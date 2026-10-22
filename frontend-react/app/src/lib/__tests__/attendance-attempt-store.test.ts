import { describe, expect, it } from "vitest";
import { API_URL, type IdentifyResponse } from "@/lib/api";
import {
  KIOSK_ATTEMPT_KEY,
  clearStoredAttempt,
  parseStoredAttempt,
  persistAttempt,
  readStoredAttempt,
  rememberRecoveryRequestId,
} from "@/lib/attendance-attempt-store";

/** Almacén en memoria con la misma interfaz usada por el módulo. */
function memoryStorage(initial: string | null = null) {
  let value = initial;
  return {
    getItem: (key: string) => (key === KIOSK_ATTEMPT_KEY ? value : null),
    setItem: (key: string, next: string) => {
      if (key === KIOSK_ATTEMPT_KEY) value = next;
    },
    removeItem: (key: string) => {
      if (key === KIOSK_ATTEMPT_KEY) value = null;
    },
  };
}

const employee = {
  id: "emp-1",
  first_name: "Ana",
  last_name: "Prueba",
  job_role_name: "Operario",
  active: true,
};

function base64url(value: string): string {
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function token(nonce: string, marker: string): string {
  const payload = base64url(JSON.stringify({ nonce, sub: "emp-1", action: "CHECK_IN" }));
  return `header.${payload}.${marker}`;
}

function info(token = "header.payload.signature"): IdentifyResponse {
  return {
    employee,
    state: { has_open_entry: false, open_check_in_at: null, last_record: null },
    server_time: "2026-10-16T12:00:00+00:00",
    server_time_label: "",
    marking_token: token,
    marking_action: "CHECK_IN",
  };
}

describe("referencia del intento versionada", () => {
  it("v1 se restaura como legado y sin inventar fecha ni origen", () => {
    const parsed = parseStoredAttempt(
      JSON.stringify({
        v: 1,
        marking_token: "legacy-token",
        marking_action: "CHECK_IN",
        employee,
      }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.v).toBe(1);
    expect(parsed?.legacy).toBe(true);
    expect(parsed?.stage).toBe("UNKNOWN");
    expect(parsed?.known_at).toBeNull();
    expect(parsed?.api_origin).toBeNull();
    expect(parsed?.recovery_request_id).toBeNull();
  });

  it("v2 conserva la etapa pero mantiene fecha y origen desconocidos", () => {
    const parsed = parseStoredAttempt(
      JSON.stringify({
        v: 2,
        marking_token: "legacy-token",
        marking_action: "CHECK_OUT",
        employee,
        stage: "EVIDENCE_STORED",
      }),
    );
    expect(parsed?.v).toBe(2);
    expect(parsed?.legacy).toBe(true);
    expect(parsed?.stage).toBe("EVIDENCE_STORED");
    expect(parsed?.known_at).toBeNull();
    expect(parsed?.api_origin).toBeNull();
  });

  it("v3 guarda el origen del API y la fecha conocida", () => {
    const storage = memoryStorage();
    const knownAt = "2026-10-16T12:00:02+00:00";
    expect(persistAttempt(info(), "PREPARED", { knownAt, storage })).toBe(true);
    const stored = readStoredAttempt(storage);
    expect(stored?.v).toBe(3);
    expect(stored?.legacy).toBe(false);
    expect(stored?.api_origin).toBe(API_URL);
    expect(stored?.known_at).toBe(knownAt);
    expect(stored?.stage).toBe("PREPARED");
  });

  it("una renovación del mismo nonce conserva fecha, origen y solicitud aunque cambie la firma", () => {
    const storage = memoryStorage();
    const knownAt = "2026-10-16T12:00:02+00:00";
    persistAttempt(info(token("nonce-a", "identify")), "PREPARED", { knownAt, storage });
    rememberRecoveryRequestId("req-1", storage);
    const originalOrigin = readStoredAttempt(storage)?.api_origin;

    // Token renovado: distinto JWT, mismo nonce, mismo empleado y acción.
    persistAttempt(info(token("nonce-a", "refreshed")), "MARKING_REQUESTED", { storage });
    const stored = readStoredAttempt(storage);
    expect(stored?.marking_token).toBe(token("nonce-a", "refreshed"));
    expect(stored?.known_at).toBe(knownAt);
    expect(stored?.api_origin).toBe(originalOrigin);
    expect(stored?.recovery_request_id).toBe("req-1");
    expect(stored?.stage).toBe("MARKING_REQUESTED");
  });

  it("una referencia legada conserva la fecha desconocida al renovar el mismo nonce", () => {
    const legacyToken = token("nonce-legacy", "identify");
    const storage = memoryStorage(
      JSON.stringify({
        v: 2,
        marking_token: legacyToken,
        marking_action: "CHECK_IN",
        employee,
        stage: "EVIDENCE_STORED",
      }),
    );
    const previous = readStoredAttempt(storage);
    expect(previous?.known_at).toBeNull();
    expect(previous?.api_origin).toBeNull();

    persistAttempt(info(token("nonce-legacy", "refreshed")), "MARKING_REQUESTED", { storage });
    const stored = readStoredAttempt(storage);
    expect(stored?.v).toBe(3);
    expect(stored?.known_at).toBeNull();
    expect(stored?.api_origin).toBeNull();
    expect(stored?.marking_action).toBe("CHECK_IN");
  });

  it("un token de otro nonce no hereda la fecha ni la solicitud anterior", () => {
    const storage = memoryStorage();
    persistAttempt(info(token("nonce-a", "identify")), "PREPARED", {
      knownAt: "2026-10-16T12:00:02+00:00",
      storage,
    });
    rememberRecoveryRequestId("req-1", storage);
    persistAttempt(info(token("nonce-b", "identify")), "PREPARED", { storage });
    const stored = readStoredAttempt(storage);
    expect(stored?.recovery_request_id).toBeNull();
    expect(stored?.known_at).not.toBe("2026-10-16T12:00:02+00:00");
    expect(stored?.api_origin).toBe(API_URL);
  });

  it("actualizar la etapa del mismo intento conserva la fecha ya conocida", () => {
    const storage = memoryStorage();
    persistAttempt(info(), "PREPARED", { knownAt: "2026-10-16T12:00:02+00:00", storage });
    persistAttempt(info(), "MARKING_REQUESTED", { storage });
    const stored = readStoredAttempt(storage);
    expect(stored?.stage).toBe("MARKING_REQUESTED");
    expect(stored?.known_at).toBe("2026-10-16T12:00:02+00:00");
  });

  it("la solicitud de recuperación se asocia sin alterar token ni fecha", () => {
    const storage = memoryStorage();
    persistAttempt(info(), "EVIDENCE_REQUESTED", { knownAt: "2026-10-16T12:00:02+00:00", storage });
    expect(rememberRecoveryRequestId("req-1", storage)).toBe(true);
    const stored = readStoredAttempt(storage);
    expect(stored?.recovery_request_id).toBe("req-1");
    expect(stored?.marking_token).toBe("header.payload.signature");
    expect(stored?.known_at).toBe("2026-10-16T12:00:02+00:00");
    expect(stored?.v).toBe(3);
  });

  it("una referencia sin token, empleado o acción válida se descarta", () => {
    expect(parseStoredAttempt(null)).toBeNull();
    expect(parseStoredAttempt("no-json")).toBeNull();
    expect(
      parseStoredAttempt(JSON.stringify({ v: 2, marking_token: "", employee, marking_action: "CHECK_IN" })),
    ).toBeNull();
    expect(
      parseStoredAttempt(JSON.stringify({ v: 2, marking_token: "t", marking_action: "OTHER", employee })),
    ).toBeNull();
  });

  it("clearStoredAttempt sólo borra la clave del intento", () => {
    const storage = memoryStorage();
    persistAttempt(info(), "PREPARED", { storage });
    clearStoredAttempt(storage);
    expect(readStoredAttempt(storage)).toBeNull();
  });
});
