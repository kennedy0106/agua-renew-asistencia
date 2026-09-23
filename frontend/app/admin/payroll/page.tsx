"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import AdminShell from "@/components/AdminShell";
import AppDialog, { AppDialogCloseButton } from "@/components/AppDialog";
import { useNotifications } from "@/components/Notifications";
import { useAdminUser } from "@/components/AdminSession";
import DateField from "@/components/DateField";
import { Alert, Pencil, Plus, Receipt, X } from "@/components/Icons";
import { Spinner, TableSkeleton } from "@/components/Loading";
import { TablePagination, useTablePagination } from "@/components/Pagination";
import { ApiError, PayrollPeriod, PayrollReadiness, PayrollRecord, PayrollSummary, payrollApi } from "@/lib/api";

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

/** Rango en lenguaje cotidiano: "1 sep 2026 → 30 sep 2026". */
function formatRange(start: string, end: string): string {
  const format = (value: string) => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) return value;
    const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
    return new Intl.DateTimeFormat("es-PE", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(date);
  };
  return `${format(start)} → ${format(end)}`;
}

export default function AdminPayrollPage() {
  const user = useAdminUser();
  const [periods, setPeriods] = useState<PayrollPeriod[]>([]);
  const [records, setRecords] = useState<PayrollRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [periodsLoading, setPeriodsLoading] = useState(true);
  const [recordsLoading, setRecordsLoading] = useState(false);
  const [actionKey, setActionKey] = useState<string | null>(null);
  const [readiness, setReadiness] = useState<PayrollReadiness | null>(null);
  const [closing, setClosing] = useState<PayrollPeriod | null>(null);
  const [closingSummary, setClosingSummary] = useState<PayrollSummary | null>(null);
  const [closingReadiness, setClosingReadiness] = useState<PayrollReadiness | null>(null);
  const [closingLoading, setClosingLoading] = useState(false);

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: "", start_date: "", end_date: "", period_kind: "MONTHLY" as "MONTHLY" | "FIRST_HALF" | "SECOND_HALF", payroll_month: "" });

  const [adjustingId, setAdjustingId] = useState<string | null>(null);
  const [adjustAmount, setAdjustAmount] = useState("");
  const [adjustNotes, setAdjustNotes] = useState("");
  const [rectifyingId, setRectifyingId] = useState<string | null>(null);
  const [rectificationReason, setRectificationReason] = useState("");
  const [rectificationError, setRectificationError] = useState<string | null>(null);
  const rectificationInputRef = useRef<HTMLTextAreaElement>(null);
  const rectificationTriggerRef = useRef<HTMLButtonElement | null>(null);
  const { success } = useNotifications();

  const canManage = user ? MANAGE_ROLES.includes(user.role) : false;
  const recordsPagination = useTablePagination(records, `${selectedId ?? ""}:${records.length}`);

  const load = useCallback(async () => {
    try {
      if (!canManage) return;
      setPeriods(await payrollApi.periods());
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Error de conexión con el servidor");
    } finally {
      setPeriodsLoading(false);
    }
  }, [canManage]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (rectifyingId) rectificationInputRef.current?.focus();
  }, [rectifyingId]);

  const selected = periods.find((p) => p.id === selectedId) ?? null;
  // El paso resaltado refleja el estado real: preparar si algo está abierto,
  // revisar si ya se calculó, consultar cuando todo está cerrado.
  const activeStep: number = periods.length === 0
    ? 1
    : periods.some((period) => period.status === "OPEN")
      ? 1
      : periods.some((period) => period.status === "CALCULATED")
        ? 2
        : 4;
  // Los pasos anteriores al actual se marcan como completados: el recorrido
  // muestra dónde está la persona, no solo un paso activo aislado.
  const stepClass = (step: number) =>
    `flow-step${activeStep === step ? " is-active" : activeStep > step ? " is-done" : ""}`;

  async function loadRecords(periodId: string) {
    setRecordsLoading(true);
    setError(null);
    try {
      const [list, recs] = await Promise.all([payrollApi.periods(), payrollApi.records(periodId)]);
      setPeriods(list);
      setRecords(recs);
      setSelectedId(periodId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudieron cargar los registros");
    } finally {
      setRecordsLoading(false);
    }
  }

  async function handleCreatePeriod(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setActionKey("create");
    setError(null);
    try {
      const [year, month] = form.payroll_month.split("-").map(Number);
      await payrollApi.createPeriod(
        form.period_kind === "MONTHLY"
          ? { name: form.name, start_date: form.start_date, end_date: form.end_date, period_kind: form.period_kind }
          : { name: form.name || undefined, year, month, period_kind: form.period_kind },
      );
      setShowForm(false);
      setForm({ name: "", start_date: "", end_date: "", period_kind: "MONTHLY", payroll_month: "" });
      setPeriods(await payrollApi.periods());
      success("Periodo de pago creado.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo crear el periodo");
    } finally {
      setBusy(false);
      setActionKey(null);
    }
  }

  async function handleCalculate(periodId: string) {
    setBusy(true);
    setActionKey(`calculate:${periodId}`);
    setError(null);
    try {
      await payrollApi.calculate(periodId);
      await loadRecords(periodId);
      success("Cálculo de pago actualizado.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo calcular");
    } finally {
      setBusy(false);
      setActionKey(null);
    }
  }

  async function handleSaveAdjustment(recordId: string) {
    setBusy(true);
    setActionKey(`adjust:${recordId}`);
    setError(null);
    try {
      const reason = adjustNotes.trim();
      if (reason.length < 3) {
        setError("El motivo debe tener al menos 3 caracteres");
        return;
      }
      await payrollApi.setAdjustment(recordId, adjustAmount || "0.00", reason);
      setAdjustingId(null);
      setAdjustAmount("");
      setAdjustNotes("");
      if (selectedId) await loadRecords(selectedId);
      success("Ajuste manual guardado.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo ajustar");
    } finally {
      setBusy(false);
      setActionKey(null);
    }
  }

  async function handleConfirm(periodId: string) {
    setBusy(true);
    setActionKey(`close:${periodId}`);
    setError(null);
    try {
      const check = await payrollApi.readiness(periodId);
      setReadiness(check);
      if (!check.ready) {
        setError(`No se puede cerrar: ${check.blockers.length} bloqueo(s) pendiente(s)`);
        return;
      }
      await payrollApi.confirm(periodId);
      setPeriods(await payrollApi.periods());
      success("Periodo confirmado y cerrado.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo confirmar");
    } finally {
      setBusy(false);
      setActionKey(null);
    }
  }

  async function handleReadiness(periodId: string) {
    setBusy(true);
    setActionKey(`validate:${periodId}`);
    setError(null);
    try {
      setReadiness(await payrollApi.readiness(periodId));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo validar el periodo");
    } finally {
      setBusy(false);
      setActionKey(null);
    }
  }

  async function openCloseDialog(period: PayrollPeriod) {
    setClosing(period);
    setClosingSummary(null);
    setClosingReadiness(null);
    setClosingLoading(true);
    setError(null);
    try {
      const [check, summary] = await Promise.all([
        payrollApi.readiness(period.id),
        payrollApi.summary(period.id),
      ]);
      setClosingReadiness(check);
      setClosingSummary(summary);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo revisar el periodo antes de cerrar");
    } finally {
      setClosingLoading(false);
    }
  }

  function closeCloseDialog() {
    if (busy) return;
    setClosing(null);
    setClosingSummary(null);
    setClosingReadiness(null);
  }

  async function confirmClose() {
    if (!closing) return;
    await handleConfirm(closing.id);
    setClosing(null);
    setClosingSummary(null);
    setClosingReadiness(null);
  }

  function closeRectification() {
    if (busy) return;
    setRectifyingId(null);
    setRectificationReason("");
    setRectificationError(null);
    window.requestAnimationFrame(() => rectificationTriggerRef.current?.focus());
  }

  async function handleRectification(periodId: string) {
    const reason = rectificationReason.trim();
    if (reason.length < 3) {
      setRectificationError("Indica un motivo de al menos 3 caracteres.");
      return;
    }
    setBusy(true);
    setActionKey(`rectify:${periodId}`);
    try {
      await payrollApi.rectify(periodId, reason);
      setPeriods(await payrollApi.periods());
      setRectifyingId(null);
      setRectificationReason("");
      setRectificationError(null);
      window.requestAnimationFrame(() => rectificationTriggerRef.current?.focus());
      success("Rectificación creada como nueva versión.");
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "No se pudo crear la rectificación";
      setRectificationError(message);
      setError(message);
    } finally {
      setBusy(false);
      setActionKey(null);
    }
  }

  return (
    <AdminShell
      title="Planilla del periodo"
      subtitle="Prepara el cálculo, revísalo y ciérralo. Al cerrar, el periodo queda bloqueado y solo se puede rectificar."
    >
      {!canManage && (
        <p className="alert alert-error" role="alert">
          <Alert size={15} style={{ marginTop: 2, flexShrink: 0 }} />
          Solo administradores y jefes pueden ver el cálculo de pago.
        </p>
      )}

      {canManage && (
        <ol className="flow-steps" aria-label="Pasos para cerrar la planilla">
          <li className={stepClass(1)}>
            <span className="flow-step-index">1</span>
            <span className="flow-step-copy"><strong>Preparar</strong><small>Crea el periodo y calcula</small></span>
          </li>
          <li className={stepClass(2)}>
            <span className="flow-step-index">2</span>
            <span className="flow-step-copy"><strong>Revisar</strong><small>Ajusta con un motivo</small></span>
          </li>
          <li className={stepClass(3)}>
            <span className="flow-step-index">3</span>
            <span className="flow-step-copy"><strong>Cerrar</strong><small>Valida y confirma</small></span>
          </li>
          <li className={stepClass(4)}>
            <span className="flow-step-index">4</span>
            <span className="flow-step-copy"><strong>Consultar</strong><small><Link href="/admin/salaries">Ver sueldos</Link></small></span>
          </li>
        </ol>
      )}

      <div className="toolbar">
        <span className="spacer" />
        {canManage && (periods.length > 0 || showForm) && (
          <button className="btn btn-outline" onClick={() => setShowForm((v) => !v)}>
            {showForm ? (
              <>
                <X size={15} /> Cancelar
              </>
            ) : (
              <>
                <Plus size={15} /> Nuevo periodo
              </>
            )}
          </button>
        )}
      </div>

      {error && (
        <p className="alert alert-error" role="alert">
          <Alert size={15} style={{ marginTop: 2, flexShrink: 0 }} />
          {error}
        </p>
      )}

      {readiness && (
        <div className={`alert ${readiness.ready ? "alert-success" : "alert-error"}`} role="status">
          <Alert size={15} style={{ marginTop: 2, flexShrink: 0 }} />
          <span>
            {readiness.ready
              ? `Periodo listo para cerrar${readiness.warnings.length ? `, con ${readiness.warnings.length} advertencia(s)` : ""}.`
              : readiness.blockers.map((issue) => issue.message).join(" · ")}
          </span>
        </div>
      )}

      {canManage && showForm && (
        <form onSubmit={handleCreatePeriod} className="card card-pad" style={{ marginBottom: "1.1rem" }}>
          <div style={{ display: "grid", gap: "0.8rem", gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))" }}>
            <div>
              <label className="label">Nombre</label>
              <input type="text" className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required={form.period_kind === "MONTHLY"} placeholder="Agosto 2026" />
            </div>
            <div>
              <label className="label">Tipo de liquidación</label>
              <select className="input" value={form.period_kind} onChange={(e) => setForm({ ...form, period_kind: e.target.value as typeof form.period_kind })}>
                <option value="MONTHLY">Mes completo</option>
                <option value="FIRST_HALF">Primera quincena</option>
                <option value="SECOND_HALF">Segunda quincena</option>
              </select>
            </div>
            {form.period_kind !== "MONTHLY" && (
              <div>
                <label className="label">Mes de liquidación</label>
                <input type="month" className="input" value={form.payroll_month} onChange={(e) => setForm({ ...form, payroll_month: e.target.value })} required />
              </div>
            )}
            {form.period_kind === "MONTHLY" && <>
            <div>
              <label className="label">Desde</label>
              <DateField value={form.start_date} onChange={(v) => setForm({ ...form, start_date: v })} required placeholder="Seleccionar" />
            </div>
            <div>
              <label className="label">Hasta</label>
              <DateField value={form.end_date} onChange={(v) => setForm({ ...form, end_date: v })} required placeholder="Seleccionar" />
            </div>
            </>}
            <div style={{ display: "flex", alignItems: "flex-end" }}>
              <button type="submit" className="btn btn-primary" disabled={busy}>
                {actionKey === "create" ? <Spinner /> : <Plus size={15} />}
                {actionKey === "create" ? "Creando periodo…" : "Crear periodo"}
              </button>
            </div>
          </div>
        </form>
      )}

      <div style={{ display: "grid", gap: "0.9rem", gridTemplateColumns: "repeat(auto-fill,minmax(250px,1fr))", marginBottom: "1.3rem" }}>
        {!periodsLoading && periods.length === 0 && (
          <div className="empty-state card card-pad" style={{ gridColumn: "1 / -1" }}>
            <Receipt size={28} />
            <div>
              <h3>Aún no hay periodos de pago</h3>
              <p>Crea el primero para calcular el tiempo trabajado y el monto estimado.</p>
            </div>
            <button className="btn btn-primary btn-sm" type="button" onClick={() => setShowForm(true)}>
              <Plus size={15} /> Crear primer periodo
            </button>
          </div>
        )}
        {periods.map((period) => (
          <div key={period.id} className={`card card-pad period-card${selectedId === period.id ? " is-selected" : ""}`}>
            <div className="period-card-head">
              <p className="period-card-name">{period.name}</p>
              {period.status === "CLOSED" ? (
                <span className="badge badge-neutral">Cerrado</span>
              ) : period.status === "CALCULATED" ? (
                <span className="badge badge-blue">Calculado</span>
              ) : (
                <span className="badge badge-amber">Abierto</span>
              )}
            </div>
            <p className="period-card-range">{formatRange(period.start_date, period.end_date)} · versión {period.version}</p>
            <p className="period-card-hint">
              {period.status === "OPEN"
                ? "Aún no se calcula. Al calcular se estima el pago con la asistencia y los ajustes del periodo."
                : period.status === "CALCULATED"
                  ? "Listo para revisar y cerrar. Revisa los registros y ajusta lo necesario antes de confirmar."
                  : "Cerrado y bloqueado. Si necesitas cambiar algo, crea una rectificación."}
            </p>
            <div className="period-card-actions">
              {period.status === "OPEN" && (
                <button className="btn btn-primary btn-sm" onClick={() => handleCalculate(period.id)} disabled={busy}>
                  {actionKey === `calculate:${period.id}` && <Spinner />}
                  {actionKey === `calculate:${period.id}` ? "Calculando…" : "Calcular pago"}
                </button>
              )}
              {period.status === "CALCULATED" && (
                <button className="btn btn-green btn-sm" onClick={() => void openCloseDialog(period)} disabled={busy}>
                  {actionKey === `close:${period.id}` && <Spinner />}
                  {actionKey === `close:${period.id}` ? "Cerrando…" : "Cerrar planilla"}
                </button>
              )}
              {period.status === "CLOSED" && (
                <button className="btn btn-outline btn-sm" onClick={() => loadRecords(period.id)} disabled={busy}>
                  Ver registros
                </button>
              )}
            </div>
            <details className="period-more">
              <summary>Más acciones</summary>
              <div className="period-more-list">
                <button className="btn btn-ghost btn-sm" onClick={() => loadRecords(period.id)} disabled={busy}>
                  Ver registros
                </button>
                {period.status === "CALCULATED" && (
                  <button className="btn btn-ghost btn-sm" onClick={() => handleCalculate(period.id)} disabled={busy}>
                    {actionKey === `calculate:${period.id}` && <Spinner />}
                    {actionKey === `calculate:${period.id}` ? "Calculando…" : "Recalcular"}
                  </button>
                )}
                {period.status === "CALCULATED" && (
                  <button className="btn btn-ghost btn-sm" onClick={() => handleReadiness(period.id)} disabled={busy}>
                    {actionKey === `validate:${period.id}` && <Spinner />}
                    {actionKey === `validate:${period.id}` ? "Validando…" : "Validar cierre"}
                  </button>
                )}
                {period.status === "CLOSED" && (
                  <button className="btn btn-ghost btn-sm" onClick={(event) => { rectificationTriggerRef.current = event.currentTarget; setRectifyingId(period.id); setRectificationReason(""); setRectificationError(null); }} disabled={busy}>
                    {actionKey === `rectify:${period.id}` && <Spinner />}
                    {actionKey === `rectify:${period.id}` ? "Creando…" : "Rectificar"}
                  </button>
                )}
              </div>
            </details>
          </div>
        ))}
      </div>

      {rectifyingId && (
        <AppDialog labelledBy="rectification-title" onClose={closeRectification} dismissible={!busy}>
          <form onSubmit={(event) => { event.preventDefault(); void handleRectification(rectifyingId); }}>
            <h2 id="rectification-title" className="card-title">Rectificar periodo cerrado</h2>
            <p className="card-sub">Indica el motivo. Se conservará el historial y se abrirá una nueva versión.</p>
            <label className="label" htmlFor="rectification-reason">Motivo de la rectificación</label>
            <textarea id="rectification-reason" data-autofocus ref={rectificationInputRef} className="input" value={rectificationReason} onChange={(event) => setRectificationReason(event.target.value)} minLength={3} required rows={3} />
            {rectificationError && <p className="alert alert-error" role="alert">{rectificationError}</p>}
            <div className="app-dialog-actions">
              <AppDialogCloseButton className="btn btn-outline" disabled={busy}>Cancelar</AppDialogCloseButton>
              <button className="btn btn-primary" type="submit" disabled={busy || rectificationReason.trim().length < 3} aria-busy={busy}>{busy && <Spinner />}{busy ? "Creando rectificación…" : "Crear rectificación"}</button>
            </div>
          </form>
        </AppDialog>
      )}

      {closing && (
        <AppDialog labelledBy="close-payroll-title" describedBy="close-payroll-description" onClose={closeCloseDialog} dismissible={!busy} className="payroll-close-dialog">
          <h2 id="close-payroll-title" className="card-title">¿Cerrar la planilla de {closing.name}?</h2>
          <p id="close-payroll-description" className="card-sub">Revisa el resumen antes de confirmar. Al cerrar, este periodo queda bloqueado.</p>
          {closingLoading ? (
            <p className="muted" role="status"><Spinner /> Revisando el periodo…</p>
          ) : (
            <>
              <dl className="payroll-close-summary">
                <div><dt>Periodo</dt><dd>{formatRange(closing.start_date, closing.end_date)}</dd></div>
                <div><dt>Empleados incluidos</dt><dd>{closingSummary ? closingSummary.employee_count : "—"}</dd></div>
                <div><dt>Monto estimado</dt><dd>{closingSummary ? formatMoney(closingSummary.total) : "—"}</dd></div>
                <div><dt>Incidencias pendientes</dt><dd>{closingReadiness ? closingReadiness.blockers.length : "—"}</dd></div>
              </dl>
              {closingReadiness && !closingReadiness.ready && (
                <div className="alert alert-error" role="alert">
                  <Alert size={15} style={{ marginTop: 2, flexShrink: 0 }} />
                  <span>No se puede cerrar todavía: {closingReadiness.blockers.map((issue) => issue.message).join(" · ")}</span>
                </div>
              )}
              {closingReadiness && closingReadiness.ready && closingReadiness.warnings.length > 0 && (
                <div className="alert" role="status">
                  <Alert size={15} style={{ marginTop: 2, flexShrink: 0 }} />
                  <span>{closingReadiness.warnings.length} advertencia(s): {closingReadiness.warnings.map((issue) => issue.message).join(" · ")}</span>
                </div>
              )}
              <p className="payroll-close-lock">
                Al cerrar, este periodo no se podrá editar. Si más adelante necesitas un cambio, se creará una nueva versión (rectificación).
              </p>
            </>
          )}
          <div className="app-dialog-actions">
            <AppDialogCloseButton className="btn btn-outline" disabled={busy}>Cancelar</AppDialogCloseButton>
            <button
              className="btn btn-green"
              type="button"
              disabled={busy || closingLoading || !closingReadiness?.ready}
              aria-busy={busy}
              onClick={() => void confirmClose()}
            >
              {busy && <Spinner />}
              {busy ? "Cerrando…" : "Cerrar planilla"}
            </button>
          </div>
        </AppDialog>
      )}

      {selected && (
        <div className="card">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0.85rem 1.1rem", borderBottom: "1px solid var(--border)" }}>
            <p style={{ fontWeight: 600 }}>
              Registros de {selected.name}
              <span className="muted" style={{ marginLeft: "0.5rem", fontSize: "0.76rem", fontWeight: 400 }}>
                {records.length} empleado(s) con sueldo en el periodo
              </span>
            </p>
            {selected.status !== "CLOSED" && (
              <span className="muted" style={{ fontSize: "0.76rem" }}>
                Los montos son una estimación hasta cerrar el periodo.
              </span>
            )}
          </div>
          <div className="table-wrap salaries-responsive-wrap" style={{ border: "none", borderRadius: 0 }} aria-busy={recordsLoading}>
            <table className="table salaries-responsive-table">
              <thead>
                <tr>
                  <th>Empleado</th>
                  <th style={{ textAlign: "right" }}>Sueldo</th>
                  <th style={{ textAlign: "right" }}>Trabajado</th>
                  <th style={{ textAlign: "right" }}>Esperado</th>
                  <th style={{ textAlign: "right" }}>Horas extra</th>
                  <th style={{ textAlign: "right" }}>Ajuste del periodo</th>
                  <th style={{ textAlign: "right" }}>Total</th>
                </tr>
              </thead>
              <tbody>
                {records.length === 0 && !recordsLoading && (
                  <tr>
                    <td colSpan={7} className="empty">
                      <Receipt size={26} />
                      Sin registros todavía. Usa «Calcular pago» para estimar el pago del periodo.
                    </td>
                  </tr>
                )}
                {recordsLoading && <TableSkeleton rows={4} cols={7} />}
                {recordsPagination.pageItems.map((record) => (
                  <tr key={record.id} style={record.payable === false ? { opacity: 0.65 } : undefined}>
                    <td data-label="Empleado" style={{ fontWeight: 600 }}>
                      {record.employee_name ?? "—"}
                      {record.payable === false && (
                        <div className="muted" style={{ fontWeight: 400, fontSize: "0.78rem" }}>
                          Fuera del cálculo pagable (se conserva el historial)
                        </div>
                      )}
                    </td>
                    <td className="num" data-label="Sueldo" style={{ textAlign: "right" }}>
                      {formatMoney(record.base_salary)}
                    </td>
                    <td className="num" data-label="Trabajado" style={{ textAlign: "right" }}>
                      {formatMinutes(record.worked_minutes)}
                    </td>
                    <td className="num" data-label="Jornada esperada" style={{ textAlign: "right" }}>
                      {formatMinutes(record.expected_minutes)}
                    </td>
                    <td className="num" data-label="Horas extra" style={{ textAlign: "right" }}>
                      {record.overtime_minutes > 0 ? (
                        <>
                          {formatMinutes(record.overtime_minutes)}
                          <span style={{ color: "var(--dark-green)", marginLeft: "0.3rem" }}>
                            ({formatMoney(record.overtime_amount)})
                          </span>
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="num" data-label="Ajuste del periodo" style={{ textAlign: "right" }}>
                      {adjustingId === record.id && selected.status !== "CLOSED" ? (
                        <span style={{ display: "inline-flex", gap: "0.3rem", alignItems: "center" }}>
                          <input type="number" step={0.01} className="input" style={{ width: 90, padding: "0.3rem 0.5rem" }} value={adjustAmount} onChange={(e) => setAdjustAmount(e.target.value)} />
                          <input type="text" className="input" style={{ width: 110, padding: "0.3rem 0.5rem" }} value={adjustNotes} onChange={(e) => setAdjustNotes(e.target.value)} placeholder="motivo" />
                          <button className="btn btn-primary btn-sm" onClick={() => handleSaveAdjustment(record.id)} disabled={busy || adjustNotes.trim().length < 3}>
                            {actionKey === `adjust:${record.id}` && <Spinner />}
                            {actionKey === `adjust:${record.id}` ? "Guardando ajuste…" : "Guardar"}
                          </button>
                          <button className="btn btn-ghost btn-sm" onClick={() => setAdjustingId(null)} aria-label="Cancelar">
                            <X size={13} />
                          </button>
                        </span>
                      ) : (
                        <>
                          {Number(record.manual_adjustment) !== 0 ? (
                            <span style={{ color: Number(record.manual_adjustment) < 0 ? "var(--red)" : "var(--dark-green)" }}>
                              {formatMoney(record.manual_adjustment)}
                            </span>
                          ) : (
                            <span className="muted">0.00</span>
                          )}
                          {selected.status !== "CLOSED" && record.payable !== false && (
                            <button
                              className="btn btn-ghost btn-sm"
                              style={{ marginLeft: "0.4rem" }}
                              onClick={() => {
                                setAdjustingId(record.id);
                                setAdjustAmount(record.manual_adjustment);
                                setAdjustNotes(record.notes ?? "");
                              }}
                            >
                              <Pencil size={12} style={{ verticalAlign: "-2px" }} /> Ajustar
                            </button>
                          )}
                        </>
                      )}
                    </td>
                    <td className="num" data-label="Total" style={{ textAlign: "right", fontWeight: 700 }}>
                      {formatMoney(record.total)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <TablePagination {...recordsPagination} />
        </div>
      )}
    </AdminShell>
  );
}
