"""Bitácora de auditoría: toda corrección sensible queda registrada.

- old_values / new_values en JSONB (PG) / JSON (SQLite en tests).
- reason es obligatorio para corregir.
- performed_by: usuario del sistema que hizo el cambio (nullable).
"""

import uuid
from datetime import datetime

from sqlalchemy import JSON, DateTime, ForeignKey, String, Uuid, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base


class AuditLog(Base):
    __tablename__ = "audit_logs"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    entity_type: Mapped[str] = mapped_column(String(50), nullable=False, index=True)
    entity_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False, index=True)
    action: Mapped[str] = mapped_column(String(50), nullable=False)
    old_values: Mapped[dict] = mapped_column(JSON().with_variant(JSONB(), "postgresql"), nullable=True)
    new_values: Mapped[dict] = mapped_column(JSON().with_variant(JSONB(), "postgresql"), nullable=True)
    reason: Mapped[str] = mapped_column(String(500), nullable=False)
    performed_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id"), nullable=True, index=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    performed_by_user = relationship("User", foreign_keys=[performed_by])
