"""Schemas de auditoría."""

import uuid
from datetime import datetime

from pydantic import BaseModel


class AuditLogOut(BaseModel):
    id: uuid.UUID
    entity_type: str
    entity_id: uuid.UUID
    action: str
    reason: str
    old_values: dict | None
    new_values: dict | None
    performed_by: uuid.UUID | None
    performed_by_username: str | None
    created_at: datetime
