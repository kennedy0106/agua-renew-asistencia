"use client";

import { useCallback, useEffect, useState } from "react";
import AdminShell from "@/components/AdminShell";
import { useAdminUser } from "@/components/AdminSession";
import DateField from "@/components/DateField";
import { Alert, Pencil, Plus, Receipt, X } from "@/components/Icons";
import { TableSkeleton } from "@/components/Loading";
import { ApiError, PayrollPeriod, PayrollRecord, payrollApi } from "@/lib/api";

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
  const user = useAdminUser();
  const [periods, setPeriods] = useState<PayrollPeriod[]>([]);
  const [records, setRecords] = useState<PayrollRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: "", start_date: "", end_date: "" });

  const [adjustingId, setAdjustingId] = useState<string | null>(null);
  const [adjustAmount, setAdjustAmount] = useState("");
  const [adjustNotes, setAdjustNotes] = useState("");

  const canManage = user ? MANAGE_ROLES.includes(user.role) : false;

  const load = useCallback(async () => {
    try {
      if (!canManage) return;
      setPeriods(await payrollApi.periods());
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Error de conexión con el servidor");
    } finally {
      setLoading(false);
    }
  }, [canManage]);

  useEffect(() => {
    load();
  }, [load]);

  const selected = periods.find((p) => p.id === selectedId) ?? null;

  async function loadRecords(periodId: string) {
    setBusy(true);
    setError(null);
    try {
      const [list, recs] = await Promise.all([payrollApi.periods(), payrollApi.records(periodId)]);
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

  return (
    <AdminShell title="Planilla" subtitle="Calcular → revisar → ajustar con motivo → cerrar (inmutable)">
      {!canManage && (
        <p className="alert alert-error" role="alert">
          <Alert size={15} style={{ marginTop: 2, flexShrink: 0 }} />
          Solo administradores y jefes pueden ver la planilla.
        </p>
      )}

      <div className="toolbar">
        <span className="spacer" />
        {canManage && (
          <button className="btn btn-primary" onClick={() => setShowForm((v) => !v)}>
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

      {canManage && showForm && (
        <form onSubmit={handleCreatePeriod} className="card card-pad" style={{ marginBottom: "1.1rem" }}>
          <div style={{ display: "grid", gap: "0.8rem", gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))" }}>
            <div>
              <label className="label">Nombre</label>
              <input type="text" className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required placeholder="Agosto 2026" />
            </div>
            <div>
              <label className="label">Desde</label>
              <DateField value={form.start_date} onChange={(v) => setForm({ ...form, start_date: v })} required placeholder="Seleccionar" />
            </div>
            <div>
              <label className="label">Hasta</label>
              <DateField value={form.end_date} onChange={(v) => setForm({ ...form, end_date: v })} required placeholder="Seleccionar" />
            </div>
            <div style={{ display: "flex", alignItems: "flex-end" }}>
              <button type="submit" className="btn btn-primary" disabled={busy}>
                <Plus size={15} />
                Crear periodo
              </button>
            </div>
          </div>
        </form>
      )}

      <div style={{ display: "grid", gap: "0.9rem", gridTemplateColumns: "repeat(auto-fill,minmax(250px,1fr))", marginBottom: "1.3rem" }}>
        {periods.length === 0 && (
          <p className="muted" style={{ fontSize: "0.85rem" }}>
            Sin periodos. Crea el primero.
          </p>
        )}
        {periods.map((period) => (
          <div
            key={period.id}
            className="card card-pad"
            style={selectedId === period.id ? { borderColor: "var(--secondary-blue)", boxShadow: "0 0 0 3px rgba(0,123,255,0.12)" } : undefined}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.5rem" }}>
              <p style={{ fontWeight: 600 }}>{period.name}</p>
              {period.status === "CLOSED" ? (
                <span className="badge badge-neutral">Cerrado</span>
              ) : period.status === "CALCULATED" ? (
                <span className="badge badge-blue">Calculado</span>
              ) : (
                <span className="badge badge-amber">Abierto</span>
              )}
            </div>
            <p className="muted" style={{ fontSize: "0.76rem", marginTop: "0.2rem" }}>
              {period.start_date} → {period.end_date}
            </p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem", marginTop: "0.7rem" }}>
              <button className="btn btn-ghost btn-sm" onClick={() => loadRecords(period.id)} disabled={busy}>
                Registros
              </button>
              {period.status !== "CLOSED" && (
                <button className="btn btn-primary btn-sm" onClick={() => handleCalculate(period.id)} disabled={busy}>
                  {period.status === "OPEN" ? "Calcular" : "Recalcular"}
                </button>
              )}
              {period.status === "CALCULATED" && (
                <button className="btn btn-green btn-sm" onClick={() => handleConfirm(period.id)} disabled={busy}>
                  Confirmar y cerrar
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

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
                Los totales son provisionales hasta cerrar el periodo.
              </span>
            )}
          </div>
          <div className="table-wrap" style={{ border: "none", borderRadius: 0 }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Empleado</th>
                  <th style={{ textAlign: "right" }}>Sueldo</th>
                  <th style={{ textAlign: "right" }}>Trabajado</th>
                  <th style={{ textAlign: "right" }}>Esperado</th>
                  <th style={{ textAlign: "right" }}>Horas extra</th>
                  <th style={{ textAlign: "right" }}>Ajuste manual</th>
                  <th style={{ textAlign: "right" }}>Total</th>
                </tr>
              </thead>
              <tbody>
                {records.length === 0 && !busy && (
                  <tr>
                    <td colSpan={7} className="empty">
                      <Receipt size={26} />
                      Sin registros. Usa «Calcular» para generar el preview.
                    </td>
                  </tr>
                )}
                {busy && <TableSkeleton rows={4} cols={7} />}
                {records.map((record) => (
                  <tr key={record.id}>
                    <td style={{ fontWeight: 600 }}>{record.employee_name ?? "—"}</td>
                    <td className="num" style={{ textAlign: "right" }}>
                      {formatMoney(record.base_salary)}
                    </td>
                    <td className="num" style={{ textAlign: "right" }}>
                      {formatMinutes(record.worked_minutes)}
                    </td>
                    <td className="num" style={{ textAlign: "right" }}>
                      {formatMinutes(record.expected_minutes)}
                    </td>
                    <td className="num" style={{ textAlign: "right" }}>
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
                    <td className="num" style={{ textAlign: "right" }}>
                      {adjustingId === record.id && selected.status !== "CLOSED" ? (
                        <span style={{ display: "inline-flex", gap: "0.3rem", alignItems: "center" }}>
                          <input type="number" step={0.01} className="input" style={{ width: 90, padding: "0.3rem 0.5rem" }} value={adjustAmount} onChange={(e) => setAdjustAmount(e.target.value)} />
                          <input type="text" className="input" style={{ width: 110, padding: "0.3rem 0.5rem" }} value={adjustNotes} onChange={(e) => setAdjustNotes(e.target.value)} placeholder="motivo" />
                          <button className="btn btn-primary btn-sm" onClick={() => handleSaveAdjustment(record.id)} disabled={busy}>
                            OK
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
                          {selected.status !== "CLOSED" && (
                            <button
                              className="link-btn"
                              style={{ marginLeft: "0.4rem", fontSize: "0.74rem" }}
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
                    <td className="num" style={{ textAlign: "right", fontWeight: 700 }}>
                      {formatMoney(record.total)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </AdminShell>
  );
}
