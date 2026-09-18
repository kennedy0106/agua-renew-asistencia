"use client";

import { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

const DIALOG_EXIT_MS = 170;
const DialogCloseContext = createContext<(() => void) | null>(null);

export function AppDialogCloseButton({
  onClick,
  type = "button",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const requestClose = useContext(DialogCloseContext);
  return (
    <button
      {...props}
      type={type}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) requestClose?.();
      }}
    />
  );
}

/** Modal de tarea crítica: siempre escapa de transforms/overflow del contenido. */
export default function AppDialog({
  children,
  labelledBy,
  describedBy,
  onClose,
  dismissible = true,
  className = "",
}: {
  children: React.ReactNode;
  labelledBy: string;
  describedBy?: string;
  onClose: () => void;
  dismissible?: boolean;
  className?: string;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const closeRef = useRef(onClose);
  const dismissibleRef = useRef(dismissible);
  const closingRef = useRef(false);
  const closeTimerRef = useRef<number | null>(null);
  const [motionState, setMotionState] = useState<"entering" | "open" | "exiting">("entering");
  const titleId = useId();

  useEffect(() => { closeRef.current = onClose; }, [onClose]);
  useEffect(() => { dismissibleRef.current = dismissible; }, [dismissible]);

  const requestClose = useCallback(() => {
    if (!dismissibleRef.current || closingRef.current) return;
    closingRef.current = true;
    setMotionState("exiting");
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    closeTimerRef.current = window.setTimeout(() => closeRef.current(), reduceMotion ? 120 : DIALOG_EXIT_MS);
  }, []);

  useEffect(() => {
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const frame = requestAnimationFrame(() => {
      setMotionState("open");
      dialogRef.current?.querySelector<HTMLElement>("[data-autofocus], input, button:not([disabled]), [href]")?.focus();
    });
    const closeWithEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      requestClose();
    };
    document.addEventListener("keydown", closeWithEscape, true);
    return () => {
      cancelAnimationFrame(frame);
      if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
      document.removeEventListener("keydown", closeWithEscape, true);
      document.body.style.overflow = overflow;
      previousFocus.current?.focus();
    };
  }, [requestClose]);

  function trapFocus(event: React.KeyboardEvent<HTMLDivElement>) {
    // Escape is handled once at document capture level so nested calendars and
    // selects cannot swallow it before the dialog gets a chance to close.
    if (event.key === "Escape") return;
    if (event.key !== "Tab") return;
    const items = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])') ?? []);
    if (!items.length) return;
    const first = items[0], last = items.at(-1)!;
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="dialog-backdrop dialog-portal" data-motion-state={motionState} onMouseDown={requestClose}>
      <div ref={dialogRef} className={`app-dialog ${className}`} role="dialog" aria-modal="true" aria-labelledby={labelledBy || titleId} aria-describedby={describedBy} onMouseDown={(event) => event.stopPropagation()} onKeyDownCapture={trapFocus}>
        <DialogCloseContext.Provider value={requestClose}>{children}</DialogCloseContext.Provider>
      </div>
    </div>,
    document.body,
  );
}
