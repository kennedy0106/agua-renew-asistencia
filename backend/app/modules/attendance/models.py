"""Registros de asistencia (marcación pública).

Reglas:
- check_in_at / check_out_at se guardan como timestamps UTC; la fecha local
  (work_date) se deriva en America/Lima.
- Un empleado no puede tener DOS entradas abiertas.
- worked_minutes se calcula al marcar salida: duración − refrigerio de la
  jornada vigente en esa fecha.
- El empleado cesado no puede marcar.
"""

import uuid
from datetime import date, datetime

from sqlalchemy import (
    JSON,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    String,
    UniqueConstraint,
    Uuid,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base

ATTENDANCE_OPEN = "OPEN"
ATTENDANCE_COMPLETE = "COMPLETE"
STORAGE_DATABASE = "DATABASE"
STORAGE_S3 = "S3"


class AttendanceRecord(Base):
    __tablename__ = "attendance_records"
    __table_args__ = (
        CheckConstraint(
            "check_out_at IS NULL OR check_out_at >= check_in_at",
            name="ck_attendance_checkout_after_checkin",
        ),
        Index(
            "uq_attendance_one_open_per_employee",
            "employee_id",
            unique=True,
            postgresql_where=text("check_out_at IS NULL"),
            sqlite_where=text("check_out_at IS NULL"),
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    employee_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("employees.id"), nullable=False, index=True
    )
    work_date: Mapped[date] = mapped_column(Date, nullable=False, index=True)
    check_in_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    check_out_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    worked_minutes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default=ATTENDANCE_OPEN)
    notes: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )

    employee = relationship("Employee")


class AttendanceDevice(Base):
    """Dispositivo autorizado para producir eventos de asistencia."""

    __tablename__ = "attendance_devices"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    device_code: Mapped[str] = mapped_column(String(64), unique=True, nullable=False, index=True)
    credential_hash: Mapped[str | None] = mapped_column(String(255), nullable=True)
    pairing_code_hash: Mapped[str | None] = mapped_column(String(255), nullable=True)
    pairing_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    token_version: Mapped[int] = mapped_column(Integer, nullable=False, default=1, server_default="1")
    active: Mapped[bool] = mapped_column(nullable=False, default=True, server_default="true")
    last_sync_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )


class AttendanceEvent(Base):
    """Evento inmutable e idempotente; las sesiones son la proyección operativa."""

    __tablename__ = "attendance_events"
    __table_args__ = (
        UniqueConstraint("device_id", "external_event_id", name="uq_attendance_event_device_external"),
        CheckConstraint("event_type IN ('CHECK_IN', 'CHECK_OUT')", name="ck_attendance_event_type"),
        CheckConstraint("source IN ('WEB', 'BIOMETRIC', 'ADMIN')", name="ck_attendance_event_source"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    employee_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("employees.id"), nullable=False, index=True)
    device_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("attendance_devices.id"), nullable=True, index=True)
    attendance_record_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("attendance_records.id"), nullable=True, index=True
    )
    external_event_id: Mapped[str] = mapped_column(String(100), nullable=False)
    event_type: Mapped[str] = mapped_column(String(20), nullable=False)
    source: Mapped[str] = mapped_column(String(20), nullable=False, default="WEB", server_default="WEB")
    captured_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    received_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())

    employee = relationship("Employee")
    device = relationship("AttendanceDevice")
    attendance_record = relationship("AttendanceRecord")


class AttendanceConsumedNonce(Base):
    """Nonce de marcación consumido (un uso; reintento idempotente)."""

    __tablename__ = "attendance_consumed_nonces"

    nonce: Mapped[str] = mapped_column(String(64), primary_key=True)
    action: Mapped[str] = mapped_column(String(20), nullable=False)
    event_type: Mapped[str] = mapped_column(String(20), nullable=False, default="CHECK_IN", server_default="CHECK_IN")
    employee_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("employees.id"), nullable=False, index=True)
    device_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("attendance_devices.id"), nullable=True, index=True)
    attendance_record_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("attendance_records.id"), nullable=True, index=True
    )
    result_payload: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


class AttendanceEvidence(Base):
    """Foto de marcación (objeto privado S3/R2; no es reconocimiento facial)."""

    __tablename__ = "attendance_evidence"
    __table_args__ = (
        CheckConstraint(
            "("
            "storage_backend = 'DATABASE' AND image_bytes IS NOT NULL AND object_key IS NULL"
            ") OR ("
            "storage_backend = 'S3' AND object_key IS NOT NULL AND storage_bucket IS NOT NULL "
            "AND image_sha256 IS NOT NULL AND byte_size IS NOT NULL AND image_bytes IS NULL"
            ") OR ("
            "storage_backend IS NULL"
            ")",
            name="ck_attendance_evidence_location",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    nonce: Mapped[str] = mapped_column(String(64), unique=True, nullable=False, index=True)
    employee_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("employees.id"), nullable=False, index=True)
    attendance_record_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("attendance_records.id"), nullable=True, index=True
    )
    device_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("attendance_devices.id"), nullable=True, index=True)
    content_type: Mapped[str] = mapped_column(String(40), nullable=False)
    image_bytes: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)
    object_key: Mapped[str | None] = mapped_column(String(512), nullable=True)
    storage_backend: Mapped[str | None] = mapped_column(String(16), nullable=True)
    storage_bucket: Mapped[str | None] = mapped_column(String(255), nullable=True)
    byte_size: Mapped[int | None] = mapped_column(Integer, nullable=True)
    image_sha256: Mapped[str | None] = mapped_column(String(64), nullable=True)
    captured_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    exception_reason: Mapped[str | None] = mapped_column(String(500), nullable=True)


class AttendanceAttemptResolution(Base):
    """Invalidación o revisión durable de un intento de kiosco (un nonce)."""

    __tablename__ = "attendance_attempt_resolutions"
    __table_args__ = (
        CheckConstraint("action IN ('CHECK_IN', 'CHECK_OUT')", name="ck_attempt_resolution_action"),
        CheckConstraint(
            "resolution IN ('CANCELLED_UNCONFIRMED', 'REVIEWED_CONFIRMED')",
            name="ck_attempt_resolution_kind",
        ),
        CheckConstraint(
            "(resolution <> 'CANCELLED_UNCONFIRMED') OR (attendance_record_id IS NULL)",
            name="ck_attempt_resolution_cancelled_without_record",
        ),
        CheckConstraint(
            "(resolution <> 'REVIEWED_CONFIRMED') OR (resolved_by_user_id IS NOT NULL AND attendance_record_id IS NOT NULL)",
            name="ck_attempt_resolution_reviewed_has_actor_and_record",
        ),
    )

    nonce: Mapped[str] = mapped_column(String(64), primary_key=True)
    employee_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("employees.id"), nullable=False, index=True)
    device_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("attendance_devices.id"), nullable=False, index=True)
    action: Mapped[str] = mapped_column(String(20), nullable=False)
    resolution: Mapped[str] = mapped_column(String(32), nullable=False)
    reason: Mapped[str] = mapped_column(String(500), nullable=False)
    resolved_by_user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"), nullable=True, index=True)
    attendance_record_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("attendance_records.id"), nullable=True, index=True
    )
    resolved_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
