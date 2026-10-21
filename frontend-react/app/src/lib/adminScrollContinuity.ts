import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type { NavigationType } from "react-router-dom";

/**
 * Continuidad de desplazamiento del shell administrativo.
 *
 * El shell es persistente, así que el documento no se recarga al cambiar de
 * sección. Cada entrada del historial conserva su posición:
 * - PUSH/REPLACE empieza arriba,
 * - POP (Atrás/Adelante) recupera la posición guardada de esa entrada.
 *
 * La recuperación no asume que el contenido ya tenga su altura final: las
 * páginas cargan datos de forma asíncrona y una tabla puede empezar como
 * skeleton y crecer después. Por eso se reintenta hasta que el documento pueda
 * alcanzar el objetivo, con un límite de tiempo y sin pelear con el usuario.
 */

const RESTORE_TIMEOUT_MS = 4000;
const RESTORE_RETRY_MS = 50;
const POSITION_TOLERANCE_PX = 1;

type PendingRestore = {
  target: number;
  timer: ReturnType<typeof setTimeout> | null;
};

export type AdminScrollContinuityOptions = {
  locationKey: string;
  navigationType: NavigationType;
};

function canUseDom(): boolean {
  return typeof window !== "undefined" && typeof document !== "undefined";
}

function readScrollTop(): number {
  if (!canUseDom()) return 0;
  return window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0;
}

function maxScrollTop(): number {
  if (!canUseDom()) return 0;
  const root = document.scrollingElement ?? document.documentElement;
  return Math.max(0, root.scrollHeight - window.innerHeight);
}

function scrollWindowTo(top: number): void {
  try {
    window.scrollTo({ top, left: 0, behavior: "auto" });
  } catch {
    try {
      window.scrollTo(0, top);
    } catch {
      // Un entorno sin scroll (SSR o jsdom sin stub) no debe romper la ruta.
    }
  }
}

/**
 * Hook usado por el host persistente. Los listeners globales se instalan una
 * vez; cada cambio de ruta cancela su restauración pendiente y el desmontaje
 * retira listeners, timer y restaura la política nativa del navegador.
 */
