"""Periodos de planilla (payroll) y registros calculados.

Reglas:
- Un periodo vive OPEN → CALCULATED → CLOSED. Cerrado es INMUTABLE.
- El cálculo guarda un SNAPSHOT en payroll_records (sueldo, minutos y montos
  congelados en el momento del cálculo).
- El ajuste manual (viáticos, bonos, descuentos con motivo) solo se puede
  aplicar antes del cierre y queda auditado.
- Dinero SIEMPRE en NUMERIC(12,2) / Decimal.
"""

import uuid
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import Date, DateTime, ForeignKey, Integer, Numeric, String, Uuid, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base

PERIOD_OPEN = "OPEN"
PERIOD_CALCULATED = "CALCULATED"
PERIOD_CLOSED = "CLOSED"

RECORD_PREVIEW = "PREVIEW"
RECORD_CONFIRMED = "CONFIRMED"


class PayrollPeriod(Base):
    __tablename__ = "payroll_periods"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    start_date: Mapped[date] = mapped_column(Date, nullable=False)
    end_date: Mapped[date] = mapped_column(Date, nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default=PERIOD_OPEN)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )

    records = relationship("PayrollRecord", back_populates="payroll_period")


class PayrollRecord(Base):
    __tablename__ = "payroll_records"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    payroll_period_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("payroll_periods.id"), nullable=False, index=True
    )
    employee_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("employees.id"), nullable=False, index=True
    )
    # --- Snapshot del cálculo ---
    monthly_salary: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    worked_minutes: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    expected_minutes: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    overtime_minutes: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    overtime_amount: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False, default=Decimal("0.00"))
    adjustment_minutes: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    adjustment_amount: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False, default=Decimal("0.00"))
    base_salary: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    manual_adjustment: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False, default=Decimal("0.00"))
    total: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default=RECORD_PREVIEW)
    notes: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )

    payroll_period = relationship("PayrollPeriod", back_populates="records")
    employee = relationship("Employee")
