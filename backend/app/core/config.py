"""Configuración central del backend (variables de entorno)."""

import os
from functools import lru_cache

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Valores de entorno del MVP.

    Las variables se leen desde el entorno o desde un archivo ``.env``
    (nombres en MAYÚSCULAS: ``DATABASE_URL``, ``SECRET_KEY``, ...).
    """

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    app_name: str = "Agua ReNew — Asistencia API"
    environment: str = "development"  # development | production
    database_url: str = ""  # PostgreSQL (Neon en producción). Vacío = sin BD.
    database_url_unpooled: str = ""  # Conexión directa (sin pooler): para migraciones Alembic.
    secret_key: str = "change-me"  # Requerido en producción (firma de sesiones/JWT).
    frontend_url: str = "http://localhost:3000"  # Origen permitido en CORS (producción).
    timezone: str = "America/Lima"  # Zona horaria oficial del negocio.

    # --- Autenticación (Fase 1) ---
    jwt_expire_minutes: int = 480  # Vida de la sesión (8 h por defecto).
    jwt_algorithm: str = "HS256"
    session_cookie_name: str = "agua_renew_session"
    session_cookie_secure: bool = False  # True en producción (solo HTTPS).
    # En producción frontend (Vercel) y backend (Railway) son cross-site:
    # requerirá "none" + secure. Dev local (mismo sitio) usa "lax".
    session_cookie_samesite: str = "lax"

    @field_validator("secret_key")
    @classmethod
    def _reject_insecure_secret_in_production(cls, value: str) -> str:
        """Fail-fast: en producción nunca arrancar con la clave por defecto."""
        env = os.getenv("ENVIRONMENT", "development").lower()
        if env == "production" and value in ("change-me", "", "secret"):
            raise ValueError(
                "SECRET_KEY no puede ser el valor por defecto en producción. "
                "Configura una clave de al menos 32 caracteres."
            )
        return value


@lru_cache
def get_settings() -> Settings:
    """Instancia única de configuración (cacheada por proceso)."""
    return Settings()
