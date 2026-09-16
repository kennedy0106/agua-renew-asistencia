"""Concurrencia de planilla y marcación (requiere PostgreSQL)."""

import os
import threading
import uuid
from datetime import date
from decimal import Decimal

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine, func, inspect, select, text
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
from app.modules.attendance.manual_models import ManualAttendanceDay, ManualRecoveryApplication, RecoveryCommitment
from app.modules.attendance.manual_schemas import ManualBatchIn, ManualDayIn, ManualUpdateIn, RecoveryAllocationIn
from app.modules.attendance.manual_service import ManualAttendanceService
from app.modules.system_roles.models import SystemRole
from app.modules.users.models import User

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
    if os.environ.get("ALLOW_TEST_DB_RESET") == "1":
        with engine.begin() as conn:
            conn.execute(text("DROP SCHEMA public CASCADE"))
            conn.execute(text("CREATE SCHEMA public"))
    Base.metadata.create_all(engine)
    evidence_tables = inspect(engine).get_table_names()
    if "attendance_evidence" in evidence_tables:
        evidence_cols = {col["name"] for col in inspect(engine).get_columns("attendance_evidence")}
        if "object_key" not in evidence_cols:
            pytest.skip("esquema de asistencia incompleto")
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


def _manual_actor(session) -> uuid.UUID:
    role = SystemRole(name=f"ADMIN-HST-{uuid.uuid4().hex[:8]}", description="concurrencia")
    session.add(role)
    session.flush()
    actor = User(username=f"hst-{uuid.uuid4().hex[:10]}", password_hash="test", system_role_id=role.id)
    session.add(actor)
    session.commit()
    return actor.id


def _manual_payload(employee_id: uuid.UUID, work_date: date, *, normal: int = 480, additional: int = 0, recovery: int = 0, commitment_id: uuid.UUID | None = None, key: str | None = None) -> ManualBatchIn:
    allocations = [] if commitment_id is None else [RecoveryAllocationIn(commitment_id=commitment_id, minutes=recovery)]
    return ManualBatchIn(
        work_date=work_date,
        idempotency_key=key or f"hst-{uuid.uuid4().hex}",
        rows=[ManualDayIn(
            employee_id=employee_id,
            worked_minutes_net=normal + additional + recovery,
            normal_minutes=normal,
            additional_minutes=additional,
            recovery_minutes=recovery,
            recovery_allocations=allocations,
            reason="Prueba concurrente HST-01",
        )],
    )


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


def test_hst01_d03_two_concurrent_creations_leave_one_active_day(pg_engine):
    """D03: dos conexiones crean la misma jornada; el índice parcial decide un ganador."""
    factory = _two_factory(pg_engine)
    setup = factory()
    try:
        employee_id, period_id, record_id = _seed_employee_and_period(setup)
        actor_id = _manual_actor(setup)
    finally:
        setup.close()

    # Una fecha fuera del periodo de planilla de la fixture evita que el caso
    # pruebe un cierre y concentra la carrera en la unicidad de la jornada.
    work_date = date(2026, 9, 10)
    barrier = threading.Barrier(2)
    outcomes: list[object] = []

    def create_day(label: str):
        db = factory()
        try:
            barrier.wait(timeout=5)
            outcomes.append(ManualAttendanceService(db).batch(_manual_payload(employee_id, work_date, key=f"d03-{label}-{uuid.uuid4().hex}"), actor_id))
        except HTTPException as exc:
            db.rollback()
            outcomes.append(exc.status_code)
        finally:
            db.close()

    threads = [threading.Thread(target=create_day, args=("a",)), threading.Thread(target=create_day, args=("b",))]
    for thread in threads:
        thread.start()
    _join_finished(threads)
    assert sum(isinstance(item, dict) for item in outcomes) == 1
    assert outcomes.count(409) == 1

    check = factory()
    try:
        active = list(check.scalars(select(ManualAttendanceDay).where(ManualAttendanceDay.employee_id == employee_id, ManualAttendanceDay.work_date == work_date, ManualAttendanceDay.voided_at.is_(None))))
        assert len(active) == 1
        check.execute(text("DELETE FROM manual_attendance_idempotency"))
        check.execute(text("DELETE FROM manual_attendance_days WHERE employee_id = :id"), {"id": employee_id})
        _cleanup_payroll(check, period_id, record_id)
    finally:
        check.close()


