/**
 * Actividad de las barras de desplazamiento nativas.
 *
 * El sistema visual (`styles/globals.css`) deja el pulgar de cada scroll
 * nativo en un azul sutil y lo lleva al azul pleno mientras el usuario lo usa.
 * Este helper es lo único que hay que instalar para que eso ocurra en todas
 * las barras: raíz de la página, paneles internos y diálogos montados en
 * portal.
 *
 * Cómo funciona: un único listener de `scroll` en fase de captura sobre el
 * documento. La captura ve los eventos de cualquier contenedor —incluidos los
 * que todavía no existen— así que no hacen falta observadores de mutaciones ni
 * registros por pantalla. Cada contenedor desplazado se marca con
 * `data-scrollbar-active="true"` y vuelve a su estado inactivo ~1 s después de
 * su último scroll.
 *
 * El listener es pasivo y nunca cancela el evento: la posición, la velocidad y
 * el comportamiento nativo del desplazamiento quedan intactos.
 */

/** Atributo que `styles/globals.css` usa para pintar el pulgar activo. */
export const SCROLLBAR_ACTIVITY_ATTRIBUTE = "data-scrollbar-active";

/** Milisegundos de calma antes de que el pulgar vuelva a su estado sutil. */
export const SCROLLBAR_IDLE_MS = 1000;

export type ScrollbarActivityOptions = {
  /** Calma antes de volver al estado inactivo. Por defecto `SCROLLBAR_IDLE_MS`. */
  idleMs?: number;
};

/**
 * Instala el seguimiento de actividad y devuelve su desinstalador. Se llama una
 * sola vez por documento (el efecto de `App`), y el desinstalador es seguro de
 * invocar más de una vez para que StrictMode pueda montar, desmontar y volver a
 * montar sin dejar marcadores ni temporizadores obsoletos.
 */
export function installScrollbarActivity({
  idleMs = SCROLLBAR_IDLE_MS,
}: ScrollbarActivityOptions = {}): () => void {
  if (typeof document === "undefined") return () => {};

  const doc = document;
  // Un temporizador por contenedor activo: el pulgar de un panel no decide
  // cuándo se apaga el de la raíz ni el de un scroller anidado.
  const timers = new Map<Element, ReturnType<typeof setTimeout>>();

  function scrollerFor(target: EventTarget | null): Element | null {
    // Los eventos de scroll de la ventana llegan con target `document` (o
    // `window` según el motor): la barra visible es la del scroller raíz.
    if (target === doc || target === doc.defaultView) {
      return doc.scrollingElement ?? doc.documentElement ?? null;
    }
    // Un contenedor sólo puede marcar su propia barra.
    return target instanceof Element ? target : null;
  }

  function handleScroll(event: Event) {
    const scroller = scrollerFor(event.target);
    if (!scroller) return;

    const pending = timers.get(scroller);
    if (pending !== undefined) clearTimeout(pending);
    if (scroller.getAttribute(SCROLLBAR_ACTIVITY_ATTRIBUTE) !== "true") {
      scroller.setAttribute(SCROLLBAR_ACTIVITY_ATTRIBUTE, "true");
    }
    timers.set(
      scroller,
      setTimeout(() => {
        timers.delete(scroller);
        scroller.removeAttribute(SCROLLBAR_ACTIVITY_ATTRIBUTE);
      }, idleMs),
    );
  }

  function settle(scroller: Element) {
    const pending = timers.get(scroller);
    if (pending !== undefined) clearTimeout(pending);
    timers.delete(scroller);
    scroller.removeAttribute(SCROLLBAR_ACTIVITY_ATTRIBUTE);
  }

  doc.addEventListener("scroll", handleScroll, { capture: true, passive: true });

  return () => {
    doc.removeEventListener("scroll", handleScroll, { capture: true });
    for (const scroller of [...timers.keys()]) settle(scroller);
  };
}
