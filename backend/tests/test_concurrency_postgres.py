"""Concurrencia de planilla y marcación (requiere PostgreSQL)."""

import os
import threading
import time
import uuid
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine, func, inspect, select, text
from sqlalchemy.orm import sessionmaker

from app.core.security import create_attendance_token, decode_attendance_token
from app.core.test_db import assert_disposable_postgres_url
from app.db.base import Base
import app.modules  # noqa: F401
from app.modules.attendance.models import AttendanceConsumedNonce, AttendanceRecord
from app.modules.attendance.service import AttendanceService
from app.modules.adjustments.models import HourAdjustment
from app.modules.adjustments.service import AdjustmentService
from app.modules.employees.models import Employee
from app.modules.job_roles.models import JobRole
from app.modules.payroll.models import PERIOD_CALCULATED, PERIOD_CLOSED, PayrollPeriod, PayrollRecord
from app.modules.payroll.service import PayrollService
from app.modules.attendance.manual_models import ManualAttendanceDay, ManualRecoveryApplication, RecoveryCommitment
from app.modules.attendance.manual_schemas import ManualBatchIn, ManualDayIn, ManualUpdateIn, RecoveryAllocationIn
from app.modules.attendance.manual_service import ManualAttendanceService
from app.modules.attendance.manual_operations import lock_operation
from app.modules.salary.models import SalarySetting
from app.modules.schedules.models import WorkSchedule
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


def test_overtime_approval_applies_one_daily_break_under_concurrency(pg_engine):
    """Un solo refrigerio diario: dos sobretiempos simultáneos, uno gana con 60/240."""
    factory = _two_factory(pg_engine)
    setup = factory()
    try:
        employee_id, period_id, record_id = _seed_employee_and_period(setup)
        actor_id = _manual_actor(setup)
        setup.add(SalarySetting(
            employee_id=employee_id, monthly_salary=Decimal("1500.00"),
            overtime_enabled=True, effective_from=date(2026, 8, 1),
        ))
        setup.add(WorkSchedule(
            employee_id=employee_id, effective_from=date(2026, 8, 1),
            monday_minutes=300, tuesday_minutes=300, wednesday_minutes=300,
            thursday_minutes=300, friday_minutes=300, saturday_minutes=300,
            break_minutes=60, break_applies_after_minutes=360,
        ))
        setup.add(AttendanceRecord(
            employee_id=employee_id, work_date=date(2026, 9, 10),
            check_in_at=datetime(2026, 9, 10, 13, tzinfo=timezone.utc),
            check_out_at=datetime(2026, 9, 10, 18, tzinfo=timezone.utc),
            worked_minutes=300, status="COMPLETE",
        ))
        setup.commit()
    finally:
        setup.close()

    work_date = date(2026, 9, 10)
    barrier = threading.Barrier(2)
    outcomes: list[object] = []
    created_ids: list[uuid.UUID] = []
    lock = threading.Lock()

    def create_overtime():
        db = factory()
        try:
            barrier.wait(timeout=5)
            adjustment = AdjustmentService(db).create(
                employee_id=employee_id, adjustment_date=work_date, minutes=300,
                adjustment_type="OVERTIME", reason="Sobretiempo concurrente",
            )
            with lock:
                created_ids.append(adjustment.id)
            outcomes.append(adjustment)
        except HTTPException as exc:
            db.rollback()
            outcomes.append(exc.status_code)
        finally:
            db.close()

    threads = [threading.Thread(target=create_overtime), threading.Thread(target=create_overtime)]
    for thread in threads:
        thread.start()
    _join_finished(threads)
    # El lock por empleado serializa: exactamente una jornada gana y la otra
    # recibe el 409 de "ya existe un ajuste de horas extra para la jornada".
    assert len(created_ids) == 1
    assert outcomes.count(409) == 1

    approve = factory()
    try:
        approved = AdjustmentService(approve).approve(created_ids[0], actor_id)
        valuation = (approved.approval_snapshot_data or {}).get("valuation") or {}
        assert approved.minutes == 300
        assert valuation["requested_minutes"] == 300
        assert valuation["break_minutes"] == 60
        assert valuation["minutes"] == 240
        approve.execute(text("DELETE FROM adjustment_operation_receipts WHERE target_adjustment_id = :id"), {"id": created_ids[0]})
        approve.execute(text("DELETE FROM hour_adjustments WHERE employee_id = :id"), {"id": employee_id})
        approve.execute(text("DELETE FROM attendance_records WHERE employee_id = :id"), {"id": employee_id})
        approve.execute(text("DELETE FROM work_schedules WHERE employee_id = :id"), {"id": employee_id})
        approve.execute(text("DELETE FROM salary_settings WHERE employee_id = :id"), {"id": employee_id})
        approve.commit()
        _cleanup_payroll(approve, period_id, record_id)
    finally:
        approve.close()


