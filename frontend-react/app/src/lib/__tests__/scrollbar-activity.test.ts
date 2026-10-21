// Actividad de barras de desplazamiento nativas.
//
// El pulgar de cada scroll nativo (raíz de la página, paneles internos y
// diálogos en portal) se marca como activo mientras el usuario desplaza y
// vuelve a su estado sutil ~1 s después del último scroll. Estos tests usan
// eventos `scroll` reales sobre el DOM y sólo observan el efecto público
// (el atributo de actividad), nunca el estado interno del helper.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  installScrollbarActivity,
  SCROLLBAR_ACTIVITY_ATTRIBUTE,
  SCROLLBAR_IDLE_MS,
} from "@/lib/scrollbar-activity";

const ATTR = SCROLLBAR_ACTIVITY_ATTRIBUTE;

let disposers: Array<() => void> = [];
let fixtures: HTMLElement[] = [];

function install(options?: Parameters<typeof installScrollbarActivity>[0]) {
  const dispose = installScrollbarActivity(options);
  disposers.push(dispose);
  return dispose;
}

/** Panel con desborde real, equivalente a un panel montado dentro de `#root`. */
function panel({ parent = document.body }: { parent?: HTMLElement } = {}) {
  const host = document.createElement("div");
  host.style.height = "20px";
  host.style.overflow = "auto";
  host.setAttribute("data-test-panel", "");
  const content = document.createElement("div");
  content.style.height = "400px";
  content.style.width = "400px";
  host.append(content);
  parent.append(host);
  fixtures.push(host);
  return host;
}

/** Dispara el evento nativo `scroll` tal como lo hace el navegador (no burbujea). */
function scrollOn(target: EventTarget) {
  const event = new Event("scroll", { bubbles: false, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  for (const dispose of disposers) dispose();
  disposers = [];
  for (const fixture of fixtures) fixture.remove();
  fixtures = [];
  vi.useRealTimers();
});

describe("installScrollbarActivity — mapeo del scroller", () => {
  it("marca el scroller raíz cuando el evento llega al documento", () => {
    install();

    scrollOn(document);

    const root = document.scrollingElement ?? document.documentElement;
    expect(root).toHaveAttribute(ATTR, "true");
  });

  it("cae al elemento raíz cuando el documento no expone scrollingElement", () => {
    const descriptor = Object.getOwnPropertyDescriptor(Document.prototype, "scrollingElement");
    Object.defineProperty(document, "scrollingElement", { value: null, configurable: true });
    try {
      install();

      scrollOn(document);

      expect(document.documentElement).toHaveAttribute(ATTR, "true");
    } finally {
      delete (document as unknown as Record<string, unknown>).scrollingElement;
      if (descriptor) Object.defineProperty(Document.prototype, "scrollingElement", descriptor);
    }
  });

  it("sólo marca el contenedor que se desplaza, nunca la raíz ni sus vecinos", () => {
    install();
    const scrolled = panel();
    const sibling = panel();

    scrollOn(scrolled);

    expect(scrolled).toHaveAttribute(ATTR, "true");
    expect(sibling).not.toHaveAttribute(ATTR);
    expect(document.documentElement).not.toHaveAttribute(ATTR);
  });

  it("cubre paneles en portal montados después de instalar, sin registros extra", () => {
    install();
    const portal = document.createElement("div");
    portal.setAttribute("data-test-portal", "");
    document.body.append(portal);

    const mountedLater = panel({ parent: portal });
    scrollOn(mountedLater);

    expect(mountedLater).toHaveAttribute(ATTR, "true");
  });
});

describe("installScrollbarActivity — temporizador", () => {
  it("vuelve al estado inactivo un segundo después del último scroll", () => {
    install();
    const scrolled = panel();

    scrollOn(scrolled);
    vi.advanceTimersByTime(SCROLLBAR_IDLE_MS - 1);
    expect(scrolled).toHaveAttribute(ATTR, "true");

    vi.advanceTimersByTime(1);
    expect(scrolled).not.toHaveAttribute(ATTR);
  });

  it("reinicia la cuenta atrás con cada scroll del mismo contenedor", () => {
    install();
    const scrolled = panel();

    scrollOn(scrolled);
    vi.advanceTimersByTime(600);
    scrollOn(scrolled);
    vi.advanceTimersByTime(600);

    expect(scrolled).toHaveAttribute(ATTR, "true");

    vi.advanceTimersByTime(SCROLLBAR_IDLE_MS - 600);
    expect(scrolled).not.toHaveAttribute(ATTR);
  });

  it("mantiene un temporizador independiente por contenedor", () => {
    install();
    const first = panel();
    const second = panel();

    scrollOn(first);
    vi.advanceTimersByTime(600);
    scrollOn(second);
    vi.advanceTimersByTime(600);

    expect(first).not.toHaveAttribute(ATTR);
    expect(second).toHaveAttribute(ATTR, "true");
  });

  it("respeta un retardo configurado por el consumidor", () => {
    install({ idleMs: 250 });
    const scrolled = panel();

    scrollOn(scrolled);
    vi.advanceTimersByTime(250);

    expect(scrolled).not.toHaveAttribute(ATTR);
  });
});

describe("installScrollbarActivity — no interfiere con el desplazamiento nativo", () => {
  it("no cancela el evento ni mueve las posiciones de scroll", () => {
    install();
    const scrolled = panel();
    scrolled.scrollTop = 30;
    scrolled.scrollLeft = 12;
    const before = {
      top: scrolled.scrollTop,
      left: scrolled.scrollLeft,
      pageY: window.scrollY,
      pageX: window.scrollX,
    };

    const event = scrollOn(scrolled);

    expect(event.defaultPrevented).toBe(false);
    expect({
      top: scrolled.scrollTop,
      left: scrolled.scrollLeft,
      pageY: window.scrollY,
      pageX: window.scrollX,
    }).toEqual(before);
  });
});

describe("installScrollbarActivity — desinstalación", () => {
  it("retira marcadores, temporizadores y el listener al desinstalar", () => {
    const dispose = install();
    const scrolled = panel();
    scrollOn(scrolled);
    expect(scrolled).toHaveAttribute(ATTR, "true");

    dispose();
    expect(scrolled).not.toHaveAttribute(ATTR);

    vi.advanceTimersByTime(SCROLLBAR_IDLE_MS * 4);
    expect(scrolled).not.toHaveAttribute(ATTR);

    scrollOn(scrolled);
    expect(scrolled).not.toHaveAttribute(ATTR);
  });

  it("soporta desinstalación repetida sin lanzar", () => {
    const dispose = install();
    const scrolled = panel();
    scrollOn(scrolled);

    expect(() => {
      dispose();
      dispose();
    }).not.toThrow();
    expect(scrolled).not.toHaveAttribute(ATTR);
  });

  it("se reinstala limpio, como hace StrictMode en desarrollo", () => {
    const firstDispose = install();
    const scrolled = panel();
    scrollOn(scrolled);
    expect(scrolled).toHaveAttribute(ATTR, "true");
    firstDispose();

    const secondDispose = install();
    scrollOn(scrolled);
    expect(scrolled).toHaveAttribute(ATTR, "true");

    vi.advanceTimersByTime(SCROLLBAR_IDLE_MS);
    expect(scrolled).not.toHaveAttribute(ATTR);

    secondDispose();
    expect(scrolled).not.toHaveAttribute(ATTR);
  });
});
