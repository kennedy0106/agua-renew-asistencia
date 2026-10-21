import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import DateField from "@/components/DateField";
import { Calendar, Clock, Download, Info, Menu, Shield, X } from "@/components/Icons";
import { Spinner } from "@/components/Loading";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { Employee } from "@/lib/api";

/**
 * Encabezado de la pestaña Asistencia.
 *
 * Dos niveles intencionales: arriba el título "Filtros" con las acciones
 * (Ayuda, Exportar CSV y, solo para ADMIN/BOSS, Más acciones); abajo los
 * filtros etiquetados. El período es un disparador compacto que revela los
 * mismos DateField de siempre, y la fila de acciones de gestión solo aparece
 * cuando se pide: ninguna de estas divulgaciones filtra ni confirma nada.
 *
 * Conserva las reglas del listado: filtrar es automático (sin botón Aplicar),
 * el rango inicial es el mes operativo en curso y Limpiar vacía empleado,
 * estado y fechas. La exportación es el CSV de siempre con los filtros actuales.
 */
type AttendanceToolbarProps = {
  canManage: boolean;
  employees: Employee[];
  employeeFilter: string;
  onEmployeeChange: (value: string) => void;
  dateFrom: string;
  dateTo: string;
  onDateFromChange: (value: string) => void;
  onDateToChange: (value: string) => void;
  statusFilter: string;
  onStatusChange: (value: string) => void;
  onClear: () => void;
  onExport: () => void;
  refreshing: boolean;
  recovery: {
    nonce: string;
    reason: string;
    lookup: string | null;
    reviewing: boolean;
    onNonceChange: (value: string) => void;
    onReasonChange: (value: string) => void;
    onLookup: () => void;
    onSubmit: (event: FormEvent) => void;
  };
};

const COLUMN_HELP: Array<{ term: string; definition: string }> = [
  {
    term: "Tiempo presente",
    definition: "Desde la primera entrada hasta la última salida, sin descontar el refrigerio.",
  },
  {
    term: "Tiempo efectivo",
    definition: "Tiempo presente menos el refrigerio. Es el tiempo que cuenta para el pago.",
  },
  {
    term: "Jornada esperada",
    definition: "Lo que la persona debía trabajar ese día según su horario.",
  },
  {
    term: "Saldo del día",
    definition: "Tiempo efectivo menos jornada esperada. En ámbar faltó tiempo; en verde trabajó de más.",
  },
  {
    term: "Incidencias",
    definition: "Situaciones a revisar, como entrada tardía, salida faltante u horas extra.",
  },
];