def test_hst01_r04_two_concurrent_recoveries_do_not_consume_more_than_pending(pg_engine):
    """R04: el bloqueo del compromiso permite una sola aplicación de 120 min."""
    factory = _two_factory(pg_engine)
    setup = factory()
    try:
        employee_id, period_id, record_id = _seed_employee_and_period(setup)
        actor_id = _manual_actor(setup)
        commitment = RecoveryCommitment(employee_id=employee_id, permission_date=date(2026, 8, 3), agreed_minutes=120, covered_before=False, reference="Permiso pendiente", created_by_user_id=actor_id)
        setup.add(commitment)
        setup.commit()
        commitment_id = commitment.id
    finally:
        setup.close()

    barrier = threading.Barrier(2)
    outcomes: list[object] = []

    def apply_recovery(work_date: date):
        db = factory()
        try:
            barrier.wait(timeout=5)
            outcomes.append(ManualAttendanceService(db).batch(_manual_payload(employee_id, work_date, normal=0, recovery=120, commitment_id=commitment_id), actor_id))
        except HTTPException as exc:
            db.rollback()
            outcomes.append(exc.status_code)
        finally:
            db.close()

    threads = [threading.Thread(target=apply_recovery, args=(date(2026, 9, 10),)), threading.Thread(target=apply_recovery, args=(date(2026, 9, 11),))]
    for thread in threads:
        thread.start()
    _join_finished(threads)
    assert sum(isinstance(item, dict) for item in outcomes) == 1
    assert outcomes.count(409) == 1

    check = factory()
    try:
        consumed = check.scalar(select(func.coalesce(func.sum(ManualRecoveryApplication.minutes), 0)).where(ManualRecoveryApplication.commitment_id == commitment_id))
        assert consumed == 120
        check.execute(text("DELETE FROM manual_attendance_idempotency"))
        check.execute(text("DELETE FROM manual_recovery_applications WHERE commitment_id = :id"), {"id": commitment_id})
        check.execute(text("DELETE FROM manual_attendance_days WHERE employee_id = :id"), {"id": employee_id})
        check.execute(text("DELETE FROM recovery_commitments WHERE id = :id"), {"id": commitment_id})
        _cleanup_payroll(check, period_id, record_id)
    finally:
        check.close()


def test_hst01_f04_close_blocks_concurrent_versioned_edit(pg_engine):
    """F04: después de tomar el lock de cierre, una edición no se publica."""
    factory = _two_factory(pg_engine)
    setup = factory()
    try:
        employee_id, period_id, record_id = _seed_employee_and_period(setup)
        actor_id = _manual_actor(setup)
        # El periodo de esta fixture cubre agosto, por eso la jornada editada
        # debe estar dentro de él.
        created = ManualAttendanceService(setup).batch(_manual_payload(employee_id, date(2026, 8, 10)), actor_id)
        manual_day_id = uuid.UUID(created["created"][0])
        period = setup.get(PayrollPeriod, period_id)
        period.status = PERIOD_CALCULATED
        setup.commit()
    finally:
        setup.close()

    lock_held = threading.Event()
    outcomes: dict[str, object] = {}

    def closer():
        db = factory()
        try:
            period = db.scalar(select(PayrollPeriod).where(PayrollPeriod.id == period_id).with_for_update())
            assert period is not None
            lock_held.set()
            period.status = PERIOD_CLOSED
            db.commit()
            outcomes["close"] = "ok"
        finally:
            db.close()

    def editor():
        db = factory()
        try:
            assert lock_held.wait(timeout=5)
            ManualAttendanceService(db).update(
                manual_day_id,
                ManualUpdateIn(
                    employee_id=employee_id,
                    worked_minutes_net=390,
                    normal_minutes=390,
                    additional_minutes=0,
                    recovery_minutes=0,
                    reason="Edición concurrente",
                    expected_version=1,
                ),
                expected_version=1,
                actor_id=actor_id,
            )
            outcomes["edit"] = "ok"
        except HTTPException as exc:
            db.rollback()
            outcomes["edit"] = exc.status_code
        finally:
            db.close()

    threads = [threading.Thread(target=closer), threading.Thread(target=editor)]
    for thread in threads:
        thread.start()
    _join_finished(threads)
    assert outcomes == {"close": "ok", "edit": 409}

    check = factory()
    try:
        period = check.get(PayrollPeriod, period_id)
        active = check.scalar(select(ManualAttendanceDay).where(ManualAttendanceDay.id == manual_day_id))
        assert period is not None and period.status == PERIOD_CLOSED
        assert active is not None and active.worked_minutes_net == 480 and active.version == 1
        check.execute(text("DELETE FROM manual_attendance_idempotency"))
        check.execute(text("DELETE FROM manual_attendance_days WHERE employee_id = :id"), {"id": employee_id})
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


