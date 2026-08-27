"""Configuración salarial por empleado.

Reglas:
- Sueldo mensual en NUMERIC(12,2) (nunca float).
- Vigencia histórica: cambiar el sueldo NUNCA sobrescribe el anterior.
- Horas extra: solo método PERCENTAGE (seccion_horas_extra.md). Las tasas se
  resuelven por TRAMOS (primeras 2 h / tercera en adelante) vía la política
  general o el override por empleado (get_effective_overtime_rates).
- Solo ADMIN/BOSS pueden ver esta información.
"""

import uuid
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Numeric,
    String,
    Uuid,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base


class SalarySetting(Base):
    __tablename__ = "salary_settings"
    __table_args__ = (
        CheckConstraint("monthly_salary >= 0", name="ck_salary_monthly_non_negative"),
        CheckConstraint(
            "custom_first_two_hours_rate IS NULL OR custom_first_two_hours_rate >= 25",
            name="ck_salary_custom_first_two_min",
        ),
        CheckConstraint(
            "custom_additional_hours_rate IS NULL OR custom_additional_hours_rate >= 35",
            name="ck_salary_custom_additional_min",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    employee_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("employees.id"), nullable=False, index=True
    )
    monthly_salary: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    overtime_enabled: Mapped[bool] = mapped_column(nullable=False, default=False)
    # Excepción por empleado a la política general de horas extra.
    use_custom_overtime_rates: Mapped[bool] = mapped_column(nullable=False, default=False)
    custom_first_two_hours_rate: Mapped[Decimal | None] = mapped_column(Numeric(5, 2), nullable=True)
    custom_additional_hours_rate: Mapped[Decimal | None] = mapped_column(Numeric(5, 2), nullable=True)
    effective_from: Mapped[date] = mapped_column(Date, nullable=False)
    effective_to: Mapped[date | None] = mapped_column(Date, nullable=True)  # NULL = vigente
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )

    employee = relationship("Employee")
