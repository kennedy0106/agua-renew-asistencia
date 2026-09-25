"use client";

// Calendario Renew (GUIA-DISENO.md §7): reemplaza <input type="date"> nativo.
// Semana Lu..Do, español, hoy con anillo, día elegido en azul sólido,
// trigger 2.75rem glass, panel de vidrio con blur. Fechas en America/Lima.

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Calendar } from "./Icons";

const WEEKDAYS = ["Lu", "Ma", "Mi", "Ju", "Vi", "Sá", "Do"];
const MONTHS = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];

function toISO(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function parseISO(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function todayLima(): Date {
  // El negocio opera en America/Lima. Para el selector de fechas basta con la
  // fecha local del navegador (que en el entorno de uso es Lima); el backend
  // sigue siendo la fuente de verdad para marcas y cálculos.
  return new Date();
}

export default function DateField({
  value,
  onChange,
  required = false,
  disabled = false,
  placeholder = "Seleccionar fecha",
  "aria-label": ariaLabel,
}: {
  value: string;
  onChange: (iso: string) => void;
  required?: boolean;
  disabled?: boolean;
  placeholder?: string;
  "aria-label"?: string;
}) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<Date>(() => (value ? parseISO(value) : todayLima()));
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const dayRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const dialogId = useId();
  const [panelPosition, setPanelPosition] = useState<{ left: number; top: number; width: number } | null>(null);

  function closeCalendar({ returnFocus = true }: { returnFocus?: boolean } = {}) {
    setOpen(false);
    setPanelPosition(null);
    if (returnFocus) window.requestAnimationFrame(() => triggerRef.current?.focus());
  }

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  const label = useMemo(() => {
    if (!value) return placeholder;
    return parseISO(value).toLocaleDateString("es-PE", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  }, [value, placeholder]);

  // Cerrar al hacer clic fuera.
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      const target = e.target as Node;
      if (!rootRef.current?.contains(target) && !panelRef.current?.contains(target)) {
        closeCalendar({ returnFocus: false });
      }
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const trigger = triggerRef.current;
      const panel = panelRef.current;
      if (!trigger || !panel) return;

      const margin = 8;
      const gap = 6;
      const triggerRect = trigger.getBoundingClientRect();
      const width = Math.min(292, window.innerWidth - margin * 2);
      const height = panel.offsetHeight;
      const left = Math.min(
        Math.max(margin, triggerRect.left),
        Math.max(margin, window.innerWidth - width - margin),
      );
      const below = triggerRect.bottom + gap;
      const above = triggerRect.top - gap - height;
      const top = below + height <= window.innerHeight - margin
        ? below
        : above >= margin
          ? above
          : Math.max(margin, Math.min(below, window.innerHeight - height - margin));

      setPanelPosition({ left, top, width });
    };
    const frame = window.requestAnimationFrame(place);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, view]);

  const days = useMemo(() => {
    const first = new Date(view.getFullYear(), view.getMonth(), 1);
    // Lunes como primer día (getDay: 0=Domingo..6=Sábado).
    const offset = (first.getDay() + 6) % 7;
    const start = new Date(view.getFullYear(), view.getMonth(), 1 - offset);
    const cells: (Date | null)[] = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      cells.push(d.getMonth() === view.getMonth() ? d : null);
    }
    return cells;
  }, [view]);

  const today = todayLima();
  const selected = value ? parseISO(value) : null;

  useEffect(() => {
    if (!open) return;
    const selectedDate = value ? parseISO(value) : null;
    const currentDate = todayLima();
    const selectedIndex = days.findIndex((day) => day && selectedDate && day.toDateString() === selectedDate.toDateString());
    const todayIndex = days.findIndex((day) => day && day.toDateString() === currentDate.toDateString());
    const firstDay = days.findIndex(Boolean);
    const nextIndex = selectedIndex >= 0 ? selectedIndex : todayIndex >= 0 ? todayIndex : firstDay;
    setFocusedIndex(nextIndex);
    const frame = window.requestAnimationFrame(() => dayRefs.current[nextIndex]?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [days, open, value]);

  function pick(d: Date | null) {
    if (!d) return;
    onChange(toISO(d));
    closeCalendar();
  }

  function shiftMonth(delta: number) {
    setView((v) => new Date(v.getFullYear(), v.getMonth() + delta, 1));
  }

  function moveDayFocus(from: number, direction: "previous" | "next" | "first" | "last") {
    const valid = days.map((day, index) => day ? index : -1).filter((index) => index >= 0);
    if (!valid.length) return;
    let target = valid[0];
    if (direction === "last") target = valid[valid.length - 1];
    if (direction === "previous") target = [...valid].reverse().find((index) => index < from) ?? valid[valid.length - 1];
    if (direction === "next") target = valid.find((index) => index > from) ?? valid[0];
    setFocusedIndex(target);
    dayRefs.current[target]?.focus();
  }

  function handleDayKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    const delta = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : event.key === "ArrowUp" ? -7 : event.key === "ArrowDown" ? 7 : 0;
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      moveDayFocus(index, event.key === "Home" ? "first" : "last");
      return;
    }
    if (!delta) return;
    event.preventDefault();
    const preferred = index + delta;
    const valid = days.map((day, dayIndex) => day ? dayIndex : -1).filter((dayIndex) => dayIndex >= 0);
    const target = valid.reduce((best, candidate) => Math.abs(candidate - preferred) < Math.abs(best - preferred) ? candidate : best, valid[0]);
    setFocusedIndex(target);
    dayRefs.current[target]?.focus();
  }

  return (
    <div ref={rootRef} className="datefield">
      <button
        ref={triggerRef}
        type="button"
        data-required={required || undefined}
        className="datefield-trigger"
        onClick={() => {
          if (disabled) return;
          if (open) closeCalendar({ returnFocus: false });
          else {
            setPanelPosition(null);
            setOpen(true);
          }
        }}
        disabled={disabled}
        aria-label={ariaLabel ?? placeholder}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? dialogId : undefined}
      >
        <Calendar size={15} />
        <span className={value ? "" : "datefield-placeholder"}>{label}</span>
      </button>

      {open && !disabled && createPortal(
        <div
          ref={panelRef}
          className="datefield-panel is-portaled"
          id={dialogId}
          role="dialog"
          aria-label={`Calendario: ${ariaLabel ?? placeholder}`}
          style={{
            left: panelPosition?.left ?? 0,
            top: panelPosition?.top ?? 0,
            width: panelPosition?.width ?? Math.min(292, typeof window === "undefined" ? 292 : window.innerWidth - 16),
            visibility: panelPosition ? "visible" : "hidden",
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              closeCalendar();
            }
          }}>
          <div className="datefield-head">
            <button type="button" className="datefield-nav" onClick={() => shiftMonth(-1)} aria-label="Mes anterior">
              ‹
            </button>
            <div className="datefield-month">
              {MONTHS[view.getMonth()]} {view.getFullYear()}
            </div>
            <button type="button" className="datefield-nav" onClick={() => shiftMonth(1)} aria-label="Mes siguiente">
              ›
            </button>
          </div>

          <div className="datefield-grid datefield-weekdays">
            {WEEKDAYS.map((w) => (
              <span key={w} className="datefield-weekday">{w}</span>
            ))}
          </div>

          <div className="datefield-grid">
            {days.map((d, i) => {
              const isToday = d !== null && d.toDateString() === today.toDateString();
              const isSelected = d !== null && selected !== null && d.toDateString() === selected.toDateString();
              return (
                <button
                  key={i}
                  type="button"
                  className={
                    "datefield-day" +
                    (isSelected ? " is-selected" : "") +
                    (isToday ? " is-today" : "") +
                    (d === null ? " is-outside" : "")
                  }
                  disabled={d === null}
                  onClick={() => pick(d)}
                  ref={(node) => { dayRefs.current[i] = node; }}
                  tabIndex={d !== null && focusedIndex === i ? 0 : -1}
                  onFocus={() => setFocusedIndex(i)}
                  onKeyDown={(event) => handleDayKeyDown(event, i)}
                >
                  {d ? d.getDate() : ""}
                </button>
              );
            })}
          </div>

          <div className="datefield-foot">
            <button type="button" className="datefield-clear" onClick={() => { onChange(""); closeCalendar(); }}>
              Borrar
            </button>
            <button type="button" className="datefield-clear" onClick={() => { pick(today); }}>
              Hoy
            </button>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
