"""Rutas de auditoría: /api/v1/audit-logs — SOLO ADMIN.

El SUPERVISOR y el JEFE no ven la bitácora (MVP §6: la auditoría es
responsabilidad del administrador).
"""

import uuid

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.core.permissions import require_any_role
from app.db.session import get_db
from app.modules.audit.repository import AuditRepository
from app.modules.audit.schemas import AuditLogOut

router = APIRouter(prefix="/api/v1/audit-logs", tags=["audit"])

require_admin = require_any_role("ADMIN")


@router.get("", response_model=list[AuditLogOut])
def list_audit_logs(
    entity_type: str | None = None,
    entity_id: uuid.UUID | None = None,
    limit: int = 100,
    db: Session = Depends(get_db),
    _: object = Depends(require_admin),
) -> list[AuditLogOut]:
    logs = AuditRepository(db).list_logs(entity_type=entity_type, entity_id=entity_id, limit=min(limit, 500))
    return [
        AuditLogOut(
            id=log.id,
            entity_type=log.entity_type,
            entity_id=log.entity_id,
            action=log.action,
            reason=log.reason,
            old_values=log.old_values,
            new_values=log.new_values,
            performed_by=log.performed_by,
            performed_by_username=(
                log.performed_by_user.username if log.performed_by_user else None
            ),
            created_at=log.created_at,
        )
        for log in logs
    ]
