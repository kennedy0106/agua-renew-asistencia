"""REG-22/F16: migraciones Alembic contra PostgreSQL desechable.

Se omite si TEST_DATABASE_URL no está definido (suite local SQLite).
En CI el workflow inyecta Postgres y corre este archivo.
"""

import os

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, inspect, text

pytestmark = pytest.mark.integration


@pytest.fixture()
def pg_url() -> str:
    url = os.environ.get("TEST_DATABASE_URL", "").strip()
    if not url:
        pytest.skip("TEST_DATABASE_URL no configurado")
    if not any(token in url for token in ("localhost", "127.0.0.1", "asistencia_test")):
        pytest.skip("TEST_DATABASE_URL debe apuntar a una BD local o de CI, nunca a producción")
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
