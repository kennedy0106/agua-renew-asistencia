"""Servicio de asistencia: reglas de marcación pública.

- La hora SIEMPRE la define el backend (UTC en BD, presentación en
  America/Lima). Nunca se confía en el reloj del navegador.
- Check-in: rechazado si hay una entrada abierta (doble entrada).
- Check-out: rechazado sin entrada abierta; worked_minutes = duración −
  refrigerio de la jornada vigente en la fecha (0 si no hay jornada).
- Empleado cesado no puede marcar.
"""

import uuid
from datetime import date, datetime, timezone

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.core.timezone import lima_tz
from app.modules.attendance.models import AttendanceRecord
from app.modules.attendance.repository import AttendanceRepository
from app.modules.employees.repository import EmployeeRepository
from app.modules.schedules.repository import WorkScheduleRepository
from app.modules.schedules.service import ScheduleService


def _as_utc(dt: datetime) -> datetime:
    """Normaliza a UTC aware. SQLite no preserva tzinfo: asume UTC."""
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def compute_worked_minutes(check_in_at: datetime, check_out_at: datetime, break_minutes: int) -> int:
    """Minutos trabajados (duración − refrigerio), nunca negativo."""
    start = _as_utc(check_in_at)
    end = _as_utc(check_out_at)
    minutes = int((end - start).total_seconds() // 60)
    return max(0, minutes - break_minutes)


class AttendanceService:
    def __init__(self, db: Session) -> None:
        self.db = db
        self.repo = AttendanceRepository(db)

    def _get_active_employee(self, employee_id: uuid.UUID):
        employee = EmployeeRepository(self.db).get_by_id(employee_id)
        if employee is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Empleado no encontrado")
        if not employee.active:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Empleado inactivo: no puede marcar asistencia",
            )
        return employee

    def identify(self, identifier: str) -> dict:
        """Resuelve al trabajador por DNI o código y devuelve su estado actual.

        Mensaje genérico si no existe: no se revela información adicional.
        """
        identifier = identifier.strip()
        employees = EmployeeRepository(self.db)
        employee = employees.get_by_dni(identifier) or employees.get_by_employee_code(identifier)
        if employee is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Trabajador no encontrado. Verifique su DNI o código.",
            )
        if not employee.active:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Empleado inactivo: no puede marcar asistencia",
            )

        open_record = self.repo.get_open(employee.id)
        last_record = self.repo.get_last(employee.id)
        now = datetime.now(timezone.utc)
        return {
            "employee": {
                "id": employee.id,
                "first_name": employee.first_name,
                "last_name": employee.last_name,
                "job_role_name": employee.job_role.name if employee.job_role else None,
                "active": employee.active,
            },
            "state": {
                "has_open_entry": open_record is not None,
                "open_check_in_at": open_record.check_in_at.isoformat() if open_record else None,
                "last_record": (
                    {
                        "id": last_record.id,
                        "work_date": last_record.work_date.isoformat(),
                        "check_in_at": last_record.check_in_at.isoformat(),
                        "check_out_at": last_record.check_out_at.isoformat() if last_record.check_out_at else None,
                        "worked_minutes": last_record.worked_minutes,
                        "status": last_record.status,
                    }
                    if last_record
                    else None
                ),
            },
            "server_time": now.isoformat(),
            "server_time_label": now.astimezone(lima_tz()).strftime("%H:%M"),
        }

    def check_in(self, employee_id: uuid.UUID) -> AttendanceRecord:
        self._get_active_employee(employee_id)

        if self.repo.get_open(employee_id) is not None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Ya tiene una entrada abierta; marque su salida primero",
            )

        now = datetime.now(timezone.utc)
        work_date = now.astimezone(lima_tz()).date()
        return self.repo.create(employee_id=employee_id, work_date=work_date, check_in_at=now)

    def check_out(self, employee_id: uuid.UUID) -> AttendanceRecord:
        self._get_active_employee(employee_id)

        record = self.repo.get_open(employee_id)
        if record is None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="No tiene una entrada abierta para marcar salida",
            )

        now = datetime.now(timezone.utc)
        schedule = WorkScheduleRepository(self.db).get_for_date(employee_id, record.work_date)
        break_minutes = schedule.break_minutes if schedule else 0
        worked = compute_worked_minutes(record.check_in_at, now, break_minutes)
        return self.repo.check_out(record, check_out_at=now, worked_minutes=worked)

    # --- Panel administrativo (Fase 7) ---

    def list_records(
        self,
        *,
        employee_id: uuid.UUID | None = None,
        date_from: date | None = None,
        date_to: date | None = None,
        status_filter: str | None = None,
    ) -> list[dict]:
        """Registros para el panel, con minutos esperados (jornada) y diferencia."""
        records = self.repo.list_records(
            employee_id=employee_id, date_from=date_from, date_to=date_to, status=status_filter
        )
        schedules = ScheduleService(self.db)
        result = []
        for record in records:
            expected = schedules.expected_minutes(record.employee_id, record.work_date)
            result.append(
                {
                    "id": record.id,
                    "employee_id": record.employee_id,
                    "employee_name": (
                        f"{record.employee.first_name} {record.employee.last_name}"
                        if record.employee
                        else None
                    ),
                    "job_role_name": (
                        record.employee.job_role.name if record.employee and record.employee.job_role else None
                    ),
                    "work_date": record.work_date,
                    "check_in_at": record.check_in_at,
                    "check_out_at": record.check_out_at,
                    "worked_minutes": record.worked_minutes,
                    "expected_minutes": expected,
                    "difference_minutes": (
                        record.worked_minutes - expected if record.worked_minutes is not None else None
                    ),
                    "status": record.status,
                    "notes": record.notes,
                }
            )
        return result

    def summary(self, today: date) -> dict:
        """Indicadores simples del dashboard (MVP §29)."""
        active = self.repo.count_active_employees()
        present = self.repo.count_distinct_employees_on(today)
        return {
            "employees_active": active,
            "present_today": present,
            "no_entry_today": max(0, active - present),
            "open_entries": self.repo.count_open(),
            "checked_out_today": self.repo.count_complete_on(today),
        }
