"use client";

import { useCallback, useEffect, useState } from "react";
import AdminShell from "@/components/AdminShell";
import { Alert, Shield } from "@/components/Icons";
import { TableSkeleton } from "@/components/Loading";
import { TablePagination, useTablePagination } from "@/components/Pagination";
import { ApiError, auditApi, AuditLog } from "@/lib/api";

const entityCopy: Record<string, string> = {
  attendance: "Marcación", attendance_attempt: "Intento de marcación", attendance_break_override: "Refrigerio",
  adjustment: "Ajuste de horas", manual_attendance_day: "Carga de horas", recovery_commitment: "Recuperación",
  employee_weekly_rest_rule: "Descanso semanal", holiday_calendar_day: "Feriado", rest_substitution: "Cambio de descanso",
  special_day_valuation: "Pago de día especial", payroll_period: "Periodo de pago", payroll_record: "Pago de empleado",
  salary: "Sueldo", schedule: "Jornada", overtime_policy: "Regla de horas extra", user: "Usuario",
};
const actionCopy: Record<string, string> = {
  create: "Creado", created: "Creado", update: "Actualizado", correction: "Corregido", set_salary: "Sueldo actualizado",
  set_schedule: "Jornada actualizada", reset_password: "Clave restablecida", change_password: "Clave cambiada",
  versioned_update: "Editado", multi_versioned_update: "Editado en bloque", multi_created: "Creado en bloque",
  voided: "Anulado", approve: "Aprobado", approved: "Aprobado", reject: "Rechazado", reconciled: "Marcado como pagado",
  payment_approved: "Pago aprobado", rectification_created: "Corrección de periodo creada", manual_adjustment: "Importe ajustado",
  close: "Periodo cerrado", ATTEMPT_CANCELLED: "Intento cancelado", ATTEMPT_REVIEWED: "Intento revisado",
  UPDATE_OVERTIME_POLICY: "Regla de horas extra actualizada", break_override_cleared: "Refrigerio automático restaurado",
};
const fieldCopy: Record<string, string> = {
  status: "Estado", minutes: "Duración", worked_minutes: "Tiempo trabajado", worked_minutes_net: "Tiempo trabajado",
  normal_minutes: "Jornada regular", additional_minutes: "Horas adicionales", recovery_minutes: "Horas recuperadas",
  requested_break_minutes: "Refrigerio registrado", break_source: "Cálculo del refrigerio", version: "Versión",
  employee_id: "Empleado", effective_from: "Vigente desde", effective_to: "Vigente hasta",
};
const valueCopy: Record<string, string> = {
  PENDING: "Pendiente", APPROVED: "Aprobado", REJECTED: "Rechazado", VOIDED: "Anulado",
  OPEN: "Abierto", CLOSED: "Cerrado", CALCULATED: "Calculado", AUTOMATIC: "Automático", OVERRIDE: "Registrado manualmente",
};

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("es-PE", {
    timeZone: "America/Lima",
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
      const label = fieldCopy[key] ?? key
        .replace("_at", "")
        .replaceAll("_", " ")
        .replace(/^./, (c) => c.toUpperCase());
      let shown = valueCopy[String(value)] ?? String(value ?? "vacío");
      if (key === "check_in_at" || key === "check_out_at") {
        shown = shown.length > 5 ? shown.slice(11, 16) : shown;
      }
      if (key.endsWith("minutes") && value !== null && Number.isFinite(Number(value))) {
        const total = Number(value);
        const h = Math.floor(Math.abs(total) / 60);
        const m = Math.abs(total) % 60;
        shown = `${total < 0 ? "−" : ""}${h} h ${m} min`;
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
  const pagination = useTablePagination(logs, logs.length);

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
            {loading && <TableSkeleton rows={6} cols={5} />}
            {!loading && logs.length === 0 && (
              <tr>
                <td colSpan={5} className="empty">
                  <Shield size={26} />
                  Sin correcciones registradas.
                </td>
              </tr>
            )}
            {pagination.pageItems.map((log) => (
              <tr key={log.id}>
                <td className="num" style={{ whiteSpace: "nowrap", color: "var(--muted)" }}>
                  {formatDateTime(log.created_at)}
                </td>
                <td style={{ fontWeight: 600 }}>{log.performed_by_username ?? "—"}</td>
                <td>
                  <span className="badge badge-blue">{entityCopy[log.entity_type] ?? "Cambio del sistema"}</span>
                  <span className="muted" style={{ marginLeft: "0.35rem", fontSize: "0.75rem" }}>
                    {actionCopy[log.action] ?? "Actualizado"}
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
      <TablePagination {...pagination} />
    </AdminShell>
  );
}
