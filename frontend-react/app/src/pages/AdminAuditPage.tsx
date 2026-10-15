
import { useCallback, useEffect, useMemo, useState } from "react";
import AdminShell from "@/components/AdminShell";
import { Alert, Filter, Refresh, Search, Shield, X } from "@/components/Icons";
import { TablePagination, useTablePagination } from "@/components/Pagination";
import { ApiError, auditApi, AuditLog } from "@/lib/api";

const entityCopy: Record<string, string> = {
  attendance: "Marcación",
  attendance_attempt: "Intento de marcación",
  attendance_break_override: "Refrigerio",
  adjustment: "Ajuste de horas",
  manual_attendance_day: "Carga de horas",
  recovery_commitment: "Recuperación",
  employee_weekly_rest_rule: "Descanso semanal",
  holiday_calendar_day: "Feriado",
  rest_substitution: "Cambio de descanso",
  special_day_valuation: "Pago de día especial",
  payroll_period: "Periodo de pago",
  payroll_record: "Pago de empleado",
  salary: "Sueldo",
  schedule: "Jornada",
  overtime_policy: "Regla de horas extra",
  user: "Usuario",
};

const entityNoun: Record<string, string> = {
  attendance: "una marcación",
  attendance_attempt: "un intento de marcación",
  attendance_break_override: "el refrigerio",
  adjustment: "un ajuste de horas",
  manual_attendance_day: "una carga de horas",
  recovery_commitment: "una recuperación",
  employee_weekly_rest_rule: "un descanso semanal",
  holiday_calendar_day: "un feriado",
  rest_substitution: "un cambio de descanso",
  special_day_valuation: "un pago de día especial",
  payroll_period: "un periodo de pago",
  payroll_record: "un pago de empleado",
  salary: "un sueldo",
  schedule: "una jornada",
  overtime_policy: "la regla de horas extra",
  user: "un usuario",
};

const entityCategory: Record<string, "attendance" | "payroll" | "schedules" | "users" | "other"> = {
  attendance: "attendance",
  attendance_attempt: "attendance",
  attendance_break_override: "attendance",
  adjustment: "attendance",
  manual_attendance_day: "attendance",
  recovery_commitment: "attendance",
  payroll_period: "payroll",
  payroll_record: "payroll",
  salary: "payroll",
  special_day_valuation: "payroll",
  schedule: "schedules",
  holiday_calendar_day: "schedules",
  employee_weekly_rest_rule: "schedules",
  rest_substitution: "schedules",
  overtime_policy: "schedules",
  user: "users",
};

const actionVerb: Record<string, string> = {
  create: "creó",
  created: "creó",
  update: "actualizó",
  correction: "corrigió",
  set_salary: "actualizó el sueldo en",
  set_schedule: "actualizó la jornada en",
  reset_password: "restableció la clave de",
  change_password: "cambió su clave",
  versioned_update: "editó",
  multi_versioned_update: "editó en bloque",
  multi_created: "creó en bloque",
  voided: "anuló",
  approve: "aprobó",
  approved: "aprobó",
  reject: "rechazó",
  reconciled: "marcó como pagado",
  payment_approved: "aprobó el pago de",
  rectification_created: "creó una corrección de",
  manual_adjustment: "ajustó el importe de",
  close: "cerró",
  ATTEMPT_CANCELLED: "canceló",
  ATTEMPT_REVIEWED: "revisó",
  UPDATE_OVERTIME_POLICY: "actualizó",
  break_override_cleared: "restauró el refrigerio automático en",
};

