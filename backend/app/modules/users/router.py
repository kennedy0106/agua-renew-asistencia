"""Rutas de administración de usuarios: /api/v1/users — SOLO ADMIN."""

import uuid

from fastapi import APIRouter, Depends, status
from sqlalchemy.orm import Session

from app.core.permissions import require_admin
from app.db.session import get_db
from app.modules.users.schemas import (
    AdminUserOut,
    ResetPasswordRequest,
    UserCreate,
    UserUpdate,
)
from app.modules.users.service import UserAdminService
from app.modules.users.models import User

router = APIRouter(prefix="/api/v1/users", tags=["users"])


def _out(user: User) -> AdminUserOut:
    return AdminUserOut(
        id=user.id,
        username=user.username,
        system_role_id=user.system_role_id,
        role=user.system_role.name if user.system_role else None,
        employee_id=user.employee_id,
        employee_name=(
            f"{user.employee.first_name} {user.employee.last_name}" if user.employee else None
        ),
        active=user.active,
        last_login_at=user.last_login_at,
        created_at=user.created_at,
    )


@router.get("", response_model=list[AdminUserOut])
def list_users(
    db: Session = Depends(get_db),
    _: object = Depends(require_admin),
) -> list[AdminUserOut]:
    return [_out(u) for u in UserAdminService(db).list_users()]


@router.post("", response_model=AdminUserOut, status_code=status.HTTP_201_CREATED)
def create_user(
    payload: UserCreate,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
) -> AdminUserOut:
    user = UserAdminService(db).create(
        username=payload.username,
        password=payload.password,
        system_role_id=payload.system_role_id,
        employee_id=payload.employee_id,
        current_user_id=admin.id,
    )
    return _out(user)


@router.patch("/{user_id}", response_model=AdminUserOut)
def update_user(
    user_id: uuid.UUID,
    payload: UserUpdate,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
) -> AdminUserOut:
    user = UserAdminService(db).update(
        user_id,
        system_role_id=payload.system_role_id,
        active=payload.active,
        employee_id=payload.employee_id,
        current_user_id=admin.id,
    )
    return _out(user)


@router.post("/{user_id}/reset-password", response_model=AdminUserOut)
def reset_password(
    user_id: uuid.UUID,
    payload: ResetPasswordRequest,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
) -> AdminUserOut:
    user = UserAdminService(db).reset_password(
        user_id, new_password=payload.new_password, current_user_id=admin.id
    )
    return _out(user)
