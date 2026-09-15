"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import AdminShell from "@/components/AdminShell";
import { useAdminUser } from "@/components/AdminSession";
import { Alert, Coins, Download, Receipt, Refresh } from "@/components/Icons";
import { Skeleton, StatSkeleton, TableSkeleton } from "@/components/Loading";
import { TablePagination, useTablePagination } from "@/components/Pagination";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  API_URL,
  ApiError,
  PayrollDailyReport,
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
  const [dailyReport, setDailyReport] = useState<PayrollDailyReport | null>(null);
  const [dailyReportLoading, setDailyReportLoading] = useState(false);
  const [dailyReportError, setDailyReportError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const canView = user ? MANAGE_ROLES.includes(user.role) : false;
  const orderedRecords = [...records.filter((record) => record.payable !== false), ...records.filter((record) => record.payable === false)];
  const pagination = useTablePagination(orderedRecords, `${selectedId}:${orderedRecords.length}`);

  const load = useCallback(async () => {
    try {
      if (!canView) return;
      const list = await payrollApi.periods();
      setPeriods(list);
      setSelectedId((current) => current || list[0]?.id || "");
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Error de conexión con el servidor");
    } finally {
      setLoading(false);
    }
  }, [canView]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!selectedId || !canView) return;
    let active = true;
    setDetailsLoading(true);
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
      })
      .finally(() => {
        if (active) setDetailsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [selectedId, canView]);

  useEffect(() => {
    if (!selectedId || !canView) return;
    let active = true;
    setDailyReport(null);
    setDailyReportError(null);
    setDailyReportLoading(true);
    payrollApi.dailyReport(selectedId)
      .then((report) => {
        if (active) setDailyReport(report);
      })
      .catch((err) => {
        if (active) {
          setDailyReportError(err instanceof ApiError ? err.message : "No se pudo cargar el desglose diario.");
        }
      })
      .finally(() => {
        if (active) setDailyReportLoading(false);
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
        <Select value={selectedId} onValueChange={(v) => setSelectedId(v)} disabled={loading || periods.length === 0}>
          <SelectTrigger aria-label="Periodo de pago" style={{ maxWidth: 280 }}>
            <SelectValue placeholder={periods.length === 0 ? "Sin periodos" : "Seleccionar periodo"} />
          </SelectTrigger>
          <SelectContent>
            {periods.map((period) => (
              <SelectItem key={period.id} value={period.id}>
                {period.name} ({period.status})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
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
        <div className="alert alert-error alert-with-action" role="alert">
          <span className="alert-copy"><Alert size={15} /> {error}</span>
          <button className="btn btn-outline btn-sm" type="button" onClick={load}>
            <Refresh size={14} /> Reintentar
          </button>
        </div>
      )}

      {loading || detailsLoading ? (
        <StatSkeleton count={5} />
      ) : (
        summary && (
          <div className="stat-grid salaries-summary" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(190px,1fr))" }}>
            <Stat label="Monto estimado a pagar" value={formatMoney(summary.total)} />
            <Stat label="Sueldo base" value={formatMoney(summary.total_base)} />
            <Stat label="Horas extra" value={formatMoney(summary.total_overtime)} green />
            <Stat label="Ajustes manuales" value={formatMoney(summary.total_manual)} />
            <Stat label="Empleados" value={String(summary.employee_count)} />
          </div>
        )
      )}

      {!loading && periods.length === 0 ? (
        <div className="empty-state card card-pad">
          <Receipt size={28} />
          <div>
            <h3>Aún no hay periodos de pago</h3>
            <p>Primero crea y calcula un periodo para consultar los montos.</p>
          </div>
          <Link href="/admin/payroll" className="btn btn-primary btn-sm">
            Ir a cálculo de pago
          </Link>
        </div>
      ) : <div className="table-wrap" aria-busy={detailsLoading}>
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
            {(loading || detailsLoading) && <TableSkeleton rows={5} cols={6} />}
            {!loading && !detailsLoading && records.length === 0 && (
              <tr>
                <td colSpan={6} className="empty">
                  <Coins size={26} />
                  Sin registros para este periodo.
                </td>
              </tr>
            )}
            {pagination.pageItems.flatMap((record, index) => [
              ...(record.payable === false && (index === 0 || pagination.pageItems[index - 1]?.payable !== false)
                ? [<tr key={`separator-${record.id}`}><td colSpan={6} style={{ background: "var(--gray-100)", fontWeight: 600 }}>Historial excluido (no suma al pago)</td></tr>]
                : []),
              <FragmentRow
                key={record.id}
                record={record}
                daily={dailyReport?.daily.filter((item) => item.employee_id === record.employee_id) ?? []}
                employeeSummary={dailyReport?.employees.find((item) => item.employee_id === record.employee_id) ?? null}
                dailyLoading={dailyReportLoading}
                dailyError={dailyReportError}
                expanded={expanded === record.id}
                onToggle={() => setExpanded(expanded === record.id ? null : record.id)}
              />,
            ])}
          </tbody>
        </table>
      </div>}
      {!loading && !detailsLoading && <TablePagination {...pagination} />}
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

function recognitionStatusLabel(status: PayrollDailyReport["daily"][number]["status"]): string {
  return {
    FUTURE_PENDING: "Pendiente",
    PENDING: "En curso",
    NO_ATTENDANCE: "Sin asistencia",
    PARTIAL: "Parcial",
    RECOGNIZED: "Reconocido",
  }[status];
}

function recognitionStatusClass(status: PayrollDailyReport["daily"][number]["status"]): string {
  return {
    FUTURE_PENDING: "badge-blue",
    PENDING: "badge-amber",
    NO_ATTENDANCE: "badge-red",
    PARTIAL: "badge-amber",
    RECOGNIZED: "badge-green",
  }[status];
}

function FragmentRow({
  record,
  daily,
  employeeSummary,
  dailyLoading,
  dailyError,
  expanded,
  onToggle,
}: {
  record: PayrollRecord;
  daily: PayrollDailyReport["daily"];
  employeeSummary: PayrollDailyReport["employees"][number] | null;
  dailyLoading: boolean;
  dailyError: string | null;
  expanded: boolean;
  onToggle: () => void;
}) {
  const dailyPagination = useTablePagination(
    daily,
    `${record.employee_id}:${daily.map((item) => `${item.work_date}:${item.recognized_total_amount}:${item.status}`).join("|")}`,
  );

  return (
    <>
      <tr style={expanded ? { background: "var(--blue-soft)" } : undefined}>
        <td style={{ fontWeight: 600 }}>
          {record.employee_name ?? "—"}
          {record.payable === false && (
            <div className="muted" style={{ fontWeight: 400, fontSize: "0.78rem" }}>
              Excluido del pago
            </div>
          )}
        </td>
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
          <div style={{ display: "inline-flex", gap: "0.5rem", alignItems: "center" }}>
            <Link
              className="btn btn-ghost btn-sm"
              href={`/admin/employees/${record.employee_id}`}
              style={{ fontSize: "0.78rem" }}
              title="Editar sueldo y jornada"
            >
              Editar
            </Link>
            <button className="btn btn-outline btn-sm" onClick={onToggle}>
              {expanded ? "Ocultar" : "Ver detalle"}
            </button>
          </div>
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
            {employeeSummary && (
              <div style={{ marginTop: "1rem" }}>
                <p className="label" style={{ marginBottom: "0.55rem" }}>Resumen informativo a la fecha</p>
                <div style={{ display: "grid", gap: "0.7rem", gridTemplateColumns: "repeat(auto-fit,minmax(145px,1fr))", fontSize: "0.84rem" }}>
                  <div><p className="muted">Base programada</p><p style={{ fontWeight: 700 }}>{formatMoney(employeeSummary.programmed_base_amount)}</p></div>
                  <div><p className="muted">Base reconocida</p><p style={{ fontWeight: 700 }}>{formatMoney(employeeSummary.recognized_base_amount)}</p></div>
                  <div><p className="muted">HE reconocida</p><p style={{ fontWeight: 700 }}>{formatMoney(employeeSummary.recognized_overtime_amount)}</p></div>
                  <div><p className="muted">Total reconocido</p><p style={{ fontWeight: 700 }}>{formatMoney(employeeSummary.recognized_total_amount)}</p></div>
                  <div><p className="muted">Base futura pendiente</p><p style={{ fontWeight: 700 }}>{formatMoney(employeeSummary.future_pending_base_amount)}</p></div>
                  <div><p className="muted">Diferencia por revisar</p><p style={{ fontWeight: 700 }}>{formatMoney(employeeSummary.review_difference_amount)}</p></div>
                </div>
              </div>
            )}
            <div style={{ marginTop: "1rem" }}>
              <p className="label" style={{ marginBottom: "0.55rem" }}>Desglose diario del periodo</p>
              {dailyLoading ? (
                <div aria-live="polite" aria-label="Cargando desglose diario" style={{ display: "grid", gap: "0.45rem", maxWidth: 640 }}>
                  <Skeleton width="100%" height={12} />
                  <Skeleton width="82%" height={12} />
                  <Skeleton width="92%" height={12} />
                </div>
              ) : dailyError ? (
                <p className="muted" role="status" style={{ fontSize: "0.84rem" }}>{dailyError}</p>
              ) : daily.length === 0 ? (
                <p className="muted" style={{ fontSize: "0.84rem" }}>No hay jornadas programadas ni movimientos para este empleado.</p>
              ) : (
                <div className="table-wrap" style={{ margin: 0 }}>
                  <table className="table" style={{ minWidth: 1020 }}>
                    <thead>
                      <tr>
                        <th>Fecha</th>
                        <th>Estado</th>
                        <th style={{ textAlign: "right" }}>Reconocido</th>
                        <th style={{ textAlign: "right" }}>Esperado</th>
                        <th style={{ textAlign: "right" }}>Base programada</th>
                        <th style={{ textAlign: "right" }}>Base reconocida</th>
                        <th style={{ textAlign: "right" }}>HE reconocida</th>
                        <th style={{ textAlign: "right" }}>Ajustes aprobados</th>
                        <th style={{ textAlign: "right" }}>Total reconocido</th>
                      </tr>
                    </thead>
                    <tbody>
                      {dailyPagination.pageItems.map((item) => (
                        <tr key={item.work_date}>
                          <td>{new Date(`${item.work_date}T12:00:00`).toLocaleDateString("es-PE", { day: "2-digit", month: "short", year: "numeric" })}</td>
                          <td><span className={`badge ${recognitionStatusClass(item.status)}`}>{recognitionStatusLabel(item.status)}</span></td>
                          <td className="num" style={{ textAlign: "right" }}>{formatMinutes(item.recognized_minutes)}</td>
                          <td className="num" style={{ textAlign: "right" }}>{formatMinutes(item.expected_minutes)}</td>
                          <td className="num" style={{ textAlign: "right" }}>{formatMoney(item.base_amount)}</td>
                          <td className="num" style={{ textAlign: "right" }}>{formatMoney(item.recognized_base_amount)}</td>
                          <td className="num" style={{ textAlign: "right" }}>{item.overtime_minutes > 0 ? formatMoney(item.recognized_overtime_amount) : "—"}</td>
                          <td className="num" style={{ textAlign: "right" }}>{item.approved_adjustment_minutes !== 0 ? `${formatMinutes(item.approved_adjustment_minutes)} · sin monto` : "—"}</td>
                          <td className="num" style={{ textAlign: "right", fontWeight: 700 }}>{formatMoney(item.recognized_total_amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <TablePagination {...dailyPagination} />
                </div>
              )}
              {Number(record.manual_adjustment) !== 0 && (
                <p className="muted" style={{ fontSize: "0.82rem", marginTop: "0.65rem" }}>
                  Ajuste manual del periodo: {formatMoney(record.manual_adjustment)}. No se asigna a un día porque aún no tiene fecha propia.
                </p>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
