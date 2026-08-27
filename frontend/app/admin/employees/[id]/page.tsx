"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import AdminShell from "@/components/AdminShell";
import { useAdminUser } from "@/components/AdminSession";
import {
  Alert,
  ArrowLeft,
  Briefcase,
  Calendar,
  Check,
  Clock,
  Coins,
  Pencil,
  Plus,
  Scale,
  User,
  X,
  Zap,
} from "@/components/Icons";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  adjustmentsApi,
  ApiError,
  Balance,
  employeesApi,
  Employee,
  HourAdjustment,
  OvertimeDetectItem,
  OvertimeValue,
  overtimeApi,
  salaryApi,
  SalaryPayload,
  SalarySetting,
  scheduleApi,
  SchedulePayload,
  WorkSchedule,
} from "@/lib/api";

const MANAGE_ROLES = ["ADMIN", "BOSS"];

type MinuteKey =
  | "monday_minutes"
  | "tuesday_minutes"
  | "wednesday_minutes"
  | "thursday_minutes"
  | "friday_minutes"
  | "saturday_minutes"
  | "sunday_minutes";

const DAYS: { key: MinuteKey; label: string }[] = [
  { key: "monday_minutes", label: "Lunes" },
  { key: "tuesday_minutes", label: "Martes" },
  { key: "wednesday_minutes", label: "Miércoles" },
  { key: "thursday_minutes", label: "Jueves" },
  { key: "friday_minutes", label: "Viernes" },
  { key: "saturday_minutes", label: "Sábado" },
  { key: "sunday_minutes", label: "Domingo" },
];

function defaultForm(): SchedulePayload {
  return {
    effective_from: "",
    monday_minutes: 480,
    tuesday_minutes: 480,
    wednesday_minutes: 480,
    thursday_minutes: 480,
    friday_minutes: 480,
    saturday_minutes: 480,
    sunday_minutes: 0,
    break_minutes: 60,
  };
}

function formatHours(minutes: number): string {
  const h = minutes / 60;
  return Number.isInteger(h) ? `${h} h` : `${h.toFixed(1)} h`;
}

