"""Utilidades de zona horaria.

Regla del MVP: las marcas se guardan como timestamps con zona horaria
(UTC en BD) y se convierten a America/Lima para presentación y reglas
locales. La hora del servidor manda; nunca la del navegador.
"""

from datetime import datetime
from zoneinfo import ZoneInfo

from app.core.config import get_settings


def lima_now() -> datetime:
    """Momento actual como datetime aware en America/Lima."""
    return datetime.now(ZoneInfo(get_settings().timezone))


def lima_tz() -> ZoneInfo:
    """Zona horaria configurada (America/Lima por defecto)."""
    return ZoneInfo(get_settings().timezone)
