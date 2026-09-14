"""EDB-03: el seed de e2e no usa SessionLocal ni DATABASE_URL discrepante."""

from __future__ import annotations

import os
from contextlib import contextmanager

import pytest

from app.core.test_db import validated_test_url
from scripts import seed_e2e_kiosk as seed_mod

VALID_TEST_URL = "postgresql+psycopg://postgres:postgres@127.0.0.1:5433/asistencia_test"
OTHER_URL = "postgresql+psycopg://postgres:postgres@127.0.0.1:5432/neondb_fake"


class _FakeEngine:
    def __init__(self) -> None:
        self.disposed = False
        self.connected = False

    def connect(self):
        self.connected = True
        raise AssertionError("DATABASE_URL discrepante no debe recibir conexiones")

    def dispose(self) -> None:
        self.disposed = True

    def begin(self):
        raise AssertionError("no debe abrirse transacción en el engine falso")


@contextmanager
def _fake_session(_engine, **_kwargs):
    class _Db:
        def rollback(self) -> None:
            return None

        def commit(self) -> None:
            return None

    yield _Db()


def test_validated_test_url_rechaza_override_de_host():
    with pytest.raises(ValueError, match="no permitida"):
        validated_test_url(
            "postgresql+psycopg://postgres:postgres@127.0.0.1:5433/asistencia_test?host=evil.example"
        )


def test_validated_test_url_rechaza_dbname_en_query():
    with pytest.raises(ValueError, match="no permitida"):
        validated_test_url(
            "postgresql+psycopg://postgres:postgres@127.0.0.1:5433/asistencia_test?dbname=postgres"
        )


def test_sin_autorizacion_no_crea_engine(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("ALLOW_TEST_DB_RESET", raising=False)
    monkeypatch.setenv("TEST_DATABASE_URL", VALID_TEST_URL)

    def boom(*_args, **_kwargs):
        raise AssertionError("create_engine no debe invocarse")

    with pytest.raises(SystemExit, match="ALLOW_TEST_DB_RESET"):
        seed_mod.main(create_engine_fn=boom)


def test_sin_test_database_url_no_crea_engine(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ALLOW_TEST_DB_RESET", "1")
    monkeypatch.delenv("TEST_DATABASE_URL", raising=False)
    monkeypatch.setenv("DATABASE_URL", VALID_TEST_URL)

    def boom(*_args, **_kwargs):
        raise AssertionError("create_engine no debe invocarse")

    with pytest.raises(SystemExit, match="TEST_DATABASE_URL"):
        seed_mod.main(create_engine_fn=boom)


def test_host_no_permitido_no_crea_engine(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ALLOW_TEST_DB_RESET", "1")
    monkeypatch.setenv(
        "TEST_DATABASE_URL",
        "postgresql+psycopg://postgres:postgres@db.internal:5432/asistencia_test",
    )

    def boom(*_args, **_kwargs):
        raise AssertionError("create_engine no debe invocarse")

    with pytest.raises(SystemExit):
        seed_mod.main(create_engine_fn=boom)


def test_usa_solo_test_database_url_aunque_haya_otra(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ALLOW_TEST_DB_RESET", "1")
    monkeypatch.setenv("TEST_DATABASE_URL", VALID_TEST_URL)
    monkeypatch.setenv("DATABASE_URL", OTHER_URL)
    created: list[str] = []
    other_touched = False

    class Probe(_FakeEngine):
        def connect(self):
            nonlocal other_touched
            other_touched = True
            raise AssertionError("no conectar al destino discrepante")

    def fake_create(url: str, **_kwargs):
        created.append(url)
        assert "neondb_fake" not in url
        assert "asistencia_test" in url
        return Probe()

    monkeypatch.setattr(seed_mod, "Session", _fake_session)
    monkeypatch.setattr(seed_mod, "seed_test_data", lambda _db: None)
    seed_mod.main(create_engine_fn=fake_create)
    assert created == [VALID_TEST_URL]
    assert other_touched is False


def test_engine_se_libera_si_el_repositorio_falla(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ALLOW_TEST_DB_RESET", "1")
    monkeypatch.setenv("TEST_DATABASE_URL", VALID_TEST_URL)
    engine = _FakeEngine()

    def fake_create(url: str, **_kwargs):
        assert url == VALID_TEST_URL
        return engine

    def boom(_db):
        raise RuntimeError("fallo de repositorio")

    monkeypatch.setattr(seed_mod, "Session", _fake_session)
    monkeypatch.setattr(seed_mod, "seed_test_data", boom)
    with pytest.raises(RuntimeError, match="fallo de repositorio"):
        seed_mod.main(create_engine_fn=fake_create)
    assert engine.disposed is True


@pytest.mark.integration
def test_seed_repetido_no_duplica_admin(monkeypatch: pytest.MonkeyPatch) -> None:
    from alembic import command
    from alembic.config import Config
    from sqlalchemy import create_engine, func, select, text
    from sqlalchemy.orm import Session

    from app.core.test_db import assert_disposable_postgres_url
    from app.modules.users.models import User
    from app.modules.employees.models import Employee
    from app.modules.salary.models import SalarySetting
    from app.modules.schedules.models import WorkSchedule

    url = os.environ.get("TEST_DATABASE_URL", "").strip()
    if not url:
        pytest.skip("TEST_DATABASE_URL no configurado")
    if os.environ.get("ALLOW_TEST_DB_RESET") != "1":
        pytest.skip("ALLOW_TEST_DB_RESET=1 es obligatorio para DROP SCHEMA")
    assert_disposable_postgres_url(url)

    engine = create_engine(url)
    with engine.begin() as conn:
        conn.execute(text("DROP SCHEMA public CASCADE"))
        conn.execute(text("CREATE SCHEMA public"))
    engine.dispose()

    monkeypatch.setenv("DATABASE_URL", url)
    monkeypatch.setenv("DATABASE_URL_UNPOOLED", url)
    from app.core.config import get_settings

    get_settings.cache_clear()
    command.upgrade(Config("alembic.ini"), "head")

    monkeypatch.setenv("ALLOW_TEST_DB_RESET", "1")
    monkeypatch.setenv("TEST_DATABASE_URL", url)
    monkeypatch.setenv("DATABASE_URL", OTHER_URL)
    seed_mod.main()
    seed_mod.main()
    engine = create_engine(url)
    try:
        with Session(engine) as db:
            count = db.scalar(select(func.count()).select_from(User).where(User.username == "admin"))
            assert count == 1
            employees = list(db.scalars(select(Employee).where(Employee.employee_code.in_(("TBL-ANA-01", "TBL-BRU-02")))))
            assert len(employees) == 2
            assert all(employee.qr_token for employee in employees)
            assert db.scalar(select(func.count()).select_from(WorkSchedule)) == 2
            assert db.scalar(select(func.count()).select_from(SalarySetting)) == 2
    finally:
        engine.dispose()
