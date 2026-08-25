"""Configuración central del backend (variables de entorno)."""

from functools import lru_cache

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
    secret_key: str = "change-me"  # Requerido en producción (firma de sesiones/JWT).
    frontend_url: str = "http://localhost:3000"  # Origen permitido en CORS (producción).
    timezone: str = "America/Lima"  # Zona horaria oficial del negocio.


@lru_cache
def get_settings() -> Settings:
    """Instancia única de configuración (cacheada por proceso)."""
    return Settings()
