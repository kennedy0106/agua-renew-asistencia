/** Lectura puntual de ubicación y presentación de fallas; sin estado de React. */
const LOCATION_TIMEOUT_MS = 20_000;
export const LOCATION_MAX_ACCURACY_M = 50;
export const LOCATION_MAX_AGE_MS = 60_000;

export type ClientPosition = {
  latitude: number;
  longitude: number;
  /** Radio horizontal reportado por el dispositivo; es una estimación, no una prueba. */
  accuracyM: number;
  /** Reloj monótono (performance.now) del instante en que llegó la lectura. */
  observedMonotonicMs: number;
};

export type LocationFailure = "unsupported" | "denied" | "unavailable" | "timeout" | "accuracy" | "invalid";
export type LocationResult = { ok: true; position: ClientPosition } | { ok: false; reason: LocationFailure };

export function locationAgeMs(position: ClientPosition, nowMonotonicMs: number): number {
  return Math.max(0, Math.round(nowMonotonicMs - position.observedMonotonicMs));
}

/**
 * Lectura puntual (nunca `watchPosition`): alta precisión, sin caché y con un
 * plazo propio de 20 s porque algunos navegadores no respetan `timeout`.
 */
export function requestBrowserPosition(now: () => number = () => performance.now()): Promise<LocationResult> {
  if (typeof navigator === "undefined" || !navigator.geolocation?.getCurrentPosition) {
    return Promise.resolve({ ok: false, reason: "unsupported" });
  }
  const geolocation = navigator.geolocation;
  return new Promise<LocationResult>((resolve) => {
    let settled = false;
    const finish = (result: LocationResult) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(deadline);
      resolve(result);
    };
    const deadline = window.setTimeout(() => finish({ ok: false, reason: "timeout" }), LOCATION_TIMEOUT_MS);
    try {
      geolocation.getCurrentPosition(
        (position) => {
          const observedMonotonicMs = now();
          const { latitude, longitude, accuracy } = position.coords;
          const validCoordinates =
            Number.isFinite(latitude) && latitude >= -90 && latitude <= 90 &&
            Number.isFinite(longitude) && longitude >= -180 && longitude <= 180;
          if (!validCoordinates || !Number.isFinite(accuracy) || accuracy <= 0) {
            finish({ ok: false, reason: "invalid" });
            return;
          }
          if (accuracy > LOCATION_MAX_ACCURACY_M) {
            finish({ ok: false, reason: "accuracy" });
            return;
          }
          finish({ ok: true, position: { latitude, longitude, accuracyM: accuracy, observedMonotonicMs } });
        },
        (error) => {
          if (error?.code === 1) finish({ ok: false, reason: "denied" });
          else if (error?.code === 3) finish({ ok: false, reason: "timeout" });
          else finish({ ok: false, reason: "unavailable" });
        },
        { enableHighAccuracy: true, maximumAge: 0, timeout: LOCATION_TIMEOUT_MS },
      );
    } catch {
      finish({ ok: false, reason: "unavailable" });
    }
  });
}

export function locationFailureMessage(reason: LocationFailure): string {
  switch (reason) {
    case "denied":
      return "El navegador bloqueó el acceso a la ubicación. Habilite el permiso de ubicación para este sitio y vuelva a intentar la marcación.";
    case "timeout":
      return "La ubicación tardó más de 20 segundos. Acerque el equipo a una zona con mejor señal y vuelva a intentar.";
    case "accuracy":
      return "La ubicación recibida no es suficientemente precisa (máximo 50 metros). Espere unos segundos y vuelva a intentar.";
    case "unsupported":
      return "Este navegador no puede obtener la ubicación del equipo. Use un dispositivo con ubicación habilitada para marcar asistencia.";
    default:
      return "No se pudo obtener la ubicación del equipo. Revise que la ubicación esté habilitada y vuelva a intentar la marcación.";
  }
}
