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

from sqlalchemy import Date, DateTime, ForeignKey, Integer, String, Uuid, func
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
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )

    employee = relationship("Employee")
    approved_by_user = relationship("User", foreign_keys=[approved_by])
