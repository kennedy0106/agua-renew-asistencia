"""Seguridad: hashing de contraseñas (Argon2) y tokens JWT.

Reglas del MVP:
- Nunca MD5/SHA1/SHA256 directo para contraseñas: se usa Argon2.
- El token JWT viaja en cookie HttpOnly (nunca en localStorage).
"""

from datetime import datetime, timedelta, timezone
from typing import Any

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerifyMismatchError

from app.core.config import get_settings

_hasher = PasswordHasher()


def hash_password(password: str) -> str:
    """Hash Argon2id de una contraseña."""
    return _hasher.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    """Verifica una contraseña contra su hash Argon2.

    Devuelve False ante cualquier fallo (incluido hash inválido) para no
    filtrar información sobre el formato almacenado.
    """
    try:
        return _hasher.verify(password_hash, password)
    except (VerifyMismatchError, InvalidHashError):
        return False


def create_access_token(subject: str, role: str, extra: dict[str, Any] | None = None) -> str:
    """Crea un JWT firmado para el usuario."""
    settings = get_settings()
    now = datetime.now(timezone.utc)
    payload: dict[str, Any] = {
        "sub": subject,  # username (estable; el id puede cambiar de tipo en el ERP)
        "role": role,
        "iat": now,
        "exp": now + timedelta(minutes=settings.jwt_expire_minutes),
    }
    if extra:
        payload.update(extra)
    return jwt.encode(payload, settings.secret_key, algorithm=settings.jwt_algorithm)


def decode_access_token(token: str) -> dict[str, Any] | None:
    """Decodifica y valida un JWT. None si es inválido o expiró."""
    settings = get_settings()
    try:
        return jwt.decode(token, settings.secret_key, algorithms=[settings.jwt_algorithm])
    except jwt.PyJWTError:
        return None


def create_attendance_token(employee_id: str, *, action: str, minutes: int = 2) -> str:
    """Prueba efímera ligada a una acción (CHECK_IN o CHECK_OUT) y un nonce de un uso."""
    settings = get_settings()
    now = datetime.now(timezone.utc)
    return jwt.encode(
        {
            "sub": employee_id,
            "type": "attendance",
            "action": action,
            "nonce": __import__("secrets").token_urlsafe(16),
            "iat": now,
            "exp": now + timedelta(minutes=minutes),
        },
        settings.secret_key,
        algorithm=settings.jwt_algorithm,
    )


def decode_attendance_token(token: str) -> dict[str, Any] | None:
    payload = decode_access_token(token)
    if payload is None or payload.get("type") != "attendance":
        return None
    if not payload.get("sub") or not payload.get("nonce") or payload.get("action") not in {"CHECK_IN", "CHECK_OUT"}:
        return None
    return payload


def session_cookie_kwargs() -> dict[str, Any]:
    """Opciones de la cookie de sesión (HttpOnly + SameSite + Secure en prod)."""
    settings = get_settings()
    return {
        "key": settings.session_cookie_name,
        "httponly": True,
        "samesite": settings.session_cookie_samesite,
        "secure": settings.session_cookie_secure,
        "path": "/",
    }
