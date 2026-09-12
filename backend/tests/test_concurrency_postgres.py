"""Concurrencia de planilla y marcación (requiere PostgreSQL)."""

import os
import threading
import uuid
from datetime import date
from decimal import Decimal

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine, inspect, select, text
from sqlalchemy.orm import sessionmaker

from app.core.security import create_attendance_token, decode_attendance_token
from app.core.test_db import assert_disposable_postgres_url
from app.db.base import Base
import app.modules  # noqa: F401
from app.modules.attendance.models import AttendanceConsumedNonce
from app.modules.attendance.service import AttendanceService
from app.modules.employees.models import Employee
from app.modules.job_roles.models import JobRole
from app.modules.payroll.models import PERIOD_CALCULATED, PERIOD_CLOSED, PayrollPeriod, PayrollRecord
from app.modules.payroll.service import PayrollService

pytestmark = pytest.mark.integration


@pytest.fixture()
def pg_engine():
    url = os.environ.get("TEST_DATABASE_URL", "").strip()
    if not url:
        pytest.skip("TEST_DATABASE_URL no configurado")
    try:
        assert_disposable_postgres_url(url)
    except ValueError as exc:
        pytest.skip(str(exc))
    engine = create_engine(url)
    Base.metadata.create_all(engine)
    yield engine
    engine.dispose()


def _two_factory(engine):
    return sessionmaker(bind=engine, autoflush=False, autocommit=False)


def _seed_employee_and_period(session):
    role = JobRole(name=f"Rol-{uuid.uuid4().hex[:8]}", active=True)
    session.add(role)
    session.flush()
    employee = Employee(
        dni=str(uuid.uuid4().int)[:8],
        employee_code=f"E-{uuid.uuid4().hex[:8]}",
        first_name="Ana",
        last_name="López",
        job_role_id=role.id,
        active=True,
        qr_token=uuid.uuid4().hex,
    )
    session.add(employee)
    session.flush()
    period = PayrollPeriod(
        name=f"Lock {uuid.uuid4().hex[:6]}",
        start_date=date(2026, 8, 1),
        end_date=date(2026, 8, 31),
        status=PERIOD_CALCULATED,
        inputs_fingerprint="abc",
    )
    session.add(period)
    session.flush()
    record = PayrollRecord(
        payroll_period_id=period.id,
        employee_id=employee.id,
        monthly_salary=Decimal("1500.00"),
        worked_minutes=0,
        expected_minutes=0,
        overtime_minutes=0,
        overtime_amount=Decimal("0.00"),
        adjustment_minutes=0,
        adjustment_amount=Decimal("0.00"),
        base_salary=Decimal("1500.00"),
        total=Decimal("1500.00"),
        payable=True,
        status="PREVIEW",
    )
    session.add(record)
    session.commit()
    return employee.id, period.id, record.id


def _cleanup_payroll(session, period_id, record_id) -> None:
    session.execute(text("DELETE FROM payroll_records WHERE id = :id"), {"id": record_id})
    session.execute(text("DELETE FROM payroll_periods WHERE id = :id"), {"id": period_id})
    session.commit()


def _join_finished(threads: list[threading.Thread], timeout: float = 15) -> None:
    for thread in threads:
        thread.join(timeout=timeout)
        assert not thread.is_alive(), f"el hilo {thread.name} no terminó"


def test_ajuste_manual_exitoso_en_postgres(pg_engine):
    """Ajuste de bono en PostgreSQL sin concurrencia (sin OUTER JOIN + FOR UPDATE)."""
    factory = _two_factory(pg_engine)
    session = factory()
    try:
        _employee_id, period_id, record_id = _seed_employee_and_period(session)
    finally:
        session.close()

    db = factory()
    try:
        saved = PayrollService(db).set_manual_adjustment(
            record_id, amount=Decimal("50.00"), notes="Bono", current_user_id=None
        )
        assert saved.manual_adjustment == Decimal("50.00")
        assert saved.total == Decimal("1550.00")
    finally:
        db.close()

    check = factory()
    try:
        record_row = check.get(PayrollRecord, record_id)
        assert record_row is not None
        assert record_row.manual_adjustment == Decimal("50.00")
        _cleanup_payroll(check, period_id, record_id)
    finally:
        check.close()


