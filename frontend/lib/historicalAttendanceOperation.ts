/** Browser-only retry context for one HST-01 administration operation.
 *
 * It stores the frozen DTO and key, never a cookie/credential.  Context is
 * namespaced by the authenticated user, so a shared browser cannot offer one
 * manager's pending operation to another manager after sign-in.
 */
import { ApiError } from "./api";

export type HistoricalOperation = {
  key: string;
  userId: string;
  kind: "BATCH" | "UPDATE" | "VOID" | "APPROVE";
  targetId?: string;
  payload: Record<string, unknown>;
};

/**
 * A mutation either reached a durable receipt, was contractually rejected
 * before a write, remains ambiguous, or can no longer be authorized.  Keep
 * this classification here so save/edit/void/approve/retry cannot gradually
 * grow incompatible catch lists.
 *
 * ``REJECTED_BEFORE_WRITE`` is intentionally restricted to emitted manual
 * attendance contracts (plus parsed 422 validation).  An arbitrary 4xx/5xx
 * is never evidence that a request did not commit.
 */
export type HistoricalOperationResult =
  | "CONFIRMED"
  | "REJECTED_BEFORE_WRITE"
  | "UNKNOWN_OR_IN_PROGRESS"
  | "AUTHENTICATION_REQUIRED";

export type HistoricalOperationOutcome<T> = {
  classification: HistoricalOperationResult;
  value?: T;
  error?: unknown;
};

const rejectedBeforeWriteCodes = new Set([
  "DAY_ALREADY_HAS_ATTENDANCE",
  "DUPLICATE_EMPLOYEE_DAY",
  "EDIT_IDENTITY_IMMUTABLE",
  "EDIT_PREVIEW_INVALID",
  "EMPLOYEE_IMMUTABLE",
  "EMPLOYEE_NOT_FOUND",
  "HISTORICAL_CONFIGURATION_MISSING",
  "HISTORICAL_DATE_REQUIRED",
  "IDEMPOTENCY_CONFLICT",
  "KNOWN_INTERVAL_INCONSISTENT",
  "MANUAL_DAY_EXISTS",
  "MANUAL_DAY_NOT_FOUND",
  "NORMAL_EXCEEDS_EXPECTED",
  "OUTSIDE_EMPLOYMENT",
  "OVERTIME_DISABLED",
  "OVERTIME_RECONCILIATION_REQUIRED",
  "PAYMENT_REVIEW_REQUIRED",
  "PAYROLL_CLOSED",
  "RECOVERY_COMMITMENT_EXISTS",
  "RECOVERY_COMMITMENT_INVALID",
  "RECOVERY_EXCEEDS_PENDING",
  "REVIEWED_AMOUNT_BELOW_POLICY",
  "STALE_PREVIEW",
  "STALE_VERSION",
]);

const unknownCodes = new Set([
  "OPERATION_IN_PROGRESS",
  "OPERATION_NOT_CONFIRMED",
  "OPERATION_RESULT_UNKNOWN",
]);

export function classifyHistoricalOperationResult(
  error: unknown | null | undefined,
): HistoricalOperationResult {
  if (error == null) return "CONFIRMED";
  if (!(error instanceof ApiError)) return "UNKNOWN_OR_IN_PROGRESS";
  if (error.status === 401 || error.status === 403) return "AUTHENTICATION_REQUIRED";
  if (unknownCodes.has(error.code ?? "")) return "UNKNOWN_OR_IN_PROGRESS";
  if (error.status === 422 || rejectedBeforeWriteCodes.has(error.code ?? "")) {
    return "REJECTED_BEFORE_WRITE";
  }
  return "UNKNOWN_OR_IN_PROGRESS";
}

export async function runHistoricalOperation<T>(
  operation: () => Promise<T>,
): Promise<HistoricalOperationOutcome<T>> {
  try {
    return { classification: classifyHistoricalOperationResult(null), value: await operation() };
  } catch (error) {
    return { classification: classifyHistoricalOperationResult(error), error };
  }
}

const storageKey = (userId: string) => `hst01.pending-operation.v2.${userId}`;

export function saveHistoricalOperation(operation: HistoricalOperation): boolean {
  if (typeof window === "undefined") return false;
  try {
    sessionStorage.setItem(storageKey(operation.userId), JSON.stringify(operation));
    return true;
  } catch {
    // An operation must not be sent if the promised same-tab recovery cannot
    // be recorded first (private-mode quota/storage failures, for example).
    return false;
  }
}

export function readHistoricalOperation(userId: string): HistoricalOperation | null {
  if (typeof window === "undefined") return null;
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(storageKey(userId)) ?? "null");
    if (!value || typeof value !== "object") return null;
    const item = value as Partial<HistoricalOperation>;
    const kinds = ["BATCH", "UPDATE", "VOID", "APPROVE"] as const;
    if (
      item.userId !== userId ||
      typeof item.key !== "string" || item.key.length < 8 ||
      !item.payload || typeof item.payload !== "object" ||
      !kinds.includes(item.kind as (typeof kinds)[number]) ||
      (item.kind !== "BATCH" && typeof item.targetId !== "string") ||
      typeof (item.payload as Record<string, unknown>).idempotency_key !== "string" ||
      (item.payload as Record<string, unknown>).idempotency_key !== item.key
    ) return null;
    return item as HistoricalOperation;
  } catch {
    return null;
  }
}

export function clearHistoricalOperation(userId: string, key?: string) {
  const pending = readHistoricalOperation(userId);
  if (!key || pending?.key === key) sessionStorage.removeItem(storageKey(userId));
}
