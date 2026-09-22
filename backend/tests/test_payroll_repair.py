"""Reparación auditada de referencia de descanso y refrigerio combinado."""
import uuid
from datetime import date, datetime, timezone
from decimal import Decimal

from sqlalchemy import select

from app.modules.adjustments.models import HourAdjustment
from app.modules.attendance.manual_models import ManualAttendanceDay
from app.modules.attendance.models import AttendanceRecord
from app.modules.payroll.models import PayrollPeriod
from app.modules.payroll.repair_service import PayrollRepairService
from app.modules.users.models import User
from app.modules.work_calendar.models import (
    EmployeeWeeklyRestRule,
    SpecialDayValuation,
    VALUATION_APPROVED,
)


def _login(client):
    assert client.post("/api/v1/auth/login", json={"username": "admin", "password": "Admin123!"}).status_code == 200


def _employee(client, db_session, *, schedule_minutes: int = 300):
    created = client.post("/api/v1/employees", json={
        "dni": "74561299", "employee_code": "REPAIR-01", "first_name": "Repara",
        "last_name": "Prueba", "job_role_id": str(db_session._test_job_roles["Operario"]),
        "hire_date": "2026-08-01",
    })
    assert created.status_code == 201, created.text
    employee_id = created.json()["id"]
    assert client.post(f"/api/v1/employees/{employee_id}/salary-settings", json={
        "effective_from": "2026-08-01", "monthly_salary": "650.00", "overtime_enabled": True,
    }).status_code == 201
    assert client.post(f"/api/v1/employees/{employee_id}/schedule", json={
        "effective_from": "2026-08-01", "monday_minutes": schedule_minutes,
        "tuesday_minutes": schedule_minutes, "wednesday_minutes": schedule_minutes,
        "thursday_minutes": schedule_minutes, "friday_minutes": schedule_minutes,
        "saturday_minutes": schedule_minutes, "break_minutes": 60,
        "break_applies_after_minutes": 360,
    }).status_code == 201
    return employee_id


def _admin_id(db_session):
    return db_session.scalar(select(User).where(User.username == "admin")).id


def _stale_rule(client, employee_id):
    response = client.post("/api/v1/work-calendar/weekly-rest-rules", json={
        "employee_id": employee_id, "weekly_rest_weekday": 6, "reference_daily_minutes": 480,
        "source": "Contrato", "reason": "Referencia obsoleta", "effective_from": "2026-08-01",
    })
    assert response.status_code == 201, response.text
    return response.json()


