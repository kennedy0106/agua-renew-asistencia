/**
 * Copia temporal de la foto pendiente para sobrevivir a una recarga.
 *
 * Cada intento tiene su propia clave derivada del nonce, empleado y acción: no
 * existe una clave global compartida entre pestañas. La referencia de
 * sessionStorage sigue siendo la autoridad del intento y este módulo nunca
 * sube, reenvía ni registra nada por sí mismo. No hay galería ni listado.
 */
export const PENDING_PHOTO_TTL_MS = 10 * 60_000;
export const PENDING_PHOTO_DB_NAME = "agua-renew-kiosk";
export const PENDING_PHOTO_STORE_NAME = "pending-photo";
const DB_VERSION = 1;
// Acota cada operación de IndexedDB: un equipo con almacenamiento bloqueado no
// puede dejar la marcación esperando indefinidamente.
const OPERATION_TIMEOUT_MS = 1_200;

export type PendingPhotoAction = "CHECK_IN" | "CHECK_OUT";

export type PendingPhoto = {
  v: 1;
  nonce: string;
  employeeId: string;
  action: PendingPhotoAction;
  imageBase64: string;
  storedAt: number;
  expiresAt: number;
};

export type PendingPhotoExpectation = {
  nonce: string;
  employeeId: string;
  action: PendingPhotoAction;
};

export type PhotoStoreOutcome =
  | { ok: true }
  | { ok: false; reason: "unsupported" | "unavailable" | "timeout" | "invalid" };

/**
 * Clave por identidad del intento. Dos pestañas con intentos distintos nunca
 * comparten registro; borrar A no puede borrar B.
 */
export function pendingPhotoKey(expected: PendingPhotoExpectation): string {
  return `${encodeURIComponent(expected.nonce)}|${encodeURIComponent(expected.employeeId)}|${expected.action}`;
}

/** Decisión pura y fail-closed: una foto sólo sirve para el intento exacto. */
export function isPendingPhotoValid(
  value: unknown,
  expected: PendingPhotoExpectation,
  nowMs: number,
): value is PendingPhoto {
  if (!value || typeof value !== "object") return false;
  const photo = value as Partial<PendingPhoto>;
  return (
    photo.v === 1 &&
    typeof photo.nonce === "string" && photo.nonce.length > 0 &&
    typeof photo.employeeId === "string" && photo.employeeId.length > 0 &&
    typeof photo.action === "string" &&
    (photo.action === "CHECK_IN" || photo.action === "CHECK_OUT") &&
    typeof photo.imageBase64 === "string" && photo.imageBase64.length > 0 &&
    typeof photo.storedAt === "number" && Number.isFinite(photo.storedAt) &&
    typeof photo.expiresAt === "number" && Number.isFinite(photo.expiresAt) &&
    photo.nonce === expected.nonce &&
    photo.employeeId === expected.employeeId &&
    photo.action === expected.action &&
    photo.expiresAt > nowMs
  );
}

function indexedDbFactory(): IDBFactory | null {
  try {
    return typeof indexedDB === "undefined" ? null : indexedDB;
  } catch {
    return null;
  }
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  const factory = indexedDbFactory();
  if (!factory) return Promise.reject(new Error("unsupported"));
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    let settled = false;
    let request: IDBOpenDBRequest;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      dbPromise = null;
      reject(error);
    };
    const timer = window.setTimeout(() => fail(new Error("timeout")), OPERATION_TIMEOUT_MS);
    try {
      request = factory.open(PENDING_PHOTO_DB_NAME, DB_VERSION);
    } catch (error) {
      fail(error);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(PENDING_PHOTO_STORE_NAME)) {
        db.createObjectStore(PENDING_PHOTO_STORE_NAME);
      }
    };
    request.onsuccess = () => {
      if (settled) {
        request.result.close();
        return;
      }
      settled = true;
      window.clearTimeout(timer);
      resolve(request.result);
    };
    request.onerror = () => fail(request.error ?? new Error("unavailable"));
    request.onblocked = () => fail(new Error("unavailable"));
  });
  return dbPromise;
}

function runRequest<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDatabase().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        let settled = false;
        let result: T;
        let transaction: IDBTransaction | undefined;
        const fail = (error: unknown) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          reject(error);
        };
        const finish = () => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          resolve(result);
        };
        const timer = window.setTimeout(() => {
          // Abortar impide que una escritura tardía se confirme después de
          // haber informado timeout y continuado el flujo.
          try {
            transaction?.abort();
          } catch {
            // La transacción pudo terminar justo antes del plazo.
          }
          fail(new Error("timeout"));
        }, OPERATION_TIMEOUT_MS);
        try {
          transaction = db.transaction(PENDING_PHOTO_STORE_NAME, mode);
          const request = operation(transaction.objectStore(PENDING_PHOTO_STORE_NAME));
          request.onsuccess = () => {
            result = request.result;
          };
          request.onerror = () => fail(request.error ?? new Error("unavailable"));
        } catch (error) {
          fail(error);
          return;
        }
        // Las escrituras sólo cuentan como guardadas al confirmar la
        // transacción; las lecturas también esperan su cierre.
        transaction.oncomplete = finish;
        transaction.onabort = () => fail(transaction?.error ?? new Error("unavailable"));
        transaction.onerror = () => fail(transaction?.error ?? new Error("unavailable"));
      }),
  );
}

/** Persiste la foto pendiente de UN intento, sin tocar la de otro. */
export async function savePendingPhoto(photo: PendingPhoto): Promise<PhotoStoreOutcome> {
  try {
    await runRequest("readwrite", (store) => store.put(photo, pendingPhotoKey(photo)));
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message === "unsupported") return { ok: false, reason: "unsupported" };
    if (message === "timeout") return { ok: false, reason: "timeout" };
    return { ok: false, reason: "unavailable" };
  }
}

/**
 * Devuelve la foto sólo si pertenece al intento esperado y sigue vigente.
 * Una copia vencida se borra bajo su propia clave; jamás la de otro intento.
 */
export async function loadPendingPhoto(
  expected: PendingPhotoExpectation,
  nowMs: number = Date.now(),
): Promise<PendingPhoto | null> {
  try {
    const value = await runRequest<unknown>("readonly", (store) => store.get(pendingPhotoKey(expected)));
    if (!isPendingPhotoValid(value, expected, nowMs)) {
      if (value !== undefined) await clearPendingPhoto(expected);
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

/**
 * Limpia la copia de ESTE intento (confirmación/cancelación autoritativa,
 * descarte o vencimiento). La clave identifica al intento: nunca borra la foto
 * pendiente de otra pestaña u otro empleado.
 */
export async function clearPendingPhoto(expected: PendingPhotoExpectation): Promise<void> {
  try {
    await runRequest("readwrite", (store) => store.delete(pendingPhotoKey(expected)));
  } catch {
    // El almacenamiento local nunca es autoritativo para la marcación.
  }
}
