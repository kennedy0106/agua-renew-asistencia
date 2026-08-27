"""Política general de horas extra de la empresa (seccion_horas_extra.md).

- Dos tramos legales mínimos: primeras 2 h >= 25%, tercera en adelante >= 35%.
- Vigencia histórica: un cambio nunca sobrescribe el anterior; se cierra el
  vigente (effective_to) y se crea uno nuevo (effective_from).
- ``reason`` es obligatorio (motivo del cambio) para la auditoría.
- CHECK constraints en BD: nunca puede guardarse por debajo de los mínimos.
"""

import uuid
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import CheckConstraint, Date, DateTime, Numeric, String, Uuid, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base

MIN_FIRST_TWO_HOURS = Decimal("25")
MIN_ADDITIONAL_HOURS = Decimal("35")


class CompanyOvertimePolicy(Base):
    __tablename__ = "company_overtime_policy"
    __table_args__ = (
        CheckConstraint(
            "first_two_hours_rate >= 25", name="ck_overtime_policy_first_two_min"
        ),
        CheckConstraint(
            "additional_hours_rate >= 35", name="ck_overtime_policy_additional_min"
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    first_two_hours_rate: Mapped[Decimal] = mapped_column(Numeric(5, 2), nullable=False)
    additional_hours_rate: Mapped[Decimal] = mapped_column(Numeric(5, 2), nullable=False)
    effective_from: Mapped[date] = mapped_column(Date, nullable=False)
    effective_to: Mapped[date | None] = mapped_column(Date, nullable=True)  # NULL = vigente
    reason: Mapped[str] = mapped_column(String(500), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )
