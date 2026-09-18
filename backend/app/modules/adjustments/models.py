"""Ajustes de horas: permisos, recuperación y otros (Fase 9).

Reglas:
- Nada automático: el JEFE clasifica y aprueba; un saldo negativo NUNCA se
  descuenta solo del sueldo.
- minutes puede ser negativo (ej. -120) o positivo (ej. +200 de
  recuperación); el signo lo decide quien registra.
- status: PENDING → APPROVED/REJECTED (solo ADMIN/BOSS aprueban).
- Aprobar/rechazar genera auditoría.
"""

import uuid
from datetime import date, datetime

from sqlalchemy import Date, DateTime, ForeignKey, Integer, JSON, String, Uuid, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base

ADJUSTMENT_TYPES = ("PERMISO", "RECUPERACION", "OTRO", "OVERTIME")
ADJUSTMENT_PENDING = "PENDING"
ADJUSTMENT_APPROVED = "APPROVED"
ADJUSTMENT_REJECTED = "REJECTED"


class HourAdjustment(Base):
    __tablename__ = "hour_adjustments"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    employee_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("employees.id"), nullable=False, index=True
    )
    adjustment_date: Mapped[date] = mapped_column(Date, nullable=False, index=True)
    minutes: Mapped[int] = mapped_column(Integer, nullable=False)  # ± minutos
    adjustment_type: Mapped[str] = mapped_column(String(20), nullable=False)
    reason: Mapped[str] = mapped_column(String(500), nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default=ADJUSTMENT_PENDING)
    approved_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id"), nullable=True, index=True
    )
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # Los ajustes antiguos ahora siguen la misma regla de correcciones que HST:
    # una corrección preserva el original y la anulación lo excluye de cálculo.
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1, server_default="1")
    supersedes_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("hour_adjustments.id"), index=True)
    voided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)
    voided_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"), index=True)
    void_reason: Mapped[str | None] = mapped_column(String(500))
    # The approved valuation is immutable.  Legacy rows may be null; rows
    # approved through the versioned/bulk contracts always persist it.
    approval_snapshot_data: Mapped[dict | None] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )

    employee = relationship("Employee")
    approved_by_user = relationship("User", foreign_keys=[approved_by])


class AdjustmentOperationReceipt(Base):
    """Recibo idempotente y acotado a mutaciones de ajustes legacy."""

    __tablename__ = "adjustment_operation_receipts"

    idempotency_key: Mapped[str] = mapped_column(String(128), primary_key=True)
    payload_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    result: Mapped[dict] = mapped_column(JSON, nullable=False)
    actor_user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), nullable=False, index=True)
    operation_type: Mapped[str] = mapped_column(String(16), nullable=False)
    target_adjustment_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("hour_adjustments.id"), nullable=False, index=True)
    http_status: Mapped[int] = mapped_column(Integer, nullable=False, default=200)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