export function useAdminScrollContinuity({
  locationKey,
  navigationType,
}: AdminScrollContinuityOptions): void {
  const positionsRef = useRef(new Map<string, number>());
  const activeKeyRef = useRef<string | null>(null);
  const lastRecordedScrollRef = useRef(0);
  const pendingRef = useRef<PendingRestore | null>(null);

  /**
   * `persist: false` es obligatorio al cambiar de ruta: el DOM nuevo ya puede
   * haber limitado el scroll a 0 y ese valor pertenece a la página nueva, no a
   * la anterior. La posición de la entrada que sale se guarda antes, con el
   * último registro fiable del evento de scroll (o la captura de intención).
   */
  const cancelPendingRestore = useCallback((persist = true) => {
    const pending = pendingRef.current;
    if (!pending) return;
    if (pending.timer !== null) clearTimeout(pending.timer);
    pendingRef.current = null;
    if (!persist) return;
    const top = readScrollTop();
    lastRecordedScrollRef.current = top;
    if (activeKeyRef.current) positionsRef.current.set(activeKeyRef.current, top);
  }, []);

  // Los eventos de intención del usuario son la señal para dejar de restaurar.
  // No se usa el evento `scroll` para detectarlo: nuestros propios `scrollTo`
  // también lo disparan y el navegador puede emitir uno al cambiar de entrada.
  useEffect(() => {
    if (!canUseDom()) return;
    let previousRestoration: ScrollRestoration | null = null;
    try {
      previousRestoration = window.history.scrollRestoration;
      window.history.scrollRestoration = "manual";
    } catch {
      // Navegadores sin la API: la restauración propia sigue funcionando.
    }

    let frame: number | null = null;
    const persistCurrentPosition = () => {
      const top = readScrollTop();
      lastRecordedScrollRef.current = top;
      if (activeKeyRef.current) positionsRef.current.set(activeKeyRef.current, top);
    };
    const recordPosition = () => {
      frame = null;
      if (pendingRef.current) return;
      persistCurrentPosition();
    };
    const onScroll = () => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(recordPosition);
    };
    const isInteractiveTarget = (target: EventTarget | null): boolean => {
      if (!(target instanceof Element)) return false;
      return Boolean(
        target.closest(
          'a, button, input, select, textarea, label, [role="button"], [contenteditable="true"]',
        ),
      );
    };
    const onScrollGesture = () => {
      if (pendingRef.current) {
        cancelPendingRestore();
      } else {
        persistCurrentPosition();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const scrollKeys = ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "];
      if (!scrollKeys.includes(event.key)) return;
      if (isInteractiveTarget(event.target)) return;
      onScrollGesture();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!pendingRef.current) {
        // Captura síncrona antes de que el clic/gesto navegue. Si el scroll
        // había ocurrido hace menos de un frame, este es el último valor fiable.
        persistCurrentPosition();
        return;
      }
      // Un clic sobre un control puede iniciar una navegación: la restauración
      // se cancela al confirmarse la ruta, sin escribir el 0 postcommit bajo la
      // entrada anterior. Un clic fuera de controles (incluida la barra de
      // scroll) sí es interacción manual y conserva la posición actual.
      if (!isInteractiveTarget(event.target)) cancelPendingRestore();
    };
    const onPopState = () => {
      // Atrás/Adelante: si ya hay una restauración en curso, el efecto de
      // cambio de ruta decide y conserva el objetivo guardado. Si el listener
      // corre antes de React, se captura el scroll de la entrada que sale.
      if (pendingRef.current) return;
      persistCurrentPosition();
    };

    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("wheel", onScrollGesture, { passive: true });
    window.addEventListener("touchstart", onScrollGesture, { passive: true });
    window.addEventListener("pointerdown", onPointerDown, { passive: true });
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("popstate", onPopState);

    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      cancelPendingRestore();
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("wheel", onScrollGesture);
      window.removeEventListener("touchstart", onScrollGesture);
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("popstate", onPopState);
      try {
        if (previousRestoration) window.history.scrollRestoration = previousRestoration;
      } catch {
        // Nada que restaurar si la API no está disponible.
      }
    };
  }, [cancelPendingRestore]);

  const restorePosition = useCallback(
    (target: number) => {
      const pending: PendingRestore = { target, timer: null };
      pendingRef.current = pending;
      const startedAt = Date.now();

      const attempt = () => {
        if (pendingRef.current !== pending) return;
        pending.timer = null;
        // Se avanza hasta donde el documento permite ahora. Si aún no alcanza,
        // el reintento se repite mientras el contenido asíncrono crece.
        scrollWindowTo(Math.min(target, maxScrollTop()));
        if (Math.abs(readScrollTop() - target) <= POSITION_TOLERANCE_PX) {
          cancelPendingRestore();
          return;
        }
        if (Date.now() - startedAt >= RESTORE_TIMEOUT_MS) {
          cancelPendingRestore();
          return;
        }
        pending.timer = setTimeout(attempt, RESTORE_RETRY_MS);
      };

      attempt();
    },
    [cancelPendingRestore],
  );

  useLayoutEffect(() => {
    if (!canUseDom()) return;
    const previousKey = activeKeyRef.current;
    if (previousKey === null) {
      // Carga inicial: se respeta la posición que el navegador haya resuelto.
      const top = readScrollTop();
      lastRecordedScrollRef.current = top;
      activeKeyRef.current = locationKey;
      positionsRef.current.set(locationKey, top);
      return;
    }
    // StrictMode repite el efecto de montaje con la misma entrada.
    if (previousKey === locationKey) return;

    // Usar el último registro fiable (evento de scroll o captura de intención)
    // evita pisar 376 con el 0 que el navegador ya aplicó al montar una página
    // nueva más corta. Si había una restauración pendiente, la entrada conserva
    // su objetivo guardado: el scroll actual puede ser solo el clamp postcommit.
    if (pendingRef.current) {
      cancelPendingRestore(false);
    } else {
      positionsRef.current.set(previousKey, lastRecordedScrollRef.current);
    }
    activeKeyRef.current = locationKey;

    // Atrás/Adelante (POP) vuelve a su entrada; una navegación nueva empieza
    // arriba. REPLACE se trata como entrada nueva para no heredar la posición.
    const target =
      navigationType === "POP" ? positionsRef.current.get(locationKey) ?? 0 : 0;

    if (target > 0) {
      restorePosition(target);
      return;
    }

    scrollWindowTo(0);
    lastRecordedScrollRef.current = 0;
    positionsRef.current.set(locationKey, 0);
  }, [cancelPendingRestore, locationKey, navigationType, restorePosition]);
}
