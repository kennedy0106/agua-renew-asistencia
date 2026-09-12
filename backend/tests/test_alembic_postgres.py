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
    assert "object_key" in evidence_cols
    nonce_cols = {col["name"] for col in inspector.get_columns("attendance_consumed_nonces")}
    assert "device_id" in nonce_cols
    assert "attendance_attempt_resolutions" in tables
    resolution_cols = {col["name"] for col in inspector.get_columns("attendance_attempt_resolutions")}
    assert {"nonce", "employee_id", "device_id", "resolution", "reason"} <= resolution_cols
    reason_col = next(
        col for col in inspector.get_columns("attendance_attempt_resolutions") if col["name"] == "reason"
    )
    assert getattr(reason_col["type"], "length", None) == 500


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


def test_alembic_upgrade_e1f2a3b4c5d6_conserva_datos_y_crea_resoluciones(pg_url: str, monkeypatch: pytest.MonkeyPatch) -> None:
    """Upgrade poblado desde e1f2a3b4c5d6: no backfill de dueños y tabla nueva vacía."""
    from app.core.config import get_settings

    monkeypatch.setenv("DATABASE_URL", pg_url)
    monkeypatch.setenv("DATABASE_URL_UNPOOLED", pg_url)
    get_settings.cache_clear()

    engine = create_engine(pg_url)
    with engine.begin() as conn:
        conn.execute(text("DROP SCHEMA public CASCADE"))
        conn.execute(text("CREATE SCHEMA public"))

    cfg = Config("alembic.ini")
    command.upgrade(cfg, "e1f2a3b4c5d6")

    role_id = "dddddddd-dddd-dddd-dddd-dddddddddddd"
    employee_id = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee"
    record_id = "ffffffff-ffff-ffff-ffff-ffffffffffff"
    device_id = "12121212-1212-1212-1212-121212121212"
    with engine.begin() as conn:
        conn.execute(
            text("INSERT INTO job_roles (id, name, active) VALUES (:id, 'Operario', true)"),
            {"id": role_id},
        )
        conn.execute(
            text(
                """
                INSERT INTO employees (id, dni, employee_code, first_name, last_name, job_role_id, active, qr_token)
                VALUES (:id, '71117777', 'EMP-EDB', 'Rita', 'Sol', :role_id, true, 'qr-edb-nonce')
                """
            ),
            {"id": employee_id, "role_id": role_id},
        )
        conn.execute(
            text(
                """
                INSERT INTO attendance_devices (id, name, device_code, active, token_version)
                VALUES (:id, 'Kiosco legado', 'dev-edb', true, 1)
                """
            ),
            {"id": device_id},
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
                    nonce, action, event_type, employee_id, device_id, attendance_record_id, result_payload
                ) VALUES (
                    'nonce-con-terminal', 'CHECK_IN', 'CHECK_IN', :employee_id, :device_id, :record_id,
                    CAST(:payload AS json)
                )
                """
            ),
            {
                "employee_id": employee_id,
                "device_id": device_id,
                "record_id": record_id,
                "payload": '{"id": "ffffffff-ffff-ffff-ffff-ffffffffffff", "event_type": "CHECK_IN"}',
            },
        )
        conn.execute(
            text(
                """
                INSERT INTO attendance_consumed_nonces (
                    nonce, action, event_type, employee_id, attendance_record_id, result_payload
                ) VALUES (
                    'nonce-sin-terminal', 'CHECK_IN', 'CHECK_IN', :employee_id, :record_id,
                    CAST(:payload AS json)
                )
                """
            ),
            {
                "employee_id": employee_id,
                "record_id": record_id,
                "payload": '{"id": "ffffffff-ffff-ffff-ffff-ffffffffffff", "event_type": "CHECK_IN"}',
            },
        )
        conn.execute(
            text(
                """
                INSERT INTO attendance_evidence (
                    id, nonce, employee_id, attendance_record_id, device_id, content_type, image_bytes
                ) VALUES (
                    '13131313-1313-1313-1313-131313131313', 'nonce-con-terminal', :employee_id, :record_id,
                    :device_id, 'image/jpeg', decode('ffd8ff', 'hex')
                )
                """
            ),
            {"employee_id": employee_id, "record_id": record_id, "device_id": device_id},
        )

    command.upgrade(cfg, "f2a3b4c5d6e7")
    inspector = inspect(engine)
    assert "attendance_attempt_resolutions" in inspector.get_table_names()
    with engine.connect() as conn:
        owned = conn.execute(
            text("SELECT device_id FROM attendance_consumed_nonces WHERE nonce = 'nonce-con-terminal'")
        ).scalar_one()
        orphan = conn.execute(
            text("SELECT device_id FROM attendance_consumed_nonces WHERE nonce = 'nonce-sin-terminal'")
        ).scalar_one()
        assert str(owned) == device_id
        assert orphan is None
        evidence_sha = conn.execute(
            text("SELECT content_type FROM attendance_evidence WHERE nonce = 'nonce-con-terminal'")
        ).scalar_one()
        assert evidence_sha == "image/jpeg"
        resolutions = conn.execute(text("SELECT count(*) FROM attendance_attempt_resolutions")).scalar_one()
        assert resolutions == 0
        status = conn.execute(
            text("SELECT status FROM attendance_records WHERE id = :id"), {"id": record_id}
        ).scalar_one()
        assert status == "OPEN"

    command.downgrade(cfg, "e1f2a3b4c5d6")
    inspector_after = inspect(engine)
    assert "attendance_attempt_resolutions" not in inspector_after.get_table_names()
    with engine.connect() as conn:
        orphan = conn.execute(
            text("SELECT device_id FROM attendance_consumed_nonces WHERE nonce = 'nonce-sin-terminal'")
        ).scalar_one()
        assert orphan is None


def test_alembic_upgrade_f2a3b4c5d6e7_amplia_reason_sin_perder_datos(
    pg_url: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A04/A05: 80→500 conserva motivos; 501 falla en PG; downgrade no recorta."""
    from sqlalchemy.exc import DataError

    from app.core.config import get_settings

    monkeypatch.setenv("DATABASE_URL", pg_url)
    monkeypatch.setenv("DATABASE_URL_UNPOOLED", pg_url)
    get_settings.cache_clear()

    engine = create_engine(pg_url)
    with engine.begin() as conn:
        conn.execute(text("DROP SCHEMA public CASCADE"))
        conn.execute(text("CREATE SCHEMA public"))

    cfg = Config("alembic.ini")
    command.upgrade(cfg, "f2a3b4c5d6e7")

    employee_id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
    device_id = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
    role_id = "cccccccc-cccc-cccc-cccc-cccccccccccc"
    reason_80 = "R" * 80
    with engine.begin() as conn:
        conn.execute(
            text("INSERT INTO job_roles (id, name, active) VALUES (:id, 'Operario', true)"),
            {"id": role_id},
        )
        conn.execute(
            text(
                """
                INSERT INTO employees (id, dni, employee_code, first_name, last_name, job_role_id, active, qr_token)
                VALUES (:id, '71118888', 'EMP-R500', 'Nora', 'Luz', :role_id, true, 'qr-reason-500')
                """
            ),
            {"id": employee_id, "role_id": role_id},
        )
        conn.execute(
            text(
                """
                INSERT INTO attendance_devices (id, name, device_code, active, token_version)
                VALUES (:id, 'Kiosco motivo', 'dev-reason', true, 1)
                """
            ),
            {"id": device_id},
        )
        conn.execute(
            text(
                """
                INSERT INTO attendance_attempt_resolutions (
                    nonce, employee_id, device_id, action, resolution, reason
                ) VALUES (
                    'nonce-reason-80', :employee_id, :device_id, 'CHECK_IN', 'CANCELLED_UNCONFIRMED', :reason
                )
                """
            ),
            {"employee_id": employee_id, "device_id": device_id, "reason": reason_80},
        )

    command.upgrade(cfg, "g3b4c5d6e7f8")
    inspector = inspect(engine)
    reason_col = next(
        col for col in inspector.get_columns("attendance_attempt_resolutions") if col["name"] == "reason"
    )
    assert getattr(reason_col["type"], "length", None) == 500
    with engine.connect() as conn:
        preserved = conn.execute(
            text("SELECT reason FROM attendance_attempt_resolutions WHERE nonce = 'nonce-reason-80'")
        ).scalar_one()
        assert preserved == reason_80
        assert len(preserved) == 80

    lengths = {81: "A" * 81, 120: "B" * 120, 500: "C" * 500}
    with engine.begin() as conn:
        for length, reason in lengths.items():
            conn.execute(
                text(
                    """
                    INSERT INTO attendance_attempt_resolutions (
                        nonce, employee_id, device_id, action, resolution, reason
                    ) VALUES (
                        :nonce, :employee_id, :device_id, 'CHECK_OUT', 'CANCELLED_UNCONFIRMED', :reason
                    )
                    """
                ),
                {
                    "nonce": f"nonce-reason-{length}",
                    "employee_id": employee_id,
                    "device_id": device_id,
                    "reason": reason,
                },
            )

    with engine.connect() as conn:
        for length, reason in lengths.items():
            stored = conn.execute(
                text("SELECT reason FROM attendance_attempt_resolutions WHERE nonce = :nonce"),
                {"nonce": f"nonce-reason-{length}"},
            ).scalar_one()
            assert stored == reason
            assert len(stored) == length

    with pytest.raises(DataError):
        with engine.begin() as conn:
            conn.execute(
                text(
                    """
                    INSERT INTO attendance_attempt_resolutions (
                        nonce, employee_id, device_id, action, resolution, reason
                    ) VALUES (
                        'nonce-reason-501', :employee_id, :device_id, 'CHECK_IN',
                        'CANCELLED_UNCONFIRMED', :reason
                    )
                    """
                ),
                {"employee_id": employee_id, "device_id": device_id, "reason": "D" * 501},
            )

    with engine.connect() as conn:
        missing = conn.execute(
            text("SELECT count(*) FROM attendance_attempt_resolutions WHERE nonce = 'nonce-reason-501'")
        ).scalar_one()
        assert missing == 0
        eighty = conn.execute(
            text("SELECT reason FROM attendance_attempt_resolutions WHERE nonce = 'nonce-reason-80'")
        ).scalar_one()
        assert eighty == reason_80

    with pytest.raises(Exception, match="No se puede reducir reason"):
        command.downgrade(cfg, "f2a3b4c5d6e7")

    with engine.connect() as conn:
        remaining = conn.execute(
            text(
                """
                SELECT nonce, char_length(reason) FROM attendance_attempt_resolutions
                ORDER BY nonce
                """
            )
        ).all()
        assert {(row[0], row[1]) for row in remaining} == {
            ("nonce-reason-80", 80),
            ("nonce-reason-81", 81),
            ("nonce-reason-120", 120),
            ("nonce-reason-500", 500),
        }

    with engine.begin() as conn:
        conn.execute(
            text("DELETE FROM attendance_attempt_resolutions WHERE char_length(reason) > 80")
        )

    command.downgrade(cfg, "f2a3b4c5d6e7")
    inspector_after = inspect(engine)
    reason_after = next(
        col for col in inspector_after.get_columns("attendance_attempt_resolutions") if col["name"] == "reason"
    )
    assert getattr(reason_after["type"], "length", None) == 80
    with engine.connect() as conn:
        leftover = conn.execute(
            text("SELECT reason FROM attendance_attempt_resolutions WHERE nonce = 'nonce-reason-80'")
        ).scalar_one()
        assert leftover == reason_80


