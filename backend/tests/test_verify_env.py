"""CD10-01: el orquestador no hereda destinos ajenos ni completa la autorización."""

from __future__ import annotations

import pytest

from app.core.verify_env import prepare_child_env

VALID_URL = "postgresql+psycopg://postgres:postgres@127.0.0.1:5433/asistencia_test"
OTHER_URL = "postgresql+psycopg://postgres:postgres@127.0.0.1:5432/neondb_fake"
VALID_STORE = {
    "OBJECT_STORE_ENDPOINT": "http://127.0.0.1:9002",
    "OBJECT_STORE_ACCESS_KEY": "asistencia",
    "OBJECT_STORE_SECRET_KEY": "asistencia-test-minio",
    "OBJECT_STORE_BUCKET": "asistencia-evidence",
}


def _base(**extra: str) -> dict[str, str]:
    env = {
        "ALLOW_TEST_DB_RESET": "1",
        "TEST_DATABASE_URL": VALID_URL,
        **VALID_STORE,
    }
    env.update(extra)
    return env


def test_sin_autorizacion_no_arma_entorno():
    with pytest.raises(ValueError, match="ALLOW_TEST_DB_RESET"):
        prepare_child_env(
            {
                "TEST_DATABASE_URL": VALID_URL,
                **VALID_STORE,
            },
            object_prefix="verify/x/",
        )


def test_urls_heredadas_se_reemplazan_por_la_de_prueba():
    parent = _base(DATABASE_URL=OTHER_URL, DATABASE_URL_UNPOOLED=OTHER_URL)
    child = prepare_child_env(parent, object_prefix="verify/x/")
    assert child["TEST_DATABASE_URL"] == VALID_URL
    assert child["DATABASE_URL"] == VALID_URL
    assert child["DATABASE_URL_UNPOOLED"] == VALID_URL
    assert parent["DATABASE_URL"] == OTHER_URL
    assert parent["DATABASE_URL_UNPOOLED"] == OTHER_URL


def test_endpoint_r2_se_rechaza():
    with pytest.raises(ValueError, match="no permitido"):
        prepare_child_env(
            _base(OBJECT_STORE_ENDPOINT="https://acct.r2.cloudflarestorage.com"),
            object_prefix="verify/x/",
        )


def test_endpoint_sin_puerto_se_rechaza():
    with pytest.raises(ValueError, match="puerto"):
        prepare_child_env(
            _base(OBJECT_STORE_ENDPOINT="http://127.0.0.1"),
            object_prefix="verify/x/",
        )


def test_bucket_ajeno_se_rechaza():
    with pytest.raises(ValueError, match="Bucket"):
        prepare_child_env(_base(OBJECT_STORE_BUCKET="prod-evidence"), object_prefix="verify/x/")
