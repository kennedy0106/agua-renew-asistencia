"""Entorno hijo de verificación local. No muta el entorno padre."""

from __future__ import annotations

from collections.abc import Mapping

from app.core.test_db import require_explicit_test_authorization, validated_test_url
from app.core.test_object_store import (
    require_live_object_store_authorization,
    validated_test_bucket,
    validated_test_object_store_endpoint,
)

_REQUIRED_STORE = (
    "OBJECT_STORE_ENDPOINT",
    "OBJECT_STORE_ACCESS_KEY",
    "OBJECT_STORE_SECRET_KEY",
    "OBJECT_STORE_BUCKET",
)


def prepare_child_env(source: Mapping[str, str], *, object_prefix: str) -> dict[str, str]:
    """Valida destinos desechables y fuerza las URLs de prueba en una copia.

    No conecta a bases ni almacenes. No modifica ``source``.
    """
    env = {str(key): str(value) for key, value in source.items()}
    require_explicit_test_authorization(env)
    require_live_object_store_authorization(env)
    safe_url = validated_test_url((env.get("TEST_DATABASE_URL") or "").strip())
    env["TEST_DATABASE_URL"] = safe_url
    env["DATABASE_URL"] = safe_url
    env["DATABASE_URL_UNPOOLED"] = safe_url
    missing = [name for name in _REQUIRED_STORE if not (env.get(name) or "").strip()]
    if missing:
        raise ValueError(f"Falta {', '.join(missing)}. La verificación local no omite destinos de prueba.")
    env["OBJECT_STORE_ENDPOINT"] = validated_test_object_store_endpoint(env["OBJECT_STORE_ENDPOINT"])
    env["OBJECT_STORE_BUCKET"] = validated_test_bucket(env["OBJECT_STORE_BUCKET"])
    env["OBJECT_STORE_ACCESS_KEY"] = env["OBJECT_STORE_ACCESS_KEY"].strip()
    env["OBJECT_STORE_SECRET_KEY"] = env["OBJECT_STORE_SECRET_KEY"].strip()
    env["OBJECT_STORE_REGION"] = (env.get("OBJECT_STORE_REGION") or "us-east-1").strip() or "us-east-1"
    env["VERIFY_LOCAL"] = "1"
    env["VERIFY_OBJECT_PREFIX"] = object_prefix
    env["SECRET_KEY"] = env.get("SECRET_KEY") or "e2e-asistencia-secret-key-32chars!!"
    env["ENVIRONMENT"] = "development"
    env["E2E_INTEGRATION"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUTF8"] = "1"
    return env
