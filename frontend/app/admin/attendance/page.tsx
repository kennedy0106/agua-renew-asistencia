"use client";

import { useCallback, useEffect, useState } from "react";
import AdminShell, { useAdminUser } from "@/components/AdminShell";
import { Alert, Download, Pencil, X } from "@/components/Icons";
import {
  API_URL,
  ApiError,
  attendanceAdminApi,
  AttendanceListItem,
  employeesApi,
  Employee,
} from "@/lib/api";

const MANAGE_ROLES = ["ADMIN", "BOSS"];

function formatClock(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit" });
}

function formatMinutes(minutes: number | null): string {
  if (minutes === null) return "—";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return `${h} h ${m.toString().padStart(2, "0")}`;
}

function formatDifference(minutes: number | null): string {
  if (minutes === null) return "—";
  const sign = minutes > 0 ? "+" : "";
  return `${sign}${formatMinutes(minutes)}`;
}

function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInput(local: string): string | null {
  if (!local) return null;
  return new Date(local).toISOString();
}

export default function AdminAttendancePage() {
  const user = useAdminUser();
  const [records, setRecords] = useState<AttendanceListItem[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [employeeFilter, setEmployeeFilter] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [statusFilter, setStatusFilter] = useState("");

  const [correcting, setCorrecting] = useState<AttendanceListItem | null>(null);
  const [corrCheckIn, setCorrCheckIn] = useState("");
  const [corrCheckOut, setCorrCheckOut] = useState("");
  const [corrNotes, setCorrNotes] = useState("");
  const [corrReason, setCorrReason] = useState("");
  const [savingCorrection, setSavingCorrection] = useState(false);

  const canManage = user ? MANAGE_ROLES.includes(user.role) : false;

  const load = useCallback(async () => {
    try {
      const [list, emps] = await Promise.all([
        attendanceAdminApi.list({
          employee_id: employeeFilter || undefined,
          date_from: dateFrom || undefined,
          date_to: dateTo || undefined,
          status: statusFilter || undefined,
        }),
        employeesApi.list(),
      ]);
      setRecords(list);
      setEmployees(emps);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Error de conexión con el servidor");
    } finally {
      setLoading(false);
    }
  }, [employeeFilter, dateFrom, dateTo, statusFilter]);

  useEffect(() => {
    load();
  }, [load]);

  function startCorrection(record: AttendanceListItem) {
    setCorrecting(record);
    setCorrCheckIn(toLocalInput(record.check_in_at));
    setCorrCheckOut(toLocalInput(record.check_out_at));
    setCorrNotes(record.notes ?? "");
    setCorrReason("");
    setError(null);
  }

  async function handleSaveCorrection(event: React.FormEvent) {
    event.preventDefault();
    if (!correcting) return;
    setSavingCorrection(true);
    setError(null);
    try {
      await attendanceAdminApi.correct(correcting.id, {
        check_in_at: fromLocalInput(corrCheckIn),
        check_out_at: fromLocalInput(corrCheckOut),
        notes: corrNotes.trim() || null,
        reason: corrReason.trim(),
      });
      setCorrecting(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo corregir el registro");
    } finally {
      setSavingCorrection(false);
    }
  }

  function exportCsv() {
    const params = new URLSearchParams();
    if (employeeFilter) params.set("employee_id", employeeFilter);
    if (dateFrom) params.set("date_from", dateFrom);
    if (dateTo) params.set("date_to", dateTo);
    if (statusFilter) params.set("status", statusFilter);
    const qs = params.toString();
    window.open(`${API_URL}/api/v1/exports/attendance.csv${qs ? `?${qs}` : ""}`);
  }

  return (
    <AdminShell title="Asistencia" subtitle={`${records.length} registro(s) · esperado = jornada pactada`}>
      {error && (
        <p className="alert alert-error" role="alert">
          <Alert size={15} style={{ marginTop: 2, flexShrink: 0 }} />
          {error}
        </p>
      )}

      <div className="toolbar">
        <select className="select" value={employeeFilter} onChange={(e) => setEmployeeFilter(e.target.value)} style={{ maxWidth: 220 }}>
          <option value="">Todos los empleados</option>
          {employees.map((e) => (
            <option key={e.id} value={e.id}>
              {e.first_name} {e.last_name}
            </option>
          ))}
        </select>
        <input type="date" className="input" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} style={{ maxWidth: 150 }} />
        <span className="muted" style={{ fontSize: "0.8rem" }}>a</span>
        <input type="date" className="input" value={dateTo} onChange={(e) => setDateTo(e.target.value)} style={{ maxWidth: 150 }} />
        <select className="select" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={{ maxWidth: 160 }}>
          <option value="">Todos los estados</option>
          <option value="OPEN">Entrada abierta</option>
          <option value="COMPLETE">Completado</option>
        </select>
        <span className="spacer" />
        <button className="btn btn-outline btn-sm" onClick={exportCsv}>
          <Download size={15} />
          Exportar CSV
        </button>
      </div>

      {correcting && canManage && (
        <form onSubmit={handleSaveCorrection} className="card card-pad" style={{ marginBottom: "1rem", borderColor: "#f0d9a8", background: "#fffdf7" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "0.7rem" }}>
            <h2 className="card-title">Corregir registro · {correcting.employee_name}</h2>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setCorrecting(null)} aria-label="Cerrar">
              <X size={14} />
            </button>
          </div>
          <div style={{ display: "grid", gap: "0.7rem", gridTemplateColumns: "repeat(auto-fit,minmax(170px,1fr))" }}>
            <div>
              <label className="label">Entrada</label>
              <input type="datetime-local" className="input" value={corrCheckIn} onChange={(e) => setCorrCheckIn(e.target.value)} />
            </div>
            <div>
              <label className="label">Salida (vacío = quitar salida)</label>
              <input type="datetime-local" className="input" value={corrCheckOut} onChange={(e) => setCorrCheckOut(e.target.value)} />
            </div>
            <div>
              <label className="label">Notas</label>
              <input type="text" className="input" value={corrNotes} onChange={(e) => setCorrNotes(e.target.value)} />
            </div>
            <div>
              <label className="label">Motivo (obligatorio)</label>
              <input
                type="text"
                className="input"
                value={corrReason}
                onChange={(e) => setCorrReason(e.target.value)}
                required
                minLength={3}
                placeholder="Ej. olvidó marcar salida"
              />
            </div>
          </div>
          <p className="muted" style={{ fontSize: "0.76rem", marginTop: "0.6rem" }}>
            El backend recalcula automáticamente minutos y estado; la corrección queda en auditoría.
          </p>
          <button
            type="submit"
            className="btn btn-amber"
            style={{ marginTop: "0.7rem" }}
            disabled={savingCorrection || corrReason.trim().length < 3}
          >
            <Pencil size={15} />
            {savingCorrection ? "Guardando…" : "Guardar corrección"}
          </button>
        </form>
      )}

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Empleado</th>
              <th>Fecha</th>
              <th>Entrada</th>
              <th>Salida</th>
              <th>Trabajado</th>
              <th>Esperado</th>
              <th>Diferencia</th>
              <th>Estado</th>
              {canManage && <th style={{ textAlign: "right" }}>Acciones</th>}
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={canManage ? 9 : 8} className="empty">
                  Cargando registros…
                </td>
              </tr>
            )}
            {!loading && records.length === 0 && (
              <tr>
                <td colSpan={canManage ? 9 : 8} className="empty">
                  Sin registros con los filtros actuales.
                </td>
              </tr>
            )}
            {records.map((record) => (
              <tr key={record.id}>
                <td>
                  <a href={`/admin/employees/${record.employee_id}`} style={{ fontWeight: 600 }}>
                    {record.employee_name ?? "—"}
                  </a>
                  <span className="muted" style={{ marginLeft: "0.4rem", fontSize: "0.75rem" }}>
                    {record.job_role_name ?? ""}
                  </span>
                </td>
                <td className="num">{record.work_date}</td>
                <td className="num">{formatClock(record.check_in_at)}</td>
                <td className="num">{formatClock(record.check_out_at)}</td>
                <td className="num">{formatMinutes(record.worked_minutes)}</td>
                <td className="num">{formatMinutes(record.expected_minutes)}</td>
                <td
                  className="num"
                  style={{
                    color:
                      record.difference_minutes === null
                        ? "var(--muted)"
                        : record.difference_minutes < 0
                          ? "#9a5b00"
                          : record.difference_minutes > 0
                            ? "var(--dark-green)"
                            : "var(--muted)",
                  }}
                >
                  {formatDifference(record.difference_minutes)}
                </td>
                <td>
                  {record.status === "OPEN" ? (
                    <span className="badge badge-amber">Abierta</span>
                  ) : (
                    <span className="badge badge-green">Completado</span>
                  )}
                </td>
                {canManage && (
                  <td style={{ textAlign: "right" }}>
                    <button className="btn btn-ghost btn-sm" onClick={() => startCorrection(record)}>
                      <Pencil size={13} />
                      Corregir
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </AdminShell>
  );
}
