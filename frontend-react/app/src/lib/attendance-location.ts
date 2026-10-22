/** Lectura puntual de ubicación y presentación de fallas; sin estado de React. */
export const LOCATION_TOTAL_BUDGET_MS = 20_000;
const LOCATION_ATTEMPT_TIMEOUT_MS = 7_000;
const LOCATION_MAX_ATTEMPTS = 3;
const RETRYABLE_LOCATION_FAILURES: ReadonlySet<LocationFailure> = new Set([
  "accuracy",
  "timeout",
  "unavailable",
]);
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
 * presupuesto total de 20 s porque algunos navegadores no respetan `timeout`.
 * Sólo se reintenta una lectura imprecisa o transitoriamente fallida; permiso
 * denegado o geolocalización no soportada terminan de inmediato. Cada intento
 * usa el tiempo que queda, nunca un plazo nuevo que estire el total.
 */
export function requestBrowserPosition(
  now: () => number = () => performance.now(),
): Promise<LocationResult> {
  if (typeof navigator === "undefined" || !navigator.geolocation?.getCurrentPosition) {
    return Promise.resolve({ ok: false, reason: "unsupported" });
  }
  const geolocation = navigator.geolocation;
  return new Promise<LocationResult>((resolve) => {
    let settled = false;
    let attemptTimer: number | undefined;
    let attempts = 0;
    const budgetDeadline = now() + LOCATION_TOTAL_BUDGET_MS;

    const finish = (result: LocationResult) => {
      if (settled) return;
      settled = true;
      if (attemptTimer !== undefined) window.clearTimeout(attemptTimer);
      window.clearTimeout(budgetTimer);
      resolve(result);
    };
    const budgetTimer = window.setTimeout(
      () => finish({ ok: false, reason: "timeout" }),
      LOCATION_TOTAL_BUDGET_MS,
    );

    const retryOrFinish = (reason: LocationFailure) => {
      const remaining = budgetDeadline - now();
      const canRetry =
        RETRYABLE_LOCATION_FAILURES.has(reason) &&
        attempts < LOCATION_MAX_ATTEMPTS &&
        remaining > 250;
      if (canRetry) {
        startAttempt();
        return;
      }
      finish({ ok: false, reason });
    };

    const startAttempt = () => {
      if (settled) return;
      const remaining = Math.max(0, budgetDeadline - now());
      if (remaining <= 0) {
        finish({ ok: false, reason: "timeout" });
        return;
      }
      attempts += 1;
      const attemptTimeout = Math.min(remaining, LOCATION_ATTEMPT_TIMEOUT_MS);
      let attemptSettled = false;
      const settleAttempt = (result: LocationResult) => {
        if (attemptSettled || settled) return;
        attemptSettled = true;
        window.clearTimeout(attemptTimer);
        if (result.ok) {
          finish(result);
          return;
        }
        retryOrFinish(result.reason);
      };
      attemptTimer = window.setTimeout(
        () => settleAttempt({ ok: false, reason: "timeout" }),
        attemptTimeout,
      );
      try {
        geolocation.getCurrentPosition(
          (position) => {
            const observedMonotonicMs = now();
            const { latitude, longitude, accuracy } = position.coords;
            const validCoordinates =
              Number.isFinite(latitude) && latitude >= -90 && latitude <= 90 &&
              Number.isFinite(longitude) && longitude >= -180 && longitude <= 180;
            if (!validCoordinates || !Number.isFinite(accuracy) || accuracy <= 0) {
              settleAttempt({ ok: false, reason: "invalid" });
              return;
            }
            if (accuracy > LOCATION_MAX_ACCURACY_M) {
              settleAttempt({ ok: false, reason: "accuracy" });
              return;
            }
            settleAttempt({
              ok: true,
              position: { latitude, longitude, accuracyM: accuracy, observedMonotonicMs },
            });
          },
          (error) => {
            if (error?.code === 1) settleAttempt({ ok: false, reason: "denied" });
            else if (error?.code === 3) settleAttempt({ ok: false, reason: "timeout" });
            else settleAttempt({ ok: false, reason: "unavailable" });
          },
          { enableHighAccuracy: true, maximumAge: 0, timeout: attemptTimeout },
        );
      } catch {
        settleAttempt({ ok: false, reason: "unavailable" });
      }
    };

    startAttempt();
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

export type LocationFailureCopy = {
  title: string;
  description: string;
  help: string;
};

/**
 * Texto de la ventana de alerta previa a identificar. Cada causa explica lo
 * que se sabe sin afirmar una causa que el navegador no demuestra (por
 * ejemplo, `accuracy` no prueba que el GPS esté apagado) y ofrece una salida
 * genérica junto a la dirección del navegador, sin prometer ajustes del sistema.
 */
export function locationFailureCopy(reason: LocationFailure): LocationFailureCopy {
  switch (reason) {
    case "denied":
      return {
        title: "Activa la ubicación para continuar",
        description:
          "El navegador bloqueó la ubicación para este sitio. Revisa el permiso de ubicación de este sitio en el navegador, junto a la dirección, y comprueba que la ubicación del equipo esté activada.",
        help: "Si no puedes cambiar el permiso, pide ayuda a tu supervisor.",
      };
    case "accuracy":
      return {
        title: "Necesitamos una ubicación más precisa",
        description:
          "La lectura recibida tiene un margen mayor de 50 metros. Comprueba que la ubicación o el GPS del equipo estén activados y, si tu equipo lo ofrece, activa la ubicación precisa. Espera unos segundos y pulsa Reintentar.",
        help: "Si la lectura sigue siendo imprecisa, pide ayuda a tu supervisor.",
      };
    case "timeout":
      return {
        title: "La ubicación está tardando demasiado",
        description:
          "La lectura de ubicación tardó más de 20 segundos. Espera unos segundos, revisa la señal del equipo y pulsa Reintentar.",
        help: "Si vuelve a ocurrir, pide ayuda a tu supervisor.",
      };
    case "unsupported":
      return {
        title: "Este equipo no puede usar la ubicación",
        description:
          "Este navegador no puede obtener la ubicación de este sitio. Usa un equipo o navegador compatible y vuelve a intentarlo.",
        help: "Si no puedes usar otro equipo, pide ayuda a tu supervisor.",
      };
    case "invalid":
      return {
        title: "La ubicación recibida no es válida",
        description:
          "El equipo devolvió una lectura incompleta o fuera de rango. Espera unos segundos y pulsa Reintentar.",
        help: "Si el problema continúa, pide ayuda a tu supervisor.",
      };
    default:
      return {
        title: "No pudimos obtener tu ubicación",
        description:
          "El equipo no entregó una ubicación en este momento. Comprueba que la ubicación del equipo esté activada, espera unos segundos y pulsa Reintentar.",
        help: "Si el problema continúa, pide ayuda a tu supervisor.",
      };
  }
}
