"""Repositorio de cargos laborales."""

import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.modules.job_roles.models import JobRole


class JobRoleRepository:
    def __init__(self, db: Session) -> None:
        self.db = db

    def get_by_id(self, role_id: uuid.UUID) -> JobRole | None:
        return self.db.get(JobRole, role_id)

    def get_active_by_name(self, name: str, exclude_id: uuid.UUID | None = None) -> JobRole | None:
        query = select(JobRole).where(JobRole.name == name, JobRole.active.is_(True))
        if exclude_id is not None:
            query = query.where(JobRole.id != exclude_id)
        return self.db.scalar(query)

    def list_all(self) -> list[JobRole]:
        return list(
            self.db.scalars(
                select(JobRole).order_by(JobRole.active.desc(), JobRole.name.asc())
            )
        )

    def create(self, *, name: str, description: str | None = None) -> JobRole:
        role = JobRole(name=name, description=description)
        self.db.add(role)
        self.db.commit()
        self.db.refresh(role)
        return role

    def update(self, role: JobRole, *, name: str | None = None, description: str | None = None, active: bool | None = None) -> JobRole:
        if name is not None:
            role.name = name
        if description is not None:
            role.description = description
        if active is not None:
            role.active = active
        self.db.add(role)
        self.db.commit()
        self.db.refresh(role)
        return role
