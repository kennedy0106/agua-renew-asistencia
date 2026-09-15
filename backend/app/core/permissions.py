"""Permisos: dependencias FastAPI de autenticación y roles.

Todo acceso administrativo pasa por aquí. Los roles se verifican en el
backend, nunca solo en la UI.
"""

from collections.abc import Callable

from fastapi import Depends, HTTPException, status
from fastapi.requests import Request
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.security import decode_access_token
from app.db.session import get_db
from app.modules.users.models import User
from app.modules.users.repository import UserRepository


def get_current_user(request: Request, db: Session = Depends(get_db)) -> User:
    """Resuelve el usuario autenticado desde la cookie de sesión."""
    settings = get_settings()
    token = request.cookies.get(settings.session_cookie_name)
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="No autenticado")

    payload = decode_access_token(token)
    if payload is None or "sub" not in payload:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Sesión inválida o expirada")

    user = UserRepository(db).get_by_username(payload["sub"])
    if user is None or not user.active:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Usuario no válido")
    return user


def get_current_operational_user(user: User = Depends(get_current_user)) -> User:
    """Usuario autenticado y habilitado para operar el panel.

    Un usuario con clave temporal mantiene una sesión válida únicamente para
    consultar su identidad, cerrar sesión y establecer su contraseña. El
    bloqueo queda en el servidor, por lo que no depende de la redirección UI.
    """
    if user.must_change_password:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Debes cambiar tu contraseña temporal antes de continuar",
        )
    return user


def require_any_role(*roles: str) -> Callable:
    """Fabrica una dependencia que exige que el usuario tenga uno de los roles dados.

    Ejemplo: ``require_any_role("ADMIN", "BOSS")``
    """

    def _dependency(user: User = Depends(get_current_operational_user)) -> User:
        if user.system_role.name not in roles:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Se requiere rol: {', '.join(roles)}",
            )
        return user

    return _dependency


require_admin = require_any_role("ADMIN")
require_boss = require_any_role("BOSS")
require_admin_or_boss = require_any_role("ADMIN", "BOSS")
