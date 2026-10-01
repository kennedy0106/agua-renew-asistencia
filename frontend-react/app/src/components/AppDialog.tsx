
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

const DIALOG_EXIT_MS = 170;

type DialogCloseControls = {
  /** Cierre implícito (Escape/backdrop). Respeta `dismissible`. */
  requestClose: () => void;
  /**
   * Cierre explícito (botón de cierre). Anima la salida aunque el diálogo no
   * sea descartable —p. ej. un formulario sucio cuyo descarte el consumidor ya
   * confirmó—. El consumidor cancela el cierre llamando a
   * `event.preventDefault()` en el `onClick` del botón.
   */
  requestExplicitClose: () => void;
};

const DialogCloseContext = createContext<DialogCloseControls | null>(null);

export function AppDialogCloseButton({
  onClick,
  type = "button",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const controls = useContext(DialogCloseContext);
  return (
    <button
      {...props}
      type={type}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) controls?.requestExplicitClose();
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

  const beginClose = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    setMotionState("exiting");
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    closeTimerRef.current = window.setTimeout(() => closeRef.current(), reduceMotion ? 120 : DIALOG_EXIT_MS);
  }, []);

  // Escape y backdrop son cierres implícitos: no pueden abandonar un diálogo
  // con `dismissible={false}` (p. ej. un formulario sucio sin confirmar).
  const requestClose = useCallback(() => {
    if (!dismissibleRef.current) return;
    beginClose();
  }, [beginClose]);

  // El botón de cierre es un cierre explícito: el consumidor ya decidió
  // (confirmación de descarte) o canceló el onClick con `preventDefault`.
  // Por eso no lo bloquea `dismissible`.
  const requestExplicitClose = useCallback(() => {
    beginClose();
  }, [beginClose]);

  const closeControls = useMemo<DialogCloseControls>(
    () => ({ requestClose, requestExplicitClose }),
    [requestClose, requestExplicitClose],
  );

  useEffect(() => {
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const frame = requestAnimationFrame(() => {
      setMotionState("open");
      dialogRef.current?.querySelector<HTMLElement>("[data-autofocus], input, button:not([disabled]), [href]")?.focus();
    });
    const closeWithEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // Si hay un selector o calendario portaleado abierto (ej. DateField),
      // no cerramos este diálogo padre para permitir que el selector se cierre primero.
      const hasNestedPopup = Boolean(document.querySelector(".datefield-panel, [role='dialog'].is-portaled, [data-floating-portal]"));
      if (hasNestedPopup) return;
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
        <DialogCloseContext.Provider value={closeControls}>{children}</DialogCloseContext.Provider>
      </div>
    </div>,
    document.body,
  );
}
