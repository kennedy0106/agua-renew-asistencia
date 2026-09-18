"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import AdminShell from "@/components/AdminShell";
import AppDialog, { AppDialogCloseButton } from "@/components/AppDialog";
import { useNotifications } from "@/components/Notifications";
import { useAdminUser } from "@/components/AdminSession";
import DateField from "@/components/DateField";
import { Alert, Camera, Download, Pencil, X } from "@/components/Icons";
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
      // eslint-disable-next-line @next/next/no-img-element
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
    setError(null);
    setPhotosFor(null);
  }

  function closeCorrectionDialog() {
    if (savingCorrection) return;
    setCorrecting(null);
    setCorrectionError(null);
  }

  async function handleSaveCorrection(event: React.FormEvent) {
    event.preventDefault();
    if (!correcting) return;
    const checkIn = timestampFromParts(corrCheckInDate, corrCheckInTime);
    const checkOut = timestampFromParts(corrCheckOutDate, corrCheckOutTime);
    if (checkIn.incomplete || checkOut.incomplete) {
      setCorrectionError("Complete la fecha y la hora de cada marcación que desea registrar.");
      return;
    }
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
      setAttemptLookup(
        [
          inspected.state,
          inspected.employee_name ?? inspected.employee_id,
          inspected.action ?? "sin acción",
          inspected.automatable ? "revisable" : "no automatizable",
          inspected.record?.id ? `evento ${inspected.record.id}` : "sin evento",
        ].join(" · "),
      );
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
      setAttemptLookup(`Revisado · ${inspected.state} · el registro original no se modificó`);
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
    <AdminShell title="Asistencia" subtitle={`${records.length} registro(s) · esperado = jornada pactada`}>
      {error && (
        <p className="alert alert-error" role="alert">
          <Alert size={15} style={{ marginTop: 2, flexShrink: 0 }} />
          {error}
        </p>
      )}

      <div className="toolbar">
        {canManage && <Link className="btn btn-outline btn-sm" href="/admin/attendance/history">Cargar horas anteriores</Link>}
        <Select value={employeeFilter || "__all"} onValueChange={(v) => setEmployeeFilter(v === "__all" ? "" : v)}>
          <SelectTrigger aria-label="Empleado" style={{ maxWidth: 220 }}>
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
        <DateField value={dateFrom} onChange={setDateFrom} aria-label="Fecha desde" placeholder="Desde" />
        <span className="muted" style={{ fontSize: "0.8rem" }}>a</span>
        <DateField value={dateTo} onChange={setDateTo} aria-label="Fecha hasta" placeholder="Hasta" />
        <Select value={statusFilter || "__all"} onValueChange={(v) => setStatusFilter(v === "__all" ? "" : v)}>
          <SelectTrigger aria-label="Estado" style={{ maxWidth: 160 }}>
            <SelectValue placeholder="Todos los estados" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all">Todos los estados</SelectItem>
            <SelectItem value="OPEN">Entrada abierta</SelectItem>
            <SelectItem value="COMPLETE">Completado</SelectItem>
          </SelectContent>
        </Select>
        {(employeeFilter || dateFrom || dateTo || statusFilter) && (
          <button className="btn btn-ghost btn-sm" type="button" onClick={() => { setEmployeeFilter(""); setDateFrom(""); setDateTo(""); setStatusFilter(""); }}>
            <X size={14} /> Limpiar filtros
          </button>
        )}
        {refreshing && !loading && <span className="toolbar-status" role="status"><Spinner /> Actualizando…</span>}
        <span className="spacer" />
        <button className="btn btn-outline btn-sm" onClick={exportCsv}>
          <Download size={15} />
          Exportar CSV
        </button>
      </div>

      {canManage && (
        <details className="recovery-panel">
          <summary>
            <span>
              <strong>Recuperar un intento de kiosco</strong>
              <small>Solo si la tablet muestra una referencia de recuperación.</small>
            </span>
            <span className="recovery-panel-action">Abrir revisión</span>
          </summary>
          <form className="card card-pad recovery-panel-form" onSubmit={reviewKioskAttempt}>
            <p className="muted recovery-panel-copy">
              Use la referencia mostrada en la tablet. Conserva el evento original; no corrige horas ni borra fotos.
            </p>
            <div style={{ display: "grid", gap: "0.7rem", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))" }}>
              <div>
                <label className="label" htmlFor="kiosk-attempt-nonce">
                  Referencia del intento
                </label>
                <input
                  id="kiosk-attempt-nonce"
                  className="input"
                  value={attemptNonce}
                  onChange={(e) => setAttemptNonce(e.target.value)}
                  placeholder="nonce del kiosco"
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
                {reviewingAttempt ? "Guardando revisión…" : "Revisar y liberar kiosco"}
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
                  <div className="correction-datefield">
                    <span className="label">Fecha</span>
                    <DateField value={corrCheckInDate} onChange={setCorrCheckInDate} aria-label="Fecha de entrada" placeholder="Seleccionar fecha" disabled={savingCorrection} />
                  </div>
                  <div>
                    <label className="label" htmlFor="correction-check-in-time">Hora</label>
                    <input id="correction-check-in-time" type="time" className="input" value={corrCheckInTime} onChange={(e) => setCorrCheckInTime(e.target.value)} disabled={savingCorrection} />
                  </div>
                </div>
              </section>
              <section className="correction-timestamp" aria-labelledby="correction-check-out-label">
                <h3 id="correction-check-out-label" className="label">Salida</h3>
                <div className="correction-date-time">
                  <div className="correction-datefield">
                    <span className="label">Fecha</span>
                    <DateField value={corrCheckOutDate} onChange={setCorrCheckOutDate} aria-label="Fecha de salida" placeholder="Seleccionar fecha" disabled={savingCorrection} />
                  </div>
                  <div>
                    <label className="label" htmlFor="correction-check-out-time">Hora</label>
                    <input id="correction-check-out-time" type="time" className="input" value={corrCheckOutTime} onChange={(e) => setCorrCheckOutTime(e.target.value)} disabled={savingCorrection} />
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
                  className="input"
                  value={corrReason}
                  onChange={(e) => setCorrReason(e.target.value)}
                  required
                  minLength={3}
                  maxLength={500}
                  placeholder="Ej. olvidó marcar salida"
                  disabled={savingCorrection}
                />
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

      <h2 className="card-title" style={{ margin: "0.9rem 0 0.55rem" }}>Resumen diario consolidado</h2>
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
              <th>Empleado</th><th>Fecha</th><th>Sesiones</th><th>Presencia</th>
              <th>Refrigerio</th><th>Neto</th><th>Esperado</th><th>Diferencia</th><th>Incidencias</th>{canManage && <th className="table-cell-action">Acción</th>}
            </tr>
          </thead>
          <tbody>
            {loading && <TableSkeleton rows={3} cols={canManage ? 10 : 9} />}
            {!loading && daily.length === 0 && <tr><td colSpan={canManage ? 10 : 9} className="empty">Sin jornadas en el rango.</td></tr>}
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
                {canManage && <td className="table-cell-action"><button className="btn btn-ghost btn-sm" type="button" disabled={day.has_open_entry} title={day.has_open_entry ? "Cierre todas las marcaciones antes de ajustar el refrigerio" : undefined} onClick={(event) => openBreakDialog(day, event.currentTarget)}>Ajustar refrigerio</button></td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="responsive-table-cards" aria-label="Resumen diario consolidado">
        {loading && <ResponsiveCardsSkeleton label="Cargando resumen diario" />}
        {!loading && daily.length === 0 && <p className="empty">Sin jornadas en el rango.</p>}
        {dailyPagination.pageItems.map((day) => (
          <article className="responsive-table-card" key={`card-${day.employee_id}-${day.work_date}`}>
            <div className="responsive-table-card__heading"><span className="responsive-table-card__name">{day.employee_name ?? "—"}</span><time className="responsive-table-card__date" dateTime={day.work_date}>{formatOperationalDate(day.work_date)}</time></div>
            <dl className="responsive-table-card__grid">
              <div className="responsive-table-card__item"><dt>Sesiones</dt><dd>{day.session_count}</dd></div>
              <div className="responsive-table-card__item"><dt>Presencia</dt><dd>{formatMinutes(day.gross_minutes)}</dd></div>
              <div className="responsive-table-card__item"><dt>Refrigerio</dt><dd title={day.break_source === "OVERRIDE" ? `Real: ${day.override_requested_minutes} min` : "Según jornada"}>{formatMinutes(day.break_minutes)}{day.override_limited ? " (limitado)" : ""}</dd></div>
              <div className="responsive-table-card__item"><dt>Neto</dt><dd>{formatMinutes(day.worked_minutes)}</dd></div>
              <div className="responsive-table-card__item"><dt>Esperado</dt><dd>{formatMinutes(day.expected_minutes)}</dd></div>
              <div className="responsive-table-card__item"><dt>Diferencia</dt><dd>{formatDifference(day.difference_minutes)}</dd></div>
              <div className="responsive-table-card__item"><dt>Incidencias</dt><dd>{day.incident_codes.length ? <span className="badge badge-amber">{day.incident_codes.map(formatIncidentCode).join(", ")}</span> : <span className="badge badge-green">Sin incidencias</span>}</dd></div>
            </dl>
            {canManage && <div className="responsive-table-card__footer"><button className="btn btn-ghost btn-sm" type="button" disabled={day.has_open_entry} title={day.has_open_entry ? "Cierre todas las marcaciones antes de ajustar el refrigerio" : undefined} onClick={(event) => openBreakDialog(day, event.currentTarget)}>Ajustar refrigerio</button></div>}
          </article>
        ))}
      </div>
      <TablePagination {...dailyPagination} />

      {adjustingBreak && (
        <AppDialog labelledBy="break-dialog-title" describedBy="break-dialog-description" onClose={closeBreakDialog} dismissible={!savingBreak}>
          <form onSubmit={saveBreak}>
          <h2 id="break-dialog-title">Ajustar refrigerio</h2>
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

      <h2 className="card-title" style={{ margin: "0.9rem 0 0.55rem" }}>Detalle de marcaciones</h2>
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
              <th>Esperado</th>
              <th>Diferencia</th>
              <th>Estado</th>
              {canManage && <th className="table-cell-action">Acciones</th>}
            </tr>
          </thead>
          <tbody>
            {loading && <TableSkeleton rows={5} cols={canManage ? 9 : 8} />}
            {!loading && records.length === 0 && (
              <tr>
                <td colSpan={canManage ? 9 : 8} className="empty">
                  Sin registros con los filtros actuales.
                </td>
              </tr>
            )}
            {recordsPagination.pageItems.map((record) => (
              <tr key={record.id}>
                <td className="table-cell-name" title={`${record.employee_name ?? "—"}${record.job_role_name ? ` · ${record.job_role_name}` : ""}`}>
                  <Link href={`/admin/employees/${record.employee_id}`} style={{ fontWeight: 600 }}>
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
                    <span className="badge badge-amber">Abierta</span>
                  ) : (
                    <span className="badge badge-green">Completado</span>
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
        {!loading && records.length === 0 && <p className="empty">Sin registros con los filtros actuales.</p>}
        {recordsPagination.pageItems.map((record) => (
          <article className="responsive-table-card" key={`card-${record.id}`}>
            <div className="responsive-table-card__heading"><span className="responsive-table-card__name"><Link href={`/admin/employees/${record.employee_id}`}>{record.employee_name ?? "—"}</Link>{record.job_role_name && <span className="muted" style={{ display: "block", fontSize: "0.78rem", fontWeight: 400 }}>{record.job_role_name}</span>}</span><time className="responsive-table-card__date" dateTime={record.work_date}>{formatOperationalDate(record.work_date)}</time></div>
            <dl className="responsive-table-card__grid">
              <div className="responsive-table-card__item"><dt>Entrada</dt><dd>{formatClock(record.check_in_at)}</dd></div>
              <div className="responsive-table-card__item"><dt>Salida</dt><dd>{formatClock(record.check_out_at)}</dd></div>
              <div className="responsive-table-card__item"><dt>Trabajado</dt><dd>{formatMinutes(record.worked_minutes)}</dd></div>
              <div className="responsive-table-card__item"><dt>Esperado</dt><dd>{formatMinutes(record.expected_minutes)}</dd></div>
              <div className="responsive-table-card__item"><dt>Diferencia</dt><dd>{formatDifference(record.difference_minutes)}</dd></div>
              <div className="responsive-table-card__item"><dt>Estado</dt><dd>{record.status === "OPEN" ? <span className="badge badge-amber">Abierta</span> : <span className="badge badge-green">Completado</span>}</dd></div>
            </dl>
            {canManage && <div className="responsive-table-card__footer attendance-record-actions"><button className="btn btn-ghost attendance-record-action" type="button" onClick={() => void loadPhotos(record.id)} aria-label={`Ver fotos de ${record.employee_name ?? "este empleado"}`} title="Ver fotos"><Camera size={18} /></button><button className="btn btn-ghost attendance-record-action" type="button" onClick={() => startCorrection(record)} aria-label={`Corregir registro de ${record.employee_name ?? "este empleado"}`} title="Corregir registro"><Pencil size={18} /></button></div>}
          </article>
        ))}
      </div>
      <TablePagination {...recordsPagination} />
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