def test_repair_dry_run_then_apply_is_idempotent(client, db_session):
    _login(client)
    employee_id = _employee(client, db_session)
    rule = _stale_rule(client, employee_id)
    employee_uuid = uuid.UUID(employee_id)
    # Valoración aprobada con la referencia obsoleta (dato legado).
    db_session.add(SpecialDayValuation(
        employee_id=employee_uuid, work_date=date(2026, 8, 2), source_kind="WEEKLY_REST",
        status=VALUATION_APPROVED, worked_minutes=300, reference_daily_minutes=480,
        amount=Decimal("27.08"), calculation={}, version=1,
    ))
    # Sobretiempo aprobado sin snapshot (fila dinámica legada) con presencia de kiosco.
    db_session.add(AttendanceRecord(
        employee_id=employee_uuid, work_date=date(2026, 8, 6),
        check_in_at=datetime(2026, 8, 6, 13, tzinfo=timezone.utc),
        check_out_at=datetime(2026, 8, 6, 18, tzinfo=timezone.utc), worked_minutes=300, status="COMPLETE",
    ))
    db_session.add(HourAdjustment(
        employee_id=employee_uuid, adjustment_date=date(2026, 8, 6), minutes=300,
        adjustment_type="OVERTIME", status="APPROVED", reason="Legado sin snapshot",
        approval_snapshot_data=None, version=1,
    ))
    # Carga histórica aprobada cuyo snapshot ignora el refrigerio combinado.
    db_session.add(ManualAttendanceDay(
        employee_id=employee_uuid, work_date=date(2026, 8, 7), worked_minutes_net=600,
        normal_minutes=300, additional_minutes=300, recovery_minutes=0,
        reason="Carga legada", payment_status="APPROVED", payment_method="OVERTIME",
        payment_snapshot={"status": "APPROVED", "amount": "22.53", "minutes": 300, "break_minutes": 0},
        approved_additional_amount=Decimal("22.53"), version=1,
        created_by_user_id=_admin_id(db_session),
    ))
    db_session.commit()

    service = PayrollRepairService(db_session)
    audit = service.audit(employee_id=employee_uuid)
    kinds = {action["action"] for action in audit["actions"]}
    assert "CORRECT_WEEKLY_REST_RULE" in kinds
    assert "REVISE_APPROVED_OVERTIME" in kinds
    assert "REVISE_APPROVED_MANUAL_PAYMENT" in kinds
    assert "REVIEW_SPECIAL_DAY_VALUATION" in kinds
    # El dry-run no muta nada.
    stored_rule = db_session.scalar(select(EmployeeWeeklyRestRule).where(EmployeeWeeklyRestRule.id == uuid.UUID(rule["id"])))
    assert stored_rule.reference_daily_minutes == 480
    assert stored_rule.version == 1

    applied = service.apply(
        actor_user_id=_admin_id(db_session),
        reason="Reparación de referencia de descanso",
        employee_id=employee_uuid,
    )
    assert applied["dry_run"] is False
    assert len(applied["applied"]) >= 3
    db_session.expire_all()
    corrected = db_session.scalar(
        select(EmployeeWeeklyRestRule)
        .where(EmployeeWeeklyRestRule.employee_id == employee_uuid)
        .order_by(EmployeeWeeklyRestRule.version.desc())
    )
    assert corrected.reference_daily_minutes == 300
    assert corrected.version == 2
    valuation = db_session.scalar(select(SpecialDayValuation).where(SpecialDayValuation.employee_id == employee_uuid))
    assert valuation.status == "PENDING"
    replacement = db_session.scalar(
        select(HourAdjustment).where(
            HourAdjustment.employee_id == employee_uuid,
            HourAdjustment.voided_at.is_(None),
        )
    )
    assert replacement is not None and replacement.status == "PENDING"
    manual_replacement = db_session.scalar(select(ManualAttendanceDay).where(
        ManualAttendanceDay.employee_id == employee_uuid,
        ManualAttendanceDay.voided_at.is_(None),
    ))
    assert manual_replacement is not None and manual_replacement.payment_status == "PENDING"
    assert manual_replacement.payment_snapshot["break_minutes"] == 60
    assert manual_replacement.payment_snapshot["minutes"] == 240

    # Idempotente: una segunda pasada no encuentra trabajo pendiente.
    second = service.audit(employee_id=employee_uuid)
    assert second["actions"] == []


def test_repair_reopens_calculated_period_for_recalculation(client, db_session):
    _login(client)
    employee_id = _employee(client, db_session)
    _stale_rule(client, employee_id)
    employee_uuid = uuid.UUID(employee_id)
    db_session.add(SpecialDayValuation(
        employee_id=employee_uuid, work_date=date(2026, 8, 2), source_kind="WEEKLY_REST",
        status=VALUATION_APPROVED, worked_minutes=300, reference_daily_minutes=480,
        amount=Decimal("27.08"), calculation={}, version=1,
    ))
    period_id = uuid.uuid4()
    db_session.add(PayrollPeriod(
        id=period_id, root_period_id=period_id, name="Agosto calculado",
        start_date=date(2026, 8, 1), end_date=date(2026, 8, 31),
        status="CALCULATED", inputs_fingerprint="stale",
    ))
    db_session.commit()

    PayrollRepairService(db_session).apply(
        actor_user_id=_admin_id(db_session),
        reason="Reparación que reabre el cálculo",
        employee_id=employee_uuid,
    )
    db_session.expire_all()
    period = db_session.get(PayrollPeriod, period_id)
    assert period.status == "OPEN"
    assert period.inputs_fingerprint is None
    # El recálculo posterior es determinista y no crea otra versión.
    recalculated = client.post(f"/api/v1/payroll/periods/{period_id}/calculate")
    assert recalculated.status_code == 200, recalculated.text
    db_session.expire_all()
    assert db_session.get(PayrollPeriod, period_id).status == "CALCULATED"


def test_closed_period_requires_rectification_before_repair(client, db_session):
    _login(client)
    employee_id = _employee(client, db_session)
    _stale_rule(client, employee_id)
    employee_uuid = uuid.UUID(employee_id)
    period_id = uuid.uuid4()
    db_session.add(PayrollPeriod(
        id=period_id, root_period_id=period_id, name="Agosto cerrado",
        start_date=date(2026, 8, 1), end_date=date(2026, 8, 31), status="CLOSED",
    ))
    db_session.commit()
    rectification = client.post(f"/api/v1/payroll/periods/{period_id}/rectifications", json={
        "reason": "Rectificación autorizada por gerencia",
    })
    assert rectification.status_code == 201, rectification.text
    assert rectification.json()["status"] == "OPEN"
    assert rectification.json()["supersedes_period_id"] == str(period_id)