function formatMoney(value: string | null): string {
  if (value === null) return "—";
  const num = Number(value);
  return `S/ ${num.toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function signedMinutes(minutes: number): string {
  const h = Math.floor(Math.abs(minutes) / 60);
  const m = Math.abs(minutes) % 60;
  const text = h === 0 ? `${m} min` : `${h} h ${m.toString().padStart(2, "0")}`;
  return minutes > 0 ? `+${text}` : minutes < 0 ? `−${text}` : "0 min";
}

const typeLabel: Record<string, string> = {
  PERMISO: "Permiso",
  RECUPERACION: "Recuperación",
  OVERTIME: "Horas extra",
  OTRO: "Otro",
};

export default function EmployeeDetailPage() {
  const params = useParams<{ id: string }>();
  const employeeId = params.id;
  const user = useAdminUser();

  const [employee, setEmployee] = useState<Employee | null>(null);
  const [schedule, setSchedule] = useState<WorkSchedule | null>(null);
  const [history, setHistory] = useState<WorkSchedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<SchedulePayload>(defaultForm());
  const [saving, setSaving] = useState(false);

  const [salary, setSalary] = useState<SalarySetting | null>(null);
  const [salaryHistory, setSalaryHistory] = useState<SalarySetting[]>([]);
  const [showSalaryForm, setShowSalaryForm] = useState(false);
  const [salaryForm, setSalaryForm] = useState<SalaryPayload>({
    effective_from: "",
    monthly_salary: "",
    overtime_enabled: false,
    overtime_method: "PERCENTAGE",
    overtime_percentage: null,
    overtime_fixed_rate: null,
  });
  const [savingSalary, setSavingSalary] = useState(false);

  const [balance, setBalance] = useState<Balance | null>(null);
  const [adjustments, setAdjustments] = useState<HourAdjustment[]>([]);
  const [showAdjForm, setShowAdjForm] = useState(false);
  const [adjForm, setAdjForm] = useState({
    adjustment_date: new Date().toISOString().slice(0, 10),
    minutes: 0,
    adjustment_type: "RECUPERACION" as HourAdjustment["adjustment_type"],
    reason: "",
  });
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [savingAdj, setSavingAdj] = useState(false);

  const [detectedDays, setDetectedDays] = useState<OvertimeDetectItem[] | null>(null);
  const [overtimeValue, setOvertimeValue] = useState<OvertimeValue | null>(null);
  const [detecting, setDetecting] = useState(false);

  const canManage = user ? MANAGE_ROLES.includes(user.role) : false;

  function monthRange(): { from: string; to: string } {
    const now = new Date();
    const from = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
    const to = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().slice(0, 10);
    return { from, to };
  }

  async function loadOvertime() {
    if (!canManage) return;
    setError(null);
    try {
      const { from, to } = monthRange();
      const [detected, value] = await Promise.all([
        overtimeApi.detect(employeeId, from, to),
        overtimeApi.value(employeeId, from, to),
      ]);
      setDetectedDays(detected);
      setOvertimeValue(value);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo consultar horas extra");
    }
  }

  async function registerOvertime(day: OvertimeDetectItem) {
    setError(null);
    try {
      await adjustmentsApi.create(employeeId, {
        adjustment_date: day.work_date,
        minutes: day.extra_minutes,
        adjustment_type: "OVERTIME",
        reason: `Horas extra del ${day.work_date} (${Math.round(day.extra_minutes / 60)} h)`,
      });
      await Promise.all([loadOvertime(), loadAdjustmentsAndBalance()]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo registrar la hora extra");
    }
  }

  async function loadAdjustmentsAndBalance() {
    const [bal, adj] = await Promise.all([
      adjustmentsApi.balance(employeeId),
      adjustmentsApi.list(employeeId),
    ]);
    setBalance(bal);
    setAdjustments(adj);
  }

  const load = useCallback(async () => {
    try {
      const emp = await employeesApi.get(employeeId);
      setEmployee(emp);
      try {
        setSchedule(await scheduleApi.get(employeeId));
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) setSchedule(null);
        else throw err;
      }
      setHistory(await scheduleApi.history(employeeId));

      if (canManage) {
        try {
          setSalary(await salaryApi.get(employeeId));
        } catch (err) {
          if (err instanceof ApiError && err.status === 404) setSalary(null);
          else throw err;
        }
        setSalaryHistory(await salaryApi.history(employeeId));
      }

      const [bal, adj] = await Promise.all([
        adjustmentsApi.balance(employeeId),
        adjustmentsApi.list(employeeId),
      ]);
      setBalance(bal);
      setAdjustments(adj);

      if (canManage) {
        await loadOvertime();
      }
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Error de conexión con el servidor");
    } finally {
      setLoading(false);
    }
  }, [employeeId, canManage]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleSaveSchedule(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await scheduleApi.set(employeeId, form);
      setShowForm(false);
      setForm(defaultForm());
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo guardar la jornada");
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveSalary(event: React.FormEvent) {
    event.preventDefault();
    setSavingSalary(true);
    setError(null);
    try {
      await salaryApi.set(employeeId, salaryForm);
      setShowSalaryForm(false);
      setSalaryForm({
        effective_from: "",
        monthly_salary: "",
        overtime_enabled: false,
        overtime_method: "PERCENTAGE",
        overtime_percentage: null,
        overtime_fixed_rate: null,
      });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo guardar el sueldo");
    } finally {
      setSavingSalary(false);
    }
  }

  const overtimeLabel = (s: SalarySetting): string => {
    if (!s.overtime_enabled) return "No configurado";
    if (s.overtime_method === "PERCENTAGE") return `${s.overtime_percentage}% recargo`;
    if (s.overtime_method === "FIXED_RATE") return `S/ ${s.overtime_fixed_rate} / hora`;
    return "Monto manual (en periodo)";
  };

  async function handleCreateAdjustment(event: React.FormEvent) {
    event.preventDefault();
    setSavingAdj(true);
    setError(null);
    try {
      await adjustmentsApi.create(employeeId, adjForm);
      setShowAdjForm(false);
      setAdjForm({
        adjustment_date: new Date().toISOString().slice(0, 10),
        minutes: 0,
        adjustment_type: "RECUPERACION",
        reason: "",
      });
      await loadAdjustmentsAndBalance();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo crear el ajuste");
    } finally {
      setSavingAdj(false);
    }
  }

  async function handleApproveAdjustment(id: string) {
    setError(null);
    try {
      await adjustmentsApi.approve(id);
      await loadAdjustmentsAndBalance();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo aprobar el ajuste");
    }
  }

  async function handleRejectAdjustment(id: string) {
    if (rejectReason.trim().length < 3) return;
    setError(null);
    try {
      await adjustmentsApi.reject(id, rejectReason.trim());
      setRejectingId(null);
      setRejectReason("");
      await loadAdjustmentsAndBalance();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo rechazar el ajuste");
    }
  }

  if (loading) {
    return (
      <AdminShell title="Detalle de empleado">
        <p className="muted">Cargando…</p>
      </AdminShell>
    );
  }

  if (!employee) {
    return (
      <AdminShell title="Detalle de empleado">
        <p className="muted">Empleado no encontrado.</p>
      </AdminShell>
    );
  }

  return (
    <AdminShell
      title={`${employee.first_name} ${employee.last_name}`}
      subtitle={`${employee.job_role_name ?? "Sin cargo"} · ${employee.dni} · ${employee.employee_code}`}
    >
      {error && (
        <p className="alert alert-error" role="alert">
          <Alert size={15} style={{ marginTop: 2, flexShrink: 0 }} />
          {error}
        </p>
      )}

      <a href="/admin/employees" className="link-btn" style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem", fontSize: "0.8rem", marginBottom: "1rem" }}>
        <ArrowLeft size={14} />
        Volver a empleados
      </a>

      <div className="card card-pad" style={{ marginBottom: "1.1rem" }}>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: "0.8rem" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.9rem" }}>
            <div className="avatar" style={{ width: 48, height: 48, fontSize: "1.15rem" }}>
              {employee.first_name.charAt(0).toUpperCase()}
            </div>
            <div>
              <h1 style={{ fontSize: "1.25rem" }}>
                {employee.first_name} {employee.last_name}
              </h1>
              <p className="muted" style={{ fontSize: "0.82rem" }}>
                {employee.job_role_name ?? "Sin cargo"} · DNI {employee.dni} · {employee.employee_code}
              </p>
            </div>
          </div>
          {employee.active ? (
            <span className="badge badge-green" style={{ fontSize: "0.78rem", padding: "0.3rem 0.8rem" }}>
              Activo
            </span>
          ) : (
            <span className="badge badge-neutral" style={{ fontSize: "0.78rem", padding: "0.3rem 0.8rem" }}>
              Inactivo
            </span>
          )}
        </div>
        {employee.hire_date && (
          <p className="muted" style={{ fontSize: "0.76rem", marginTop: "0.6rem" }}>
            Ingreso: {employee.hire_date}
          </p>
        )}
      </div>

      {/* Jornada laboral */}
      <div className="card card-pad" style={{ marginBottom: "1.1rem" }}>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: "0.6rem", marginBottom: "0.9rem" }}>
          <div>
            <h2 className="card-title">Jornada laboral</h2>
            <p className="card-sub">Minutos pactados por día; el cambio de jornada preserva el historial.</p>
          </div>
          {canManage && (
            <button className="btn btn-outline btn-sm" onClick={() => setShowForm((v) => !v)}>
              {showForm ? (
                <>
                  <X size={14} /> Cancelar
                </>
              ) : (
                <>
                  <Plus size={14} /> Nueva jornada
                </>
              )}
            </button>
          )}
        </div>

        {canManage && showForm && (
          <form onSubmit={handleSaveSchedule} className="card" style={{ padding: "0.9rem", marginBottom: "1rem", background: "var(--gray-100)", boxShadow: "none" }}>
            <div style={{ display: "grid", gap: "0.7rem", gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))" }}>
              <div>
                <label className="label">Vigente desde</label>
                <input type="date" className="input" value={form.effective_from} onChange={(e) => setForm({ ...form, effective_from: e.target.value })} required />
              </div>
              {DAYS.map((day) => (
                <div key={day.key}>
                  <label className="label">{day.label} (horas)</label>
                  <input
                    type="number"
                    min={0}
                    max={24}
                    step={0.5}
                    className="input"
                    value={form[day.key] / 60}
                    onChange={(e) => setForm({ ...form, [day.key]: Math.round(Number(e.target.value) * 60) })}
                  />
                </div>
              ))}
              <div>
                <label className="label">Refrigerio (min)</label>
                <input
                  type="number"
                  min={0}
                  max={1440}
                  step={15}
                  className="input"
                  value={form.break_minutes}
                  onChange={(e) => setForm({ ...form, break_minutes: Number(e.target.value) })}
                />
              </div>
            </div>
            <button type="submit" className="btn btn-primary" style={{ marginTop: "0.8rem" }} disabled={saving || !form.effective_from}>
              <Check size={15} />
              {saving ? "Guardando…" : "Guardar jornada"}
            </button>
          </form>
        )}

        {schedule ? (
          <div className="table-wrap">
            <table className="table">
              <tbody>
                {DAYS.map((day) => (
                  <tr key={day.key}>
                    <td style={{ fontWeight: 600, width: 160 }}>{day.label}</td>
                    <td>{formatHours(schedule[day.key])}</td>
                  </tr>
                ))}
                <tr>
                  <td style={{ fontWeight: 600 }}>Refrigerio</td>
                  <td>{schedule.break_minutes} min</td>
                </tr>
                <tr>
                  <td style={{ fontWeight: 600 }}>Vigente desde</td>
                  <td>{schedule.effective_from}</td>
                </tr>
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted" style={{ fontSize: "0.85rem" }}>
            Este empleado aún no tiene jornada configurada.
            {canManage && " Usa «Nueva jornada» para definirla."}
          </p>
        )}

        {history.length > 1 && (
          <div style={{ marginTop: "1rem", borderTop: "1px solid var(--border)", paddingTop: "0.8rem" }}>
            <h3 style={{ fontSize: "0.85rem", fontWeight: 600, marginBottom: "0.4rem" }}>Historial de jornadas</h3>
            <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: "0.2rem", fontSize: "0.82rem", color: "var(--muted)" }}>
              {history.map((h) => (
                <li key={h.id}>
                  {h.effective_from} → {h.effective_to ?? "vigente"}
                  <span style={{ marginLeft: "0.5rem", opacity: 0.7 }}>
                    (L {formatHours(h.monday_minutes)} · S {formatHours(h.saturday_minutes)} · D {formatHours(h.sunday_minutes)})
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* Sueldo */}
      {canManage && (
        <div className="card card-pad" style={{ marginBottom: "1.1rem" }}>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: "0.6rem", marginBottom: "0.9rem" }}>
            <div>
              <h2 className="card-title">Sueldo</h2>
              <p className="card-sub">Visible solo para administradores y jefes. El cambio preserva el historial.</p>
            </div>
            <button className="btn btn-outline btn-sm" onClick={() => setShowSalaryForm((v) => !v)}>
              {showSalaryForm ? (
                <>
                  <X size={14} /> Cancelar
                </>
              ) : (
                <>
                  <Coins size={14} /> Configurar sueldo
                </>
              )}
            </button>
          </div>

          {showSalaryForm && (
            <form onSubmit={handleSaveSalary} className="card" style={{ padding: "0.9rem", marginBottom: "1rem", background: "var(--gray-100)", boxShadow: "none" }}>
              <div style={{ display: "grid", gap: "0.7rem", gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))" }}>
                <div>
                  <label className="label">Vigente desde</label>
                  <input type="date" className="input" value={salaryForm.effective_from} onChange={(e) => setSalaryForm({ ...salaryForm, effective_from: e.target.value })} required />
                </div>
                <div>
                  <label className="label">Sueldo mensual (S/)</label>
                  <input
                    type="number"
                    min={0.01}
                    step={0.01}
                    className="input"
                    value={salaryForm.monthly_salary}
                    onChange={(e) => setSalaryForm({ ...salaryForm, monthly_salary: e.target.value })}
                    required
                  />
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", paddingTop: "1.4rem" }}>
                  <input
                    type="checkbox"
                    id="overtime-enabled"
                    checked={salaryForm.overtime_enabled}
                    onChange={(e) => setSalaryForm({ ...salaryForm, overtime_enabled: e.target.checked })}
                    style={{ width: 16, height: 16, accentColor: "var(--primary-blue)" }}
                  />
                  <label htmlFor="overtime-enabled" style={{ fontSize: "0.82rem", fontWeight: 600, color: "var(--gray-600)" }}>
                    Horas extra habilitadas
                  </label>
                </div>

                {salaryForm.overtime_enabled && (
                  <>
                    <div>
                      <label className="label">Método</label>
                      <Select value={salaryForm.overtime_method} onValueChange={(v) => setSalaryForm({ ...salaryForm, overtime_method: v as SalaryPayload["overtime_method"] })}>
                        <SelectTrigger aria-label="Método de horas extra">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="PERCENTAGE">Porcentaje (%)</SelectItem>
                          <SelectItem value="FIXED_RATE">Tarifa fija (S/ / hora)</SelectItem>
                          <SelectItem value="MANUAL">Monto manual (en periodo)</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    {salaryForm.overtime_method === "PERCENTAGE" && (
                      <div>
                        <label className="label">Recargo (%)</label>
                        <input
                          type="number"
                          min={0}
                          step={0.01}
                          className="input"
                          value={salaryForm.overtime_percentage ?? ""}
                          onChange={(e) => setSalaryForm({ ...salaryForm, overtime_percentage: e.target.value || null })}
                          required
                        />
                      </div>
                    )}
                    {salaryForm.overtime_method === "FIXED_RATE" && (
                      <div>
                        <label className="label">Tarifa (S/ por hora)</label>
                        <input
                          type="number"
                          min={0}
                          step={0.01}
                          className="input"
                          value={salaryForm.overtime_fixed_rate ?? ""}
                          onChange={(e) => setSalaryForm({ ...salaryForm, overtime_fixed_rate: e.target.value || null })}
                          required
                        />
                      </div>
                    )}
                  </>
                )}
              </div>
              <button
                type="submit"
                className="btn btn-primary"
                style={{ marginTop: "0.8rem" }}
                disabled={savingSalary || !salaryForm.effective_from || !salaryForm.monthly_salary}
              >
                <Check size={15} />
                {savingSalary ? "Guardando…" : "Guardar sueldo"}
              </button>
            </form>
          )}

          {salary ? (
            <div className="stat-grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))", marginBottom: 0 }}>
              <div className="stat-card">
                <div className="stat-label">Sueldo mensual</div>
                <div className="stat-value" style={{ fontSize: "1.25rem" }}>{formatMoney(salary.monthly_salary)}</div>
                <div className="stat-hint">desde {salary.effective_from}</div>
              </div>
              <div className="stat-card">
                <div className="stat-label">Horas extra</div>
                <div className="stat-value" style={{ fontSize: "1.05rem" }}>{overtimeLabel(salary)}</div>
              </div>
              <div className="stat-card">
                <div className="stat-label">Estado</div>
                <div className="stat-value" style={{ fontSize: "1.05rem", color: "var(--dark-green)" }}>Vigente</div>
              </div>
            </div>
          ) : (
            <p className="muted" style={{ fontSize: "0.85rem" }}>
              Este empleado aún no tiene sueldo configurado.
            </p>
          )}

          {salaryHistory.length > 1 && (
            <div style={{ marginTop: "1rem", borderTop: "1px solid var(--border)", paddingTop: "0.8rem" }}>
              <h3 style={{ fontSize: "0.85rem", fontWeight: 600, marginBottom: "0.4rem" }}>Historial de sueldos</h3>
              <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: "0.2rem", fontSize: "0.82rem", color: "var(--muted)" }}>
                {salaryHistory.map((h) => (
                  <li key={h.id}>
                    {formatMoney(h.monthly_salary)} · {h.effective_from} → {h.effective_to ?? "vigente"}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* Ajustes de horas y saldo */}
      <div className="card card-pad">
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: "0.6rem", marginBottom: "0.9rem" }}>
          <div>
            <h2 className="card-title">Ajustes de horas y saldo</h2>
            <p className="card-sub">Saldo = trabajado − esperado + ajustes aprobados. Nada se descuenta solo.</p>
          </div>
          {canManage && (
            <button className="btn btn-outline btn-sm" onClick={() => setShowAdjForm((v) => !v)}>
              {showAdjForm ? (
                <>
                  <X size={14} /> Cancelar
                </>
              ) : (
                <>
                  <Plus size={14} /> Nuevo ajuste
                </>
              )}
            </button>
          )}
        </div>

        {balance && (
          <div className="stat-grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))" }}>
            <div className="stat-card">
              <div className="stat-label">Trabajado</div>
              <div className="stat-value" style={{ fontSize: "1.1rem" }}>{signedMinutes(balance.worked_minutes)}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Esperado</div>
              <div className="stat-value" style={{ fontSize: "1.1rem" }}>{signedMinutes(balance.expected_minutes)}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Ajustes aprobados</div>
              <div className="stat-value" style={{ fontSize: "1.1rem" }}>{signedMinutes(balance.adjustment_minutes)}</div>
            </div>
            <div
              className="stat-card"
              style={
                balance.balance_minutes < 0
                  ? { borderColor: "#f0d9a8", background: "#fffdf7" }
                  : { borderColor: "#bfe8cd", background: "#f2fcf6" }
              }
            >
              <div className="stat-label">Saldo del mes</div>
              <div className="stat-value" style={{ fontSize: "1.1rem", color: balance.balance_minutes < 0 ? "#9a5b00" : "var(--dark-green)" }}>
                {signedMinutes(balance.balance_minutes)}
              </div>
            </div>
          </div>
        )}

        {canManage && (
          <div className="card" style={{ padding: "0.9rem", marginBottom: "1rem", background: "var(--blue-soft)", borderColor: "rgba(0,123,255,0.25)", boxShadow: "none" }}>
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: "0.5rem", marginBottom: "0.6rem" }}>
              <div>
                <h3 style={{ fontSize: "0.85rem", fontWeight: 600 }}>Horas extra</h3>
                <p style={{ fontSize: "0.74rem", color: "var(--muted)" }}>
                  Detectar ≠ pagar: registrar crea un ajuste pendiente que debe aprobarse.
                </p>
              </div>
              <button
                className="btn btn-outline btn-sm"
                onClick={() => {
                  setDetecting(true);
                  loadOvertime().finally(() => setDetecting(false));
                }}
                disabled={detecting}
              >
                <Zap size={14} />
                {detecting ? "Consultando…" : "Detectar sobretiempo del mes"}
              </button>
            </div>

            {overtimeValue && overtimeValue.overtime_minutes > 0 && (
              <div className="card" style={{ padding: "0.6rem 0.8rem", marginBottom: "0.6rem", boxShadow: "none", display: "flex", flexWrap: "wrap", gap: "0.4rem 1.2rem", fontSize: "0.82rem" }}>
                <span className="muted">
                  Método: <strong style={{ color: "var(--text)" }}>{overtimeValue.method === "PERCENTAGE" ? "Porcentaje" : overtimeValue.method === "FIXED_RATE" ? "Tarifa fija" : "Manual"}</strong>
                </span>
                {overtimeValue.hourly_rate && (
                  <span className="muted">
                    Tarifa: <strong style={{ color: "var(--text)" }}>S/ {Number(overtimeValue.hourly_rate).toFixed(2)} / h</strong>
                  </span>
                )}
                <span className="muted">
                  Minutos aprobados: <strong style={{ color: "var(--text)" }}>{overtimeValue.overtime_minutes}</strong>
                </span>
                <span className="muted">
                  Valor: <strong style={{ color: "var(--dark-green)" }}>S/ {Number(overtimeValue.value).toFixed(2)}</strong>
                </span>
              </div>
            )}

            {detectedDays !== null &&
              (detectedDays.length === 0 ? (
                <p style={{ fontSize: "0.78rem", color: "var(--muted)" }}>
                  Sin sobretiempo detectado este mes (trabajado ≤ esperado todos los días).
                </p>
              ) : (
                <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: "0.4rem" }}>
                  {detectedDays.map((day) => (
                    <li key={day.work_date} className="card" style={{ padding: "0.55rem 0.8rem", boxShadow: "none", display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: "0.5rem", fontSize: "0.84rem" }}>
                      <span>
                        <strong>{day.work_date}</strong>
                        <span className="muted" style={{ marginLeft: "0.5rem" }}>
                          trabajado {signedMinutes(day.worked_minutes)} · esperado {signedMinutes(day.expected_minutes)}
                        </span>
                      </span>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: "0.5rem" }}>
                        <strong style={{ color: "var(--primary-blue)" }}>+{signedMinutes(day.extra_minutes)}</strong>
                        <button className="btn btn-primary btn-sm" onClick={() => registerOvertime(day)}>
                          Registrar como HE
                        </button>
                      </span>
                    </li>
                  ))}
                </ul>
              ))}
          </div>
        )}

        {canManage && showAdjForm && (
          <form onSubmit={handleCreateAdjustment} className="card" style={{ padding: "0.9rem", marginBottom: "1rem", background: "var(--gray-100)", boxShadow: "none" }}>
            <div style={{ display: "grid", gap: "0.7rem", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))" }}>
              <div>
                <label className="label">Fecha</label>
                <input type="date" className="input" value={adjForm.adjustment_date} onChange={(e) => setAdjForm({ ...adjForm, adjustment_date: e.target.value })} required />
              </div>
              <div>
                <label className="label">Minutos (±)</label>
                <input
                  type="number"
                  min={-1440}
                  max={1440}
                  className="input"
                  value={adjForm.minutes}
                  onChange={(e) => setAdjForm({ ...adjForm, minutes: Number(e.target.value) })}
                  required
                />
              </div>
              <div>
                <label className="label">Tipo</label>
                <Select value={adjForm.adjustment_type} onValueChange={(v) => setAdjForm({ ...adjForm, adjustment_type: v as HourAdjustment["adjustment_type"] })}>
                  <SelectTrigger aria-label="Tipo de ajuste">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="RECUPERACION">Recuperación</SelectItem>
                    <SelectItem value="PERMISO">Permiso</SelectItem>
                    <SelectItem value="OVERTIME">Horas extra</SelectItem>
                    <SelectItem value="OTRO">Otro</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="label">Motivo</label>
                <input
                  type="text"
                  className="input"
                  value={adjForm.reason}
                  onChange={(e) => setAdjForm({ ...adjForm, reason: e.target.value })}
                  required
                  minLength={3}
                  placeholder="Ej. recuperó las horas del sábado 22"
                />
              </div>
            </div>
            <button type="submit" className="btn btn-primary" style={{ marginTop: "0.8rem" }} disabled={savingAdj || adjForm.reason.trim().length < 3}>
              <Plus size={15} />
              {savingAdj ? "Guardando…" : "Crear ajuste (pendiente)"}
            </button>
          </form>
        )}

        {adjustments.length === 0 ? (
          <p className="muted" style={{ fontSize: "0.85rem" }}>Sin ajustes registrados.</p>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: "0.5rem" }}>
            {adjustments.map((adj) => (
              <li key={adj.id} className="card" style={{ padding: "0.7rem 0.9rem", boxShadow: "none" }}>
                <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: "0.5rem" }}>
                  <div>
                    <p style={{ fontSize: "0.85rem", fontWeight: 600 }}>
                      {typeLabel[adj.adjustment_type] ?? adj.adjustment_type} ·{" "}
                      <span style={{ color: adj.minutes < 0 ? "#9a5b00" : "var(--dark-green)" }}>
                        {signedMinutes(adj.minutes)}
                      </span>
                      <span className="muted" style={{ marginLeft: "0.5rem", fontWeight: 400, fontSize: "0.76rem" }}>
                        {adj.adjustment_date}
                      </span>
                    </p>
                    <p style={{ fontSize: "0.76rem", color: "var(--muted)" }}>{adj.reason}</p>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                    {adj.status === "APPROVED" ? (
                      <span className="badge badge-green">Aprobado por {adj.approved_by_username ?? "—"}</span>
                    ) : adj.status === "REJECTED" ? (
                      <span className="badge badge-red">Rechazado</span>
                    ) : (
                      <span className="badge badge-amber">Pendiente</span>
                    )}
                    {canManage && adj.status === "PENDING" && (
                      <>
                        <button className="btn btn-green btn-sm" onClick={() => handleApproveAdjustment(adj.id)}>
                          <Check size={13} />
                          Aprobar
                        </button>
                        {rejectingId === adj.id ? (
                          <span style={{ display: "inline-flex", gap: "0.3rem", alignItems: "center" }}>
                            <input
                              type="text"
                              className="input"
                              style={{ width: 150, padding: "0.35rem 0.5rem" }}
                              value={rejectReason}
                              onChange={(e) => setRejectReason(e.target.value)}
                              placeholder="Motivo del rechazo…"
                            />
                            <button className="btn btn-danger btn-sm" onClick={() => handleRejectAdjustment(adj.id)} disabled={rejectReason.trim().length < 3}>
                              Confirmar
                            </button>
                            <button
                              className="btn btn-ghost btn-sm"
                              onClick={() => {
                                setRejectingId(null);
                                setRejectReason("");
                              }}
                              aria-label="Cancelar"
                            >
                              <X size={13} />
                            </button>
                          </span>
                        ) : (
                          <button
                            className="btn btn-danger btn-sm"
                            onClick={() => {
                              setRejectingId(adj.id);
                              setRejectReason("");
                            }}
                          >
                            Rechazar
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </AdminShell>
  );
}
