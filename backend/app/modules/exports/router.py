"""Exportaciones CSV.

- BOM UTF-8 (\\ufeff) para que Excel abra los acentos correctamente.
- Asistencia: cualquier usuario autenticado (datos de asistencia).
- Sueldos: ADMIN/BOSS únicamente (privacidad salarial).
- El frontend descarga con navegación simple (cookie SameSite=Lax viaja en
  navegaciones de nivel superior); el backend nunca expone más de lo que
  expone la API.
"""

import csv
import io
import uuid
from datetime import date, datetime, timezone
from decimal import Decimal

from fastapi import APIRouter, Depends
from fastapi.responses import Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.permissions import get_current_operational_user, require_admin_or_boss
from app.core.timezone import lima_tz
from app.db.session import get_db
from app.modules.attendance.repository import AttendanceRepository
from app.modules.attendance.manual_models import ManualAttendanceDay
from app.modules.payroll.repository import PayrollRepository
from app.modules.payroll.service import PayrollService
from app.modules.schedules.service import ScheduleService

router = APIRouter(prefix="/api/v1/exports", tags=["exports"])


def _csv_response(rows: list[list], filename: str) -> Response:
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    # Todo texto controlado por usuario se neutraliza ante fórmulas de Excel.
    writer.writerows([[f"'{value}" if isinstance(value, str) and value[:1] in ("=", "+", "-", "@") else value for value in row] for row in rows])
    content = "\ufeff" + buffer.getvalue()
    return Response(
        content=content.encode("utf-8"),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


def _fmt_time(value: datetime | None) -> str:
    """HH:MM en America/Lima (tolera timestamps naive = UTC, caso SQLite)."""
    if value is None:
        return ""
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(lima_tz()).strftime("%H:%M")


def _fmt_date(value: date | None) -> str:
    return value.isoformat() if value else ""


@router.get("/attendance.csv")
def export_attendance(
    employee_id: uuid.UUID | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    status: str | None = None,
    db: Session = Depends(get_db),
    _: object = Depends(get_current_operational_user),
) -> Response:
    records = AttendanceRepository(db).list_records(
        employee_id=employee_id, date_from=date_from, date_to=date_to, status=status
    )
    rows = [
        [
            "Fecha",
            "Empleado",
            "DNI",
            "Cargo",
            "Entrada",
            "Salida",
            "Trabajado (min)",
            "Esperado (min)",
            "Diferencia (min)",
            "Estado",
            "Notas",
            "Origen",
            "Normal (min)",
            "Adicional (min)",
            "Recuperación (min)",
            "Referencia",
            "Concepto adicional",
            "Estado pago adicional",
        ]
    ]
    schedules = ScheduleService(db)
    for record in records:
        expected = schedules.expected_minutes(record.employee_id, record.work_date)
        employee = record.employee
        rows.append(
            [
                _fmt_date(record.work_date),
                f"{employee.first_name} {employee.last_name}" if employee else "",
                employee.dni if employee else "",
                employee.job_role.name if employee and employee.job_role else "",
                _fmt_time(record.check_in_at),
                _fmt_time(record.check_out_at),
                record.worked_minutes if record.worked_minutes is not None else "",
                expected,
                (record.worked_minutes - expected) if record.worked_minutes is not None else "",
                record.status,
                record.notes or "", "KIOSCO", "", "", "", "", "", "",
            ]
        )
    manual_query = select(ManualAttendanceDay).where(ManualAttendanceDay.voided_at.is_(None))
    if employee_id:
        manual_query = manual_query.where(ManualAttendanceDay.employee_id == employee_id)
    if date_from:
        manual_query = manual_query.where(ManualAttendanceDay.work_date >= date_from)
    if date_to:
        manual_query = manual_query.where(ManualAttendanceDay.work_date <= date_to)
    manual = list(db.scalars(manual_query))
    for item in manual:
        employee = item.employee
        rows.append([_fmt_date(item.work_date), f"{employee.first_name} {employee.last_name}" if employee else "", employee.dni if employee else "", employee.job_role.name if employee and employee.job_role else "", _fmt_time(item.known_check_in_at), _fmt_time(item.known_check_out_at), item.worked_minutes_net, schedules.expected_minutes(item.employee_id, item.work_date), item.normal_minutes - schedules.expected_minutes(item.employee_id, item.work_date), "CARGA_HISTORICA", item.reason, "CARGA_HISTORICA", item.normal_minutes, item.additional_minutes, item.recovery_minutes, item.source_reference or "", item.payment_concept or "", item.payment_status])
    return _csv_response(rows, f"asistencia_{date_from or 'todo'}_{date_to or 'hoy'}.csv")


@router.get("/salaries.csv")
def export_salaries(
    period_id: uuid.UUID,
    include_excluded: bool = False,
    db: Session = Depends(get_db),
    _: object = Depends(require_admin_or_boss),
) -> Response:
    period = PayrollRepository(db).get_period(period_id)
    if period is None:
        from fastapi import HTTPException, status

        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Periodo no encontrado")
    records = PayrollRepository(db).list_records(period_id, payable_only=not include_excluded)
    rows = [
        [
            "Periodo",
            "Empleado",
            "DNI",
            "Cargo",
            "Sueldo base (S/)",
            "Trabajado (min)",
            "Esperado (min)",
            "HE (min)",
            "HE (S/)",
            "Ajuste horas (min)",
            "Ajuste manual (S/)",
            "Notas",
            "Total (S/)",
            "Estado",
            "Versión del cálculo",
            "Descanso/Feriado (S/)",
        ]
    ]
    payable_total = Decimal("0.00")
    for record in records:
        employee = record.employee
        estado = "PAGABLE" if record.payable else "EXCLUIDO"
        if record.payable:
            payable_total += record.total
        rows.append(
            [
                period.name,
                f"{employee.first_name} {employee.last_name}" if employee else "",
                employee.dni if employee else "",
                employee.job_role.name if employee and employee.job_role else "",
                f"{record.base_salary:.2f}",
                record.worked_minutes,
                record.expected_minutes,
                record.overtime_minutes,
                f"{record.overtime_amount:.2f}",
                record.adjustment_minutes,
                f"{record.manual_adjustment:.2f}",
                record.notes or "",
                f"{record.total:.2f}",
                estado,
                period.version,
                f"{record.special_day_amount:.2f}",
            ]
        )
    rows.append(
        [
            period.name,
            "TOTAL PAGABLE",
            "", "", "", "", "", "", "", "", "", "",
            f"{payable_total:.2f}",
            "TOTAL",
            period.version,
            "",
        ]
    )
    safe_name = "".join(c for c in period.name if c.isalnum() or c in "-_ ").strip().replace(" ", "_")
    filename = f"sueldos_{safe_name}_historial.csv" if include_excluded else f"sueldos_{safe_name}.csv"
    return _csv_response(rows, filename)


@router.get("/salaries-month.csv")
def export_monthly_consolidation(
    year: int,
    month: int,
    db: Session = Depends(get_db),
    _: object = Depends(require_admin_or_boss),
) -> Response:
    """CSV of the same current-root view returned by payroll consolidation."""
    consolidation = PayrollService(db).monthly_consolidation(year, month)
    rows = [["Año", "Mes", "Empleado", "Básico (S/)", "HE (S/)", "Descanso/Feriado (S/)", "Ajuste manual (S/)", "Total (S/)", "Periodos vigentes"]]
    for item in consolidation["employees"]:
        rows.append([
            year, month, item["employee_name"] or str(item["employee_id"]),
            f"{item['base_amount']:.2f}", f"{item['overtime_amount']:.2f}",
            f"{item['special_day_amount']:.2f}", f"{item['manual_adjustment']:.2f}",
            f"{item['total']:.2f}", ",".join(str(period_id) for period_id in item["period_ids"]),
        ])
    rows.append([year, month, "TOTAL", "", "", "", "", f"{consolidation['total']:.2f}", ""])
    return _csv_response(rows, f"consolidado_{year}_{month:02d}.csv")
