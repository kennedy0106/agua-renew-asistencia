import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * La copia local es fail-closed: sólo vale para el nonce, empleado y acción
 * exactos del intento vigente, y vence sola. El fake de IndexedDB reproduce el
 * subconjunto que usa el helper (open/get/put/delete) para probar TTL y
 * limpieza sin depender de una implementación real del navegador.
 */

type Handler = ((this: unknown, event: Event) => unknown) | null;

class FakeRequest<T> {
  result: T | undefined;
  error: Error | null = null;
  onsuccess: Handler = null;
  onerror: Handler = null;
  onupgradeneeded: Handler = null;
  onblocked: Handler = null;
}

class FakeObjectStore {
  data = new Map<string, unknown>();
  complete: (() => void) | null = null;
  openCursor() {
    const request = new FakeRequest<unknown>();
    const entries = Array.from(this.data.entries());
    const complete = this.complete;
    let index = 0;
    const next = () => queueMicrotask(() => {
      const entry = entries[index++];
      request.result = entry ? {
        value: entry[1],
        delete: () => this.data.delete(entry[0]),
        continue: next,
      } : null;
      request.onsuccess?.call(request, new Event("success"));
      if (!entry) complete?.();
    });
    next();
    return request;
  }
  get(key: IDBValidKey) {
    const request = new FakeRequest<unknown>();
    queueMicrotask(() => {
      request.result = this.data.get(String(key));
      request.onsuccess?.call(request, new Event("success"));
      this.complete?.();
    });
    return request;
  }
  put(value: unknown, key: IDBValidKey) {
    const request = new FakeRequest<IDBValidKey>();
    queueMicrotask(() => {
      this.data.set(String(key), value);
      request.result = key;
      request.onsuccess?.call(request, new Event("success"));
      this.complete?.();
    });
    return request;
  }
  delete(key: IDBValidKey) {
    const request = new FakeRequest<undefined>();
    queueMicrotask(() => {
      this.data.delete(String(key));
      request.onsuccess?.call(request, new Event("success"));
      this.complete?.();
    });
    return request;
  }
}

class FakeTransaction {
  oncomplete: Handler = null;
  onerror: Handler = null;
  onabort: Handler = null;
  constructor(private store: FakeObjectStore) {
    this.store.complete = () => this.oncomplete?.call(this, new Event("complete"));
  }
  objectStore() {
    return this.store;
  }
}

class FakeDatabase {
  objectStoreNames = { contains: () => true };
  store = new FakeObjectStore();
  transaction() {
    return new FakeTransaction(this.store) as unknown as IDBTransaction;
  }
  close() {}
}

function installFakeIndexedDb() {
  const database = new FakeDatabase();
  const open = vi.fn(() => {
    const request = new FakeRequest<IDBDatabase>();
    queueMicrotask(() => {
      request.result = database as unknown as IDBDatabase;
      request.onsuccess?.call(request, new Event("success"));
    });
    return request as unknown as IDBOpenDBRequest;
  });
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: { open } as unknown as IDBFactory,
  });
  return { database, open };
}

const PHOTO = {
  v: 1 as const,
  nonce: "nonce-a",
  employeeId: "emp-1",
  action: "CHECK_IN" as const,
  imageBase64: "QUJD",
  storedAt: 1_000,
  expiresAt: 11_000,
};

async function photoStore() {
  vi.resetModules();
  return import("@/lib/attendance-photo-store");
}

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(5_000);
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as { indexedDB?: unknown }).indexedDB;
});

describe("validación de la foto pendiente", () => {
  it("acepta sólo la coincidencia exacta y vigente", async () => {
    const { isPendingPhotoValid } = await photoStore();
    const expected = { nonce: "nonce-a", employeeId: "emp-1", action: "CHECK_IN" as const };
    expect(isPendingPhotoValid(PHOTO, expected, 5_000)).toBe(true);
    expect(isPendingPhotoValid(PHOTO, expected, 11_000)).toBe(false);
    expect(isPendingPhotoValid(PHOTO, { ...expected, nonce: "nonce-b" }, 5_000)).toBe(false);
    expect(isPendingPhotoValid(PHOTO, { ...expected, employeeId: "emp-2" }, 5_000)).toBe(false);
    expect(isPendingPhotoValid(PHOTO, { ...expected, action: "CHECK_OUT" }, 5_000)).toBe(false);
    expect(isPendingPhotoValid({ ...PHOTO, imageBase64: "" }, expected, 5_000)).toBe(false);
  });
});

