"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ApiError,
  authApi,
  PayrollPeriod,
  PayrollRecord,
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

const STATUS_LABEL: Record<string, string> = {
  OPEN: "Abierto",
  CALCULATED: "Calculado",
  CLOSED: "Cerrado",
};

export default function AdminPayrollPage() {
  const router = useRouter();
  const [user, setUser] = useState<UserOut | null>(null);
  const [periods, setPeriods] = useState<PayrollPeriod[]>([]);
  const [records, setRecords] = useState<PayrollRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Crear periodo
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: "", start_date: "", end_date: "" });

  // Ajuste manual
  const [adjustingId, setAdjustingId] = useState<string | null>(null);
  const [adjustAmount, setAdjustAmount] = useState("");
  const [adjustNotes, setAdjustNotes] = useState("");

  const canManage = user ? MANAGE_ROLES.includes(user.role) : false;

  const load = useCallback(async () => {
    try {
      const me = await authApi.me();
      setUser(me);
      if (!MANAGE_ROLES.includes(me.role)) {
        setError("Solo administradores y jefes pueden ver la planilla.");
        return;
      }
      setPeriods(await payrollApi.periods());
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
  }, [router]);

  useEffect(() => {
    load();
  }, [load]);

  const selected = periods.find((p) => p.id === selectedId) ?? null;

  async function loadRecords(periodId: string) {
    setBusy(true);
    setError(null);
    try {
      const [list, recs] = await Promise.all([
        payrollApi.periods(),
        payrollApi.records(periodId),
      ]);
      setPeriods(list);
      setRecords(recs);
      setSelectedId(periodId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudieron cargar los registros");
    } finally {
      setBusy(false);
    }
  }

  async function handleCreatePeriod(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await payrollApi.createPeriod(form);
      setShowForm(false);
      setForm({ name: "", start_date: "", end_date: "" });
      setPeriods(await payrollApi.periods());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo crear el periodo");
    } finally {
      setBusy(false);
    }
  }

  async function handleCalculate(periodId: string) {
    setBusy(true);
    setError(null);
    try {
      await payrollApi.calculate(periodId);
      await loadRecords(periodId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo calcular");
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveAdjustment(recordId: string) {
    setBusy(true);
    setError(null);
    try {
      await payrollApi.setAdjustment(recordId, adjustAmount || "0.00", adjustNotes.trim() || null);
      setAdjustingId(null);
      setAdjustAmount("");
      setAdjustNotes("");
      if (selectedId) await loadRecords(selectedId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo ajustar");
    } finally {
      setBusy(false);
    }
  }

  async function handleConfirm(periodId: string) {
    setBusy(true);
    setError(null);
    try {
      await payrollApi.confirm(periodId);
      setPeriods(await payrollApi.periods());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo confirmar");
    } finally {
      setBusy(false);
    }
  }

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
          <span className="text-sm text-zinc-500">· Planilla</span>
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
            <h1 className="text-2xl font-semibold text-zinc-900">Planilla</h1>
            <p className="text-sm text-zinc-500">
              Calcular → revisar → ajustar con motivo → cerrar (inmutable).
            </p>
          </div>
          {canManage && (
            <button
              onClick={() => setShowForm((v) => !v)}
              className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-sky-700"
            >
              {showForm ? "Cancelar" : "+ Nuevo periodo"}
            </button>
          )}
        </div>

        {error && (
          <p className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
        )}

        {canManage && showForm && (
          <form
            onSubmit={handleCreatePeriod}
            className="mb-6 grid gap-3 rounded-2xl border border-zinc-200 bg-white p-4 sm:grid-cols-3"
          >
            <label className="flex flex-col gap-1 text-sm font-medium text-zinc-700">
              Nombre
              <input
                type="text"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                required
                placeholder="Agosto 2026"
                className="rounded-lg border border-zinc-300 px-3 py-2 text-zinc-900 outline-none focus:border-sky-500"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm font-medium text-zinc-700">
              Desde
              <input
                type="date"
                value={form.start_date}
                onChange={(e) => setForm({ ...form, start_date: e.target.value })}
                required
                className="rounded-lg border border-zinc-300 px-3 py-2 text-zinc-900 outline-none focus:border-sky-500"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm font-medium text-zinc-700">
              Hasta
              <input
                type="date"
                value={form.end_date}
                onChange={(e) => setForm({ ...form, end_date: e.target.value })}
                required
                className="rounded-lg border border-zinc-300 px-3 py-2 text-zinc-900 outline-none focus:border-sky-500"
              />
            </label>
            <div className="sm:col-span-3">
              <button
                type="submit"
                disabled={busy}
                className="rounded-lg bg-sky-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-sky-700 disabled:opacity-50"
              >
                Crear periodo
              </button>
            </div>
          </form>
        )}

        <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {periods.length === 0 && (
            <p className="text-sm text-zinc-400">Sin periodos. Crea el primero.</p>
          )}
          {periods.map((period) => (
            <div
              key={period.id}
              className={`rounded-2xl border bg-white p-4 ${
                selectedId === period.id ? "border-sky-400 ring-1 ring-sky-200" : "border-zinc-200"
              }`}
            >
              <div className="flex items-center justify-between">
                <p className="font-semibold text-zinc-900">{period.name}</p>
                <span
                  className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                    period.status === "CLOSED"
                      ? "bg-zinc-100 text-zinc-500"
                      : period.status === "CALCULATED"
                        ? "bg-sky-50 text-sky-700"
                        : "bg-amber-50 text-amber-700"
                  }`}
                >
                  {STATUS_LABEL[period.status]}
                </span>
              </div>
              <p className="mt-1 text-xs text-zinc-400">
                {period.start_date} → {period.end_date}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  onClick={() => loadRecords(period.id)}
                  className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs text-zinc-600 hover:bg-zinc-100"
                >
                  Registros
                </button>
                {period.status !== "CLOSED" && (
                  <button
                    onClick={() => handleCalculate(period.id)}
                    disabled={busy}
                    className="rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-sky-700 disabled:opacity-50"
                  >
                    {period.status === "OPEN" ? "Calcular" : "Recalcular"}
                  </button>
                )}
                {period.status === "CALCULATED" && (
                  <button
                    onClick={() => handleConfirm(period.id)}
                    disabled={busy}
                    className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                  >
                    Confirmar y cerrar
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>

        {selected && (
          <div className="overflow-x-auto rounded-2xl border border-zinc-200 bg-white">
            <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3">
              <p className="font-semibold text-zinc-900">
                Registros de {selected.name}
                <span className="ml-2 text-xs font-normal text-zinc-400">
                  {records.length} empleado(s) con sueldo en el periodo
                </span>
              </p>
              {selected.status !== "CLOSED" && (
                <span className="text-xs text-zinc-400">
                  Los totales son provisionales hasta cerrar el periodo.
                </span>
              )}
            </div>
            <table className="w-full text-left text-sm">
              <thead className="border-b border-zinc-200 bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500">
                <tr>
                  <th className="px-4 py-3">Empleado</th>
                  <th className="px-4 py-3 text-right">Sueldo</th>
                  <th className="px-4 py-3 text-right">Trabajado</th>
                  <th className="px-4 py-3 text-right">Esperado</th>
                  <th className="px-4 py-3 text-right">Horas extra</th>
                  <th className="px-4 py-3 text-right">Ajuste manual</th>
                  <th className="px-4 py-3 text-right">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100">
                {records.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-4 py-6 text-center text-zinc-400">
                      Sin registros. Usa «Calcular» para generar el preview.
                    </td>
                  </tr>
                )}
                {records.map((record) => (
                  <tr key={record.id}>
                    <td className="px-4 py-3 font-medium text-zinc-900">
                      {record.employee_name ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {formatMoney(record.base_salary)}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {formatMinutes(record.worked_minutes)}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {formatMinutes(record.expected_minutes)}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {record.overtime_minutes > 0 ? (
                        <>
                          <span className="text-zinc-700">{formatMinutes(record.overtime_minutes)}</span>
                          <span className="ml-1 text-emerald-700">
                            ({formatMoney(record.overtime_amount)})
                          </span>
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {adjustingId === record.id && selected.status !== "CLOSED" ? (
                        <span className="flex items-center justify-end gap-1">
                          <input
                            type="number"
                            step={0.01}
                            value={adjustAmount}
                            onChange={(e) => setAdjustAmount(e.target.value)}
                            className="w-24 rounded-lg border border-zinc-300 px-2 py-1 text-xs text-zinc-900 outline-none focus:border-sky-500"
                          />
                          <input
                            type="text"
                            value={adjustNotes}
                            onChange={(e) => setAdjustNotes(e.target.value)}
                            placeholder="motivo"
                            className="w-28 rounded-lg border border-zinc-300 px-2 py-1 text-xs text-zinc-900 outline-none focus:border-sky-500"
                          />
                          <button
                            onClick={() => handleSaveAdjustment(record.id)}
                            className="rounded-lg bg-sky-600 px-2 py-1 text-xs font-semibold text-white"
                          >
                            OK
                          </button>
                          <button
                            onClick={() => setAdjustingId(null)}
                            className="text-xs text-zinc-400"
                          >
                            ✕
                          </button>
                        </span>
                      ) : (
                        <>
                          {Number(record.manual_adjustment) !== 0 ? (
                            <span
                              className={
                                Number(record.manual_adjustment) < 0
                                  ? "text-red-600"
                                  : "text-emerald-700"
                              }
                            >
                              {formatMoney(record.manual_adjustment)}
                            </span>
                          ) : (
                            <span className="text-zinc-300">0.00</span>
                          )}
                          {selected.status !== "CLOSED" && (
                            <button
                              onClick={() => {
                                setAdjustingId(record.id);
                                setAdjustAmount(record.manual_adjustment);
                                setAdjustNotes(record.notes ?? "");
                              }}
                              className="ml-2 text-xs text-sky-600 hover:underline"
                            >
                              Ajustar
                            </button>
                          )}
                        </>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right font-semibold tabular-nums text-zinc-900">
                      {formatMoney(record.total)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </div>
  );
}
