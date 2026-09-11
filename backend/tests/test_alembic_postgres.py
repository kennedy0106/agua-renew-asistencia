"""REG-22/F16: migraciones Alembic contra PostgreSQL desechable.

Se omite si TEST_DATABASE_URL no está definido (suite local SQLite).
En CI el workflow inyecta Postgres y corre este archivo.
"""

import os

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, inspect, text

from app.core.test_db import assert_disposable_postgres_url

pytestmark = pytest.mark.integration


@pytest.fixture()
def pg_url() -> str:
    url = os.environ.get("TEST_DATABASE_URL", "").strip()
    if not url:
        pytest.skip("TEST_DATABASE_URL no configurado")
    if os.environ.get("ALLOW_TEST_DB_RESET") != "1":
        pytest.skip("ALLOW_TEST_DB_RESET=1 es obligatorio para DROP SCHEMA")
    try:
        assert_disposable_postgres_url(url)
    except ValueError as exc:
        pytest.skip(str(exc))
    return url


def test_alembic_upgrade_head_desde_esquema_vacio(pg_url: str, monkeypatch: pytest.MonkeyPatch) -> None:
    from app.core.config import get_settings

    monkeypatch.setenv("DATABASE_URL", pg_url)
    monkeypatch.setenv("DATABASE_URL_UNPOOLED", pg_url)
    get_settings.cache_clear()

    engine = create_engine(pg_url)
    with engine.begin() as conn:
        conn.execute(text("DROP SCHEMA public CASCADE"))
        conn.execute(text("CREATE SCHEMA public"))

    cfg = Config("alembic.ini")
    command.upgrade(cfg, "head")

    inspector = inspect(engine)
    tables = set(inspector.get_table_names())
    assert "employees" in tables
    assert "attendance_records" in tables
    assert "payroll_records" in tables
    index_names = {idx["name"] for idx in inspector.get_indexes("attendance_records")}
    assert "uq_attendance_one_open_per_employee" in index_names
    columns = {col["name"] for col in inspector.get_columns("payroll_records")}
    assert "missing_salary_days" in columns
    assert "payable" in columns
    period_cols = {col["name"] for col in inspector.get_columns("payroll_periods")}
    assert "inputs_fingerprint" in period_cols
    assert "attendance_evidence" in tables
    assert "attendance_consumed_nonces" in tables
