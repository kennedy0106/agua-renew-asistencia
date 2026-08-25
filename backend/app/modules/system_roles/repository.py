"""Repositorio de roles del sistema."""

import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.modules.system_roles.models import SystemRole


class SystemRoleRepository:
    def __init__(self, db: Session) -> None:
        self.db = db

    def get_by_id(self, role_id: uuid.UUID) -> SystemRole | None:
        return self.db.get(SystemRole, role_id)

    def get_by_name(self, name: str) -> SystemRole | None:
        return self.db.scalar(select(SystemRole).where(SystemRole.name == name))

    def list_all(self) -> list[SystemRole]:
        return list(self.db.scalars(select(SystemRole).order_by(SystemRole.name)))

    def create(self, *, name: str, description: str | None = None) -> SystemRole:
        role = SystemRole(name=name, description=description)
        self.db.add(role)
        self.db.commit()
        self.db.refresh(role)
        return role
