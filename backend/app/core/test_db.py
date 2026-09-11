"""Guardas para bases de prueba destructivas (R12)."""

from urllib.parse import urlparse

_ALLOWED_HOSTS = {"localhost", "127.0.0.1", "::1"}
_ALLOWED_DBS = {"asistencia_test"}


def assert_disposable_postgres_url(url: str) -> None:
    """Rechaza cualquier URL que no sea Postgres local de la base de tests.

    No basta con que el texto 'asistencia_test' aparezca en la cadena.
    """
    if not url or not url.strip():
        raise ValueError("TEST_DATABASE_URL vacío")
    normalized = url.strip().replace("postgresql+psycopg://", "postgresql://", 1)
    parsed = urlparse(normalized)
    scheme = (parsed.scheme or "").split("+")[0].lower()
    if scheme not in {"postgres", "postgresql"}:
        raise ValueError("TEST_DATABASE_URL debe ser PostgreSQL")
    host = (parsed.hostname or "").lower()
    if host not in _ALLOWED_HOSTS:
        raise ValueError(f"Host no permitido para borrar esquema: {host or '(vacío)'}")
    database = (parsed.path or "/").lstrip("/").split("/")[0]
    if database not in _ALLOWED_DBS:
        raise ValueError(f"Base no permitida para borrar esquema: {database or '(vacía)'}")