def test_repair_reports_closed_periods_without_mutating(client, db_session):
    _login(client)
    employee_id = _employee(client, db_session)
    rule = _stale_rule(client, employee_id)
    employee_uuid = uuid.UUID(employee_id)
    period_id = uuid.uuid4()
    db_session.add(PayrollPeriod(
        id=period_id, root_period_id=period_id, name="Agosto cerrado",
        start_date=date(2026, 8, 1), end_date=date(2026, 8, 31), status="CLOSED",
    ))
    db_session.commit()

    service = PayrollRepairService(db_session)
    audit = service.audit(employee_id=employee_uuid)
    assert audit["closed_periods_requiring_rectification"]
    assert audit["closed_periods_requiring_rectification"][0]["reason"] == "PAYROLL_CLOSED_RECTIFICATION_REQUIRED"

    applied = service.apply(
        actor_user_id=_admin_id(db_session),
        reason="Intento sobre cerrado",
        employee_id=employee_uuid,
    )
    # La regla cerrada no se mutó y el cierre quedó reportado.
    db_session.expire_all()
    stored_rule = db_session.scalar(select(EmployeeWeeklyRestRule).where(EmployeeWeeklyRestRule.id == uuid.UUID(rule["id"])))
    assert stored_rule.reference_daily_minutes == 480
    assert stored_rule.version == 1
    assert any(item["action"] == "PAYROLL_RECTIFICATION_REQUIRED" for item in applied["skipped"])


def test_manual_payment_is_not_mutated_when_latest_period_is_closed(client, db_session):
    """Un CLOSED es inmutable: la fila aprobada no se anula ni versiona; se reporta."""
    _login(client)
    employee_id = _employee(client, db_session)
    employee_uuid = uuid.UUID(employee_id)
    work_date = date(2026, 8, 7)
    period_id = uuid.uuid4()
    db_session.add(PayrollPeriod(
        id=period_id, root_period_id=period_id, name="Agosto cerrado",
        start_date=date(2026, 8, 1), end_date=date(2026, 8, 31), status="CLOSED",
    ))
    manual = ManualAttendanceDay(
        employee_id=employee_uuid, work_date=work_date, worked_minutes_net=600,
        normal_minutes=300, additional_minutes=300, recovery_minutes=0,
        reason="Carga aprobada con refrigerio obsoleto", payment_status="APPROVED",
        payment_method="OVERTIME",
        payment_snapshot={"status": "APPROVED", "amount": "22.53", "minutes": 300, "break_minutes": 0},
        approved_additional_amount=Decimal("22.53"), version=1,
        created_by_user_id=_admin_id(db_session),
    )
    db_session.add(manual)
    db_session.commit()
    manual_id = manual.id

    service = PayrollRepairService(db_session)
    audit = service.audit(employee_id=employee_uuid)
    assert any(action["action"] == "REVISE_APPROVED_MANUAL_PAYMENT" for action in audit["actions"])
    assert audit["closed_periods_requiring_rectification"]

    applied = service.apply(
        actor_user_id=_admin_id(db_session),
        reason="Intento de reparación sobre un cierre",
        employee_id=employee_uuid,
    )
    db_session.expire_all()
    stored = db_session.get(ManualAttendanceDay, manual_id)
    assert stored is not None
    assert stored.voided_at is None
    assert stored.payment_status == "APPROVED"
    assert stored.version == 1
    assert stored.payment_snapshot["break_minutes"] == 0
    assert any(item.get("action") == "REVISE_APPROVED_MANUAL_PAYMENT" for item in applied["skipped"])
    assert any(item.get("action") == "PAYROLL_RECTIFICATION_REQUIRED" for item in applied["skipped"])
    # No se creó una versión de reemplazo que dejara la fila original en revisión.
    versions = list(db_session.scalars(select(ManualAttendanceDay).where(ManualAttendanceDay.employee_id == employee_uuid)))
    assert len(versions) == 1


def test_audit_finds_active_rule_effective_before_interval(client, db_session):
    """Una regla vigente anterior al rango consultado sigue gobernando el intervalo."""
    _login(client)
    employee_id = _employee(client, db_session)
    employee_uuid = uuid.UUID(employee_id)
    _stale_rule(client, employee_id)

    audit = PayrollRepairService(db_session).audit(
        employee_id=employee_uuid, date_from=date(2026, 9, 1), date_to=date(2026, 9, 30)
    )
    rules = [action for action in audit["actions"] if action["action"] == "CORRECT_WEEKLY_REST_RULE"]
    assert len(rules) == 1
    assert rules[0]["effective_from"] == "2026-08-01"
    assert rules[0]["current_reference_minutes"] == 480
    assert rules[0]["expected_reference_minutes"] == 300
