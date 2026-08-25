"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  ApiError,
  authApi,
  employeesApi,
  Employee,
  salaryApi,
  SalaryPayload,
  SalarySetting,
  scheduleApi,
  SchedulePayload,
  UserOut,
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

export default function EmployeeDetailPage() {
  const params = useParams<{ id: string }>();
  const employeeId = params.id;
  const router = useRouter();

  const [user, setUser] = useState<UserOut | null>(null);
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

  const canManage = user ? MANAGE_ROLES.includes(user.role) : false;

  const load = useCallback(async () => {
    try {
      const me = await authApi.me();
      setUser(me);
      const emp = await employeesApi.get(employeeId);
      setEmployee(emp);
      try {
        setSchedule(await scheduleApi.get(employeeId));
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) setSchedule(null);
        else throw err;
      }
      setHistory(await scheduleApi.history(employeeId));

      // Salario: solo ADMIN/BOSS (el backend rechaza 403 al supervisor).
      if (MANAGE_ROLES.includes(me.role)) {
        try {
          setSalary(await salaryApi.get(employeeId));
        } catch (err) {
          if (err instanceof ApiError && err.status === 404) setSalary(null);
          else throw err;
        }
        setSalaryHistory(await salaryApi.history(employeeId));
      }
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
  }, [employeeId, router]);

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

  function formatMoney(value: string | null): string {
    if (value === null) return "—";
    const num = Number(value);
    return `S/ ${num.toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  const overtimeLabel = (s: SalarySetting): string => {
    if (!s.overtime_enabled) return "No configurado";
    if (s.overtime_method === "PERCENTAGE") return `${s.overtime_percentage}% recargo`;
    if (s.overtime_method === "FIXED_RATE") return `S/ ${s.overtime_fixed_rate} / hora`;
    return "Monto manual (en periodo)";
  };

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center bg-zinc-50 text-zinc-500">
        Cargando…
      </div>
    );
  }

  if (!employee) {
    return (
      <div className="flex flex-1 items-center justify-center bg-zinc-50 text-zinc-500">
        Empleado no encontrado.
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col bg-zinc-50">
      <header className="flex items-center justify-between border-b border-zinc-200 bg-white px-6 py-4">
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-sky-600 text-lg">
            💧
          </span>
          <span className="font-semibold text-zinc-900">Agua ReNew</span>
          <span className="text-sm text-zinc-500">· Detalle de empleado</span>
        </div>
        <button
          onClick={() => router.push("/admin/employees")}
          className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm text-zinc-600 transition-colors hover:bg-zinc-100"
        >
          ← Empleados
        </button>
      </header>

      <main className="mx-auto w-full max-w-4xl flex-1 p-6">
        {error && (
          <p className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
        )}

        <div className="mb-6 rounded-2xl border border-zinc-200 bg-white p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 className="text-2xl font-semibold text-zinc-900">
                {employee.first_name} {employee.last_name}
              </h1>
              <p className="text-sm text-zinc-500">
                {employee.job_role_name ?? "Sin cargo"} · {employee.dni} · {employee.employee_code}
              </p>
            </div>
            <span
              className={
                employee.active
                  ? "rounded-full bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700"
                  : "rounded-full bg-zinc-100 px-3 py-1 text-xs font-medium text-zinc-500"
              }
            >
              {employee.active ? "Activo" : "Inactivo"}
            </span>
          </div>
          {employee.hire_date && (
            <p className="mt-2 text-xs text-zinc-400">Ingreso: {employee.hire_date}</p>
          )}
        </div>

        <div className="mb-6 rounded-2xl border border-zinc-200 bg-white p-5">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold text-zinc-900">Jornada laboral</h2>
              <p className="text-sm text-zinc-500">
                Minutos pactados por día; el cambio de jornada preserva el historial.
              </p>
            </div>
            {canManage && (
              <button
                onClick={() => setShowForm((v) => !v)}
                className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-sky-700"
              >
                {showForm ? "Cancelar" : "Nueva jornada"}
              </button>
            )}
          </div>

          {canManage && showForm && (
            <form
              onSubmit={handleSaveSchedule}
              className="mb-5 grid gap-3 rounded-xl bg-zinc-50 p-4 sm:grid-cols-3 lg:grid-cols-4"
            >
              <label className="flex flex-col gap-1 text-sm font-medium text-zinc-700 sm:col-span-2">
                Vigente desde
                <input
                  type="date"
                  value={form.effective_from}
                  onChange={(e) => setForm({ ...form, effective_from: e.target.value })}
                  required
                  className="rounded-lg border border-zinc-300 px-3 py-2 text-zinc-900 outline-none focus:border-sky-500"
                />
              </label>
              {DAYS.map((day) => (
                <label key={day.key} className="flex flex-col gap-1 text-sm font-medium text-zinc-700">
                  {day.label} (horas)
                  <input
                    type="number"
                    min={0}
                    max={24}
                    step={0.5}
                    value={form[day.key] / 60}
                    onChange={(e) =>
                      setForm({ ...form, [day.key]: Math.round(Number(e.target.value) * 60) })
                    }
                    className="rounded-lg border border-zinc-300 px-3 py-2 text-zinc-900 outline-none focus:border-sky-500"
                  />
                </label>
              ))}
              <label className="flex flex-col gap-1 text-sm font-medium text-zinc-700">
                Refrigerio (min)
                <input
                  type="number"
                  min={0}
                  max={1440}
                  step={15}
                  value={form.break_minutes}
                  onChange={(e) => setForm({ ...form, break_minutes: Number(e.target.value) })}
                  className="rounded-lg border border-zinc-300 px-3 py-2 text-zinc-900 outline-none focus:border-sky-500"
                />
              </label>
              <div className="sm:col-span-3 lg:col-span-4">
                <button
                  type="submit"
                  disabled={saving || !form.effective_from}
                  className="rounded-lg bg-sky-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-sky-700 disabled:opacity-50"
                >
                  {saving ? "Guardando…" : "Guardar jornada"}
                </button>
              </div>
            </form>
          )}

          {schedule ? (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <tbody className="divide-y divide-zinc-100">
                  {DAYS.map((day) => (
                    <tr key={day.key}>
                      <td className="py-2 pr-4 font-medium text-zinc-700">{day.label}</td>
                      <td className="py-2 text-zinc-900">{formatHours(schedule[day.key])}</td>
                    </tr>
                  ))}
                  <tr>
                    <td className="py-2 pr-4 font-medium text-zinc-700">Refrigerio</td>
                    <td className="py-2 text-zinc-900">{schedule.break_minutes} min</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4 font-medium text-zinc-700">Vigente desde</td>
                    <td className="py-2 text-zinc-900">{schedule.effective_from}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-zinc-400">
              Este empleado aún no tiene jornada configurada.
              {canManage && " Usa «Nueva jornada» para definirla."}
            </p>
          )}

          {history.length > 1 && (
            <div className="mt-5 border-t border-zinc-100 pt-4">
              <h3 className="mb-2 text-sm font-semibold text-zinc-700">Historial de jornadas</h3>
              <ul className="space-y-1 text-sm text-zinc-500">
                {history.map((h) => (
                  <li key={h.id}>
                    {h.effective_from} → {h.effective_to ?? "vigente"}
                    <span className="ml-2 text-zinc-400">
                      (L {formatHours(h.monday_minutes)} · S {formatHours(h.saturday_minutes)} · D{" "}
                      {formatHours(h.sunday_minutes)})
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        {canManage && (
          <div className="rounded-2xl border border-zinc-200 bg-white p-5">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold text-zinc-900">Sueldo</h2>
                <p className="text-sm text-zinc-500">
                  Visible solo para administradores y jefes. El cambio de sueldo preserva el historial.
                </p>
              </div>
              <button
                onClick={() => setShowSalaryForm((v) => !v)}
                className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-sky-700"
              >
                {showSalaryForm ? "Cancelar" : "Configurar sueldo"}
              </button>
            </div>

            {showSalaryForm && (
              <form
                onSubmit={handleSaveSalary}
                className="mb-5 grid gap-3 rounded-xl bg-zinc-50 p-4 sm:grid-cols-3"
              >
                <label className="flex flex-col gap-1 text-sm font-medium text-zinc-700">
                  Vigente desde
                  <input
                    type="date"
                    value={salaryForm.effective_from}
                    onChange={(e) => setSalaryForm({ ...salaryForm, effective_from: e.target.value })}
                    required
                    className="rounded-lg border border-zinc-300 px-3 py-2 text-zinc-900 outline-none focus:border-sky-500"
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm font-medium text-zinc-700">
                  Sueldo mensual (S/)
                  <input
                    type="number"
                    min={0.01}
                    step={0.01}
                    value={salaryForm.monthly_salary}
                    onChange={(e) => setSalaryForm({ ...salaryForm, monthly_salary: e.target.value })}
                    required
                    className="rounded-lg border border-zinc-300 px-3 py-2 text-zinc-900 outline-none focus:border-sky-500"
                  />
                </label>
                <label className="flex items-end gap-2 pb-2 text-sm font-medium text-zinc-700">
                  <input
                    type="checkbox"
                    checked={salaryForm.overtime_enabled}
                    onChange={(e) =>
                      setSalaryForm({ ...salaryForm, overtime_enabled: e.target.checked })
                    }
                    className="h-4 w-4 accent-sky-600"
                  />
                  Horas extra habilitadas
                </label>

                {salaryForm.overtime_enabled && (
                  <>
                    <label className="flex flex-col gap-1 text-sm font-medium text-zinc-700">
                      Método
                      <select
                        value={salaryForm.overtime_method}
                        onChange={(e) =>
                          setSalaryForm({
                            ...salaryForm,
                            overtime_method: e.target.value as SalaryPayload["overtime_method"],
                          })
                        }
                        className="rounded-lg border border-zinc-300 px-3 py-2 text-zinc-900 outline-none focus:border-sky-500"
                      >
                        <option value="PERCENTAGE">Porcentaje (%)</option>
                        <option value="FIXED_RATE">Tarifa fija (S/ / hora)</option>
                        <option value="MANUAL">Monto manual (en periodo)</option>
                      </select>
                    </label>
                    {salaryForm.overtime_method === "PERCENTAGE" && (
                      <label className="flex flex-col gap-1 text-sm font-medium text-zinc-700">
                        Recargo (%)
                        <input
                          type="number"
                          min={0}
                          step={0.01}
                          value={salaryForm.overtime_percentage ?? ""}
                          onChange={(e) =>
                            setSalaryForm({
                              ...salaryForm,
                              overtime_percentage: e.target.value || null,
                            })
                          }
                          required
                          className="rounded-lg border border-zinc-300 px-3 py-2 text-zinc-900 outline-none focus:border-sky-500"
                        />
                      </label>
                    )}
                    {salaryForm.overtime_method === "FIXED_RATE" && (
                      <label className="flex flex-col gap-1 text-sm font-medium text-zinc-700">
                        Tarifa (S/ por hora)
                        <input
                          type="number"
                          min={0}
                          step={0.01}
                          value={salaryForm.overtime_fixed_rate ?? ""}
                          onChange={(e) =>
                            setSalaryForm({
                              ...salaryForm,
                              overtime_fixed_rate: e.target.value || null,
                            })
                          }
                          required
                          className="rounded-lg border border-zinc-300 px-3 py-2 text-zinc-900 outline-none focus:border-sky-500"
                        />
                      </label>
                    )}
                  </>
                )}

                <div className="sm:col-span-3">
                  <button
                    type="submit"
                    disabled={savingSalary || !salaryForm.effective_from || !salaryForm.monthly_salary}
                    className="rounded-lg bg-sky-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-sky-700 disabled:opacity-50"
                  >
                    {savingSalary ? "Guardando…" : "Guardar sueldo"}
                  </button>
                </div>
              </form>
            )}

            {salary ? (
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="rounded-xl border border-zinc-100 p-4">
                  <p className="text-xs font-medium uppercase tracking-wide text-zinc-400">
                    Sueldo mensual
                  </p>
                  <p className="mt-1 text-xl font-semibold text-zinc-900">
                    {formatMoney(salary.monthly_salary)}
                  </p>
                  <p className="mt-1 text-xs text-zinc-400">desde {salary.effective_from}</p>
                </div>
                <div className="rounded-xl border border-zinc-100 p-4">
                  <p className="text-xs font-medium uppercase tracking-wide text-zinc-400">
                    Horas extra
                  </p>
                  <p className="mt-1 text-lg font-semibold text-zinc-900">{overtimeLabel(salary)}</p>
                </div>
                <div className="rounded-xl border border-zinc-100 p-4">
                  <p className="text-xs font-medium uppercase tracking-wide text-zinc-400">
                    Estado
                  </p>
                  <p className="mt-1 text-lg font-semibold text-emerald-600">Vigente</p>
                </div>
              </div>
            ) : (
              <p className="text-sm text-zinc-400">
                Este empleado aún no tiene sueldo configurado.
              </p>
            )}

            {salaryHistory.length > 1 && (
              <div className="mt-5 border-t border-zinc-100 pt-4">
                <h3 className="mb-2 text-sm font-semibold text-zinc-700">Historial de sueldos</h3>
                <ul className="space-y-1 text-sm text-zinc-500">
                  {salaryHistory.map((h) => (
                    <li key={h.id}>
                      {formatMoney(h.monthly_salary)} · {h.effective_from} →{" "}
                      {h.effective_to ?? "vigente"}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
