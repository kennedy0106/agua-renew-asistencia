import { afterEach, describe, expect, it, vi } from "vitest";
import { LOCATION_MAX_AGE_MS, locationAgeMs, requestBrowserPosition } from "@/lib/attendance-location";

// B3 covers only the stateless helper; preparation API and private evidence follow in B4/B6.
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
