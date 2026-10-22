import { API_URL, type IdentifyResponse } from "@/lib/api";

/**
 * Referencia del intento público guardada en la pestaña.
 *
 * v1 y v2 son referencias históricas: NO guardaron el origen del API ni la
 * fecha en que se conoció el intento, por lo que se restauran con esos datos
 * explícitamente desconocidos (nunca se inventa una fecha). v3 es el formato
 * actual: conserva el origen del API que emitió el token y la fecha conocida
 * por el navegador. La referencia y la foto temporal (TTL propio) se conservan
 * aunque envejezcan; sólo una resolución autoritativa del servidor las limpia.
 */
export const KIOSK_ATTEMPT_KEY = "agua_renew_kiosk_open_attempt";

export type DeliveryStage =
  | "EVIDENCE_REQUESTED"
  | "PREPARED"
  | "EVIDENCE_STORED"
  | "MARKING_REQUESTED"
  | "UNKNOWN";

export type StoredAttempt = {
  v: 1 | 2 | 3;
  marking_token: string;
  marking_action: IdentifyResponse["marking_action"];
  employee: IdentifyResponse["employee"];
  stage: DeliveryStage;
  /** Origen del API que emitió el intento; null si la versión antigua no lo guardó. */
  api_origin: string | null;
  /** Fecha ISO en que el navegador conoció el intento; null si es desconocida. */
  known_at: string | null;
  /** Solicitud de recuperación ya registrada por este navegador, si existe. */
  recovery_request_id: string | null;
  /** true sólo para referencias v1/v2 anteriores al formato actual. */
  legacy: boolean;
};

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function safeStorage(fallback?: StorageLike): StorageLike | null {
  if (fallback) return fallback;
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

function parseStage(value: unknown, version: 1 | 2 | 3): DeliveryStage {
  if (version === 1) return "UNKNOWN";
  if (
    value === "EVIDENCE_REQUESTED" ||
    value === "PREPARED" ||
    value === "EVIDENCE_STORED" ||
    value === "MARKING_REQUESTED"
  ) {
    return value;
  }
  return "UNKNOWN";
}

function validKnownAt(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  return Number.isFinite(new Date(value).getTime()) ? value : null;
}

/** Nonce del token firmado; el navegador sólo lo usa para reconocer el mismo intento. */
function nonceFromToken(token: string): string | null {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const padded = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = atob(padded.padEnd(padded.length + ((4 - (padded.length % 4)) % 4), "="));
    const payload = JSON.parse(json) as { nonce?: unknown };
    return typeof payload.nonce === "string" && payload.nonce !== "" ? payload.nonce : null;
  } catch {
    return null;
  }
}

/**
 * El mismo intento se reconoce por nonce + empleado + acción. Una renovación
 * del mismo nonce puede cambiar la firma del JWT y aun así conservar la fecha,
 * el origen y la solicitud de recuperación ya asociados.
 */
function isSameAttempt(previous: StoredAttempt, info: IdentifyResponse): boolean {
  if (previous.employee.id !== info.employee.id) return false;
  if (previous.marking_action !== info.marking_action) return false;
  const previousNonce = nonceFromToken(previous.marking_token);
  const nextNonce = nonceFromToken(info.marking_token);
  if (previousNonce && nextNonce) return previousNonce === nextNonce;
  return previous.marking_token === info.marking_token;
}

/** Lectura fail-closed: una referencia sin token, empleado o acción no sirve. */
export function parseStoredAttempt(raw: string | null): StoredAttempt | null {
  if (!raw) return null;
  let parsed: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return null;
    parsed = value as Record<string, unknown>;
  } catch {
    return null;
  }
  const token = parsed.marking_token;
  const employee = parsed.employee as Partial<IdentifyResponse["employee"]> | undefined;
  const action = parsed.marking_action;
  if (typeof token !== "string" || token === "") return null;
  if (!employee || typeof employee !== "object" || typeof employee.id !== "string" || employee.id === "") {
    return null;
  }
  if (action !== "CHECK_IN" && action !== "CHECK_OUT") return null;
  const version: 1 | 2 | 3 = parsed.v === 3 ? 3 : parsed.v === 2 ? 2 : 1;
  const recoveryId =
    typeof parsed.recovery_request_id === "string" && parsed.recovery_request_id !== ""
      ? parsed.recovery_request_id
      : null;
  return {
    v: version,
    marking_token: token,
    marking_action: action,
    employee: employee as IdentifyResponse["employee"],
    stage: parseStage(parsed.stage, version),
    api_origin: version === 3 && typeof parsed.api_origin === "string" && parsed.api_origin
      ? parsed.api_origin
      : null,
    known_at: version === 3 ? validKnownAt(parsed.known_at) : null,
    recovery_request_id: recoveryId,
    legacy: version < 3,
  };
}

export function readStoredAttempt(storage?: StorageLike): StoredAttempt | null {
  const store = safeStorage(storage);
  if (!store) return null;
  try {
    return parseStoredAttempt(store.getItem(KIOSK_ATTEMPT_KEY));
  } catch {
    return null;
  }
}

/**
 * Guarda la referencia del intento. El vencimiento del token lo decide el
 * servidor; aquí sólo se registra el origen y cuándo lo conoció el navegador.
 */
export function persistAttempt(
  info: IdentifyResponse,
  stage: DeliveryStage,
  options: {
    knownAt?: string | null;
    recoveryRequestId?: string | null;
    storage?: StorageLike;
  } = {},
): boolean {
  const store = safeStorage(options.storage);
  if (!store) return false;
  const previous = readStoredAttempt(store);
  const sameAttempt = previous ? isSameAttempt(previous, info) : false;
  const preserved = sameAttempt ? previous : null;
  const explicitKnownAt = validKnownAt(options.knownAt);
  // En una renovación del mismo nonce se conserva incluso `null` (legado): no
  // se inventa una fecha que la referencia original no tenía.
  const knownAt = explicitKnownAt ?? (preserved ? preserved.known_at : new Date().toISOString());
  const payload: StoredAttempt = {
    v: 3,
    marking_token: info.marking_token,
    marking_action: info.marking_action,
    employee: info.employee,
    stage,
    api_origin: preserved ? preserved.api_origin : API_URL,
    known_at: knownAt,
    recovery_request_id:
      options.recoveryRequestId !== undefined
        ? options.recoveryRequestId
        : preserved
          ? preserved.recovery_request_id
          : null,
    legacy: false,
  };
  try {
    store.setItem(KIOSK_ATTEMPT_KEY, JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

/** Asocia el id de la solicitud ya probada por GET; no altera token ni fecha. */
export function rememberRecoveryRequestId(requestId: string, storage?: StorageLike): boolean {
  const store = safeStorage(storage);
  if (!store) return false;
  const previous = readStoredAttempt(store);
  if (!previous) return false;
  const payload: StoredAttempt = {
    ...previous,
    v: 3,
    recovery_request_id: requestId,
    legacy: false,
  };
  try {
    store.setItem(KIOSK_ATTEMPT_KEY, JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

export function clearStoredAttempt(storage?: StorageLike): void {
  const store = safeStorage(storage);
  if (!store) return;
  try {
    store.removeItem(KIOSK_ATTEMPT_KEY);
  } catch {
    // El storage local no es autoritativo; el servidor conserva el intento.
  }
}

/** Estados en los que la copia local de la foto ya estaba consolidada. */
export function stageHasEvidence(stage: DeliveryStage): boolean {
  return stage === "EVIDENCE_STORED" || stage === "MARKING_REQUESTED" || stage === "UNKNOWN";
}