def _seed_employee_device(session):
    from app.modules.attendance.models import AttendanceDevice

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
    device = AttendanceDevice(
        name=f"Kiosco {uuid.uuid4().hex[:6]}",
        device_code=uuid.uuid4().hex,
        active=True,
    )
    session.add(device)
    session.commit()
    return employee.id, device.id


def _cleanup_attempt(session, employee_id, device_id) -> None:
    session.execute(text("DELETE FROM attendance_attempt_resolutions WHERE employee_id = :id"), {"id": employee_id})
    session.execute(text("DELETE FROM attendance_events WHERE employee_id = :id"), {"id": employee_id})
    session.execute(text("DELETE FROM attendance_evidence WHERE employee_id = :id"), {"id": employee_id})
    session.execute(text("DELETE FROM attendance_consumed_nonces WHERE employee_id = :id"), {"id": employee_id})
    session.execute(text("DELETE FROM attendance_records WHERE employee_id = :id"), {"id": employee_id})
    session.execute(text("DELETE FROM employees WHERE id = :id"), {"id": employee_id})
    session.execute(text("DELETE FROM attendance_devices WHERE id = :id"), {"id": device_id})
    session.commit()


def test_marcacion_gana_resolucion_ve_confirmado(pg_engine):
    if "attendance_attempt_resolutions" not in inspect(pg_engine).get_table_names():
        pytest.skip("esquema de resoluciones incompleto")
    from app.modules.attendance.models import AttendanceAttemptResolution, AttendanceRecord

    factory = _two_factory(pg_engine)
    session = factory()
    try:
        employee_id, device_id = _seed_employee_device(session)
    finally:
        session.close()

    token = create_attendance_token(str(employee_id), action="CHECK_IN", device_id=str(device_id))
    nonce = str(decode_attendance_token(token)["nonce"])
    holding = threading.Event()
    results: dict[str, object] = {}

    def marker():
        db = factory()
        try:
            service = AttendanceService(db)
            service.repo.lock_employee_for_attempt(employee_id)
            holding.set()
            results["mark"] = service.check_in(
                employee_id,
                nonce=nonce,
                require_evidence=False,
                device_id=device_id,
                token_device_id=str(device_id),
                marking_token=token,
            )
        except HTTPException as exc:
            db.rollback()
            results["mark"] = exc.status_code
            raise
        finally:
            db.close()

    def resolver():
        db = factory()
        try:
            holding.wait(timeout=5)
            results["resolve"] = AttendanceService(db).resolve_attempt(
                token, reason_code="USER_CANCELLED", device_id=device_id
            )
        except HTTPException as exc:
            db.rollback()
            results["resolve"] = exc.status_code
        finally:
            db.close()

    threads = [
        threading.Thread(target=marker, name="marker-first"),
        threading.Thread(target=resolver, name="resolver-wait"),
    ]
    for thread in threads:
        thread.start()
    _join_finished(threads)

    marked = results.get("mark")
    assert marked is not None and not isinstance(marked, int)
    resolved = results.get("resolve")
    assert isinstance(resolved, dict)
    assert resolved["state"] == "CONFIRMED"
    check = factory()
    try:
        records = list(check.scalars(select(AttendanceRecord).where(AttendanceRecord.employee_id == employee_id)))
        assert len(records) == 1
        assert check.scalar(select(AttendanceAttemptResolution).where(AttendanceAttemptResolution.nonce == nonce)) is None
        _cleanup_attempt(check, employee_id, device_id)
    finally:
        check.close()


