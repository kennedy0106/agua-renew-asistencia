
import { Link } from "react-router-dom";
import { useCallback, useEffect, useState } from "react";
import AdminShell from "@/components/AdminShell";
import { useAdminUser } from "@/components/AdminSession";
import { Spinner, StatSkeleton } from "@/components/Loading";
import {
  Alert,
  Chart,
  Check,
  ChevronRight,
  ClipboardCheck,
  Clock,
  Refresh,
  Users,
} from "@/components/Icons";
import { ApiError, attendanceAdminApi, AttendanceListItem, AttendanceSummary, Employee, employeesApi } from "@/lib/api";

type DashboardData = { summary: AttendanceSummary; records: AttendanceListItem[]; missingEmployees: Employee[] };

function limaDateKey(date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Lima", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function formatLongDate(date = new Date()): string {
  return new Intl.DateTimeFormat("es-PE", { timeZone: "America/Lima", weekday: "long", day: "numeric", month: "long" }).format(date);
}

function formatClock(value: string | null): string {
  if (!value) return "Pendiente";
  return new Intl.DateTimeFormat("es-PE", { timeZone: "America/Lima", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

/** Iniciales legibles para el avatar de lista (sin inventar datos externos). */
function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("");
}

const AVATAR_TONES = ["dash-avatar--blue", "dash-avatar--teal", "dash-avatar--green"] as const;

export default function AdminDashboardPage() {
  const user = useAdminUser();
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [today] = useState(limaDateKey);

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const [summary, records, employees] = await Promise.all([
        attendanceAdminApi.summary(),
        attendanceAdminApi.list({ date_from: today, date_to: today }),
        employeesApi.list({ active: true }),
      ]);
      const presentIds = new Set(records.map((record) => record.employee_id));
      setData({ summary, records, missingEmployees: employees.filter((employee) => !presentIds.has(employee.id)) });
      setUpdatedAt(new Date());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No pudimos conectar con el servidor.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [today]);

  useEffect(() => { void load(); }, [load]);

  const openEntries = data?.records.filter((record) => !record.check_out_at) ?? [];
  const incidents = [
    ...(data?.missingEmployees.map((employee) => ({ id: `missing-${employee.id}`, title: `${employee.first_name} ${employee.last_name}`, detail: employee.job_role_name ?? "Sin cargo asignado", status: "Sin entrada", kind: "missing" as const })) ?? []),
    ...openEntries.map((record) => ({ id: `open-${record.id}`, title: record.employee_name ?? "Empleado sin nombre", detail: `Entrada registrada a las ${formatClock(record.check_in_at)}`, status: "Entrada abierta", kind: "open" as const })),
  ];

  const handleFocusIncidents = () => {
    window.requestAnimationFrame(() => {
      document.getElementById("incidents-title")?.focus();
    });
  };

  const coverage = data?.summary.employees_active
    ? Math.min(100, Math.round((data.summary.present_today / data.summary.employees_active) * 100))
    : 0;
  const attentionCount = data ? data.summary.no_entry_today + data.summary.open_entries : 0;

  return (
    <AdminShell title="Resumen de asistencia" subtitle={user ? `${formatLongDate()} · ${user.username}` : formatLongDate()}>
      <section className="dash-context" aria-label="Contexto de la jornada">
        <div>
          <p className="dash-eyebrow">
            Módulo en vivo
            <span className="dash-eyebrow-sep" aria-hidden>·</span>
            <span className="dash-eyebrow-muted">Jornada de hoy</span>
          </p>
          <h2 className="dash-title">Jornada de hoy</h2>
        </div>
        <div className="dash-context-actions">
          <span className="dash-updated" aria-live="polite">
            {updatedAt ? `Actualizado a las ${formatClock(updatedAt.toISOString())}` : "Esperando datos del servidor"}
          </span>
          <button type="button" className="btn btn-outline btn-sm dashboard-refresh" onClick={() => void load(true)} disabled={refreshing}>
            {refreshing ? <Spinner /> : <Refresh size={16} />}
            {refreshing ? "Actualizando…" : "Actualizar"}
          </button>
        </div>
      </section>

      {error && (
        <div className="alert alert-error dashboard-error" role="alert">
          <Alert size={17} />
          <div>
            <strong>No pudimos cargar el resumen</strong>
            <span>{error} Revisa tu conexión y vuelve a intentarlo.</span>
          </div>
          <button type="button" className="btn btn-outline btn-sm" onClick={() => void load()}>Reintentar</button>
        </div>
      )}

      {loading ? <StatSkeleton count={5} /> : data ? (
        <>
          <section className="dash-hero-row" aria-labelledby="team-status-title">
            <div className="dash-hero">
              <div className="dash-hero-body">
                <div>
                  <span className="dash-hero-badge">
                    <Clock size={14} /> Flujo de personal en tiempo real
                  </span>
                  <h2 id="team-status-title" className="dash-hero-title" style={{ marginTop: "0.6rem" }}>
                    El equipo, <span>de un vistazo.</span>
                  </h2>
                  <p className="dash-hero-copy">
                    Seguimiento de marcaciones registradas hoy en hora de Lima para la operación de Agua Renew.
                  </p>
                </div>
                <div className="dash-telemetry" aria-label={`${data.summary.present_today} de ${data.summary.employees_active} empleados activos presentes hoy`}>
                  <div className="dash-ring" aria-hidden>
                    <svg viewBox="0 0 36 36">
                      <path className="dash-ring-track" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" fill="none" stroke="currentColor" strokeWidth="3.5" />
                      <path className="dash-ring-fill" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" fill="none" stroke="currentColor" strokeDasharray={`${coverage}, 100`} strokeLinecap="round" strokeWidth="3.5" />
                    </svg>
                    <span className="dash-ring-value">{coverage}%</span>
                  </div>
                  <div>
                    <span className="dash-presence-label"><i className="dash-presence-dot" aria-hidden />Jornada activa</span>
                    <div className="dash-presence-value">
                      {data.summary.present_today}
                      <small>/ {data.summary.employees_active} presentes</small>
                    </div>
                    <Link to="/admin/attendance" className="dash-hero-link">
                      Ver marcaciones <ChevronRight size={15} />
                    </Link>
                  </div>
                </div>
              </div>
              <div className="dash-coverage">
                <div className="dash-coverage-head">
                  <span>Cobertura del turno <strong>({data.summary.present_today} de {data.summary.employees_active} colaboradores)</strong></span>
                  <strong>{coverage}% completado</strong>
                </div>
                <div className="dash-coverage-track" aria-hidden>
                  <span className="dash-coverage-fill" style={{ transform: `scaleX(${coverage / 100})` }} />
                </div>
              </div>
            </div>

            <aside className="dash-alert" aria-label="Resumen de atención">
              <div>
                <div className="dash-alert-head">
                  <span className="dash-alert-chip">
                    {attentionCount > 0 ? <Alert size={16} /> : <Check size={16} />}
                    {attentionCount > 0 ? "Requiere atención" : "Jornada al día"}
                  </span>
                  <span className="dash-alert-level">{attentionCount > 0 ? "ALTA" : "OK"}</span>
                </div>
                <div className="dash-alert-metric" style={{ marginTop: "0.75rem" }}>
                  <strong>{attentionCount}</strong>
                  <span>incidencias</span>
                </div>
                <p className="dash-alert-copy">
                  {attentionCount > 0
                    ? <><strong>{data.summary.no_entry_today} colaborador(es)</strong> de la plantilla aún no registran marcación de entrada al turno de hoy.</>
                    : <>Todos los colaboradores presentes tienen su jornada registrada sin incidencias abiertas.</>}
                </p>
                <div className="dash-alert-breakdown">
                  <div className="dash-alert-row" data-kind="missing">
                    <span><i aria-hidden />Sin registrar entrada</span>
                    <strong>{data.summary.no_entry_today} personas</strong>
                  </div>
                  <div className="dash-alert-row" data-kind="open">
                    <span><i aria-hidden />Jornadas abiertas</span>
                    <strong>{data.summary.open_entries} personas</strong>
                  </div>
                </div>
              </div>
              <button type="button" className="btn dash-alert-cta" onClick={handleFocusIncidents}>
                {attentionCount > 0 ? "Resolver incidencias del turno" : "Revisar jornada"} <ChevronRight size={18} />
              </button>
            </aside>
          </section>

          <section className="dash-kpis" aria-label="Indicadores de la jornada">
            <KpiCard href="/admin/employees" tone="blue" label="Empleados activos" value={data.summary.employees_active} unit="asignados" icon={<Users size={20} />} chip="100% de la plantilla" />
            <KpiCard href="#incidencias" tone="red" label="Sin entrada hoy" value={data.summary.no_entry_today} unit="ausentes" icon={<Alert size={20} />} chip={data.summary.no_entry_today > 0 ? "Crítico · atención" : "Sin pendientes"} onClick={handleFocusIncidents} />
            <KpiCard href="#incidencias" tone="neutral" label="Entradas abiertas" value={data.summary.open_entries} unit="laborando" icon={<ClipboardCheck size={20} />} chip={data.summary.open_entries > 0 ? "En jornada regular" : "Sin jornadas abiertas"} onClick={handleFocusIncidents} />
            <KpiCard href="/admin/attendance" tone="green" label="Con salida hoy" value={data.summary.checked_out_today} unit="completadas" icon={<Chart size={20} />} chip="Turnos finalizados" />
          </section>

          <div className="dash-workspace">
            <section id="incidencias" className="dash-panel operations-panel" aria-labelledby="incidents-title" tabIndex={-1}>
              <div className="dash-panel-head">
                <div>
                  <h2 id="incidents-title" tabIndex={-1} className="dash-panel-title outline-none">
                    Incidencias por resolver
                    {incidents.length > 0 && <span className="dash-count">{incidents.length}</span>}
                  </h2>
                  <p className="dash-panel-sub">Personas sin registro de entrada y jornadas que siguen abiertas al turno actual.</p>
                </div>
              </div>
              {incidents.length > 0 ? (
                <div className="dash-list">
                  {incidents.slice(0, 6).map((incident, index) => (
                    <Link key={incident.id} to="/admin/attendance" className="dash-row">
                      <span className="dash-row-main">
                        <span className={`dash-avatar ${AVATAR_TONES[index % AVATAR_TONES.length]}`} aria-hidden>{initials(incident.title)}</span>
                        <span className="dash-row-copy">
                          <span className="dash-row-name">
                            {incident.title}
                            <span className="dash-row-role">{incident.detail}</span>
                          </span>
                          <span className="dash-row-detail">{incident.detail}</span>
                        </span>
                      </span>
                      <span className="dash-row-side">
                        <span className={`dash-status-chip dash-status-chip--${incident.kind}`}>
                          <i aria-hidden />{incident.status}
                        </span>
                      </span>
                    </Link>
                  ))}
                  {incidents.length > 6 && (
                    <Link to="/admin/attendance" className="dash-panel-link">
                      Ver {incidents.length - 6} incidencias más <ChevronRight size={15} />
                    </Link>
                  )}
                </div>
              ) : (
                <div className="dash-empty">
                  <span className="dash-empty-icon"><Check size={22} /></span>
                  <div>
                    <strong>Todo está al día</strong>
                    <p>No hay incidencias pendientes en la jornada.</p>
                  </div>
                </div>
              )}
            </section>

            <section className="dash-panel" aria-labelledby="activity-title">
              <div className="dash-panel-head">
                <div>
                  <h2 id="activity-title" className="dash-panel-title">Actividad reciente</h2>
                  <p className="dash-panel-sub">Últimas marcaciones registradas hoy.</p>
                </div>
              </div>
              {data.records.length > 0 ? (
                <div className="dash-list">
                  {data.records.slice(0, 5).map((record, index) => (
                    <Link key={record.id} to="/admin/attendance" className="dash-row">
                      <span className="dash-row-main">
                        <span className={`dash-avatar ${AVATAR_TONES[index % AVATAR_TONES.length]}`} aria-hidden>
                          {initials(record.employee_name ?? "Empleado")}
                        </span>
                        <span className="dash-row-copy">
                          <span className="dash-row-name">{record.employee_name ?? "Empleado sin nombre"}</span>
                          <span className="dash-row-detail">{record.job_role_name ?? "Sin cargo asignado"}</span>
                        </span>
                      </span>
                      <span className="dash-activity-time">
                        <strong>{formatClock(record.check_in_at)}</strong>
                        <small>{record.check_out_at ? `Salida ${formatClock(record.check_out_at)}` : "En jornada"}</small>
                      </span>
                    </Link>
                  ))}
                  <Link to="/admin/attendance" className="dash-panel-link">
                    Revisar asistencia <ChevronRight size={15} />
                  </Link>
                </div>
              ) : (
                <div className="dash-empty">
                  <span className="dash-empty-icon"><Clock size={22} /></span>
                  <div>
                    <strong>Aún no hay marcaciones</strong>
                    <p>La actividad aparecerá cuando se registre la primera entrada.</p>
                  </div>
                </div>
              )}
            </section>
          </div>
        </>
      ) : null}
    </AdminShell>
  );
}

function KpiCard({
  href,
  label,
  value,
  unit,
  icon,
  chip,
  tone,
  onClick,
}: {
  href: string;
  label: string;
  value: number;
  unit: string;
  icon: React.ReactNode;
  chip: string;
  tone: "blue" | "green" | "red" | "neutral";
  onClick?: () => void;
}) {
  return (
    <Link
      to={href}
      onClick={onClick}
      className={`dash-kpi dash-kpi--${tone}`}
      aria-label={`${label}: ${value}. Abrir detalle`}
    >
      <div className="dash-kpi-head">
        <span className="dash-kpi-label">{label}</span>
        <span className={`dash-kpi-icon dash-kpi-icon--${tone}`}>{icon}</span>
      </div>
      <div className="dash-kpi-value">
        <strong>{value}</strong>
        <small>{unit}</small>
      </div>
      <div className="dash-kpi-foot">
        <span className="dash-kpi-chip"><i aria-hidden />{chip}</span>
        <ChevronRight size={16} className="dash-kpi-arrow" />
      </div>
      <span className="dash-kpi-accent" aria-hidden />
    </Link>
  );
}
