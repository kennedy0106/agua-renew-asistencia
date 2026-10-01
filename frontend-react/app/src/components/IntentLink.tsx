import type { AnchorHTMLAttributes, ReactNode } from "react";
import { Link } from "react-router-dom";

type IntentLinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
  href: string;
  children: ReactNode;
  /**
   * Notifica al shell que el operador reveló intención de navegar (clic/teclado).
   * En Next el prefetch de ruta se disparaba aquí; React Router no expone prefetch
   * de rutas, así que se conserva el contrato de `href`/`onNavigate` sin cambiar
   * el comportamiento visible.
   */
  onNavigate?: () => void;
};

/** Enlace interno del shell: `href` de Next se traduce a `to` de React Router. */
export default function IntentLink({
  href,
  children,
  onClick,
  onNavigate,
  ...props
}: IntentLinkProps) {
  return (
    <Link
      to={href}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented) return;
        // Solo la intención de navegación primaria (clic izquierdo sin
        // modificadores) debe notificarse. Un clic con modificador abre en otra
        // pestaña/ventana o añade a selección, así que no es una navegación del
        // shell y no debe disparar `onNavigate`.
        if (event.button !== 0) return;
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        onNavigate?.();
      }}
      {...props}
    >
      {children}
    </Link>
  );
}
