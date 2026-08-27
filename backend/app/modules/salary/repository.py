"""Repositorio de configuración salarial."""

import uuid
from datetime import date
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.modules.salary.models import SalarySetting


class SalarySettingRepository:
    def __init__(self, db: Session) -> None:
        self.db = db

    def get_for_date(self, employee_id: uuid.UUID, day: date) -> SalarySetting | None:
        return self.db.scalar(
            select(SalarySetting)
            .where(
                SalarySetting.employee_id == employee_id,
                SalarySetting.effective_from <= day,
                (SalarySetting.effective_to.is_(None)) | (SalarySetting.effective_to >= day),
            )
            .order_by(SalarySetting.effective_from.desc())
            .limit(1)
        )

    def get_active(self, employee_id: uuid.UUID) -> SalarySetting | None:
        return self.db.scalar(
            select(SalarySetting)
            .where(SalarySetting.employee_id == employee_id, SalarySetting.effective_to.is_(None))
            .order_by(SalarySetting.effective_from.desc())
            .limit(1)
        )

    def list_history(self, employee_id: uuid.UUID) -> list[SalarySetting]:
        return list(
            self.db.scalars(
                select(SalarySetting)
                .where(SalarySetting.employee_id == employee_id)
                .order_by(SalarySetting.effective_from.desc())
            )
        )

    def create(
        self,
        *,
        employee_id: uuid.UUID,
        monthly_salary: Decimal,
        effective_from: date,
        overtime_enabled: bool = False,
        use_custom_overtime_rates: bool = False,
        custom_first_two_hours_rate: Decimal | None = None,
        custom_additional_hours_rate: Decimal | None = None,
    ) -> SalarySetting:
        setting = SalarySetting(
            employee_id=employee_id,
            monthly_salary=monthly_salary,
            effective_from=effective_from,
            overtime_enabled=overtime_enabled,
            use_custom_overtime_rates=use_custom_overtime_rates,
            custom_first_two_hours_rate=custom_first_two_hours_rate,
            custom_additional_hours_rate=custom_additional_hours_rate,
        )
        self.db.add(setting)
        self.db.commit()
        self.db.refresh(setting)
        return setting

    def close_active(self, employee_id: uuid.UUID, until: date) -> None:
        active = self.get_active(employee_id)
        if active is not None:
            active.effective_to = until
            self.db.add(active)
