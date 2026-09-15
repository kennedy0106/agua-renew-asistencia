"use client";

import Link, { type LinkProps } from "next/link";
import { useRouter } from "next/navigation";
import type { AnchorHTMLAttributes, ReactNode } from "react";

/** Prefetch exclusivamente cuando el operador revela intención, nunca al pintar toda la barra. */
export default function IntentLink({ href, children, onClick, ...props }: LinkProps & AnchorHTMLAttributes<HTMLAnchorElement> & { children: ReactNode }) {
  const router = useRouter();
  // El shell solo enlaza rutas internas literales; mantener ese contrato evita
  // volver a habilitar el prefetch masivo de la barra lateral.
  const prefetch = () => router.prefetch(href as string);
  return <Link href={href} prefetch={false} onMouseEnter={prefetch} onFocus={prefetch} onTouchStart={prefetch} onClick={onClick} {...props}>{children}</Link>;
}
