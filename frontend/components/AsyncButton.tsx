"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Spinner } from "@/components/Loading";

type AsyncButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  busy?: boolean;
  busyLabel?: string;
  children: ReactNode;
};

/** Botón de mutación con un estado inequívoco y estable para teclado y lector. */
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
      {busy ? (
        <>
          <Spinner />
          <span>{busyLabel}</span>
        </>
      ) : children}
    </button>
  );
}
