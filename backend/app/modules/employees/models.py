"""Empleados: entidad central del MVP (la reutilizará el ERP futuro).

Reglas:
- DNI único (8 dígitos, Perú) y código interno único.
- Un empleado cesado NO se elimina: se marca INACTIVO y su historial se conserva.
- Un empleado NO necesita usuario del sistema; un usuario puede vincularse a
  un empleado (users.employee_id → employees.id).
"""

import uuid
from datetime import date, datetime

from sqlalchemy import Boolean, Date, DateTime, ForeignKey, String, Uuid, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base


class Employee(Base):
    __tablename__ = "employees"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    dni: Mapped[str] = mapped_column(String(8), unique=True, nullable=False, index=True)
    employee_code: Mapped[str] = mapped_column(String(20), unique=True, nullable=False, index=True)
    first_name: Mapped[str] = mapped_column(String(100), nullable=False)
    last_name: Mapped[str] = mapped_column(String(100), nullable=False)
    job_role_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("job_roles.id"), nullable=False, index=True
    )
    hire_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    termination_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )

    job_role = relationship("JobRole")
