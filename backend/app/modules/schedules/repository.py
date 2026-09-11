"""Repositorio de jornadas laborales."""

import uuid
from datetime import date

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.modules.schedules.models import WorkSchedule


class WorkScheduleRepository:
    def __init__(self, db: Session) -> None:
        self.db = db

    def get_for_date(self, employee_id: uuid.UUID, day: date) -> WorkSchedule | None:
        return self.db.scalar(
            select(WorkSchedule)
            .where(
                WorkSchedule.employee_id == employee_id,
                WorkSchedule.effective_from <= day,
                (WorkSchedule.effective_to.is_(None)) | (WorkSchedule.effective_to >= day),
            )
            .order_by(WorkSchedule.effective_from.desc())
            .limit(1)
        )

    def get_active(self, employee_id: uuid.UUID) -> WorkSchedule | None:
        """Jornada vigente (effective_to IS NULL), la más reciente."""
        return self.db.scalar(
            select(WorkSchedule)
            .where(WorkSchedule.employee_id == employee_id, WorkSchedule.effective_to.is_(None))
            .order_by(WorkSchedule.effective_from.desc())
            .limit(1)
        )

    def list_history(self, employee_id: uuid.UUID) -> list[WorkSchedule]:
        return list(
            self.db.scalars(
                select(WorkSchedule)
                .where(WorkSchedule.employee_id == employee_id)
                .order_by(WorkSchedule.effective_from.desc())
            )
        )

    def create(
        self,
        *,
        employee_id: uuid.UUID,
        effective_from: date,
        monday_minutes: int = 0,
        tuesday_minutes: int = 0,
        wednesday_minutes: int = 0,
        thursday_minutes: int = 0,
        friday_minutes: int = 0,
        saturday_minutes: int = 0,
        sunday_minutes: int = 0,
        break_minutes: int = 0,
        break_applies_after_minutes: int = 360,
    ) -> WorkSchedule:
        schedule = WorkSchedule(
            employee_id=employee_id,
            effective_from=effective_from,
            monday_minutes=monday_minutes,
            tuesday_minutes=tuesday_minutes,
            wednesday_minutes=wednesday_minutes,
            thursday_minutes=thursday_minutes,
            friday_minutes=friday_minutes,
            saturday_minutes=saturday_minutes,
            sunday_minutes=sunday_minutes,
            break_minutes=break_minutes,
            break_applies_after_minutes=break_applies_after_minutes,
        )
        self.db.add(schedule)
        self.db.commit()
        self.db.refresh(schedule)
        return schedule

    def close_active(self, employee_id: uuid.UUID, until: date) -> None:
        """Cierra la jornada vigente hasta 'until' (effective_to = until)."""
        active = self.get_active(employee_id)
        if active is not None:
            active.effective_to = until
            self.db.add(active)
