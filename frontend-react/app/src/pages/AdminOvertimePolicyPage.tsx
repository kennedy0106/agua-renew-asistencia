
import { useCallback, useEffect, useState } from "react";
import AdminShell from "@/components/AdminShell";
import DateField from "@/components/DateField";
import { Alert, Check, Plus, X } from "@/components/Icons";
import { ApiError, OvertimePolicy, overtimePolicyApi } from "@/lib/api";
import { Spinner, TableSkeleton } from "@/components/Loading";
import { TablePagination, useTablePagination } from "@/components/Pagination";

function dayAfter(isoDate: string): string {
  const parts = isoDate.split("-").map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) {
    return isoDate;
  }
  const [year, month, day] = parts;
  // Usar componentes UTC puros evita desfases por zona horaria local
  const d = new Date(Date.UTC(year, month - 1, day + 1));
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
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

  const firstRateNum = Number(form.first_two_hours_rate);
  const addRateNum = Number(form.additional_hours_rate);
  const isEffectiveFromValid = Boolean(form.effective_from && form.effective_from.trim().length > 0);
  const isFirstRateValid = !isNaN(firstRateNum) && firstRateNum >= 25;
  const isAddRateValid = !isNaN(addRateNum) && addRateNum >= 35;
  const isReasonValid = form.reason.trim().length >= 3;
  const isFormValid = isEffectiveFromValid && isFirstRateValid && isAddRateValid && isReasonValid;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!isFormValid || saving) return;
    setSaving(true);
    setError(null);
    try {
      await overtimePolicyApi.create({
        effective_from: form.effective_from,
        first_two_hours_rate: form.first_two_hours_rate,
        additional_hours_rate: form.additional_hours_rate,
        reason: form.reason.trim(),
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

  function handleToggleForm() {
    if (!showForm && active) {
      setForm({
        effective_from: dayAfter(active.effective_from),
        first_two_hours_rate: active.first_two_hours_rate,
        additional_hours_rate: active.additional_hours_rate,
        reason: "",
      });
    }
    setShowForm((v) => !v);
  }

  return (
    <AdminShell
      title="Reglas de horas extra"
      subtitle="Cómo se calcula el recargo por horas extra. Los porcentajes son mínimos legales (25% / 35%), no un tope."
    >
      {error && (
        <div
          className="alert alert-error overtime-alert-error"
          role="alert"
        >
          <div className="overtime-alert-body">
            <Alert size={16} className="overtime-alert-icon" aria-hidden="true" />
            <span>{error}</span>
          </div>
          <button
            type="button"
            className="btn btn-outline btn-sm overtime-retry-btn"
            onClick={() => void load()}
            disabled={loading}
            aria-label="Reintentar carga de políticas de horas extra"
          >
            Reintentar
          </button>
        </div>
      )}

      <div className="card card-pad overtime-general-policy-card">
        <div className="overtime-policy-header">
          <div>
            <h2 className="card-title">Política general</h2>
            <p className="card-sub">
              Aplica a todos los empleados sin configuración personalizada. Los porcentajes son un mínimo legal, no un tope.
            </p>
          </div>
          <button
            type="button"
            className="btn btn-outline btn-sm overtime-toggle-form-btn"
            onClick={handleToggleForm}
            aria-expanded={showForm}
            aria-controls="overtime-policy-form"
          >
            {showForm ? (
              <>
                <X size={14} aria-hidden="true" /> Cancelar
              </>
            ) : (
              <>
                <Plus size={14} aria-hidden="true" /> Nueva política
              </>
            )}
          </button>
        </div>

        {showForm && (
          <form
            id="overtime-policy-form"
            onSubmit={handleSubmit}
            className="overtime-policy-form"
            aria-label="Formulario para registrar nueva política de horas extra"
          >
            <div className="overtime-form-grid">
              <div className="overtime-field-group">
                <label id="overtime-effective-from-label" className="label">
                  Vigente desde <span className="overtime-required-mark" aria-hidden="true">*</span>
                </label>
                <DateField
                  value={form.effective_from}
                  onChange={(v) => setForm((prev) => ({ ...prev, effective_from: v }))}
                  required
                  placeholder="Seleccionar fecha"
                  aria-label="Fecha de inicio de vigencia (requerido)"
                />
                <p id="overtime-effective-from-hint" className="field-hint overtime-field-hint">
                  Fecha requerida para nueva vigencia
                </p>
              </div>

              <div className="overtime-field-group">
                <label htmlFor="overtime-first-two-hours" className="label">
                  Primeras 2 h (%) <span className="overtime-required-mark" aria-hidden="true">*</span>
                </label>
                <input
                  id="overtime-first-two-hours"
                  type="number"
                  min={25}
                  step={0.01}
                  className="input"
                  value={form.first_two_hours_rate}
                  onChange={(e) => setForm((prev) => ({ ...prev, first_two_hours_rate: e.target.value }))}
                  required
                  aria-describedby="overtime-first-two-hours-hint"
                />
                <p id="overtime-first-two-hours-hint" className="field-hint overtime-field-hint">
                  Mínimo 25% (legal D.L. 728)
                </p>
              </div>

              <div className="overtime-field-group">
                <label htmlFor="overtime-additional-hours" className="label">
                  Tercera hora en adelante (%) <span className="overtime-required-mark" aria-hidden="true">*</span>
                </label>
                <input
                  id="overtime-additional-hours"
                  type="number"
                  min={35}
                  step={0.01}
                  className="input"
                  value={form.additional_hours_rate}
                  onChange={(e) => setForm((prev) => ({ ...prev, additional_hours_rate: e.target.value }))}
                  required
                  aria-describedby="overtime-additional-hours-hint"
                />
                <p id="overtime-additional-hours-hint" className="field-hint overtime-field-hint">
                  Mínimo 35% (legal D.L. 728)
                </p>
              </div>

              <div className="overtime-field-group">
                <label htmlFor="overtime-reason" className="label">
                  Motivo del cambio <span className="overtime-required-mark" aria-hidden="true">*</span>
                </label>
                <input
                  id="overtime-reason"
                  type="text"
                  className="input"
                  value={form.reason}
                  onChange={(e) => setForm((prev) => ({ ...prev, reason: e.target.value }))}
                  required
                  minLength={3}
                  placeholder="Ej. Actualización de política salarial anual"
                  aria-describedby="overtime-reason-hint"
                />
                <p id="overtime-reason-hint" className="field-hint overtime-field-hint">
                  Mínimo 3 caracteres requeridos
                </p>
              </div>
            </div>

            <div className="overtime-form-actions">
              <button
                type="submit"
                className="btn btn-primary overtime-submit-btn"
                disabled={saving || !isFormValid}
                aria-busy={saving}
              >
                {saving ? <Spinner /> : <Check size={15} aria-hidden="true" />}
                {saving ? "Guardando…" : "Guardar política"}
              </button>
              <button
                type="button"
                className="btn btn-outline overtime-cancel-btn"
                onClick={() => setShowForm(false)}
                disabled={saving}
              >
                Cancelar
              </button>
            </div>
          </form>
        )}

        {loading ? (
          <TableSkeleton rows={2} cols={4} />
        ) : active ? (
          <div className="stat-grid overtime-stat-grid">
            <div className="stat-card overtime-stat-card">
              <div className="stat-label">Primeras 2 horas</div>
              <div className="stat-value num">{active.first_two_hours_rate}%</div>
              <div className="stat-hint">Vigente desde {active.effective_from}</div>
            </div>
            <div className="stat-card overtime-stat-card">
              <div className="stat-label">Tercera hora en adelante</div>
              <div className="stat-value num">{active.additional_hours_rate}%</div>
              <div className="stat-hint">Vigente desde {active.effective_from}</div>
            </div>
            <div className="stat-card overtime-stat-card">
              <div className="stat-label">Estado</div>
              <div className="stat-value stat-value--status">
                <span className="badge badge-green">Vigente</span>
              </div>
              <div className="stat-hint">Política activa actual</div>
            </div>
          </div>
        ) : (
          <div className="overtime-empty-state">
            <p className="overtime-empty-title">
              No hay una política de horas extra configurada
            </p>
            <p className="muted overtime-empty-desc">
              Aún no hay política configurada. Se usarán los mínimos legales (25% / 35%) hasta que definas una.
            </p>
          </div>
        )}
      </div>

      <div className="card card-pad overtime-history-card">
        <div className="overtime-history-header">
          <div>
            <h2 className="card-title">Historial de políticas</h2>
            <p className="card-sub">
              Registro cronológico de configuraciones previas y vigencias aplicadas en el cálculo de sobretiempo.
            </p>
          </div>
          {history.length > 0 && (
            <span
              className="badge badge-neutral overtime-history-count"
              aria-label={`Total: ${history.length} políticas registradas`}
            >
              {history.length} {history.length === 1 ? "política" : "políticas"}
            </span>
          )}
        </div>

        {loading ? (
          <TableSkeleton rows={3} cols={5} />
        ) : history.length === 0 ? (
          <div className="overtime-history-empty">
            <p className="overtime-empty-desc">
              No hay historial de políticas registrado todavía.
            </p>
          </div>
        ) : (
          <>
            <div className="table-wrap overtime-table-wrap">
              <table className="table employee-stack-table overtime-history-table">
                <thead>
                  <tr>
                    <th scope="col">Vigente desde</th>
                    <th scope="col">Primeras 2 h</th>
                    <th scope="col">Tercera en adelante</th>
                    <th scope="col">Hasta</th>
                    <th scope="col">Motivo</th>
                  </tr>
                </thead>
                <tbody>
                  {pagination.pageItems.map((p) => (
                    <tr key={p.id} className="overtime-history-row">
                      <td data-label="Vigente desde" className="overtime-cell-effective-from">
                        {p.effective_from}
                      </td>
                      <td data-label="Primeras 2 h" className="num overtime-cell-first-two">
                        {p.first_two_hours_rate}%
                      </td>
                      <td data-label="Tercera en adelante" className="num overtime-cell-additional">
                        {p.additional_hours_rate}%
                      </td>
                      <td data-label="Hasta" className="overtime-cell-effective-to">
                        {p.effective_to ? (
                          <span className="overtime-date-to">{p.effective_to}</span>
                        ) : (
                          <span className="badge badge-green">Vigente</span>
                        )}
                      </td>
                      <td
                        data-label="Motivo"
                        className="overtime-cell-reason"
                      >
                        {p.reason}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <TablePagination {...pagination} />
          </>
        )}
      </div>
    </AdminShell>
  );
}