def test_hst01_a30_same_idempotency_key_has_one_effective_creation(pg_engine):
    """A30: una respuesta perdida se puede recuperar; nunca duplica la jornada."""
    factory = _two_factory(pg_engine)
    setup = factory()
    try:
        employee_id, period_id, record_id = _seed_employee_and_period(setup)
        actor_id = _manual_actor(setup)
    finally:
        setup.close()

    payload = _manual_payload(employee_id, date(2026, 9, 12), key=f"a30-{uuid.uuid4().hex}")
    barrier = threading.Barrier(2)
    outcomes: list[object] = []

    def create_same_request():
        db = factory()
        try:
            barrier.wait(timeout=5)
            outcomes.append(ManualAttendanceService(db).batch(payload, actor_id))
        except HTTPException as exc:
            db.rollback()
            outcomes.append(exc.status_code)
        finally:
            db.close()

    threads = [threading.Thread(target=create_same_request), threading.Thread(target=create_same_request)]
    for thread in threads:
        thread.start()
    _join_finished(threads)
    # The transaction advisory lock serializes the same key: both callers
    # receive the committed receipt, not a false MANUAL_DAY_EXISTS conflict.
    assert len(outcomes) == 2 and all(isinstance(item, dict) for item in outcomes)
    assert outcomes[0] == outcomes[1]

    check = factory()
    try:
        active = list(check.scalars(select(ManualAttendanceDay).where(
            ManualAttendanceDay.employee_id == employee_id,
            ManualAttendanceDay.work_date == date(2026, 9, 12),
            ManualAttendanceDay.voided_at.is_(None),
        )))
        assert len(active) == 1
        replay = ManualAttendanceService(check).batch(payload, actor_id)
        assert replay == next(item for item in outcomes if isinstance(item, dict))
        check.execute(text("DELETE FROM manual_attendance_idempotency"))
        check.execute(text("DELETE FROM manual_attendance_days WHERE employee_id = :id"), {"id": employee_id})
        _cleanup_payroll(check, period_id, record_id)
    finally:
        check.close()


def test_h693_same_key_can_continue_after_first_transaction_rolls_back(pg_engine):
    """C02: el advisory lock no reserva una clave cuando la primera transacción revierte."""
    factory = _two_factory(pg_engine)
    setup = factory()
    try:
        employee_id, period_id, record_id = _seed_employee_and_period(setup)
        actor_id = _manual_actor(setup)
    finally:
        setup.close()
    key = f"c02-{uuid.uuid4().hex}"
    payload = _manual_payload(employee_id, date(2026, 9, 13), key=key)
    first = factory(); lock_operation(first, key)
    pid_ready = threading.Event(); outcomes: list[object] = []

    def second_request():
        db = factory()
        try:
            pid = db.scalar(text("SELECT pg_backend_pid()"))
            outcomes.append(("pid", pid)); pid_ready.set()
            outcomes.append(ManualAttendanceService(db).batch(payload, actor_id))
        except Exception as exc:  # surfaced below; never accepted as success
            outcomes.append(exc)
        finally:
            db.close()

    thread = threading.Thread(target=second_request); thread.start()
    assert pid_ready.wait(timeout=5)
    pid = next(value for label, value in outcomes if isinstance((label, value), tuple) and label == "pid")
    observer = factory()
    try:
        waiting = False
        for _ in range(100):
            waiting = observer.scalar(text("SELECT wait_event_type = 'Lock' FROM pg_stat_activity WHERE pid = :pid"), {"pid": pid}) is True
            if waiting: break
            time.sleep(0.02)
        assert waiting, "la segunda conexión no alcanzó el advisory lock"
    finally:
        observer.close()
    first.rollback(); first.close()
    _join_finished([thread])
    results = [item for item in outcomes if isinstance(item, dict)]
    assert len(results) == 1
    check = factory()
    try:
        assert check.query(ManualAttendanceDay).filter_by(employee_id=employee_id, work_date=date(2026, 9, 13)).count() == 1
        assert check.execute(text("SELECT COUNT(*) FROM manual_attendance_idempotency WHERE idempotency_key = :key"), {"key": key}).scalar_one() == 1
        check.execute(text("DELETE FROM manual_attendance_idempotency"))
        check.execute(text("DELETE FROM manual_attendance_days WHERE employee_id = :id"), {"id": employee_id})
        _cleanup_payroll(check, period_id, record_id)
    finally:
        check.close()


