import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AsistenciaPage from "@/pages/AsistenciaPage";

/**
 * Regresiones de la recuperación supervisada del kiosco:
 * verificación antes de cámara, una única lectura al restaurar, fecha real de
 * una confirmación antigua y recuperación explícita sin polling ni escrituras.
 */

type GeoSuccess = (position: {
  coords: { latitude: number; longitude: number; accuracy: number; altitude: null; altitudeAccuracy: null; heading: null; speed: null };
  timestamp: number;
}) => void;

function installGeolocation() {
  const getCurrentPosition = vi.fn((success: GeoSuccess) =>
    success({
      coords: { latitude: -12.0464, longitude: -77.0428, accuracy: 12.5, altitude: null, altitudeAccuracy: null, heading: null, speed: null },
      timestamp: 0,
    }),
  );
  Object.defineProperty(navigator, "geolocation", {
    configurable: true,
    value: { getCurrentPosition, watchPosition: vi.fn(() => 1), clearWatch: vi.fn() },
  });
  return { getCurrentPosition };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function base64url(value: string): string {
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function markingToken(nonce = "nonce-a", marker = "identify"): string {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ nonce, sub: "emp-1", action: "CHECK_IN" }));
  return `${header}.${payload}.${marker}`;
}

function identifyResponse(token = markingToken()) {
  return {
    employee: { id: "emp-1", first_name: "Ana", last_name: "Prueba", job_role_name: "Operario", active: true },
    state: { has_open_entry: false, open_check_in_at: null, last_record: null },
    server_time: "2026-10-16T12:00:00+00:00",
    server_time_label: "",
    marking_token: token,
    marking_action: "CHECK_IN",
  };
}

const CONFIRMED_OLD = {
  id: "rec-old",
  employee_id: "emp-1",
  work_date: "2026-10-16",
  check_in_at: "2026-10-16T12:00:05+00:00",
  check_out_at: null,
  worked_minutes: null,
  status: "OPEN",
  event_type: "CHECK_IN",
};

function seedStoredAttempt(overrides: Record<string, unknown> = {}) {
  window.sessionStorage.setItem(
    "agua_renew_kiosk_open_attempt",
    JSON.stringify({
      v: 2,
      marking_token: markingToken(),
      marking_action: "CHECK_IN",
      employee: identifyResponse().employee,
      stage: "MARKING_REQUESTED",
      ...overrides,
    }),
  );
}

function storedAttemptRaw(): string | null {
  return window.sessionStorage.getItem("agua_renew_kiosk_open_attempt");
}

function recoveryStatus(overrides: Record<string, unknown> = {}) {
  return {
    id: "req-1",
    status: "PENDING",
    requested_at: "2026-10-16T12:01:00+00:00",
    resolved_at: null,
    reason: null,
    can_reidentify: false,
    confirmation: null,
    ...overrides,
  };
}

function installMediaSpy() {
  const getUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream);
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
  return getUserMedia;
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Unexpected network request")));
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined });
  installGeolocation();
  window.sessionStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  window.sessionStorage.clear();
});

describe("verificación de sesión antes de la cámara", () => {
  it("un fallo de cookie no abre la cámara, no persiste intento y conserva el identificador", async () => {
    const getUserMedia = installMediaSpy();
    const paths: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      paths.push(url);
      if (url.includes("/terminal/verify")) {
        return jsonResponse(
          { detail: { code: "TERMINAL_COOKIE_MISSING", message: "Sin cookie del equipo" } },
          401,
        );
      }
      if (url.includes("/identify")) return jsonResponse(identifyResponse());
      return jsonResponse({ detail: "inesperado" }, 404);
    }));

    const user = userEvent.setup();
    render(<AsistenciaPage />);
    await user.type(screen.getByTestId("kiosk-identifier"), "71112233");
    await user.click(screen.getByTestId("kiosk-identify"));

    const incident = await screen.findByTestId("kiosk-incident-message");
    expect(incident).toHaveTextContent(/cookie de sesión/i);
    expect(incident).toHaveTextContent(/No se abrió la cámara ni se registró nada/i);
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(storedAttemptRaw()).toBeNull();
    expect(paths.filter((path) => /prepare|evidence|check-in/.test(path))).toHaveLength(0);
    expect(screen.getByTestId("kiosk-retry-verification")).toBeInTheDocument();
    // Un fallo fresco antes de enviar no es un intento pendiente: no hay
    // recuperación de jefe ni referencia enviada que mostrar.
    expect(screen.queryByTestId("kiosk-request-recovery")).toBeNull();
    expect(screen.queryByTestId("kiosk-attempt-nonce")).toBeNull();

    // El identificador se conserva para reintentar o volver a identificar.
    await user.click(screen.getByTestId("kiosk-back-identify"));
    expect(await screen.findByTestId("kiosk-identifier")).toHaveValue("71112233");
  });

  it("un token ilegible se informa para soporte y no ofrece recuperación automática", async () => {
    installMediaSpy();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/terminal/verify")) {
        return jsonResponse(
          { detail: { code: "MARKING_TOKEN_INVALID", message: "Token inválido" } },
          401,
        );
      }
      if (url.includes("/identify")) return jsonResponse(identifyResponse());
      return jsonResponse({ detail: "inesperado" }, 404);
    }));

    const user = userEvent.setup();
    render(<AsistenciaPage />);
    await user.type(screen.getByTestId("kiosk-identifier"), "71112233");
    await user.click(screen.getByTestId("kiosk-identify"));

    expect(await screen.findByTestId("kiosk-incident-message")).toHaveTextContent(/revisión manual a soporte/i);
    expect(screen.queryByTestId("kiosk-request-recovery")).toBeNull();
    expect(screen.queryByTestId("kiosk-attempt-nonce")).toBeNull();
  });
});

