import { useCallback, useEffect, useState, type FormEvent } from "react";
import AppDialog, { AppDialogCloseButton } from "@/components/AppDialog";
import { useAdminViewState } from "@/components/AdminViewState";
import { Alert, Check, Clock, Eye, Info, Refresh, Search, Shield, X } from "@/components/Icons";
import { Spinner } from "@/components/Loading";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  ApiError,
  attendanceRecoveryAdminApi,
  type Employee,
  type RecoveryDecision,
  type RecoveryRequestAdminDetail,
  type RecoveryRequestAdminItem,
  type RecoveryRequestStatusValue,
} from "@/lib/api";

/**
 * Panel ADMIN/BOSS de solicitudes de recuperación de sesión.
 *
 * Sólo lista, inspecciona y resuelve con motivo auditado. No registra
 * asistencia, no cambia horas y no reutiliza el token del intento. Toda la
 * decisión efectiva la aplica el servidor bajo el lock del empleado; esta UI
 * muestra lo que el servidor inspeccionó y jamás inventa un estado.
 */

const STATUS_LABEL: Record<RecoveryRequestStatusValue, string> = {
  PENDING: "Pendiente de revisión",
  AUTHORIZED: "Autorizada para identificarse",
  REJECTED: "Rechazada",
  CONFIRMED_EXISTING: "Confirmación ya registrada",
};

const STATUS_BADGE: Record<RecoveryRequestStatusValue, string> = {
  PENDING: "badge badge-amber",
  AUTHORIZED: "badge badge-green",
  REJECTED: "badge badge-red",
  CONFIRMED_EXISTING: "badge badge-blue",
};

const ATTEMPT_STATE_LABEL: Record<string, string> = {
  PREPARATION_ONLY: "preparado, sin marcación confirmada",
  EXPIRED_UNCONFIRMED: "preparación vencida, sin marcación confirmada",
  EMPTY: "sin preparación, foto ni marcación asociadas",
  UNVERIFIABLE_BROWSER: "no se pudo verificar el navegador del intento",
  UNKNOWN: "sin datos suficientes",
  CANCELLED: "cancelado sin crear marcación",
  REVIEWED: "revisado y confirmado",
  CONFIRMED: "confirmado",
  CONFIRMED_WINDOW_ELAPSED: "confirmado fuera del plazo de revisión",
  INCONSISTENT: "inconsistente: requiere corrección manual",
  EVIDENCE_ONLY: "sólo evidencia, sin marcación",
};

const DECISION_LABEL: Record<RecoveryDecision, string> = {
  AUTHORIZE_REIDENTIFY: "Autorizar una nueva identificación",
  REJECT: "Rechazar la recuperación",
  CONFIRM_EXISTING: "Confirmar la marcación ya existente",
};

function actionLabel(action: string): string {
  if (action === "CHECK_IN") return "Entrada";
  if (action === "CHECK_OUT") return "Salida";
  return action || "—";
}