const actionCopy: Record<string, string> = {
  create: "Creado",
  created: "Creado",
  update: "Actualizado",
  correction: "Corregido",
  set_salary: "Sueldo actualizado",
  set_schedule: "Jornada actualizada",
  reset_password: "Clave restablecida",
  change_password: "Clave cambiada",
  versioned_update: "Editado",
  multi_versioned_update: "Editado en bloque",
  multi_created: "Creado en bloque",
  voided: "Anulado",
  approve: "Aprobado",
  approved: "Aprobado",
  reject: "Rechazado",
  reconciled: "Marcado como pagado",
  payment_approved: "Pago aprobado",
  rectification_created: "Corrección de periodo creada",
  manual_adjustment: "Importe ajustado",
  close: "Periodo cerrado",
  ATTEMPT_CANCELLED: "Intento cancelado",
  ATTEMPT_REVIEWED: "Intento revisado",
  UPDATE_OVERTIME_POLICY: "Regla de horas extra actualizada",
  break_override_cleared: "Refrigerio automático restaurado",
};

const fieldCopy: Record<string, string> = {
  status: "Estado",
  minutes: "Duración",
  worked_minutes: "Tiempo trabajado",
  worked_minutes_net: "Tiempo trabajado",
  normal_minutes: "Jornada regular",
  additional_minutes: "Horas adicionales",
  recovery_minutes: "Horas recuperadas",
  requested_break_minutes: "Refrigerio registrado",
  break_source: "Cálculo del refrigerio",
  version: "Versión",
  employee_id: "Empleado",
  effective_from: "Vigente desde",
  effective_to: "Vigente hasta",
  check_in_at: "Entrada",
  check_out_at: "Salida",
  work_date: "Fecha",
  manual_adjustment: "Ajuste manual",
  base_salary: "Sueldo base",
  total: "Total",
  overtime_minutes: "Horas extra",
  expected_minutes: "Jornada esperada",
  adjustment_minutes: "Minutos de ajuste",
  adjustment_amount: "Importe del ajuste",
};

