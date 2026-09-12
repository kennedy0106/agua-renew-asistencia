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
    device_cols = {col["name"] for col in inspector.get_columns("attendance_devices")}
    assert "pairing_code_hash" in device_cols
    evidence_cols = {col["name"] for col in inspector.get_columns("attendance_evidence")}
    assert "image_sha256" in evidence_cols
    nonce_cols = {col["name"] for col in inspector.get_columns("attendance_consumed_nonces")}
    assert "device_id" in nonce_cols


def test_alembic_upgrade_conserva_datos_de_revision_previa(pg_url: str, monkeypatch: pytest.MonkeyPatch) -> None:
    """T30: upgrade desde b7e1c4a90f12 con filas representativas, sin reescribirlas."""
    from app.core.config import get_settings

    monkeypatch.setenv("DATABASE_URL", pg_url)
    monkeypatch.setenv("DATABASE_URL_UNPOOLED", pg_url)
    get_settings.cache_clear()

    engine = create_engine(pg_url)
    with engine.begin() as conn:
        conn.execute(text("DROP SCHEMA public CASCADE"))
        conn.execute(text("CREATE SCHEMA public"))

    cfg = Config("alembic.ini")
    command.upgrade(cfg, "b7e1c4a90f12")

    role_id = "11111111-1111-1111-1111-111111111111"
    employee_id = "22222222-2222-2222-2222-222222222222"
    period_id = "33333333-3333-3333-3333-333333333333"
    record_id = "44444444-4444-4444-4444-444444444444"
    with engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO job_roles (id, name, active) VALUES (:id, 'Operario', true)"
            ),
            {"id": role_id},
        )
        conn.execute(
            text(
                """
                INSERT INTO employees (id, dni, employee_code, first_name, last_name, job_role_id, active, qr_token)
                VALUES (:id, '72845632', 'EMP-001', 'Ana', 'López', :role_id, true, 'qr-token-seed')
                """
            ),
            {"id": employee_id, "role_id": role_id},
        )
        conn.execute(
            text(
                """
                INSERT INTO payroll_periods (id, name, start_date, end_date, status, root_period_id, version)
                VALUES (:id, 'Agosto seed', '2026-08-01', '2026-08-31', 'CLOSED', :id, 1)
                """
            ),
            {"id": period_id},
        )
        conn.execute(
            text(
                """
                INSERT INTO payroll_records (
                    id, payroll_period_id, employee_id, monthly_salary, worked_minutes, expected_minutes,
                    overtime_minutes, overtime_amount, adjustment_minutes, adjustment_amount,
                    base_salary, manual_adjustment, missing_salary_days, total, status
                ) VALUES (
                    :id, :period_id, :employee_id, 1500, 0, 0, 0, 0, 0, 0, 1500, 50, 0, 1550, 'CONFIRMED'
                )
                """
            ),
            {"id": record_id, "period_id": period_id, "employee_id": employee_id},
        )
        conn.execute(
            text(
                """
                INSERT INTO attendance_records (
                    id, employee_id, work_date, check_in_at, check_out_at, worked_minutes, status
                ) VALUES (
                    '55555555-5555-5555-5555-555555555555', :employee_id, '2026-08-03',
                    '2026-08-03 13:00:00+00', '2026-08-03 22:00:00+00', 480, 'COMPLETE'
                )
                """
            ),
            {"employee_id": employee_id},
        )

    command.upgrade(cfg, "head")
    with engine.connect() as conn:
        total = conn.execute(text("SELECT total, status FROM payroll_records WHERE id = :id"), {"id": record_id}).one()
        assert str(total[0]) in {"1550.00", "1550"}
        assert total[1] == "CONFIRMED"
        payable = conn.execute(text("SELECT payable FROM payroll_records WHERE id = :id"), {"id": record_id}).one()[0]
        assert payable is True or payable == 1
        fingerprint = conn.execute(
            text("SELECT inputs_fingerprint FROM payroll_periods WHERE id = :id"), {"id": period_id}
        ).one()[0]
        assert fingerprint is None
        attendance_status = conn.execute(
            text("SELECT status, worked_minutes FROM attendance_records WHERE id = '55555555-5555-5555-5555-555555555555'")
        ).one()
        assert attendance_status[0] == "COMPLETE"
        assert attendance_status[1] == 480
        nonce_cols = {col["name"] for col in inspect(engine).get_columns("attendance_consumed_nonces")}
        assert "result_payload" in nonce_cols
        assert "device_id" in nonce_cols


def test_alembic_upgrade_conserva_nonces_sin_device_id(pg_url: str, monkeypatch: pytest.MonkeyPatch) -> None:
    """e1f2a3b4c5d6 deja device_id NULL en nonces anteriores; no inventa propietario."""
    from app.core.config import get_settings

    monkeypatch.setenv("DATABASE_URL", pg_url)
    monkeypatch.setenv("DATABASE_URL_UNPOOLED", pg_url)
    get_settings.cache_clear()

    engine = create_engine(pg_url)
    with engine.begin() as conn:
        conn.execute(text("DROP SCHEMA public CASCADE"))
        conn.execute(text("CREATE SCHEMA public"))

    cfg = Config("alembic.ini")
    command.upgrade(cfg, "d9a1b2c3d4e5")

    role_id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
    employee_id = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
    record_id = "cccccccc-cccc-cccc-cccc-cccccccccccc"
    with engine.begin() as conn:
        conn.execute(
            text("INSERT INTO job_roles (id, name, active) VALUES (:id, 'Operario', true)"),
            {"id": role_id},
        )
        conn.execute(
            text(
                """
                INSERT INTO employees (id, dni, employee_code, first_name, last_name, job_role_id, active, qr_token)
                VALUES (:id, '71118888', 'EMP-LEG', 'Luis', 'Paz', :role_id, true, 'qr-legacy-nonce')
                """
            ),
            {"id": employee_id, "role_id": role_id},
        )
        conn.execute(
            text(
                """
                INSERT INTO attendance_records (
                    id, employee_id, work_date, check_in_at, check_out_at, worked_minutes, status
                ) VALUES (
                    :id, :employee_id, '2026-08-03',
                    '2026-08-03 13:00:00+00', NULL, NULL, 'OPEN'
                )
                """
            ),
            {"id": record_id, "employee_id": employee_id},
        )
        conn.execute(
            text(
                """
                INSERT INTO attendance_consumed_nonces (
                    nonce, action, event_type, employee_id, attendance_record_id, result_payload
                ) VALUES (
                    'legacy-nonce-sin-terminal', 'CHECK_IN', 'CHECK_IN', :employee_id, :record_id,
                    CAST(:payload AS json)
                )
                """
            ),
            {
                "employee_id": employee_id,
                "record_id": record_id,
                "payload": '{"id": "cccccccc-cccc-cccc-cccc-cccccccccccc", "event_type": "CHECK_IN"}',
            },
        )

    command.upgrade(cfg, "head")
    with engine.connect() as conn:
        row = conn.execute(
            text(
                """
                SELECT device_id, action, employee_id, result_payload
                FROM attendance_consumed_nonces
                WHERE nonce = 'legacy-nonce-sin-terminal'
                """
            )
        ).one()
        assert row[0] is None
        assert row[1] == "CHECK_IN"
        assert str(row[2]) == employee_id
        payload = row[3]
        assert payload["event_type"] == "CHECK_IN"

