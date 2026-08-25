"""Repositorio de la bitácora de auditoría."""

import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session, joinedload

from app.modules.audit.models import AuditLog


class AuditRepository:
    def __init__(self, db: Session) -> None:
        self.db = db

    def create(
        self,
        *,
        entity_type: str,
        entity_id: uuid.UUID,
        action: str,
        old_values: dict | None,
        new_values: dict | None,
        reason: str,
        performed_by: uuid.UUID | None,
    ) -> AuditLog:
        log = AuditLog(
            entity_type=entity_type,
            entity_id=entity_id,
            action=action,
            old_values=old_values,
            new_values=new_values,
            reason=reason,
            performed_by=performed_by,
        )
        self.db.add(log)
        self.db.commit()
        self.db.refresh(log)
        return log

    def list_logs(
        self,
        *,
        entity_type: str | None = None,
        entity_id: uuid.UUID | None = None,
        limit: int = 100,
    ) -> list[AuditLog]:
        query = select(AuditLog).options(joinedload(AuditLog.performed_by_user))
        if entity_type is not None:
            query = query.where(AuditLog.entity_type == entity_type)
        if entity_id is not None:
            query = query.where(AuditLog.entity_id == entity_id)
        query = query.order_by(AuditLog.created_at.desc()).limit(limit)
        return list(self.db.scalars(query))
