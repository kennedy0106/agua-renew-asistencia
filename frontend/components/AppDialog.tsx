"use client";

import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";

/** Modal de tarea crítica: siempre escapa de transforms/overflow del contenido. */
export default function AppDialog({
  children,
  labelledBy,
  describedBy,
  onClose,
  className = "",
}: {
  children: React.ReactNode;
  labelledBy: string;
  describedBy?: string;
  onClose: () => void;
  className?: string;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const titleId = useId();

  useEffect(() => {
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const frame = requestAnimationFrame(() => {
      dialogRef.current?.querySelector<HTMLElement>("[data-autofocus], input, button:not([disabled]), [href]")?.focus();
    });
    return () => {
      cancelAnimationFrame(frame);
      document.body.style.overflow = overflow;
      previousFocus.current?.focus();
    };
  }, []);

  function trapFocus(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
    if (event.key !== "Tab") return;
    const items = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])') ?? []);
    if (!items.length) return;
    const first = items[0], last = items.at(-1)!;
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="dialog-backdrop dialog-portal" onMouseDown={onClose}>
      <div ref={dialogRef} className={`app-dialog ${className}`} role="dialog" aria-modal="true" aria-labelledby={labelledBy || titleId} aria-describedby={describedBy} onMouseDown={(event) => event.stopPropagation()} onKeyDown={trapFocus}>
        {children}
      </div>
    </div>,
    document.body,
  );
}
