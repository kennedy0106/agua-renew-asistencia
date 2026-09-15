"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import AdminShell from "@/components/AdminShell";
import { useAdminUser } from "@/components/AdminSession";
import DateField from "@/components/DateField";
import { Alert, Download, Pencil, X } from "@/components/Icons";
import { Spinner, TableSkeleton } from "@/components/Loading";
import { TablePagination, useTablePagination } from "@/components/Pagination";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
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

function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInput(local: string): string | null {
  if (!local) return null;
  return new Date(local).toISOString();
}

export default function AdminAttendancePage() {
  const user = useAdminUser();
  const [records, setRecords] = useState<AttendanceListItem[]>([]);
  const [daily, setDaily] = useState<AttendanceDailyItem[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [employeeFilter, setEmployeeFilter] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [statusFilter, setStatusFilter] = useState("");

  const [correcting, setCorrecting] = useState<AttendanceListItem | null>(null);
  const [corrCheckIn, setCorrCheckIn] = useState("");
  const [corrCheckOut, setCorrCheckOut] = useState("");
  const [corrNotes, setCorrNotes] = useState("");
  const [corrReason, setCorrReason] = useState("");
  const [savingCorrection, setSavingCorrection] = useState(false);
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

  async function loadPhotos(recordId: string) {
    setPhotosFor(recordId);
    setPhotoUrls({ check_in: null, check_out: null, missing: null });
    try {
      const meta = await attendanceAdminApi.evidenceMeta(recordId);
      const checkInUrl = meta.check_in?.id ? await attendanceAdminApi.evidenceImage(meta.check_in.id) : null;
      const checkOutUrl = meta.check_out?.id ? await attendanceAdminApi.evidenceImage(meta.check_out.id) : null;
      const missing =
        !meta.check_in?.available && !meta.check_out?.available
          ? "Este registro es anterior a la evidencia fotográfica o nunca tuvo foto."
          : null;
      setPhotoUrls({ check_in: checkInUrl, check_out: checkOutUrl, missing });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudieron cargar las fotos");
    }
  }

  function startCorrection(record: AttendanceListItem) {
    setCorrecting(record);
    setCorrCheckIn(toLocalInput(record.check_in_at));
    setCorrCheckOut(toLocalInput(record.check_out_at));
    setCorrNotes(record.notes ?? "");
    setCorrReason("");
    setError(null);
    void loadPhotos(record.id);
  }

  async function handleSaveCorrection(event: React.FormEvent) {
    event.preventDefault();
    if (!correcting) return;
    setSavingCorrection(true);
    setError(null);
    try {
      await attendanceAdminApi.correct(correcting.id, {
        check_in_at: fromLocalInput(corrCheckIn),
        check_out_at: fromLocalInput(corrCheckOut),
        notes: corrNotes.trim() || null,
        reason: corrReason.trim(),
      });
      setCorrecting(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo corregir el registro");
    } finally {
      setSavingCorrection(false);
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
                {reviewingAttempt ? "Guardando…" : "Revisar y liberar kiosco"}
              </button>
            </div>
          </form>
        </details>
      )}

      {photosFor && !correcting && (
        <div className="card card-pad" style={{ marginBottom: "1rem" }}>
          <h2 className="card-title">Evidencia fotográfica</h2>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.8rem", marginTop: "0.6rem" }}>
            <figure>
              <figcaption className="label">Foto de entrada</figcaption>
              {photoUrls.check_in ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={photoUrls.check_in} alt="Entrada" style={{ width: "100%", borderRadius: 8 }} />
              ) : (
                <p className="muted">Sin foto de entrada.</p>
              )}
            </figure>
            <figure>
              <figcaption className="label">Foto de salida</figcaption>
              {photoUrls.check_out ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={photoUrls.check_out} alt="Salida" style={{ width: "100%", borderRadius: 8 }} />
              ) : (
                <p className="muted">Sin foto de salida.</p>
              )}
            </figure>
          </div>
          {photoUrls.missing && <p className="muted" style={{ marginTop: "0.6rem" }}>{photoUrls.missing}</p>}
        </div>
      )}

      {correcting && canManage && (
        <form onSubmit={handleSaveCorrection} className="card card-pad" style={{ marginBottom: "1rem", borderColor: "#f0d9a8", background: "#fffdf7" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "0.7rem" }}>
            <h2 className="card-title">Corregir registro · {correcting.employee_name}</h2>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setCorrecting(null)} aria-label="Cerrar">
              <X size={14} />
            </button>
          </div>
          <div style={{ display: "grid", gap: "0.7rem", gridTemplateColumns: "repeat(auto-fit,minmax(170px,1fr))" }}>
            <div>
              <label className="label">Entrada</label>
              <input type="datetime-local" className="input" value={corrCheckIn} onChange={(e) => setCorrCheckIn(e.target.value)} />
            </div>
            <div>
              <label className="label">Salida (vacío = quitar salida)</label>
              <input type="datetime-local" className="input" value={corrCheckOut} onChange={(e) => setCorrCheckOut(e.target.value)} />
            </div>
            <div>
              <label className="label">Notas</label>
              <input type="text" className="input" value={corrNotes} onChange={(e) => setCorrNotes(e.target.value)} />
            </div>
            <div>
              <label className="label">Motivo (obligatorio)</label>
              <input
                type="text"
                className="input"
                value={corrReason}
                onChange={(e) => setCorrReason(e.target.value)}
                required
                minLength={3}
                placeholder="Ej. olvidó marcar salida"
              />
            </div>
          </div>
          <p className="muted" style={{ fontSize: "0.76rem", marginTop: "0.6rem" }}>
            El backend recalcula automáticamente minutos y estado; la corrección queda en auditoría.
          </p>
          {photosFor === correcting.id && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.8rem", marginTop: "0.8rem" }}>
              <figure>
                <figcaption className="label">Foto de entrada</figcaption>
                {photoUrls.check_in ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={photoUrls.check_in} alt="Entrada" style={{ width: "100%", borderRadius: 8 }} />
                ) : (
                  <p className="muted">Sin foto de entrada.</p>
                )}
              </figure>
              <figure>
                <figcaption className="label">Foto de salida</figcaption>
                {photoUrls.check_out ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={photoUrls.check_out} alt="Salida" style={{ width: "100%", borderRadius: 8 }} />
                ) : (
                  <p className="muted">Sin foto de salida.</p>
                )}
              </figure>
              {photoUrls.missing && <p className="muted" style={{ gridColumn: "1 / -1" }}>{photoUrls.missing}</p>}
            </div>
          )}
          <button
            type="submit"
            className="btn btn-amber"
            style={{ marginTop: "0.7rem" }}
            disabled={savingCorrection || corrReason.trim().length < 3}
          >
            <Pencil size={15} />
            {savingCorrection ? "Guardando…" : "Guardar corrección"}
          </button>
        </form>
      )}

      <h2 className="card-title" style={{ margin: "0.9rem 0 0.55rem" }}>Resumen diario consolidado</h2>
      <div className="table-wrap" style={{ marginBottom: "1rem" }}>
        <table className="table">
          <thead>
            <tr>
              <th>Empleado</th><th>Fecha</th><th>Sesiones</th><th>Presencia</th>
              <th>Refrigerio</th><th>Neto</th><th>Esperado</th><th>Diferencia</th><th>Incidencias</th>
            </tr>
          </thead>
          <tbody>
            {loading && <TableSkeleton rows={3} cols={9} />}
            {!loading && daily.length === 0 && <tr><td colSpan={9} className="empty">Sin jornadas en el rango.</td></tr>}
            {dailyPagination.pageItems.map((day) => (
              <tr key={`${day.employee_id}-${day.work_date}`}>
                <td style={{ fontWeight: 600 }}>{day.employee_name ?? "—"}</td>
                <td className="num">{day.work_date}</td>
                <td className="num">{day.session_count}</td>
                <td className="num">{formatMinutes(day.gross_minutes)}</td>
                <td className="num">{formatMinutes(day.break_minutes)}</td>
                <td className="num">{formatMinutes(day.worked_minutes)}</td>
                <td className="num">{formatMinutes(day.expected_minutes)}</td>
                <td className="num">{formatDifference(day.difference_minutes)}</td>
                <td>{day.incident_codes.length ? <span className="badge badge-amber">{day.incident_codes.map(formatIncidentCode).join(", ")}</span> : <span className="badge badge-green">Sin incidencias</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <TablePagination {...dailyPagination} />

      <h2 className="card-title" style={{ margin: "0.9rem 0 0.55rem" }}>Detalle de marcaciones</h2>
      <div className="table-wrap">
        <table className="table">
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
              {canManage && <th style={{ textAlign: "right" }}>Acciones</th>}
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
                <td>
                  <Link href={`/admin/employees/${record.employee_id}`} style={{ fontWeight: 600 }}>
                    {record.employee_name ?? "—"}
                  </Link>
                  <span className="muted" style={{ marginLeft: "0.4rem", fontSize: "0.75rem" }}>
                    {record.job_role_name ?? ""}
                  </span>
                </td>
                <td className="num">{record.work_date}</td>
                <td className="num">{formatClock(record.check_in_at)}</td>
                <td className="num">{formatClock(record.check_out_at)}</td>
                <td className="num">{formatMinutes(record.worked_minutes)}</td>
                <td className="num">{formatMinutes(record.expected_minutes)}</td>
                <td
                  className="num"
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
                  <td style={{ textAlign: "right", display: "flex", gap: "0.3rem", justifyContent: "flex-end" }}>
                    <button className="btn btn-ghost btn-sm" onClick={() => void loadPhotos(record.id)}>
                      Fotos
                    </button>
                    <button className="btn btn-ghost btn-sm" onClick={() => startCorrection(record)}>
                      <Pencil size={13} />
                      Corregir
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <TablePagination {...recordsPagination} />
    </AdminShell>
  );
}
