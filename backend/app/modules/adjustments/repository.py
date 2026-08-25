"""Repositorio de ajustes de horas."""

import uuid
from datetime import date

from sqlalchemy import func, select
from sqlalchemy.orm import Session, joinedload

from app.modules.adjustments.models import HourAdjustment


class AdjustmentRepository:
    def __init__(self, db: Session) -> None:
        self.db = db

    def get_by_id(self, adjustment_id: uuid.UUID) -> HourAdjustment | None:
        return self.db.scalar(
            select(HourAdjustment).options(joinedload(HourAdjustment.approved_by_user)).where(HourAdjustment.id == adjustment_id)
        )

    def list_for_employee(self, employee_id: uuid.UUID) -> list[HourAdjustment]:
        return list(
            self.db.scalars(
                select(HourAdjustment)
                .options(joinedload(HourAdjustment.approved_by_user))
                .where(HourAdjustment.employee_id == employee_id)
                .order_by(HourAdjustment.adjustment_date.desc(), HourAdjustment.created_at.desc())
            )
        )

    def create(
        self,
        *,
        employee_id: uuid.UUID,
        adjustment_date: date,
        minutes: int,
        adjustment_type: str,
        reason: str,
    ) -> HourAdjustment:
        adjustment = HourAdjustment(
            employee_id=employee_id,
            adjustment_date=adjustment_date,
            minutes=minutes,
            adjustment_type=adjustment_type,
            reason=reason,
            status="PENDING",
        )
        self.db.add(adjustment)
        self.db.commit()
        self.db.refresh(adjustment)
        return adjustment

    def set_status(self, adjustment: HourAdjustment, *, status: str, approved_by: uuid.UUID) -> HourAdjustment:
        adjustment.status = status
        adjustment.approved_by = approved_by
        adjustment.approved_at = func.now()
        self.db.add(adjustment)
        self.db.commit()
        self.db.refresh(adjustment)
        return adjustment

    def approved_minutes_in_range(self, employee_id: uuid.UUID, date_from: date, date_to: date) -> int:
        total = self.db.scalar(
            select(func.coalesce(func.sum(HourAdjustment.minutes), 0)).where(
                HourAdjustment.employee_id == employee_id,
                HourAdjustment.status == "APPROVED",
                HourAdjustment.adjustment_date >= date_from,
                HourAdjustment.adjustment_date <= date_to,
            )
        )
        return int(total or 0)
