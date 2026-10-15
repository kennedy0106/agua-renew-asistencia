"""Persistencia de CAL-01 a CAL-03.

El calendario no crea asistencia.  Guarda las reglas que permiten interpretar
una fecha y las valoraciones revisables que después consume planilla.
"""
import uuid
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import CheckConstraint, Date, DateTime, ForeignKey, Index, Integer, JSON, Numeric, String, UniqueConstraint, Uuid, func, text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base

SUBSTITUTION_PROPOSED = "PROPOSED"
SUBSTITUTION_APPROVED = "APPROVED"
SUBSTITUTION_ENJOYED = "ENJOYED"
SUBSTITUTION_CANCELLED = "CANCELLED"
SUBSTITUTION_INVALIDATED = "INVALIDATED"

VALUATION_PENDING = "PENDING"
VALUATION_APPROVED = "APPROVED"
VALUATION_REVIEW_REQUIRED = "REVIEW_REQUIRED"
VALUATION_VOIDED = "VOIDED"


class EmployeeWeeklyRestRule(Base):
    __tablename__ = "employee_weekly_rest_rules"
    __table_args__ = (
        CheckConstraint("weekly_rest_weekday >= 0 AND weekly_rest_weekday <= 6", name="ck_weekly_rest_weekday"),
        CheckConstraint("reference_daily_minutes > 0 AND reference_daily_minutes <= 1440", name="ck_weekly_rest_reference"),
        CheckConstraint("week_starts_on = 0", name="ck_weekly_rest_monday_start"),
        Index("ix_weekly_rest_employee_effective", "employee_id", "effective_from", "effective_to"),
    )
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    employee_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("employees.id"), nullable=False, index=True)
    weekly_rest_weekday: Mapped[int] = mapped_column(Integer, nullable=False)
    week_starts_on: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    reference_daily_minutes: Mapped[int] = mapped_column(Integer, nullable=False)
    source: Mapped[str] = mapped_column(String(80), nullable=False)
    reason: Mapped[str] = mapped_column(String(500), nullable=False)
    effective_from: Mapped[date] = mapped_column(Date, nullable=False)
    effective_to: Mapped[date | None] = mapped_column(Date)
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1, server_default="1")
    created_by_user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    employee = relationship("Employee")


class RestSubstitution(Base):
    __tablename__ = "rest_substitutions"
    __table_args__ = (
        CheckConstraint("substitute_end >= substitute_start", name="ck_rest_substitution_range"),
        CheckConstraint("version >= 1", name="ck_rest_substitution_version"),
        CheckConstraint("origin_kind IN ('WEEKLY_REST', 'HOLIDAY')", name="ck_rest_substitution_origin_kind"),
        Index("ix_rest_substitution_employee_origin", "employee_id", "original_date"),
        Index("ix_rest_substitution_employee_range", "employee_id", "substitute_start", "substitute_end"),
    )
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    employee_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("employees.id"), nullable=False, index=True)
    original_date: Mapped[date] = mapped_column(Date, nullable=False, index=True)
    origin_kind: Mapped[str] = mapped_column(String(24), nullable=False, default="WEEKLY_REST", server_default="WEEKLY_REST")
    substitute_start: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    substitute_end: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    reference: Mapped[str] = mapped_column(String(500), nullable=False)
    reason: Mapped[str] = mapped_column(String(500), nullable=False)
    status: Mapped[str] = mapped_column(String(24), nullable=False, default=SUBSTITUTION_PROPOSED)
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1, server_default="1")
    evidence: Mapped[dict | None] = mapped_column(JSON)
    created_by_user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), nullable=False)
    approved_by_user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    cancelled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    employee = relationship("Employee")


class HolidayCalendarDay(Base):
    __tablename__ = "holiday_calendar_days"
    __table_args__ = (
        UniqueConstraint("holiday_date", "scope", "version", name="uq_holiday_calendar_day_version"),
        CheckConstraint("version >= 1", name="ck_holiday_calendar_version"),
        Index("ix_holiday_calendar_active", "holiday_date", "effective_to"),
    )
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    holiday_date: Mapped[date] = mapped_column(Date, nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(160), nullable=False)
    scope: Mapped[str] = mapped_column(String(40), nullable=False, default="NATIONAL")
    day_kind: Mapped[str] = mapped_column(String(40), nullable=False, default="HOLIDAY")
    source: Mapped[str] = mapped_column(String(250), nullable=False)
    effective_from: Mapped[date] = mapped_column(Date, nullable=False)
    effective_to: Mapped[date | None] = mapped_column(Date)
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1, server_default="1")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


class SpecialDayValuation(Base):
    __tablename__ = "special_day_valuations"
    __table_args__ = (
        CheckConstraint("worked_minutes >= 0", name="ck_special_day_worked_minutes"),
        CheckConstraint("reference_daily_minutes > 0", name="ck_special_day_reference_minutes"),
        CheckConstraint("version >= 1", name="ck_special_day_valuation_version"),
        Index("ix_special_day_valuation_employee_day", "employee_id", "work_date"),
        Index("uq_special_day_valuation_active", "employee_id", "work_date", "source_kind", unique=True, postgresql_where=text("voided_at IS NULL"), sqlite_where=text("voided_at IS NULL")),
    )
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    employee_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("employees.id"), nullable=False, index=True)
    work_date: Mapped[date] = mapped_column(Date, nullable=False, index=True)
    source_kind: Mapped[str] = mapped_column(String(40), nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default=VALUATION_PENDING)
    worked_minutes: Mapped[int] = mapped_column(Integer, nullable=False)
    reference_daily_minutes: Mapped[int] = mapped_column(Integer, nullable=False)
    amount: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False, default=Decimal("0.00"))
    calculation: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1, server_default="1")
    preview_token: Mapped[str | None] = mapped_column(String(128), index=True)
    approved_by_user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    voided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    void_reason: Mapped[str | None] = mapped_column(String(500))
    created_by_user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())
    components = relationship("SpecialDayValuationComponent", back_populates="valuation", cascade="all, delete-orphan")
    employee = relationship("Employee")


class SpecialDayValuationComponent(Base):
    __tablename__ = "special_day_valuation_components"
    __table_args__ = (UniqueConstraint("valuation_id", "component_kind", name="uq_special_day_component_kind"),)
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    valuation_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("special_day_valuations.id"), nullable=False, index=True)
    component_kind: Mapped[str] = mapped_column(String(48), nullable=False)
    minutes: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    amount: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False, default=Decimal("0.00"))
    details: Mapped[dict | None] = mapped_column(JSON)
    valuation = relationship("SpecialDayValuation", back_populates="components")


class WorkCalendarOperationReceipt(Base):
    __tablename__ = "work_calendar_operation_receipts"
    idempotency_key: Mapped[str] = mapped_column(String(128), primary_key=True)
    payload_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    operation_type: Mapped[str] = mapped_column(String(48), nullable=False)
    target_entity_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True, index=True)
    result: Mapped[dict] = mapped_column(JSON, nullable=False)
    actor_user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
