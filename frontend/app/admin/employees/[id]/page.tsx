"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import AdminShell from "@/components/AdminShell";
import AppDialog, { AppDialogCloseButton } from "@/components/AppDialog";
import EmployeeAttendanceWorkspace, { type EmployeeAttendanceWorkspaceHandle } from "@/components/EmployeeAttendanceWorkspace";
import { DetailSkeleton, Skeleton, Spinner } from "@/components/Loading";
import { useNotifications } from "@/components/Notifications";
import { useAdminSession } from "@/components/AdminSession";
import DateField from "@/components/DateField";
import {
  Alert,
  ArrowLeft,
  Check,
  Coins,
  Download,
  Plus,
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
    break_applies_after_minutes: 360,
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

/** Fecha ISO (YYYY-MM-DD) del día siguiente a la fecha dada. */
function dayAfter(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00`);
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
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
  const { user, ready } = useAdminSession();

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
    use_custom_overtime_rates: false,
    custom_first_two_hours_rate: null,
    custom_additional_hours_rate: null,
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
  const adjustmentOperationKeys = useRef<Record<string, string>>({});
  const [adjustmentAction, setAdjustmentAction] = useState<string | null>(null);
  const workspaceRef = useRef<EmployeeAttendanceWorkspaceHandle>(null);

  const [detectedDays, setDetectedDays] = useState<OvertimeDetectItem[] | null>(null);
  const [overtimeValue, setOvertimeValue] = useState<OvertimeValue | null>(null);
  const [detecting, setDetecting] = useState(false);

  // QR del empleado: se obtiene vía fetch con credenciales (no <img> cross-origin,
  // que no envía la cookie y devolvía "No autenticado"). Se guarda como object URL.
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [qrNonce, setQrNonce] = useState(0);
  const [downloadingQr, setDownloadingQr] = useState(false);
  const [rotatingQr, setRotatingQr] = useState(false);
  const [confirmQrRotation, setConfirmQrRotation] = useState(false);
  const [registeringOvertimeDay, setRegisteringOvertimeDay] = useState<string | null>(null);
  const { success } = useNotifications();

  const canManage = user ? MANAGE_ROLES.includes(user.role) : false;
  const activeOvertimeByDate = new Map(
    adjustments
      .filter((adjustment) => adjustment.adjustment_type === "OVERTIME" && (adjustment.status === "PENDING" || adjustment.status === "APPROVED"))
      .map((adjustment) => [adjustment.adjustment_date, adjustment]),
  );

  function monthRange(): { from: string; to: string } {
    const now = new Date();
    const from = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
    const to = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().slice(0, 10);
    return { from, to };
  }

  const loadOvertime = useCallback(async () => {
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
  }, [canManage, employeeId]);

  async function registerOvertime(day: OvertimeDetectItem) {
    if (registeringOvertimeDay) return;
    setRegisteringOvertimeDay(day.work_date);
    setError(null);
    try {
      await adjustmentsApi.create(employeeId, {
        adjustment_date: day.work_date,
        minutes: day.extra_minutes,
        adjustment_type: "OVERTIME",
        reason: `Horas extra del ${day.work_date} (${Math.round(day.extra_minutes / 60)} h)`,
      });
      await Promise.all([loadOvertime(), loadAdjustmentsAndBalance()]);
      success("Horas extra registradas como ajuste pendiente.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo registrar la hora extra");
    } finally {
      setRegisteringOvertimeDay(null);
    }
  }

  const loadAdjustmentsAndBalance = useCallback(async () => {
    const [bal, adj] = await Promise.all([
      adjustmentsApi.balance(employeeId),
      adjustmentsApi.list(employeeId),
    ]);
    setBalance(bal);
    setAdjustments(adj);
  }, [employeeId]);

  async function refreshAdjustmentSurfaces() {
    await Promise.all([loadAdjustmentsAndBalance(), loadOvertime()]);
  }

  const load = useCallback(async () => {
    // Time-bound: ningún bloque puede colgar la UI más de 25s (cold start).
    const TIMEOUT_MS = 25_000;
    const withTimeout = <T,>(p: Promise<T>): Promise<T> =>
      Promise.race([
        p,
        new Promise<T>((_, reject) =>
          setTimeout(() => reject(new Error("Tiempo agotado")), TIMEOUT_MS),
        ),
      ]);

    try {
      const emp = await withTimeout(employeesApi.get(employeeId));
      setEmployee(emp);

      // Bajamos loading temprano para que la página pinte el detalle básico
      // aunque las llamadas secundarias sigan en curso. Esto evita el
      // "Cargando…" eterno si una llamada (p. ej. cold start) cuelga.
      setLoading(false);

      // Llamadas secundarias en paralelo (no bloquean el primer render).
      const tasks: Promise<void>[] = [
        withTimeout(scheduleApi.get(employeeId))
          .then((s) => setSchedule(s))
          .catch((err) => {
            if (err instanceof ApiError && err.status === 404) setSchedule(null);
            else throw err;
          }),
        withTimeout(scheduleApi.history(employeeId)).then(setHistory),
        withTimeout(adjustmentsApi.balance(employeeId)).then(setBalance),
        withTimeout(adjustmentsApi.list(employeeId)).then(setAdjustments),
      ];

      if (canManage) {
        tasks.push(
          withTimeout(salaryApi.get(employeeId))
            .then((s) => setSalary(s))
            .catch((err) => {
              if (err instanceof ApiError && err.status === 404) setSalary(null);
              else throw err;
            }),
        );
        tasks.push(withTimeout(salaryApi.history(employeeId)).then(setSalaryHistory));
        tasks.push(withTimeout(loadOvertime()));
      }

      try {
        await Promise.all(tasks);
        setError(null);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "Algunas secciones no pudieron cargar");
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Error de conexión con el servidor");
      setLoading(false);
    }
  }, [canManage, employeeId, loadOvertime]);

  useEffect(() => {
    if (!ready) return;
    load();
  }, [load, ready]);

  // Cargar el QR (SVG) con credenciales cuando el empleado ya está disponible.
  // No usamos <img src=...> porque el navegador NO envía la cookie cross-origin.
  useEffect(() => {
    if (!employee) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(employeesApi.qrUrl(employee.id), {
          credentials: "include",
        });
        if (!res.ok) return;
        const svg = await res.text();
        const blob = new Blob([svg], { type: "image/svg+xml" });
        const url = URL.createObjectURL(blob);
        if (!cancelled) setQrUrl(url);
        else URL.revokeObjectURL(url);
      } catch {
        // silencioso: el QR es un extra, no debe romper la página
      }
    })();
    return () => { cancelled = true; };
  }, [employee, qrNonce]);

  useEffect(() => () => { if (qrUrl) URL.revokeObjectURL(qrUrl); }, [qrUrl]);

  async function handleDownloadQr(format: "svg" | "png" | "jpg") {
    if (!employee) return;
    setDownloadingQr(true);
    try {
      // Descargar el archivo real (SVG), no un link. El atributo `download`
      // de un <a> cross-origin es ignorado por el navegador; por eso se baja
      // vía fetch + blob + <a> local.
      const res = await fetch(`${employeesApi.qrUrl(employee.id)}?format=${format}`, {
        credentials: "include",
      });
      if (!res.ok) {
        const body = await res.text();
        setError(body.includes("No autenticado") ? "Sesión expirada: vuelve a iniciar sesión" : "No se pudo descargar el QR");
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `qr-${employee.employee_code}-5x5cm.${format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      success(`QR ${format.toUpperCase()} descargado a 5 × 5 cm.`);
    } catch {
      setError("No se pudo descargar el QR");
    } finally {
      setDownloadingQr(false);
    }
  }

  async function handleRotateQr() {
    if (!employee) return;
    setRotatingQr(true);
    setError(null);
    try {
      await employeesApi.rotateQr(employee.id);
      setQrNonce((n) => n + 1);
      success("QR rotado. El código anterior ya no identifica al empleado.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo rotar el QR");
    } finally {
      setRotatingQr(false);
    }
  }

  async function handleSaveSchedule(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await scheduleApi.set(employeeId, form);
      setShowForm(false);
      setForm(defaultForm());
      await load();
      success("Jornada laboral guardada.");
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
        use_custom_overtime_rates: false,
        custom_first_two_hours_rate: null,
        custom_additional_hours_rate: null,
      });
      await load();
      success("Sueldo guardado.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo guardar el sueldo");
    } finally {
      setSavingSalary(false);
    }
  }

  const overtimeLabel = (s: SalarySetting): string => {
    if (!s.overtime_enabled) return "No configurado";
    if (s.use_custom_overtime_rates) {
      return `Personalizado: ${s.custom_first_two_hours_rate}% / ${s.custom_additional_hours_rate}%`;
    }
    return "Política general";
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
      success("Ajuste registrado correctamente.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo crear el ajuste");
    } finally {
      setSavingAdj(false);
    }
  }

  async function handleApproveAdjustment(id: string) {
    if (adjustmentAction) return;
    setError(null);
    const adjustment = adjustments.find((item) => item.id === id);
    if (!adjustment?.version || !adjustment.approval_snapshot) {
      setError("Actualice el historial antes de aprobar; falta la previsualización vigente del ajuste.");
      return;
    }
    const key = adjustmentOperationKeys.current[id] ?? crypto.randomUUID();
    adjustmentOperationKeys.current[id] = key;
    setAdjustmentAction(`approve:${id}`);
    try {
      await adjustmentsApi.approve(id, adjustment.version, adjustment.approval_snapshot, key);
      delete adjustmentOperationKeys.current[id];
      await loadAdjustmentsAndBalance();
      success("Ajuste aprobado.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo aprobar el ajuste");
    } finally { setAdjustmentAction(null); }
  }

  async function handleRejectAdjustment(id: string) {
    if (adjustmentAction) return;
    if (rejectReason.trim().length < 3) return;
    setError(null);
    const adjustment = adjustments.find((item) => item.id === id);
    if (!adjustment?.version) {
      setError("Actualice el historial antes de rechazar; falta la versión vigente del ajuste.");
      return;
    }
    const key = adjustmentOperationKeys.current[id] ?? crypto.randomUUID();
    adjustmentOperationKeys.current[id] = key;
    setAdjustmentAction(`reject:${id}`);
    try {
      await adjustmentsApi.reject(id, rejectReason.trim(), adjustment.version, key);
      delete adjustmentOperationKeys.current[id];
      setRejectingId(null);
      setRejectReason("");
      await loadAdjustmentsAndBalance();
      success("Ajuste rechazado.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo rechazar el ajuste");
    } finally { setAdjustmentAction(null); }
  }

  if (!ready || loading) {
    return (
      <AdminShell title="Detalle de empleado">
        <DetailSkeleton sections={4} />
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

      <Link href="/admin/employees" className="btn btn-ghost btn-sm" style={{ marginBottom: "1rem" }}>
        <ArrowLeft size={14} />
        Volver a empleados
      </Link>

      <div className="card card-pad" style={{ marginBottom: "1.1rem" }}>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: "0.8rem" }}>
          <div className="employee-profile-identity" style={{ display: "flex", alignItems: "center", gap: "0.9rem" }}>
            <div className="avatar" style={{ width: 48, height: 48, fontSize: "1.15rem" }}>
              {employee.first_name.charAt(0).toUpperCase()}
            </div>
            <div className="employee-profile-identity-copy">
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

        {/* QR único del empleado */}
        <div style={{ display: "flex", alignItems: "center", gap: "1rem", marginTop: "1rem", flexWrap: "wrap" }}>
          <div
            style={{
              width: 120,
              height: 120,
              padding: 6,
              background: "#ffffff",
              borderRadius: "var(--radius-panel)",
              border: "1px solid var(--ink-border)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
            title="QR único del empleado"
          >
            {qrUrl ? (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                src={qrUrl}
                alt={`QR de ${employee.first_name} ${employee.last_name}`}
                width={108}
                height={108}
                style={{ display: "block" }}
              />
            ) : (
              <Skeleton width={108} height={108} />
            )}
          </div>
          <div style={{ display: "grid", gap: "0.35rem" }}>
            <p className="muted" style={{ fontSize: "0.78rem", maxWidth: 260 }}>
              Código QR único para este empleado. Úsalo para marcar asistencia o imprimirlo en su credencial.
            </p>
            <div className="button-row" aria-label="Descargar código QR">
              <button
                className="btn btn-outline btn-sm"
                type="button"
                onClick={() => void handleDownloadQr("png")}
                disabled={downloadingQr}
              >
                <Download size={14} />
                {downloadingQr && <Spinner />}
                {downloadingQr ? "Descargando…" : "PNG 5 × 5 cm"}
              </button>
              <button className="btn btn-ghost btn-sm" type="button" onClick={() => void handleDownloadQr("svg")} disabled={downloadingQr}>SVG</button>
              <button className="btn btn-ghost btn-sm" type="button" onClick={() => void handleDownloadQr("jpg")} disabled={downloadingQr}>JPG</button>
            </div>
            {canManage && (
              <button
                className="btn btn-outline btn-sm"
                onClick={() => setConfirmQrRotation(true)}
                disabled={rotatingQr}
                style={{ width: "fit-content" }}
              >
                {rotatingQr && <Spinner />}
                {rotatingQr ? "Rotando QR…" : "Rotar QR"}
              </button>
            )}
          </div>
        </div>

        {employee.hire_date && (
          <p className="muted" style={{ fontSize: "0.76rem", marginTop: "0.6rem" }}>
            Ingreso: {employee.hire_date}
          </p>
        )}
      </div>

      {canManage && <EmployeeAttendanceWorkspace ref={workspaceRef} employeeId={employeeId} onAdjustmentMutated={refreshAdjustmentSurfaces} />}

      {/* Jornada laboral */}
      <div className="card card-pad" style={{ marginBottom: "1.1rem" }}>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: "0.6rem", marginBottom: "0.9rem" }}>
          <div>
            <h2 className="card-title">Jornada laboral</h2>
            <p className="card-sub">Horario semanal vigente. Los cambios se guardan sin borrar configuraciones anteriores.</p>
          </div>
          {canManage && (
            <button
              className="btn btn-outline btn-sm"
              onClick={() => {
                if (!showForm && schedule) {
                  setForm({ ...defaultForm(), effective_from: dayAfter(schedule.effective_from) });
                }
                setShowForm(true);
              }}
            >
              <><Plus size={14} /> Nueva jornada</>
            </button>
          )}
        </div>

        {canManage && showForm && <AppDialog labelledBy="schedule-dialog-title" onClose={() => setShowForm(false)} dismissible={!saving} className="employee-profile-dialog employee-profile-dialog--wide">
          <form onSubmit={handleSaveSchedule} className="schedule-form">
            <div className="app-dialog-heading"><div><h2 id="schedule-dialog-title" className="card-title">Nueva jornada laboral</h2><p className="card-sub">El cambio preserva el historial de la jornada anterior.</p></div><AppDialogCloseButton className="btn btn-ghost btn-sm" disabled={saving}>Cerrar</AppDialogCloseButton></div>
            <section className="schedule-form-section">
              <div>
                <label className="label">Vigente desde</label>
                <DateField value={form.effective_from} onChange={(v) => setForm({ ...form, effective_from: v })} required placeholder="Seleccionar" />
              </div>
            </section>
            <section className="schedule-form-section" aria-labelledby="schedule-hours-title">
              <h3 id="schedule-hours-title" className="label">Horas pactadas por día</h3>
              <div className="schedule-hours-grid">
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
              </div>
            </section>
            <section className="schedule-form-section" aria-labelledby="schedule-break-title">
              <h3 id="schedule-break-title" className="label">Reglas de refrigerio</h3>
              <div className="schedule-break-grid">
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
              <div>
                <label className="label">Aplicar refrigerio desde (min)</label>
                <input
                  type="number"
                  min={0}
                  max={1440}
                  step={30}
                  className="input"
                  value={form.break_applies_after_minutes}
                  onChange={(e) => setForm({ ...form, break_applies_after_minutes: Number(e.target.value) })}
                />
              </div>
              </div>
            </section>
            <div className="app-dialog-actions"><AppDialogCloseButton className="btn btn-ghost" disabled={saving}>Cancelar</AppDialogCloseButton><button type="submit" className="btn btn-primary" disabled={saving || !form.effective_from}>
              <Check size={15} />
              {saving && <Spinner />}
              {saving ? "Guardando jornada…" : "Guardar jornada"}
            </button></div>
          </form>
        </AppDialog>}

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
                  <td>{schedule.break_minutes} min desde {schedule.break_applies_after_minutes} min de presencia</td>
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
            <button
              className="btn btn-outline btn-sm"
              onClick={() => {
                if (!showSalaryForm && salary) {
                  setSalaryForm({
                    effective_from: dayAfter(salary.effective_from),
                    monthly_salary: salary.monthly_salary,
                    overtime_enabled: salary.overtime_enabled,
                    use_custom_overtime_rates: salary.use_custom_overtime_rates,
                    custom_first_two_hours_rate: salary.custom_first_two_hours_rate,
                    custom_additional_hours_rate: salary.custom_additional_hours_rate,
                  });
                }
                setShowSalaryForm(true);
              }}
            >
              <><Coins size={14} /> Configurar sueldo</>
            </button>
          </div>

          {showSalaryForm && <AppDialog labelledBy="salary-dialog-title" onClose={() => setShowSalaryForm(false)} dismissible={!savingSalary} className="employee-profile-dialog">
            <form onSubmit={handleSaveSalary} className="schedule-form">
              <div className="app-dialog-heading"><div><h2 id="salary-dialog-title" className="card-title">Configurar sueldo</h2><p className="card-sub">El nuevo valor preserva el historial y se aplica desde la fecha indicada.</p></div><AppDialogCloseButton className="btn btn-ghost btn-sm" disabled={savingSalary}>Cerrar</AppDialogCloseButton></div>
              <div style={{ display: "grid", gap: "0.7rem", gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))" }}>
                <div>
                  <label className="label">Vigente desde</label>
                  <DateField value={salaryForm.effective_from} onChange={(v) => setSalaryForm({ ...salaryForm, effective_from: v })} required placeholder="Seleccionar" />
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
                    <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", paddingTop: "1.4rem" }}>
                      <input
                        type="checkbox"
                        id="use-custom-overtime"
                        checked={salaryForm.use_custom_overtime_rates}
                        onChange={(e) =>
                          setSalaryForm({ ...salaryForm, use_custom_overtime_rates: e.target.checked })
                        }
                        style={{ width: 16, height: 16, accentColor: "var(--primary-blue)" }}
                      />
                      <label htmlFor="use-custom-overtime" style={{ fontSize: "0.82rem", fontWeight: 600, color: "var(--gray-600)" }}>
                        Usar política personalizada
                      </label>
                    </div>
                    <p style={{ fontSize: "0.72rem", color: "var(--muted)", margin: 0, gridColumn: "1 / -1" }}>
                      Si no activas esto, se usa la política general de la empresa (mínimos legales 25% / 35%).
                    </p>
                    {salaryForm.use_custom_overtime_rates && (
                      <>
                        <div>
                          <label className="label">Primeras 2 h (%)</label>
                          <input
                            type="number"
                            min={25}
                            step={0.01}
                            className="input"
                            value={salaryForm.custom_first_two_hours_rate ?? ""}
                            onChange={(e) => setSalaryForm({ ...salaryForm, custom_first_two_hours_rate: e.target.value || null })}
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
                            value={salaryForm.custom_additional_hours_rate ?? ""}
                            onChange={(e) => setSalaryForm({ ...salaryForm, custom_additional_hours_rate: e.target.value || null })}
                            required
                          />
                          <p style={{ fontSize: "0.68rem", color: "var(--muted)", margin: "0.2rem 0 0" }}>Mínimo 35%</p>
                        </div>
                      </>
                    )}
                  </>
                )}
              </div>
              <div className="app-dialog-actions"><AppDialogCloseButton className="btn btn-ghost" disabled={savingSalary}>Cancelar</AppDialogCloseButton><button
                type="submit"
                className="btn btn-primary"
                disabled={savingSalary || !salaryForm.effective_from || !salaryForm.monthly_salary}
              >
                <Check size={15} />
                {savingSalary && <Spinner />}
                {savingSalary ? "Guardando sueldo…" : "Guardar sueldo"}
              </button></div>
            </form>
          </AppDialog>}

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
            <p className="card-sub">Saldo = trabajado − esperado + ajustes (sin horas extra). Las HE aprobadas se muestran aparte.</p>
          </div>
          {canManage && (
            <button className="btn btn-outline btn-sm" onClick={() => setShowAdjForm(true)}>
              <Plus size={14} /> Nuevo ajuste
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
            <div className="stat-card">
              <div className="stat-label">Horas extra</div>
              <div className="stat-value" style={{ fontSize: "1.1rem" }}>{signedMinutes(balance.overtime_minutes)}</div>
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
                {detecting && <Spinner />}
                {detecting ? "Consultando sobretiempo…" : "Detectar sobretiempo del mes"}
              </button>
            </div>

            {overtimeValue && overtimeValue.overtime_minutes > 0 && (
              <div className="card" style={{ padding: "0.6rem 0.8rem", marginBottom: "0.6rem", boxShadow: "none", display: "flex", flexWrap: "wrap", gap: "0.4rem 1.2rem", fontSize: "0.82rem" }}>
                <span className="muted">
                  Tiempo aprobado: <strong style={{ color: "var(--text)" }}>{signedMinutes(overtimeValue.overtime_minutes)}</strong>
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
                        {activeOvertimeByDate.get(day.work_date) ? (
                          <span className={`badge ${activeOvertimeByDate.get(day.work_date)?.status === "APPROVED" ? "badge-green" : "badge-amber"}`}>
                            {activeOvertimeByDate.get(day.work_date)?.status === "APPROVED" ? "Aprobada" : "Pendiente"}
                          </span>
                        ) : (
                          <button className="btn btn-primary btn-sm" onClick={() => void registerOvertime(day)} disabled={registeringOvertimeDay === day.work_date}>
                            {registeringOvertimeDay === day.work_date ? "Registrando…" : "Registrar como HE"}
                          </button>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              ))}
          </div>
      )}

      {confirmQrRotation && (
        <AppDialog labelledBy="rotate-qr-title" onClose={() => setConfirmQrRotation(false)} dismissible={!rotatingQr}>
          <h2 id="rotate-qr-title" className="card-title">¿Rotar el código QR?</h2>
          <p className="card-sub">El QR actual dejará de identificar a este empleado. Usa esta acción solo si se perdió o comprometió la credencial.</p>
          <div className="app-dialog-actions">
            <AppDialogCloseButton className="btn btn-outline" disabled={rotatingQr}>Cancelar</AppDialogCloseButton>
            <button className="btn btn-danger" type="button" onClick={async () => { await handleRotateQr(); setConfirmQrRotation(false); }} disabled={rotatingQr} aria-busy={rotatingQr}>{rotatingQr && <Spinner />}{rotatingQr ? "Rotando QR…" : "Rotar QR"}</button>
          </div>
        </AppDialog>
      )}

        {canManage && showAdjForm && <AppDialog labelledBy="adjustment-create-dialog-title" onClose={() => setShowAdjForm(false)} dismissible={!savingAdj} className="employee-profile-dialog">
          <form onSubmit={handleCreateAdjustment} className="schedule-form">
            <div className="app-dialog-heading"><div><h2 id="adjustment-create-dialog-title" className="card-title">Nuevo ajuste</h2><p className="card-sub">El ajuste queda pendiente de aprobación y conserva una traza auditable.</p></div><AppDialogCloseButton className="btn btn-ghost btn-sm" disabled={savingAdj}>Cerrar</AppDialogCloseButton></div>
            <div style={{ display: "grid", gap: "0.7rem", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))" }}>
              <div>
                <label className="label">Fecha</label>
                <DateField value={adjForm.adjustment_date} onChange={(v) => setAdjForm({ ...adjForm, adjustment_date: v })} required placeholder="Seleccionar" />
              </div>
              <div>
                <label className="label">Tiempo a sumar o descontar (minutos)</label>
                <input
                  type="number"
                  min={-1440}
                  max={1440}
                  className="input"
                  value={adjForm.minutes}
                  onChange={(e) => setAdjForm({ ...adjForm, minutes: Number(e.target.value) })}
                  required
                />
                <small className="muted">Use un número positivo para sumar tiempo y uno negativo para descontarlo.</small>
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
            <div className="app-dialog-actions"><AppDialogCloseButton className="btn btn-ghost" disabled={savingAdj}>Cancelar</AppDialogCloseButton><button type="submit" className="btn btn-primary" disabled={savingAdj || adjForm.reason.trim().length < 3}>
              <Plus size={15} />
              {savingAdj && <Spinner />}
              {savingAdj ? "Creando ajuste…" : "Crear ajuste (pendiente)"}
            </button></div>
          </form>
        </AppDialog>}

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
                    {canManage && !adj.voided_at && (
                      <span className="button-row">
                        <button className="btn btn-outline btn-sm" type="button" onClick={() => workspaceRef.current?.editAdjustment(adj)} disabled={adjustmentAction !== null}>Editar</button>
                        <button className="btn btn-danger btn-sm" type="button" onClick={() => workspaceRef.current?.voidAdjustment(adj)} disabled={adjustmentAction !== null}>Eliminar</button>
                      </span>
                    )}
                    {canManage && adj.status === "PENDING" && (
                      <>
                        <button className="btn btn-green btn-sm" onClick={() => handleApproveAdjustment(adj.id)} disabled={adjustmentAction !== null} aria-busy={adjustmentAction === `approve:${adj.id}`}>
                          {adjustmentAction === `approve:${adj.id}` ? <Spinner /> : <Check size={13} />}
                          {adjustmentAction === `approve:${adj.id}` ? "Aprobando…" : "Aprobar"}
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
                            <button className="btn btn-danger btn-sm" onClick={() => handleRejectAdjustment(adj.id)} disabled={rejectReason.trim().length < 3 || adjustmentAction !== null} aria-busy={adjustmentAction === `reject:${adj.id}`}>
                              {adjustmentAction === `reject:${adj.id}` && <Spinner />}{adjustmentAction === `reject:${adj.id}` ? "Rechazando…" : "Confirmar"}
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
