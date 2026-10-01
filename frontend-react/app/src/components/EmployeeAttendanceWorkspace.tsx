
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { AsyncButton } from "@/components/AsyncButton";
import DateField from "@/components/DateField";
import MonthField from "@/components/MonthField";
import { DetailSkeleton, InlineLoading } from "@/components/Loading";
import AppDialog, { AppDialogCloseButton } from "@/components/AppDialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  ApiError,
  employeeAttendanceApi,
  EmployeeAgendaDay,
  historicalAttendanceApi,
  HourAdjustment,
  ManualAttendanceDay,
  ManualAttendanceRow,
  ManualMultiPreview,
  PayrollAccrual,
  WorkCalendarDay,
  RestSubstitution,
  SpecialDayValuation,
  workCalendarApi,
} from "@/lib/api";

type Treatment = "NORMAL" | "ADDITIONAL" | "RECOVERY" | "MIXED";
type OverrideDraft = { hours: string; minutes: string; reason: string; activity: string };
type Commitment = { id: string; pending_minutes: number; reference: string };
type AdjustmentEditorItem = Pick<HourAdjustment, "id" | "adjustment_date" | "minutes" | "adjustment_type" | "reason" | "version">;

const weekdays = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"];
const statusCopy: Record<string, string> = {
  COMPLETE: "Completa", OPEN: "Abierta", NO_RECORD: "Sin registro", REST: "Descanso",
  MANUAL: "Administrativa", PERMISSION: "Permiso", RECOVERY: "Recuperación",
  OVERTIME_PENDING: "Adicional pendiente", OVERTIME_APPROVED: "Adicional aprobado",
  FUTURE: "Fecha futura", OUTSIDE_EMPLOYMENT: "Fuera del contrato",
  WEEKLY_REST: "Descanso semanal", HOLIDAY: "Feriado", SPECIAL_DAY_PENDING: "Pago pendiente de confirmación",
  SPECIAL_DAY_APPROVED: "Pago confirmado para planilla",
};

const adjustmentTypeCopy: Record<string, string> = {
  PERMISO: "Permiso", RECUPERACION: "Recuperación", OVERTIME: "Horas extra", OTRO: "Otro ajuste",
};
const specialSourceCopy: Record<string, string> = {
  WEEKLY_REST: "descanso semanal trabajado", HOLIDAY: "feriado trabajado", MAY_DAY_COINCIDENCE: "primero de mayo",
};
const specialStatusCopy: Record<string, string> = {
  PENDING: "Pendiente de confirmación", APPROVED: "Confirmado para planilla", REVIEW_REQUIRED: "Requiere revisión", VOIDED: "Anulado",
};
const substitutionStatusCopy: Record<string, string> = {
  PROPOSED: "Pendiente de aprobación", APPROVED: "Aprobado", ENJOYED: "Descanso confirmado", CANCELLED: "Cancelado", INVALIDATED: "Requiere revisión",
};
const valuationComponentCopy: Record<string, string> = {
  WEEKLY_REST_WORK: "Trabajo realizado", WEEKLY_REST_SURCHARGE: "Pago adicional por descanso",
  HOLIDAY_WORK: "Trabajo realizado", HOLIDAY_SURCHARGE: "Pago adicional por feriado",
  MAY_DAY_BASE: "Pago del primero de mayo", MAY_DAY_WORK: "Trabajo realizado", MAY_DAY_SURCHARGE: "Pago adicional",
};

function isoToday() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Lima", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

