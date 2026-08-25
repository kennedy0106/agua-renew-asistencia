"""Rutas de cargos laborales: /api/v1/job-roles

- GET: cualquier usuario autenticado (necesario para ver empleados).
- POST/PATCH: solo ADMIN (gestiona cargos laborales).
"""

import uuid

from fastapi import APIRouter, Depends, status
from sqlalchemy.orm import Session

from app.core.permissions import get_current_user, require_admin
from app.db.session import get_db
from app.modules.job_roles.schemas import JobRoleCreate, JobRoleOut, JobRoleUpdate
from app.modules.job_roles.service import JobRoleService

router = APIRouter(prefix="/api/v1/job-roles", tags=["job-roles"])


@router.get("", response_model=list[JobRoleOut])
def list_job_roles(db: Session = Depends(get_db), _: object = Depends(get_current_user)) -> list[JobRoleOut]:
    return JobRoleService(db).list_all()


@router.post("", response_model=JobRoleOut, status_code=status.HTTP_201_CREATED)
def create_job_role(payload: JobRoleCreate, db: Session = Depends(get_db), _: object = Depends(require_admin)) -> JobRoleOut:
    return JobRoleService(db).create(name=payload.name, description=payload.description)


@router.patch("/{role_id}", response_model=JobRoleOut)
def update_job_role(role_id: uuid.UUID, payload: JobRoleUpdate, db: Session = Depends(get_db), _: object = Depends(require_admin)) -> JobRoleOut:
    return JobRoleService(db).update(
        role_id, name=payload.name, description=payload.description, active=payload.active
    )
