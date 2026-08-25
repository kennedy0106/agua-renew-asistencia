"""Servicio de cargos laborales: reglas de negocio.

- El nombre es obligatorio.
- No pueden existir DOS cargos ACTIVOS con el mismo nombre (un cargo
  desactivado sí puede volver a usarse).
- Los cargos con historial no se borran: se desactivan.
"""

import uuid

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.modules.job_roles.models import JobRole
from app.modules.job_roles.repository import JobRoleRepository


class JobRoleService:
    def __init__(self, db: Session) -> None:
        self.db = db
        self.repo = JobRoleRepository(db)

    def list_all(self) -> list[JobRole]:
        return self.repo.list_all()

    def create(self, *, name: str, description: str | None = None) -> JobRole:
        name = name.strip()
        if not name:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="El nombre del cargo es obligatorio",
            )
        if self.repo.get_active_by_name(name) is not None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"Ya existe un cargo activo llamado '{name}'",
            )
        return self.repo.create(name=name, description=description)

    def update(self, role_id: uuid.UUID, *, name: str | None = None, description: str | None = None, active: bool | None = None) -> JobRole:
        role = self.repo.get_by_id(role_id)
        if role is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Cargo no encontrado")

        if name is not None:
            name = name.strip()
            if not name:
                raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="El nombre no puede quedar vacío")
            if active is not False and self.repo.get_active_by_name(name, exclude_id=role_id) is not None:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail=f"Ya existe un cargo activo llamado '{name}'",
                )

        return self.repo.update(role, name=name, description=description, active=active)
