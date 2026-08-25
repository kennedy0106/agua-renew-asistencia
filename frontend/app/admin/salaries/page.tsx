"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ApiError,
  authApi,
  PayrollPeriod,
  PayrollRecord,
  PayrollSummary,
  payrollApi,
  UserOut,
} from "@/lib/api";

const MANAGE_ROLES = ["ADMIN", "BOSS"];

function formatMoney(value: string): string {
  return `S/ ${Number(value).toLocaleString("es-PE", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return `${h} h ${m.toString().padStart(2, "0")}`;
}

export default function AdminSalariesPage() {
  const router = useRouter();
  const [user, setUser] = useState<UserOut | null>(null);
  const [periods, setPeriods] = useState<PayrollPeriod[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [summary, setSummary] = useState<PayrollSummary | null>(null);
  const [records, setRecords] = useState<PayrollRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const me = await authApi.me();
      setUser(me);
      if (!MANAGE_ROLES.includes(me.role)) {
        setError("Solo administradores y jefes pueden ver los sueldos.");
        return;
      }
      const list = await payrollApi.periods();
      setPeriods(list);
      if (list.length > 0 && !selectedId) {
        setSelectedId(list[0].id);
      }
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
  }, [router, selectedId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!selectedId) return;
    let active = true;
    Promise.all([payrollApi.summary(selectedId), payrollApi.records(selectedId)])
      .then(([sum, recs]) => {
        if (!active) return;
        setSummary(sum);
        setRecords(recs);
        setError(null);
      })
      .catch((err) => {
        if (active && err instanceof ApiError) {
          setError(err.message);
        }
      });
    return () => {
      active = false;
    };
  }, [selectedId]);

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center bg-zinc-50 text-zinc-500">
        Cargando…
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col bg-zinc-50">
      <header className="flex items-center justify-between border-b border-zinc-200 bg-white px-6 py-4">
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-sky-600 text-lg">
            💧
          </span>
          <span className="font-semibold text-zinc-900">Agua ReNew</span>
          <span className="text-sm text-zinc-500">· Sueldos</span>
        </div>
        <button
          onClick={() => router.push("/admin/dashboard")}
          className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm text-zinc-600 transition-colors hover:bg-zinc-100"
        >
          ← Dashboard
        </button>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 p-6">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold text-zinc-900">Sueldos por periodo</h1>
            <p className="text-sm text-zinc-500">
              Vista de liquidaciones. Los totales los calcula el backend.
            </p>
          </div>
          <select
            value={selectedId}
            onChange={(e) => setSelectedId(e.target.value)}
            className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-sky-500"
          >
            {periods.length === 0 && <option value="">Sin periodos</option>}
            {periods.map((period) => (
              <option key={period.id} value={period.id}>
                {period.name} ({period.status})
              </option>
            ))}
          </select>
        </div>

        {error && (
          <p className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
        )}

        {summary && (
          <div className="mb-6 grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <div className="rounded-2xl border border-zinc-200 bg-white p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-zinc-400">
                Total planilla
              </p>
              <p className="mt-1 text-2xl font-semibold text-zinc-900">
                {formatMoney(summary.total)}
              </p>
            </div>
            <div className="rounded-2xl border border-zinc-200 bg-white p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-zinc-400">
                Sueldo base
              </p>
              <p className="mt-1 text-2xl font-semibold text-zinc-900">
                {formatMoney(summary.total_base)}
              </p>
            </div>
            <div className="rounded-2xl border border-zinc-200 bg-white p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-zinc-400">
                Horas extra
              </p>
              <p className="mt-1 text-2xl font-semibold text-emerald-600">
                {formatMoney(summary.total_overtime)}
              </p>
            </div>
            <div className="rounded-2xl border border-zinc-200 bg-white p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-zinc-400">
                Ajustes manuales
              </p>
              <p className="mt-1 text-2xl font-semibold text-sky-600">
                {formatMoney(summary.total_manual)}
              </p>
            </div>
            <div className="rounded-2xl border border-zinc-200 bg-white p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-zinc-400">
                Empleados
              </p>
              <p className="mt-1 text-2xl font-semibold text-zinc-900">
                {summary.employee_count}
              </p>
            </div>
          </div>
        )}

        <div className="overflow-hidden rounded-2xl border border-zinc-200 bg-white">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-zinc-200 bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="px-4 py-3">Empleado</th>
                <th className="px-4 py-3 text-right">Sueldo base</th>
                <th className="px-4 py-3 text-right">Horas extra</th>
                <th className="px-4 py-3 text-right">Ajuste manual</th>
                <th className="px-4 py-3 text-right">Total</th>
                <th className="px-4 py-3 text-right">Detalle</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {records.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-center text-zinc-400">
                    Sin registros para este periodo.
                  </td>
                </tr>
              )}
              {records.map((record) => (
                <FragmentRow
                  key={record.id}
                  record={record}
                  expanded={expanded === record.id}
                  onToggle={() => setExpanded(expanded === record.id ? null : record.id)}
                />
              ))}
            </tbody>
          </table>
        </div>
      </main>
    </div>
  );
}

function FragmentRow({
  record,
  expanded,
  onToggle,
}: {
  record: PayrollRecord;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr className={expanded ? "bg-sky-50/50" : ""}>
        <td className="px-4 py-3 font-medium text-zinc-900">{record.employee_name ?? "—"}</td>
        <td className="px-4 py-3 text-right tabular-nums">{formatMoney(record.base_salary)}</td>
        <td className="px-4 py-3 text-right tabular-nums">
          {record.overtime_minutes > 0 ? (
            <span className="text-emerald-700">{formatMoney(record.overtime_amount)}</span>
          ) : (
            "—"
          )}
        </td>
        <td className="px-4 py-3 text-right tabular-nums">
          {Number(record.manual_adjustment) !== 0 ? (
            <span className={Number(record.manual_adjustment) < 0 ? "text-red-600" : "text-sky-700"}>
              {formatMoney(record.manual_adjustment)}
            </span>
          ) : (
            <span className="text-zinc-300">—</span>
          )}
        </td>
        <td className="px-4 py-3 text-right font-semibold tabular-nums text-zinc-900">
          {formatMoney(record.total)}
        </td>
        <td className="px-4 py-3 text-right">
          <button
            onClick={onToggle}
            className="text-xs text-sky-600 hover:underline"
          >
            {expanded ? "Ocultar" : "Ver detalle"}
          </button>
        </td>
      </tr>
      {expanded && (
        <tr className="bg-zinc-50/60">
          <td colSpan={6} className="px-6 py-4">
            <div className="grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <p className="text-xs text-zinc-400">Trabajado</p>
                <p className="font-medium text-zinc-900">{formatMinutes(record.worked_minutes)}</p>
              </div>
              <div>
                <p className="text-xs text-zinc-400">Esperado (jornada)</p>
                <p className="font-medium text-zinc-900">{formatMinutes(record.expected_minutes)}</p>
              </div>
              <div>
                <p className="text-xs text-zinc-400">Horas extra</p>
                <p className="font-medium text-zinc-900">
                  {record.overtime_minutes > 0
                    ? `${formatMinutes(record.overtime_minutes)} = ${formatMoney(record.overtime_amount)}`
                    : "—"}
                </p>
              </div>
              <div>
                <p className="text-xs text-zinc-400">Ajustes de horas (aprobados)</p>
                <p className="font-medium text-zinc-900">{formatMinutes(record.adjustment_minutes)}</p>
              </div>
              {record.notes && (
                <div className="sm:col-span-2 lg:col-span-4">
                  <p className="text-xs text-zinc-400">Notas del ajuste manual</p>
                  <p className="font-medium text-zinc-900">{record.notes}</p>
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