def test_resolucion_gana_marcacion_no_crea_evento(pg_engine):
    if "attendance_attempt_resolutions" not in inspect(pg_engine).get_table_names():
        pytest.skip("esquema de resoluciones incompleto")
    from app.modules.attendance.models import AttendanceAttemptResolution, AttendanceRecord

    factory = _two_factory(pg_engine)
    session = factory()
    try:
        employee_id, device_id = _seed_employee_device(session)
    finally:
        session.close()

    token = create_attendance_token(str(employee_id), action="CHECK_IN", device_id=str(device_id))
    nonce = str(decode_attendance_token(token)["nonce"])
    holding = threading.Event()
    results: dict[str, object] = {}
    errors: list[BaseException] = []

    def resolver():
        db = factory()
        try:
            service = AttendanceService(db)
            service.repo.lock_employee_for_attempt(employee_id)
            holding.set()
            results["resolve"] = service.resolve_attempt(
                token, reason_code="USER_CANCELLED", device_id=device_id
            )
        except HTTPException as exc:
            db.rollback()
            results["resolve"] = exc.status_code
        except BaseException as exc:
            errors.append(exc)
            raise
        finally:
            db.close()

    def marker():
        db = factory()
        try:
            holding.wait(timeout=5)
            results["mark"] = AttendanceService(db).check_in(
                employee_id,
                nonce=nonce,
                require_evidence=False,
                device_id=device_id,
                token_device_id=str(device_id),
                marking_token=token,
            )
        except HTTPException as exc:
            db.rollback()
            results["mark"] = exc.status_code
        except BaseException as exc:
            errors.append(exc)
            raise
        finally:
            db.close()

    threads = [
        threading.Thread(target=resolver, name="resolver-first"),
        threading.Thread(target=marker, name="marker-wait"),
    ]
    for thread in threads:
        thread.start()
    _join_finished(threads)
    assert not errors

    resolved = results.get("resolve")
    assert isinstance(resolved, dict) and resolved["state"] == "CANCELLED"
    assert results.get("mark") == 409
    check = factory()
    try:
        records = list(check.scalars(select(AttendanceRecord).where(AttendanceRecord.employee_id == employee_id)))
        assert records == []
        row = check.scalar(select(AttendanceAttemptResolution).where(AttendanceAttemptResolution.nonce == nonce))
        assert row is not None
        assert row.resolution == "CANCELLED_UNCONFIRMED"
        _cleanup_attempt(check, employee_id, device_id)
    finally:
        check.close()


def test_evidencia_vs_resolucion_ambos_ordenes(pg_engine):
    if "attendance_attempt_resolutions" not in inspect(pg_engine).get_table_names():
        pytest.skip("esquema de resoluciones incompleto")
    from tests.image_helpers import valid_jpeg_b64
    from app.modules.attendance.models import AttendanceEvidence

    factory = _two_factory(pg_engine)
    session = factory()
    try:
        employee_id, device_id = _seed_employee_device(session)
    finally:
        session.close()

    token = create_attendance_token(str(employee_id), action="CHECK_IN", device_id=str(device_id))
    holding = threading.Event()
    results: dict[str, object] = {}

    def evidence_first():
        db = factory()
        try:
            service = AttendanceService(db)
            service.repo.lock_employee_for_attempt(employee_id)
            holding.set()
            results["evidence"] = service.store_evidence(
                marking_token=token,
                image_base64=valid_jpeg_b64(),
                content_type="image/jpeg",
                device_id=device_id,
            )
        except HTTPException as exc:
            db.rollback()
            results["evidence"] = exc.status_code
        finally:
            db.close()

    def resolve_wait():
        db = factory()
        try:
            holding.wait(timeout=5)
            results["resolve"] = AttendanceService(db).resolve_attempt(
                token, reason_code="PHOTO_RETAKE", device_id=device_id
            )
        except HTTPException as exc:
            db.rollback()
            results["resolve"] = exc.status_code
        finally:
            db.close()

    threads = [
        threading.Thread(target=evidence_first, name="evidence-first"),
        threading.Thread(target=resolve_wait, name="resolve-after-evidence"),
    ]
    for thread in threads:
        thread.start()
    _join_finished(threads)
    assert not isinstance(results.get("evidence"), int)
    assert isinstance(results.get("resolve"), dict)
    assert results["resolve"]["state"] == "CANCELLED"

    token_b = create_attendance_token(str(employee_id), action="CHECK_IN", device_id=str(device_id))
    holding_b = threading.Event()
    results_b: dict[str, object] = {}

    def resolve_first():
        db = factory()
        try:
            service = AttendanceService(db)
            service.repo.lock_employee_for_attempt(employee_id)
            holding_b.set()
            results_b["resolve"] = service.resolve_attempt(
                token_b, reason_code="PHOTO_RETAKE", device_id=device_id
            )
        except HTTPException as exc:
            db.rollback()
            results_b["resolve"] = exc.status_code
        finally:
            db.close()

    def evidence_wait():
        db = factory()
        try:
            holding_b.wait(timeout=5)
            results_b["evidence"] = AttendanceService(db).store_evidence(
                marking_token=token_b,
                image_base64=valid_jpeg_b64(color=(9, 9, 9)),
                content_type="image/jpeg",
                device_id=device_id,
            )
        except HTTPException as exc:
            db.rollback()
            results_b["evidence"] = exc.status_code
        finally:
            db.close()

    threads_b = [
        threading.Thread(target=resolve_first, name="resolve-first-ev"),
        threading.Thread(target=evidence_wait, name="evidence-after-resolve"),
    ]
    for thread in threads_b:
        thread.start()
    _join_finished(threads_b)
    assert isinstance(results_b.get("resolve"), dict) and results_b["resolve"]["state"] == "CANCELLED"
    assert results_b.get("evidence") == 409
    check = factory()
    try:
        leftover = list(check.scalars(select(AttendanceEvidence).where(AttendanceEvidence.employee_id == employee_id)))
        assert len(leftover) == 1
        _cleanup_attempt(check, employee_id, device_id)
    finally:
        check.close()


