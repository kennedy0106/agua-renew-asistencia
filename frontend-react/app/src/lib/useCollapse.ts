// Estado y refs de un colapso de altura medida. La transición se interrumpe
// desde la altura actual (no reinicia desde cero), se apoya sólo en `height`
// durante el colapso y en `opacity` para el contenido, y limpia observadores y
// temporizadores al desmontar.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { TransitionEvent } from "react";
import { prefersReducedMotion } from "@/lib/motion";

export const COLLAPSE_DURATION_MS = 200;
const COLLAPSE_FADE_MS = 160;
const FALLBACK_BUFFER_MS = 80;

type Phase = "closed" | "opening" | "open" | "closing";

function contentHeight(inner: HTMLElement | null): number {
  if (!inner) return 0;
  return Math.max(inner.scrollHeight, inner.offsetHeight, inner.getBoundingClientRect().height);
}

function renderedHeight(outer: HTMLElement | null): number {
  if (!outer) return 0;
  const measured = outer.getBoundingClientRect().height;
  if (measured > 0) return measured;
  const inline = Number.parseFloat(outer.style.height);
  return Number.isFinite(inline) ? inline : 0;
}

function currentOpacity(inner: HTMLElement | null, fallback: number): number {
  if (!inner || typeof window === "undefined") return fallback;
  const value = Number.parseFloat(window.getComputedStyle(inner).opacity);
  return Number.isFinite(value) ? value : fallback;
}

/**
 * Estado y refs de un colapso de altura medida. Devuelve `mounted` para que el
 * consumidor pueda retirar la fila o el panel recién cuando termina el cierre.
 */
export function useCollapse(open: boolean, duration = COLLAPSE_DURATION_MS) {
  const [keepMounted, setKeepMounted] = useState(open);
  const mounted = open || keepMounted;
  const outerRef = useRef<HTMLDivElement | null>(null);
  const innerRef = useRef<HTMLDivElement | null>(null);
  const phaseRef = useRef<Phase>(open ? "open" : "closed");
  const timerRef = useRef<number | null>(null);
  const openRef = useRef(open);

  const clearFallback = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const finishOpen = useCallback(() => {
    const outer = outerRef.current;
    if (outer) {
      outer.style.transition = "none";
      outer.style.height = "auto";
      outer.style.overflow = "visible";
      outer.dataset.state = "open";
    }
    phaseRef.current = "open";
    clearFallback();
  }, [clearFallback]);

  const finishClosed = useCallback(() => {
    const outer = outerRef.current;
    if (outer) {
      outer.style.transition = "none";
      outer.style.height = "0px";
      outer.style.overflow = "hidden";
      outer.dataset.state = "closed";
    }
    phaseRef.current = "closed";
    clearFallback();
    setKeepMounted(false);
  }, [clearFallback]);

  const scheduleFallback = useCallback(
    (phase: "opening" | "closing") => {
      clearFallback();
      timerRef.current = window.setTimeout(() => {
        if (phaseRef.current !== phase) return;
        if (phase === "opening") finishOpen();
        else finishClosed();
      }, duration + FALLBACK_BUFFER_MS);
    },
    [clearFallback, duration, finishClosed, finishOpen],
  );

  useLayoutEffect(() => {
    openRef.current = open;
    if (!mounted) return;
    const outer = outerRef.current;
    const inner = innerRef.current;
    if (!outer || !inner) return;

    const reduceMotion = prefersReducedMotion();

    if (open) {
      setKeepMounted(true);
      if (reduceMotion || duration <= 0) {
        outer.style.transition = "none";
        outer.style.height = "auto";
        outer.style.overflow = "visible";
        outer.dataset.state = "open";
        inner.style.transition = "none";
        inner.style.opacity = "1";
        phaseRef.current = "open";
        clearFallback();
        return;
      }
      // Un rerender por reloj, tecleo o datos no debe reiniciar la animación.
      if (phaseRef.current === "open") {
        outer.style.height = "auto";
        outer.style.overflow = "visible";
        return;
      }

      const target = contentHeight(inner);
      const fromClosed = phaseRef.current === "closed";
      const startHeight = fromClosed ? 0 : renderedHeight(outer);
      const startOpacity = fromClosed ? 0 : currentOpacity(inner, 0);

      outer.style.overflow = "hidden";
      outer.style.transition = "none";
      outer.style.height = `${startHeight}px`;
      inner.style.transition = "none";
      inner.style.opacity = `${startOpacity}`;
      // Fuerza el estilo inicial para que la transición tenga un punto de fuga.
      void outer.offsetHeight;

      outer.style.transition = `height ${duration}ms var(--ease-out)`;
      inner.style.transition = `opacity ${Math.min(COLLAPSE_FADE_MS, duration)}ms var(--ease-out)`;
      outer.style.height = `${target}px`;
      inner.style.opacity = "1";
      outer.dataset.state = "opening";
      phaseRef.current = "opening";
      scheduleFallback("opening");
      return;
    }

    if (phaseRef.current === "closed") {
      setKeepMounted(false);
      return;
    }
    if (reduceMotion || duration <= 0) {
      finishClosed();
      return;
    }

    const startHeight = renderedHeight(outer);
    const startOpacity = currentOpacity(inner, 1);

    outer.style.overflow = "hidden";
    outer.style.transition = "none";
    outer.style.height = `${startHeight}px`;
    inner.style.transition = "none";
    inner.style.opacity = `${startOpacity}`;
    void outer.offsetHeight;

    outer.style.transition = `height ${duration}ms var(--ease-out)`;
    inner.style.transition = `opacity ${Math.min(COLLAPSE_FADE_MS, duration)}ms var(--ease-out)`;
    outer.style.height = "0px";
    inner.style.opacity = "0";
    outer.dataset.state = "closing";
    phaseRef.current = "closing";
    scheduleFallback("closing");
  }, [clearFallback, duration, finishClosed, finishOpen, mounted, open, scheduleFallback]);

  // La altura natural se mantiene al terminar; si el contenido cambia de alto
  // mientras está abierto, se recalcula sin animar ni recortar.
  useEffect(() => {
    if (!mounted) return;
    const outer = outerRef.current;
    const inner = innerRef.current;
    if (!outer || !inner) return;

    const syncHeight = () => {
      if (!openRef.current) return;
      const target = contentHeight(inner);
      if (phaseRef.current === "open") {
        outer.style.height = "auto";
      } else if (phaseRef.current === "opening") {
        outer.style.height = `${target}px`;
      }
    };

    const observer =
      typeof ResizeObserver === "function" ? new ResizeObserver(syncHeight) : null;
    observer?.observe(inner);
    window.addEventListener("resize", syncHeight);

    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", syncHeight);
    };
  }, [mounted]);

  useEffect(() => clearFallback, [clearFallback]);

  const handleTransitionEnd = useCallback(
    (event: TransitionEvent<HTMLDivElement>) => {
      if (event.target !== event.currentTarget || event.propertyName !== "height") return;
      const outer = event.currentTarget;
      if (phaseRef.current === "opening") {
        if (renderedHeight(outer) < contentHeight(innerRef.current) - 1) return;
        finishOpen();
      } else if (phaseRef.current === "closing") {
        finishClosed();
      }
    },
    [finishClosed, finishOpen],
  );

  return { mounted, outerRef, innerRef, handleTransitionEnd };
}
