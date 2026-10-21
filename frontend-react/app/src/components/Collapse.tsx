// Colapso reutilizable con altura medida. Se usa en el desglose de las tablas
// de asistencia y en el teclado DNI del kiosco: son los dos casos donde la
// altura del contenido forma parte del flujo y no existe un `transform`
// equivalente que conserve el desplazamiento de las filas.

import type { ReactNode } from "react";
import { COLLAPSE_DURATION_MS, useCollapse } from "@/lib/useCollapse";

type CollapseProps = {
  open: boolean;
  children: ReactNode;
  id?: string;
  className?: string;
  innerClassName?: string;
  duration?: number;
};

/**
 * Contenedor de colapso. Retiene el DOM sólo durante el cierre, con `inert` y
 * `aria-hidden` activos, y lo retira al terminar para no dejar filas vacías.
 */
export function Collapse({
  open,
  children,
  id,
  className,
  innerClassName,
  duration = COLLAPSE_DURATION_MS,
}: CollapseProps) {
  const { mounted, outerRef, innerRef, handleTransitionEnd } = useCollapse(open, duration);
  if (!mounted) return null;

  return (
    <div
      ref={outerRef}
      id={id}
      className={`attendance-collapse${className ? ` ${className}` : ""}`}
      aria-hidden={open ? undefined : true}
      inert={!open}
      onTransitionEnd={handleTransitionEnd}
    >
      <div ref={innerRef} className={`attendance-collapse__inner${innerClassName ? ` ${innerClassName}` : ""}`}>
        {children}
      </div>
    </div>
  );
}
