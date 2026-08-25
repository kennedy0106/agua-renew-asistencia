"""Jornadas laborales por empleado.

Reglas:
- Los días se guardan en MINUTOS (nunca decimales tipo 7.5 h).
- Vigencia histórica: cambiar una jornada NUNCA sobrescribe la anterior;
  se cierra la vigente (effective_to) y se crea una nueva (effective_from).
- ``expected_minutes(employee, date)`` es la fuente para comparar con lo
  trabajado (Fase 6+).
"""

import uuid
from datetime import date, datetime

from sqlalchemy import CheckConstraint, Date, DateTime, ForeignKey, Integer, Uuid, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base

_MAX_DAY_MINUTES = 1440  # 24 h


class WorkSchedule(Base):
    __tablename__ = "work_schedules"
    __table_args__ = (
        CheckConstraint(
            "monday_minutes >= 0 AND tuesday_minutes >= 0 AND wednesday_minutes >= 0 "
            "AND thursday_minutes >= 0 AND friday_minutes >= 0 AND saturday_minutes >= 0 "
            "AND sunday_minutes >= 0 AND break_minutes >= 0",
            name="ck_work_schedule_minutes_non_negative",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    employee_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("employees.id"), nullable=False, index=True
    )
    monday_minutes: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    tuesday_minutes: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    wednesday_minutes: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    thursday_minutes: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    friday_minutes: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    saturday_minutes: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    sunday_minutes: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    break_minutes: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    effective_from: Mapped[date] = mapped_column(Date, nullable=False)
    effective_to: Mapped[date | None] = mapped_column(Date, nullable=True)  # NULL = vigente
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )

    employee = relationship("Employee")
