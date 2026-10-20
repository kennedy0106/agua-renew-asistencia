// Presentación de las dos tablas operativas de Asistencia: resumen diario del
// equipo y detalle de marcaciones. Solo formateo y composición visual sobre los
// datos ya cargados por la página; no consulta la API, no recalcula minutos y no
// conoce los diálogos de corrección, evidencia o refrigerio (la página los
// conserva y entrega los callbacks).

import { Fragment, useState } from "react";
import { Link } from "react-router-dom";
import { Camera, ChevronRight, Clock, Pencil } from "@/components/Icons";
import { TableSkeleton } from "@/components/Loading";
import { formatOperationalDate } from "@/lib/dates";
import type { AttendanceDailyItem, AttendanceListItem } from "@/lib/api";

const LIMA_TIME_ZONE = "America/Lima";

/**
 * Etiquetas completas de incidencia (significado para la persona). Se muestran
 * en el `title` y en el texto solo-lectores de pantalla; el badge de la celda
 * usa una versión corta para que la fila siga siendo compacta.
 */
const INCIDENT_LABELS: Record<string, string> = {
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

const INCIDENT_SHORT_LABELS: Record<string, string> = {
  ...INCIDENT_LABELS,
  LONG_ATTENDANCE: "Jornada larga",
  INCOMPLETE: "Jornada incompleta",
  OPEN_ATTENDANCE: "Entrada sin salida",
};

function humanizeIncidentCode(code: string): string {
  const fallback = code.replace(/[_-]+/g, " ").trim().toLocaleLowerCase("es-PE");
  return fallback ? `${fallback.charAt(0).toLocaleUpperCase("es-PE")}${fallback.slice(1)}` : "Incidencia sin detalle";
}

function incidentLabel(code: string): string {
  return INCIDENT_LABELS[code] ?? humanizeIncidentCode(code);
}

function incidentShortLabel(code: string): string {
  return INCIDENT_SHORT_LABELS[code] ?? humanizeIncidentCode(code);
}

const pad2 = (value: number) => value.toString().padStart(2, "0");

/**
 * Duración de tabla en h:mm (hora de dos dígitos, sin envolver las 24 h).
 * Es un formateador exclusivo de esta presentación: el resto de la página
 * conserva `formatMinutes` con su formato clásico ("8 h 20").
 */
function formatTableDuration(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return "—";
  const total = Math.abs(Math.trunc(minutes));
  return `${pad2(Math.floor(total / 60))}:${pad2(total % 60)}`;
}

/** Saldo con su signo en h:mm: "+66:24", "-04:59", "00:00" o "—" si está pendiente. */
function formatTableBalance(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return "—";
  const total = Math.trunc(minutes);
  const sign = total > 0 ? "+" : total < 0 ? "-" : "";
  return `${sign}${formatTableDuration(Math.abs(total))}`;
}

function balanceTone(minutes: number | null | undefined): "positive" | "negative" | "zero" {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes) || minutes === 0) return "zero";
  return minutes > 0 ? "positive" : "negative";
}

