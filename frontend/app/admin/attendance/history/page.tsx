"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import AdminShell from "@/components/AdminShell";
import {
  ApiError,
  authApi,
  employeesApi,
  Employee,
  historicalAttendanceApi,
  ManualAttendanceDay,
  ManualAttendanceRow,
} from "@/lib/api";
import { clearHistoricalOperation, readHistoricalOperation, saveHistoricalOperation } from "@/lib/historicalAttendanceOperation";

type PaymentPreview = {
  status: string;
  amount: string | null;
  reason?: string;
  method?: "OVERTIME" | "REVIEWED";
  concept?: string | null;
  reference?: string | null;
};
type PreviewRow = {
  employee_id: string;
  worked_minutes_net: number;
  normal_minutes: number;
  additional_minutes: number;
  recovery_minutes: number;
  payment?: PaymentPreview;
  warning?: string | null;
};
type Draft = ManualAttendanceRow & {
  selected: boolean;
  hours: string;
  minutes: string;
  treatment: "NORMAL" | "ADDITIONAL" | "RECOVERY" | "MIXED";
};
type EditDraft = ManualAttendanceDay & {
  hours: string;
  minutes: string;
  treatment: Draft["treatment"];
};

const defaultReason = "Carga de asistencia anterior al inicio del sistema";
const makeDraft = (employee: Employee): Draft => ({
  employee_id: employee.id,
  worked_minutes_net: 0,
  normal_minutes: 0,
  additional_minutes: 0,
  recovery_minutes: 0,
  reason: defaultReason,
  recovery_allocations: [],
  payment_method: null,
  payment_concept: null,
  source_reference: null,
  reviewed_additional_amount: null,
  selected: false,
  hours: "",
  minutes: "",
  treatment: "NORMAL",
});
const treatmentFor = (
  item: Pick<
    ManualAttendanceRow,
    "normal_minutes" | "additional_minutes" | "recovery_minutes"
  >,
): Draft["treatment"] => {
  const parts = [
    item.normal_minutes > 0,
    item.additional_minutes > 0,
    item.recovery_minutes > 0,
  ].filter(Boolean).length;
  if (parts > 1) return "MIXED";
  if (item.additional_minutes > 0) return "ADDITIONAL";
  if (item.recovery_minutes > 0) return "RECOVERY";
  return "NORMAL";
};
const knownTimeLabel = (value?: string | null) =>
  value
    ? new Intl.DateTimeFormat("es-PE", {
        dateStyle: "short",
        timeStyle: "short",
        timeZone: "America/Lima",
      }).format(new Date(value))
    : "Sin dato";
