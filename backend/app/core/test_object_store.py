"""Guardas para almacenes S3 de prueba. No admite R2 ni hosts reales."""

from __future__ import annotations

import os
from collections.abc import Mapping
from urllib.parse import urlparse

_ALLOWED_HOSTS = {"localhost", "127.0.0.1", "::1"}
_ALLOWED_BUCKETS = {"asistencia-evidence", "asistencia-evidence-test"}
_ALLOWED_SCHEMES = {"http", "https"}
_BLOCKED_HOST_MARKERS = (
    "r2.cloudflarestorage.com",
    "amazonaws.com",
    "backblazeb2.com",
    "wasabisys.com",
)
_REDIRECT_QUERY_KEYS = {"host", "hostaddr", "port", "dbname", "service"}


def require_live_object_store_authorization(env: Mapping[str, str] | None = None) -> None:
    source = env if env is not None else os.environ
    if source.get("ALLOW_TEST_DB_RESET") != "1" and source.get("ALLOW_TEST_OBJECT_STORE") != "1":
        raise ValueError(
            "ALLOW_TEST_OBJECT_STORE=1 o ALLOW_TEST_DB_RESET=1 es obligatorio para S3 de prueba"
        )


def validated_test_object_store_endpoint(url: str) -> str:
    if not url or not url.strip():
        raise ValueError("OBJECT_STORE_ENDPOINT vacío")
    raw = url.strip()
    parsed = urlparse(raw)
    scheme = (parsed.scheme or "").lower()
    if scheme not in _ALLOWED_SCHEMES:
        raise ValueError("OBJECT_STORE_ENDPOINT debe usar http o https")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError("OBJECT_STORE_ENDPOINT no admite usuario embebido")
    if parsed.fragment:
        raise ValueError("OBJECT_STORE_ENDPOINT no admite fragmento")
    query_keys = {part.split("=", 1)[0].lower() for part in parsed.query.split("&") if part}
    redirected = sorted(query_keys & _REDIRECT_QUERY_KEYS)
    if redirected:
        raise ValueError(f"Opción de conexión no permitida: {', '.join(redirected)}")
    host = (parsed.hostname or "").lower()
    if not host:
        raise ValueError("OBJECT_STORE_ENDPOINT sin host")
    if any(marker in host for marker in _BLOCKED_HOST_MARKERS):
        raise ValueError(f"Host de almacén no permitido para pruebas: {host}")
    if host not in _ALLOWED_HOSTS:
        raise ValueError(f"Host de almacén no permitido para pruebas: {host}")
    if parsed.port is None:
        raise ValueError("OBJECT_STORE_ENDPOINT debe declarar un puerto explícito")
    return raw.rstrip("/")


def validated_test_bucket(name: str) -> str:
    bucket = (name or "").strip()
    if bucket not in _ALLOWED_BUCKETS:
        raise ValueError(f"Bucket de prueba no permitido: {bucket or '(vacío)'}")
    return bucket
