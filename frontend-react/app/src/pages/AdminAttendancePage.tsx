
import { useCallback, useEffect, useRef, useState } from "react";
import AdminShell from "@/components/AdminShell";
import AppDialog, { AppDialogCloseButton } from "@/components/AppDialog";
import {
  AttendanceDailyCards,
  AttendanceDailyTable,
  AttendanceRecordsCards,
  AttendanceRecordsTable,
} from "@/components/AttendanceTables";
import AttendanceToolbar from "@/components/AttendanceToolbar";
import { useNotifications } from "@/components/Notifications";
import { useAdminUser } from "@/components/AdminSession";
import DateField from "@/components/DateField";
import { Alert, Download, Eye, Pencil, X } from "@/components/Icons";
import { Spinner } from "@/components/Loading";
import { TablePagination, useTablePagination } from "@/components/Pagination";
import { formatOperationalDate } from "@/lib/dates";
import {
  API_URL,
  ApiError,
  attendanceAdminApi,
  AttendanceDailyItem,
  AttendanceEvidenceRef,
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

function formatMinutes(minutes: number | null): string {
  if (minutes === null) return "—";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return `${h} h ${m.toString().padStart(2, "0")}`;
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

/**
 * Enlace solo-texto a Google Maps con las coordenadas originales. Usa el host
 * literal, sin API de pago, sin mapa incrustado y sin datos del trabajador.
 */
function googleMapsCoordinateUrl(latitude: number, longitude: number): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${latitude},${longitude}`)}`;
}

function formatOfficialTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleTimeString("es-PE", {
    timeZone: "America/Lima",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

/** Redondeo honesto para lectura: como máximo un decimal, sin perder el dato en el enlace. */
function formatAccuracyMeters(value: number | null | undefined): string | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return `±${Number(value.toFixed(1))} m`;
}

/** Coordenadas legibles; el enlace a Maps conserva los valores completos del registro. */
function formatEvidenceCoordinate(value: number): string {
  return Number.isFinite(value) ? value.toFixed(5) : "—";
}

function EvidenceFigure({
  side,
  label,
  originalSrc,
  stampedSrc,
  stampedAdvertised,
  stampedFailed,
  meta,
  loading,
}: {
  side: "check_in" | "check_out";
  label: "Entrada" | "Salida";
  originalSrc: string | null;
  stampedSrc: string | null;
  stampedAdvertised: boolean;
  stampedFailed: boolean;
  meta: AttendanceEvidenceRef | null;
  loading: boolean;
}) {
  const [showOriginal, setShowOriginal] = useState(false);
  const hasStamped = Boolean(stampedSrc);
  const canSwitchVersion = Boolean(stampedSrc && originalSrc);
  const showingStamped = hasStamped && !showOriginal;
  const displaySrc = showingStamped ? stampedSrc : originalSrc;
  const location = meta?.location ?? null;
  const officialTime = formatOfficialTime(meta?.marked_at);
  const accuracy = location ? formatAccuracyMeters(location.accuracy_m) : null;
  const stampUnavailable = stampedAdvertised && !stampedSrc && stampedFailed;
  const photoName = label.toLowerCase();

  return (
    <figure className="evidence-figure" data-testid={`evidence-figure-${side}`}>
      <figcaption className="evidence-figure__caption">
        <h3 className="evidence-figure__title">{label}</h3>
        {displaySrc && (
          <span
            className={`badge ${showingStamped ? "badge-blue" : "badge-neutral"} evidence-version`}
            data-testid={`evidence-version-${side}`}
            data-version={showingStamped ? "stamped" : "original"}
          >
            {showingStamped ? "Con sello" : "Original"}
          </span>
        )}
      </figcaption>

      <div className="evidence-stage">
        {loading ? (
          <div className="skeleton evidence-stage__skeleton" role="status">
            <span className="sr-only">Cargando foto de {photoName}</span>
          </div>
        ) : displaySrc ? (
          <img
            src={displaySrc}
            alt={`${label} ${showingStamped ? "con sello" : "original sin sello"}`}
            data-testid={`evidence-image-${side}`}
          />
        ) : (
          <p className="evidence-stage__empty" data-testid={`evidence-empty-${side}`}>
            Sin foto de {photoName}.
          </p>
        )}
      </div>

      {stampUnavailable && (
        <p className="evidence-notice" role="status" data-testid={`evidence-stamp-warning-${side}`}>
          No se pudo cargar la versión con sello de esta foto. La imagen mostrada y descargable es la original, sin sello.
        </p>
      )}

      {canSwitchVersion && (
        <div className="evidence-view-row">
          <span className="evidence-view-row__label" aria-hidden="true">
            <Eye size={14} /> Vista
          </span>
          <div
            className="evidence-view"
            role="group"
            aria-label={`Vista de la foto de ${photoName}`}
            data-testid={`evidence-toggle-${side}`}
          >
            <button
              type="button"
              className="evidence-view__option"
              aria-pressed={!showOriginal}
              onClick={() => setShowOriginal(false)}
            >
              Con sello
            </button>
            <button
              type="button"
              className="evidence-view__option"
              aria-pressed={showOriginal}
              onClick={() => setShowOriginal(true)}
            >
              Original
            </button>
          </div>
        </div>
      )}

      {(originalSrc || stampedSrc) && (
        <div className="evidence-downloads">
          {stampedSrc && (
            <a
              className="btn btn-primary evidence-action"
              href={stampedSrc}
              download={`evidencia-${side}-sello.jpg`}
              data-testid={`evidence-stamped-download-${side}`}
            >
              <Download size={16} />
              Descargar con sello
            </a>
          )}
          {originalSrc && (
            <a
              className={`btn ${stampedSrc ? "btn-outline" : "btn-primary"} evidence-action`}
              href={originalSrc}
              download={`evidencia-${side}.jpg`}
              data-testid={`evidence-original-${side}`}
            >
              {!stampedSrc && <Download size={16} />}
              Descargar original
            </a>
          )}
        </div>
      )}

      {meta && (
        <dl className="evidence-meta">
          <div className="evidence-meta__row">
            <dt>Hora oficial (Lima)</dt>
            <dd data-testid={`evidence-official-time-${side}`}>
              {officialTime ? <time dateTime={meta.marked_at ?? undefined}>{officialTime}</time> : "No registrada"}
            </dd>
          </div>
          <div className="evidence-meta__row">
            <dt>Ubicación</dt>
            {location ? (
              <dd data-testid={`evidence-location-${side}`}>
                <span className={location.address ? "evidence-meta__address" : "evidence-meta__muted"}>
                  {location.address ?? "Dirección no registrada"}
                </span>
                <span className="evidence-meta__coords">
                  {formatEvidenceCoordinate(location.latitude)}, {formatEvidenceCoordinate(location.longitude)}
                </span>
                {accuracy && <span className="evidence-meta__accuracy">Precisión {accuracy}</span>}
                <a
                  className="evidence-meta__maps"
                  href={googleMapsCoordinateUrl(location.latitude, location.longitude)}
                  target="_blank"
                  rel="noopener noreferrer"
                  data-testid={`evidence-maps-${side}`}
                >
                  Ver en Google Maps
                  <span className="sr-only"> (se abre en una pestaña nueva)</span>
                </a>
              </dd>
            ) : (
              <dd className="evidence-meta__muted" data-testid={`evidence-location-missing-${side}`}>
                Ubicación no disponible para este registro.
              </dd>
            )}
          </div>
        </dl>
      )}
    </figure>
  );
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
  const [photoLoading, setPhotoLoading] = useState(false);
  const [photoUrls, setPhotoUrls] = useState<{ check_in: string | null; check_out: string | null; missing: string | null }>({
    check_in: null,
    check_out: null,
    missing: null,
  });
  const [photoMeta, setPhotoMeta] = useState<{
    check_in: AttendanceEvidenceRef | null;
    check_out: AttendanceEvidenceRef | null;
  }>({ check_in: null, check_out: null });
  const [stampedUrls, setStampedUrls] = useState<{ check_in: string | null; check_out: string | null }>({
    check_in: null,
    check_out: null,
  });
  const [stampFailed, setStampFailed] = useState<{ check_in: boolean; check_out: boolean }>({
    check_in: false,
    check_out: false,
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
  const evidenceRecord = photosFor ? records.find((item) => item.id === photosFor) ?? null : null;
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

  useEffect(() => () => {
    if (stampedUrls.check_in) URL.revokeObjectURL(stampedUrls.check_in);
    if (stampedUrls.check_out) URL.revokeObjectURL(stampedUrls.check_out);
  }, [stampedUrls]);

  async function loadPhotos(recordId: string) {
    setPhotosFor(recordId);
    setPhotoLoading(true);
    setPhotoUrls({ check_in: null, check_out: null, missing: null });
    setPhotoMeta({ check_in: null, check_out: null });
    setStampedUrls({ check_in: null, check_out: null });
    setStampFailed({ check_in: false, check_out: false });
    try {
      const meta = await attendanceAdminApi.evidenceMeta(recordId);
      const [checkInUrl, checkOutUrl] = await Promise.all([
        meta.check_in?.id ? attendanceAdminApi.evidenceImage(meta.check_in.id) : null,
        meta.check_out?.id ? attendanceAdminApi.evidenceImage(meta.check_out.id) : null,
      ]);
      // El sello solo existe para evidencia confirmada y preparada. Si el
      // derivado anunciado falla, se avisa: el original NUNCA se muestra como
      // si estuviera sellado.
      const loadStamped = async (ref: AttendanceEvidenceRef | null | undefined) => {
        if (!ref?.id || !ref.stamped_available) return { url: null, failed: false };
        try {
          return { url: await attendanceAdminApi.evidenceStampedImage(ref.id), failed: false };
        } catch {
          return { url: null, failed: true };
        }
      };
      const [stampedIn, stampedOut] = await Promise.all([
        loadStamped(meta.check_in),
        loadStamped(meta.check_out),
      ]);
      const missing =
        !meta.check_in?.available && !meta.check_out?.available
          ? "Este registro es anterior a la evidencia fotográfica o nunca tuvo foto."
          : null;
      setPhotoMeta({ check_in: meta.check_in ?? null, check_out: meta.check_out ?? null });
      setStampedUrls({ check_in: stampedIn.url, check_out: stampedOut.url });
      setStampFailed({ check_in: stampedIn.failed, check_out: stampedOut.failed });
      setPhotoUrls({ check_in: checkInUrl, check_out: checkOutUrl, missing });
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "No se pudieron cargar las fotos";
      setPhotoMeta({ check_in: null, check_out: null });
      setStampedUrls({ check_in: null, check_out: null });
      setStampFailed({ check_in: false, check_out: false });
      setPhotoUrls({ check_in: null, check_out: null, missing: message });
      setError(message);
    } finally {
      setPhotoLoading(false);
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

      <AttendanceToolbar
        canManage={canManage}
        employees={employees}
        employeeFilter={employeeFilter}
        onEmployeeChange={setEmployeeFilter}
        dateFrom={dateFrom}
        dateTo={dateTo}
        onDateFromChange={setDateFrom}
        onDateToChange={setDateTo}
        statusFilter={statusFilter}
        onStatusChange={setStatusFilter}
        onClear={() => {
          setEmployeeFilter("");
          setDateFrom("");
          setDateTo("");
          setStatusFilter("");
        }}
        onExport={exportCsv}
        refreshing={refreshing && !loading}
        recovery={{
          nonce: attemptNonce,
          reason: attemptReason,
          lookup: attemptLookup,
          reviewing: reviewingAttempt,
          onNonceChange: setAttemptNonce,
          onReasonChange: setAttemptReason,
          onLookup: () => void lookupKioskAttempt(),
          onSubmit: reviewKioskAttempt,
        }}
      />

      {photosFor && (
        <AppDialog
          labelledBy="evidence-dialog-title"
          describedBy="evidence-dialog-description"
          onClose={() => setPhotosFor(null)}
          className="evidence-dialog"
        >
          <header className="evidence-dialog__header">
            <div className="evidence-dialog__heading">
              <h2 id="evidence-dialog-title">Evidencia fotográfica</h2>
              <p className="evidence-dialog__subject" data-testid="evidence-subject">
                <strong>{evidenceRecord?.employee_name ?? "Nombre no disponible"}</strong>
                {evidenceRecord?.work_date && (
                  <>
                    <span className="evidence-dialog__separator" aria-hidden="true"> · </span>
                    <time dateTime={evidenceRecord.work_date}>{formatOperationalDate(evidenceRecord.work_date)}</time>
                  </>
                )}
              </p>
            </div>
            <AppDialogCloseButton className="btn btn-ghost evidence-dialog__close" aria-label="Cerrar evidencia">
              <X size={18} />
            </AppDialogCloseButton>
          </header>
          <div className="evidence-dialog__body">
            <p className="evidence-dialog__intro" id="evidence-dialog-description">
              La versión <strong>con sello</strong> integra los datos del registro (hora y ubicación); la{" "}
              <strong>original</strong> es la captura de la cámara, sin ese sello.
            </p>
            {photoUrls.missing ? (
              <p className="evidence-dialog__empty" role="status">
                {photoUrls.missing}
              </p>
            ) : (
              <div className="evidence-grid">
                <EvidenceFigure
                  side="check_in"
                  label="Entrada"
                  originalSrc={photoUrls.check_in}
                  stampedSrc={stampedUrls.check_in}
                  stampedAdvertised={Boolean(photoMeta.check_in?.stamped_available)}
                  stampedFailed={stampFailed.check_in}
                  meta={photoMeta.check_in}
                  loading={photoLoading}
                />
                <EvidenceFigure
                  side="check_out"
                  label="Salida"
                  originalSrc={photoUrls.check_out}
                  stampedSrc={stampedUrls.check_out}
                  stampedAdvertised={Boolean(photoMeta.check_out?.stamped_available)}
                  stampedFailed={stampFailed.check_out}
                  meta={photoMeta.check_out}
                  loading={photoLoading}
                />
              </div>
            )}
          </div>
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
          <AttendanceDailyTable
            days={dailyPagination.pageItems}
            loading={loading}
            canManage={canManage}
            onEditBreak={openBreakDialog}
          />
          <AttendanceDailyCards
            days={dailyPagination.pageItems}
            loading={loading}
            canManage={canManage}
            onEditBreak={openBreakDialog}
          />
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
          <AttendanceRecordsTable
            records={recordsPagination.pageItems}
            loading={loading}
            canManage={canManage}
            onPhotos={loadPhotos}
            onCorrect={startCorrection}
          />
          <AttendanceRecordsCards
            records={recordsPagination.pageItems}
            loading={loading}
            canManage={canManage}
            onPhotos={loadPhotos}
            onCorrect={startCorrection}
          />
          <TablePagination {...recordsPagination} />
        </>
      )}
    </AdminShell>
  );
}