def test_cierre_gana_ajuste_recibe_409(pg_engine):
    """El cierre toma el bloqueo primero; el ajuste espera y recibe conflicto de negocio."""
    factory = _two_factory(pg_engine)
    session = factory()
    try:
        _employee_id, period_id, record_id = _seed_employee_and_period(session)
    finally:
        session.close()

    holding = threading.Event()
    results: dict[str, object] = {}

    def closer():
        db = factory()
        try:
            service = PayrollService(db)
            period_row = service._get_period_or_404(period_id, for_update=True)
            holding.set()
            period_row.status = PERIOD_CLOSED
            db.add(period_row)
            db.commit()
            results["close"] = "ok"
        except HTTPException as exc:
            db.rollback()
            results["close"] = exc.status_code
            raise
        finally:
            db.close()

    def adjuster():
        db = factory()
        try:
            holding.wait(timeout=5)
            PayrollService(db).set_manual_adjustment(
                record_id, amount=Decimal("50.00"), notes="Bono concurrente", current_user_id=None
            )
            results["adjust"] = "ok"
        except HTTPException as exc:
            db.rollback()
            results["adjust"] = exc.status_code
        finally:
            db.close()

    threads = [
        threading.Thread(target=closer, name="closer"),
        threading.Thread(target=adjuster, name="adjuster"),
    ]
    for thread in threads:
        thread.start()
    _join_finished(threads)

    assert results.get("close") == "ok"
    assert results.get("adjust") == 409
    check = factory()
    try:
        period_row = check.get(PayrollPeriod, period_id)
        record_row = check.get(PayrollRecord, record_id)
        assert period_row is not None and record_row is not None
        assert period_row.status == PERIOD_CLOSED
        assert record_row.manual_adjustment == Decimal("0.00")
        _cleanup_payroll(check, period_id, record_id)
    finally:
        check.close()


def test_ajuste_gana_antes_del_cierre(pg_engine):
    """El bono se guarda; el cierre posterior conserva el importe."""
    factory = _two_factory(pg_engine)
    session = factory()
    try:
        _employee_id, period_id, record_id = _seed_employee_and_period(session)
    finally:
        session.close()

    adjusted = threading.Event()
    results: dict[str, object] = {}

    def adjuster():
        db = factory()
        try:
            PayrollService(db).set_manual_adjustment(
                record_id, amount=Decimal("50.00"), notes="Bono primero", current_user_id=None
            )
            results["adjust"] = "ok"
            adjusted.set()
        except HTTPException:
            db.rollback()
            raise
        finally:
            db.close()

    def closer():
        db = factory()
        try:
            adjusted.wait(timeout=5)
            service = PayrollService(db)
            period_row = service._get_period_or_404(period_id, for_update=True)
            period_row.status = PERIOD_CLOSED
            db.add(period_row)
            db.commit()
            results["close"] = "ok"
        except HTTPException:
            db.rollback()
            raise
        finally:
            db.close()

    threads = [
        threading.Thread(target=adjuster, name="adjuster"),
        threading.Thread(target=closer, name="closer"),
    ]
    for thread in threads:
        thread.start()
    _join_finished(threads)

    assert results.get("adjust") == "ok"
    assert results.get("close") == "ok"
    check = factory()
    try:
        period_row = check.get(PayrollPeriod, period_id)
        record_row = check.get(PayrollRecord, record_id)
        assert period_row.status == PERIOD_CLOSED
        assert record_row.manual_adjustment == Decimal("50.00")
        assert record_row.total == Decimal("1550.00")
        _cleanup_payroll(check, period_id, record_id)
    finally:
        check.close()


