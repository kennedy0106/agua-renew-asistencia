"""Repositorio de la política general de horas extra."""

import uuid
from datetime import date

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.modules.overtime_policy.models import CompanyOvertimePolicy


class OvertimePolicyRepository:
    def __init__(self, db: Session) -> None:
        self.db = db

    def get_for_date(self, day: date) -> CompanyOvertimePolicy | None:
        """Política vigente en la fecha dada (la más reciente que cubre el día)."""
        return self.db.scalar(
            select(CompanyOvertimePolicy)
            .where(
                CompanyOvertimePolicy.effective_from <= day,
                (CompanyOvertimePolicy.effective_to.is_(None))
                | (CompanyOvertimePolicy.effective_to >= day),
            )
            .order_by(CompanyOvertimePolicy.effective_from.desc())
            .limit(1)
        )

    def get_active(self) -> CompanyOvertimePolicy | None:
        """Política vigente ahora (effective_to IS NULL)."""
        return self.db.scalar(
            select(CompanyOvertimePolicy)
            .where(CompanyOvertimePolicy.effective_to.is_(None))
            .order_by(CompanyOvertimePolicy.effective_from.desc())
            .limit(1)
        )

    def list_history(self) -> list[CompanyOvertimePolicy]:
        return list(
            self.db.scalars(
                select(CompanyOvertimePolicy).order_by(
                    CompanyOvertimePolicy.effective_from.desc()
                )
            )
        )

    def create(
        self,
        *,
        first_two_hours_rate,
        additional_hours_rate,
        effective_from: date,
        reason: str,
    ) -> CompanyOvertimePolicy:
        policy = CompanyOvertimePolicy(
            first_two_hours_rate=first_two_hours_rate,
            additional_hours_rate=additional_hours_rate,
            effective_from=effective_from,
            reason=reason,
        )
        self.db.add(policy)
        self.db.commit()
        self.db.refresh(policy)
        return policy

    def close_active(self, until: date) -> None:
        """Cierra la política vigente (effective_to = until)."""
        active = self.get_active()
        if active is not None:
            active.effective_to = until
            self.db.add(active)
            self.db.commit()
