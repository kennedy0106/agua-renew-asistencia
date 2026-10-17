import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  API_URL,
  ApiError,
  attendanceAdminApi,
  attendanceApi,
  type AttendanceLocationSnapshot,
} from "@/lib/api";
import { LOCATION_MAX_AGE_MS, locationAgeMs, requestBrowserPosition } from "@/pages/AsistenciaPage";

/**
 * Contrato HTTP del flujo de ubicación y evidencia privada con sello.
 *
 * Estas pruebas fijan la forma exacta del cable (S6/S9/L5/L6) sin backend real:
 * prepare recibe el token y la ubicación puntual, la recuperación puede exponer
 * el mismo snapshot, y el visor privado consume el derivado sellado sin tocar
 * el original.
 */

const LOCATION: AttendanceLocationSnapshot = {
  latitude: -12.0464,
  longitude: -77.0428,
  accuracy_m: 12.5,
  observed_at: "2026-10-16T12:00:00+00:00",
  address: "Av. Siempre Viva 742, Lima",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => "blob:mock-object-url");
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("lectura puntual de ubicación", () => {
  it("mide la antigüedad con reloj monótono en el límite de 60 s", () => {
    expect(LOCATION_MAX_AGE_MS).toBe(60000);
    const position = { latitude: -12.0464, longitude: -77.0428, accuracyM: 10, observedMonotonicMs: 1000 };
    expect(locationAgeMs(position, 61000)).toBe(60000);
    expect(locationAgeMs(position, 61001)).toBe(60001);
    expect(locationAgeMs(position, 500)).toBe(0);
  });

  it("no usa watchPosition ni caché y respeta el límite de 50 m", async () => {
    const calls: PositionOptions[] = [];
    const watchPosition = vi.fn();
    let respond: ((accuracy: number) => void) | null = null;
    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      value: {
        watchPosition,
        clearWatch: vi.fn(),
        getCurrentPosition: (success: PositionCallback, _error: PositionErrorCallback, options?: PositionOptions) => {
          calls.push(options ?? {});
          respond = (accuracy: number) =>
            success({
              coords: { latitude: -12.0464, longitude: -77.0428, accuracy, altitude: null, altitudeAccuracy: null, heading: null, speed: null } as GeolocationCoordinates,
              timestamp: 0,
            } as GeolocationPosition);
        },
      },
    });

    const within = requestBrowserPosition(() => 500);
    respond!(50);
    const accepted = await within;
    expect(accepted.ok).toBe(true);
    if (accepted.ok) {
      expect(accepted.position.accuracyM).toBe(50);
      expect(accepted.position.observedMonotonicMs).toBe(500);
    }
    expect(calls[0]).toMatchObject({ enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });

    const over = requestBrowserPosition(() => 500);
    respond!(50.0001);
    expect(await over).toEqual({ ok: false, reason: "accuracy" });
    expect(watchPosition).not.toHaveBeenCalled();
  });

  it("resuelve con un plazo propio si el callback nunca responde", async () => {
    vi.useFakeTimers();
    try {
      Object.defineProperty(navigator, "geolocation", {
        configurable: true,
        value: { getCurrentPosition: vi.fn(), watchPosition: vi.fn(), clearWatch: vi.fn() },
      });
      const pending = requestBrowserPosition(() => 0);
      const outcome = await vi.advanceTimersByTimeAsync(20000).then(() => pending);
      expect(outcome).toEqual({ ok: false, reason: "timeout" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("clasifica la denegación de permiso sin diagnosticar un GPS apagado", async () => {
    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      value: {
        getCurrentPosition: (_success: PositionCallback, error: PositionErrorCallback) =>
          error({ code: 1, message: "denied" } as GeolocationPositionError),
        watchPosition: vi.fn(),
        clearWatch: vi.fn(),
      },
    });
    expect(await requestBrowserPosition()).toEqual({ ok: false, reason: "denied" });
  });
});

describe("prepare de marcación con ubicación", () => {
  it("envía token y ubicación con la forma exacta del contrato", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        marking_token: "tok-renovado",
        marked_at: "2026-10-16T12:00:05+00:00",
        expires_at: "2026-10-16T12:05:05+00:00",
        location: LOCATION,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await attendanceApi.prepareAttempt("tok-identificado", {
      latitude: -12.0464,
      longitude: -77.0428,
      accuracy_m: 12.5,
      age_ms: 60000,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe(`${API_URL}/api/v1/attendance/attempt/prepare`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      marking_token: "tok-identificado",
      location: {
        latitude: -12.0464,
        longitude: -77.0428,
        accuracy_m: 12.5,
        age_ms: 60000,
      },
    });
    expect(result.marking_token).toBe("tok-renovado");
    expect(result.marked_at).toBe("2026-10-16T12:00:05+00:00");
    expect(result.expires_at).toBe("2026-10-16T12:05:05+00:00");
    expect(result.location).toEqual(LOCATION);
  });

  it("la recuperación usa el snapshot anidado real sin inventar datos", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        state: "PENDING",
        record: null,
        evidence_ready: false,
        write_token_valid: true,
        marking_token: "tok-renovado",
        preparation: {
          marked_at: "2026-10-16T12:00:05+00:00",
          expires_at: "2026-10-16T12:05:05+00:00",
          location: LOCATION,
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const status = await attendanceApi.attemptStatus("tok-identificado");

    expect(status.state).toBe("PENDING");
    expect(status.marking_token).toBe("tok-renovado");
    expect(status.preparation).toEqual({
      marked_at: "2026-10-16T12:00:05+00:00",
      expires_at: "2026-10-16T12:05:05+00:00",
      location: LOCATION,
    });
    // El DTO real no expone marked_at/location planos: van dentro de preparation.
    const raw = status as unknown as Record<string, unknown>;
    expect(raw.marked_at).toBeUndefined();
    expect(raw.location).toBeUndefined();
  });

  it("acepta un resultado antiguo sin preparación", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ state: "PENDING", record: null, write_token_valid: false }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const status = await attendanceApi.attemptStatus("tok-identificado");

    expect(status.preparation).toBeUndefined();
    expect(status.marking_token).toBeUndefined();
  });
});