const toDateTimeInput = (value?: string | null) => {
  if (!value) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Lima",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(value));
  const part = (type: string) =>
    parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`;
};
const limaInputToIso = (value: string) =>
  value ? new Date(`${value}:00-05:00`).toISOString() : null;

function paymentLabel(
  payment: PaymentPreview | undefined,
  hasAdditional: boolean,
  effectiveStatus?: string,
) {
  if (!hasAdditional) return "No aplica";
  if (!payment) return "Sin valoración";
  const method =
    payment.method === "REVIEWED"
      ? "Importe revisado"
      : "Sobretiempo ordinario";
  const amount =
    payment.amount === null ? "sin importe" : `S/ ${payment.amount}`;
  // The row state is authoritative.  The nested snapshot is a valuation
  // record and can intentionally be older than a later approval transition.
  const status =
    (effectiveStatus ?? payment.status) === "APPROVED"
      ? "Aprobado"
      : (effectiveStatus ?? payment.status) === "PENDING"
        ? "Pendiente de aprobación"
        : effectiveStatus ?? payment.status;
  return `${method} · ${amount} · ${status}`;
}

export default function HistoricalAttendancePage() {
  const [workDate, setWorkDate] = useState("");
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<PreviewRow[] | null>(null);
  const [previewToken, setPreviewToken] = useState<string | null>(null);
  const previewRequest = useRef(0);
  const mutationInFlight = useRef<string | null>(null);
  const recoveryGeneration = useRef(0);
  const [batchKey, setBatchKey] = useState(() => crypto.randomUUID());
  const [operationUserId, setOperationUserId] = useState<string | null>(null);
  const [history, setHistory] = useState<ManualAttendanceDay[]>([]);
  const [historyOffset, setHistoryOffset] = useState(0);
  const [showVoided, setShowVoided] = useState(false);
  const [commitmentsByEmployee, setCommitmentsByEmployee] = useState<Record<string,
    {
      id: string;
      employee_id: string;
      pending_minutes: number;
      reference: string;
    }[]
  >>({});
  const [showTimes, setShowTimes] = useState(false);
  const [edit, setEdit] = useState<EditDraft | null>(null);
  const [editPreview, setEditPreview] = useState<PreviewRow | null>(null);
  const [editPreviewToken, setEditPreviewToken] = useState<string | null>(null);
  const editPreviewRequest = useRef(0);
  const [commitmentEmployee, setCommitmentEmployee] = useState("");
  const [commitmentDate, setCommitmentDate] = useState("");
  const [commitmentMinutes, setCommitmentMinutes] = useState("");
  const [commitmentCovered, setCommitmentCovered] = useState(false);
  const [commitmentReference, setCommitmentReference] = useState("");
  const loadHistory = async (offset = historyOffset, includeVoided = showVoided) => {
    try {
      const rows = await historicalAttendanceApi.list({ offset, limit: 50, include_voided: includeVoided });
      setHistory(rows);
      setHistoryOffset(offset);
      return true;
    } catch {
      return false;
    }
  };
  useEffect(() => {
    void authApi.me().then((user) => setOperationUserId(user.id)).catch(() => setOperationUserId(null));
    employeesApi
      .list()
      .then((rows) => {
        setEmployees(rows);
        setDrafts(rows.map(makeDraft));
      })
      .catch(() => setMessage("No se pudieron cargar los empleados."));
    loadHistory(0, false);
    // `loadHistory` deliberately receives explicit initial values here; it is
    // recreated with the render state and must not retrigger the initial load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!operationUserId) return;
    const generation = ++recoveryGeneration.current;
    const pending = readHistoricalOperation(operationUserId);
    if (!pending) return;
    void historicalAttendanceApi.operation(pending.key).then(async (receipt) => {
      if (generation !== recoveryGeneration.current) return;
      clearHistoricalOperation(operationUserId, pending.key);
      const refreshed = await loadHistory();
      if (generation !== recoveryGeneration.current) return;
      setMessage(refreshed
        ? `Operación recuperada: ${receipt.operation_type}. Historial actualizado.`
        : `Operación recuperada: ${receipt.operation_type}. No se pudo actualizar el historial.`);
    }).catch(() => {
      if (generation !== recoveryGeneration.current) return;
      setMessage("Hay una operación pendiente. Use Reintentar con el mismo envío; no cambie el formulario.");
    });
    return () => { recoveryGeneration.current += 1; };
  // The recovery is intentionally scoped to a user identity, not form state.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [operationUserId]);
  const refuseWhilePending = () => {
    if (!operationUserId) return false;
    if (!readHistoricalOperation(operationUserId)) return false;
    setMessage("Hay una operación pendiente. Resuélvala o reinténtela con el mismo envío antes de iniciar otra.");
    return true;
  };
  const selected = useMemo(
    () => drafts.filter((draft) => draft.selected),
    [drafts],
  );
  const update = (index: number, patch: Partial<Draft>) => {
    previewRequest.current += 1;
    setPreview(null);
    setPreviewToken(null);
    setBatchKey(crypto.randomUUID());
    setDrafts((all) =>
      all.map((item, itemIndex) =>
        itemIndex === index ? { ...item, ...patch } : item,
      ),
    );
  };
  const loadCommitments = async (employeeId: string) => {
    const loaded = await historicalAttendanceApi.commitments(employeeId);
    setCommitmentsByEmployee((current) => ({ ...current, [employeeId]: loaded }));
  };
  const commitmentsFor = (employeeId: string) => commitmentsByEmployee[employeeId] ?? [];
  const payloadRows = (): ManualAttendanceRow[] =>
    selected.filter((draft) => draft.hours !== "" || draft.minutes !== "").map((draft) => {
      const {
        hours,
        minutes,
        treatment,
        selected: isSelected,
        ...item
      } = draft;
      void isSelected;
      const total = Number(hours || 0) * 60 + Number(minutes || 0);
      let normal = total;
      let additional = 0;
      let recovery = 0;
      if (treatment === "ADDITIONAL") {
        normal = 0;
        additional = total;
      }
      if (treatment === "RECOVERY") {
        normal = 0;
        recovery = total;
      }
      if (treatment === "MIXED") {
        normal = item.normal_minutes;
        additional = item.additional_minutes;
        recovery = item.recovery_minutes;
      }
      const payment =
        additional > 0
          ? {
              payment_method: item.payment_method,
              payment_concept: item.payment_concept,
              source_reference: item.source_reference,
              reviewed_additional_amount: item.reviewed_additional_amount,
            }
          : {
              payment_method: null,
              payment_concept: null,
              source_reference: null,
              reviewed_additional_amount: null,
            };
      const allocations = recovery
        ? item.recovery_allocations.map((allocation) => ({
            ...allocation,
            // A recovery-only row has one visible total; changing that total
            // must not retain an invisible amount from the old selection.
            minutes: treatment === "RECOVERY" ? total : allocation.minutes,
          }))
        : [];
      return {
        ...item,
        ...payment,
        worked_minutes_net: total,
        normal_minutes: normal,
        additional_minutes: additional,
        recovery_minutes: recovery,
        recovery_allocations: allocations,
      };
    });
  const validationError = (rows: ManualAttendanceRow[]) => {
    if (rows.some((row) => !row.reason.trim()))
      return "El motivo es obligatorio.";
    if (rows.some((row) => row.additional_minutes > 0 && !row.payment_method))
      return "Seleccione el tratamiento de pago para cada adicional.";
    const reviewed = rows.find(
      (row) => row.additional_minutes > 0 && row.payment_method === "REVIEWED",
    );
    if (reviewed) {
      const amount = Number(reviewed.reviewed_additional_amount);
      if (!Number.isFinite(amount) || amount <= 0)
        return "El importe revisado debe ser mayor que S/ 0.00.";
      if (!reviewed.payment_concept?.trim())
        return "El concepto del importe revisado es obligatorio.";
      if (!reviewed.source_reference?.trim())
        return "La referencia del importe revisado es obligatoria.";
    }
    return null;
  };
  const buildPayload = (approveAdditional = false) => ({
    work_date: workDate,
    rows: payloadRows(),
    approve_additional: approveAdditional,
    idempotency_key: batchKey,
    preview_token: previewToken,
  });
  const runPreview = async () => {
    setMessage("");
    if (!workDate || !selected.length) {
      setMessage("Seleccione una fecha pasada y al menos un empleado.");
      return;
    }
    const rows = payloadRows();
    const error = validationError(rows);
    if (error) {
      setMessage(error);
      return;
    }
    setBusy(true);
    const request = ++previewRequest.current;
    try {
      const result = await historicalAttendanceApi.preview(buildPayload());
      // A slow answer for a prior date/distribution must never re-enable an
      // approval after the operator has already changed the form.
      if (request === previewRequest.current) {
        setPreview(result.rows as PreviewRow[]);
        setPreviewToken(result.preview_token);
      }
    } catch (error) {
      setMessage(
        error instanceof ApiError ? error.message : "No se pudo previsualizar.",
      );
    } finally {
      setBusy(false);
    }
  };
  const approvable =
    Boolean(preview?.some((row) => row.additional_minutes > 0)) &&
    Boolean(
      preview
        ?.filter((row) => row.additional_minutes > 0)
        .every(
          (row) =>
            row.payment?.status === "PENDING" && row.payment.amount !== null,
        ),
    );
  const save = async (approveAdditional: boolean) => {
    if (approveAdditional && !previewToken) {
      setMessage("Previsualice nuevamente antes de aprobar.");
      return;
    }
    const frozen = buildPayload(approveAdditional);
    if (!operationUserId) {
      setMessage("No se pudo confirmar el usuario actual; espere antes de guardar.");
      return;
    }
    if (refuseWhilePending()) return;
    if (mutationInFlight.current) return;
    if (!saveHistoricalOperation({ key: frozen.idempotency_key, userId: operationUserId, kind: "BATCH", payload: frozen })) {
      setMessage("No se pudo guardar el reintento local; la carga no fue enviada.");
      return;
    }
    mutationInFlight.current = frozen.idempotency_key;
    setBusy(true);
    try {
      const saved = await historicalAttendanceApi.batch(
        frozen,
      );
      clearHistoricalOperation(operationUserId, frozen.idempotency_key);
      setPreview(null);
      setPreviewToken(null);
      setBatchKey(crypto.randomUUID());
      setDrafts(employees.map(makeDraft));
      const refreshed = await loadHistory();
      setMessage(refreshed
        ? `${saved.created.length} carga(s) registrada(s).`
        : `${saved.created.length} carga(s) registrada(s). No se pudo actualizar el historial.`);
    } catch (error) {
      if (error instanceof ApiError && ["STALE_PREVIEW", "STALE_VERSION", "PAYROLL_CLOSED", "IDEMPOTENCY_CONFLICT"].includes(error.code ?? "")) {
        clearHistoricalOperation(operationUserId, frozen.idempotency_key);
        setMessage(error.code === "STALE_PREVIEW" ? "La valoración cambió. Previsualice de nuevo antes de aprobar." : error.code === "STALE_VERSION" ? "La versión cambió realmente; actualice el historial." : error.message);
      } else {
        setMessage("Resultado no confirmado: puede reintentar el mismo envío.");
      }
    } finally {
      if (mutationInFlight.current === frozen.idempotency_key) mutationInFlight.current = null;
      setBusy(false);
    }
  };
  const createCommitment = async () => {
    if (
      !commitmentEmployee ||
      !commitmentDate ||
      !commitmentMinutes ||
      !commitmentReference.trim()
    ) {
      setMessage(
        "Complete empleado, fecha, minutos y referencia del compromiso.",
      );
      return;
    }
    setBusy(true);
    try {
      await historicalAttendanceApi.createCommitment({
        employee_id: commitmentEmployee,
        permission_date: commitmentDate,
        agreed_minutes: Number(commitmentMinutes),
        covered_before: commitmentCovered,
        reference: commitmentReference.trim(),
      });
      await loadCommitments(commitmentEmployee);
      setMessage(
        "Compromiso histórico registrado. Ya puede seleccionarlo en la fila de recuperación.",
      );
      setCommitmentMinutes("");
      setCommitmentReference("");
    } catch (error) {
      setMessage(
        error instanceof ApiError
          ? error.message
          : "No se pudo registrar el compromiso.",
      );
    } finally {
      setBusy(false);
    }
  };
  const editRow = (): ManualAttendanceRow | null => {
    if (!edit) return null;
    const total = Number(edit.hours || 0) * 60 + Number(edit.minutes || 0);
    let normal = total;
    let additional = 0;
    let recovery = 0;
    if (edit.treatment === "ADDITIONAL") {
      normal = 0;
      additional = total;
    }
    if (edit.treatment === "RECOVERY") {
      normal = 0;
      recovery = total;
    }
    if (edit.treatment === "MIXED") {
      normal = edit.normal_minutes;
      additional = edit.additional_minutes;
      recovery = edit.recovery_minutes;
    }
    return {
      employee_id: edit.employee_id,
      worked_minutes_net: total,
      normal_minutes: normal,
      additional_minutes: additional,
      recovery_minutes: recovery,
      known_check_in_at: edit.known_check_in_at,
      known_check_out_at: edit.known_check_out_at,
      known_break_minutes: edit.known_break_minutes,
      day_context: edit.day_context,
      source_reference: additional ? edit.source_reference : null,
      payment_method: additional ? edit.payment_method : null,
      payment_concept: additional ? edit.payment_concept : null,
      reviewed_additional_amount: additional
        ? edit.reviewed_additional_amount
        : null,
      reason: edit.reason,
      recovery_allocations: recovery
        ? edit.recovery_allocations.map((allocation) => ({
            ...allocation,
            minutes:
              edit.treatment === "RECOVERY" ? total : allocation.minutes,
          }))
        : [],
    };
  };
  const updateEdit = (patch: Partial<EditDraft>) => {
    editPreviewRequest.current += 1;
    setEditPreview(null);
    setEditPreviewToken(null);
    setEdit((current) => (current ? { ...current, ...patch } : current));
  };
  const openEdit = async (id: string) => {
    setBusy(true);
    editPreviewRequest.current += 1;
    setMessage("");
    try {
      const item = await historicalAttendanceApi.get(id);
      await loadCommitments(item.employee_id);
      setEdit({
        ...item,
        reviewed_additional_amount:
          item.reviewed_additional_amount ??
          (item.payment_snapshot?.amount as string | null) ??
          null,
        hours: String(Math.floor(item.worked_minutes_net / 60)),
        minutes: String(item.worked_minutes_net % 60),
        treatment: treatmentFor(item),
      });
      setEditPreview(null);
      setEditPreviewToken(null);
    } catch (error) {
      setMessage(
        error instanceof ApiError
          ? error.message
          : "No se pudo cargar la versión vigente.",
      );
    } finally {
      setBusy(false);
    }
  };
  const previewEdit = async () => {
    if (!edit) return;
    const row = editRow();
    if (!row) return;
    const error = validationError([row]);
    if (error) {
      setMessage(error);
      return;
    }
    setBusy(true);
    const request = ++editPreviewRequest.current;
    try {
      const result = await historicalAttendanceApi.preview({
        work_date: edit.work_date,
        rows: [row],
        idempotency_key: crypto.randomUUID(),
        editing_manual_day_id: edit.id,
        expected_version: edit.version,
      });
      if (request === editPreviewRequest.current) {
        setEditPreview(result.rows[0] as PreviewRow);
        setEditPreviewToken(result.preview_token);
      }
    } catch (error) {
      setMessage(
        error instanceof ApiError
          ? error.message
          : "No se pudo previsualizar la corrección.",
      );
    } finally {
      setBusy(false);
    }
  };
  const saveEdit = async () => {
    if (!edit) return;
    const row = editRow();
    if (!row) return;
    const error = validationError([row]);
    if (error) {
      setMessage(error);
      return;
    }
    if (!editPreviewToken) {
      setMessage("Previsualice la corrección antes de guardarla.");
      return;
    }
    const frozen = { ...row, expected_version: edit.version, preview_token: editPreviewToken, idempotency_key: crypto.randomUUID() };
    if (!operationUserId) { setMessage("No se pudo confirmar el usuario actual; espere antes de guardar."); return; }
    if (refuseWhilePending()) return;
    if (mutationInFlight.current) return;
    if (!saveHistoricalOperation({ key: frozen.idempotency_key, userId: operationUserId, kind: "UPDATE", targetId: edit.id, payload: frozen })) {
      setMessage("No se pudo guardar el reintento local; la corrección no fue enviada.");
      return;
    }
    mutationInFlight.current = frozen.idempotency_key;
    setBusy(true);
    try {
      await historicalAttendanceApi.update(edit.id, {
        ...frozen,
      });
      clearHistoricalOperation(operationUserId, frozen.idempotency_key);
      setEdit(null);
      setEditPreview(null);
      setEditPreviewToken(null);
      setMessage(await loadHistory()
        ? "Corrección versionada guardada. El historial se actualizó."
        : "Corrección versionada guardada; no se pudo actualizar el historial.");
    } catch (error) {
      if (error instanceof ApiError && error.code === "STALE_PREVIEW") {
        clearHistoricalOperation(operationUserId, frozen.idempotency_key);
        setEditPreview(null); setEditPreviewToken(null);
        setMessage("La valoración cambió. Actualice la previsualización antes de guardar.");
      } else if (error instanceof ApiError && error.code === "STALE_VERSION") {
        clearHistoricalOperation(operationUserId, frozen.idempotency_key);
        await loadHistory();
        setMessage(
          "Esta carga cambió en otra sesión. Recargue el historial y vuelva a editar la versión vigente.",
        );
      } else
        setMessage(
          error instanceof ApiError
            ? error.message
            : "No se pudo guardar la corrección.",
        );
    } finally {
      if (mutationInFlight.current === frozen.idempotency_key) mutationInFlight.current = null;
      setBusy(false);
    }
  };
  const voidItem = async (item: ManualAttendanceDay) => {
    const key = crypto.randomUUID();
    const payload = { expected_version: item.version, reason: "Anulación administrativa", idempotency_key: key };
    if (!operationUserId) { setMessage("No se pudo confirmar el usuario actual; espere antes de anular."); return; }
    if (refuseWhilePending()) return;
    if (mutationInFlight.current) return;
    if (!saveHistoricalOperation({ key, userId: operationUserId, kind: "VOID", targetId: item.id, payload })) {
      setMessage("No se pudo guardar el reintento local; la anulación no fue enviada.");
      return;
    }
    mutationInFlight.current = key;
    setBusy(true);
    try {
      await historicalAttendanceApi.void(item.id, item.version, payload.reason, key);
      clearHistoricalOperation(operationUserId, key);
      setMessage(await loadHistory() ? "Anulación registrada." : "Anulación registrada; no se pudo actualizar el historial.");
    } catch (error) {
      if (error instanceof ApiError && ["STALE_VERSION", "PAYROLL_CLOSED", "IDEMPOTENCY_CONFLICT"].includes(error.code ?? "")) {
        clearHistoricalOperation(operationUserId, key);
        setMessage(error.code === "STALE_VERSION" ? "La carga cambió en otra sesión; actualice el historial." : error.message);
      } else setMessage("Resultado no confirmado: reintente la misma anulación.");
    } finally { if (mutationInFlight.current === key) mutationInFlight.current = null; setBusy(false); }
  };
  const approveItem = async (item: ManualAttendanceDay) => {
    if (!operationUserId) { setMessage("No se pudo confirmar el usuario actual; espere antes de aprobar."); return; }
    if (refuseWhilePending()) return;
    if (mutationInFlight.current) return;
    setBusy(true);
    let currentSnapshot: Record<string, unknown>;
    try {
      const valuation = await historicalAttendanceApi.preview({
        work_date: item.work_date,
        rows: [{
          employee_id: item.employee_id,
          worked_minutes_net: item.worked_minutes_net,
          normal_minutes: item.normal_minutes,
          additional_minutes: item.additional_minutes,
          recovery_minutes: item.recovery_minutes,
          known_check_in_at: item.known_check_in_at,
          known_check_out_at: item.known_check_out_at,
          known_break_minutes: item.known_break_minutes,
          day_context: item.day_context,
          source_reference: item.source_reference,
          payment_method: item.payment_method,
          payment_concept: item.payment_concept,
          reviewed_additional_amount: item.reviewed_additional_amount,
          reason: item.reason,
          recovery_allocations: item.recovery_allocations,
        }],
        idempotency_key: crypto.randomUUID(),
        editing_manual_day_id: item.id,
        expected_version: item.version,
      });
      currentSnapshot = valuation.rows[0].payment as Record<string, unknown>;
      const amount = currentSnapshot.amount == null ? "sin importe calculado" : `S/ ${currentSnapshot.amount}`;
      if (!window.confirm(`La valoración vigente es ${amount}. ¿Confirma aprobar exactamente este importe y contenido?`)) {
        setMessage("Aprobación cancelada; no se realizó ningún cambio.");
        return;
      }
    } catch (error) {
      setMessage(error instanceof ApiError ? error.message : "No se pudo obtener la valoración vigente.");
      return;
    } finally {
      setBusy(false);
    }
    const key = crypto.randomUUID();
    const payload = { expected_version: item.version, expected_snapshot: currentSnapshot!, idempotency_key: key };
    if (!saveHistoricalOperation({ key, userId: operationUserId, kind: "APPROVE", targetId: item.id, payload })) {
      setMessage("No se pudo guardar el reintento local; la aprobación no fue enviada.");
      return;
    }
    mutationInFlight.current = key;
    setBusy(true);
    try {
      await historicalAttendanceApi.approve(item.id, item.version, payload.expected_snapshot, key);
      clearHistoricalOperation(operationUserId, key);
      setMessage(await loadHistory() ? "Adicional aprobado." : "Adicional aprobado; no se pudo actualizar el historial.");
    } catch (error) {
      if (error instanceof ApiError && ["STALE_PREVIEW", "STALE_VERSION", "PAYROLL_CLOSED", "IDEMPOTENCY_CONFLICT"].includes(error.code ?? "")) {
        clearHistoricalOperation(operationUserId, key);
        setMessage(error.code === "STALE_PREVIEW" ? "La valoración cambió. Abra la carga, previsualice y apruebe nuevamente." : error.code === "STALE_VERSION" ? "La versión ya cambió; actualice el historial." : error.message);
      } else setMessage("Resultado no confirmado: reintente la misma aprobación.");
    } finally { if (mutationInFlight.current === key) mutationInFlight.current = null; setBusy(false); }
  };
  const retryPendingOperation = async () => {
    if (!operationUserId) return;
    const pending = readHistoricalOperation(operationUserId);
    if (!pending) { setMessage("No hay una operación pendiente para este usuario."); return; }
    if (mutationInFlight.current) return;
    mutationInFlight.current = pending.key;
    setBusy(true);
    try {
      if (pending.kind === "BATCH") await historicalAttendanceApi.batch(pending.payload as Parameters<typeof historicalAttendanceApi.batch>[0]);
      if (pending.kind === "UPDATE" && pending.targetId) await historicalAttendanceApi.update(pending.targetId, pending.payload as Parameters<typeof historicalAttendanceApi.update>[1]);
      if (pending.kind === "VOID" && pending.targetId) {
        const p = pending.payload as { expected_version: number; reason: string; idempotency_key: string };
        await historicalAttendanceApi.void(pending.targetId, p.expected_version, p.reason, p.idempotency_key);
      }
      if (pending.kind === "APPROVE" && pending.targetId) {
        const p = pending.payload as { expected_version: number; expected_snapshot: Record<string, unknown>; idempotency_key: string };
        await historicalAttendanceApi.approve(pending.targetId, p.expected_version, p.expected_snapshot, p.idempotency_key);
      }
      clearHistoricalOperation(operationUserId, pending.key);
      setMessage(await loadHistory()
        ? "Operación recuperada sin duplicar la carga."
        : "Operación recuperada sin duplicar la carga; no se pudo actualizar el historial.");
    } catch (error) {
      if (error instanceof ApiError && ["STALE_PREVIEW", "STALE_VERSION", "PAYROLL_CLOSED", "IDEMPOTENCY_CONFLICT"].includes(error.code ?? "")) {
        clearHistoricalOperation(operationUserId, pending.key);
        setMessage(error.code === "STALE_PREVIEW" ? "La valoración quedó obsoleta; obtenga una previsualización nueva." : error.code === "STALE_VERSION" ? "La operación no puede aplicarse: la versión cambió realmente." : error.message);
      } else setMessage("La operación sigue sin confirmación; conserve el mismo reintento.");
    } finally { if (mutationInFlight.current === pending.key) mutationInFlight.current = null; setBusy(false); }
  };
  return (
    <AdminShell
      title="Cargar horas anteriores"
      subtitle="Registro administrativo: no genera marcaciones de kiosco ni fotografías."
    >
      <div className="page-actions">
        <Link className="btn btn-secondary" href="/admin/attendance">
          Volver a asistencia
        </Link>
      </div>
      <section className="panel">
        <div className="form-row">
          <label>
            Fecha trabajada
            <input
              type="date"
              value={workDate}
              onChange={(event) => {
                previewRequest.current += 1;
                setWorkDate(event.target.value);
                setPreview(null);
                setPreviewToken(null);
                setBatchKey(crypto.randomUUID());
              }}
            />
          </label>
          <p className="muted">
            Debe ser anterior a hoy. Las horas son netas; los horarios son
            opcionales y no crean una entrada/salida.
          </p>
        </div>
        {message && (
          <div className="form-message"><p role="status">{message}</p>{operationUserId && readHistoricalOperation(operationUserId) && <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void retryPendingOperation()}>Reintentar operación pendiente</button>}</div>
        )}
        <label>
          <input
            type="checkbox"
            checked={showTimes}
            onChange={(event) => setShowTimes(event.target.checked)}
          />{" "}
          Horarios conocidos (opcionales)
        </label>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Incluir</th>
                <th>Empleado</th>
                <th>Trabajó</th>
                <th>Tratamiento</th>
                <th>Distribución / recuperación</th>
                <th>Pago adicional</th>
                <th>Motivo</th>
                {showTimes && <th>Entrada / salida</th>}
              </tr>
            </thead>
            <tbody>
              {drafts.map((row, index) => {
                const total =
                  Number(row.hours || 0) * 60 + Number(row.minutes || 0);
                const additional =
                  row.treatment === "ADDITIONAL"
                    ? total
                    : row.treatment === "MIXED"
                      ? row.additional_minutes
                      : 0;
                return (
                  <tr key={row.employee_id}>
                    <td>
                      <input
                        aria-label={`Incluir ${employees[index]?.first_name}`}
                        type="checkbox"
                        checked={row.selected}
                        onChange={(event) =>
                          update(index, { selected: event.target.checked })
                        }
                      />
                    </td>
                    <td>
                      {employees[index]?.first_name}{" "}
                      {employees[index]?.last_name}
                      <br />
                      <small>{employees[index]?.employee_code}</small>
                    </td>
                    <td>
                      <input
                        aria-label="Horas"
                        inputMode="numeric"
                        min="0"
                        max="24"
                        type="number"
                        value={row.hours}
                        onChange={(event) =>
                          update(index, { hours: event.target.value })
                        }
                        placeholder="h"
                      />
                      <input
                        aria-label="Minutos"
                        inputMode="numeric"
                        min="0"
                        max="59"
                        type="number"
                        value={row.minutes}
                        onChange={(event) =>
                          update(index, { minutes: event.target.value })
                        }
                        placeholder="min"
                      />
                    </td>
                    <td>
                      <select
                        value={row.treatment}
                        onChange={(event) => {
                          const treatment = event.target
                            .value as Draft["treatment"];
                          update(index, { treatment });
                          if (treatment === "RECOVERY" || treatment === "MIXED")
                            void loadCommitments(row.employee_id);
                        }}
                      >
                        <option value="NORMAL">Jornada normal</option>
                        <option value="ADDITIONAL">Adicional pagado</option>
                        <option value="RECOVERY">Recuperación</option>
                        <option value="MIXED">Dividir horas</option>
                      </select>
                    </td>
                    <td>
                      {row.treatment === "MIXED" ? (
                        <>
                          <input
                            aria-label="Normal"
                            type="number"
                            min="0"
                            value={row.normal_minutes || ""}
                            onChange={(event) =>
                              update(index, {
                                normal_minutes: Number(event.target.value),
                              })
                            }
                            placeholder="N"
                          />
                          <input
                            aria-label="Adicional"
                            type="number"
                            min="0"
                            value={row.additional_minutes || ""}
                            onChange={(event) =>
                              update(index, {
                                additional_minutes: Number(event.target.value),
                              })
                            }
                            placeholder="P"
                          />
                          <input
                            aria-label="Recuperación"
                            type="number"
                            min="0"
                            value={row.recovery_minutes || ""}
                            onChange={(event) =>
                              update(index, {
                                recovery_minutes: Number(event.target.value),
                                recovery_allocations:
                                  row.recovery_allocations.map(
                                    (allocation) => ({
                                      ...allocation,
                                      minutes: Number(event.target.value),
                                    }),
                                  ),
                              })
                            }
                            placeholder="R"
                          />
                          {row.recovery_minutes > 0 && (
                            <select
                              aria-label="Compromiso mixto"
                              onChange={(event) =>
                                update(index, {
                                  recovery_allocations: event.target.value
                                    ? [
                                        {
                                          commitment_id: event.target.value,
                                          minutes: row.recovery_minutes,
                                        },
                                      ]
                                    : [],
                                })
                              }
                            >
                              <option value="">Seleccione compromiso</option>
                              {commitmentsFor(row.employee_id).map((commitment) => (
                                  <option
                                    key={commitment.id}
                                    value={commitment.id}
                                  >
                                    {commitment.reference} · pendiente{" "}
                                    {commitment.pending_minutes} min
                                  </option>
                                ))}
                            </select>
                          )}
                        </>
                      ) : row.treatment === "RECOVERY" ? (
                        <select
                          aria-label="Compromiso"
                          onChange={(event) =>
                            update(index, {
                              recovery_allocations: event.target.value
                                ? [
                                    {
                                      commitment_id: event.target.value,
                                      minutes: total,
                                    },
                                  ]
                                : [],
                            })
                          }
                        >
                          <option value="">Seleccione compromiso</option>
                          {commitmentsFor(row.employee_id).map((commitment) => (
                              <option key={commitment.id} value={commitment.id}>
                                {commitment.reference} · pendiente{" "}
                                {commitment.pending_minutes} min
                              </option>
                            ))}
                        </select>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td>
                      {additional > 0 ? (
                        <div>
                          <select
                            aria-label="Método de pago adicional"
                            value={row.payment_method ?? ""}
                            onChange={(event) =>
                              update(index, {
                                payment_method: event.target.value
                                  ? (event.target.value as
                                      "OVERTIME" | "REVIEWED")
                                  : null,
                              })
                            }
                          >
                            <option value="">Seleccione método</option>
                            <option value="OVERTIME">
                              Sobretiempo ordinario
                            </option>
                            <option value="REVIEWED">Importe revisado</option>
                          </select>
                          {row.payment_method === "REVIEWED" && (
                            <>
                              <input
                                aria-label="Importe revisado"
                                type="number"
                                inputMode="decimal"
                                min="0.01"
                                step="0.01"
                                value={row.reviewed_additional_amount ?? ""}
                                onChange={(event) =>
                                  update(index, {
                                    reviewed_additional_amount:
                                      event.target.value || null,
                                  })
                                }
                                placeholder="S/ 0.00"
                              />
                              <input
                                aria-label="Concepto de importe revisado"
                                value={row.payment_concept ?? ""}
                                onChange={(event) =>
                                  update(index, {
                                    payment_concept: event.target.value || null,
                                  })
                                }
                                placeholder="Concepto"
                              />
                              <input
                                aria-label="Referencia de importe revisado"
                                value={row.source_reference ?? ""}
                                onChange={(event) =>
                                  update(index, {
                                    source_reference:
                                      event.target.value || null,
                                  })
                                }
                                placeholder="Referencia"
                              />
                            </>
                          )}
                        </div>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td>
                      <input
                        aria-label="Motivo"
                        value={row.reason}
                        onChange={(event) =>
                          update(index, { reason: event.target.value })
                        }
                      />
                    </td>
                    {showTimes && (
                      <td>
                        <input
                          type="datetime-local"
                          aria-label="Entrada conocida"
                          onChange={(event) =>
                            update(index, {
                              known_check_in_at: limaInputToIso(event.target.value),
                            })
                          }
                        />
                        <input
                          type="datetime-local"
                          aria-label="Salida conocida"
                          onChange={(event) =>
                            update(index, {
                              known_check_out_at: limaInputToIso(event.target.value),
                            })
                          }
                        />
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="page-actions">
          <button
            className="btn btn-secondary"
            disabled={busy}
            onClick={runPreview}
          >
            Previsualizar
          </button>
          {preview && (
            <>
              <button
                className="btn btn-secondary"
                disabled={busy}
                onClick={() => save(false)}
              >
                Guardar horas
              </button>
              <button
                className="btn"
                disabled={busy || !approvable}
                onClick={() => save(true)}
              >
                Guardar y aprobar adicionales
              </button>
            </>
          )}
        </div>
        {preview && (
          <div className="panel">
            <h2>Previsualización</h2>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Empleado</th>
                    <th>Total</th>
                    <th>Normal</th>
                    <th>Adicional</th>
                    <th>Recuperación</th>
                    <th>Pago adicional</th>
                    <th>Observación</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.map((item) => (
                    <tr key={item.employee_id}>
                      <td>
                        {employees.find(
                          (employee) => employee.id === item.employee_id,
                        )?.first_name ?? item.employee_id}
                      </td>
                      <td>{item.worked_minutes_net} min</td>
                      <td>{item.normal_minutes} min</td>
                      <td>{item.additional_minutes} min</td>
                      <td>{item.recovery_minutes} min</td>
                      <td>
                        {paymentLabel(
                          item.payment,
                          item.additional_minutes > 0,
                        )}
                        {item.payment?.method === "REVIEWED" && (
                          <>
                            <br />
                            <small>
                              {item.payment.concept} · {item.payment.reference}
                            </small>
                          </>
                        )}
                      </td>
                      <td>
                        {item.warning ??
                          item.payment?.reason ??
                          "Sin observaciones"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>
      <section className="panel">
        <h2>Compromiso histórico de recuperación</h2>
        <p className="muted">
          Registre el permiso pendiente antes de aplicar horas de recuperación.
          Indique si el permiso ya fue reconocido en el saldo.
        </p>
        <div className="form-row">
          <label>
            Empleado
            <select
              aria-label="Empleado del compromiso"
              value={commitmentEmployee}
              onChange={(event) => {
                setCommitmentEmployee(event.target.value);
                if (event.target.value)
                  void loadCommitments(event.target.value);
              }}
            >
              <option value="">Seleccione empleado</option>
              {employees.map((employee) => (
                <option key={employee.id} value={employee.id}>
                  {employee.first_name} {employee.last_name} ·{" "}
                  {employee.employee_code}
                </option>
              ))}
            </select>
          </label>
          <label>
            Fecha del permiso
            <input
              aria-label="Fecha del permiso"
              type="date"
              value={commitmentDate}
              onChange={(event) => setCommitmentDate(event.target.value)}
            />
          </label>
          <label>
            Minutos pendientes
            <input
              aria-label="Minutos pendientes"
              type="number"
              min="1"
              max="1440"
              value={commitmentMinutes}
              onChange={(event) => setCommitmentMinutes(event.target.value)}
            />
          </label>
          <label>
            Referencia
            <input
              aria-label="Referencia del compromiso"
              value={commitmentReference}
              onChange={(event) => setCommitmentReference(event.target.value)}
              placeholder="Permiso acordado"
            />
          </label>
          <label>
            <input
              aria-label="Permiso ya reconocido"
              type="checkbox"
              checked={commitmentCovered}
              onChange={(event) => setCommitmentCovered(event.target.checked)}
            />{" "}
            Permiso ya reconocido en el saldo
          </label>
        </div>
        <button
          className="btn btn-secondary"
          disabled={busy}
          onClick={createCommitment}
        >
          Registrar compromiso histórico
        </button>
      </section>
      <section className="panel">
        <h2>Historial de cargas</h2>
        <div className="page-actions">
          <label>
            <input
              type="checkbox"
              checked={showVoided}
              onChange={(event) => {
                const includeVoided = event.target.checked;
                setShowVoided(includeVoided);
                void loadHistory(0, includeVoided);
              }}
            />{" "}
            Mostrar anuladas y linaje
          </label>
        </div>
        {history.length ? (<>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Fecha / empleado</th>
                  <th>W real</th>
                  <th>N normal</th>
                  <th>P adicional</th>
                  <th>R recuperación</th>
                  <th>Horarios conocidos</th>
                  <th>Motivo</th>
                  <th>Pago / versión</th>
                  <th>Acciones</th>
                </tr>
              </thead>
              <tbody>
                {history.map((item) => {
                  const employee = employees.find(
                    (entry) => entry.id === item.employee_id,
                  );
                  return (
                    <tr key={item.id}>
                      <td>
                        <strong>Carga histórica administrativa</strong>
                        <br />
                        {item.work_date}
                        <br />
                        <small>
                          {employee
                            ? `${employee.first_name} ${employee.last_name}`
                            : item.employee_id}
                        </small>
                      </td>
                      <td>{item.worked_minutes_net} min</td>
                      <td>{item.normal_minutes} min</td>
                      <td>{item.additional_minutes} min</td>
                      <td>{item.recovery_minutes} min</td>
                      <td>
                        Entrada: {knownTimeLabel(item.known_check_in_at)}
                        <br />
                        Salida: {knownTimeLabel(item.known_check_out_at)}
                      </td>
                      <td>{item.reason}</td>
                      <td>
                        {paymentLabel(
                          item.payment_snapshot
                            ? {
                                ...(item.payment_snapshot as PaymentPreview),
                                status: item.payment_status,
                              }
                            : undefined,
                          item.additional_minutes > 0,
                        )}
                        <br />
                        <small>Versión {item.version}</small>
                      </td>
                      <td>
                        <button
                          className="btn btn-ghost btn-sm"
                          disabled={busy}
                          onClick={() => void openEdit(item.id)}
                        >
                          Editar
                        </button>{" "}
                        <button
                          className="btn btn-ghost btn-sm"
                          disabled={busy}
                          onClick={() => void voidItem(item)}
                        >
                          Anular
                        </button>
                        {item.payment_status === "PENDING" &&
                          item.payment_snapshot && (
                            <button
                              className="btn btn-ghost btn-sm"
                              disabled={busy}
                              onClick={() => void approveItem(item)}
                            >
                              Aprobar
                            </button>
                          )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="page-actions">
            <button className="btn btn-ghost btn-sm" disabled={busy || historyOffset === 0} onClick={() => void loadHistory(Math.max(0, historyOffset - 50))}>Más recientes</button>
            <button className="btn btn-ghost btn-sm" disabled={busy || history.length < 50} onClick={() => void loadHistory(historyOffset + 50)}>Más antiguas</button>
          </div>
        </>) : (
          <p className="muted">Sin cargas históricas.</p>
        )}
      </section>
      {edit && (
        <section
          className="panel"
          role="dialog"
          aria-modal="true"
          aria-label="Editar carga histórica"
        >
          <h2>Editar carga histórica</h2>
          <p className="muted">
            La corrección crea una nueva versión auditada. Empleado y fecha son
            inmutables.
          </p>
          <div className="form-row">
            <label>
              Empleado
              <input
                aria-label="Empleado inmutable"
                readOnly
                value={
                  employees.find((employee) => employee.id === edit.employee_id)
                    ? `${employees.find((employee) => employee.id === edit.employee_id)?.first_name} ${employees.find((employee) => employee.id === edit.employee_id)?.last_name}`
                    : edit.employee_id
                }
              />
            </label>
            <label>
              Fecha trabajada
              <input
                aria-label="Fecha inmutable"
                readOnly
                value={edit.work_date}
              />
            </label>
            <label>
              Horas
              <input
                aria-label="Horas editadas"
                type="number"
                min="0"
                max="24"
                value={edit.hours}
                onChange={(event) => updateEdit({ hours: event.target.value })}
              />
            </label>
            <label>
              Minutos
              <input
                aria-label="Minutos editados"
                type="number"
                min="0"
                max="59"
                value={edit.minutes}
                onChange={(event) =>
                  updateEdit({ minutes: event.target.value })
                }
              />
            </label>
            <label>
              Tratamiento
              <select
                aria-label="Tratamiento de edición"
                value={edit.treatment}
                onChange={(event) => {
                  const treatment = event.target.value as Draft["treatment"];
                  updateEdit({ treatment });
                  if (treatment === "RECOVERY" || treatment === "MIXED")
                    void loadCommitments(edit.employee_id);
                }}
              >
                <option value="NORMAL">Jornada normal</option>
                <option value="ADDITIONAL">Adicional pagado</option>
                <option value="RECOVERY">Recuperación</option>
                <option value="MIXED">Dividir horas</option>
              </select>
            </label>
          </div>
          {edit.treatment === "MIXED" && (
            <div className="form-row">
              <label>
                Normal
                <input
                  aria-label="Normal editado"
                  type="number"
                  min="0"
                  value={edit.normal_minutes || ""}
                  onChange={(event) =>
                    updateEdit({ normal_minutes: Number(event.target.value) })
                  }
                />
              </label>
              <label>
                Adicional
                <input
                  aria-label="Adicional editado"
                  type="number"
                  min="0"
                  value={edit.additional_minutes || ""}
                  onChange={(event) =>
                    updateEdit({
                      additional_minutes: Number(event.target.value),
                    })
                  }
                />
              </label>
              <label>
                Recuperación
                <input
                  aria-label="Recuperación editada"
                  type="number"
                  min="0"
                  value={edit.recovery_minutes || ""}
                  onChange={(event) =>
                    updateEdit({
                      recovery_minutes: Number(event.target.value),
                      recovery_allocations: edit.recovery_allocations.map(
                        (allocation) => ({
                          ...allocation,
                          minutes: Number(event.target.value),
                        }),
                      ),
                    })
                  }
                />
              </label>
            </div>
          )}
          {(edit.treatment === "RECOVERY" ||
            (edit.treatment === "MIXED" && edit.recovery_minutes > 0)) && (
            <label>
              Compromiso
              <select
                aria-label="Compromiso editado"
                value={edit.recovery_allocations[0]?.commitment_id ?? ""}
                onChange={(event) =>
                  updateEdit({
                    recovery_allocations: event.target.value
                      ? [
                          {
                            commitment_id: event.target.value,
                            minutes:
                              edit.treatment === "RECOVERY"
                                ? Number(edit.hours || 0) * 60 +
                                  Number(edit.minutes || 0)
                                : edit.recovery_minutes,
                          },
                        ]
                      : [],
                  })
                }
              >
                <option value="">Seleccione compromiso</option>
                {commitmentsFor(edit.employee_id).map((commitment) => (
                    <option key={commitment.id} value={commitment.id}>
                      {commitment.reference} · pendiente{" "}
                      {commitment.pending_minutes} min
                    </option>
                  ))}
              </select>
            </label>
          )}
          {(edit.treatment === "ADDITIONAL" ||
            (edit.treatment === "MIXED" && edit.additional_minutes > 0)) && (
            <div className="form-row">
              <label>
                Método de pago adicional
                <select
                  aria-label="Método de pago adicional editado"
                  value={edit.payment_method ?? ""}
                  onChange={(event) =>
                    updateEdit({
                      payment_method: event.target.value
                        ? (event.target.value as "OVERTIME" | "REVIEWED")
                        : null,
                    })
                  }
                >
                  <option value="">Seleccione método</option>
                  <option value="OVERTIME">Sobretiempo ordinario</option>
                  <option value="REVIEWED">Importe revisado</option>
                </select>
              </label>
              {edit.payment_method === "REVIEWED" && (
                <>
                  <label>
                    Importe revisado
                    <input
                      aria-label="Importe revisado editado"
                      type="number"
                      min="0.01"
                      step="0.01"
                      value={edit.reviewed_additional_amount ?? ""}
                      onChange={(event) =>
                        updateEdit({
                          reviewed_additional_amount:
                            event.target.value || null,
                        })
                      }
                    />
                  </label>
                  <label>
                    Concepto
                    <input
                      aria-label="Concepto editado"
                      value={edit.payment_concept ?? ""}
                      onChange={(event) =>
                        updateEdit({
                          payment_concept: event.target.value || null,
                        })
                      }
                    />
                  </label>
                  <label>
                    Referencia
                    <input
                      aria-label="Referencia editada"
                      value={edit.source_reference ?? ""}
                      onChange={(event) =>
                        updateEdit({
                          source_reference: event.target.value || null,
                        })
                      }
                    />
                  </label>
                </>
              )}
            </div>
          )}
          <div className="form-row">
            <label>
              Entrada conocida
              <input
                aria-label="Entrada conocida editada"
                type="datetime-local"
                value={toDateTimeInput(edit.known_check_in_at)}
                onChange={(event) =>
                  updateEdit({
                    known_check_in_at: limaInputToIso(event.target.value),
                  })
                }
              />
            </label>
            <label>
              Salida conocida
              <input
                aria-label="Salida conocida editada"
                type="datetime-local"
                value={toDateTimeInput(edit.known_check_out_at)}
                onChange={(event) =>
                  updateEdit({
                    known_check_out_at: limaInputToIso(event.target.value),
                  })
                }
              />
            </label>
            <label>
              Motivo
              <input
                aria-label="Motivo de edición"
                value={edit.reason}
                onChange={(event) => updateEdit({ reason: event.target.value })}
              />
            </label>
          </div>
          {editPreview && (
            <p className="form-message">
              Previsualización: W {editPreview.worked_minutes_net} min · N{" "}
              {editPreview.normal_minutes} min · P{" "}
              {editPreview.additional_minutes} min · R{" "}
              {editPreview.recovery_minutes} min ·{" "}
              {paymentLabel(
                editPreview.payment,
                editPreview.additional_minutes > 0,
              )}
            </p>
          )}
          <div className="page-actions">
            <button
              className="btn btn-secondary"
              disabled={busy}
              onClick={() => void previewEdit()}
            >
              Previsualizar cambios
            </button>
            <button
              className="btn"
              disabled={busy}
              onClick={() => void saveEdit()}
            >
              Guardar corrección
            </button>
            <button
              className="btn btn-ghost"
              disabled={busy}
              onClick={() => {
                setEdit(null);
                setEditPreview(null);
              }}
            >
              Cancelar
            </button>
          </div>
        </section>
      )}
    </AdminShell>
  );
}
