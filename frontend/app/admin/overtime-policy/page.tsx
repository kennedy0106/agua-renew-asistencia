"use client";

import { useCallback, useEffect, useState } from "react";
import AdminShell from "@/components/AdminShell";
import DateField from "@/components/DateField";
import { Alert, Check, Plus, X } from "@/components/Icons";
import { ApiError, OvertimePolicy, overtimePolicyApi } from "@/lib/api";
import { TableSkeleton } from "@/components/Loading";
import { TablePagination, useTablePagination } from "@/components/Pagination";

function dayAfter(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00`);
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

export default function OvertimePolicyPage() {
  const [active, setActive] = useState<OvertimePolicy | null>(null);
  const [history, setHistory] = useState<OvertimePolicy[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    effective_from: "",
    first_two_hours_rate: "25.00",
    additional_hours_rate: "35.00",
    reason: "",
  });
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [a, h] = await Promise.all([overtimePolicyApi.active(), overtimePolicyApi.history()]);
      setActive(a);
      setHistory(h);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo cargar la política");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);
  const pagination = useTablePagination(history, history.length);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await overtimePolicyApi.create({
        effective_from: form.effective_from,
        first_two_hours_rate: form.first_two_hours_rate,
        additional_hours_rate: form.additional_hours_rate,
        reason: form.reason,
      });
      setShowForm(false);
      setForm({
        effective_from: "",
        first_two_hours_rate: "25.00",
        additional_hours_rate: "35.00",
        reason: "",
      });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo guardar la política");
    } finally {
      setSaving(false);
    }
  }

  return (
    <AdminShell
      title="Horas extra"
      subtitle="Política general de la empresa (mínimos legales: 25% / 35%)"
    >
      {error && (
        <p className="alert alert-error" role="alert">
          <Alert size={15} style={{ marginTop: 2, flexShrink: 0 }} />
          {error}
        </p>
      )}

      <div className="card card-pad" style={{ marginBottom: "1.1rem" }}>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: "0.6rem", marginBottom: "0.9rem" }}>
          <div>
            <h2 className="card-title">Política general</h2>
            <p className="card-sub">
              Aplica a todos los empleados sin configuración personalizada. Los porcentajes son un mínimo legal, no un tope.
            </p>
          </div>
          <button
            className="btn btn-outline btn-sm"
            onClick={() => {
              if (!showForm && active) {
                setForm({
                  effective_from: dayAfter(active.effective_from),
                  first_two_hours_rate: active.first_two_hours_rate,
                  additional_hours_rate: active.additional_hours_rate,
                  reason: "",
                });
              }
              setShowForm((v) => !v);
            }}
          >
            {showForm ? (
              <>
                <X size={14} /> Cancelar
              </>
            ) : (
              <>
                <Plus size={14} /> Nueva política
              </>
            )}
          </button>
        </div>

        {showForm && (
          <form onSubmit={handleSubmit} className="card" style={{ padding: "0.9rem", marginBottom: "1rem", background: "var(--gray-100)", boxShadow: "none" }}>
            <div style={{ display: "grid", gap: "0.7rem", gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))" }}>
              <div>
                <label className="label">Vigente desde</label>
                <DateField value={form.effective_from} onChange={(v) => setForm({ ...form, effective_from: v })} required placeholder="Seleccionar" />
              </div>
              <div>
                <label className="label">Primeras 2 h (%)</label>
                <input
                  type="number"
                  min={25}
                  step={0.01}
                  className="input"
                  value={form.first_two_hours_rate}
                  onChange={(e) => setForm({ ...form, first_two_hours_rate: e.target.value })}
                  required
                />
                <p style={{ fontSize: "0.68rem", color: "var(--muted)", margin: "0.2rem 0 0" }}>Mínimo 25%</p>
              </div>
              <div>
                <label className="label">Tercera hora en adelante (%)</label>
                <input
                  type="number"
                  min={35}
                  step={0.01}
                  className="input"
                  value={form.additional_hours_rate}
                  onChange={(e) => setForm({ ...form, additional_hours_rate: e.target.value })}
                  required
                />
                <p style={{ fontSize: "0.68rem", color: "var(--muted)", margin: "0.2rem 0 0" }}>Mínimo 35%</p>
              </div>
              <div>
                <label className="label">Motivo del cambio</label>
                <input
                  type="text"
                  className="input"
                  value={form.reason}
                  onChange={(e) => setForm({ ...form, reason: e.target.value })}
                  required
                  minLength={3}
                  placeholder="Ej. Nueva política de pago de horas extra"
                />
              </div>
            </div>
            <button type="submit" className="btn btn-primary" style={{ marginTop: "0.8rem" }} disabled={saving || form.reason.trim().length < 3}>
              <Check size={15} />
              {saving ? "Guardando…" : "Guardar política"}
            </button>
          </form>
        )}

        {loading ? (
          <TableSkeleton rows={2} cols={4} />
        ) : active ? (
          <div className="stat-grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))" }}>
            <div className="stat-card">
              <div className="stat-label">Primeras 2 horas</div>
              <div className="stat-value" style={{ fontSize: "1.35rem" }}>{active.first_two_hours_rate}%</div>
              <div className="stat-hint">desde {active.effective_from}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Tercera hora en adelante</div>
              <div className="stat-value" style={{ fontSize: "1.35rem" }}>{active.additional_hours_rate}%</div>
              <div className="stat-hint">desde {active.effective_from}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Estado</div>
              <div className="stat-value" style={{ fontSize: "1.1rem", color: "var(--dark-green)" }}>Vigente</div>
            </div>
          </div>
        ) : (
          <p className="muted" style={{ fontSize: "0.85rem" }}>
            Aún no hay política configurada. Se usarán los mínimos legales (25% / 35%) hasta que definas una.
          </p>
        )}
      </div>

      {history.length > 0 && (
        <div className="card card-pad">
          <h2 className="card-title" style={{ marginBottom: "0.8rem" }}>Historial de políticas</h2>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Vigente desde</th>
                  <th>Primeras 2 h</th>
                  <th>Tercera en adelante</th>
                  <th>Hasta</th>
                  <th>Motivo</th>
                </tr>
              </thead>
              <tbody>
                {pagination.pageItems.map((p) => (
                  <tr key={p.id}>
                    <td>{p.effective_from}</td>
                    <td>{p.first_two_hours_rate}%</td>
                    <td>{p.additional_hours_rate}%</td>
                    <td>{p.effective_to ?? "vigente"}</td>
                    <td>{p.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <TablePagination {...pagination} />
        </div>
      )}
    </AdminShell>
  );
}