def test_dos_resoluciones_simultaneas_una_fila(pg_engine):
    if "attendance_attempt_resolutions" not in inspect(pg_engine).get_table_names():
        pytest.skip("esquema de resoluciones incompleto")
    from sqlalchemy import func
    from app.modules.attendance.models import AttendanceAttemptResolution
    from app.modules.audit.models import AuditLog

    factory = _two_factory(pg_engine)
    session = factory()
    try:
        employee_id, device_id = _seed_employee_device(session)
    finally:
        session.close()

    token = create_attendance_token(str(employee_id), action="CHECK_IN", device_id=str(device_id))
    nonce = str(decode_attendance_token(token)["nonce"])
    barrier = threading.Barrier(2)
    payloads: list[object] = []
    errors: list[BaseException] = []

    def worker():
        db = factory()
        try:
            barrier.wait(timeout=5)
            payloads.append(
                AttendanceService(db).resolve_attempt(token, reason_code="USER_CANCELLED", device_id=device_id)
            )
        except HTTPException as exc:
            payloads.append(exc.status_code)
        except BaseException as exc:
            errors.append(exc)
            raise
        finally:
            db.close()

    threads = [threading.Thread(target=worker, name="resolve-a"), threading.Thread(target=worker, name="resolve-b")]
    for thread in threads:
        thread.start()
    _join_finished(threads)
    assert not errors
    states = [item["state"] for item in payloads if isinstance(item, dict)]
    assert states == ["CANCELLED", "CANCELLED"]
    check = factory()
    try:
        count = check.scalar(
            select(func.count()).select_from(AttendanceAttemptResolution).where(AttendanceAttemptResolution.nonce == nonce)
        )
        assert count == 1
        audits = check.scalar(
            select(func.count())
            .select_from(AuditLog)
            .where(AuditLog.entity_id == employee_id, AuditLog.action == "ATTEMPT_CANCELLED")
        )
        assert audits == 1
        _cleanup_attempt(check, employee_id, device_id)
    finally:
        check.close()