def test_h693_advisory_lock_timeout_is_controlled_and_keeps_same_key(pg_engine):
    """C13: un lock ocupado termina en OPERATION_IN_PROGRESS, no en éxito falso."""
    factory = _two_factory(pg_engine)
    key = f"c13-{uuid.uuid4().hex}"
    holder = factory(); contender = factory()
    try:
        lock_operation(holder, key)
        with pytest.raises(HTTPException) as raised:
            lock_operation(contender, key)
        assert raised.value.status_code == 503
        assert raised.value.detail["code"] == "OPERATION_IN_PROGRESS"
    finally:
        contender.close(); holder.rollback(); holder.close()


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


def test_hst01_a31_correct_record_and_batch_leave_one_source_per_day(pg_engine):
    """A31: corrección que cruza de fecha y batch toman primero Employee."""
    factory = _two_factory(pg_engine)
    setup = factory()
    try:
        employee_id, period_id, record_id = _seed_employee_and_period(setup)
        actor_id = _manual_actor(setup)
        original_day, target_day = date(2026, 9, 10), date(2026, 9, 11)
        start = datetime(2026, 9, 10, 13, tzinfo=timezone.utc)
        record = AttendanceRecord(
            employee_id=employee_id, work_date=original_day,
            check_in_at=start, check_out_at=start + timedelta(minutes=60),
            worked_minutes=60, status="COMPLETE",
        )
        setup.add(record); setup.commit()
        attendance_id = record.id
    finally:
        setup.close()

    barrier = threading.Barrier(2)
    outcomes: list[object] = []

    def correct():
        db = factory()
        try:
            barrier.wait(timeout=5)
            shifted = datetime(2026, 9, 11, 13, tzinfo=timezone.utc)
            outcomes.append(AttendanceService(db).correct_record(
                attendance_id, reason="Corrección A31 de fecha", current_user_id=actor_id,
                check_in_at=shifted, check_out_at=shifted + timedelta(minutes=60),
            ))
        except HTTPException as exc:
            db.rollback(); outcomes.append(exc.status_code)
        finally:
            db.close()

    def batch():
        db = factory()
        try:
            barrier.wait(timeout=5)
            outcomes.append(ManualAttendanceService(db).batch(
                _manual_payload(employee_id, target_day, normal=60, key=f"a31-{uuid.uuid4().hex}"), actor_id
            ))
        except HTTPException as exc:
            db.rollback(); outcomes.append(exc.status_code)
        finally:
            db.close()

    threads = [threading.Thread(target=correct), threading.Thread(target=batch)]
    for thread in threads:
        thread.start()
    _join_finished(threads)
    assert sum(item == 409 for item in outcomes) == 1
    assert len(outcomes) == 2

    check = factory()
    try:
        session_count = check.scalar(select(func.count()).select_from(AttendanceRecord).where(
            AttendanceRecord.employee_id == employee_id, AttendanceRecord.work_date == target_day
        ))
        manual_count = check.scalar(select(func.count()).select_from(ManualAttendanceDay).where(
            ManualAttendanceDay.employee_id == employee_id, ManualAttendanceDay.work_date == target_day,
            ManualAttendanceDay.voided_at.is_(None),
        ))
        assert int(session_count or 0) + int(manual_count or 0) == 1
        check.execute(text("DELETE FROM manual_attendance_idempotency"))
        check.execute(text("DELETE FROM manual_attendance_days WHERE employee_id = :id"), {"id": employee_id})
        check.execute(text("DELETE FROM attendance_records WHERE employee_id = :id"), {"id": employee_id})
        _cleanup_payroll(check, period_id, record_id)
    finally:
        check.close()


