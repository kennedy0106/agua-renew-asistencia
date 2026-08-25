"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ApiError, auditApi, AuditLog, authApi, UserOut } from "@/lib/api";

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("es-PE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function prettyValues(values: Record<string, unknown> | null): string {
  if (!values) return "—";
  const parts = Object.entries(values)
    .filter(([key]) => key !== "work_date")
    .map(([key, value]) => {
      const label = key
        .replace("_at", "")
        .replace("_", " ")
        .replace(/^./, (c) => c.toUpperCase());
      let shown = String(value ?? "vacío");
      if (key === "check_in_at" || key === "check_out_at") {
        shown = shown.length > 5 ? shown.slice(11, 16) : shown;
      }
      if (key === "worked_minutes" && value !== null) {
        const h = Math.floor(Number(value) / 60);
        const m = Number(value) % 60;
        shown = `${h} h ${m} min`;
      }
      return `${label}: ${shown}`;
    });
  return parts.join(" · ");
}

export default function AdminAuditPage() {
  const router = useRouter();
  const [user, setUser] = useState<UserOut | null>(null);
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const me = await authApi.me();
      setUser(me);
      if (me.role !== "ADMIN") {
        setError("Solo los administradores pueden ver la auditoría.");
        setLogs([]);
        return;
      }
      setLogs(await auditApi.list({ limit: 200 }));
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

  return (
    <div className="flex flex-1 flex-col bg-zinc-50">
      <header className="flex items-center justify-between border-b border-zinc-200 bg-white px-6 py-4">
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-sky-600 text-lg">
            💧
          </span>
          <span className="font-semibold text-zinc-900">Agua ReNew</span>
          <span className="text-sm text-zinc-500">· Auditoría</span>
        </div>
        <button
          onClick={() => router.push("/admin/dashboard")}
          className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm text-zinc-600 transition-colors hover:bg-zinc-100"
        >
          ← Dashboard
        </button>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 p-6">
        <div className="mb-6">
          <h1 className="text-2xl font-semibold text-zinc-900">Auditoría</h1>
          <p className="text-sm text-zinc-500">
            {logs.length} corrección(es) registrada(s). Acceso exclusivo de administradores.
          </p>
        </div>

        {error && (
          <p className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
        )}

        <div className="overflow-hidden rounded-2xl border border-zinc-200 bg-white">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-zinc-200 bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="px-4 py-3">Fecha</th>
                <th className="px-4 py-3">Usuario</th>
                <th className="px-4 py-3">Entidad</th>
                <th className="px-4 py-3">Motivo</th>
                <th className="px-4 py-3">Cambios</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {logs.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-zinc-400">
                    {loading ? "Cargando…" : "Sin correcciones registradas."}
                  </td>
                </tr>
              )}
              {logs.map((log) => (
                <tr key={log.id}>
                  <td className="whitespace-nowrap px-4 py-3 text-zinc-500">
                    {formatDateTime(log.created_at)}
                  </td>
                  <td className="px-4 py-3 font-medium text-zinc-900">
                    {log.performed_by_username ?? "—"}
                  </td>
                  <td className="px-4 py-3">
                    <span className="rounded-full bg-zinc-100 px-2.5 py-0.5 text-xs font-medium text-zinc-600">
                      {log.entity_type}
                    </span>
                    <span className="ml-1 text-xs text-zinc-400">{log.action}</span>
                  </td>
                  <td className="max-w-[220px] px-4 py-3 text-zinc-700">{log.reason}</td>
                  <td className="px-4 py-3 text-xs text-zinc-500">
                    <div className="text-amber-600 line-through decoration-amber-400">
                      {prettyValues(log.old_values)}
                    </div>
                    <div className="mt-0.5 text-emerald-700">{prettyValues(log.new_values)}</div>
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