/** Fecha ISO del negocio en formato corto es-PE (día, mes y año visibles). */
function formatRangeDate(iso: string): string {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(year, month - 1, day).toLocaleDateString("es-PE", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

/** Resumen del rango vigente; el estado vacío nunca inventa el mes en curso. */
function periodSummary(from: string, to: string): string {
  if (from && to) return `${formatRangeDate(from)} – ${formatRangeDate(to)}`;
  if (from) return `Desde ${formatRangeDate(from)}`;
  if (to) return `Hasta ${formatRangeDate(to)}`;
  return "Sin fechas";
}

export default function AttendanceToolbar({
  canManage,
  employees,
  employeeFilter,
  onEmployeeChange,
  dateFrom,
  dateTo,
  onDateFromChange,
  onDateToChange,
  statusFilter,
  onStatusChange,
  onClear,
  onExport,
  refreshing,
  recovery,
}: AttendanceToolbarProps) {
  const [helpOpen, setHelpOpen] = useState(false);
  const [periodOpen, setPeriodOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const helpTriggerRef = useRef<HTMLButtonElement>(null);
  const periodTriggerRef = useRef<HTMLButtonElement>(null);
  const moreTriggerRef = useRef<HTMLButtonElement>(null);
  const moreWrapRef = useRef<HTMLDivElement>(null);
  const nonceInputRef = useRef<HTMLInputElement>(null);

  const hasFilters = Boolean(employeeFilter || dateFrom || dateTo || statusFilter);
  const summary = periodSummary(dateFrom, dateTo);

  function closeRecovery() {
    setRecoveryOpen(false);
    // El disparador sigue montado: el foco vuelve sin esperar un cuadro.
    moreTriggerRef.current?.focus();
  }

  useEffect(() => {
    if (recoveryOpen) window.requestAnimationFrame(() => nonceInputRef.current?.focus());
  }, [recoveryOpen]);

  // El listado de acciones se descarta al hacer clic fuera. El editor de
  // período no: su calendario es portaleado y gestiona su propio cierre.
  useEffect(() => {
    if (!moreOpen) return;
    function onMouseDown(event: MouseEvent) {
      const wrap = moreWrapRef.current;
      if (wrap && event.target instanceof Node && !wrap.contains(event.target)) setMoreOpen(false);
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [moreOpen]);

  // Escape cierra la divulgación abierta y devuelve el foco a su disparador.
  // El calendario anidado se cierra antes: la página detiene ese Escape en la
  // captura de window cuando hay un panel de fecha portaleado abierto.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      if (recoveryOpen) {
        setRecoveryOpen(false);
        moreTriggerRef.current?.focus();
        return;
      }
      if (moreOpen) {
        setMoreOpen(false);
        moreTriggerRef.current?.focus();
        return;
      }
      if (periodOpen) {
        setPeriodOpen(false);
        periodTriggerRef.current?.focus();
        return;
      }
      if (helpOpen) {
        setHelpOpen(false);
        helpTriggerRef.current?.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [recoveryOpen, moreOpen, periodOpen, helpOpen]);

  return (
    <section className="attendance-toolbar" aria-labelledby="attendance-filters-title">
      <div className="attendance-toolbar-head">
        <h2 className="attendance-toolbar-title" id="attendance-filters-title">
          Filtros
        </h2>
        <div className="attendance-toolbar-actions">
          {refreshing && (
            <span className="attendance-toolbar-status" role="status">
              <Spinner /> Actualizando…
            </span>
          )}
          <button
            type="button"
            ref={helpTriggerRef}
            className="btn btn-ghost btn-sm attendance-action"
            aria-expanded={helpOpen}
            aria-controls={helpOpen ? "attendance-columns-help" : undefined}
            onClick={() => setHelpOpen((open) => !open)}
          >
            <Info size={15} /> Ayuda
          </button>
          <button
            type="button"
            className="btn btn-outline btn-sm attendance-action"
            title="Descarga un CSV compatible con Excel: se abre en tu hoja de cálculo."
            onClick={onExport}
          >
            <Download size={15} /> Exportar CSV
          </button>
          {canManage && (
            <div className="attendance-more-wrap" ref={moreWrapRef}>
              <button
                type="button"
                ref={moreTriggerRef}
                className="btn btn-ghost btn-sm attendance-action"
                aria-expanded={moreOpen}
                aria-controls={moreOpen ? "attendance-more-actions" : undefined}
                onClick={() => setMoreOpen((open) => !open)}
              >
                <Menu size={15} /> Más acciones
              </button>
              {moreOpen && (
                <div className="attendance-more" id="attendance-more-actions">
                  <Link
                    className="attendance-more-item"
                    to="/admin/attendance/history"
                    onClick={() => setMoreOpen(false)}
                  >
                    <Clock size={16} />
                    <span>
                      <span className="attendance-more-title">Cargar horas anteriores</span>
                      <span className="attendance-more-hint">Días anteriores al inicio del sistema.</span>
                    </span>
                  </Link>
                  <button
                    type="button"
                    className="attendance-more-item"
                    onClick={() => {
                      setMoreOpen(false);
                      setRecoveryOpen(true);
                    }}
                  >
                    <Shield size={16} />
                    <span>
                      <span className="attendance-more-title">Recuperar un intento de la tablet</span>
                      <span className="attendance-more-hint">Solo si la tablet muestra una referencia.</span>
                    </span>
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {helpOpen && (
        <div className="attendance-help" id="attendance-columns-help">
          <p className="attendance-help-intro">Qué mide cada columna de la tabla.</p>
          <dl className="term-help-grid attendance-help-grid">
            {COLUMN_HELP.map((item) => (
              <div key={item.term}>
                <dt>{item.term}</dt>
                <dd>{item.definition}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      <div className="attendance-filter-row">
        <div className="attendance-filter attendance-filter--employee">
          <label className="attendance-filter-label" htmlFor="attendance-employee-filter">
            Empleado
          </label>
          <Select
            value={employeeFilter || "__all"}
            onValueChange={(value) => onEmployeeChange(value === "__all" ? "" : value)}
          >
            <SelectTrigger id="attendance-employee-filter" aria-label="Empleado" className="attendance-employee-select">
              <SelectValue placeholder="Todos los empleados" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all">Todos los empleados</SelectItem>
              {employees.map((employee) => (
                <SelectItem key={employee.id} value={employee.id}>
                  {employee.first_name} {employee.last_name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="attendance-filter attendance-filter--period">
          <span className="attendance-filter-label" aria-hidden="true">
            Período
          </span>
          <button
            type="button"
            ref={periodTriggerRef}
            className="attendance-period-trigger"
            aria-expanded={periodOpen}
            aria-controls={periodOpen ? "attendance-period-editor" : undefined}
            aria-label={`Período: ${summary}`}
            title="Elige el rango de fechas del listado"
            onClick={() => setPeriodOpen((open) => !open)}
          >
            <Calendar size={15} />
            <span className="attendance-period-text">{summary}</span>
          </button>
        </div>

        <div className="attendance-filter attendance-filter--status">
          <label className="attendance-filter-label" htmlFor="attendance-status-filter">
            Estado
          </label>
          <Select
            value={statusFilter || "__all"}
            onValueChange={(value) => onStatusChange(value === "__all" ? "" : value)}
          >
            <SelectTrigger id="attendance-status-filter" aria-label="Estado" className="attendance-status-select">
              <SelectValue placeholder="Todos los estados" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all">Todos los estados</SelectItem>
              <SelectItem value="OPEN">Sin salida registrada</SelectItem>
              <SelectItem value="COMPLETE">Jornada completada</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="attendance-filter attendance-filter--clear">
          {hasFilters && (
            <button type="button" className="btn btn-ghost btn-sm attendance-clear" onClick={onClear}>
              <X size={14} /> Limpiar
            </button>
          )}
        </div>

        {periodOpen && (
          <div className="attendance-period-editor" id="attendance-period-editor">
            <DateField value={dateFrom} onChange={onDateFromChange} aria-label="Fecha desde" placeholder="Desde" />
            <span className="attendance-period-separator" aria-hidden="true">
              a
            </span>
            <DateField value={dateTo} onChange={onDateToChange} aria-label="Fecha hasta" placeholder="Hasta" />
          </div>
        )}
      </div>

      {canManage && recoveryOpen && (
        <section className="attendance-recovery" aria-labelledby="attendance-recovery-title">
          <div className="attendance-recovery-head">
            <div>
              <h3 className="attendance-recovery-title" id="attendance-recovery-title">
                Recuperar un intento de la tablet
              </h3>
              <p className="attendance-recovery-hint">Solo si la tablet muestra una referencia de recuperación.</p>
            </div>
            <button
              type="button"
              className="btn btn-ghost btn-sm attendance-recovery-close"
              aria-label="Cerrar recuperación de tablet"
              onClick={closeRecovery}
            >
              <X size={15} />
            </button>
          </div>
          <form className="attendance-recovery-form" onSubmit={recovery.onSubmit}>
            <p className="attendance-recovery-copy">
              Escribe el código que aparece en la pantalla de la tablet. Conserva el evento original; no corrige horas ni
              borra fotos.
            </p>
            <div className="attendance-recovery-fields">
              <div>
                <label className="attendance-filter-label" htmlFor="kiosk-attempt-nonce">
                  Código de incidente de la tablet
                </label>
                <input
                  id="kiosk-attempt-nonce"
                  ref={nonceInputRef}
                  className="input"
                  value={recovery.nonce}
                  onChange={(event) => recovery.onNonceChange(event.target.value)}
                  placeholder="Ej. A1B2C3"
                  data-testid="admin-attempt-nonce"
                />
              </div>
              <div>
                <label className="attendance-filter-label" htmlFor="kiosk-attempt-reason">
                  Motivo
                </label>
                <input
                  id="kiosk-attempt-reason"
                  className="input"
                  value={recovery.reason}
                  onChange={(event) => recovery.onReasonChange(event.target.value)}
                  minLength={3}
                  maxLength={500}
                  placeholder="Revisión autorizada"
                  data-testid="admin-attempt-reason"
                />
                <p className="attendance-recovery-hint">
                  Máximo 500 caracteres. El servidor rechaza textos más largos o solo espacios.
                </p>
              </div>
            </div>
            {recovery.lookup && (
              <p className="attendance-recovery-lookup" data-testid="admin-attempt-lookup">
                {recovery.lookup}
              </p>
            )}
            <div className="attendance-recovery-actions">
              <button
                type="button"
                className="btn btn-outline btn-sm"
                disabled={recovery.reviewing || !recovery.nonce.trim()}
                onClick={recovery.onLookup}
              >
                Consultar intento
              </button>
              <button
                type="submit"
                className="btn btn-amber btn-sm"
                disabled={
                  recovery.reviewing || recovery.nonce.trim().length < 1 || recovery.reason.trim().length < 3
                }
              >
                {recovery.reviewing && <Spinner />}
                {recovery.reviewing ? "Guardando revisión…" : "Revisar y habilitar tablet"}
              </button>
            </div>
          </form>
        </section>
      )}
    </section>
  );
}
