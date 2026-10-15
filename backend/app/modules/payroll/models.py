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

from sqlalchemy import Boolean, CheckConstraint, Date, DateTime, ForeignKey, Integer, Numeric, String, UniqueConstraint, Uuid, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base

PERIOD_OPEN = "OPEN"
PERIOD_CALCULATED = "CALCULATED"
PERIOD_CLOSED = "CLOSED"

RECORD_PREVIEW = "PREVIEW"
RECORD_CONFIRMED = "CONFIRMED"
RECORD_EXCLUDED = "EXCLUDED"

PERIOD_MONTHLY = "MONTHLY"
PERIOD_FIRST_HALF = "FIRST_HALF"
PERIOD_SECOND_HALF = "SECOND_HALF"
PAYROLL_MONTH_MONTHLY_LEGACY = "MONTHLY_LEGACY"
PAYROLL_MONTH_SEMIMONTHLY = "SEMIMONTHLY"


class PayrollMonth(Base):
    """Raíz exclusiva de liquidación para un mes calendario.

    Los meses históricos pueden seguir sin padre; al crearse el primer
    periodo quincenal se bloquea esta fila para serializar Q1/Q2.
    """
    __tablename__ = "payroll_months"
    __table_args__ = (
        UniqueConstraint("year", "month", name="uq_payroll_month_year_month"),
        CheckConstraint("month >= 1 AND month <= 12", name="ck_payroll_month_month"),
    )
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    year: Mapped[int] = mapped_column(Integer, nullable=False)
    month: Mapped[int] = mapped_column(Integer, nullable=False)
    mode: Mapped[str] = mapped_column(String(24), nullable=False, default=PAYROLL_MONTH_MONTHLY_LEGACY)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


class PayrollPeriod(Base):
    __tablename__ = "payroll_periods"
    __table_args__ = (
        CheckConstraint("version >= 1", name="ck_payroll_period_version_positive"),
        UniqueConstraint("root_period_id", "version", name="uq_payroll_period_root_version"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    payroll_month_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("payroll_months.id"), nullable=True, index=True)
    period_kind: Mapped[str] = mapped_column(String(20), nullable=False, default=PERIOD_MONTHLY, server_default=PERIOD_MONTHLY)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    start_date: Mapped[date] = mapped_column(Date, nullable=False)
    end_date: Mapped[date] = mapped_column(Date, nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default=PERIOD_OPEN)
    root_period_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False, default=uuid.uuid4, index=True)
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1, server_default="1")
    supersedes_period_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("payroll_periods.id"), nullable=True, index=True
    )
    rectification_reason: Mapped[str | None] = mapped_column(String(500), nullable=True)
    inputs_fingerprint: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )

    records = relationship("PayrollRecord", back_populates="payroll_period")
    payroll_month = relationship("PayrollMonth")


class PayrollRecord(Base):
    __tablename__ = "payroll_records"
    __table_args__ = (
        UniqueConstraint("payroll_period_id", "employee_id", name="uq_payroll_record_period_employee"),
    )

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
    # Valoración aprobada de descanso/feriado; separada de HE para impedir
    # que una misma jornada se liquide dos veces.
    special_day_amount: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False, default=Decimal("0.00"), server_default="0.00")
    adjustment_minutes: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    adjustment_amount: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False, default=Decimal("0.00"))
    base_salary: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    manual_adjustment: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False, default=Decimal("0.00"))
    missing_salary_days: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    total: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default=RECORD_PREVIEW)
    payable: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default="true")
    notes: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )

    payroll_period = relationship("PayrollPeriod", back_populates="records")
    employee = relationship("Employee")
