"use client";

// Calendario Renew (GUIA-DISENO.md §7): reemplaza <input type="date"> nativo.
// Semana Lu..Do, español, hoy con anillo, día elegido en azul sólido,
// trigger 2.75rem glass, panel de vidrio con blur. Fechas en America/Lima.

import { useEffect, useMemo, useRef, useState } from "react";
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
  placeholder = "Seleccionar fecha",
  "aria-label": ariaLabel,
}: {
  value: string;
  onChange: (iso: string) => void;
  required?: boolean;
  placeholder?: string;
  "aria-label"?: string;
}) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<Date>(() => (value ? parseISO(value) : todayLima()));
  const rootRef = useRef<HTMLDivElement>(null);

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
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

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

  function pick(d: Date | null) {
    if (!d) return;
    onChange(toISO(d));
    setOpen(false);
  }

  function shiftMonth(delta: number) {
    setView((v) => new Date(v.getFullYear(), v.getMonth() + delta, 1));
  }

  return (
    <div ref={rootRef} className="datefield" style={{ position: "relative" }}>
      <button
        type="button"
        className="datefield-trigger"
        onClick={() => setOpen((o) => !o)}
        aria-label={ariaLabel ?? placeholder}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <Calendar size={15} />
        <span className={value ? "" : "datefield-placeholder"}>{label}</span>
      </button>

      {open && (
        <div className="datefield-panel" role="dialog">
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
                >
                  {d ? d.getDate() : ""}
                </button>
              );
            })}
          </div>

          <div className="datefield-foot">
            <button type="button" className="datefield-clear" onClick={() => { onChange(""); setOpen(false); }}>
              Borrar
            </button>
            <button type="button" className="datefield-clear" onClick={() => { pick(today); }}>
              Hoy
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