describe("evidencia privada con sello", () => {
  it("expone marked_at, location y stamped_available sin romper las claves antiguas", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        record_id: "rec-1",
        check_in: {
          id: "ev-1",
          captured_at: "2026-10-16T12:00:05+00:00",
          content_type: "image/jpeg",
          available: true,
          marked_at: "2026-10-16T12:00:05+00:00",
          location: LOCATION,
          stamped_available: true,
        },
        check_out: null,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const meta = await attendanceAdminApi.evidenceMeta("rec-1");

    expect(meta.check_in?.id).toBe("ev-1");
    expect(meta.check_in?.available).toBe(true);
    expect(meta.check_in?.marked_at).toBe("2026-10-16T12:00:05+00:00");
    expect(meta.check_in?.location).toEqual(LOCATION);
    expect(meta.check_in?.stamped_available).toBe(true);
    expect(meta.check_out).toBeNull();
  });

  it("descarga el derivado sellado del endpoint privado con credenciales", async () => {
    const blob = new Blob(["stamped"], { type: "image/jpeg" });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(blob, { status: 200, headers: { "Content-Type": "image/jpeg" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const url = await attendanceAdminApi.evidenceStampedImage("ev-1");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [requestUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(requestUrl)).toBe(
      `${API_URL}/api/v1/attendance/evidence/ev-1/stamped-image`,
    );
    expect(init.credentials).toBe("include");
    expect(url).toBe("blob:mock-object-url");
    expect(String(requestUrl)).not.toContain("/image");
  });

  it("falla con ApiError cuando el sello no está disponible y no cae al original", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ detail: "not found" }, 404),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(attendanceAdminApi.evidenceStampedImage("ev-1")).rejects.toBeInstanceOf(ApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("/stamped-image");
  });

  it("mantiene la imagen original en su endpoint de solo bytes", async () => {
    const blob = new Blob(["original"], { type: "image/jpeg" });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(blob, { status: 200, headers: { "Content-Type": "image/jpeg" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const url = await attendanceAdminApi.evidenceImage("ev-1");

    expect(String(fetchMock.mock.calls[0][0])).toBe(
      `${API_URL}/api/v1/attendance/evidence/ev-1/image`,
    );
    expect(url).toBe("blob:mock-object-url");
  });
});
