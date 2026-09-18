"use client";

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Calendar } from "./Icons";

const MONTHS = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];

function limaMonth() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima", year: "numeric", month: "2-digit" }).formatToParts(new Date());
  const value = (part: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === part)?.value ?? "";
  return `${value("year")}-${value("month")}`;
}

export default function MonthField({ value, onChange, disabled = false, "aria-label": ariaLabel = "Mes" }: {
  value: string;
  onChange: (month: string) => void;
  disabled?: boolean;
  "aria-label"?: string;
}) {
  const [open, setOpen] = useState(false);
  const [year, setYear] = useState(() => Number(value.slice(0, 4)) || Number(limaMonth().slice(0, 4)));
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const monthRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const dialogId = useId();
  const selectedMonth = Number(value.slice(5, 7)) - 1;

  const label = useMemo(() => {
    if (!value || selectedMonth < 0 || selectedMonth > 11) return "Seleccionar mes";
    return `${MONTHS[selectedMonth]} de ${value.slice(0, 4)}`;
  }, [selectedMonth, value]);

  function close(returnFocus = true) {
    setOpen(false);
    if (returnFocus) window.requestAnimationFrame(() => triggerRef.current?.focus());
  }

  useEffect(() => { if (value) setYear(Number(value.slice(0, 4))); }, [value]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  useLayoutEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) close(false);
    };
    // Escape must work even while focus is in a portal/native control or the
    // browser has not yet moved focus to the first month button.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    document.addEventListener("pointerdown", onPointerDown);
    // Window capture is intentionally above Radix/native controls that can
    // stop propagation at document level while they finish their own Escape.
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const focus = selectedMonth >= 0 && selectedMonth < 12 ? selectedMonth : 0;
    const frame = window.requestAnimationFrame(() => monthRefs.current[focus]?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open, selectedMonth, year]);

  function select(monthIndex: number) {
    onChange(`${year}-${String(monthIndex + 1).padStart(2, "0")}`);
    close();
  }

  function onMonthKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key === "Escape") { event.preventDefault(); close(); return; }
    const delta = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : event.key === "ArrowUp" ? -4 : event.key === "ArrowDown" ? 4 : 0;
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      monthRefs.current[event.key === "Home" ? 0 : 11]?.focus();
      return;
    }
    if (!delta) return;
    event.preventDefault();
    monthRefs.current[(index + delta + 12) % 12]?.focus();
  }

  return <div className="monthfield" ref={rootRef} onKeyDownCapture={(event) => {
    if (event.key === "Escape" && open) { event.preventDefault(); event.stopPropagation(); close(); }
  }}>
    <button ref={triggerRef} type="button" className="monthfield-trigger" disabled={disabled} onClick={() => !disabled && setOpen((current) => !current)} aria-label={ariaLabel} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? dialogId : undefined}>
      <Calendar size={15} /><span>{label}</span>
    </button>
    {open && !disabled && <div id={dialogId} className="monthfield-panel" role="dialog" aria-label="Seleccionar mes" onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); close(); } }}>
      <div className="monthfield-head">
        <button type="button" className="datefield-nav" onClick={() => setYear((current) => current - 1)} aria-label="Año anterior">‹</button>
        <strong>{year}</strong>
        <button type="button" className="datefield-nav" onClick={() => setYear((current) => current + 1)} aria-label="Año siguiente">›</button>
      </div>
      <div className="monthfield-grid">
        {MONTHS.map((name, index) => <button key={name} ref={(node) => { monthRefs.current[index] = node; }} type="button" className={`monthfield-month${year === Number(value.slice(0, 4)) && index === selectedMonth ? " is-selected" : ""}`} onClick={() => select(index)} onKeyDown={(event) => onMonthKeyDown(event, index)}>{name.slice(0, 3)}</button>)}
      </div>
      <div className="datefield-foot"><button type="button" className="datefield-clear" onClick={() => { const current = limaMonth(); setYear(Number(current.slice(0, 4))); onChange(current); close(); }}>Este mes</button></div>
    </div>}
  </div>;
}