describe("IndexedDB temporal de la foto", () => {
  it("purga fotos vencidas de pestañas cerradas y conserva las vigentes", async () => {
    const { database } = installFakeIndexedDb();
    const store = await photoStore();
    const expired = { ...PHOTO, nonce: "closed-tab", expiresAt: 4_999 };
    database.store.data.set(store.pendingPhotoKey(expired), expired);
    database.store.data.set(store.pendingPhotoKey(PHOTO), PHOTO);

    await store.purgeExpiredPendingPhotos();

    expect(database.store.data.has(store.pendingPhotoKey(expired))).toBe(false);
    expect(database.store.data.get(store.pendingPhotoKey(PHOTO))).toEqual(PHOTO);
  });
  it("guarda por intento y no entrega ni borra la foto de otra identidad", async () => {
    installFakeIndexedDb();
    const store = await photoStore();
    const expected = { nonce: "nonce-a", employeeId: "emp-1", action: "CHECK_IN" as const };

    expect(await store.savePendingPhoto(PHOTO)).toEqual({ ok: true });
    expect(await store.loadPendingPhoto(expected, 5_000)).toMatchObject({ imageBase64: "QUJD" });
    // Otra identidad usa otra clave: no puede leer ni borrar la foto de A.
    expect(await store.loadPendingPhoto({ ...expected, employeeId: "emp-2" }, 5_000)).toBeNull();
    expect(await store.loadPendingPhoto(expected, 5_000)).toMatchObject({ imageBase64: "QUJD" });
  });

  it("dos pestañas/intentos conviven y confirmar A no borra la foto B", async () => {
    installFakeIndexedDb();
    const store = await photoStore();
    const attemptA = { nonce: "nonce-a", employeeId: "emp-1", action: "CHECK_IN" as const };
    const attemptB = { nonce: "nonce-b", employeeId: "emp-2", action: "CHECK_OUT" as const };
    const photoA = { ...PHOTO, nonce: "nonce-a", employeeId: "emp-1", imageBase64: "QUJD" };
    const photoB = { ...PHOTO, nonce: "nonce-b", employeeId: "emp-2", action: "CHECK_OUT" as const, imageBase64: "REVG" };

    await store.savePendingPhoto(photoA);
    await store.savePendingPhoto(photoB);
    expect(await store.loadPendingPhoto(attemptA, 5_000)).toMatchObject({ imageBase64: "QUJD" });
    expect(await store.loadPendingPhoto(attemptB, 5_000)).toMatchObject({ imageBase64: "REVG" });

    await store.clearPendingPhoto(attemptA);
    expect(await store.loadPendingPhoto(attemptA, 5_000)).toBeNull();
    expect(await store.loadPendingPhoto(attemptB, 5_000)).toMatchObject({ imageBase64: "REVG" });
  });

  it("descarta una copia vencida sin tocar la referencia del intento", async () => {
    installFakeIndexedDb();
    const store = await photoStore();
    const expected = { nonce: "nonce-a", employeeId: "emp-1", action: "CHECK_IN" as const };
    await store.savePendingPhoto(PHOTO);

    expect(await store.loadPendingPhoto(expected, PHOTO.expiresAt + 1)).toBeNull();
    expect(await store.loadPendingPhoto(expected, 5_000)).toBeNull();
  });

  it("limpiar deja el almacén sin foto", async () => {
    installFakeIndexedDb();
    const store = await photoStore();
    const expected = { nonce: "nonce-a", employeeId: "emp-1", action: "CHECK_IN" as const };
    await store.savePendingPhoto(PHOTO);
    await store.clearPendingPhoto(expected);
    expect(await store.loadPendingPhoto(expected, 5_000)).toBeNull();
  });

  it("sin IndexedDB no bloquea: informa no soportado y conserva la memoria", async () => {
    Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: undefined });
    const store = await photoStore();
    const expected = { nonce: "nonce-a", employeeId: "emp-1", action: "CHECK_IN" as const };

    expect(await store.savePendingPhoto(PHOTO)).toEqual({ ok: false, reason: "unsupported" });
    expect(await store.loadPendingPhoto(expected, 5_000)).toBeNull();
    await expect(store.clearPendingPhoto(expected)).resolves.toBeUndefined();
  });
});
