"""Cargas administrativas de tiempo histórico.

Estas tablas son deliberadamente independientes de ``AttendanceRecord``: una
carga de duración no crea una sesión, evento, foto ni estado abierto del
kiosco.
"""
import uuid
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import Boolean, CheckConstraint, Date, DateTime, ForeignKey, Index, Integer, JSON, Numeric, String, UniqueConstraint, Uuid, func, text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base


class ManualAttendanceDay(Base):
    __tablename__ = "manual_attendance_days"
    __table_args__ = (
        CheckConstraint("worked_minutes_net >= 0 AND worked_minutes_net <= 1440", name="ck_manual_day_worked_range"),
        CheckConstraint("normal_minutes >= 0 AND additional_minutes >= 0 AND recovery_minutes >= 0", name="ck_manual_day_parts_nonnegative"),
        CheckConstraint("worked_minutes_net = normal_minutes + additional_minutes + recovery_minutes", name="ck_manual_day_parts_match"),
        UniqueConstraint("employee_id", "work_date", "version", name="uq_manual_day_employee_date_version"),
        CheckConstraint("known_break_minutes IS NULL OR known_break_minutes >= 0", name="ck_manual_day_break_nonnegative"),
        CheckConstraint("(known_check_in_at IS NULL OR known_check_out_at IS NULL) OR known_check_out_at >= known_check_in_at", name="ck_manual_day_known_times_order"),
        Index("uq_manual_day_active_employee_date", "employee_id", "work_date", unique=True, postgresql_where=text("voided_at IS NULL"), sqlite_where=text("voided_at IS NULL")),
    )
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    employee_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("employees.id"), nullable=False, index=True)
    work_date: Mapped[date] = mapped_column(Date, nullable=False, index=True)
    worked_minutes_net: Mapped[int] = mapped_column(Integer, nullable=False)
    normal_minutes: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    additional_minutes: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    recovery_minutes: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    day_context: Mapped[str] = mapped_column(String(24), nullable=False, default="ORDINARY")
    source_reference: Mapped[str | None] = mapped_column(String(200))
    known_check_in_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    known_check_out_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    known_break_minutes: Mapped[int | None] = mapped_column(Integer)
    reason: Mapped[str] = mapped_column(String(500), nullable=False)
    payment_status: Mapped[str] = mapped_column(String(20), nullable=False, default="NOT_APPLICABLE")
    payment_method: Mapped[str | None] = mapped_column(String(24))
    payment_concept: Mapped[str | None] = mapped_column(String(120))
    approved_additional_amount: Mapped[Decimal | None] = mapped_column(Numeric(12, 2))
    payment_snapshot: Mapped[dict | None] = mapped_column(JSON)
    approved_by_user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"), index=True)
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    supersedes_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("manual_attendance_days.id"), index=True)
    voided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    voided_by_user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"), index=True)
    void_reason: Mapped[str | None] = mapped_column(String(500))
    created_by_user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), nullable=False, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())
    employee = relationship("Employee")


class RecoveryCommitment(Base):
    __tablename__ = "recovery_commitments"
    __table_args__ = (
        CheckConstraint("agreed_minutes > 0", name="ck_recovery_commitment_positive"),
        UniqueConstraint("employee_id", "permission_date", name="uq_recovery_commitment_employee_permission"),
    )
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    employee_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("employees.id"), nullable=False, index=True)
    permission_date: Mapped[date] = mapped_column(Date, nullable=False)
    agreed_minutes: Mapped[int] = mapped_column(Integer, nullable=False)
    covered_before: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    reference: Mapped[str] = mapped_column(String(500), nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="ACTIVE")
    created_by_user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), nullable=False, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


class ManualRecoveryApplication(Base):
    __tablename__ = "manual_recovery_applications"
    __table_args__ = (UniqueConstraint("manual_day_id", "commitment_id", name="uq_manual_recovery_application"), CheckConstraint("minutes > 0", name="ck_manual_recovery_application_positive"))
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    manual_day_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("manual_attendance_days.id"), nullable=False, index=True)
    commitment_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("recovery_commitments.id"), nullable=False, index=True)
    minutes: Mapped[int] = mapped_column(Integer, nullable=False)
    manual_day = relationship("ManualAttendanceDay")
    commitment = relationship("RecoveryCommitment")


class ManualAttendanceIdempotency(Base):
    __tablename__ = "manual_attendance_idempotency"
    idempotency_key: Mapped[str] = mapped_column(String(128), primary_key=True)
    payload_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    result: Mapped[dict] = mapped_column(JSON, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
