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


def create_attendance_token(
    employee_id: str,
    *,
    action: str,
    minutes: int = 2,
    record_id: str | None = None,
    device_id: str | None = None,
) -> str:
    """Prueba efímera ligada a una acción, nonce de un uso y, si aplica, sesión/terminal."""
    settings = get_settings()
    now = datetime.now(timezone.utc)
    payload: dict[str, Any] = {
        "sub": employee_id,
        "type": "attendance",
        "action": action,
        "nonce": __import__("secrets").token_urlsafe(16),
        "iat": now,
        "exp": now + timedelta(minutes=minutes),
    }
    if record_id:
        payload["rid"] = record_id
    if device_id:
        payload["did"] = device_id
    return jwt.encode(payload, settings.secret_key, algorithm=settings.jwt_algorithm)


def create_terminal_token(device_id: str, token_version: int, *, days: int | None = None) -> str:
    settings = get_settings()
    now = datetime.now(timezone.utc)
    lifetime = days if days is not None else settings.terminal_token_days
    return jwt.encode(
        {
            "sub": device_id,
            "type": "terminal",
            "ver": token_version,
            "iat": now,
            "exp": now + timedelta(days=lifetime),
        },
        settings.secret_key,
        algorithm=settings.jwt_algorithm,
    )


def decode_terminal_token(token: str) -> dict[str, Any] | None:
    payload = decode_access_token(token)
    if payload is None or payload.get("type") != "terminal" or not payload.get("sub"):
        return None
    return payload


def terminal_cookie_kwargs() -> dict[str, Any]:
    settings = get_settings()
    return {
        "key": "agua_renew_terminal",
        "httponly": True,
        "samesite": settings.session_cookie_samesite,
        "secure": settings.session_cookie_secure,
        "path": "/",
        "max_age": settings.terminal_token_days * 24 * 60 * 60,
    }


def decode_attendance_token(token: str) -> dict[str, Any] | None:
    payload = decode_access_token(token)
    if payload is None or payload.get("type") != "attendance":
        return None
    if not payload.get("sub") or not payload.get("nonce") or payload.get("action") not in {"CHECK_IN", "CHECK_OUT"}:
        return None
    return payload


def decode_attendance_token_for_recovery(token: str) -> dict[str, Any] | None:
    """Valida firma y tipo de un token de marcación ignorando solo ``exp``.

    No sustituye a ``decode_attendance_token``: las escrituras siguen
    rechazando el permiso corto vencido.
    """
    settings = get_settings()
    try:
        payload = jwt.decode(
            token,
            settings.secret_key,
            algorithms=[settings.jwt_algorithm],
            options={"verify_exp": False},
        )
    except jwt.PyJWTError:
        return None
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
