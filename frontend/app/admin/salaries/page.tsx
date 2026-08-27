"use client";

import { useCallback, useEffect, useState } from "react";
import AdminShell from "@/components/AdminShell";
import { useAdminUser } from "@/components/AdminSession";
import { Alert, ChevronRight, Coins, Download } from "@/components/Icons";
import { StatSkeleton, TableSkeleton } from "@/components/Loading";
import {
  API_URL,
  ApiError,
  PayrollPeriod,
  PayrollRecord,
  PayrollSummary,
  payrollApi,
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
  const user = useAdminUser();
  const [periods, setPeriods] = useState<PayrollPeriod[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [summary, setSummary] = useState<PayrollSummary | null>(null);
  const [records, setRecords] = useState<PayrollRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const canView = user ? MANAGE_ROLES.includes(user.role) : false;

  const load = useCallback(async () => {
    try {
      if (!canView) return;
      const list = await payrollApi.periods();
      setPeriods(list);
      if (list.length > 0 && !selectedId) {
        setSelectedId(list[0].id);
      }
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Error de conexión con el servidor");
    } finally {
      setLoading(false);
    }
  }, [canView, selectedId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!selectedId || !canView) return;
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
  }, [selectedId, canView]);

  return (
    <AdminShell
      title="Sueldos por periodo"
      subtitle="Vista de liquidaciones · los totales los calcula el backend"
    >
      {!canView && (
        <p className="alert alert-error" role="alert">
          <Alert size={15} style={{ marginTop: 2, flexShrink: 0 }} />
          Solo administradores y jefes pueden ver los sueldos.
        </p>
      )}

      <div className="toolbar">
        <select className="select" value={selectedId} onChange={(e) => setSelectedId(e.target.value)} style={{ maxWidth: 260 }}>
          {periods.length === 0 && <option value="">Sin periodos</option>}
          {periods.map((period) => (
            <option key={period.id} value={period.id}>
              {period.name} ({period.status})
            </option>
          ))}
        </select>
        <span className="spacer" />
        {selectedId && (
          <button
            className="btn btn-outline btn-sm"
            onClick={() => window.open(`${API_URL}/api/v1/exports/salaries.csv?period_id=${selectedId}`)}
          >
            <Download size={15} />
            Exportar CSV
          </button>
        )}
      </div>

      {error && (
        <p className="alert alert-error" role="alert">
          <Alert size={15} style={{ marginTop: 2, flexShrink: 0 }} />
          {error}
        </p>
      )}

      {loading ? (
        <StatSkeleton count={5} />
      ) : (
        summary && (
          <div className="stat-grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))" }}>
            <Stat label="Total planilla" value={formatMoney(summary.total)} />
            <Stat label="Sueldo base" value={formatMoney(summary.total_base)} />
            <Stat label="Horas extra" value={formatMoney(summary.total_overtime)} green />
            <Stat label="Ajustes manuales" value={formatMoney(summary.total_manual)} />
            <Stat label="Empleados" value={String(summary.employee_count)} />
          </div>
        )
      )}

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Empleado</th>
              <th style={{ textAlign: "right" }}>Sueldo base</th>
              <th style={{ textAlign: "right" }}>Horas extra</th>
              <th style={{ textAlign: "right" }}>Ajuste manual</th>
              <th style={{ textAlign: "right" }}>Total</th>
              <th style={{ textAlign: "right" }}>Detalle</th>
            </tr>
          </thead>
          <tbody>
            {loading && <TableSkeleton rows={5} cols={6} />}
            {!loading && records.length === 0 && (
              <tr>
                <td colSpan={6} className="empty">
                  <Coins size={26} />
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
    </AdminShell>
  );
}

function Stat({ label, value, green }: { label: string; value: string; green?: boolean }) {
  return (
    <div className="stat-card">
      <div className="stat-label">{label}</div>
      <div className="stat-value" style={green ? { color: "var(--dark-green)" } : undefined}>
        {value}
      </div>
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
      <tr style={expanded ? { background: "var(--blue-soft)" } : undefined}>
        <td style={{ fontWeight: 600 }}>{record.employee_name ?? "—"}</td>
        <td className="num" style={{ textAlign: "right" }}>
          {formatMoney(record.base_salary)}
        </td>
        <td className="num" style={{ textAlign: "right" }}>
          {record.overtime_minutes > 0 ? (
            <span style={{ color: "var(--dark-green)" }}>{formatMoney(record.overtime_amount)}</span>
          ) : (
            "—"
          )}
        </td>
        <td className="num" style={{ textAlign: "right" }}>
          {Number(record.manual_adjustment) !== 0 ? (
            <span style={{ color: Number(record.manual_adjustment) < 0 ? "var(--red)" : "var(--primary-blue)" }}>
              {formatMoney(record.manual_adjustment)}
            </span>
          ) : (
            <span className="muted">—</span>
          )}
        </td>
        <td className="num" style={{ textAlign: "right", fontWeight: 700 }}>
          {formatMoney(record.total)}
        </td>
        <td style={{ textAlign: "right" }}>
          <button className="link-btn" onClick={onToggle} style={{ fontSize: "0.78rem" }}>
            {expanded ? "Ocultar" : "Ver detalle"}
          </button>
        </td>
      </tr>
      {expanded && (
        <tr style={{ background: "var(--gray-100)" }}>
          <td colSpan={6} style={{ padding: "0.9rem 1.2rem" }}>
            <div style={{ display: "grid", gap: "0.7rem", gridTemplateColumns: "repeat(auto-fit,minmax(170px,1fr))", fontSize: "0.84rem" }}>
              <div>
                <p className="label" style={{ marginBottom: "0.1rem" }}>Trabajado</p>
                <p style={{ fontWeight: 600 }}>{formatMinutes(record.worked_minutes)}</p>
              </div>
              <div>
                <p className="label" style={{ marginBottom: "0.1rem" }}>Esperado (jornada)</p>
                <p style={{ fontWeight: 600 }}>{formatMinutes(record.expected_minutes)}</p>
              </div>
              <div>
                <p className="label" style={{ marginBottom: "0.1rem" }}>Horas extra</p>
                <p style={{ fontWeight: 600 }}>
                  {record.overtime_minutes > 0
                    ? `${formatMinutes(record.overtime_minutes)} = ${formatMoney(record.overtime_amount)}`
                    : "—"}
                </p>
              </div>
              <div>
                <p className="label" style={{ marginBottom: "0.1rem" }}>Ajustes de horas (aprobados)</p>
                <p style={{ fontWeight: 600 }}>{formatMinutes(record.adjustment_minutes)}</p>
              </div>
              {record.notes && (
                <div>
                  <p className="label" style={{ marginBottom: "0.1rem" }}>Notas del ajuste manual</p>
                  <p style={{ fontWeight: 600 }}>{record.notes}</p>
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
