/** Browser-only retry context for one HST-01 administration operation.
 *
 * It stores the frozen DTO and key, never a cookie/credential.  Context is
 * namespaced by the authenticated user, so a shared browser cannot offer one
 * manager's pending operation to another manager after sign-in.
 */
export type HistoricalOperation = {
  key: string;
  userId: string;
  kind: "BATCH" | "UPDATE" | "VOID" | "APPROVE";
  targetId?: string;
  payload: Record<string, unknown>;
};

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