const valueCopy: Record<string, string> = {
  PENDING: "Pendiente",
  APPROVED: "Aprobado",
  REJECTED: "Rechazado",
  VOIDED: "Anulado",
  OPEN: "Abierto",
  CLOSED: "Cerrado",
  CALCULATED: "Calculado",
  AUTOMATIC: "Automático",
  OVERRIDE: "Registrado manualmente",
  COMPLETE: "Completada",
  PREVIEW: "Vista previa",
  CONFIRMED: "Confirmado",
  EXCLUDED: "Excluido",
  RECOGNIZED: "Reconocido",
  SCHEDULE: "Según jornada",
  NONE: "Sin refrigerio",
  CANCELLED: "Cancelado",
  REVIEWED: "Revisado",
};

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("es-PE", {
    timeZone: "America/Lima",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fieldLabel(key: string): string {
  return (
    fieldCopy[key] ??
    key
      .replace("_at", "")
      .replaceAll("_", " ")
      .replace(/^./, (c) => c.toUpperCase())
  );
}

/** Convierte un valor crudo en algo legible para una persona administrativa. */
function readableValue(key: string, value: unknown): string {
  if (value === null || value === undefined || value === "") return "vacío";
  if (typeof value === "object") return "datos adjuntos";
  let shown = valueCopy[String(value)] ?? String(value);
  if (key === "check_in_at" || key === "check_out_at") {
    shown = shown.length > 5 ? shown.slice(11, 16) : shown;
  }
  if (key.endsWith("minutes") && Number.isFinite(Number(value))) {
    const total = Number(value);
    const h = Math.floor(Math.abs(total) / 60);
    const m = Math.abs(total) % 60;
    shown = `${total < 0 ? "−" : ""}${h} h ${m} min`;
  }
  return shown;
}

type Change = { key: string; label: string; from: string; to: string };

/** Diferencias legibles entre lo anterior y lo nuevo, sin exponer JSON crudo. */
function describeChanges(log: AuditLog): Change[] {
  const oldValues = log.old_values ?? {};
  const newValues = log.new_values ?? {};
  const keys = Array.from(new Set([...Object.keys(oldValues), ...Object.keys(newValues)])).filter(
    (key) => key !== "work_date"
  );
  return keys
    .map((key) => {
      const hasOld = Object.prototype.hasOwnProperty.call(oldValues, key);
      const hasNew = Object.prototype.hasOwnProperty.call(newValues, key);
      const from = hasOld ? readableValue(key, oldValues[key]) : "—";
      const to = hasNew ? readableValue(key, newValues[key]) : "—";
      return { key, label: fieldLabel(key), from, to };
    })
    .filter((change) => change.from !== change.to);
}

function sentence(log: AuditLog): { phrase: string; hasExplicitNoun: boolean } {
  const verb = actionVerb[log.action] ?? "actualizó";
  const noun = entityNoun[log.entity_type];
  if (noun) {
    return { phrase: `${verb} ${noun}`, hasExplicitNoun: true };
  }
  return { phrase: verb, hasExplicitNoun: false };
}

export default function AdminAuditPage() {
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [searchTerm, setSearchTerm] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<
    "all" | "attendance" | "payroll" | "schedules" | "users"
  >("all");
  const [actorFilter, setActorFilter] = useState("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setLogs(await auditApi.list({ limit: 200 }));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Error de conexión con el servidor");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const actors = useMemo(() => {
    const set = new Set<string>();
    for (const log of logs) {
      const name = log.performed_by_username || log.performed_by || "Sistema";
      set.add(name);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b, "es-PE"));
  }, [logs]);

  const filteredLogs = useMemo(() => {
    return logs.filter((log) => {
      // 1. Category filter
      if (categoryFilter !== "all") {
        const cat = entityCategory[log.entity_type] ?? "other";
        if (cat !== categoryFilter) return false;
      }

      // 2. Actor filter
      if (actorFilter !== "all") {
        const act = log.performed_by_username || log.performed_by || "Sistema";
        if (act !== actorFilter) return false;
      }

      // 3. Date range filter (using Lima date YYYY-MM-DD)
      if (dateFrom || dateTo) {
        const logLimaDate = new Date(log.created_at).toLocaleDateString("en-CA", {
          timeZone: "America/Lima",
        });
        if (dateFrom && logLimaDate < dateFrom) return false;
        if (dateTo && logLimaDate > dateTo) return false;
      }

      // 4. Free text search
      if (searchTerm.trim()) {
        const q = searchTerm.toLowerCase().trim();
        const actor = (log.performed_by_username ?? log.performed_by ?? "sistema").toLowerCase();
        const reason = (log.reason ?? "").toLowerCase();
        const entityLabel = (entityCopy[log.entity_type] ?? log.entity_type).toLowerCase();
        const actionLabel = (
          actionCopy[log.action] ??
          actionVerb[log.action] ??
          log.action
        ).toLowerCase();
        const idMatch =
          log.id.toLowerCase().includes(q) || log.entity_id.toLowerCase().includes(q);

        if (
          actor.includes(q) ||
          reason.includes(q) ||
          entityLabel.includes(q) ||
          actionLabel.includes(q) ||
          idMatch
        ) {
          return true;
        }

        const oldVals = JSON.stringify(log.old_values ?? "").toLowerCase();
        const newVals = JSON.stringify(log.new_values ?? "").toLowerCase();
        if (oldVals.includes(q) || newVals.includes(q)) return true;

        return false;
      }

      return true;
    });
  }, [logs, categoryFilter, actorFilter, dateFrom, dateTo, searchTerm]);

  const pagination = useTablePagination(filteredLogs, filteredLogs.length);

  const hasActiveFilters = Boolean(
    searchTerm.trim() ||
      categoryFilter !== "all" ||
      actorFilter !== "all" ||
      dateFrom ||
      dateTo
  );

  function clearFilters() {
    setSearchTerm("");
    setCategoryFilter("all");
    setActorFilter("all");
    setDateFrom("");
    setDateTo("");
  }

  return (
    <AdminShell
      title="Auditoría"
      subtitle="Qué cambió, quién lo hizo y por qué. El detalle técnico queda guardado en cada evento."
    >
      {error && (
        <div
          className="alert alert-error"
          role="alert"
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: "1rem",
            flexWrap: "wrap",
            marginBottom: "1rem",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <Alert size={16} style={{ flexShrink: 0 }} />
            <span>{error}</span>
          </div>
          <button
            type="button"
            className="btn btn-outline btn-sm"
            onClick={() => void load()}
            style={{ minHeight: "2.1rem" }}
          >
            <Refresh size={14} /> Reintentar
          </button>
        </div>
      )}

      <p className="audit-intro">
        Cada línea resume una acción sobre la asistencia o los pagos. Usa «Ver detalle técnico» solo si necesitas el
        identificador o los datos originales.
      </p>

      <div className="audit-toolbar">
        <div className="audit-search">
          <Search size={16} aria-hidden />
          <input
            type="search"
            className="input"
            placeholder="Buscar por usuario, motivo, cambio o ref…"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            aria-label="Buscar en bitácora de auditoría"
          />
          {searchTerm && (
            <button
              type="button"
              className="audit-search-clear"
              onClick={() => setSearchTerm("")}
              aria-label="Limpiar búsqueda"
            >
              <X size={14} />
            </button>
          )}
        </div>

        <div className="audit-filters-group">
          <div className="audit-filter-item">
            <label htmlFor="audit-category-select" className="sr-only">
              Categoría
            </label>
            <select
              id="audit-category-select"
              className="input select"
              value={categoryFilter}
              onChange={(e) =>
                setCategoryFilter(
                  e.target.value as "all" | "attendance" | "payroll" | "schedules" | "users"
                )
              }
              aria-label="Filtrar por categoría"
            >
              <option value="all">Todas las categorías</option>
              <option value="attendance">Marcaciones y Asistencia</option>
              <option value="payroll">Planilla y Pagos</option>
              <option value="schedules">Jornadas y Feriados</option>
              <option value="users">Usuarios del sistema</option>
            </select>
          </div>

          {actors.length > 1 && (
            <div className="audit-filter-item">
              <label htmlFor="audit-actor-select" className="sr-only">
                Autor
              </label>
              <select
                id="audit-actor-select"
                className="input select"
                value={actorFilter}
                onChange={(e) => setActorFilter(e.target.value)}
                aria-label="Filtrar por autor"
              >
                <option value="all">Todos los autores ({actors.length})</option>
                {actors.map((act) => (
                  <option key={act} value={act}>
                    {act}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="audit-date-range">
            <label htmlFor="audit-date-from" className="audit-date-label">
              Desde
            </label>
            <input
              id="audit-date-from"
              type="date"
              className="input audit-date-input"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              aria-label="Fecha inicial de auditoría"
            />
            <label htmlFor="audit-date-to" className="audit-date-label">
              Hasta
            </label>
            <input
              id="audit-date-to"
              type="date"
              className="input audit-date-input"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              aria-label="Fecha final de auditoría"
            />
          </div>

          {hasActiveFilters && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={clearFilters}
              style={{ minHeight: "2.5rem" }}
            >
              Limpiar filtros
            </button>
          )}
        </div>
      </div>

      <p className="audit-count-meta">
        Mostrando {filteredLogs.length} de {logs.length} {logs.length === 1 ? "evento registrado" : "eventos registrados"}
      </p>

      {loading ? (
        <div className="audit-list" aria-busy="true" aria-label="Cargando bitácora de auditoría">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="audit-event audit-skeleton-card surface-material">
              <div className="audit-skeleton-head">
                <div className="audit-skeleton-bar" style={{ width: "35%", height: "1.1rem" }} />
                <div className="audit-skeleton-bar" style={{ width: "18%", height: "0.85rem" }} />
              </div>
              <div
                className="audit-skeleton-bar"
                style={{ width: "60%", height: "0.85rem", marginTop: "0.6rem" }}
              />
              <div
                className="audit-skeleton-bar"
                style={{ width: "42%", height: "0.85rem", marginTop: "0.45rem" }}
              />
            </div>
          ))}
        </div>
      ) : logs.length === 0 ? (
        <div className="operational-empty operational-empty--neutral">
          <span>
            <Shield size={20} />
          </span>
          <div>
            <strong>Sin cambios registrados</strong>
            <p>Aquí aparecerán las correcciones y decisiones del equipo.</p>
          </div>
        </div>
      ) : filteredLogs.length === 0 ? (
        <div className="operational-empty operational-empty--neutral" style={{ padding: "2rem 1.5rem" }}>
          <span>
            <Filter size={20} />
          </span>
          <div>
            <strong>No se encontraron eventos con los filtros aplicados</strong>
            <p>Prueba ajustando el texto de búsqueda, rango de fechas o categorías seleccionadas.</p>
            <button
              type="button"
              className="btn btn-outline btn-sm"
              onClick={clearFilters}
              style={{ marginTop: "0.75rem", minHeight: "2.2rem" }}
            >
              Restablecer todos los filtros
            </button>
          </div>
        </div>
      ) : (
        <ul className="audit-list">
          {pagination.pageItems.map((log) => {
            const changes = describeChanges(log);
            const { phrase, hasExplicitNoun } = sentence(log);
            const actor = log.performed_by_username ?? "El sistema";
            return (
              <li className="audit-event surface-material" key={log.id}>
                <div className="audit-event-head">
                  <p className="audit-event-sentence">
                    <strong>{actor}</strong> {phrase}
                    {!hasExplicitNoun && (
                      <span className="audit-event-entity">
                        {" "}· {entityCopy[log.entity_type] ?? "Registro del sistema"}
                      </span>
                    )}
                    {log.entity_id && (
                      <span
                        className="audit-event-entity"
                        title={`Identificador de entidad: ${log.entity_id}`}
                      >
                        {" "}· Ref. {log.entity_id.length > 8 ? `${log.entity_id.slice(0, 8)}…` : log.entity_id}
                      </span>
                    )}
                  </p>
                  <time className="audit-event-time" dateTime={log.created_at}>
                    {formatDateTime(log.created_at)}
                  </time>
                </div>

                {log.reason && (
                  <p className="audit-event-reason">
                    <span>Motivo:</span> {log.reason}
                  </p>
                )}

                {changes.length > 0 && (
                  <ul className="audit-changes">
                    {changes.map((change) => (
                      <li key={change.key}>
                        <span className="audit-change-label">{change.label}</span>
                        <span className="audit-change-from">{change.from}</span>
                        <span className="audit-change-arrow" aria-hidden>
                          →
                        </span>
                        <span className="audit-change-to">{change.to}</span>
                      </li>
                    ))}
                  </ul>
                )}

                <details className="audit-tech">
                  <summary>Ver detalle técnico</summary>
                  <dl className="audit-tech-grid">
                    <div>
                      <dt>Identificador</dt>
                      <dd>{log.id}</dd>
                    </div>
                    <div>
                      <dt>Entidad</dt>
                      <dd>
                        {entityCopy[log.entity_type] ?? log.entity_type} · {log.entity_id}
                      </dd>
                    </div>
                    <div>
                      <dt>Acción</dt>
                      <dd>{actionCopy[log.action] ?? log.action}</dd>
                    </div>
                    <div>
                      <dt>Autor</dt>
                      <dd>{log.performed_by_username ?? log.performed_by ?? "Sistema"}</dd>
                    </div>
                  </dl>
                  <pre className="audit-json">
                    {JSON.stringify({ anterior: log.old_values, nuevo: log.new_values }, null, 2)}
                  </pre>
                </details>
              </li>
            );
          })}
        </ul>
      )}
      <TablePagination {...pagination} />
    </AdminShell>
  );
}