function monthBounds(month: string) {
  const [year, value] = month.split("-").map(Number);
  const last = new Date(Date.UTC(year, value, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, "0")}` };
}

function dateParts(iso: string) {
  const [year, month, day] = iso.split("-").map(Number);
  return { year, month, day };
}

function calendarOffset(iso: string) {
  const { year, month, day } = dateParts(iso);
  return (new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7;
}

function formatMinutes(value: number) {
  const hours = Math.floor(Math.abs(value) / 60);
  const minutes = Math.abs(value) % 60;
  return `${value < 0 ? "−" : ""}${hours} h ${String(minutes).padStart(2, "0")}`;
}

function money(value: string | number | null | undefined) {
  if (value === null || value === undefined) return "—";
  return `S/ ${Number(value).toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function paymentPreviewText(payment: ManualMultiPreview["items"][number]["payment_preview"]) {
  if (!payment) return "";
  const amount = payment.amount ? money(payment.amount) : "Sin importe calculado";
  const breakMinutes = Number(payment.break_minutes ?? 0);
  if (breakMinutes <= 0) return amount;
  const payableMinutes = Number(payment.minutes ?? 0);
  return `${formatMinutes(breakMinutes)} de refrigerio · ${formatMinutes(payableMinutes)} adicionales pagables · ${amount}`;
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("es-PE", { dateStyle: "medium", timeStyle: "short", timeZone: "America/Lima" }).format(new Date(value));
}

function toLimaIso(date: string, time: string) {
  return time ? `${date}T${time}:00-05:00` : null;
}

function friendlyError(error: unknown, fallback: string) {
  return error instanceof ApiError ? error.message : fallback;
}

function previewIssue(message?: string | null, code?: string | null) {
  if (message && !/^[A-Z0-9_]+$/.test(message)) return message;
  const copy: Record<string, string> = {
    MANUAL_DAY_EXISTS: "Ya existe una carga para esta fecha. Puede editarla desde el detalle del día.",
    ATTENDANCE_EXISTS: "Esta fecha ya tiene marcaciones. Revise el detalle antes de continuar.",
    CLOSED_PERIOD: "La planilla de esta fecha está cerrada y requiere una corrección autorizada.",
    RECOVERY_COMMITMENT_REQUIRED: "Seleccione el permiso que estas horas recuperan.",
  };
  return copy[code ?? message ?? ""] ?? "Esta fecha necesita revisión antes de guardarse.";
}

export type EmployeeAttendanceWorkspaceHandle = {
  editAdjustment: (adjustment: HourAdjustment) => void;
  voidAdjustment: (adjustment: HourAdjustment) => void;
};

type EmployeeAttendanceWorkspaceProps = {
  employeeId: string;
  onAdjustmentMutated?: () => Promise<void> | void;
};

const EmployeeAttendanceWorkspace = forwardRef<EmployeeAttendanceWorkspaceHandle, EmployeeAttendanceWorkspaceProps>(function EmployeeAttendanceWorkspace({ employeeId, onAdjustmentMutated }, ref) {
  const today = isoToday();
  const [month, setMonth] = useState(today.slice(0, 7));
  const [agenda, setAgenda] = useState<EmployeeAgendaDay[]>([]);
  const [calendarDays, setCalendarDays] = useState<WorkCalendarDay[]>([]);
  const [agendaLoading, setAgendaLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedDates, setSelectedDates] = useState<string[]>([]);
  const [focusedDate, setFocusedDate] = useState<string | null>(today);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [period, setPeriod] = useState<"FIRST_HALF" | "SECOND_HALF" | "MONTH" | "CUSTOM">(
    Number(today.slice(8, 10)) <= 15 ? "FIRST_HALF" : "SECOND_HALF",
  );
  const [customFrom, setCustomFrom] = useState(monthBounds(month).from);
  const [customTo, setCustomTo] = useState(today);
  const [accrual, setAccrual] = useState<PayrollAccrual | null>(null);
  const [accrualLoading, setAccrualLoading] = useState(true);
  const [accrualError, setAccrualError] = useState<string | null>(null);
  const accrualRequestId = useRef(0);

  const [treatment, setTreatment] = useState<Treatment>("NORMAL");
  const [hours, setHours] = useState("8");
  const [minutes, setMinutes] = useState("0");
  const [normalMinutes, setNormalMinutes] = useState("0");
  const [additionalMinutes, setAdditionalMinutes] = useState("0");
  const [recoveryMinutes, setRecoveryMinutes] = useState("0");
  const [reason, setReason] = useState("Carga administrativa desde el perfil del empleado");
  const [activity, setActivity] = useState("");
  const [checkIn, setCheckIn] = useState("");
  const [checkOut, setCheckOut] = useState("");
  const [commitmentId, setCommitmentId] = useState("");
  const [commitments, setCommitments] = useState<Commitment[]>([]);
  const [overrides, setOverrides] = useState<Record<string, OverrideDraft>>({});
  const [preview, setPreview] = useState<ManualMultiPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [savingBatch, setSavingBatch] = useState(false);
  const [batchDialogOpen, setBatchDialogOpen] = useState(false);
  const [batchKey, setBatchKey] = useState(() => crypto.randomUUID());
  const mutationInFlight = useRef(false);

  const [editingAdjustment, setEditingAdjustment] = useState<AdjustmentEditorItem | null>(null);
  const [adjustmentDraft, setAdjustmentDraft] = useState({ date: "", minutes: "", type: "OTRO" as HourAdjustment["adjustment_type"], reason: "" });
  const [voidingAdjustment, setVoidingAdjustment] = useState<HourAdjustment | null>(null);
  const [voidReason, setVoidReason] = useState("");
  const [adjustmentBusy, setAdjustmentBusy] = useState(false);
  const [adjustmentOperationKey, setAdjustmentOperationKey] = useState(() => crypto.randomUUID());
  const [editingManual, setEditingManual] = useState<ManualAttendanceDay | null>(null);
  const [manualDraft, setManualDraft] = useState<ManualAttendanceRow | null>(null);
  const [manualPreviewToken, setManualPreviewToken] = useState<string | null>(null);
  const [voidingManual, setVoidingManual] = useState<ManualAttendanceDay | null>(null);
  const [manualVoidReason, setManualVoidReason] = useState("");
  const [manualBusy, setManualBusy] = useState(false);
  const [manualOperationKey, setManualOperationKey] = useState(() => crypto.randomUUID());
  const [calendarBusy, setCalendarBusy] = useState(false);
  const [calendarDialogOpen, setCalendarDialogOpen] = useState(false);
  const [restWeekday, setRestWeekday] = useState("6");
  const [referenceMinutes, setReferenceMinutes] = useState("480");
  const [calendarReason, setCalendarReason] = useState("Regla administrativa de descanso");
  const [substitution, setSubstitution] = useState<RestSubstitution | null>(null);
  const [substitutionStart, setSubstitutionStart] = useState("");
  const [substitutionEnd, setSubstitutionEnd] = useState("");
  const [valuation, setValuation] = useState<SpecialDayValuation | null>(null);
  const [showSubstitution, setShowSubstitution] = useState(false);

  const bounds = useMemo(() => monthBounds(month), [month]);
  const byDate = useMemo(() => new Map(agenda.map((day) => [day.work_date, day])), [agenda]);
  const calendarByDate = useMemo(() => new Map(calendarDays.map((day) => [day.work_date, day])), [calendarDays]);
  const focused = focusedDate ? byDate.get(focusedDate) ?? null : null;
  const focusedCalendar = focusedDate ? calendarByDate.get(focusedDate) ?? null : null;
  const referenceDuration = Math.max(0, Number(referenceMinutes) || 0);
  const referenceHours = Math.floor(referenceDuration / 60);
  const referenceRemainder = referenceDuration % 60;
  const calendarReasonForSave = calendarReason.trim().length >= 3 ? calendarReason.trim() : "Actualización desde el perfil del empleado";
  // La referencia mostrada sale del horario vigente (300), no del valor por
  // defecto obsoleto (480). `referenceMinutes` solo edita la regla en el diálogo.
  const effectiveReferenceMinutes = focusedCalendar?.reference_daily_minutes
    ?? (calendarDays.reduce((max, day) => Math.max(max, day.reference_daily_minutes ?? 0), 0)
      || focused?.expected_minutes
      || 0);

  function openCalendarDialog() {
    const firstRest = calendarDays.find((day) => day.weekly_rest);
    if (firstRest) setRestWeekday(String(calendarOffset(firstRest.work_date)));
    // La duración se completa con la jornada real del horario (300) y nunca con
    // una referencia almacenada obsoleta (480).
    const scheduleReference = calendarDays.reduce(
      (max, day) => Math.max(max, day.reference_daily_minutes ?? 0, day.scheduled_minutes ?? 0),
      0,
    );
    const suggested = focusedCalendar?.reference_daily_minutes
      ?? (scheduleReference > 0 ? scheduleReference : null)
      ?? focusedCalendar?.scheduled_minutes
      ?? focused?.expected_minutes;
    if (suggested && suggested > 0) setReferenceMinutes(String(suggested));
    setShowSubstitution(false);
    setCalendarDialogOpen(true);
  }

  const loadAgenda = useCallback(async (background = false) => {
    if (background) setRefreshing(true);
    else setAgendaLoading(true);
    setError(null);
    try {
      const [response, resolved] = await Promise.all([
        employeeAttendanceApi.agenda(employeeId, bounds.from, bounds.to),
        workCalendarApi.days(employeeId, bounds.from, bounds.to),
      ]);
      setAgenda(response.days);
      setCalendarDays(resolved);
      setFocusedDate((current) => current && response.days.some((day) => day.work_date === current) ? current : response.days[0]?.work_date ?? null);
    } catch (err) {
      setError(friendlyError(err, "No se pudo cargar la agenda del empleado."));
    } finally {
      setAgendaLoading(false);
      setRefreshing(false);
    }
  }, [bounds.from, bounds.to, employeeId]);

  const loadAccrual = useCallback(async (background = false) => {
    const requestId = ++accrualRequestId.current;
    setAccrualLoading(true);
    setAccrualError(null);
    if (!background) setAccrual(null);
    try {
      const response = await employeeAttendanceApi.accrual(employeeId, {
        period,
        anchor_date: `${month}-${String(Math.min(Number(today.slice(8, 10)), Number(bounds.to.slice(8, 10)))).padStart(2, "0")}`,
        date_from: period === "CUSTOM" ? customFrom : undefined,
        date_to: period === "CUSTOM" ? customTo : undefined,
      });
      if (requestId === accrualRequestId.current) setAccrual(response);
    } catch (err) {
      if (requestId === accrualRequestId.current) {
        setAccrualError(friendlyError(err, "No se pudo calcular el acumulado del periodo."));
      }
    } finally {
      if (requestId === accrualRequestId.current) setAccrualLoading(false);
    }
  }, [bounds.to, customFrom, customTo, employeeId, month, period, today]);

  useEffect(() => { void loadAgenda(); }, [loadAgenda]);
  useEffect(() => { void loadAccrual(); }, [loadAccrual]);
  useEffect(() => {
    void historicalAttendanceApi.commitments(employeeId)
      .then((items) => setCommitments(items.filter((item) => item.pending_minutes > 0)))
      .catch(() => setCommitments([]));
  }, [employeeId]);

  function invalidatePreview() {
    setPreview(null);
    setNotice(null);
    setBatchKey(crypto.randomUUID());
  }

  function toggleDate(date: string, extend: boolean) {
    setFocusedDate(date);
    setSelectedDates((current) => {
      if (extend && current.length) {
        const start = current[current.length - 1];
        const [from, to] = start < date ? [start, date] : [date, start];
        const range = agenda.map((item) => item.work_date).filter((item) => item >= from && item <= to);
        return Array.from(new Set([...current, ...range])).slice(0, 50).sort();
      }
      return current.includes(date) ? current.filter((item) => item !== date) : [...current, date].sort().slice(0, 50);
    });
    invalidatePreview();
  }

  function effectiveTotal(date: string) {
    const row = overrides[date];
    return Number((row?.hours ?? hours) || 0) * 60 + Number((row?.minutes ?? minutes) || 0);
  }

  function templateFor(date: string) {
    const total = effectiveTotal(date);
    const row = overrides[date];
    const normal = treatment === "NORMAL" ? total : treatment === "MIXED" ? Number(normalMinutes || 0) : 0;
    const additional = treatment === "ADDITIONAL" ? total : treatment === "MIXED" ? Number(additionalMinutes || 0) : 0;
    const recovery = treatment === "RECOVERY" ? total : treatment === "MIXED" ? Number(recoveryMinutes || 0) : 0;
    const rowActivity = row?.activity ?? activity;
    return {
      worked_minutes_net: total,
      normal_minutes: normal,
      additional_minutes: additional,
      recovery_minutes: recovery,
      known_check_in_at: toLimaIso(date, checkIn),
      known_check_out_at: toLimaIso(date, checkOut),
      known_break_minutes: null,
      day_context: "ORDINARY" as const,
      source_reference: additional ? rowActivity : null,
      payment_method: additional ? "OVERTIME" as const : null,
      payment_concept: additional ? rowActivity : null,
      reviewed_additional_amount: null,
      reason: row?.reason ?? reason,
      recovery_allocations: recovery && commitmentId ? [{ commitment_id: commitmentId, minutes: recovery }] : [],
    };
  }

  function validateBatch() {
    if (!selectedDates.length) return "Seleccione al menos una fecha.";
    if (selectedDates.length > 50) return "El lote admite hasta 50 fechas.";
    if (selectedDates.some((date) => effectiveTotal(date) <= 0)) return "Todas las fechas deben tener horas netas.";
    if (reason.trim().length < 3) return "Escriba un motivo para la carga.";
    if ((treatment === "ADDITIONAL" || treatment === "MIXED") && activity.trim().length < 3) return "Describa la actividad realizada en las horas adicionales.";
    if ((treatment === "RECOVERY" || treatment === "MIXED") && !commitmentId) return "Seleccione el compromiso que se recupera.";
    if (treatment === "MIXED" && Number(normalMinutes) + Number(additionalMinutes) + Number(recoveryMinutes) !== effectiveTotal(selectedDates[0])) return "La distribución mixta debe sumar las horas netas.";
    return null;
  }

  function batchPayload() {
    const first = selectedDates[0];
    const base = templateFor(first);
    return {
      employee_id: employeeId,
      work_dates: selectedDates,
      template: base,
      overrides: selectedDates.map((date) => ({ work_date: date, ...templateFor(date) })),
      idempotency_key: batchKey,
      approve_additional: false,
    };
  }

  async function runPreview() {
    const validation = validateBatch();
    if (validation) { setError(validation); return; }
    setPreviewing(true); setError(null); setNotice(null);
    try {
      setPreview(await employeeAttendanceApi.previewMulti(batchPayload()));
      setNotice("Previsualización lista. Revise cada fecha antes de guardar.");
    } catch (err) {
      setError(friendlyError(err, "No se pudo previsualizar el lote."));
    } finally { setPreviewing(false); }
  }

  async function saveBatch() {
    if (!preview || mutationInFlight.current) return;
    mutationInFlight.current = true; setSavingBatch(true); setError(null); setNotice(null);
    try {
      const result = await employeeAttendanceApi.createMulti({ ...batchPayload(), preview_token: preview.preview_token });
      setNotice(`${result.items.length} fechas guardadas. La agenda y el acumulado ya están actualizados.`);
      setSelectedDates([]); setOverrides({}); setPreview(null); setBatchKey(crypto.randomUUID()); setBatchDialogOpen(false);
      await Promise.all([loadAgenda(true), loadAccrual(true)]);
    } catch (err) {
      const definitive = err instanceof ApiError && (err.responseKind === "DOMAIN_ERROR" || err.responseKind === "REQUEST_VALIDATION");
      setError(definitive
        ? err.message
        : "No se pudo confirmar la respuesta. Reintente este mismo envío; no cambie las fechas.");
    } finally { mutationInFlight.current = false; setSavingBatch(false); }
  }

  function beginAdjustmentEdit(item: AdjustmentEditorItem) {
    setEditingAdjustment(item);
    setAdjustmentDraft({ date: item.adjustment_date, minutes: String(item.minutes), type: item.adjustment_type, reason: item.reason });
    setVoidReason("");
    setAdjustmentOperationKey(crypto.randomUUID());
  }

  function beginAdjustmentVoid(item: HourAdjustment) {
    setVoidingAdjustment(item);
    setVoidReason("");
    setAdjustmentOperationKey(crypto.randomUUID());
  }

  useImperativeHandle(ref, () => ({
    editAdjustment: (item) => beginAdjustmentEdit(item),
    voidAdjustment: (item) => beginAdjustmentVoid(item),
  }));

  async function updateAdjustment() {
    if (!editingAdjustment || adjustmentBusy) return;
    setAdjustmentBusy(true); setError(null);
    try {
      await employeeAttendanceApi.updateAdjustment(editingAdjustment.id, {
        adjustment_date: adjustmentDraft.date,
        minutes: Number(adjustmentDraft.minutes),
        adjustment_type: adjustmentDraft.type,
        reason: adjustmentDraft.reason.trim(),
        expected_version: editingAdjustment.version ?? 1,
        idempotency_key: adjustmentOperationKey,
      });
      setEditingAdjustment(null);
      setNotice("Ajuste actualizado. La nueva versión quedó pendiente de aprobación.");
      await Promise.all([loadAgenda(true), loadAccrual(true), onAdjustmentMutated?.()]);
    } catch (err) { setError(friendlyError(err, "No se pudo actualizar el ajuste.")); }
    finally { setAdjustmentBusy(false); }
  }

  async function voidAdjustment() {
    if (!voidingAdjustment || voidReason.trim().length < 3 || adjustmentBusy) return;
    setAdjustmentBusy(true); setError(null);
    try {
      await employeeAttendanceApi.voidAdjustment(voidingAdjustment.id, {
        expected_version: voidingAdjustment.version ?? 1,
        reason: voidReason.trim(),
        idempotency_key: adjustmentOperationKey,
      });
      setVoidingAdjustment(null); setVoidReason("");
      setNotice("Ajuste anulado y retirado de los cálculos. El historial se conserva.");
      await Promise.all([loadAgenda(true), loadAccrual(true), onAdjustmentMutated?.()]);
    } catch (err) { setError(friendlyError(err, "No se pudo anular el ajuste.")); }
    finally { setAdjustmentBusy(false); }
  }

  function beginManualEdit(item: ManualAttendanceDay) {
    setEditingManual(item);
    setManualDraft({
      employee_id: item.employee_id,
      worked_minutes_net: item.worked_minutes_net,
      normal_minutes: item.normal_minutes,
      additional_minutes: item.additional_minutes,
      recovery_minutes: item.recovery_minutes,
      known_check_in_at: item.known_check_in_at ?? null,
      known_check_out_at: item.known_check_out_at ?? null,
      known_break_minutes: item.known_break_minutes ?? null,
      day_context: item.day_context ?? "ORDINARY",
      source_reference: item.source_reference ?? null,
      payment_method: item.payment_method ?? null,
      payment_concept: item.payment_concept ?? null,
      reviewed_additional_amount: item.reviewed_additional_amount ?? null,
      reason: item.reason,
      recovery_allocations: item.recovery_allocations ?? [],
    });
    setManualPreviewToken(null);
    setManualOperationKey(crypto.randomUUID());
  }

  async function previewManualEdit() {
    if (!editingManual || !manualDraft) return;
    setManualBusy(true); setError(null);
    try {
      const result = await historicalAttendanceApi.preview({
        work_date: editingManual.work_date,
        rows: [manualDraft],
        idempotency_key: manualOperationKey,
        editing_manual_day_id: editingManual.id,
        expected_version: editingManual.version,
      });
      setManualPreviewToken(result.preview_token);
      setNotice("Cambio previsualizado. Revise la distribución antes de guardar la nueva versión.");
    } catch (err) { setError(friendlyError(err, "No se pudo previsualizar el cambio.")); }
    finally { setManualBusy(false); }
  }

  async function saveManualEdit() {
    if (!editingManual || !manualDraft || !manualPreviewToken) return;
    setManualBusy(true); setError(null);
    try {
      await historicalAttendanceApi.update(editingManual.id, {
        ...manualDraft,
        expected_version: editingManual.version,
        preview_token: manualPreviewToken,
        idempotency_key: manualOperationKey,
      });
      setEditingManual(null); setManualDraft(null); setManualPreviewToken(null);
      setNotice("Carga actualizada mediante una nueva versión.");
      await Promise.all([loadAgenda(true), loadAccrual(true)]);
    } catch (err) { setError(friendlyError(err, "No se pudo actualizar la carga.")); }
    finally { setManualBusy(false); }
  }

  async function voidManual() {
    if (!voidingManual || manualVoidReason.trim().length < 3) return;
    setManualBusy(true); setError(null);
    try {
      await historicalAttendanceApi.void(voidingManual.id, voidingManual.version, manualVoidReason.trim(), manualOperationKey);
      setVoidingManual(null); setManualVoidReason("");
      setNotice("Carga anulada y retirada de los cálculos. Su historial se conserva.");
      await Promise.all([loadAgenda(true), loadAccrual(true)]);
    } catch (err) { setError(friendlyError(err, "No se pudo anular la carga.")); }
    finally { setManualBusy(false); }
  }

  async function saveWeeklyRestRule() {
    if (calendarBusy) return;
    setCalendarBusy(true); setError(null);
    try {
      await workCalendarApi.setWeeklyRestRule({ employee_id: employeeId, weekly_rest_weekday: Number(restWeekday), reference_daily_minutes: Number(referenceMinutes), source: "Perfil del empleado", reason: calendarReasonForSave, effective_from: bounds.from });
      setNotice("Regla de descanso guardada. La agenda ya muestra su vigencia.");
      await Promise.all([loadAgenda(true), loadAccrual(true)]);
    } catch (err) { setError(friendlyError(err, "No se pudo guardar la regla de descanso.")); }
    finally { setCalendarBusy(false); }
  }

  async function proposeRestSubstitution() {
    if (!focusedDate || !substitutionStart || !substitutionEnd || calendarBusy) return;
    setCalendarBusy(true); setError(null);
    try {
      const origin = focusedCalendar?.holiday ? "HOLIDAY" : "WEEKLY_REST";
      const result = await workCalendarApi.proposeSubstitution({ employee_id: employeeId, original_date: focusedDate, origin_kind: origin, substitute_start: `${substitutionStart}:00-05:00`, substitute_end: `${substitutionEnd}:00-05:00`, reference: "Acuerdo administrativo", reason: calendarReasonForSave, idempotency_key: crypto.randomUUID() });
      setSubstitution(result); setNotice("Cambio de descanso guardado. Ahora debe aprobarse.");
    } catch (err) { setError(friendlyError(err, "No se pudo proponer la sustitución.")); }
    finally { setCalendarBusy(false); }
  }

  async function actOnSubstitution(action: "approve" | "verify" | "cancel") {
    if (!substitution || calendarBusy) return;
    setCalendarBusy(true); setError(null);
    try {
      const result = await workCalendarApi.substitutionAction(substitution.id, action, { expected_version: substitution.version, reason: calendarReasonForSave, idempotency_key: crypto.randomUUID(), evidence: action === "verify" ? { reference: "Evidencia administrativa desde perfil" } : undefined });
      setSubstitution(result); setNotice(action === "approve" ? "Cambio de descanso aprobado." : action === "verify" ? "Descanso tomado y confirmado." : "Cambio de descanso cancelado. El historial se conserva.");
      await Promise.all([loadAgenda(true), loadAccrual(true)]);
    } catch (err) { setError(friendlyError(err, "La acción sobre la sustitución fue rechazada.")); }
    finally { setCalendarBusy(false); }
  }

  async function previewSpecialValuation() {
    if (!focusedDate || calendarBusy) return;
    setCalendarBusy(true); setError(null);
    try {
      const source = focusedCalendar?.holiday ? (focusedCalendar.holiday.day_kind === "MAY_DAY" ? "MAY_DAY_COINCIDENCE" : "HOLIDAY") : "WEEKLY_REST";
      const result = await workCalendarApi.previewValuation({ employee_id: employeeId, work_date: focusedDate, source_kind: source });
      setValuation(result); setNotice("Pago calculado. Revise el importe antes de confirmarlo para planilla.");
    } catch (err) { setError(friendlyError(err, "No se pudo calcular el pago de este día.")); }
    finally { setCalendarBusy(false); }
  }

  async function actOnValuation(action: "approve" | "reconcile") {
    if (!valuation || calendarBusy) return;
    setCalendarBusy(true); setError(null);
    try {
      const result = action === "approve"
        ? await workCalendarApi.approveValuation(valuation.id, { expected_version: valuation.version, preview_token: valuation.preview_token ?? "", idempotency_key: crypto.randomUUID(), reason: calendarReasonForSave })
        : await workCalendarApi.reconcileValuation(valuation.id, { expected_version: valuation.version, reference: calendarReasonForSave, idempotency_key: crypto.randomUUID() });
      setValuation(result); setNotice(action === "approve" ? "Pago confirmado para la próxima planilla." : "Pago marcado como ya realizado; no se volverá a sumar.");
      await Promise.all([loadAgenda(true), loadAccrual(true)]);
    } catch (err) { setError(friendlyError(err, "La acción sobre la valoración fue rechazada.")); }
    finally { setCalendarBusy(false); }
  }

  const calendarCells = useMemo(() => {
    const prefix = agenda.length ? calendarOffset(agenda[0].work_date) : calendarOffset(bounds.from);
    return [...Array.from({ length: prefix }, () => null), ...agenda];
  }, [agenda, bounds.from]);
  const hasConflicts = preview?.items.some((item) => item.status === "CONFLICT") ?? false;

  return (
    <section className="employee-attendance-workspace" aria-labelledby="employee-agenda-title">
      <header className="employee-workspace-head">
        <div>
          <h2 id="employee-agenda-title">Asistencia, horas y acumulado</h2>
          <p>Seleccione fechas, revise el detalle diario y registre horas administrativas sin crear marcaciones de kiosco.</p>
        </div>
        {refreshing && <InlineLoading />}
      </header>

      {error && <div className="alert alert-error" role="alert">{error}</div>}
      {notice && <div className="alert alert-success" role="status">{notice}</div>}

      <div className="employee-accrual-panel">
        <div className="employee-period-controls">
          <label><span className="label">Periodo acumulado</span>
            <Select value={period} onValueChange={(value) => setPeriod(value as typeof period)}>
              <SelectTrigger aria-label="Periodo acumulado"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="FIRST_HALF">Primera quincena</SelectItem><SelectItem value="SECOND_HALF">Segunda quincena</SelectItem><SelectItem value="MONTH">Mes completo</SelectItem><SelectItem value="CUSTOM">Rango personalizado</SelectItem></SelectContent>
            </Select>
          </label>
          {period === "CUSTOM" && <>
            <label><span className="label">Desde</span><DateField value={customFrom} onChange={setCustomFrom} /></label>
            <label><span className="label">Hasta</span><DateField value={customTo} onChange={setCustomTo} /></label>
          </>}
        </div>
        {accrualError && <div className="alert alert-error" role="alert">{accrualError}</div>}
        {accrualLoading ? <div className="employee-accrual-loading"><DetailSkeleton sections={1} /></div> : accrual && (
          <div className="employee-accrual-grid">
            <div><span>Base acumulada</span><strong>{money(accrual.base_amount)}</strong></div>
            <div><span>Valor día legal (sueldo ÷ 30)</span><strong>{money(accrual.legal_daily_value)}</strong></div>
            {accrual.closing_regularization_amount != null && Number(accrual.closing_regularization_amount) !== 0 && (
              <div><span>Regularización de cierre</span><strong>{money(accrual.closing_regularization_amount)}</strong></div>
            )}
            <div><span>Adicionales aprobados</span><strong>{money(accrual.approved_additional_amount)}</strong></div>
            <div><span>Adicionales pendientes</span><strong>{money(accrual.pending_additional_amount)}</strong></div>
            <div className="employee-accrual-total"><span>Total estimado al {accrual.cutoff_date}</span><strong>{money(accrual.estimated_total)}</strong></div>
            {accrual.official_total_snapshot !== null && <div><span>Planilla confirmada</span><strong>{money(accrual.official_total_snapshot)}</strong></div>}
          </div>
        )}
      </div>

      <div className="employee-agenda-layout">
        <div className="employee-calendar-panel">
          <div className="employee-calendar-toolbar">
            <label><span className="label">Mes</span><MonthField value={month} onChange={(value) => { setMonth(value); setSelectedDates([]); setPreview(null); }} /></label>
            <span>{selectedDates.length} de 50 fechas</span>
          </div>
          <p className="employee-calendar-help">Clic para seleccionar. Use Mayús + clic para completar un rango.</p>
          <div className="employee-calendar-weekdays" aria-hidden="true">{weekdays.map((day) => <span key={day}>{day}</span>)}</div>
          {agendaLoading ? <DetailSkeleton sections={2} /> : (
            <div className="employee-calendar" role="grid" aria-label={`Agenda de ${month}`}>
              {calendarCells.map((day, index) => day ? (
                <button
                  type="button"
                  role="gridcell"
                  key={day.work_date}
                  className={`employee-calendar-day${selectedDates.includes(day.work_date) ? " is-selected" : ""}${focusedDate === day.work_date ? " is-focused" : ""}`}
                  aria-selected={selectedDates.includes(day.work_date)}
                  onClick={(event) => toggleDate(day.work_date, event.shiftKey)}
                >
                  <strong>{Number(day.work_date.slice(8, 10))}</strong>
                  <span>{calendarByDate.get(day.work_date)?.holiday?.name ?? (calendarByDate.get(day.work_date)?.weekly_rest ? "Descanso semanal" : statusCopy[day.statuses[0] ?? ""] ?? "Sin registro")}</span>
                  <i className={`calendar-state calendar-state--${(day.statuses[0] ?? "NO_RECORD").toLowerCase()}`} aria-hidden="true" />
                  {day.statuses.length > 1 && <small>+{day.statuses.length - 1}</small>}
                </button>
              ) : <span className="employee-calendar-day is-empty" key={`empty-${index}`} aria-hidden="true" />)}
            </div>
          )}
        </div>

        <aside className="employee-day-detail" aria-live="polite">
          <h3>{focused ? new Intl.DateTimeFormat("es-PE", { dateStyle: "full", timeZone: "UTC" }).format(new Date(`${focused.work_date}T12:00:00Z`)) : "Detalle del día"}</h3>
          {!focused ? <p className="empty">Seleccione una fecha del calendario.</p> : <>
            <div className="employee-day-statuses">{focused.statuses.map((status) => <span className="badge badge-blue" key={status}>{statusCopy[status] ?? status}</span>)}</div>
            <dl className="employee-day-facts">
              <div><dt>Jornada esperada</dt><dd>{formatMinutes(focused.expected_minutes)}</dd></div>
              {focusedCalendar && <><div><dt>Horario programado</dt><dd>{formatMinutes(focusedCalendar.scheduled_minutes)}</dd></div><div><dt>Duración usada para calcular descansos y feriados</dt><dd>{focusedCalendar.reference_daily_minutes === null ? "Aún no configurada" : formatMinutes(focusedCalendar.reference_daily_minutes)}</dd></div></>}
              <div><dt>Marcaciones</dt><dd>{focused.attendance.length || "Ninguna"}</dd></div>
              <div><dt>Carga administrativa</dt><dd>{focused.manual_day ? formatMinutes(focused.manual_day.worked_minutes_net) : "Ninguna"}</dd></div>
            </dl>
            {focusedCalendar?.reference_diverges_from_rule && <p className="employee-day-entry" role="status">La regla de descanso guarda {formatMinutes(focusedCalendar.rule_reference_daily_minutes ?? 0)} pero la jornada real es {formatMinutes(focusedCalendar.reference_daily_minutes ?? 0)}. Corrija la regla para dejar constancia.</p>}
            {focused.attendance.map((item) => <p className="employee-day-entry" key={item.id}>{item.check_in_at.slice(11, 16)} → {item.check_out_at?.slice(11, 16) ?? "abierta"} · {item.worked_minutes === null ? "en curso" : formatMinutes(item.worked_minutes)}</p>)}
            {focusedCalendar?.holiday && <p className="employee-day-entry">{focusedCalendar.holiday.name} · {focusedCalendar.holiday.source}</p>}
            {focused.holiday && <p className="employee-day-entry">{focused.holiday.name} · {focused.holiday.source}</p>}
            {focused.special_day_valuations?.map((item) => <p className="employee-day-entry" key={item.id}>Pago por {specialSourceCopy[item.source_kind] ?? "día especial"}: {money(item.amount)} · {specialStatusCopy[item.status] ?? "Requiere revisión"}</p>)}
            {focused.manual_day && <div className="employee-day-record"><strong>{focused.manual_day.reason}</strong><p>Jornada regular: {formatMinutes(focused.manual_day.normal_minutes)} · Horas adicionales: {formatMinutes(focused.manual_day.additional_minutes)} · Recuperación: {formatMinutes(focused.manual_day.recovery_minutes)}</p><div className="button-row"><button className="btn btn-outline btn-sm" type="button" onClick={() => beginManualEdit(focused.manual_day!)}>Editar</button><button className="btn btn-danger btn-sm" type="button" onClick={() => { setVoidingManual(focused.manual_day!); setManualVoidReason(""); setManualOperationKey(crypto.randomUUID()); }}>Anular</button><Link className="btn btn-ghost btn-sm" to={`/admin/attendance/history?employee_id=${employeeId}`}>Historial</Link></div></div>}
            {focused.adjustments.map((item) => <div className="employee-day-record" key={item.id}>
              <strong>{adjustmentTypeCopy[item.adjustment_type] ?? "Ajuste de horas"} · {formatMinutes(item.minutes)}</strong><p>{item.reason} · {item.status === "APPROVED" ? "Aprobado" : item.status === "PENDING" ? "Pendiente" : "Rechazado"}</p>
              {!item.voided_at && <div className="button-row"><button type="button" className="btn btn-outline btn-sm" onClick={() => beginAdjustmentEdit(item)}>Editar</button><button type="button" className="btn btn-danger btn-sm" onClick={() => beginAdjustmentVoid(item as HourAdjustment)}>Eliminar</button></div>}
            </div>)}
          </>}
        </aside>
      </div>

      <section className="employee-disclosure-card" aria-labelledby="work-calendar-title">
        <div>
          <h3 id="work-calendar-title">Descansos y feriados</h3>
          <p>Descanso habitual: {weekdays[Number(restWeekday)] ?? "Sin definir"} · jornada usada para el cálculo: {formatMinutes(effectiveReferenceMinutes)}.</p>
        </div>
        <button type="button" className="btn btn-outline" onClick={openCalendarDialog}>Configurar descansos y feriados</button>
      </section>

      {calendarDialogOpen && <AppDialog labelledBy="work-calendar-dialog-title" onClose={() => setCalendarDialogOpen(false)} dismissible={!calendarBusy} className="employee-workspace-dialog">
      <section className="employee-batch-panel" aria-labelledby="work-calendar-dialog-title">
        <div className="app-dialog-heading"><div><h2 id="work-calendar-dialog-title">Descansos y feriados</h2><p>Indique el descanso habitual. El sistema calculará automáticamente los pagos que correspondan.</p></div><AppDialogCloseButton className="btn btn-ghost btn-sm" disabled={calendarBusy}>Cerrar</AppDialogCloseButton></div>
        <div className="employee-batch-head"><div><h3>Descanso habitual</h3><p>Esta configuración se aplicará desde el inicio del mes mostrado en la agenda.</p></div>{calendarBusy && <InlineLoading label="Actualizando calendario…" />}</div>
        <div className="employee-batch-grid">
          <label><span className="label">Día de descanso</span><Select value={restWeekday} onValueChange={setRestWeekday}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{weekdays.map((day, index) => <SelectItem value={String(index)} key={day}>{day}</SelectItem>)}</SelectContent></Select></label>
          <fieldset className="employee-duration-setting"><legend>Duración habitual de la jornada</legend><div><label><span>Horas</span><input className="input" type="number" min="0" max="24" value={referenceHours} onChange={(event) => setReferenceMinutes(String((Number(event.target.value) || 0) * 60 + referenceRemainder))} /></label><label><span>Minutos</span><input className="input" type="number" min="0" max="59" value={referenceRemainder} onChange={(event) => setReferenceMinutes(String(referenceHours * 60 + (Number(event.target.value) || 0)))} /></label></div><small>Se completó con el horario del empleado. Solo cámbielo si ese descanso debe calcularse con otra duración.</small></fieldset>
        </div>
        <details className="employee-calendar-note"><summary>Añadir una nota para el historial</summary><label><span className="label">Nota administrativa</span><input className="input" value={calendarReason} onChange={(event) => setCalendarReason(event.target.value)} placeholder="Ej. acuerdo firmado el 18 de septiembre" /></label></details>
        <div className="employee-batch-actions"><AsyncButton type="button" className="btn btn-primary" busy={calendarBusy} busyLabel="Guardando configuración…" disabled={referenceDuration < 1} onClick={() => void saveWeeklyRestRule()}>Guardar configuración</AsyncButton></div>
        {focusedDate && (focusedCalendar?.weekly_rest || focusedCalendar?.holiday) && <div className="employee-day-record"><strong>{focusedCalendar?.holiday ? `Feriado: ${focusedCalendar.holiday.name}` : "Descanso semanal"}</strong><p>{new Intl.DateTimeFormat("es-PE", { dateStyle: "long", timeZone: "UTC" }).format(new Date(`${focusedDate}T12:00:00Z`))}. Elija solo la acción que necesita.</p><div className="button-row"><button type="button" className="btn btn-outline btn-sm" onClick={() => setShowSubstitution((current) => !current)}>{showSubstitution ? "Ocultar cambio de descanso" : "Cambiar el descanso a otra fecha"}</button><AsyncButton type="button" className="btn btn-outline btn-sm" busy={calendarBusy} busyLabel="Calculando pago…" onClick={() => void previewSpecialValuation()}>Calcular pago de este día</AsyncButton></div>{showSubstitution && <div className="employee-substitution-form"><p>Indique el periodo continuo en el que la persona tomará el descanso.</p><div className="employee-inline-editor-grid"><label><span className="label">Inicio del nuevo descanso</span><input className="input" type="datetime-local" value={substitutionStart} onChange={(event) => setSubstitutionStart(event.target.value)} /></label><label><span className="label">Fin del nuevo descanso</span><input className="input" type="datetime-local" value={substitutionEnd} onChange={(event) => setSubstitutionEnd(event.target.value)} /></label></div><AsyncButton type="button" className="btn btn-outline btn-sm" busy={calendarBusy} busyLabel="Guardando solicitud…" disabled={!substitutionStart || !substitutionEnd} onClick={() => void proposeRestSubstitution()}>Guardar cambio de descanso</AsyncButton></div>}</div>}
        {substitution && <div className="employee-day-record"><strong>Cambio de descanso · {substitutionStatusCopy[substitution.status] ?? "Requiere revisión"}</strong><p>{formatDateTime(substitution.substitute_start)} → {formatDateTime(substitution.substitute_end)} · corresponde a {specialSourceCopy[substitution.origin_kind] ?? "un día especial"}</p><div className="button-row">{substitution.status === "PROPOSED" && <AsyncButton type="button" className="btn btn-outline btn-sm" busy={calendarBusy} busyLabel="Aprobando…" onClick={() => void actOnSubstitution("approve")}>Aprobar cambio</AsyncButton>}{substitution.status === "APPROVED" && <AsyncButton type="button" className="btn btn-outline btn-sm" busy={calendarBusy} busyLabel="Confirmando…" onClick={() => void actOnSubstitution("verify")}>Confirmar descanso tomado</AsyncButton>}{!["CANCELLED", "INVALIDATED", "ENJOYED"].includes(substitution.status) && <AsyncButton type="button" className="btn btn-danger btn-sm" busy={calendarBusy} busyLabel="Cancelando…" onClick={() => void actOnSubstitution("cancel")}>Cancelar cambio</AsyncButton>}</div></div>}
        {valuation && <div className="employee-day-record"><strong>Pago calculado por {specialSourceCopy[valuation.source_kind] ?? "día especial"}: {money(valuation.amount)}</strong><p>{specialStatusCopy[valuation.status] ?? "Requiere revisión"}</p><dl className="employee-payment-breakdown">{valuation.components.map((item) => <div key={item.component_kind}><dt>{valuationComponentCopy[item.component_kind] ?? "Concepto incluido"}</dt><dd>{money(item.amount)}</dd></div>)}</dl><div className="button-row">{valuation.status === "PENDING" && <AsyncButton type="button" className="btn btn-primary btn-sm" busy={calendarBusy} busyLabel="Confirmando…" onClick={() => void actOnValuation("approve")}>Confirmar para planilla</AsyncButton>}{valuation.status !== "VOIDED" && <AsyncButton type="button" className="btn btn-outline btn-sm" busy={calendarBusy} busyLabel="Registrando pago…" onClick={() => void actOnValuation("reconcile")}>Marcar como ya pagado</AsyncButton>}</div></div>}
      </section>
      </AppDialog>}

      <section className="employee-disclosure-card" aria-labelledby="employee-batch-title">
        <div><h3 id="employee-batch-title">Registrar horas en bloque</h3><p>{selectedDates.length ? `${selectedDates.length} ${selectedDates.length === 1 ? "fecha seleccionada" : "fechas seleccionadas"} en la agenda.` : "Seleccione hasta 50 fechas en la agenda para preparar una carga."}</p></div>
        <button type="button" className="btn btn-primary" onClick={() => setBatchDialogOpen(true)} disabled={!selectedDates.length}>Registrar {selectedDates.length ? `${selectedDates.length} ${selectedDates.length === 1 ? "fecha" : "fechas"}` : "fechas"}</button>
      </section>

      {batchDialogOpen && <AppDialog labelledBy="employee-batch-dialog-title" onClose={() => setBatchDialogOpen(false)} dismissible={!previewing && !savingBatch} className="employee-workspace-dialog employee-workspace-dialog--wide">
      <section className="employee-batch-panel" aria-labelledby="employee-batch-dialog-title">
        <div className="app-dialog-heading"><div className="employee-batch-head"><div><h2 id="employee-batch-dialog-title">Registrar en las fechas seleccionadas</h2><p>La previsualización comprueba conflictos y calcula cada importe antes de guardar.</p></div><span className="badge badge-blue">{selectedDates.length} {selectedDates.length === 1 ? "seleccionada" : "seleccionadas"}</span></div><AppDialogCloseButton className="btn btn-ghost btn-sm" disabled={previewing || savingBatch}>Cerrar</AppDialogCloseButton></div>
        <div className="employee-batch-grid">
          <label><span className="label">Cómo registrar estas horas</span><Select value={treatment} onValueChange={(value) => { setTreatment(value as Treatment); invalidatePreview(); }}><SelectTrigger aria-label="Cómo registrar estas horas"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="NORMAL">Como jornada regular</SelectItem><SelectItem value="ADDITIONAL">Como horas adicionales pagadas</SelectItem><SelectItem value="RECOVERY">Como recuperación de un permiso</SelectItem><SelectItem value="MIXED">Dividir entre varios tipos</SelectItem></SelectContent></Select></label>
          <label><span className="label">Horas netas</span><div className="employee-duration-input"><input className="input" type="number" min="0" max="24" value={hours} onChange={(event) => { setHours(event.target.value); invalidatePreview(); }} aria-label="Horas netas" /><input className="input" type="number" min="0" max="59" value={minutes} onChange={(event) => { setMinutes(event.target.value); invalidatePreview(); }} aria-label="Minutos netos" /></div></label>
          <label className="employee-batch-wide"><span className="label">Motivo</span><input className="input" value={reason} onChange={(event) => { setReason(event.target.value); invalidatePreview(); }} /></label>
          {(treatment === "ADDITIONAL" || treatment === "MIXED") && <label className="employee-batch-wide"><span className="label">Actividad realizada en las horas adicionales</span><input className="input" value={activity} onChange={(event) => { setActivity(event.target.value); invalidatePreview(); }} placeholder="Ej. mantenimiento de la unidad y cierre de ruta" /></label>}
          {(treatment === "RECOVERY" || treatment === "MIXED") && <label className="employee-batch-wide"><span className="label">Compromiso de recuperación</span><Select value={commitmentId} onValueChange={(value) => { setCommitmentId(value); invalidatePreview(); }}><SelectTrigger aria-label="Compromiso de recuperación"><SelectValue placeholder="Seleccione un compromiso" /></SelectTrigger><SelectContent>{commitments.map((item) => <SelectItem value={item.id} key={item.id}>{item.reference} · {item.pending_minutes} min pendientes</SelectItem>)}</SelectContent></Select></label>}
          {treatment === "MIXED" && <fieldset className="employee-mixed-fields"><legend>Reparto exacto del tiempo (minutos)</legend><label>Jornada regular<input className="input" type="number" min="0" value={normalMinutes} onChange={(event) => { setNormalMinutes(event.target.value); invalidatePreview(); }} /></label><label>Horas adicionales<input className="input" type="number" min="0" value={additionalMinutes} onChange={(event) => { setAdditionalMinutes(event.target.value); invalidatePreview(); }} /></label><label>Horas recuperadas<input className="input" type="number" min="0" value={recoveryMinutes} onChange={(event) => { setRecoveryMinutes(event.target.value); invalidatePreview(); }} /></label></fieldset>}
          <fieldset className="employee-known-times"><legend>Horarios conocidos (opcionales)</legend><label>Entrada<input className="input" type="time" value={checkIn} onChange={(event) => { setCheckIn(event.target.value); invalidatePreview(); }} /></label><label>Salida<input className="input" type="time" value={checkOut} onChange={(event) => { setCheckOut(event.target.value); invalidatePreview(); }} /></label></fieldset>
        </div>

        {selectedDates.length > 0 && <div className="employee-batch-dates"><div className="employee-batch-date employee-batch-date--head"><span>Fecha</span><span>Horas</span><span>Min</span><span>Motivo / actividad específica</span></div>{selectedDates.map((date) => { const row = overrides[date]; return <div className="employee-batch-date" key={date}><strong>{date}</strong><input className="input" type="number" min="0" max="24" aria-label={`Horas del ${date}`} value={row?.hours ?? hours} onChange={(event) => { setOverrides((current) => ({ ...current, [date]: { hours: event.target.value, minutes: row?.minutes ?? minutes, reason: row?.reason ?? reason, activity: row?.activity ?? activity } })); invalidatePreview(); }} /><input className="input" type="number" min="0" max="59" aria-label={`Minutos del ${date}`} value={row?.minutes ?? minutes} onChange={(event) => { setOverrides((current) => ({ ...current, [date]: { hours: row?.hours ?? hours, minutes: event.target.value, reason: row?.reason ?? reason, activity: row?.activity ?? activity } })); invalidatePreview(); }} /><input className="input" aria-label={`Detalle del ${date}`} value={(treatment === "ADDITIONAL" || treatment === "MIXED") ? (row?.activity ?? activity) : (row?.reason ?? reason)} onChange={(event) => { setOverrides((current) => ({ ...current, [date]: { hours: row?.hours ?? hours, minutes: row?.minutes ?? minutes, reason: treatment === "NORMAL" || treatment === "RECOVERY" ? event.target.value : row?.reason ?? reason, activity: treatment === "ADDITIONAL" || treatment === "MIXED" ? event.target.value : row?.activity ?? activity } })); invalidatePreview(); }} /></div>; })}</div>}

        <div className="employee-batch-actions"><AsyncButton type="button" className="btn btn-outline" busy={previewing} busyLabel="Comprobando fechas…" disabled={!selectedDates.length || savingBatch} onClick={() => void runPreview()}>Previsualizar lote</AsyncButton>{preview && <AsyncButton type="button" busy={savingBatch} busyLabel="Guardando el mismo envío…" disabled={hasConflicts} onClick={() => void saveBatch()}>Guardar {preview.items.length} fechas</AsyncButton>}</div>
        {preview && <div className="employee-batch-preview" aria-live="polite"><h4>Revisión antes de guardar</h4>{preview.items.map((item) => <div className={`employee-preview-row is-${item.status.toLowerCase()}`} key={item.work_date}><strong>{item.work_date}</strong><span>{item.status === "READY" ? `${formatMinutes(item.effective_row.worked_minutes_net)} informados` : previewIssue(item.message, item.error_code)}</span><span>{paymentPreviewText(item.payment_preview)}</span></div>)}</div>}
      </section>
      </AppDialog>}

      {editingAdjustment && <AppDialog labelledBy="adjustment-edit-title" onClose={() => setEditingAdjustment(null)} dismissible={!adjustmentBusy} className="employee-workspace-dialog"><div className="employee-dialog-content"><h2 id="adjustment-edit-title">Editar ajuste</h2><p>Al guardar, la versión anterior se conserva y la aprobación deberá revisarse.</p><div className="employee-inline-editor-grid"><label><span className="label">Fecha</span><DateField value={adjustmentDraft.date} onChange={(date) => setAdjustmentDraft((current) => ({ ...current, date }))} /></label><label><span className="label">Minutos</span><input className="input" type="number" value={adjustmentDraft.minutes} onChange={(event) => setAdjustmentDraft((current) => ({ ...current, minutes: event.target.value }))} /></label><label><span className="label">Tipo</span><Select value={adjustmentDraft.type} onValueChange={(value) => setAdjustmentDraft((current) => ({ ...current, type: value as HourAdjustment["adjustment_type"] }))}><SelectTrigger aria-label="Tipo de ajuste"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="PERMISO">Permiso</SelectItem><SelectItem value="RECUPERACION">Recuperación</SelectItem><SelectItem value="OVERTIME">Horas extra</SelectItem><SelectItem value="OTRO">Otro</SelectItem></SelectContent></Select></label><label><span className="label">Motivo</span><input className="input" value={adjustmentDraft.reason} onChange={(event) => setAdjustmentDraft((current) => ({ ...current, reason: event.target.value }))} /></label></div><div className="app-dialog-actions"><AppDialogCloseButton className="btn btn-ghost" disabled={adjustmentBusy}>Cancelar</AppDialogCloseButton><AsyncButton type="button" busy={adjustmentBusy} busyLabel="Guardando nueva versión…" disabled={adjustmentDraft.reason.trim().length < 3} onClick={() => void updateAdjustment()}>Guardar cambios</AsyncButton></div></div></AppDialog>}
      {voidingAdjustment && <AppDialog labelledBy="adjustment-void-title" onClose={() => setVoidingAdjustment(null)} dismissible={!adjustmentBusy} className="employee-workspace-dialog"><div className="employee-dialog-content is-danger"><h2 id="adjustment-void-title">Eliminar ajuste</h2><p>Se anulará de forma auditada: dejará de afectar saldo, acumulado y planilla, y su historial seguirá disponible.</p><label><span className="label">Motivo obligatorio</span><textarea className="input" value={voidReason} onChange={(event) => setVoidReason(event.target.value)} rows={3} /></label><div className="app-dialog-actions"><AppDialogCloseButton className="btn btn-ghost" disabled={adjustmentBusy}>Cancelar</AppDialogCloseButton><AsyncButton type="button" className="btn btn-danger" busy={adjustmentBusy} busyLabel="Eliminando ajuste…" disabled={voidReason.trim().length < 3} onClick={() => void voidAdjustment()}>Eliminar ajuste</AsyncButton></div></div></AppDialog>}
      {editingManual && manualDraft && <AppDialog labelledBy="manual-edit-title" onClose={() => { setEditingManual(null); setManualDraft(null); }} dismissible={!manualBusy} className="employee-workspace-dialog"><div className="employee-dialog-content"><h2 id="manual-edit-title">Editar carga del {editingManual.work_date}</h2><p>Normal, adicional y recuperación deben sumar el total neto. El importe adicional se vuelve a previsualizar.</p><div className="employee-inline-editor-grid"><label><span className="label">Total neto (min)</span><input className="input" type="number" min="0" value={manualDraft.worked_minutes_net} onChange={(event) => { setManualDraft({ ...manualDraft, worked_minutes_net: Number(event.target.value) }); setManualPreviewToken(null); }} /></label><label><span className="label">Normal (min)</span><input className="input" type="number" min="0" value={manualDraft.normal_minutes} onChange={(event) => { setManualDraft({ ...manualDraft, normal_minutes: Number(event.target.value) }); setManualPreviewToken(null); }} /></label><label><span className="label">Adicional (min)</span><input className="input" type="number" min="0" value={manualDraft.additional_minutes} onChange={(event) => { setManualDraft({ ...manualDraft, additional_minutes: Number(event.target.value) }); setManualPreviewToken(null); }} /></label><label><span className="label">Recuperación (min)</span><input className="input" type="number" min="0" value={manualDraft.recovery_minutes} onChange={(event) => { setManualDraft({ ...manualDraft, recovery_minutes: Number(event.target.value) }); setManualPreviewToken(null); }} /></label><label className="employee-batch-wide"><span className="label">Motivo</span><input className="input" value={manualDraft.reason} onChange={(event) => { setManualDraft({ ...manualDraft, reason: event.target.value }); setManualPreviewToken(null); }} /></label></div><div className="app-dialog-actions"><AppDialogCloseButton className="btn btn-ghost" disabled={manualBusy}>Cancelar</AppDialogCloseButton><AsyncButton type="button" className="btn btn-outline" busy={manualBusy && !manualPreviewToken} busyLabel="Calculando cambio…" disabled={manualDraft.reason.trim().length < 3} onClick={() => void previewManualEdit()}>Previsualizar cambio</AsyncButton>{manualPreviewToken && <AsyncButton type="button" busy={manualBusy} busyLabel="Guardando nueva versión…" onClick={() => void saveManualEdit()}>Guardar nueva versión</AsyncButton>}</div></div></AppDialog>}
      {voidingManual && <AppDialog labelledBy="manual-void-title" onClose={() => setVoidingManual(null)} dismissible={!manualBusy} className="employee-workspace-dialog"><div className="employee-dialog-content is-danger"><h2 id="manual-void-title">Anular carga del {voidingManual.work_date}</h2><p>Se retirará de saldo, acumulado y planilla; el registro anterior seguirá en el historial.</p><label><span className="label">Motivo obligatorio</span><textarea className="input" rows={3} value={manualVoidReason} onChange={(event) => setManualVoidReason(event.target.value)} /></label><div className="app-dialog-actions"><AppDialogCloseButton className="btn btn-ghost" disabled={manualBusy}>Cancelar</AppDialogCloseButton><AsyncButton type="button" className="btn btn-danger" busy={manualBusy} busyLabel="Anulando carga…" disabled={manualVoidReason.trim().length < 3} onClick={() => void voidManual()}>Anular carga</AsyncButton></div></div></AppDialog>}
    </section>
  );
});

export default EmployeeAttendanceWorkspace;
