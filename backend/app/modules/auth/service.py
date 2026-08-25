"""Servicio de autenticación: validar credenciales y emitir sesión."""

from sqlalchemy.orm import Session

from app.core.security import verify_password
from app.modules.users.models import User
from app.modules.users.repository import UserRepository


class AuthService:
    def __init__(self, db: Session) -> None:
        self.db = db
        self.users = UserRepository(db)

    def authenticate(self, username: str, password: str) -> User | None:
        """Valida credenciales. None si usuario no existe, inactivo o clave mala.

        Se devuelve el mismo resultado en los tres casos para no revelar
        qué dato fue incorrecto.
        """
        user = self.users.get_by_username(username)
        if user is None or not user.active:
            return None
        if not verify_password(password, user.password_hash):
            return None
        self.users.set_last_login(user)
        return user
