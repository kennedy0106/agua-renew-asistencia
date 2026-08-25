"""Servicio de jornadas laborales.

- ``expected_minutes(employee_id, date)``: minutos pactados según la jornada
  vigente para esa fecha (0 si no hay jornada o el día no es laborable).
- ``set_schedule``: cierra la jornada vigente (historial preservado) y crea
  la nueva; rechaza solapamientos (409).
"""

import uuid
from datetime import date, timedelta

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.modules.employees.repository import EmployeeRepository
from app.modules.schedules.models import WorkSchedule
from app.modules.schedules.repository import WorkScheduleRepository

_DAY_FIELDS = (
    "monday_minutes",
    "tuesday_minutes",
    "wednesday_minutes",
    "thursday_minutes",
    "friday_minutes",
    "saturday_minutes",
    "sunday_minutes",
)


class ScheduleService:
    def __init__(self, db: Session) -> None:
        self.db = db
        self.repo = WorkScheduleRepository(db)

    def expected_minutes(self, employee_id: uuid.UUID, day: date) -> int:
        """Minutos que debía trabajar el empleado ese día (jornada vigente en la fecha)."""
        schedule = self.repo.get_for_date(employee_id, day)
        if schedule is None:
            return 0
        return getattr(schedule, _DAY_FIELDS[day.weekday()])

    def get_current(self, employee_id: uuid.UUID) -> WorkSchedule:
        schedule = self.repo.get_active(employee_id)
        if schedule is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="El empleado no tiene jornada configurada",
            )
        return schedule

    def get_for_date_or_404(self, employee_id: uuid.UUID, day: date) -> WorkSchedule:
        schedule = self.repo.get_for_date(employee_id, day)
        if schedule is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="No hay jornada configurada para esa fecha",
            )
        return schedule

    def list_history(self, employee_id: uuid.UUID) -> list[WorkSchedule]:
        return self.repo.list_history(employee_id)

    def set_schedule(
        self,
        *,
        employee_id: uuid.UUID,
        effective_from: date,
        minutes: dict[str, int],
        break_minutes: int = 0,
    ) -> WorkSchedule:
        if EmployeeRepository(self.db).get_by_id(employee_id) is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Empleado no encontrado")

        active = self.repo.get_active(employee_id)
        if active is not None and active.effective_from >= effective_from:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Ya existe una jornada vigente desde esa fecha o después; elige una fecha posterior",
            )

        # Cerrar la vigente el día anterior al inicio de la nueva (historial).
        if active is not None:
            self.repo.close_active(employee_id, effective_from - timedelta(days=1))

        return self.repo.create(
            employee_id=employee_id,
            effective_from=effective_from,
            break_minutes=break_minutes,
            **{field: minutes.get(field, 0) for field in _DAY_FIELDS},
        )