def test_recalculo_concurrente_no_reabre_cerrado(pg_engine):
    """T14: recálculo espera el cierre y no altera un periodo CLOSED."""
    factory = _two_factory(pg_engine)
    session = factory()
    try:
        _employee_id, period_id, record_id = _seed_employee_and_period(session)
    finally:
        session.close()

    holding = threading.Event()
    results: dict[str, object] = {}

    def closer():
        db = factory()
        try:
            service = PayrollService(db)
            period_row = service._get_period_or_404(period_id, for_update=True)
            holding.set()
            period_row.status = PERIOD_CLOSED
            db.add(period_row)
            db.commit()
            results["close"] = "ok"
        except HTTPException:
            db.rollback()
            raise
        finally:
            db.close()

    def recalculator():
        db = factory()
        try:
            holding.wait(timeout=5)
            PayrollService(db).calculate(period_id)
            results["calc"] = "ok"
        except HTTPException as exc:
            db.rollback()
            results["calc"] = exc.status_code
        finally:
            db.close()

    threads = [
        threading.Thread(target=closer, name="closer"),
        threading.Thread(target=recalculator, name="recalculator"),
    ]
    for thread in threads:
        thread.start()
    _join_finished(threads)

    assert results.get("close") == "ok"
    assert results.get("calc") == 409
    check = factory()
    try:
        period_row = check.get(PayrollPeriod, period_id)
        record_row = check.get(PayrollRecord, record_id)
        assert period_row.status == PERIOD_CLOSED
        assert record_row.total == Decimal("1500.00")
        _cleanup_payroll(check, period_id, record_id)
    finally:
        check.close()


def test_entrada_concurrente_mismo_nonce(pg_engine):
    """T17: dos check-in con el mismo nonce recuperan un solo resultado."""
    if "attendance_consumed_nonces" not in inspect(pg_engine).get_table_names():
        pytest.skip("esquema de asistencia incompleto")
    factory = _two_factory(pg_engine)
    session = factory()
    try:
        employee_id, period_id, record_id = _seed_employee_and_period(session)
    finally:
        session.close()

    token = create_attendance_token(str(employee_id), action="CHECK_IN")
    nonce = str(decode_attendance_token(token)["nonce"])
    barrier = threading.Barrier(2)
    payloads: list[object] = []

    def worker():
        db = factory()
        try:
            barrier.wait(timeout=5)
            payloads.append(AttendanceService(db).check_in(employee_id, nonce=nonce, require_evidence=False))
        except HTTPException:
            db.rollback()
            raise
        finally:
            db.close()

    threads = [threading.Thread(target=worker, name="checkin-a"), threading.Thread(target=worker, name="checkin-b")]
    for thread in threads:
        thread.start()
    _join_finished(threads)

    ids = []
    for item in payloads:
        if isinstance(item, dict):
            ids.append(str(item["id"]))
        else:
            ids.append(str(item.id))
    assert len(payloads) == 2
    assert len(set(ids)) == 1
    check = factory()
    try:
        nonce_row = check.scalar(select(AttendanceConsumedNonce).where(AttendanceConsumedNonce.nonce == nonce))
        assert nonce_row is not None
        check.execute(text("DELETE FROM attendance_events WHERE employee_id = :id"), {"id": employee_id})
        check.execute(text("DELETE FROM attendance_consumed_nonces WHERE employee_id = :id"), {"id": employee_id})
        check.execute(text("DELETE FROM attendance_records WHERE employee_id = :id"), {"id": employee_id})
        _cleanup_payroll(check, period_id, record_id)
    finally:
        check.close()


def test_canje_simultaneo_mismo_codigo(pg_engine):
    """Dos conexiones PostgreSQL canjean el mismo código: exactamente un ganador."""
    if "attendance_devices" not in inspect(pg_engine).get_table_names():
        pytest.skip("esquema de terminales incompleto")
    from app.modules.attendance.models import AttendanceDevice
    from app.modules.devices.service import DeviceService

    factory = _two_factory(pg_engine)
    session = factory()
    try:
        device, code = DeviceService(session).create("Kiosco concurrente")
        device_id = device.id
    finally:
        session.close()

    barrier = threading.Barrier(2)
    outcomes: list[object] = []

    def worker():
        db = factory()
        try:
            barrier.wait(timeout=5)
            DeviceService(db).pair(code)
            outcomes.append("ok")
        except HTTPException as exc:
            outcomes.append(exc.status_code)
        finally:
            db.close()

    threads = [
        threading.Thread(target=worker, name="pair-a"),
        threading.Thread(target=worker, name="pair-b"),
    ]
    for thread in threads:
        thread.start()
    _join_finished(threads)

    assert outcomes.count("ok") == 1
    assert outcomes.count(401) == 1
    check = factory()
    try:
        row = check.get(AttendanceDevice, device_id)
        assert row is not None
        assert row.pairing_code_hash is None
        check.execute(text("DELETE FROM attendance_devices WHERE id = :id"), {"id": device_id})
        check.commit()
    finally:
        check.close()