describe("restauración acotada de la referencia anterior", () => {
  it("hace una sola consulta de lectura, sin writes, y no inventa la fecha legada", async () => {
    seedStoredAttempt();
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: String(init?.method ?? "GET") });
      if (url.includes("/attempt/status")) {
        return jsonResponse({
          state: "PENDING",
          record: null,
          evidence_ready: true,
          write_token_valid: false,
        });
      }
      return jsonResponse({ detail: "inesperado" }, 404);
    }));

    render(<AsistenciaPage />);
    expect(await screen.findByTestId("kiosk-incident-message")).toHaveTextContent(/sigue pendiente/i);
    expect(await screen.findByText(/No está disponible la fecha en que se guardó esta referencia/i)).toBeInTheDocument();

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/api/v1/attendance/attempt/status");
    expect(calls.some((call) => call.method !== "POST" && call.url.includes("/attempt/status"))).toBe(false);
    expect(calls.some((call) => /prepare|evidence|check-in|recovery-requests/.test(call.url))).toBe(false);
    expect(storedAttemptRaw()).not.toBeNull();
    expect(screen.getByTestId("kiosk-request-recovery")).toBeInTheDocument();
  });

  it("StrictMode comparte una sola lectura y aplica el resultado al montaje vigente", async () => {
    seedStoredAttempt();
    let statusCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/attempt/status")) {
        statusCalls += 1;
        return jsonResponse({ state: "PENDING", record: null, evidence_ready: true, write_token_valid: false });
      }
      return jsonResponse({ detail: "inesperado" }, 404);
    }));

    render(
      <StrictMode>
        <AsistenciaPage />
      </StrictMode>,
    );
    expect(await screen.findByTestId("kiosk-incident-message")).toHaveTextContent(/sigue pendiente/i);
    expect(statusCalls).toBe(1);
    expect(storedAttemptRaw()).not.toBeNull();
  });

  it("una confirmación antigua muestra su fecha real y no se presenta como de hoy", async () => {
    seedStoredAttempt();
    const writes: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/attempt/status")) {
        return jsonResponse({ state: "CONFIRMED", record: CONFIRMED_OLD });
      }
      if (String(init?.method ?? "GET") !== "GET") writes.push(url);
      return jsonResponse({ detail: "inesperado" }, 404);
    }));

    render(<AsistenciaPage />);
    expect(await screen.findByTestId("kiosk-confirmed-title")).toHaveTextContent(/Marcación ya registrada/i);
    expect(screen.getByTestId("kiosk-confirmed-date")).toHaveTextContent("16/10/2026");
    expect(screen.getByTestId("kiosk-confirmed-historical")).toHaveTextContent(/No es una marcación de hoy/i);
    expect(writes).toHaveLength(0);
    expect(storedAttemptRaw()).toBeNull();
  });
});

