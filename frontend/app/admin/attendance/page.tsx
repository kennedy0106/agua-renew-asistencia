"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ApiError,
  attendanceAdminApi,
  AttendanceListItem,
  authApi,
  employeesApi,
  Employee,
} from "@/lib/api";

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

export default function AdminAttendancePage() {
  const router = useRouter();
  const [records, setRecords] = useState<AttendanceListItem[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [employeeFilter, setEmployeeFilter] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [statusFilter, setStatusFilter] = useState("");

  const load = useCallback(async () => {
    try {
      await authApi.me();
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
        </div>

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
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {records.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-6 text-center text-zinc-400">
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
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </main>
    </div>
  );
}
