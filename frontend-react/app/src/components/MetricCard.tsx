import type { ReactNode } from "react";
import IntentLink from "@/components/IntentLink";
import { ChevronRight } from "@/components/Icons";

/**
 * Patrón visual canónico de métrica (Stitch): etiqueta superior, icono tonal,
 * valor tabular, unidad, pie con chip o texto de apoyo y acento de 2px.
 *
 * Es la única fuente de verdad para superficies tipo KPI. Una métrica
 * informativa se renderiza como superficie estática; solo hay enlace o botón
 * cuando existe una navegación o acción real, para no fabricar affordances.
 */
export type MetricTone = "blue" | "green" | "red" | "neutral" | "amber";

/** Tamaño del valor: `lg` es el KPI de dashboard; `md`/`sm` densifican paneles. */
export type MetricSize = "lg" | "md" | "sm";

export type MetricCardProps = {
  /** Etiqueta corta siempre visible que nombra la métrica. */
  label: string;
  /** Valor principal. Se mantiene como texto/número tabular. */
  value: string | number;
  /** Unidad o calificador del valor (p. ej. "ausentes"). */
  unit?: string;
  /** Icono tonal; los iconos del sistema ya son `aria-hidden`. */
  icon?: ReactNode;
  tone?: MetricTone;
  size?: MetricSize;
  /** Contexto en el pie, mostrado como chip con punto de color. */
  chip?: string;
  /** Contexto en el pie sin tratamiento de chip (métricas informativas). */
  supportingText?: string;
  /** Destino interno; convierte la métrica en enlace con precarga. */
  href?: string;
  /** Acción real; convierte la métrica en botón si no hay `href`. */
  onClick?: () => void;
  className?: string;
  /** Nombre accesible explícito para la superficie interactiva. */
  ariaLabel?: string;
  "data-testid"?: string;
};

function composeAccessibleName({ label, value, unit, chip, supportingText }: Pick<MetricCardProps, "label" | "value" | "unit" | "chip" | "supportingText">): string {
  const parts = [`${label}: ${value}`];
  if (unit) parts.push(unit);
  if (chip) parts.push(chip);
  else if (supportingText) parts.push(supportingText);
  return parts.join(". ");
}

export default function MetricCard({
  label,
  value,
  unit,
  icon,
  tone = "neutral",
  size = "lg",
  chip,
  supportingText,
  href,
  onClick,
  className,
  ariaLabel,
  "data-testid": dataTestId,
}: MetricCardProps) {
  const isLink = Boolean(href);
  const isButton = !isLink && Boolean(onClick);
  const isInteractive = isLink || isButton;
  const classes = ["metric-card", `metric-card--${tone}`, `metric-card--${size}`];
  if (isInteractive) classes.push("is-interactive");
  if (className) classes.push(className);

  const content = (
    <>
      <div className="metric-card-head">
        <span className="metric-card-label">{label}</span>
        {icon ? <span className={`metric-card-icon metric-card-icon--${tone}`}>{icon}</span> : null}
      </div>
      <div className="metric-card-value">
        <strong>{value}</strong>
        {unit ? <small>{unit}</small> : null}
      </div>
      {chip || supportingText ? (
        <div className="metric-card-foot">
          {chip ? (
            <span className="metric-card-chip">
              <i aria-hidden />
              {chip}
            </span>
          ) : (
            <span className="metric-card-support">{supportingText}</span>
          )}
          {isInteractive ? <ChevronRight size={16} className="metric-card-arrow" /> : null}
        </div>
      ) : null}
      <span className="metric-card-accent" aria-hidden />
    </>
  );

  if (isLink) {
    return (
      <IntentLink
        href={href as string}
        onClick={onClick}
        className={classes.join(" ")}
        aria-label={ariaLabel ?? `${composeAccessibleName({ label, value, unit, chip, supportingText })}. Abrir detalle`}
        data-interactive="true"
        data-testid={dataTestId}
      >
        {content}
      </IntentLink>
    );
  }

  if (isButton) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={classes.join(" ")}
        aria-label={ariaLabel ?? `${composeAccessibleName({ label, value, unit, chip, supportingText })}. Abrir detalle`}
        data-interactive="true"
        data-testid={dataTestId}
      >
        {content}
      </button>
    );
  }

  return (
    <div className={classes.join(" ")} data-interactive="false" data-testid={dataTestId}>
      {content}
    </div>
  );
}
