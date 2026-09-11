"""R12: DROP SCHEMA solo sobre host y base parseados."""

import pytest

from app.core.test_db import assert_disposable_postgres_url


def test_url_local_asistencia_test_es_valida():
    assert_disposable_postgres_url("postgresql+psycopg://postgres:postgres@localhost:5432/asistencia_test")
    assert_disposable_postgres_url("postgresql://u:p@127.0.0.1:5432/asistencia_test")


def test_url_remota_o_otra_base_se_rechaza():
    with pytest.raises(ValueError):
        assert_disposable_postgres_url(
            "postgresql://user:asistencia_test@ep-prod.neon.tech/neondb?sslmode=require"
        )
    with pytest.raises(ValueError):
        assert_disposable_postgres_url("postgresql://postgres:postgres@localhost:5432/neondb")
    with pytest.raises(ValueError):
        assert_disposable_postgres_url("postgresql://postgres:postgres@db.internal:5432/asistencia_test")