/** Hora de Lima con el mismo formato es-PE que el resto de la operación. */
function formatTableClock(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("es-PE", {
    timeZone: LIMA_TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Fecha calendaria de Lima (YYYY-MM-DD) para un instante de la marcación. */
function limaCalendarDate(iso: string | null): string | null {
  if (!iso) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: LIMA_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(iso));
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  const year = value("year");
  const month = value("month");
  const day = value("day");
  return year && month && day ? `${year}-${month}-${day}` : null;
}

/**
 * Fecha visible de salida, solo cuando el día de Lima de la salida no es el
 * mismo que el de la entrada. Nunca inventa la fecha: sin salida, no hay fecha.
 */
function crossedExitDate(record: AttendanceListItem): string | null {
  const checkInDate = limaCalendarDate(record.check_in_at);
  const checkOutDate = limaCalendarDate(record.check_out_at);
  if (!checkOutDate || !checkInDate || checkOutDate === checkInDate) return null;
  return checkOutDate;
}

function breakSourceLabel(day: AttendanceDailyItem): string {
  if (day.break_source === "OVERRIDE") return "Ajuste manual";
  if (day.break_source === "SCHEDULE") return "Automático según jornada";
  return "Sin refrigerio aplicado";
}

function Incidents({ codes }: { codes: string[] }) {
  if (codes.length === 0) {
    return <span className="badge badge-neutral attendance-no-incident">Sin incidencias</span>;
  }
  return (
    <span className="attendance-incidents">
      {codes.map((code) => (
        <span key={code} className="badge badge-amber attendance-incident" title={incidentLabel(code)}>
          {incidentShortLabel(code)}
        </span>
      ))}
      <span className="sr-only">{codes.map(incidentLabel).join(". ")}</span>
    </span>
  );
}

function Balance({ minutes }: { minutes: number | null | undefined }) {
  return (
    <span className={`attendance-num attendance-balance attendance-balance--${balanceTone(minutes)}`}>
      {formatTableBalance(minutes)}
    </span>
  );
}

function DailyDetail({ day }: { day: AttendanceDailyItem }) {
  return (
    <dl className="attendance-detail">
      <div className="attendance-detail__person">
        <dt>Empleado</dt>
        <dd>{day.employee_name ?? "—"}</dd>
      </div>
      <div>
        <dt>Sesiones</dt>
        <dd className="attendance-num">{day.session_count}</dd>
      </div>
      <div>
        <dt>Presencia</dt>
        <dd className="attendance-num">{formatTableDuration(day.gross_minutes)}</dd>
      </div>
      <div>
        <dt>Refrigerio aplicado</dt>
        <dd className="attendance-num">{formatTableDuration(day.break_minutes)}</dd>
      </div>
      {day.break_source === "OVERRIDE" && day.override_requested_minutes !== null && (
        <div>
          <dt>Refrigerio solicitado</dt>
          <dd className="attendance-num">{formatTableDuration(day.override_requested_minutes)}</dd>
        </div>
      )}
      <div>
        <dt>Origen del refrigerio</dt>
        <dd>
          {breakSourceLabel(day)}
          {day.override_limited && (
            <span className="badge badge-amber attendance-detail__flag">Refrigerio limitado</span>
          )}
        </dd>
      </div>
    </dl>
  );
}

function RecordDetail({ record }: { record: AttendanceListItem }) {
  return (
    <dl className="attendance-detail">
      <div className="attendance-detail__person">
        <dt>Empleado</dt>
        <dd>{record.employee_name ?? "—"}</dd>
      </div>
      <div>
        <dt>Jornada esperada</dt>
        <dd className="attendance-num">{formatTableDuration(record.expected_minutes)}</dd>
      </div>
      <div>
        <dt>Saldo del día</dt>
        <dd>
          <Balance minutes={record.difference_minutes} />
        </dd>
      </div>
      <div>
        <dt>Cargo</dt>
        <dd>{record.job_role_name ?? "—"}</dd>
      </div>
    </dl>
  );
}

function RowToggle({
  open,
  controls,
  onClick,
}: {
  open: boolean;
  controls: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="attendance-row-toggle"
      aria-expanded={open}
      aria-controls={controls}
      onClick={onClick}
    >
      <ChevronRight size={14} />
      <span>{open ? "Ocultar desglose" : "Desglose"}</span>
    </button>
  );
}

type DailyProps = {
  days: AttendanceDailyItem[];
  loading: boolean;
  canManage: boolean;
  onEditBreak: (day: AttendanceDailyItem, trigger: HTMLButtonElement) => void;
};

/** Tabla del resumen diario (escritorio ancho). */
export function AttendanceDailyTable({ days, loading, canManage, onEditBreak }: DailyProps) {
  const [openKeys, setOpenKeys] = useState<Record<string, boolean>>({});
  const columns = canManage ? 7 : 6;

  return (
    <div className="table-wrap attendance-responsive-wrap attendance-tables attendance-daily-wrap">
      <table className="table attendance-daily-table" aria-label="Resumen diario del equipo">
        <colgroup>
          <col className="attendance-col-name" />
          <col className="attendance-col-date" />
          <col className="attendance-col-number" />
          <col className="attendance-col-number" />
          <col className="attendance-col-balance" />
          <col className="attendance-col-incidents" />
          {canManage && <col className="attendance-col-action" />}
        </colgroup>
        <thead>
          <tr>
            <th scope="col">Empleado</th>
            <th scope="col">Fecha</th>
            <th scope="col" className="attendance-num">Efectivo</th>
            <th scope="col" className="attendance-num">Esperado</th>
            <th scope="col" className="attendance-num">Saldo</th>
            <th scope="col">Incidencias</th>
            {canManage && <th scope="col" className="attendance-col-action">Acciones</th>}
          </tr>
        </thead>
        <tbody>
          {loading && <TableSkeleton rows={3} cols={columns} />}
          {days.map((day) => {
            const key = `${day.employee_id}-${day.work_date}`;
            const detailId = `attendance-daily-detail-${key}`;
            const open = Boolean(openKeys[key]);
            return (
              <Fragment key={key}>
                <tr>
                  <td className="table-cell-name attendance-cell-name">
                    <div className="attendance-identity">
                      <span className="attendance-name" title={day.employee_name ?? "—"}>
                        {day.employee_name ?? "—"}
                      </span>
                      <RowToggle
                        open={open}
                        controls={detailId}
                        onClick={() => setOpenKeys((current) => ({ ...current, [key]: !open }))}
                      />
                    </div>
                  </td>
                  <td className="attendance-num attendance-date">{formatOperationalDate(day.work_date)}</td>
                  <td className="attendance-num">{formatTableDuration(day.worked_minutes)}</td>
                  <td className="attendance-num">{formatTableDuration(day.expected_minutes)}</td>
                  <td>
                    <Balance minutes={day.difference_minutes} />
                  </td>
                  <td className="attendance-incidents-cell">
                    <Incidents codes={day.incident_codes} />
                  </td>
                  {canManage && (
                    <td className="attendance-col-action">
                      <div className="attendance-actions">
                        <button
                          type="button"
                          className="btn attendance-action attendance-action--secondary"
                          disabled={day.has_open_entry}
                          title={
                            day.has_open_entry
                              ? "Cierre todas las marcaciones antes de ajustar el refrigerio"
                              : undefined
                          }
                          aria-label={`Editar refrigerio de ${day.employee_name ?? "este empleado"}`}
                          onClick={(event) => onEditBreak(day, event.currentTarget)}
                        >
                          <Clock size={16} />
                          Refrigerio
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
                {open && (
                  <tr className="attendance-detail-row" id={detailId}>
                    <td colSpan={columns}>
                      <DailyDetail day={day} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Tarjetas del resumen diario (laptop y móvil). */
export function AttendanceDailyCards({ days, loading, canManage, onEditBreak }: DailyProps) {
  const [openKeys, setOpenKeys] = useState<Record<string, boolean>>({});

  return (
    <div className="responsive-table-cards attendance-cards attendance-tables" role="region" aria-label="Resumen diario del equipo">
      {loading && <ResponsiveCardsSkeleton label="Cargando resumen diario" />}
      {days.map((day) => {
        const key = `${day.employee_id}-${day.work_date}`;
        const detailId = `attendance-daily-card-detail-${key}`;
        const open = Boolean(openKeys[key]);
        return (
          <article className="responsive-table-card attendance-card" key={`card-${key}`}>
            <div className="attendance-card__head">
              <span className="attendance-card__name" title={day.employee_name ?? "—"}>
                {day.employee_name ?? "—"}
              </span>
              <time className="attendance-card__date" dateTime={day.work_date}>
                {formatOperationalDate(day.work_date)}
              </time>
            </div>
            <dl className="attendance-card__primary">
              <div>
                <dt>Efectivo</dt>
                <dd className="attendance-num">{formatTableDuration(day.worked_minutes)}</dd>
              </div>
              <div>
                <dt>Esperado</dt>
                <dd className="attendance-num">{formatTableDuration(day.expected_minutes)}</dd>
              </div>
              <div>
                <dt>Saldo</dt>
                <dd>
                  <Balance minutes={day.difference_minutes} />
                </dd>
              </div>
            </dl>
            <div className="attendance-card__status">
              <Incidents codes={day.incident_codes} />
            </div>
            <div className="attendance-card__footer">
              <RowToggle
                open={open}
                controls={detailId}
                onClick={() => setOpenKeys((current) => ({ ...current, [key]: !open }))}
              />
              {canManage && (
                <div className="attendance-card__actions attendance-actions">
                  <button
                    type="button"
                    className="btn attendance-action attendance-action--secondary"
                    disabled={day.has_open_entry}
                    title={
                      day.has_open_entry
                        ? "Cierre todas las marcaciones antes de ajustar el refrigerio"
                        : undefined
                    }
                    aria-label={`Editar refrigerio de ${day.employee_name ?? "este empleado"}`}
                    onClick={(event) => onEditBreak(day, event.currentTarget)}
                  >
                    <Clock size={16} />
                    Refrigerio
                  </button>
                </div>
              )}
            </div>
            {open && (
              <div id={detailId} className="attendance-card__detail">
                <DailyDetail day={day} />
              </div>
            )}
          </article>
        );
      })}
    </div>
  );
}

type RecordProps = {
  records: AttendanceListItem[];
  loading: boolean;
  canManage: boolean;
  onPhotos: (recordId: string) => void;
  onCorrect: (record: AttendanceListItem) => void;
};

/** Tabla del detalle de marcaciones (escritorio ancho). */
export function AttendanceRecordsTable({ records, loading, canManage, onPhotos, onCorrect }: RecordProps) {
  const [openIds, setOpenIds] = useState<Record<string, boolean>>({});
  const columns = canManage ? 7 : 6;

  return (
    <div className="table-wrap attendance-responsive-wrap attendance-tables">
      <table className="table attendance-records-table" aria-label="Detalle de marcaciones">
        <colgroup>
          <col className="attendance-col-name" />
          <col className="attendance-col-date" />
          <col className="attendance-col-time" />
          <col className="attendance-col-time" />
          <col className="attendance-col-number" />
          <col className="attendance-col-status" />
          {canManage && <col className="attendance-col-action" />}
        </colgroup>
        <thead>
          <tr>
            <th scope="col">Empleado</th>
            <th scope="col">Fecha</th>
            <th scope="col" className="attendance-num">Entrada</th>
            <th scope="col" className="attendance-num">Salida</th>
            <th scope="col" className="attendance-num">Trabajado</th>
            <th scope="col">Estado</th>
            {canManage && <th scope="col" className="attendance-col-action">Acciones</th>}
          </tr>
        </thead>
        <tbody>
          {loading && <TableSkeleton rows={5} cols={columns} />}
          {records.map((record) => {
            const detailId = `attendance-record-detail-${record.id}`;
            const open = Boolean(openIds[record.id]);
            const exitDate = crossedExitDate(record);
            return (
              <Fragment key={record.id}>
                <tr>
                  <td className="table-cell-name attendance-cell-name">
                    <div className="attendance-identity">
                      <div className="attendance-identity__text">
                        <Link
                          className="attendance-name attendance-name--link"
                          to={`/admin/employees/${record.employee_id}`}
                          title={`${record.employee_name ?? "—"}${record.job_role_name ? ` · ${record.job_role_name}` : ""}`}
                        >
                          {record.employee_name ?? "—"}
                        </Link>
                        {record.job_role_name && <span className="attendance-role">{record.job_role_name}</span>}
                      </div>
                      <RowToggle
                        open={open}
                        controls={detailId}
                        onClick={() => setOpenIds((current) => ({ ...current, [record.id]: !open }))}
                      />
                    </div>
                  </td>
                  <td className="attendance-num attendance-date">{formatOperationalDate(record.work_date)}</td>
                  <td className="attendance-num attendance-time">{formatTableClock(record.check_in_at)}</td>
                  <td className="attendance-num attendance-time">
                    {formatTableClock(record.check_out_at)}
                    {exitDate && (
                      <span className="attendance-exit-date" title="La salida ocurrió en otra fecha">
                        {formatOperationalDate(exitDate)}
                      </span>
                    )}
                  </td>
                  <td className="attendance-num">{formatTableDuration(record.worked_minutes)}</td>
                  <td>
                    {record.status === "OPEN" ? (
                      <span className="badge badge-amber attendance-status">Sin salida</span>
                    ) : (
                      <span className="badge badge-neutral attendance-status">Cerrada</span>
                    )}
                  </td>
                  {canManage && (
                    <td className="attendance-col-action">
                      <div className="attendance-actions">
                        <button
                          type="button"
                          className="btn attendance-action attendance-action--soft"
                          onClick={() => onPhotos(record.id)}
                          aria-label={`Ver fotos de ${record.employee_name ?? "este empleado"}`}
                          title="Ver fotos"
                        >
                          <Camera size={17} />
                          Fotos
                        </button>
                        <button
                          type="button"
                          className="btn attendance-action attendance-action--neutral"
                          onClick={() => onCorrect(record)}
                          aria-label={`Corregir registro de ${record.employee_name ?? "este empleado"}`}
                          title="Corregir registro"
                        >
                          <Pencil size={16} />
                          Corregir
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
                {open && (
                  <tr className="attendance-detail-row" id={detailId}>
                    <td colSpan={columns}>
                      <RecordDetail record={record} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Tarjetas del detalle de marcaciones (laptop y móvil). */
export function AttendanceRecordsCards({ records, loading, canManage, onPhotos, onCorrect }: RecordProps) {
  const [openIds, setOpenIds] = useState<Record<string, boolean>>({});

  return (
    <div className="responsive-table-cards attendance-cards attendance-tables" role="region" aria-label="Detalle de marcaciones">
      {loading && <ResponsiveCardsSkeleton label="Cargando detalle de marcaciones" />}
      {records.map((record) => {
        const detailId = `attendance-record-card-detail-${record.id}`;
        const open = Boolean(openIds[record.id]);
        const exitDate = crossedExitDate(record);
        return (
          <article className="responsive-table-card attendance-card" key={`card-${record.id}`}>
            <div className="attendance-card__head">
              <span className="attendance-card__name">
                <Link className="attendance-name attendance-name--link" to={`/admin/employees/${record.employee_id}`}>
                  {record.employee_name ?? "—"}
                </Link>
                {record.job_role_name && (
                  <span className="attendance-card__role">{record.job_role_name}</span>
                )}
              </span>
              <time className="attendance-card__date" dateTime={record.work_date}>
                {formatOperationalDate(record.work_date)}
              </time>
            </div>
            <dl className="attendance-card__primary attendance-card__primary--times">
              <div>
                <dt>Entrada</dt>
                <dd className="attendance-num">{formatTableClock(record.check_in_at)}</dd>
              </div>
              <div>
                <dt>Salida</dt>
                <dd className="attendance-num">
                  {formatTableClock(record.check_out_at)}
                  {exitDate && (
                    <span className="attendance-exit-date" title="La salida ocurrió en otra fecha">
                      {formatOperationalDate(exitDate)}
                    </span>
                  )}
                </dd>
              </div>
              <div>
                <dt>Trabajado</dt>
                <dd className="attendance-num">{formatTableDuration(record.worked_minutes)}</dd>
              </div>
            </dl>
            <div className="attendance-card__status">
              {record.status === "OPEN" ? (
                <span className="badge badge-amber attendance-status">Sin salida</span>
              ) : (
                <span className="badge badge-neutral attendance-status">Cerrada</span>
              )}
            </div>
            <div className="attendance-card__footer">
              <RowToggle
                open={open}
                controls={detailId}
                onClick={() => setOpenIds((current) => ({ ...current, [record.id]: !open }))}
              />
              {canManage && (
                <div className="attendance-card__actions attendance-actions">
                  <button
                    type="button"
                    className="btn attendance-action attendance-action--soft"
                    onClick={() => onPhotos(record.id)}
                    aria-label={`Ver fotos de ${record.employee_name ?? "este empleado"}`}
                    title="Ver fotos"
                  >
                    <Camera size={17} />
                    Fotos
                  </button>
                  <button
                    type="button"
                    className="btn attendance-action attendance-action--neutral"
                    onClick={() => onCorrect(record)}
                    aria-label={`Corregir registro de ${record.employee_name ?? "este empleado"}`}
                    title="Corregir registro"
                  >
                    <Pencil size={16} />
                    Corregir
                  </button>
                </div>
              )}
            </div>
            {open && (
              <div id={detailId} className="attendance-card__detail">
                <RecordDetail record={record} />
              </div>
            )}
          </article>
        );
      })}
    </div>
  );
}

function ResponsiveCardsSkeleton({ label }: { label: string }) {
  return (
    <div className="responsive-table-card attendance-card" aria-busy="true" aria-label={label}>
      <div className="skeleton" style={{ width: "62%", height: 17 }} />
      <div className="attendance-card__primary">
        <div className="skeleton" style={{ height: 34 }} />
        <div className="skeleton" style={{ height: 34 }} />
        <div className="skeleton" style={{ height: 34 }} />
      </div>
    </div>
  );
}
