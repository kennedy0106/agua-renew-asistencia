"""Usuarios del sistema administrativo.

Un empleado (employees) NO necesita tener usuario; un usuario es alguien
autorizado a entrar al panel (ADMIN/BOSS/SUPERVISOR). La relación con
employees se agrega en la Fase 3 (empleados); por eso employee_id no tiene
FK todavía.
"""

import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, String, Uuid, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base


class User(Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    username: Mapped[str] = mapped_column(String(50), unique=True, nullable=False, index=True)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    employee_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True)  # FK a employees en Fase 3
    system_role_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("system_roles.id"), nullable=False, index=True
    )
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )

    system_role = relationship("SystemRole", back_populates="users")
