import { useEffect, useRef } from "react";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { Link } from "react-router-dom";
import { preloadRoute } from "@/lib/routePreload";

type IntentLinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
  href: string;
  children: ReactNode;
  /**
   * Notifica al shell que el operador reveló intención de navegar (clic/teclado).
   * El prefetch del chunk se dispara aquí mismo, en el gesto más temprano que
   * permita reutilizar la promesa del `React.lazy` de destino.
   */
  onNavigate?: () => void;
};

// Un hover prolongado es intención; rozar la barra no lo es. El retardo evita
// bajar chunks de más al mover el puntero por la navegación.
const HOVER_INTENT_MS = 80;

/** Enlace interno del shell: `href` de Next se traduce a `to` de React Router. */
export default function IntentLink({
  href,
  children,
  onClick,
  onNavigate,
  onMouseEnter,
  onMouseLeave,
  onFocus,
  onPointerDown,
  target,
  ...props
}: IntentLinkProps) {
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Abrir en otra pestaña/ventana renderiza otro documento: precargar aquí no
  // alcanza a ese destino, así que se omite.
  const canPreload = !target || target === "_self";

  useEffect(
    () => () => {
      if (hoverTimer.current) clearTimeout(hoverTimer.current);
    },
    [],
  );

  function preload() {
    if (canPreload) void preloadRoute(href);
  }

  function cancelHoverIntent() {
    if (hoverTimer.current) {
      clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
  }

  return (
    <Link
      to={href}
      target={target}
      onMouseEnter={(event) => {
        onMouseEnter?.(event);
        if (!canPreload || hoverTimer.current) return;
        hoverTimer.current = setTimeout(() => {
          hoverTimer.current = null;
          preload();
        }, HOVER_INTENT_MS);
      }}
      onMouseLeave={(event) => {
        onMouseLeave?.(event);
        cancelHoverIntent();
      }}
      onFocus={(event) => {
        onFocus?.(event);
        cancelHoverIntent();
        preload();
      }}
      onPointerDown={(event) => {
        onPointerDown?.(event);
        if (event.defaultPrevented) return;
        // Solo el puntero primario sin modificadores anticipa la navegación del
        // shell; el resto abre en otra pestaña/ventana o un menú contextual.
        if (event.button !== 0) return;
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        preload();
      }}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented) return;
        // Solo la intención de navegación primaria (clic izquierdo sin
        // modificadores) debe notificarse. Un clic con modificador abre en otra
        // pestaña/ventana o añade a selección, así que no es una navegación del
        // shell y no debe disparar `onNavigate` ni la precarga.
        if (event.button !== 0) return;
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        preload();
        onNavigate?.();
      }}
      {...props}
    >
      {children}
    </Link>
  );
}
