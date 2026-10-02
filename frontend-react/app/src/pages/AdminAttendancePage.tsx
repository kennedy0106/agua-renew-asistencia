
import { Link } from "react-router-dom";
import { useCallback, useEffect, useRef, useState } from "react";
import AdminShell from "@/components/AdminShell";
import AppDialog, { AppDialogCloseButton } from "@/components/AppDialog";
import { useNotifications } from "@/components/Notifications";
import { useAdminUser } from "@/components/AdminSession";
import DateField from "@/components/DateField";
import { Alert, Camera, Clock, Download, Pencil, X } from "@/components/Icons";
import { Spinner, TableSkeleton } from "@/components/Loading";
import { TablePagination, useTablePagination } from "@/components/Pagination";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatOperationalDate } from "@/lib/dates";
import {
  API_URL,
  ApiError,
  attendanceAdminApi,
  AttendanceDailyItem,
  AttendanceListItem,
  employeesApi,
  Employee,
} from "@/lib/api";

const MANAGE_ROLES = ["ADMIN", "BOSS"];

function currentLimaMonth(): { from: string; to: string } {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Lima",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const [year, month] = today.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    from: `${year}-${String(month).padStart(2, "0")}-01`,
    to: `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`,
  };
}

function formatClock(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("es-PE", { timeZone: "America/Lima", hour: "2-digit", minute: "2-digit" });
}

function formatMinutes(minutes: number | null): string {
  if (minutes === null) return "—";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return `${h} h ${m.toString().padStart(2, "0")}`;
}

function formatDifference(minutes: number | null): string {
  if (minutes === null) return "—";
  const sign = minutes > 0 ? "+" : "";
  return `${sign}${formatMinutes(minutes)}`;
}

function formatIncidentCode(code: string): string {
  const labels: Record<string, string> = {
    EARLY_ENTRY: "Entrada anticipada",
    LATE_ENTRY: "Entrada tardía",
    EARLY_EXIT: "Salida anticipada",
    MISSING_ENTRY: "Sin entrada",
    MISSING_EXIT: "Sin salida",
    OVERTIME: "Horas extra",
    INCOMPLETE: "Jornada incompleta",
    LONG_ATTENDANCE: "Jornada excesivamente larga",
    OPEN_ATTENDANCE: "Entrada sin salida",
    OVERLAPPING_SESSIONS: "Sesiones superpuestas",
  };
  if (labels[code]) return labels[code];
  const fallback = code.replace(/[_-]+/g, " ").trim().toLocaleLowerCase("es-PE");
  return fallback ? `${fallback.charAt(0).toLocaleUpperCase("es-PE")}${fallback.slice(1)}` : "Incidencia sin detalle";
}

/** Estado de un intento de kiosco en lenguaje cotidiano (evita jerga interna). */
function kioskAttemptStateLabel(state: string): string {
  const labels: Record<string, string> = {
    UNKNOWN: "sin datos suficientes para revisarlo",
    CANCELLED: "cancelado sin crear marcación",
    REVIEWED: "revisado y confirmado",
    CONFIRMED: "confirmado en la tablet",
    CONFIRMED_WINDOW_ELAPSED: "confirmado, pero fuera del plazo de revisión",
    INCONSISTENT: "inconsistente: requiere soporte técnico",
    EVIDENCE_ONLY: "solo tiene evidencia, sin marcación registrada",
  };
  return labels[state] ?? "en un estado no reconocido";
}

function kioskActionLabel(action: string | null): string | null {
  if (action === "CHECK_IN") return "Entrada";
  if (action === "CHECK_OUT") return "Salida";
  return null;
}

function toLocalDateAndTime(iso: string | null): { date: string; time: string } {
  if (!iso) return { date: "", time: "" };
  const d = new Date(iso);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
}

function fromLocalInput(local: string): string | null {
  if (!local) return null;
  return new Date(local).toISOString();
}

function timestampFromParts(date: string, time: string): { value: string | null; incomplete: boolean } {
  if (!date && !time) return { value: null, incomplete: false };
  if (!date || !time) return { value: null, incomplete: true };
  return { value: fromLocalInput(`${date}T${time}`), incomplete: false };
}

function EvidenceImage({ label, src, loading }: { label: string; src: string | null; loading: boolean }) {
  return <figure className="evidence-image">
    <figcaption className="label">{label}</figcaption>
    {loading ? <div className="skeleton evidence-skeleton" aria-label={`Cargando ${label.toLowerCase()}`} /> : src ?
      <img src={src} alt={label} /> : <p className="muted">Sin {label.toLowerCase()}.</p>}
  </figure>;
}