def test_hst01_overtime_adjustment_and_manual_p_are_exclusive_under_race(pg_engine):
    """P y OVERTIME legado no pasan simultáneamente las guardas recíprocas."""
    factory = _two_factory(pg_engine)
    setup = factory()
    try:
        employee_id, period_id, record_id = _seed_employee_and_period(setup)
        actor_id = _manual_actor(setup)
    finally:
        setup.close()

    work_date = date(2026, 9, 12)
    payload = ManualBatchIn(
        work_date=work_date, idempotency_key=f"p-vs-overtime-{uuid.uuid4().hex}",
        rows=[ManualDayIn(
            employee_id=employee_id, worked_minutes_net=60, normal_minutes=0,
            additional_minutes=60, recovery_minutes=0, payment_method="OVERTIME",
            reason="P concurrente con ajuste legado",
        )],
    )
    barrier = threading.Barrier(2)
    outcomes: list[object] = []

    def create_manual():
        db = factory()
        try:
            barrier.wait(timeout=5)
            outcomes.append(ManualAttendanceService(db).batch(payload, actor_id))
        except HTTPException as exc:
            db.rollback(); outcomes.append(exc.status_code)
        finally:
            db.close()

    def create_overtime():
        db = factory()
        try:
            barrier.wait(timeout=5)
            outcomes.append(AdjustmentService(db).create(
                employee_id=employee_id, adjustment_date=work_date, minutes=60,
                adjustment_type="OVERTIME", reason="Legado concurrente",
            ))
        except HTTPException as exc:
            db.rollback(); outcomes.append(exc.status_code)
        finally:
            db.close()

    threads = [threading.Thread(target=create_manual), threading.Thread(target=create_overtime)]
    for thread in threads:
        thread.start()
    _join_finished(threads)
    assert outcomes.count(409) == 1

    check = factory()
    try:
        manual_count = check.scalar(select(func.count()).select_from(ManualAttendanceDay).where(
            ManualAttendanceDay.employee_id == employee_id, ManualAttendanceDay.work_date == work_date,
            ManualAttendanceDay.additional_minutes > 0, ManualAttendanceDay.voided_at.is_(None),
        ))
        overtime_count = check.scalar(select(func.count()).select_from(HourAdjustment).where(
            HourAdjustment.employee_id == employee_id, HourAdjustment.adjustment_date == work_date,
            HourAdjustment.adjustment_type == "OVERTIME", HourAdjustment.status.in_(("PENDING", "APPROVED")),
        ))
        assert int(manual_count or 0) + int(overtime_count or 0) == 1
        check.execute(text("DELETE FROM manual_attendance_idempotency"))
        check.execute(text("DELETE FROM manual_attendance_days WHERE employee_id = :id"), {"id": employee_id})
        check.execute(text("DELETE FROM hour_adjustments WHERE employee_id = :id"), {"id": employee_id})
        _cleanup_payroll(check, period_id, record_id)
    finally:
        check.close()


def test_hst01_a32_approval_and_void_leave_no_approved_old_version(pg_engine):
    """A32: aprobar y anular compiten sobre la misma versión, con un solo ganador."""
    factory = _two_factory(pg_engine)
    setup = factory()
    try:
        employee_id, period_id, record_id = _seed_employee_and_period(setup)
        actor_id = _manual_actor(setup)
        payload = ManualBatchIn(
            work_date=date(2026, 9, 13),
            idempotency_key=f"a32-{uuid.uuid4().hex}",
            rows=[ManualDayIn(
                employee_id=employee_id,
                worked_minutes_net=60,
                normal_minutes=0,
                additional_minutes=60,
                recovery_minutes=0,
                payment_method="REVIEWED",
                payment_concept="Trabajo especial",
                source_reference="Acta A32",
                reviewed_additional_amount=Decimal("20.00"),
                reason="Aprobación concurrente",
            )],
        )
        created = ManualAttendanceService(setup).batch(payload, actor_id)
        item = setup.get(ManualAttendanceDay, uuid.UUID(created["created"][0]))
        assert item is not None
        item_id, snapshot, version = item.id, dict(item.payment_snapshot or {}), item.version
    finally:
        setup.close()

    barrier = threading.Barrier(2)
    outcomes: list[object] = []

    def approve():
        db = factory()
        try:
            barrier.wait(timeout=5)
            outcomes.append(ManualAttendanceService(db).approve(item_id, actor_id, version, snapshot))
        except HTTPException as exc:
            db.rollback()
            outcomes.append(exc.status_code)
        finally:
            db.close()

    def void():
        db = factory()
        try:
            barrier.wait(timeout=5)
            outcomes.append(ManualAttendanceService(db).void(item_id, version, "Anulación A32", actor_id))
        except HTTPException as exc:
            db.rollback()
            outcomes.append(exc.status_code)
        finally:
            db.close()

    threads = [threading.Thread(target=approve), threading.Thread(target=void)]
    for thread in threads:
        thread.start()
    _join_finished(threads)
    assert sum(isinstance(item, dict) for item in outcomes) == 1
    assert outcomes.count(409) == 1

    check = factory()
    try:
        persisted = check.get(ManualAttendanceDay, item_id)
        assert persisted is not None
        if persisted.voided_at:
            assert persisted.payment_status != "APPROVED"
        else:
            assert persisted.payment_status == "APPROVED" and persisted.version == version + 1
        check.execute(text("DELETE FROM manual_attendance_idempotency"))
        check.execute(text("DELETE FROM manual_attendance_days WHERE employee_id = :id"), {"id": employee_id})
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
                        preview_token="f" * 64,
                        idempotency_key=f"f04-edit-{uuid.uuid4().hex}",
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
