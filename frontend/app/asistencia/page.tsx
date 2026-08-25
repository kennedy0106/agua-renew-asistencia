"use client";

import { useState } from "react";
import {
  ApiError,
  attendanceApi,
  AttendanceRecordOut,
  IdentifyResponse,
} from "@/lib/api";

type Step = "identify" | "employee" | "done";

function formatClock(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit" });
}

function formatDuration(minutes: number | null): string {
  if (minutes === null) return "—";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return `${h} h ${m} min`;
}

export default function AsistenciaPage() {
  const [step, setStep] = useState<Step>("identify");
  const [identifier, setIdentifier] = useState("");
  const [data, setData] = useState<IdentifyResponse | null>(null);
  const [record, setRecord] = useState<AttendanceRecordOut | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleIdentify(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const result = await attendanceApi.identify(identifier);
      setData(result);
      setStep("employee");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo conectar con el servidor");
    } finally {
      setLoading(false);
    }
  }

  async function handleMark(action: "checkIn" | "checkOut") {
    if (!data) return;
    setLoading(true);
    setError(null);
    try {
      const result =
        action === "checkIn"
          ? await attendanceApi.checkIn(data.employee.id)
          : await attendanceApi.checkOut(data.employee.id);
      setRecord(result);
      setStep("done");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo registrar la marcación");
    } finally {
      setLoading(false);
    }
  }

  function reset() {
    setStep("identify");
    setIdentifier("");
    setData(null);
    setRecord(null);
    setError(null);
  }

  return (
    <div className="flex flex-1 flex-col items-center justify-center bg-zinc-50 px-6 py-10">
      <main className="w-full max-w-md">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-sky-600 text-3xl">
            💧
          </div>
          <h1 className="text-2xl font-semibold text-zinc-900">Control de asistencia</h1>
          <p className="text-sm text-zinc-500">Agua ReNew</p>
        </div>

        {error && (
          <p className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-center text-sm text-red-700">
            {error}
          </p>
        )}

        {step === "identify" && (
          <form
            onSubmit={handleIdentify}
            className="flex flex-col gap-3 rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm"
          >
            <label className="flex flex-col gap-1 text-sm font-medium text-zinc-700">
              DNI o código
              <input
                type="text"
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                required
                autoFocus
                placeholder="Ej. 72845632 o EMP-001"
                className="rounded-lg border border-zinc-300 px-3 py-3 text-center text-lg text-zinc-900 outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-100"
              />
            </label>
            <button
              type="submit"
              disabled={loading || !identifier.trim()}
              className="rounded-lg bg-sky-600 px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-sky-700 disabled:opacity-50"
            >
              {loading ? "Buscando…" : "Continuar"}
            </button>
          </form>
        )}

        {step === "employee" && data && (
          <div className="flex flex-col gap-4 rounded-2xl border border-zinc-200 bg-white p-6 text-center shadow-sm">
            <div>
              <p className="text-lg font-semibold text-zinc-900">
                {data.employee.first_name} {data.employee.last_name}
              </p>
              <p className="text-sm text-zinc-500">{data.employee.job_role_name ?? "—"}</p>
            </div>
            <div className="rounded-xl bg-zinc-50 py-3">
              <p className="text-3xl font-bold tabular-nums text-zinc-900">
                {data.server_time_label}
              </p>
              <p className="text-xs text-zinc-400">Hora del servidor (Lima)</p>
            </div>

            {data.state.has_open_entry ? (
              <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-3 text-sm text-emerald-800">
                Entrada registrada:{" "}
                <span className="font-semibold">{formatClock(data.state.open_check_in_at!)}</span>
              </div>
            ) : (
              data.state.last_record && (
                <p className="text-xs text-zinc-400">
                  Última marcación: {data.state.last_record.work_date} ·{" "}
                  {formatDuration(data.state.last_record.worked_minutes)}
                </p>
              )
            )}

            <button
              onClick={() => handleMark(data.state.has_open_entry ? "checkOut" : "checkIn")}
              disabled={loading}
              className={`rounded-lg px-4 py-3 text-sm font-semibold text-white transition-colors disabled:opacity-50 ${
                data.state.has_open_entry
                  ? "bg-amber-500 hover:bg-amber-600"
                  : "bg-sky-600 hover:bg-sky-700"
              }`}
            >
              {loading
                ? "Procesando…"
                : data.state.has_open_entry
                  ? "MARCAR SALIDA"
                  : "MARCAR ENTRADA"}
            </button>
            <button
              onClick={reset}
              className="text-xs text-zinc-400 hover:text-zinc-600"
            >
              ← Cambiar de trabajador
            </button>
          </div>
        )}

        {step === "done" && record && data && (
          <div className="flex flex-col gap-4 rounded-2xl border border-zinc-200 bg-white p-6 text-center shadow-sm">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-emerald-100 text-2xl">
              ✅
            </div>
            <div>
              <p className="text-lg font-semibold text-zinc-900">
                {record.status === "OPEN" ? "Entrada registrada" : "Salida registrada"}
              </p>
              <p className="text-sm text-zinc-500">
                {data.employee.first_name} {data.employee.last_name} · {record.work_date}
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div className="rounded-xl bg-zinc-50 py-3">
                <p className="text-xs text-zinc-400">Entrada</p>
                <p className="font-semibold text-zinc-900">{formatClock(record.check_in_at)}</p>
              </div>
              <div className="rounded-xl bg-zinc-50 py-3">
                <p className="text-xs text-zinc-400">Salida</p>
                <p className="font-semibold text-zinc-900">
                  {record.check_out_at ? formatClock(record.check_out_at) : "—"}
                </p>
              </div>
            </div>
            {record.worked_minutes !== null && (
              <p className="text-sm text-zinc-600">
                Horas trabajadas:{" "}
                <span className="font-semibold">{formatDuration(record.worked_minutes)}</span>
              </p>
            )}
            <button
              onClick={reset}
              className="rounded-lg bg-sky-600 px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-sky-700"
            >
              Terminar
            </button>
          </div>
        )}
      </main>
    </div>
  );
}
