"""Guardas para bases de prueba destructivas (R12)."""

from urllib.parse import urlparse

from sqlalchemy.engine.url import make_url

_ALLOWED_HOSTS = {"localhost", "127.0.0.1", "::1"}
_ALLOWED_DBS = {"asistencia_test"}
_REDIRECT_QUERY_KEYS = {"host", "hostaddr", "port", "dbname", "service"}


def normalize_postgres_url(url: str) -> str:
    """Normaliza el dialecto psycopg sin importar el motor de la aplicación."""
    if url.startswith("postgres://"):
        return "postgresql+psycopg://" + url[len("postgres://") :]
    if url.startswith("postgresql://"):
        return "postgresql+psycopg://" + url[len("postgresql://") :]
    return url


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


def validated_test_url(url: str) -> str:
    """Valida TEST_DATABASE_URL y rechaza parámetros que redirijan el destino."""
    if not url or not url.strip():
        raise ValueError("TEST_DATABASE_URL vacío")
    raw = url.strip()
    parsed = make_url(raw)
    query_keys = {str(key).lower() for key in parsed.query}
    redirected = sorted(query_keys & _REDIRECT_QUERY_KEYS)
    if redirected:
        raise ValueError(f"Opción de conexión no permitida: {', '.join(redirected)}")
    assert_disposable_postgres_url(raw)
    return raw


def require_explicit_test_authorization() -> None:
    import os

    if os.environ.get("ALLOW_TEST_DB_RESET") != "1":
        raise ValueError("ALLOW_TEST_DB_RESET=1 es obligatorio")
