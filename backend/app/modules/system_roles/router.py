"""Rutas de roles del sistema: GET /api/v1/system-roles (autenticado).

Solo lectura: los roles se siembran con scripts.seed_roles y no se crean
desde la API (la gestión de roles es configuración, no operación diaria).
"""

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.core.permissions import get_current_operational_user
from app.db.session import get_db
from app.modules.system_roles.repository import SystemRoleRepository
from app.modules.system_roles.models import SystemRole

router = APIRouter(prefix="/api/v1/system-roles", tags=["system-roles"])


@router.get("", response_model=list[dict])
def list_system_roles(db: Session = Depends(get_db), _: object = Depends(get_current_operational_user)) -> list[dict]:
    return [
        {"id": role.id, "name": role.name, "description": role.description}
        for role in SystemRoleRepository(db).list_all()
    ]