def test_permiso_vence_esperando_el_lock(pg_engine):
    if "attendance_attempt_resolutions" not in inspect(pg_engine).get_table_names():
        pytest.skip("esquema de resoluciones incompleto")
    import time
    from datetime import datetime, timedelta, timezone
    import jwt
    from app.core.config import get_settings
    from app.modules.attendance.models import AttendanceRecord

    factory = _two_factory(pg_engine)
    session = factory()
    try:
        employee_id, device_id = _seed_employee_device(session)
    finally:
        session.close()

    token = create_attendance_token(str(employee_id), action="CHECK_IN", device_id=str(device_id), minutes=1)
    nonce = str(decode_attendance_token(token)["nonce"])
    locked = threading.Event()
    results: dict[str, object] = {}
    errors: list[BaseException] = []

    def holder():
        db = factory()
        try:
            AttendanceService(db).repo.lock_employee_for_attempt(employee_id)
            locked.set()
            time.sleep(1.5)
        except BaseException as exc:
            errors.append(exc)
            raise
        finally:
            db.rollback()
            db.close()

    def late_mark():
        db = factory()
        try:
            assert locked.wait(timeout=5)
            settings = get_settings()
            payload = jwt.decode(
                token,
                settings.secret_key,
                algorithms=[settings.jwt_algorithm],
                options={"verify_exp": False},
            )
            payload["exp"] = datetime.now(timezone.utc) - timedelta(seconds=5)
            expired = jwt.encode(payload, settings.secret_key, algorithm=settings.jwt_algorithm)
            results["mark"] = AttendanceService(db).check_in(
                employee_id,
                nonce=nonce,
                require_evidence=False,
                device_id=device_id,
                token_device_id=str(device_id),
                marking_token=expired,
            )
        except HTTPException as exc:
            db.rollback()
            results["mark"] = exc.status_code
        except BaseException as exc:
            errors.append(exc)
            raise
        finally:
            db.close()

    threads = [
        threading.Thread(target=holder, name="lock-holder"),
        threading.Thread(target=late_mark, name="expired-writer"),
    ]
    for thread in threads:
        thread.start()
    _join_finished(threads, timeout=20)
    assert not errors
    assert results.get("mark") == 401
    check = factory()
    try:
        records = list(check.scalars(select(AttendanceRecord).where(AttendanceRecord.employee_id == employee_id)))
        assert records == []
        _cleanup_attempt(check, employee_id, device_id)
    finally:
        check.close()


def test_purge_vs_marcacion_no_borra_confirmada(pg_engine):
    if "attendance_attempt_resolutions" not in inspect(pg_engine).get_table_names():
        pytest.skip("esquema de resoluciones incompleto")
    from datetime import datetime, timedelta, timezone

    from tests.image_helpers import valid_jpeg_b64
    from app.modules.attendance.models import AttendanceEvidence, AttendanceRecord

    factory = _two_factory(pg_engine)
    session = factory()
    try:
        employee_id, device_id = _seed_employee_device(session)
    finally:
        session.close()

    token = create_attendance_token(str(employee_id), action="CHECK_IN", device_id=str(device_id))
    nonce = str(decode_attendance_token(token)["nonce"])
    setup = factory()
    try:
        AttendanceService(setup).store_evidence(
            marking_token=token,
            image_base64=valid_jpeg_b64(),
            content_type="image/jpeg",
            device_id=device_id,
        )
        row = setup.scalar(select(AttendanceEvidence).where(AttendanceEvidence.nonce == nonce))
        row.captured_at = datetime.now(timezone.utc) - timedelta(hours=48)
        setup.add(row)
        setup.commit()
    finally:
        setup.close()

    barrier = threading.Barrier(2)
    results: dict[str, object] = {}

    def marker():
        db = factory()
        try:
            barrier.wait(timeout=5)
            results["mark"] = AttendanceService(db).check_in(
                employee_id,
                nonce=nonce,
                require_evidence=True,
                device_id=device_id,
                token_device_id=str(device_id),
                marking_token=token,
            )
        except HTTPException as ext:
            db.rollback()
            results["mark"] = ext.status_code
        finally:
            db.close()

    def purger():
        db = factory()
        try:
            barrier.wait(timeout=5)
            results["purge"] = AttendanceService(db).purge_abandoned_evidence(older_than_hours=24)
        except HTTPException as ext:
            db.rollback()
            results["purge"] = ext.status_code
        finally:
            db.close()

    threads = [
        threading.Thread(target=marker, name="purge-mark"),
        threading.Thread(target=purger, name="purge-clean"),
    ]
    for thread in threads:
        thread.start()
    _join_finished(threads)
    assert not isinstance(results.get("mark"), int)
    purge = results.get("purge")
    assert isinstance(purge, dict) and purge.get("deleted") == 0
    check = factory()
    try:
        evidence = check.scalar(select(AttendanceEvidence).where(AttendanceEvidence.nonce == nonce))
        records = list(check.scalars(select(AttendanceRecord).where(AttendanceRecord.employee_id == employee_id)))
        assert evidence is not None
        assert evidence.attendance_record_id is not None
        assert len(records) == 1
        _cleanup_attempt(check, employee_id, device_id)
    finally:
        check.close()