export default function AdminAttendancePage() {
  const [initialRange] = useState(currentLimaMonth);
  const user = useAdminUser();
  const [records, setRecords] = useState<AttendanceListItem[]>([]);
  const [daily, setDaily] = useState<AttendanceDailyItem[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [employeeFilter, setEmployeeFilter] = useState("");
  const [dateFrom, setDateFrom] = useState(initialRange.from);
  const [dateTo, setDateTo] = useState(initialRange.to);
  const [statusFilter, setStatusFilter] = useState("");

  const [correcting, setCorrecting] = useState<AttendanceListItem | null>(null);
  const [corrCheckInDate, setCorrCheckInDate] = useState("");
  const [corrCheckInTime, setCorrCheckInTime] = useState("");
  const [corrCheckOutDate, setCorrCheckOutDate] = useState("");
  const [corrCheckOutTime, setCorrCheckOutTime] = useState("");
  const [corrNotes, setCorrNotes] = useState("");
  const [corrReason, setCorrReason] = useState("");
  const [savingCorrection, setSavingCorrection] = useState(false);
  const [correctionError, setCorrectionError] = useState<string | null>(null);
  const [corrFieldErrors, setCorrFieldErrors] = useState<{
    checkInDate?: boolean;
    checkInTime?: boolean;
    checkOutDate?: boolean;
    checkOutTime?: boolean;
    reason?: boolean;
  }>({});
  const [photosFor, setPhotosFor] = useState<string | null>(null);
  const [photoUrls, setPhotoUrls] = useState<{ check_in: string | null; check_out: string | null; missing: string | null }>({
    check_in: null,
    check_out: null,
    missing: null,
  });
  const [attemptNonce, setAttemptNonce] = useState("");
  const [attemptReason, setAttemptReason] = useState("");
  const [attemptLookup, setAttemptLookup] = useState<string | null>(null);
  const [reviewingAttempt, setReviewingAttempt] = useState(false);
  const [adjustingBreak, setAdjustingBreak] = useState<AttendanceDailyItem | null>(null);
  const [breakMinutes, setBreakMinutes] = useState("0");
  const [breakReason, setBreakReason] = useState("");
  const [savingBreak, setSavingBreak] = useState(false);
  const [breakError, setBreakError] = useState<string | null>(null);
  const breakInputRef = useRef<HTMLInputElement>(null);
  const breakTriggerRef = useRef<HTMLButtonElement | null>(null);
  const { success } = useNotifications();

  const canManage = user ? MANAGE_ROLES.includes(user.role) : false;
  const dailyPagination = useTablePagination(daily, `${employeeFilter}:${dateFrom}:${dateTo}:${statusFilter}:${daily.length}`);
  const recordsPagination = useTablePagination(records, `${employeeFilter}:${dateFrom}:${dateTo}:${statusFilter}:${records.length}`);

  useEffect(() => {
    employeesApi.list().then(setEmployees).catch(() => undefined);
  }, []);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const [list, dailyList] = await Promise.all([
        attendanceAdminApi.list({
          employee_id: employeeFilter || undefined,
          date_from: dateFrom || undefined,
          date_to: dateTo || undefined,
          status: statusFilter || undefined,
        }),
        attendanceAdminApi.daily({
          employee_id: employeeFilter || undefined,
          date_from: dateFrom || undefined,
          date_to: dateTo || undefined,
        }),
      ]);
      setRecords(list);
      setDaily(dailyList);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Error de conexión con el servidor");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [employeeFilter, dateFrom, dateTo, statusFilter]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!adjustingBreak) return;
    breakInputRef.current?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !savingBreak) {
        setAdjustingBreak(null);
        setBreakError(null);
        window.requestAnimationFrame(() => breakTriggerRef.current?.focus());
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [adjustingBreak, savingBreak]);

  useEffect(() => {
    function onWindowKeyDownCapture(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      const portaledPanel = document.querySelector(".datefield-panel.is-portaled");
      if (portaledPanel) {
        event.stopImmediatePropagation();
        event.preventDefault();
        const expandedTrigger = document.querySelector<HTMLButtonElement>('.datefield-trigger[aria-expanded="true"]');
        if (expandedTrigger) {
          expandedTrigger.click();
          expandedTrigger.focus();
        } else {
          document.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        }
      }
    }
    window.addEventListener("keydown", onWindowKeyDownCapture, true);
    return () => window.removeEventListener("keydown", onWindowKeyDownCapture, true);
  }, []);

  useEffect(() => () => {
    if (photoUrls.check_in) URL.revokeObjectURL(photoUrls.check_in);
    if (photoUrls.check_out) URL.revokeObjectURL(photoUrls.check_out);
  }, [photoUrls]);

  async function loadPhotos(recordId: string) {
    setPhotosFor(recordId);
    setPhotoUrls({ check_in: null, check_out: null, missing: null });
    try {
      const meta = await attendanceAdminApi.evidenceMeta(recordId);
      const [checkInUrl, checkOutUrl] = await Promise.all([
        meta.check_in?.id ? attendanceAdminApi.evidenceImage(meta.check_in.id) : null,
        meta.check_out?.id ? attendanceAdminApi.evidenceImage(meta.check_out.id) : null,
      ]);
      const missing =
        !meta.check_in?.available && !meta.check_out?.available
          ? "Este registro es anterior a la evidencia fotográfica o nunca tuvo foto."
          : null;
      setPhotoUrls({ check_in: checkInUrl, check_out: checkOutUrl, missing });
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "No se pudieron cargar las fotos";
      setPhotoUrls({ check_in: null, check_out: null, missing: message });
      setError(message);
    }
  }

  function startCorrection(record: AttendanceListItem) {
    const checkIn = toLocalDateAndTime(record.check_in_at);
    const checkOut = toLocalDateAndTime(record.check_out_at);
    setCorrecting(record);
    setCorrCheckInDate(checkIn.date);
    setCorrCheckInTime(checkIn.time);
    setCorrCheckOutDate(checkOut.date);
    setCorrCheckOutTime(checkOut.time);
    setCorrNotes(record.notes ?? "");
    setCorrReason("");
    setCorrectionError(null);
    setCorrFieldErrors({});
    setError(null);
    setPhotosFor(null);
  }

  function closeCorrectionDialog() {
    if (savingCorrection) return;
    setCorrecting(null);
    setCorrectionError(null);
    setCorrFieldErrors({});
  }

  async function handleSaveCorrection(event: React.FormEvent) {
    event.preventDefault();
    if (!correcting) return;
    const checkIn = timestampFromParts(corrCheckInDate, corrCheckInTime);
    const checkOut = timestampFromParts(corrCheckOutDate, corrCheckOutTime);
    const errors: {
      checkInDate?: boolean;
      checkInTime?: boolean;
      checkOutDate?: boolean;
      checkOutTime?: boolean;
      reason?: boolean;
    } = {};

    if (corrCheckInDate && !corrCheckInTime) errors.checkInTime = true;
    if (!corrCheckInDate && corrCheckInTime) errors.checkInDate = true;
    if (corrCheckOutDate && !corrCheckOutTime) errors.checkOutTime = true;
    if (!corrCheckOutDate && corrCheckOutTime) errors.checkOutDate = true;
    if (corrReason.trim().length < 3) errors.reason = true;

    if (checkIn.incomplete || checkOut.incomplete || errors.reason) {
      setCorrFieldErrors(errors);
      setCorrectionError(
        errors.reason && !checkIn.incomplete && !checkOut.incomplete
          ? "El motivo de la corrección es obligatorio (mínimo 3 caracteres)."
          : "Complete la fecha y la hora de cada marcación que desea registrar."
      );
      return;
    }
    setCorrFieldErrors({});
    setSavingCorrection(true);
    setCorrectionError(null);
    try {
      await attendanceAdminApi.correct(correcting.id, {
        check_in_at: checkIn.value,
        check_out_at: checkOut.value,
        notes: corrNotes.trim() || null,
        reason: corrReason.trim(),
      });
      setCorrecting(null);
      setCorrectionError(null);
      setCorrFieldErrors({});
      await load();
      success("Corrección guardada. El registro fue recalculado.");
    } catch (err) {
      setCorrectionError(err instanceof ApiError ? err.message : "No se pudo corregir el registro");
    } finally {
      setSavingCorrection(false);
    }
  }

  function openBreakDialog(day: AttendanceDailyItem, trigger: HTMLButtonElement) {
    breakTriggerRef.current = trigger;
    setAdjustingBreak(day);
    setBreakMinutes(String(day.override_requested_minutes ?? day.break_minutes));
    setBreakReason("");
    setBreakError(null);
    setError(null);
  }

  function closeBreakDialog() {
    if (savingBreak) return;
    setAdjustingBreak(null);
    setBreakError(null);
    window.requestAnimationFrame(() => breakTriggerRef.current?.focus());
  }

  async function saveBreak(event: React.FormEvent) {
    event.preventDefault();
    if (!adjustingBreak) return;
    const minutes = Number(breakMinutes);
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > adjustingBreak.gross_minutes) {
      setBreakError("Ingrese minutos enteros entre 0 y la presencia efectiva.");
      return;
    }
    setSavingBreak(true);
    setBreakError(null);
    try {
      await attendanceAdminApi.setBreakOverride(adjustingBreak.employee_id, adjustingBreak.work_date, minutes, breakReason.trim());
      setAdjustingBreak(null);
      await load();
      success("Refrigerio actualizado para esta jornada.");
      window.requestAnimationFrame(() => breakTriggerRef.current?.focus());
    } catch (err) {
      setBreakError(err instanceof ApiError ? err.message : "No se pudo actualizar el refrigerio");
    } finally {
      setSavingBreak(false);
    }
  }

  async function resetBreakToAutomatic() {
    if (!adjustingBreak) return;
    setSavingBreak(true);
    setBreakError(null);
    try {
      await attendanceAdminApi.clearBreakOverride(adjustingBreak.employee_id, adjustingBreak.work_date, breakReason.trim());
      setAdjustingBreak(null);
      await load();
      success("Se restauró el cálculo automático del refrigerio.");
      window.requestAnimationFrame(() => breakTriggerRef.current?.focus());
    } catch (err) {
      setBreakError(err instanceof ApiError ? err.message : "No se pudo volver al cálculo automático");
    } finally {
      setSavingBreak(false);
    }
  }

  async function lookupKioskAttempt() {
    if (!canManage) return;
    setReviewingAttempt(true);
    setError(null);
    try {
      const inspected = await attendanceAdminApi.inspectAttempt(attemptNonce.trim());
      const persona = inspected.employee_name ?? inspected.employee_id;
      const accion = kioskActionLabel(inspected.action);
      const estado = kioskAttemptStateLabel(inspected.state);
      const siguiente = inspected.automatable
        ? "Puedes revisarlo y habilitar la tablet."
        : "No se puede resolver desde aquí; pide apoyo a soporte.";
      setAttemptLookup(`${persona}${accion ? ` · ${accion}` : ""}: ${estado}. ${siguiente}`);
    } catch (err) {
      setAttemptLookup(null);
      setError(err instanceof ApiError ? err.message : "No se encontró el intento");
    } finally {
      setReviewingAttempt(false);
    }
  }

  async function reviewKioskAttempt(event: React.FormEvent) {
    event.preventDefault();
    if (!canManage) return;
    setReviewingAttempt(true);
    setError(null);
    try {
      await attendanceAdminApi.reviewAttempt(attemptNonce.trim(), attemptReason.trim());
      setAttemptReason("");
      const inspected = await attendanceAdminApi.inspectAttempt(attemptNonce.trim());
      const persona = inspected.employee_name ?? inspected.employee_id;
      setAttemptLookup(`${persona}: revisión registrada (${kioskAttemptStateLabel(inspected.state)}). El registro original no se modificó.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo revisar el intento");
    } finally {
      setReviewingAttempt(false);
    }
  }

  function exportCsv() {
    const params = new URLSearchParams();
    if (employeeFilter) params.set("employee_id", employeeFilter);
    if (dateFrom) params.set("date_from", dateFrom);
    if (dateTo) params.set("date_to", dateTo);
    if (statusFilter) params.set("status", statusFilter);
    const qs = params.toString();
    window.open(`${API_URL}/api/v1/exports/attendance.csv${qs ? `?${qs}` : ""}`);
  }

  return (
    <AdminShell
      title="Asistencia"
      subtitle={`${records.length} marcación(es) en el rango · revisa el día, corrige registros o ajusta el refrigerio.`}
    >
      {error && (
        <p className="alert alert-error" role="alert">
          <Alert size={15} style={{ marginTop: 2, flexShrink: 0 }} />
          {error}
        </p>
      )}

      <details className="term-help">
        <summary>
          <span><strong>¿Qué significa cada columna?</strong><small>Tiempo presente, efectivo, jornada esperada y saldo del día</small></span>
        </summary>
        <dl className="term-help-grid">
          <div><dt>Tiempo presente</dt><dd>Desde la primera entrada hasta la última salida, sin descontar el refrigerio.</dd></div>
          <div><dt>Tiempo efectivo</dt><dd>Tiempo presente menos el refrigerio. Es el tiempo que cuenta para el pago.</dd></div>
          <div><dt>Jornada esperada</dt><dd>Lo que la persona debía trabajar ese día según su horario.</dd></div>
          <div><dt>Saldo del día</dt><dd>Tiempo efectivo menos jornada esperada. En ámbar faltó tiempo; en verde trabajó de más.</dd></div>
          <div><dt>Incidencias</dt><dd>Situaciones a revisar, como entrada tardía, salida faltante u horas extra.</dd></div>
        </dl>
      </details>

      <div className="toolbar attendance-toolbar">
        {canManage && (
          <Link className="btn btn-outline btn-sm attendance-toolbar-action" to="/admin/attendance/history" title="Registra horas de días anteriores al inicio del sistema">
            <Clock size={15} /> Cargar horas anteriores
          </Link>
        )}
        <div className="attendance-toolbar-filter attendance-toolbar-filter--employee" style={{ minWidth: "11rem", flex: "1 1 13rem" }}>
          <Select value={employeeFilter || "__all"} onValueChange={(v) => setEmployeeFilter(v === "__all" ? "" : v)}>
            <SelectTrigger aria-label="Empleado" className="attendance-employee-select" style={{ width: "100%" }}>
              <SelectValue placeholder="Todos los empleados" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all">Todos los empleados</SelectItem>
              {employees.map((e) => (
                <SelectItem key={e.id} value={e.id}>
                  {e.first_name} {e.last_name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="attendance-toolbar-filter attendance-toolbar-filter--dates" style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem", flex: "0 0 auto" }}>
          <DateField value={dateFrom} onChange={setDateFrom} aria-label="Fecha desde" placeholder="Desde" />
          <span className="muted attendance-toolbar-range-separator" style={{ fontSize: "0.8rem", padding: "0 0.15rem", flexShrink: 0 }}>a</span>
          <DateField value={dateTo} onChange={setDateTo} aria-label="Fecha hasta" placeholder="Hasta" />
        </div>
        <div className="attendance-toolbar-filter attendance-toolbar-filter--status" style={{ minWidth: "9.5rem", flex: "0 1 10.5rem" }}>
          <Select value={statusFilter || "__all"} onValueChange={(v) => setStatusFilter(v === "__all" ? "" : v)}>
            <SelectTrigger aria-label="Estado" className="attendance-status-select" style={{ width: "100%" }}>
              <SelectValue placeholder="Todos los estados" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all">Todos los estados</SelectItem>
              <SelectItem value="OPEN">Sin salida registrada</SelectItem>
              <SelectItem value="COMPLETE">Jornada completada</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {(employeeFilter || dateFrom || dateTo || statusFilter) && (
          <button className="btn btn-ghost btn-sm attendance-toolbar-clear" type="button" onClick={() => { setEmployeeFilter(""); setDateFrom(""); setDateTo(""); setStatusFilter(""); }}>
            <X size={14} /> Limpiar filtros
          </button>
        )}
        {refreshing && !loading && <span className="toolbar-status" role="status"><Spinner /> Actualizando…</span>}
        <span className="spacer" />
        <button className="btn btn-outline btn-sm attendance-toolbar-export" onClick={exportCsv} title="Descarga un archivo CSV para abrirlo en Excel">
          <Download size={15} />
          Descargar para Excel
        </button>
      </div>

      {canManage && (
        <details className="recovery-panel surface-material">
          <summary>
            <span>
              <strong>Recuperar un intento de la tablet</strong>
              <small>Solo si la tablet muestra una referencia de recuperación.</small>
            </span>
            <span className="recovery-panel-action">Abrir revisión</span>
          </summary>
          <form className="card card-pad recovery-panel-form" onSubmit={reviewKioskAttempt}>
            <p className="muted recovery-panel-copy">
              Escribe el código que aparece en la pantalla de la tablet. Conserva el evento original; no corrige horas ni borra fotos.
            </p>
            <div style={{ display: "grid", gap: "0.7rem", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))" }}>
              <div>
                <label className="label" htmlFor="kiosk-attempt-nonce">
                  Código de incidente de la tablet
                </label>
                <input
                  id="kiosk-attempt-nonce"
                  className="input"
                  value={attemptNonce}
                  onChange={(e) => setAttemptNonce(e.target.value)}
                  placeholder="Ej. A1B2C3"
                  data-testid="admin-attempt-nonce"
                />
              </div>
              <div>
                <label className="label" htmlFor="kiosk-attempt-reason">
                  Motivo
                </label>
                <input
                  id="kiosk-attempt-reason"
                  className="input"
                  value={attemptReason}
                  onChange={(e) => setAttemptReason(e.target.value)}
                  minLength={3}
                  maxLength={500}
                  placeholder="Revisión autorizada"
                  data-testid="admin-attempt-reason"
                />
                <p className="muted" style={{ fontSize: "0.75rem", margin: "0.25rem 0 0" }}>
                  Máximo 500 caracteres. El servidor rechaza textos más largos o solo espacios.
                </p>
              </div>
            </div>
            {attemptLookup && (
              <p className="muted" style={{ marginTop: "0.6rem" }} data-testid="admin-attempt-lookup">
                {attemptLookup}
              </p>
            )}
            <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.7rem", flexWrap: "wrap" }}>
              <button type="button" className="btn btn-outline btn-sm" disabled={reviewingAttempt || !attemptNonce.trim()} onClick={() => void lookupKioskAttempt()}>
                Consultar intento
              </button>
              <button type="submit" className="btn btn-amber btn-sm" disabled={reviewingAttempt || attemptNonce.trim().length < 1 || attemptReason.trim().length < 3}>
                {reviewingAttempt && <Spinner />}
                {reviewingAttempt ? "Guardando revisión…" : "Revisar y habilitar tablet"}
              </button>
            </div>
          </form>
        </details>
      )}

      {photosFor && (
        <AppDialog labelledBy="evidence-dialog-title" onClose={() => setPhotosFor(null)} className="evidence-dialog">
          <div className="app-dialog-heading"><div><h2 id="evidence-dialog-title">Evidencia fotográfica</h2><p className="muted">Entrada y salida del registro seleccionado.</p></div><AppDialogCloseButton className="btn btn-ghost btn-sm" aria-label="Cerrar evidencia"><X size={15} /></AppDialogCloseButton></div>
          <div className="evidence-grid">
            <EvidenceImage label="Foto de entrada" src={photoUrls.check_in} loading={!photoUrls.missing && !photoUrls.check_in && !photoUrls.check_out} />
            <EvidenceImage label="Foto de salida" src={photoUrls.check_out} loading={!photoUrls.missing && !photoUrls.check_in && !photoUrls.check_out} />
          </div>
          {photoUrls.missing && <p className="muted">{photoUrls.missing}</p>}
        </AppDialog>
      )}

      {correcting && canManage && (
        <AppDialog labelledBy="correction-dialog-title" describedBy="correction-dialog-description" onClose={closeCorrectionDialog} dismissible={!savingCorrection} className="correction-dialog">
          <form onSubmit={handleSaveCorrection} aria-busy={savingCorrection} className="correction-form">
            <div className="app-dialog-heading">
              <div>
                <h2 id="correction-dialog-title">Corregir registro</h2>
                <p id="correction-dialog-description" className="muted">
                  {correcting.employee_name ?? "Registro seleccionado"} · {formatOperationalDate(correcting.work_date)}. Actualice las marcaciones y deje el motivo para el historial del equipo.
                </p>
              </div>
              <AppDialogCloseButton className="btn btn-ghost btn-sm" disabled={savingCorrection} aria-label="Cerrar corrección">
                <X size={15} />
              </AppDialogCloseButton>
            </div>
            {correctionError && <p className="alert alert-error" role="alert" aria-live="assertive">{correctionError}</p>}
            <div className="correction-fields">
              <section className="correction-timestamp" aria-labelledby="correction-check-in-label">
                <h3 id="correction-check-in-label" className="label">Entrada</h3>
                <div className="correction-date-time">
                  <div className={`correction-datefield${corrFieldErrors.checkInDate ? " is-invalid" : ""}`}>
                    <span className="label">Fecha</span>
                    <DateField
                      value={corrCheckInDate}
                      onChange={(d) => {
                        setCorrCheckInDate(d);
                        setCorrFieldErrors((prev) => ({ ...prev, checkInDate: false }));
                      }}
                      aria-label="Fecha de entrada"
                      placeholder="Seleccionar fecha"
                      disabled={savingCorrection}
                    />
                    {corrFieldErrors.checkInDate && (
                      <span className="error-hint" style={{ color: "var(--expense-red, #b42318)", fontSize: "0.75rem", display: "block", marginTop: "0.2rem" }} role="alert">
                        Indique la fecha de entrada.
                      </span>
                    )}
                  </div>
                  <div>
                    <label className="label" htmlFor="correction-check-in-time">Hora</label>
                    <input
                      id="correction-check-in-time"
                      type="time"
                      className={`input${corrFieldErrors.checkInTime ? " is-invalid" : ""}`}
                      aria-invalid={corrFieldErrors.checkInTime ? "true" : undefined}
                      aria-describedby={corrFieldErrors.checkInTime ? "corr-checkin-time-error" : undefined}
                      style={corrFieldErrors.checkInTime ? { borderColor: "var(--expense-red, #b42318)" } : undefined}
                      value={corrCheckInTime}
                      onChange={(e) => {
                        setCorrCheckInTime(e.target.value);
                        setCorrFieldErrors((prev) => ({ ...prev, checkInTime: false }));
                      }}
                      disabled={savingCorrection}
                    />
                    {corrFieldErrors.checkInTime && (
                      <span id="corr-checkin-time-error" className="error-hint" style={{ color: "var(--expense-red, #b42318)", fontSize: "0.75rem", display: "block", marginTop: "0.2rem" }} role="alert">
                        Indique la hora de entrada.
                      </span>
                    )}
                  </div>
                </div>
              </section>
              <section className="correction-timestamp" aria-labelledby="correction-check-out-label">
                <h3 id="correction-check-out-label" className="label">Salida</h3>
                <div className="correction-date-time">
                  <div className={`correction-datefield${corrFieldErrors.checkOutDate ? " is-invalid" : ""}`}>
                    <span className="label">Fecha</span>
                    <DateField
                      value={corrCheckOutDate}
                      onChange={(d) => {
                        setCorrCheckOutDate(d);
                        setCorrFieldErrors((prev) => ({ ...prev, checkOutDate: false }));
                      }}
                      aria-label="Fecha de salida"
                      placeholder="Seleccionar fecha"
                      disabled={savingCorrection}
                    />
                    {corrFieldErrors.checkOutDate && (
                      <span className="error-hint" style={{ color: "var(--expense-red, #b42318)", fontSize: "0.75rem", display: "block", marginTop: "0.2rem" }} role="alert">
                        Indique la fecha de salida.
                      </span>
                    )}
                  </div>
                  <div>
                    <label className="label" htmlFor="correction-check-out-time">Hora</label>
                    <input
                      id="correction-check-out-time"
                      type="time"
                      className={`input${corrFieldErrors.checkOutTime ? " is-invalid" : ""}`}
                      aria-invalid={corrFieldErrors.checkOutTime ? "true" : undefined}
                      aria-describedby={corrFieldErrors.checkOutTime ? "corr-checkout-time-error" : undefined}
                      style={corrFieldErrors.checkOutTime ? { borderColor: "var(--expense-red, #b42318)" } : undefined}
                      value={corrCheckOutTime}
                      onChange={(e) => {
                        setCorrCheckOutTime(e.target.value);
                        setCorrFieldErrors((prev) => ({ ...prev, checkOutTime: false }));
                      }}
                      disabled={savingCorrection}
                    />
                    {corrFieldErrors.checkOutTime && (
                      <span id="corr-checkout-time-error" className="error-hint" style={{ color: "var(--expense-red, #b42318)", fontSize: "0.75rem", display: "block", marginTop: "0.2rem" }} role="alert">
                        Indique la hora de salida.
                      </span>
                    )}
                  </div>
                </div>
              </section>
              <div className="correction-field correction-field--full">
                <label className="label" htmlFor="correction-notes">Notas</label>
                <input id="correction-notes" type="text" className="input" value={corrNotes} onChange={(e) => setCorrNotes(e.target.value)} disabled={savingCorrection} />
              </div>
              <div className="correction-field correction-field--full">
                <label className="label" htmlFor="correction-reason">Motivo (obligatorio)</label>
                <input
                  data-autofocus
                  id="correction-reason"
                  type="text"
                  className={`input${corrFieldErrors.reason ? " is-invalid" : ""}`}
                  aria-invalid={corrFieldErrors.reason ? "true" : undefined}
                  aria-describedby={corrFieldErrors.reason ? "corr-reason-error" : undefined}
                  style={corrFieldErrors.reason ? { borderColor: "var(--expense-red, #b42318)" } : undefined}
                  value={corrReason}
                  onChange={(e) => {
                    setCorrReason(e.target.value);
                    setCorrFieldErrors((prev) => ({ ...prev, reason: false }));
                  }}
                  required
                  minLength={3}
                  maxLength={500}
                  placeholder="Ej. olvidó marcar salida"
                  disabled={savingCorrection}
                />
                {corrFieldErrors.reason && (
                  <span id="corr-reason-error" className="error-hint" style={{ color: "var(--expense-red, #b42318)", fontSize: "0.75rem", display: "block", marginTop: "0.2rem" }} role="alert">
                    El motivo debe tener al menos 3 caracteres.
                  </span>
                )}
              </div>
            </div>
            <div className="app-dialog-actions">
              <AppDialogCloseButton className="btn btn-ghost" disabled={savingCorrection}>Cancelar</AppDialogCloseButton>
              <button type="submit" className="btn btn-amber" disabled={savingCorrection || corrReason.trim().length < 3}>
                <Pencil size={15} />
                {savingCorrection && <Spinner />}
                {savingCorrection ? "Guardando corrección…" : "Guardar corrección"}
              </button>
            </div>
          </form>
        </AppDialog>
      )}

      <div className="section-heading">
        <h2 className="card-title">Resumen diario del equipo</h2>
        <p className="card-sub">Una fila por persona y día. Úsalo para detectar diferencias antes de cerrar la planilla.</p>
      </div>
      {!loading && daily.length === 0 ? (
        <p className="empty">Sin jornadas en el rango.</p>
      ) : (
        <>
          <div className="table-wrap attendance-responsive-wrap" style={{ marginBottom: "1rem" }}>
            <table className={`table attendance-daily-table${canManage ? " has-actions" : ""}`}>
              <colgroup>
                <col className="col-employee" /><col className="col-date" /><col className="col-sessions" />
                <col className="col-duration" /><col className="col-duration" /><col className="col-duration" />
                <col className="col-duration" /><col className="col-difference" /><col className="col-incidents" />
                {canManage && <col className="col-action" />}
              </colgroup>
              <thead>
                <tr>
                  <th>Empleado</th><th>Fecha</th><th>Sesiones</th><th>Tiempo presente</th>
                  <th>Refrigerio (descanso)</th><th>Tiempo efectivo</th><th>Jornada esperada</th><th>Saldo del día</th><th>Incidencias</th>{canManage && <th className="table-cell-action">Acción</th>}
                </tr>
              </thead>
              <tbody>
                {loading && <TableSkeleton rows={3} cols={canManage ? 10 : 9} />}
                {dailyPagination.pageItems.map((day) => (
                  <tr key={`${day.employee_id}-${day.work_date}`}>
                    <td className="table-cell-name" style={{ fontWeight: 600 }} title={day.employee_name ?? "—"}>{day.employee_name ?? "—"}</td>
                    <td className="num table-cell-nowrap">{formatOperationalDate(day.work_date)}</td>
                    <td className="num table-cell-nowrap">{day.session_count}</td>
                    <td className="num table-cell-nowrap">{formatMinutes(day.gross_minutes)}</td>
                    <td className="num table-cell-nowrap" title={day.break_source === "OVERRIDE" ? `Real: ${day.override_requested_minutes} min` : "Según jornada"}>{formatMinutes(day.break_minutes)}{day.override_limited ? " (limitado)" : ""}</td>
                    <td className="num table-cell-nowrap">{formatMinutes(day.worked_minutes)}</td>
                    <td className="num table-cell-nowrap">{formatMinutes(day.expected_minutes)}</td>
                    <td className="num table-cell-nowrap">{formatDifference(day.difference_minutes)}</td>
                    <td>{day.incident_codes.length ? <span className="badge badge-amber">{day.incident_codes.map(formatIncidentCode).join(", ")}</span> : <span className="badge badge-green">Sin incidencias</span>}</td>
                    {canManage && <td className="table-cell-action"><button className="btn btn-ghost btn-sm" type="button" disabled={day.has_open_entry} title={day.has_open_entry ? "Cierre todas las marcaciones antes de ajustar el refrigerio" : undefined} onClick={(event) => openBreakDialog(day, event.currentTarget)}>Editar refrigerio del día</button></td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="responsive-table-cards" aria-label="Resumen diario del equipo">
            {loading && <ResponsiveCardsSkeleton label="Cargando resumen diario" />}
            {dailyPagination.pageItems.map((day) => (
              <article className="responsive-table-card" key={`card-${day.employee_id}-${day.work_date}`}>
                <div className="responsive-table-card__heading"><span className="responsive-table-card__name">{day.employee_name ?? "—"}</span><time className="responsive-table-card__date" dateTime={day.work_date}>{formatOperationalDate(day.work_date)}</time></div>
                <dl className="responsive-table-card__grid">
                  <div className="responsive-table-card__item"><dt>Sesiones</dt><dd>{day.session_count}</dd></div>
                  <div className="responsive-table-card__item"><dt>Tiempo presente</dt><dd>{formatMinutes(day.gross_minutes)}</dd></div>
                  <div className="responsive-table-card__item"><dt>Refrigerio (descanso)</dt><dd title={day.break_source === "OVERRIDE" ? `Real: ${day.override_requested_minutes} min` : "Según jornada"}>{formatMinutes(day.break_minutes)}{day.override_limited ? " (limitado)" : ""}</dd></div>
                  <div className="responsive-table-card__item"><dt>Tiempo efectivo</dt><dd>{formatMinutes(day.worked_minutes)}</dd></div>
                  <div className="responsive-table-card__item"><dt>Jornada esperada</dt><dd>{formatMinutes(day.expected_minutes)}</dd></div>
                  <div className="responsive-table-card__item"><dt>Saldo del día</dt><dd>{formatDifference(day.difference_minutes)}</dd></div>
                  <div className="responsive-table-card__item"><dt>Incidencias</dt><dd>{day.incident_codes.length ? <span className="badge badge-amber">{day.incident_codes.map(formatIncidentCode).join(", ")}</span> : <span className="badge badge-green">Sin incidencias</span>}</dd></div>
                </dl>
                {canManage && <div className="responsive-table-card__footer"><button className="btn btn-ghost btn-sm" type="button" disabled={day.has_open_entry} title={day.has_open_entry ? "Cierre todas las marcaciones antes de ajustar el refrigerio" : undefined} onClick={(event) => openBreakDialog(day, event.currentTarget)}>Editar refrigerio del día</button></div>}
              </article>
            ))}
          </div>
          <TablePagination {...dailyPagination} />
        </>
      )}

      {adjustingBreak && (
        <AppDialog labelledBy="break-dialog-title" describedBy="break-dialog-description" onClose={closeBreakDialog} dismissible={!savingBreak}>
          <form onSubmit={saveBreak}>
          <h2 id="break-dialog-title">Editar refrigerio del día</h2>
          <p id="break-dialog-description" className="muted">{adjustingBreak.employee_name} · {formatOperationalDate(adjustingBreak.work_date)}. Presencia: {formatMinutes(adjustingBreak.gross_minutes)}. El valor real sustituye solo este día.</p>
          {breakError && <p className="alert alert-error" role="alert" aria-live="assertive">{breakError}</p>}
          <label className="label" htmlFor="daily-break-minutes">Refrigerio real (minutos)</label>
          <input ref={breakInputRef} data-autofocus id="daily-break-minutes" className="input" inputMode="numeric" type="number" min="0" max={adjustingBreak.gross_minutes} value={breakMinutes} onChange={(event) => setBreakMinutes(event.target.value)} required />
          <p className="muted" role="status">Neto previsto: {formatMinutes(Math.max(0, adjustingBreak.gross_minutes - (Number(breakMinutes) || 0)))}</p>
          <label className="label" htmlFor="daily-break-reason">Motivo</label>
          <input id="daily-break-reason" className="input" minLength={3} maxLength={500} value={breakReason} onChange={(event) => setBreakReason(event.target.value)} placeholder="Ej.: mayor demanda" required />
          <div className="app-dialog-actions">
            <AppDialogCloseButton className="btn btn-ghost" disabled={savingBreak}>Cancelar</AppDialogCloseButton>
            {adjustingBreak.break_source === "OVERRIDE" && <button type="button" className="btn btn-outline" disabled={savingBreak || breakReason.trim().length < 3} onClick={() => void resetBreakToAutomatic()}>Volver al cálculo automático</button>}
            <button type="submit" className="btn btn-primary" disabled={savingBreak || breakReason.trim().length < 3} aria-busy={savingBreak}>{savingBreak && <Spinner />}{savingBreak ? "Guardando refrigerio…" : "Guardar refrigerio"}</button>
          </div>
          </form>
        </AppDialog>
      )}

      <div className="section-heading">
        <h2 className="card-title">Detalle de marcaciones</h2>
        <p className="card-sub">Cada entrada y salida registrada. Desde aquí puedes ver las fotos y corregir un registro.</p>
      </div>
      {!loading && records.length === 0 ? (
        <p className="empty">Sin registros con los filtros actuales.</p>
      ) : (
        <>
          <div className="table-wrap attendance-responsive-wrap">
            <table className={`table attendance-records-table${canManage ? " has-actions" : ""}`}>
              <colgroup>
                <col className="col-employee" /><col className="col-date" /><col className="col-time" /><col className="col-time" />
                <col className="col-duration" /><col className="col-duration" /><col className="col-duration" /><col className="col-status" />
                {canManage && <col className="col-action" />}
              </colgroup>
              <thead>
                <tr>
                  <th>Empleado</th>
                  <th>Fecha</th>
                  <th>Entrada</th>
                  <th>Salida</th>
                  <th>Trabajado</th>
                  <th>Jornada esperada</th>
                  <th>Saldo del día</th>
                  <th>Estado</th>
                  {canManage && <th className="table-cell-action">Acciones</th>}
                </tr>
              </thead>
              <tbody>
                {loading && <TableSkeleton rows={5} cols={canManage ? 9 : 8} />}
                {recordsPagination.pageItems.map((record) => (
                  <tr key={record.id}>
                    <td className="table-cell-name" title={`${record.employee_name ?? "—"}${record.job_role_name ? ` · ${record.job_role_name}` : ""}`}>
                      <Link to={`/admin/employees/${record.employee_id}`} style={{ fontWeight: 600 }}>
                        {record.employee_name ?? "—"}
                      </Link>
                      <span className="muted" style={{ marginLeft: "0.4rem", fontSize: "0.75rem" }}>
                        {record.job_role_name ?? ""}
                      </span>
                    </td>
                    <td className="num table-cell-nowrap">{formatOperationalDate(record.work_date)}</td>
                    <td className="num table-cell-nowrap">{formatClock(record.check_in_at)}</td>
                    <td className="num table-cell-nowrap">{formatClock(record.check_out_at)}</td>
                    <td className="num table-cell-nowrap">{formatMinutes(record.worked_minutes)}</td>
                    <td className="num table-cell-nowrap">{formatMinutes(record.expected_minutes)}</td>
                    <td
                      className="num table-cell-nowrap"
                      style={{
                        color:
                          record.difference_minutes === null
                            ? "var(--muted)"
                            : record.difference_minutes < 0
                              ? "#9a5b00"
                              : record.difference_minutes > 0
                                ? "var(--dark-green)"
                                : "var(--muted)",
                      }}
                    >
                      {formatDifference(record.difference_minutes)}
                    </td>
                    <td>
                      {record.status === "OPEN" ? (
                        <span className="badge badge-amber">Sin salida</span>
                      ) : (
                        <span className="badge badge-green">Completada</span>
                      )}
                    </td>
                    {canManage && (
                      <td className="table-cell-action">
                        <div className="attendance-record-actions">
                        <button className="btn btn-ghost attendance-record-action" type="button" onClick={() => void loadPhotos(record.id)} aria-label={`Ver fotos de ${record.employee_name ?? "este empleado"}`} title="Ver fotos">
                          <Camera size={18} />
                        </button>
                        <button className="btn btn-ghost attendance-record-action" type="button" onClick={() => startCorrection(record)} aria-label={`Corregir registro de ${record.employee_name ?? "este empleado"}`} title="Corregir registro">
                          <Pencil size={18} />
                        </button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="responsive-table-cards" aria-label="Detalle de marcaciones">
            {loading && <ResponsiveCardsSkeleton label="Cargando detalle de marcaciones" />}
            {recordsPagination.pageItems.map((record) => (
              <article className="responsive-table-card" key={`card-${record.id}`}>
                <div className="responsive-table-card__heading"><span className="responsive-table-card__name"><Link to={`/admin/employees/${record.employee_id}`}>{record.employee_name ?? "—"}</Link>{record.job_role_name && <span className="muted" style={{ display: "block", fontSize: "0.78rem", fontWeight: 400 }}>{record.job_role_name}</span>}</span><time className="responsive-table-card__date" dateTime={record.work_date}>{formatOperationalDate(record.work_date)}</time></div>
                <dl className="responsive-table-card__grid">
                  <div className="responsive-table-card__item"><dt>Entrada</dt><dd>{formatClock(record.check_in_at)}</dd></div>
                  <div className="responsive-table-card__item"><dt>Salida</dt><dd>{formatClock(record.check_out_at)}</dd></div>
                  <div className="responsive-table-card__item"><dt>Trabajado</dt><dd>{formatMinutes(record.worked_minutes)}</dd></div>
                  <div className="responsive-table-card__item"><dt>Jornada esperada</dt><dd>{formatMinutes(record.expected_minutes)}</dd></div>
                  <div className="responsive-table-card__item"><dt>Saldo del día</dt><dd>{formatDifference(record.difference_minutes)}</dd></div>
                  <div className="responsive-table-card__item"><dt>Estado</dt><dd>{record.status === "OPEN" ? <span className="badge badge-amber">Sin salida</span> : <span className="badge badge-green">Completada</span>}</dd></div>
                </dl>
                {canManage && <div className="responsive-table-card__footer attendance-record-actions"><button className="btn btn-ghost attendance-record-action" type="button" onClick={() => void loadPhotos(record.id)} aria-label={`Ver fotos de ${record.employee_name ?? "este empleado"}`} title="Ver fotos"><Camera size={18} /></button><button className="btn btn-ghost attendance-record-action" type="button" onClick={() => startCorrection(record)} aria-label={`Corregir registro de ${record.employee_name ?? "este empleado"}`} title="Corregir registro"><Pencil size={18} /></button></div>}
              </article>
            ))}
          </div>
          <TablePagination {...recordsPagination} />
        </>
      )}
    </AdminShell>
  );
}

function ResponsiveCardsSkeleton({ label }: { label: string }) {
  return (
    <div className="responsive-table-card" aria-busy="true" aria-label={label}>
      <div className="skeleton" style={{ width: "62%", height: 17 }} />
      <div className="responsive-table-card__grid">
        <div className="skeleton" style={{ height: 34 }} />
        <div className="skeleton" style={{ height: 34 }} />
        <div className="skeleton" style={{ height: 34 }} />
        <div className="skeleton" style={{ height: 34 }} />
      </div>
    </div>
  );
}
