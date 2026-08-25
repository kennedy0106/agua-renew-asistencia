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
from datetime import date, datetime

from fastapi import APIRouter, Depends
from fastapi.responses import Response
from sqlalchemy.orm import Session

from app.core.permissions import get_current_user, require_admin_or_boss
from app.core.timezone import lima_tz
from app.db.session import get_db
from app.modules.attendance.repository import AttendanceRepository
from app.modules.payroll.repository import PayrollRepository
from app.modules.schedules.service import ScheduleService

router = APIRouter(prefix="/api/v1/exports", tags=["exports"])


def _csv_response(rows: list[list], filename: str) -> Response:
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerows(rows)
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
        value = value.replace(tzinfo=datetime.now().astimezone().tzinfo)
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
    _: object = Depends(get_current_user),
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
                record.notes or "",
            ]
        )
    return _csv_response(rows, f"asistencia_{date_from or 'todo'}_{date_to or 'hoy'}.csv")


@router.get("/salaries.csv")
def export_salaries(
    period_id: uuid.UUID,
    db: Session = Depends(get_db),
    _: object = Depends(require_admin_or_boss),
) -> Response:
    period = PayrollRepository(db).get_period(period_id)
    if period is None:
        from fastapi import HTTPException, status

        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Periodo no encontrado")
    records = PayrollRepository(db).list_records(period_id)
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
        ]
    ]
    for record in records:
        employee = record.employee
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
            ]
        )
    safe_name = "".join(c for c in period.name if c.isalnum() or c in "-_ ").strip().replace(" ", "_")
    return _csv_response(rows, f"sueldos_{safe_name}.csv")
