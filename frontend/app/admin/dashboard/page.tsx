"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import AdminShell from "@/components/AdminShell";
import { useAdminUser } from "@/components/AdminSession";
import { Spinner, StatSkeleton } from "@/components/Loading";
import { Alert, Chart, Check, ChevronRight, ClipboardCheck, Clock, Refresh, Users } from "@/components/Icons";
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
    ...(data?.missingEmployees.map((employee) => ({ id: `missing-${employee.id}`, title: `${employee.first_name} ${employee.last_name}`, detail: employee.job_role_name ?? "Sin cargo asignado", status: "Sin entrada" })) ?? []),
    ...openEntries.map((record) => ({ id: `open-${record.id}`, title: record.employee_name ?? "Empleado sin nombre", detail: `Entrada registrada a las ${formatClock(record.check_in_at)}`, status: "Entrada abierta" })),
  ];

  return (
    <AdminShell title="Resumen de asistencia" subtitle={user ? `${formatLongDate()} · ${user.username}` : formatLongDate()}>
      <section className="dashboard-statusbar" aria-label="Estado de actualización">
        <div><strong>Jornada de hoy</strong><span>{updatedAt ? `Actualizado a las ${formatClock(updatedAt.toISOString())}` : "Esperando datos del servidor"}</span></div>
        <button type="button" className="btn btn-outline dashboard-refresh" onClick={() => void load(true)} disabled={refreshing}>
          {refreshing ? <Spinner /> : <Refresh size={16} />}{refreshing ? "Actualizando resumen…" : "Actualizar"}
        </button>
      </section>

      {error && (
        <div className="alert alert-error dashboard-error" role="alert">
          <Alert size={17} /><div><strong>No pudimos cargar el resumen</strong><span>{error} Revisa tu conexión y vuelve a intentarlo.</span></div>
          <button type="button" className="btn btn-outline btn-sm" onClick={() => void load()}>Reintentar</button>
        </div>
      )}

      {loading ? <StatSkeleton count={5} /> : data ? (
        <>
          <section className="dashboard-overview" aria-labelledby="team-status-title">
            <div className="dashboard-command surface-material">
              <div className="dashboard-command-copy">
                <h2 id="team-status-title">El equipo, de un vistazo.</h2>
                <p>Seguimiento de marcaciones registradas hoy en hora de Lima.</p>
              </div>
              <div className="dashboard-presence" aria-label={`${data.summary.present_today} de ${data.summary.employees_active} empleados activos presentes hoy`}>
                <span className="dashboard-presence-status"><i aria-hidden />Jornada activa</span>
                <strong>{data.summary.present_today}<small>/{data.summary.employees_active}</small></strong>
                <span>presentes hoy</span>
              </div>
              <div className="dashboard-progress">
                <div className="dashboard-progress-track" aria-hidden><span style={{ width: `${data.summary.employees_active ? Math.min(100, (data.summary.present_today / data.summary.employees_active) * 100) : 0}%` }} /></div>
                <Link href="/admin/attendance" prefetch={false} className="dashboard-command-link">Ver marcaciones <ChevronRight size={16} /></Link>
              </div>
            </div>
            <aside className="dashboard-attention" aria-label="Resumen de atención">
              <div className="dashboard-attention-icon"><Alert size={19} /></div>
              <div><span>Requiere atención</span><strong>{data.summary.no_entry_today + data.summary.open_entries}</strong><p>{data.summary.no_entry_today} sin entrada · {data.summary.open_entries} jornadas abiertas</p></div>
              <Link href="#incidencias" prefetch={false} className="dashboard-attention-link" aria-label="Ver incidencias"><ChevronRight size={18} /></Link>
            </aside>
          </section>

          <section className="dashboard-metrics" aria-label="Indicadores de la jornada">
            <StatCard href="/admin/employees" label="Empleados activos" value={data.summary.employees_active} icon={<Users size={16} />} tone="blue" />
            <StatCard href="#incidencias" label="Sin entrada hoy" value={data.summary.no_entry_today} icon={<Alert size={16} />} tone="red" />
            <StatCard href="#incidencias" label="Entradas abiertas" value={data.summary.open_entries} icon={<ClipboardCheck size={16} />} tone="blue" />
            <StatCard href="/admin/attendance" label="Con salida hoy" value={data.summary.checked_out_today} icon={<Chart size={16} />} tone="green" />
          </section>

          <div className="dashboard-workspace">
            <section id="incidencias" className="operations-panel surface-material" aria-labelledby="incidents-title">
              <div className="operations-panel-head"><div><h2 id="incidents-title">Incidencias por resolver</h2><p>Personas sin entrada y jornadas que siguen abiertas.</p></div>{incidents.length > 0 && <span className="count-badge">{incidents.length}</span>}</div>
              {incidents.length > 0 ? (
                <div className="operations-list">
                  {incidents.slice(0, 6).map((incident) => (
                    <Link key={incident.id} href="/admin/attendance" prefetch={false} className="operation-row">
                      <span className="operation-alert"><Alert size={16} /></span><span className="operation-copy"><strong>{incident.title}</strong><small>{incident.detail}</small></span><span className="operation-status">{incident.status}</span><ChevronRight size={16} />
                    </Link>
                  ))}
                  {incidents.length > 6 && <Link href="/admin/attendance" prefetch={false} className="panel-link">Ver {incidents.length - 6} incidencias más <ChevronRight size={15} /></Link>}
                </div>
              ) : (
                <div className="operational-empty"><span><Check size={20} /></span><div><strong>Todo está al día</strong><p>No hay incidencias pendientes en la jornada.</p></div></div>
              )}
            </section>

            <section className="operations-panel surface-material" aria-labelledby="activity-title">
              <div className="operations-panel-head"><div><h2 id="activity-title">Actividad reciente</h2><p>Últimas marcaciones registradas hoy.</p></div></div>
              {data.records.length > 0 ? (
                <div className="operations-list">
                  {data.records.slice(0, 5).map((record) => (
                    <Link key={record.id} href="/admin/attendance" prefetch={false} className="activity-row">
                      <span className="activity-mark" aria-hidden /><span className="operation-copy"><strong>{record.employee_name ?? "Empleado sin nombre"}</strong><small>{record.job_role_name ?? "Sin cargo asignado"}</small></span><span className="activity-time"><strong>{formatClock(record.check_in_at)}</strong><small>{record.check_out_at ? `Salida ${formatClock(record.check_out_at)}` : "En jornada"}</small></span>
                    </Link>
                  ))}
                  <Link href="/admin/attendance" prefetch={false} className="panel-link">Revisar asistencia <ChevronRight size={15} /></Link>
                </div>
              ) : (
                <div className="operational-empty operational-empty--neutral"><span><Clock size={20} /></span><div><strong>Aún no hay marcaciones</strong><p>La actividad aparecerá cuando se registre la primera entrada.</p></div></div>
              )}
            </section>
          </div>
        </>
      ) : null}
    </AdminShell>
  );
}

function StatCard({ href, label, value, icon, tone, featured = false }: { href: string; label: string; value: number; icon: React.ReactNode; tone: "blue" | "green" | "red"; featured?: boolean }) {
  return <Link href={href} prefetch={false} className={`stat-card surface-material stat-card--${tone}${featured ? " stat-card--featured" : ""}`} aria-label={`${label}: ${value}. Abrir detalle`}><div className="stat-label">{icon}{label}</div><div className="stat-value">{value}</div><span className="stat-action">Ver detalle <ChevronRight size={14} /></span></Link>;
}
