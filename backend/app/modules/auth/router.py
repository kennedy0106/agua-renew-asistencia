"""Rutas de autenticación: /api/v1/auth/*

Sesión = JWT firmado en cookie HttpOnly + SameSite=Lax (Secure en
producción). El frontend nunca toca el token (nada de localStorage).
"""

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.permissions import get_current_user
from app.core.security import create_access_token, session_cookie_kwargs
from app.db.session import get_db
from app.modules.auth.schemas import LoginRequest, LogoutResponse, UserOut
from app.modules.auth.service import AuthService
from app.modules.users.models import User
from app.modules.users.schemas import ChangePasswordRequest
from app.modules.users.service import UserAdminService

router = APIRouter(prefix="/api/v1/auth", tags=["auth"])


def _to_user_out(user: User) -> UserOut:
    return UserOut(
        id=user.id,
        username=user.username,
        role=user.system_role.name,
        active=user.active,
        last_login_at=user.last_login_at,
        created_at=user.created_at,
    )


@router.post("/login", response_model=UserOut)
def login(payload: LoginRequest, response: Response, db: Session = Depends(get_db)) -> UserOut:
    user = AuthService(db).authenticate(payload.username, payload.password)
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Usuario o contraseña incorrectos",
        )
    token = create_access_token(user.username, user.system_role.name)
    response.set_cookie(value=token, **session_cookie_kwargs())
    return _to_user_out(user)


@router.post("/logout", response_model=LogoutResponse)
def logout(response: Response) -> LogoutResponse:
    response.delete_cookie(get_settings().session_cookie_name, path="/")
    return LogoutResponse()


@router.get("/me", response_model=UserOut)
def me(user: User = Depends(get_current_user)) -> UserOut:
    return _to_user_out(user)


@router.post("/change-password", status_code=status.HTTP_204_NO_CONTENT)
def change_own_password(
    payload: ChangePasswordRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> None:
    """Cambia la propia contraseña (exige verificar la actual)."""
    UserAdminService(db).change_own_password(
        user,
        current_password=payload.current_password,
        new_password=payload.new_password,
    )
