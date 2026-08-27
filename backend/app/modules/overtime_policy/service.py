"""Servicio de política de horas extra.

Provee la ÚNICA fuente de verdad para resolver las tasas efectivas de horas
extra (seccion_horas_extra.md §7): ``get_effective_overtime_rates``.

Resolución:
  - Si el empleado tiene override vigente en esa fecha (salary_settings con
    use_custom_overtime_rates = true) → source "employee_override".
  - Si no → política general de empresa vigente → source "company_policy".
  - Si no hay política general → devuelve los MÍNIMOS legales (25/35).

Todo el payroll y el cálculo de horas extra debe usar esta función. No se
duplica la decisión en otros módulos.
"""

import uuid
from datetime import date, timedelta
from decimal import Decimal

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.modules.audit.repository import AuditRepository
from app.modules.overtime_policy.models import (
    MIN_ADDITIONAL_HOURS,
    MIN_FIRST_TWO_HOURS,
    CompanyOvertimePolicy,
)
from app.modules.overtime_policy.repository import OvertimePolicyRepository
from app.modules.salary.repository import SalarySettingRepository


class OvertimePolicyService:
    def __init__(self, db: Session) -> None:
        self.db = db
        self.repo = OvertimePolicyRepository(db)

    def get_effective_overtime_rates(self, employee_id: uuid.UUID, day: date) -> dict:
        """Tasas efectivas para un empleado en una fecha (fuente única de verdad)."""
        # 1) Excepción por empleado vigente en la fecha.
        salary = SalarySettingRepository(self.db).get_for_date(employee_id, day)
        if salary is not None and salary.use_custom_overtime_rates:
            return {
                "first_two_hours_rate": salary.custom_first_two_hours_rate,
                "additional_hours_rate": salary.custom_additional_hours_rate,
                "source": "employee_override",
            }

        # 2) Política general vigente en la fecha.
        policy = self.repo.get_for_date(day)
        if policy is not None:
            return {
                "first_two_hours_rate": policy.first_two_hours_rate,
                "additional_hours_rate": policy.additional_hours_rate,
                "source": "company_policy",
            }

        # 3) Sin política → mínimos legales (cuantizados a 2 decimales).
        return {
            "first_two_hours_rate": MIN_FIRST_TWO_HOURS.quantize(Decimal("0.01")),
            "additional_hours_rate": MIN_ADDITIONAL_HOURS.quantize(Decimal("0.01")),
            "source": "company_policy",
        }

    def get_active(self) -> CompanyOvertimePolicy | None:
        return self.repo.get_active()

    def list_history(self) -> list[CompanyOvertimePolicy]:
        return self.repo.list_history()

    def set_policy(
        self,
        *,
        first_two_hours_rate: Decimal,
        additional_hours_rate: Decimal,
        effective_from: date,
        reason: str,
        performed_by: uuid.UUID | None,
    ) -> CompanyOvertimePolicy:
        active = self.repo.get_active()
        if active is not None and active.effective_from >= effective_from:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=(
                    f"Ya hay una política vigente desde {active.effective_from.isoformat()}. "
                    "Para cambiarla, usa una fecha posterior (la anterior quedará en el historial)."
                ),
            )

        if active is not None:
            self.repo.close_active(effective_from - timedelta(days=1))

        created = self.repo.create(
            first_two_hours_rate=first_two_hours_rate,
            additional_hours_rate=additional_hours_rate,
            effective_from=effective_from,
            reason=reason.strip(),
        )

        AuditRepository(self.db).create(
            entity_type="overtime_policy",
            entity_id=created.id,
            action="UPDATE_OVERTIME_POLICY",
            old_values=self._serialize(active),
            new_values=self._serialize(created),
            reason=reason.strip(),
            performed_by=performed_by,
        )
        return created

    @staticmethod
    def _serialize(policy: CompanyOvertimePolicy | None) -> dict | None:
        if policy is None:
            return None
        return {
            "first_two_hours_rate": str(policy.first_two_hours_rate),
            "additional_hours_rate": str(policy.additional_hours_rate),
            "effective_from": policy.effective_from.isoformat(),
            "effective_to": policy.effective_to.isoformat() if policy.effective_to else None,
        }
