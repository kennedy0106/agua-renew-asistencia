"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  API_URL,
  ApiError,
  attendanceAdminApi,
  AttendanceListItem,
  authApi,
  employeesApi,
  Employee,
  UserOut,
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
  const router = useRouter();
  const [user, setUser] = useState<UserOut | null>(null);
  const [records, setRecords] = useState<AttendanceListItem[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [employeeFilter, setEmployeeFilter] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [statusFilter, setStatusFilter] = useState("");

  // Corrección (Fase 8)
  const [correcting, setCorrecting] = useState<AttendanceListItem | null>(null);
  const [corrCheckIn, setCorrCheckIn] = useState("");
  const [corrCheckOut, setCorrCheckOut] = useState("");
  const [corrNotes, setCorrNotes] = useState("");
  const [corrReason, setCorrReason] = useState("");
  const [savingCorrection, setSavingCorrection] = useState(false);

  const canManage = user ? MANAGE_ROLES.includes(user.role) : false;

  const load = useCallback(async () => {
    try {
      const me = await authApi.me();
      setUser(me);
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
      if (err instanceof ApiError && err.status === 401) {
        router.replace("/admin/login");
      } else {
        setError(err instanceof ApiError ? err.message : "Error de conexión con el servidor");
      }
    } finally {
      setLoading(false);
    }
  }, [router, employeeFilter, dateFrom, dateTo, statusFilter]);

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

  return (
    <div className="flex flex-1 flex-col bg-zinc-50">
      <header className="flex items-center justify-between border-b border-zinc-200 bg-white px-6 py-4">
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-sky-600 text-lg">
            💧
          </span>
          <span className="font-semibold text-zinc-900">Agua ReNew</span>
          <span className="text-sm text-zinc-500">· Asistencia</span>
        </div>
        <button
          onClick={() => router.push("/admin/dashboard")}
          className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm text-zinc-600 transition-colors hover:bg-zinc-100"
        >
          ← Dashboard
        </button>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 p-6">
        <div className="mb-6">
          <h1 className="text-2xl font-semibold text-zinc-900">Asistencia</h1>
          <p className="text-sm text-zinc-500">
            {records.length} registro(s). Esperado = jornada pactada para esa fecha.
          </p>
        </div>

        {error && (
          <p className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
        )}

        <div className="mb-4 flex flex-wrap gap-3">
          <select
            value={employeeFilter}
            onChange={(e) => setEmployeeFilter(e.target.value)}
            className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-sky-500"
          >
            <option value="">Todos los empleados</option>
            {employees.map((e) => (
              <option key={e.id} value={e.id}>
                {e.first_name} {e.last_name}
              </option>
            ))}
          </select>
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-sky-500"
          />
          <span className="self-center text-xs text-zinc-400">a</span>
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-sky-500"
          />
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-sky-500"
          >
            <option value="">Todos los estados</option>
            <option value="OPEN">Entrada abierta</option>
            <option value="COMPLETE">Completado</option>
          </select>
          <button
            onClick={() => {
              const params = new URLSearchParams();
              if (employeeFilter) params.set("employee_id", employeeFilter);
              if (dateFrom) params.set("date_from", dateFrom);
              if (dateTo) params.set("date_to", dateTo);
              if (statusFilter) params.set("status", statusFilter);
              const qs = params.toString();
              window.open(`${API_URL}/api/v1/exports/attendance.csv${qs ? `?${qs}` : ""}`);
            }}
            className="rounded-lg border border-emerald-300 bg-white px-3 py-2 text-sm font-medium text-emerald-700 hover:bg-emerald-50"
          >
            Exportar CSV
          </button>
        </div>

        {correcting && canManage && (
          <form
            onSubmit={handleSaveCorrection}
            className="mb-4 rounded-2xl border border-amber-200 bg-amber-50/60 p-4"
          >
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-zinc-900">
                Corregir registro · {correcting.employee_name}
              </h2>
              <button
                type="button"
                onClick={() => setCorrecting(null)}
                className="text-xs text-zinc-400 hover:text-zinc-600"
              >
                Cerrar ✕
              </button>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <label className="flex flex-col gap-1 text-sm font-medium text-zinc-700">
                Entrada
                <input
                  type="datetime-local"
                  value={corrCheckIn}
                  onChange={(e) => setCorrCheckIn(e.target.value)}
                  className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-amber-500"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm font-medium text-zinc-700">
                Salida (vacío = quitar salida)
                <input
                  type="datetime-local"
                  value={corrCheckOut}
                  onChange={(e) => setCorrCheckOut(e.target.value)}
                  className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-amber-500"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm font-medium text-zinc-700">
                Notas
                <input
                  type="text"
                  value={corrNotes}
                  onChange={(e) => setCorrNotes(e.target.value)}
                  className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-amber-500"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm font-medium text-zinc-700">
                Motivo (obligatorio)
                <input
                  type="text"
                  value={corrReason}
                  onChange={(e) => setCorrReason(e.target.value)}
                  required
                  minLength={3}
                  placeholder="Ej. olvidó marcar salida"
                  className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-amber-500"
                />
              </label>
            </div>
            <p className="mt-2 text-xs text-zinc-500">
              El backend recalcula automáticamente minutos trabajados y estado; la corrección queda
              registrada en auditoría.
            </p>
            <button
              type="submit"
              disabled={savingCorrection || corrReason.trim().length < 3}
              className="mt-3 rounded-lg bg-amber-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-amber-700 disabled:opacity-50"
            >
              {savingCorrection ? "Guardando…" : "Guardar corrección"}
            </button>
          </form>
        )}

        <div className="overflow-x-auto rounded-2xl border border-zinc-200 bg-white">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-zinc-200 bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="px-4 py-3">Empleado</th>
                <th className="px-4 py-3">Fecha</th>
                <th className="px-4 py-3">Entrada</th>
                <th className="px-4 py-3">Salida</th>
                <th className="px-4 py-3">Trabajado</th>
                <th className="px-4 py-3">Esperado</th>
                <th className="px-4 py-3">Diferencia</th>
                <th className="px-4 py-3">Estado</th>
                {canManage && <th className="px-4 py-3 text-right">Acciones</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {records.length === 0 && (
                <tr>
                  <td colSpan={canManage ? 9 : 8} className="px-4 py-6 text-center text-zinc-400">
                    Sin registros con los filtros actuales.
                  </td>
                </tr>
              )}
              {records.map((record) => (
                <tr key={record.id}>
                  <td className="px-4 py-3">
                    <a
                      href={`/admin/employees/${record.employee_id}`}
                      className="font-medium text-zinc-900 hover:text-sky-700 hover:underline"
                    >
                      {record.employee_name ?? "—"}
                    </a>
                    <span className="ml-1 text-xs text-zinc-400">
                      {record.job_role_name ?? ""}
                    </span>
                  </td>
                  <td className="px-4 py-3">{record.work_date}</td>
                  <td className="px-4 py-3 tabular-nums">{formatClock(record.check_in_at)}</td>
                  <td className="px-4 py-3 tabular-nums">{formatClock(record.check_out_at)}</td>
                  <td className="px-4 py-3 tabular-nums">{formatMinutes(record.worked_minutes)}</td>
                  <td className="px-4 py-3 tabular-nums">{formatMinutes(record.expected_minutes)}</td>
                  <td
                    className={`px-4 py-3 tabular-nums ${
                      record.difference_minutes === null
                        ? "text-zinc-400"
                        : record.difference_minutes < 0
                          ? "text-amber-600"
                          : record.difference_minutes > 0
                            ? "text-emerald-600"
                            : "text-zinc-500"
                    }`}
                  >
                    {formatDifference(record.difference_minutes)}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={
                        record.status === "OPEN"
                          ? "rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-medium text-amber-700"
                          : "rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-700"
                      }
                    >
                      {record.status === "OPEN" ? "Abierta" : "Completado"}
                    </span>
                  </td>
                  {canManage && (
                    <td className="px-4 py-3">
                      <div className="flex justify-end">
                        <button
                          onClick={() => startCorrection(record)}
                          className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs text-zinc-600 transition-colors hover:bg-zinc-100"
                        >
                          Corregir
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </main>
    </div>
  );
}