describe("recuperación explícita", () => {
  it("sólo envía POST+GET al pulsar, no hace polling y AUTHORIZED habilita reidentificación", async () => {
    seedStoredAttempt();
    const posts: string[] = [];
    const statusGets: string[] = [];
    let reflected: Record<string, unknown> = recoveryStatus();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = String(init?.method ?? "GET");
      if (url.includes("/attempt/status")) {
        return jsonResponse({ state: "PENDING", record: null, evidence_ready: true, write_token_valid: false });
      }
      if (url.endsWith("/api/v1/attendance/recovery-requests") && method === "POST") {
        posts.push(url);
        return jsonResponse(reflected, 201);
      }
      if (url.includes("/api/v1/attendance/recovery-requests/req-1") && method === "GET") {
        statusGets.push(url);
        return jsonResponse(reflected);
      }
      return jsonResponse({ detail: "inesperado" }, 404);
    }));

    const user = userEvent.setup();
    render(<AsistenciaPage />);
    await screen.findByTestId("kiosk-request-recovery");
    expect(posts).toHaveLength(0);
    expect(statusGets).toHaveLength(0);

    await user.click(screen.getByTestId("kiosk-request-recovery"));
    expect(await screen.findByTestId("kiosk-recovery-status")).toHaveTextContent(/Pendiente de revisión/i);
    expect(posts).toHaveLength(1);
    expect(statusGets).toHaveLength(1);
    expect(screen.getByTestId("kiosk-consult-recovery")).toBeInTheDocument();
    expect(screen.queryByTestId("kiosk-reidentify-authorized")).toBeNull();

    // Consulta explícita: el servidor responde AUTHORIZED y sólo entonces se habilita.
    reflected = recoveryStatus({ status: "AUTHORIZED", can_reidentify: true, resolved_at: "2026-10-16T12:05:00+00:00" });
    await user.click(screen.getByTestId("kiosk-consult-recovery"));
    const release = await screen.findByTestId("kiosk-reidentify-authorized");
    expect(statusGets).toHaveLength(2);

    await user.click(release);
    expect(await screen.findByTestId("kiosk-identifier")).toBeInTheDocument();
    expect(screen.getByTestId("kiosk-released-reference")).toHaveTextContent(/nonce-a/);
    expect(storedAttemptRaw()).toBeNull();
    expect(statusGets).toHaveLength(2);
    expect(posts).toHaveLength(1);
  });

  it("un rechazo no habilita nueva identificación ni cierra el intento", async () => {
    seedStoredAttempt();
    const reflected = recoveryStatus({
      status: "REJECTED",
      reason: "No corresponde",
      resolved_at: "2026-10-16T12:05:00+00:00",
    });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = String(init?.method ?? "GET");
      if (url.includes("/attempt/status")) {
        return jsonResponse({ state: "PENDING", record: null, evidence_ready: true, write_token_valid: false });
      }
      if (url.endsWith("/api/v1/attendance/recovery-requests") && method === "POST") {
        return jsonResponse(reflected, 201);
      }
      if (url.includes("/recovery-requests/req-1") && method === "GET") return jsonResponse(reflected);
      return jsonResponse({ detail: "inesperado" }, 404);
    }));

    const user = userEvent.setup();
    render(<AsistenciaPage />);
    await user.click(await screen.findByTestId("kiosk-request-recovery"));

    expect(await screen.findByTestId("kiosk-recovery-status")).toHaveTextContent(/Rechazada por el jefe/i);
    expect(screen.queryByTestId("kiosk-reidentify-authorized")).toBeNull();
    expect(screen.queryByTestId("kiosk-back-identify")).toBeNull();
    expect(screen.queryByTestId("kiosk-take-another")).toBeNull();
    expect(screen.queryByTestId("kiosk-cancel-attempt")).toBeNull();
  });

  it("una referencia no firmada se conserva para revisión manual y no crea solicitud", async () => {
    seedStoredAttempt();
    let created = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/attempt/status")) {
        return jsonResponse({ state: "PENDING", record: null, evidence_ready: true, write_token_valid: false });
      }
      if (url.endsWith("/api/v1/attendance/recovery-requests") && String(init?.method) === "POST") {
        created += 1;
        return jsonResponse(
          { detail: { code: "RECOVERY_TOKEN_UNREADABLE", message: "Referencia no verificable" } },
          422,
        );
      }
      return jsonResponse({ detail: "inesperado" }, 404);
    }));

    const user = userEvent.setup();
    render(<AsistenciaPage />);
    await user.click(await screen.findByTestId("kiosk-request-recovery"));

    expect(await screen.findByTestId("kiosk-recovery-error")).toHaveTextContent(/revisión manual/i);
    expect(created).toBe(1);
    expect(storedAttemptRaw()).not.toBeNull();
    await waitFor(() => expect(screen.getByTestId("kiosk-request-recovery")).not.toBeDisabled());
  });
});