def test_alembic_upgrade_h4c5d6e7f8a9_conserva_bytes_y_anade_object_key(
    pg_url: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.core.config import get_settings

    monkeypatch.setenv("DATABASE_URL", pg_url)
    monkeypatch.setenv("DATABASE_URL_UNPOOLED", pg_url)
    get_settings.cache_clear()

    engine = create_engine(pg_url)
    with engine.begin() as conn:
        conn.execute(text("DROP SCHEMA public CASCADE"))
        conn.execute(text("CREATE SCHEMA public"))

    cfg = Config("alembic.ini")
    command.upgrade(cfg, "g3b4c5d6e7f8")

    role_id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
    employee_id = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
    with engine.begin() as conn:
        conn.execute(
            text("INSERT INTO job_roles (id, name, active) VALUES (:id, 'Operario', true)"),
            {"id": role_id},
        )
        conn.execute(
            text(
                """
                INSERT INTO employees (id, dni, employee_code, first_name, last_name, job_role_id, active, qr_token)
                VALUES (:id, '71118888', 'EMP-S3', 'Nora', 'R2', :role_id, true, 'qr-s3')
                """
            ),
            {"id": employee_id, "role_id": role_id},
        )
        conn.execute(
            text(
                """
                INSERT INTO attendance_evidence (
                    id, nonce, employee_id, content_type, image_bytes
                ) VALUES (
                    '14141414-1414-1414-1414-141414141414', 'nonce-s3-legacy', :employee_id,
                    'image/jpeg', decode('ffd8ff', 'hex')
                )
                """
            ),
            {"employee_id": employee_id},
        )

    command.upgrade(cfg, "h4c5d6e7f8a9")
    inspector = inspect(engine)
    evidence_cols = {col["name"]: col for col in inspector.get_columns("attendance_evidence")}
    assert "object_key" in evidence_cols
    assert evidence_cols["image_bytes"]["nullable"] is True
    with engine.connect() as conn:
        row = conn.execute(
            text(
                """
                SELECT object_key, encode(image_bytes, 'hex')
                FROM attendance_evidence WHERE nonce = 'nonce-s3-legacy'
                """
            )
        ).one()
        assert row[0] is None
        assert row[1] == "ffd8ff"
