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
from app.modules.audit.repository import AuditRepository
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
        performed_by: uuid.UUID | None = None,
    ) -> WorkSchedule:
        if EmployeeRepository(self.db).get_by_id(employee_id) is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Empleado no encontrado")

        active = self.repo.get_active(employee_id)
        if active is not None and active.effective_from >= effective_from:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=(
                    f"Ya hay una jornada vigente desde {active.effective_from.isoformat()}. "
                    "Para cambiarla, usa una fecha posterior (la nueva jornada entrará "
                    "en vigor ese día y la anterior quedará en el historial)."
                ),
            )

        # Cerrar la vigente el día anterior al inicio de la nueva (historial).
        if active is not None:
            self.repo.close_active(employee_id, effective_from - timedelta(days=1))

        created = self.repo.create(
            employee_id=employee_id,
            effective_from=effective_from,
            break_minutes=break_minutes,
            **{field: minutes.get(field, 0) for field in _DAY_FIELDS},
        )

        AuditRepository(self.db).create(
            entity_type="schedule",
            entity_id=created.id,
            action="set_schedule",
            old_values=self._serialize(active),
            new_values=self._serialize(created),
            reason=f"Nueva jornada vigente desde {effective_from.isoformat()}",
            performed_by=performed_by,
        )
        return created

    @staticmethod
    def _serialize(schedule: WorkSchedule | None) -> dict | None:
        if schedule is None:
            return None
        return {
            "monday_minutes": schedule.monday_minutes,
            "tuesday_minutes": schedule.tuesday_minutes,
            "wednesday_minutes": schedule.wednesday_minutes,
            "thursday_minutes": schedule.thursday_minutes,
            "friday_minutes": schedule.friday_minutes,
            "saturday_minutes": schedule.saturday_minutes,
            "sunday_minutes": schedule.sunday_minutes,
            "break_minutes": schedule.break_minutes,
            "effective_from": schedule.effective_from.isoformat(),
            "effective_to": schedule.effective_to.isoformat() if schedule.effective_to else None,
        }
