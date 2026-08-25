"""Configuración salarial por empleado.

Reglas:
- Sueldo mensual en NUMERIC(12,2) (nunca float).
- Vigencia histórica: cambiar el sueldo NUNCA sobrescribe el anterior.
- Métodos de horas extra: PERCENTAGE | FIXED_RATE | MANUAL.
- Solo ADMIN/BOSS pueden ver esta información.
"""

import uuid
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import CheckConstraint, Date, DateTime, ForeignKey, Numeric, String, Uuid, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base

OVERTIME_METHODS = ("PERCENTAGE", "FIXED_RATE", "MANUAL")


class SalarySetting(Base):
    __tablename__ = "salary_settings"
    __table_args__ = (
        CheckConstraint("monthly_salary >= 0", name="ck_salary_monthly_non_negative"),
        CheckConstraint(
            "overtime_percentage IS NULL OR overtime_percentage >= 0",
            name="ck_salary_percentage_non_negative",
        ),
        CheckConstraint(
            "overtime_fixed_rate IS NULL OR overtime_fixed_rate >= 0",
            name="ck_salary_fixed_rate_non_negative",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    employee_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("employees.id"), nullable=False, index=True
    )
    monthly_salary: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    overtime_enabled: Mapped[bool] = mapped_column(nullable=False, default=False)
    overtime_method: Mapped[str] = mapped_column(String(20), nullable=False, default="PERCENTAGE")
    overtime_percentage: Mapped[Decimal | None] = mapped_column(Numeric(5, 2), nullable=True)
    overtime_fixed_rate: Mapped[Decimal | None] = mapped_column(Numeric(12, 2), nullable=True)
    effective_from: Mapped[date] = mapped_column(Date, nullable=False)
    effective_to: Mapped[date | None] = mapped_column(Date, nullable=True)  # NULL = vigente
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )

    employee = relationship("Employee")