function attemptStateLabel(state: string): string {
  return ATTEMPT_STATE_LABEL[state] ?? "estado no reconocido";
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleString("es-PE", {
    timeZone: "America/Lima",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const [year, month, day] = value.slice(0, 10).split("-");
  return year && month && day ? `${day}/${month}/${year}` : value;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError && error.message ? error.message : fallback;
}

export default function AttendanceRecoveryPanel({
  employees,
  onResolved,
}: {
  employees: Employee[];
  onResolved?: () => void;
}) {
  const [statusFilter, setStatusFilter] = useAdminViewState<string>("attendance.recovery.status", "");
  const [employeeFilter, setEmployeeFilter] = useAdminViewState<string>("attendance.recovery.employee", "");
  const [query, setQuery] = useAdminViewState<string>("attendance.recovery.query", "");
  const [queryDraft, setQueryDraft] = useState(query);
  const [items, setItems] = useState<RecoveryRequestAdminItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [detailId, setDetailId] = useState<string | null>(null);
  const [detail, setDetail] = useState<RecoveryRequestAdminDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [decision, setDecision] = useState<RecoveryDecision>("REJECT");
  const [reason, setReason] = useState("");
  const [resolving, setResolving] = useState(false);
  const [resolveError, setResolveError] = useState<string | null>(null);

  const load = useCallback(
    async (mode: "initial" | "refresh" = "refresh") => {
      if (mode === "initial") setLoading(true);
      else setRefreshing(true);
      try {
        const list = await attendanceRecoveryAdminApi.list({
          status: statusFilter as RecoveryRequestStatusValue | "",
          employee_id: employeeFilter,
          q: query,
          limit: 50,
        });
        setItems(list);
        setError(null);
      } catch (err) {
        setError(errorMessage(err, "No se pudieron cargar las solicitudes de recuperación."));
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [employeeFilter, query, statusFilter],
  );

  useEffect(() => {
    void load("initial");
  }, [load]);

  async function openDetail(item: RecoveryRequestAdminItem) {
    setDetailId(item.id);
    setDetail(null);
    setDetailError(null);
    setResolveError(null);
    setReason("");
    setResolving(false);
    setDetailLoading(true);
    try {
      const loaded = await attendanceRecoveryAdminApi.detail(item.id);
      setDetail(loaded);
      setDecision(
        loaded.attempt.can_authorize && !loaded.attempt.inconsistent ? "AUTHORIZE_REIDENTIFY" : "REJECT",
      );
    } catch (err) {
      setDetailError(errorMessage(err, "No se pudo inspeccionar la solicitud."));
    } finally {
      setDetailLoading(false);
    }
  }

  function closeDetail() {
    if (resolving) return;
    setDetailId(null);
    setDetail(null);
    setDetailError(null);
    setResolveError(null);
  }

  function submitSearch(event: FormEvent) {
    event.preventDefault();
    setQuery(queryDraft.trim());
  }

  async function resolveRequest(event: FormEvent) {
    event.preventDefault();
    if (!detail || resolving) return;
    if (reason.trim().length < 3) {
      setResolveError("El motivo es obligatorio (mínimo 3 caracteres).");
      return;
    }
    if (decision === "AUTHORIZE_REIDENTIFY" && (!detail.attempt.can_authorize || detail.attempt.inconsistent)) {
      setResolveError("Este intento no se puede autorizar: es inconsistente o requiere corrección manual.");
      return;
    }
    setResolving(true);
    setResolveError(null);
    try {
      const updated = await attendanceRecoveryAdminApi.resolve(detail.request.id, decision, reason.trim());
      setDetail(updated);
      setReason("");
      await load("refresh");
      onResolved?.();
    } catch (err) {
      setResolveError(errorMessage(err, "No se pudo resolver la solicitud."));
    } finally {
      setResolving(false);
    }
  }

  const authorizeBlocked = Boolean(detail && (detail.attempt.inconsistent || !detail.attempt.can_authorize));
  const canSubmit =
    Boolean(detail) &&
    detail?.request.status === "PENDING" &&
    reason.trim().length >= 3 &&
    !resolving &&
    !(decision === "AUTHORIZE_REIDENTIFY" && authorizeBlocked);

  return (
    <section className="attendance-recovery-panel" aria-labelledby="recovery-panel-title">
      <div className="recovery-panel-head">
        <div>
          <h2 className="card-title" id="recovery-panel-title">
            <Shield size={18} /> Solicitudes de recuperación
          </h2>
          <p className="card-sub">
            Intentos de la tablet con sesión perdida. Resolver aquí no registra asistencia ni cambia horas.
          </p>
        </div>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => void load("refresh")}
          disabled={loading || refreshing}
          aria-busy={refreshing}
          data-testid="recovery-refresh"
        >
          <Refresh size={15} />
          {refreshing ? "Actualizando…" : "Actualizar"}
        </button>
      </div>

      <form className="recovery-filters" onSubmit={submitSearch} aria-label="Filtros de solicitudes de recuperación">
        <div className="recovery-filter">
          <label className="recovery-filter-label" htmlFor="recovery-status-filter">
            Estado
          </label>
          <Select
            value={statusFilter || "__all"}
            onValueChange={(value) => setStatusFilter(value === "__all" ? "" : value)}
          >
            <SelectTrigger id="recovery-status-filter" aria-label="Filtrar solicitudes por estado">
              <SelectValue placeholder="Todos los estados" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all">Todos los estados</SelectItem>
              <SelectItem value="PENDING">Pendientes</SelectItem>
              <SelectItem value="AUTHORIZED">Autorizadas</SelectItem>
              <SelectItem value="REJECTED">Rechazadas</SelectItem>
              <SelectItem value="CONFIRMED_EXISTING">Confirmación existente</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="recovery-filter">
          <label className="recovery-filter-label" htmlFor="recovery-employee-filter">
            Empleado
          </label>
          <Select
            value={employeeFilter || "__all"}
            onValueChange={(value) => setEmployeeFilter(value === "__all" ? "" : value)}
          >
            <SelectTrigger id="recovery-employee-filter" aria-label="Filtrar solicitudes por empleado">
              <SelectValue placeholder="Todos los empleados" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all">Todos los empleados</SelectItem>
              {employees.map((employee) => (
                <SelectItem key={employee.id} value={employee.id}>
                  {employee.first_name} {employee.last_name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="recovery-filter recovery-filter--search">
          <label className="recovery-filter-label" htmlFor="recovery-query">
            Buscar
          </label>
          <div className="recovery-search">
            <Search size={15} aria-hidden="true" />
            <input
              id="recovery-query"
              className="input"
              type="search"
              value={queryDraft}
              onChange={(event) => setQueryDraft(event.target.value)}
              placeholder="Nombre, DNI o referencia"
              maxLength={80}
              data-testid="recovery-query"
            />
          </div>
        </div>
        <button type="submit" className="btn btn-outline btn-sm recovery-search-submit" disabled={loading}>
          Buscar
        </button>
      </form>

      {error && (
        <p className="alert alert-error" role="alert" data-testid="recovery-list-error">
          <Alert size={15} />
          <span>{error}</span>
        </p>
      )}

      {loading ? (
        <p className="recovery-loading" role="status">
          <Spinner size={16} /> Cargando solicitudes…
        </p>
      ) : items.length === 0 ? (
        <p className="empty" data-testid="recovery-empty">
          No hay solicitudes de recuperación con estos filtros.
        </p>
      ) : (
        <div className="table-wrap recovery-table-wrap">
          <table className="table recovery-table">
            <thead>
              <tr>
                <th scope="col">Empleado</th>
                <th scope="col">Acción</th>
                <th scope="col">Estado</th>
                <th scope="col">Solicitada</th>
                <th scope="col">Referencia</th>
                <th scope="col">Resuelta</th>
                <th scope="col">
                  <span className="sr-only">Acciones</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} data-testid="recovery-row">
                  <td data-label="Empleado">
                    <span className="recovery-employee-name">{item.employee_name ?? item.employee_id}</span>
                    {item.employee_dni && <span className="recovery-employee-dni">DNI {item.employee_dni}</span>}
                  </td>
                  <td data-label="Acción">{actionLabel(item.action)}</td>
                  <td data-label="Estado">
                    <span className={STATUS_BADGE[item.status]}>{STATUS_LABEL[item.status]}</span>
                  </td>
                  <td data-label="Solicitada">{formatDateTime(item.requested_at)}</td>
                  <td data-label="Referencia">
                    <code className="recovery-nonce">{item.nonce}</code>
                  </td>
                  <td data-label="Resuelta">
                    {item.resolved_at ? formatDateTime(item.resolved_at) : "—"}
                    {item.resolved_by_username && (
                      <span className="recovery-resolved-by">por {item.resolved_by_username}</span>
                    )}
                  </td>
                  <td className="recovery-row-action">
                    <button
                      type="button"
                      className="btn btn-outline btn-sm"
                      onClick={() => void openDetail(item)}
                      aria-label={`Revisar solicitud de ${item.employee_name ?? item.employee_id}`}
                      data-testid="recovery-open"
                    >
                      <Eye size={14} /> Revisar
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {detailId && (
        <AppDialog
          labelledBy="recovery-detail-title"
          describedBy="recovery-detail-description"
          onClose={closeDetail}
          dismissible={!resolving}
          className="recovery-dialog"
        >
          <header className="app-dialog-heading">
            <div>
              <h2 id="recovery-detail-title">Revisar solicitud de recuperación</h2>
              <p id="recovery-detail-description" className="muted">
                Inspección de sólo lectura de la preparación, evidencia, consumo y resolución. La decisión se audita
                con el motivo.
              </p>
            </div>
            <AppDialogCloseButton className="btn btn-ghost btn-sm" disabled={resolving} aria-label="Cerrar detalle">
              <X size={15} />
            </AppDialogCloseButton>
          </header>

          {detailLoading && (
            <p className="recovery-loading" role="status">
              <Spinner size={16} /> Inspeccionando el intento…
            </p>
          )}

          {detailError && (
            <p className="alert alert-error" role="alert" data-testid="recovery-detail-error">
              <Alert size={15} />
              <span>{detailError}</span>
            </p>
          )}

          {detail && (
            <div className="recovery-detail" data-testid="recovery-detail">
              <div className="recovery-detail-status">
                <span className={STATUS_BADGE[detail.request.status]}>
                  {STATUS_LABEL[detail.request.status]}
                </span>
                <span className="badge badge-neutral">{attemptStateLabel(detail.attempt.state)}</span>
              </div>

              {detail.attempt.inconsistent && (
                <p className="alert alert-error" role="alert" data-testid="recovery-inconsistent">
                  <Alert size={15} />
                  <span>
                    Intento inconsistente: la preparación, la evidencia, el consumo o el registro no coinciden. No se
                    puede autorizar una nueva identificación; requiere corrección manual.
                  </span>
                </p>
              )}
              {!detail.attempt.inconsistent && !detail.attempt.can_authorize && (
                <p className="alert alert-notice" role="status" data-testid="recovery-not-authorizable">
                  <Info size={15} />
                  <span>
                    El servidor no habilita autorizar este intento ({attemptStateLabel(detail.attempt.state)}).
                    {detail.attempt.token_expired ? " El token está vencido." : ""}
                  </span>
                </p>
              )}
              {detail.attempt.browser_unverifiable && (
                <p className="alert alert-notice" role="status" data-testid="recovery-browser-unverifiable">
                  <Info size={15} />
                  <span>
                    El navegador original no es verificable. Se conserva el dispositivo original registrado; no se
                    sustituye por el navegador solicitante.
                  </span>
                </p>
              )}

              <section className="recovery-block" aria-labelledby="recovery-request-summary">
                <h3 id="recovery-request-summary">Solicitud</h3>
                <dl className="recovery-facts">
                  <div>
                    <dt>Empleado</dt>
                    <dd>
                      {detail.employee
                        ? `${detail.employee.first_name} ${detail.employee.last_name}`
                        : detail.request.employee_name ?? detail.request.employee_id}
                      {detail.employee && (
                        <span className="recovery-fact-hint">
                          DNI {detail.employee.dni} · {detail.employee.employee_code}
                          {detail.employee.active ? "" : " · inactivo"}
                        </span>
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>Acción</dt>
                    <dd>{actionLabel(detail.request.action)}</dd>
                  </div>
                  <div>
                    <dt>Referencia</dt>
                    <dd>
                      <code className="recovery-nonce">{detail.request.nonce}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>Solicitada</dt>
                    <dd>{formatDateTime(detail.request.requested_at)}</dd>
                  </div>
                  <div>
                    <dt>Dispositivo original</dt>
                    <dd>
                      {detail.original_device
                        ? `${detail.original_device.name} · ${detail.original_device.id}`
                        : detail.request.original_device_id ?? "No registrado"}
                    </dd>
                  </div>
                  <div>
                    <dt>Navegador solicitante</dt>
                    <dd>
                      {detail.requester_device
                        ? `${detail.requester_device.name} · ${detail.requester_device.id}`
                        : detail.request.requester_device_id ?? "No registrado"}
                    </dd>
                  </div>
                  <div>
                    <dt>Resuelta</dt>
                    <dd>
                      {detail.request.resolved_at
                        ? `${formatDateTime(detail.request.resolved_at)}${detail.request.resolved_by_username ? ` · ${detail.request.resolved_by_username}` : ""}`
                        : "Aún no resuelta"}
                    </dd>
                  </div>
                  <div>
                    <dt>Motivo</dt>
                    <dd>{detail.request.reason ?? "—"}</dd>
                  </div>
                </dl>
              </section>

              <div className="recovery-inspection-grid">
                <section className="recovery-block" aria-labelledby="recovery-preparation">
                  <h3 id="recovery-preparation">Preparación</h3>
                  {detail.attempt.preparation ? (
                    <dl className="recovery-facts recovery-facts--compact">
                      <div>
                        <dt>Hora oficial</dt>
                        <dd data-testid="recovery-preparation-marked-at">
                          {formatDateTime(detail.attempt.preparation.marked_at)}
                        </dd>
                      </div>
                      <div>
                        <dt>Vence</dt>
                        <dd>{formatDateTime(detail.attempt.preparation.expires_at)}</dd>
                      </div>
                      <div>
                        <dt>Ubicación</dt>
                        <dd>
                          {detail.attempt.preparation.location.address ?? "Dirección no registrada"}
                          <span className="recovery-fact-hint">
                            {detail.attempt.preparation.location.latitude.toFixed(5)},{" "}
                            {detail.attempt.preparation.location.longitude.toFixed(5)} · ±
                            {detail.attempt.preparation.location.accuracy_m} m
                          </span>
                        </dd>
                      </div>
                    </dl>
                  ) : (
                    <p className="muted" data-testid="recovery-preparation-empty">
                      Sin preparación registrada.
                    </p>
                  )}
                </section>

                <section className="recovery-block" aria-labelledby="recovery-evidence">
                  <h3 id="recovery-evidence">Evidencia</h3>
                  {detail.attempt.evidence.ready ? (
                    <dl className="recovery-facts recovery-facts--compact">
                      <div>
                        <dt>Estado</dt>
                        <dd data-testid="recovery-evidence-ready">
                          <Check size={14} /> Foto guardada
                        </dd>
                      </div>
                      <div>
                        <dt>Capturada</dt>
                        <dd>{formatDateTime(detail.attempt.evidence.captured_at)}</dd>
                      </div>
                      <div>
                        <dt>Tipo</dt>
                        <dd>{detail.attempt.evidence.content_type ?? "—"}</dd>
                      </div>
                      <div>
                        <dt>Registro</dt>
                        <dd>{detail.attempt.evidence.record_id ?? "—"}</dd>
                      </div>
                    </dl>
                  ) : (
                    <p className="muted" data-testid="recovery-evidence-empty">
                      Sin foto guardada; el intento puede seguir en preparación.
                    </p>
                  )}
                </section>

                <section className="recovery-block" aria-labelledby="recovery-consumed">
                  <h3 id="recovery-consumed">Consumo del intento</h3>
                  <dl className="recovery-facts recovery-facts--compact">
                    <div>
                      <dt>Consumido</dt>
                      <dd data-testid="recovery-consumed-present">{detail.attempt.consumed.present ? "Sí" : "No"}</dd>
                    </div>
                    <div>
                      <dt>Confirmado</dt>
                      <dd>{detail.attempt.consumed.confirmed ? "Sí" : "No"}</dd>
                    </div>
                    <div>
                      <dt>Registro</dt>
                      <dd>{detail.attempt.consumed.record_id ?? "—"}</dd>
                    </div>
                    <div>
                      <dt>Dispositivo</dt>
                      <dd>{detail.attempt.consumed.device_id ?? "—"}</dd>
                    </div>
                  </dl>
                </section>

                <section className="recovery-block" aria-labelledby="recovery-resolution">
                  <h3 id="recovery-resolution">Resolución del servidor</h3>
                  {detail.attempt.resolution.present ? (
                    <dl className="recovery-facts recovery-facts--compact">
                      <div>
                        <dt>Resolución</dt>
                        <dd data-testid="recovery-resolution-value">
                          {detail.attempt.resolution.resolution ?? "—"}
                        </dd>
                      </div>
                      <div>
                        <dt>Motivo</dt>
                        <dd>{detail.attempt.resolution.reason ?? "—"}</dd>
                      </div>
                      <div>
                        <dt>Fecha</dt>
                        <dd>{formatDateTime(detail.attempt.resolution.resolved_at)}</dd>
                      </div>
                      <div>
                        <dt>Actor</dt>
                        <dd>{detail.attempt.resolution.resolved_by_user_id ?? "—"}</dd>
                      </div>
                    </dl>
                  ) : (
                    <p className="muted" data-testid="recovery-resolution-empty">
                      Sin resolución previa.
                    </p>
                  )}
                </section>
              </div>

              <section className="recovery-block" aria-labelledby="recovery-record">
                <h3 id="recovery-record">Registro confirmado</h3>
                {detail.attempt.record ? (
                  <dl className="recovery-facts recovery-facts--compact">
                    <div>
                      <dt>Fecha</dt>
                      <dd data-testid="recovery-record-date">{formatDate(detail.attempt.record.work_date)}</dd>
                    </div>
                    <div>
                      <dt>Entrada</dt>
                      <dd>{formatDateTime(detail.attempt.record.check_in_at)}</dd>
                    </div>
                    <div>
                      <dt>Salida</dt>
                      <dd>{formatDateTime(detail.attempt.record.check_out_at)}</dd>
                    </div>
                    <div>
                      <dt>Trabajado</dt>
                      <dd>
                        {detail.attempt.record.worked_minutes === null
                          ? "—"
                          : `${detail.attempt.record.worked_minutes} min`}
                      </dd>
                    </div>
                  </dl>
                ) : (
                  <p className="muted" data-testid="recovery-record-empty">
                    Sin registro asociado; no se inventa una asistencia.
                  </p>
                )}
              </section>

              {detail.request.status === "PENDING" ? (
                <form className="recovery-resolve" onSubmit={resolveRequest} aria-busy={resolving}>
                  <h3>Resolver solicitud</h3>
                  <div className="recovery-resolve-fields">
                    <div>
                      <label className="recovery-filter-label" htmlFor="recovery-decision">
                        Decisión
                      </label>
                      <Select value={decision} onValueChange={(value) => setDecision(value as RecoveryDecision)}>
                        <SelectTrigger id="recovery-decision" aria-label="Decisión">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="AUTHORIZE_REIDENTIFY" disabled={authorizeBlocked}>
                            {DECISION_LABEL.AUTHORIZE_REIDENTIFY}
                          </SelectItem>
                          <SelectItem value="REJECT">{DECISION_LABEL.REJECT}</SelectItem>
                          <SelectItem value="CONFIRM_EXISTING">{DECISION_LABEL.CONFIRM_EXISTING}</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="recovery-reason-field">
                      <label className="recovery-filter-label" htmlFor="recovery-reason">
                        Motivo (obligatorio)
                      </label>
                      <input
                        id="recovery-reason"
                        className="input"
                        value={reason}
                        onChange={(event) => setReason(event.target.value)}
                        minLength={3}
                        maxLength={500}
                        required
                        placeholder="Ej. el trabajador no pudo marcar por sesión vencida"
                        data-testid="recovery-reason"
                      />
                      <p className="recovery-fact-hint">
                        Visible en la auditoría. Entre 3 y 500 caracteres con texto visible.
                      </p>
                    </div>
                  </div>
                  {authorizeBlocked && decision === "AUTHORIZE_REIDENTIFY" && (
                    <p className="alert alert-notice" role="status">
                      <Info size={15} />
                      <span>Elija otra decisión: autorizar está bloqueado para este intento.</span>
                    </p>
                  )}
                  {resolveError && (
                    <p className="alert alert-error" role="alert" data-testid="recovery-resolve-error">
                      <Alert size={15} />
                      <span>{resolveError}</span>
                    </p>
                  )}
                  <div className="app-dialog-actions">
                    <AppDialogCloseButton className="btn btn-ghost" disabled={resolving}>
                      Cancelar
                    </AppDialogCloseButton>
                    <button type="submit" className="btn btn-primary" disabled={!canSubmit} data-testid="recovery-resolve">
                      {resolving && <Spinner size={15} />}
                      {resolving ? "Registrando decisión…" : "Registrar decisión"}
                    </button>
                  </div>
                </form>
              ) : (
                <p className="recovery-closed" data-testid="recovery-closed">
                  <Clock size={16} /> Esta solicitud ya fue resuelta. El registro original y su historial no se
                  modifican desde aquí.
                </p>
              )}
            </div>
          )}
        </AppDialog>
      )}
    </section>
  );
}
