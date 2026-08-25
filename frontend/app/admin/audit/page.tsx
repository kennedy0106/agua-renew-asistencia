"use client";

import { useCallback, useEffect, useState } from "react";
import AdminShell from "@/components/AdminShell";
import { Alert, Shield } from "@/components/Icons";
import { ApiError, auditApi, AuditLog } from "@/lib/api";

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
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setLogs(await auditApi.list({ limit: 200 }));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Error de conexión con el servidor");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <AdminShell
      title="Auditoría"
      subtitle={`${logs.length} acción(es) registrada(s) · acceso exclusivo de administradores`}
    >
      {error && (
        <p className="alert alert-error" role="alert">
          <Alert size={15} style={{ marginTop: 2, flexShrink: 0 }} />
          {error}
        </p>
      )}

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Fecha</th>
              <th>Usuario</th>
              <th>Entidad</th>
              <th>Motivo</th>
              <th>Cambios</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={5} className="empty">
                  Cargando bitácora…
                </td>
              </tr>
            )}
            {!loading && logs.length === 0 && (
              <tr>
                <td colSpan={5} className="empty">
                  <Shield size={26} />
                  Sin correcciones registradas.
                </td>
              </tr>
            )}
            {logs.map((log) => (
              <tr key={log.id}>
                <td className="num" style={{ whiteSpace: "nowrap", color: "var(--muted)" }}>
                  {formatDateTime(log.created_at)}
                </td>
                <td style={{ fontWeight: 600 }}>{log.performed_by_username ?? "—"}</td>
                <td>
                  <span className="badge badge-blue">{log.entity_type}</span>
                  <span className="muted" style={{ marginLeft: "0.35rem", fontSize: "0.75rem" }}>
                    {log.action}
                  </span>
                </td>
                <td style={{ maxWidth: 230 }}>{log.reason}</td>
                <td style={{ fontSize: "0.76rem" }}>
                  <div style={{ color: "#9a5b00", textDecoration: "line-through", textDecorationColor: "#e8c27a" }}>
                    {prettyValues(log.old_values)}
                  </div>
                  <div style={{ color: "var(--dark-green)", marginTop: "0.15rem" }}>
                    {prettyValues(log.new_values)}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </AdminShell>
  );
}
