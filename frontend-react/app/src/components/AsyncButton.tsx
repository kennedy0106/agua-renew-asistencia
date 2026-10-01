
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Spinner } from "@/components/Loading";

type AsyncButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  busy?: boolean;
  busyLabel?: string;
  children: ReactNode;
};

/**
 * Mutation button with a stable normal/busy crossfade.
 *
 * Both labels live in the same grid cell, so the button is always as wide as
 * the wider of the two and only opacity changes. Nothing animates `width` and
 * the surrounding layout never shifts.
 */
export function AsyncButton({
  busy = false,
  busyLabel = "Procesando…",
  children,
  disabled,
  className = "btn btn-primary",
  ...props
}: AsyncButtonProps) {
  return (
    <button
      {...props}
      className={className}
      disabled={disabled || busy}
      aria-busy={busy}
    >
      <span className="async-button__crossfade">
        <span className="async-button__layer" aria-hidden={busy}>
          {children}
        </span>
        <span className="async-button__layer" aria-hidden={!busy}>
          <Spinner />
          <span>{busyLabel}</span>
        </span>
      </span>
    </button>
  );
}
