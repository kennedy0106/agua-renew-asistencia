"""Refrigerio real posterior al cierre de la jornada (SQLite en memoria)."""

import uuid
from datetime import datetime, timedelta, timezone

from app.core.timezone import lima_tz
from app.modules.attendance.models import ATTENDANCE_COMPLETE, ATTENDANCE_OPEN, AttendanceBreakOverride, AttendanceRecord
from app.modules.audit.models import AuditLog
from app.modules.payroll.models import PERIOD_CALCULATED, PERIOD_CLOSED, PERIOD_OPEN, PayrollPeriod


def _login(client, username="admin", password="Admin123!"):
    assert client.post("/api/v1/auth/login", json={"username": username, "password": password}).status_code == 200


def _employee(client, db_session):
    response = client.post("/api/v1/employees", json={
        "dni": "72845632", "employee_code": "EMP-001", "first_name": "Juan", "last_name": "Pérez",
        "job_role_id": str(db_session._test_job_roles["Operario"]),
    })
    assert response.status_code == 201
    return response.json()["id"]


def _complete(db_session, employee_id, *, minutes=420, work_date=None):
    work_date = work_date or datetime.now(lima_tz()).date()
    start = datetime.combine(work_date, datetime.min.time(), tzinfo=timezone.utc).replace(hour=12)
    record = AttendanceRecord(employee_id=uuid.UUID(employee_id), work_date=work_date, check_in_at=start,
                              check_out_at=start + timedelta(minutes=minutes), worked_minutes=minutes,
                              status=ATTENDANCE_COMPLETE)
    db_session.add(record); db_session.commit()
    return work_date


def _url(employee_id, work_date):
    return f"/api/v1/attendance/daily/{employee_id}/{work_date}/break"


def test_override_real_0_30_60_and_audit(client, db_session):
    _login(client)
    employee_id = _employee(client, db_session)
    day = _complete(db_session, employee_id, minutes=420)
    for minutes in (0, 30, 60):
        response = client.put(_url(employee_id, day), json={"requested_break_minutes": minutes, "reason": "Demanda operativa"})
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["gross_minutes"] == 420
        assert body["break_minutes"] == minutes
        assert body["worked_minutes"] == 420 - minutes
        assert body["break_source"] == "OVERRIDE"
        assert body["override_requested_minutes"] == minutes
    log = db_session.query(AuditLog).filter(AuditLog.action == "break_override_updated").first()
    assert log.reason == "Demanda operativa"


def test_override_without_schedule_and_gross_below_threshold(client, db_session):
    _login(client)
    employee_id = _employee(client, db_session)
    day = _complete(db_session, employee_id, minutes=300)
    response = client.get(f"/api/v1/attendance/daily?employee_id={employee_id}&date_from={day}&date_to={day}")
    assert response.json()[0]["break_source"] == "NONE"
    response = client.put(_url(employee_id, day), json={"requested_break_minutes": 30, "reason": "Almuerzo corto"})
    assert response.status_code == 200
    assert response.json()["worked_minutes"] == 270


def test_override_rejects_open_future_missing_excess_and_supervisor(client, db_session):
    _login(client)
    employee_id = _employee(client, db_session)
    today = datetime.now(lima_tz()).date()
    assert client.put(_url(employee_id, today), json={"requested_break_minutes": 0, "reason": "Sin marca"}).status_code == 409
    _complete(db_session, employee_id, minutes=60)
    assert client.put(_url(employee_id, today), json={"requested_break_minutes": 61, "reason": "Excede"}).status_code == 422
    db_session.add(AttendanceRecord(employee_id=uuid.UUID(employee_id), work_date=today, check_in_at=datetime.now(timezone.utc), status=ATTENDANCE_OPEN))
    db_session.commit()
    assert client.put(_url(employee_id, today), json={"requested_break_minutes": 0, "reason": "Hay abierta"}).status_code == 409
    _login(client, "supervisor", "Sup123!")
    assert client.put(_url(employee_id, today + timedelta(days=1)), json={"requested_break_minutes": 0, "reason": "Futuro"}).status_code == 403


def test_clear_returns_schedule_calculation_and_audits(client, db_session):
    _login(client)
    employee_id = _employee(client, db_session)
    day = _complete(db_session, employee_id, minutes=420)
    schedule = client.post(f"/api/v1/employees/{employee_id}/schedule", json={"effective_from": day.isoformat(), "monday_minutes": 480, "tuesday_minutes": 480, "wednesday_minutes": 480, "thursday_minutes": 480, "friday_minutes": 480, "saturday_minutes": 480, "sunday_minutes": 480, "break_minutes": 60, "break_applies_after_minutes": 360})
    assert schedule.status_code == 201
    client.put(_url(employee_id, day), json={"requested_break_minutes": 30, "reason": "Almuerzo corto"})
    response = client.request("DELETE", _url(employee_id, day), json={"reason": "Vuelve a la regla"})
    assert response.status_code == 200, response.text
    assert response.json()["break_source"] == "SCHEDULE"
    assert response.json()["break_minutes"] == 60
    assert db_session.query(AttendanceBreakOverride).count() == 0
    cleared = db_session.query(AuditLog).filter(AuditLog.action == "break_override_cleared").one()
    assert cleared.new_values["break_source"] == "SCHEDULE"


def test_correction_caps_effective_override_but_keeps_requested(client, db_session):
    _login(client)
    employee_id = _employee(client, db_session)
    day = _complete(db_session, employee_id, minutes=120)
    assert client.put(_url(employee_id, day), json={"requested_break_minutes": 60, "reason": "Almuerzo real"}).status_code == 200
    record = db_session.query(AttendanceRecord).one()
    record.check_out_at = record.check_in_at + timedelta(minutes=30)
    db_session.commit()
    from app.modules.attendance.service import AttendanceService
    AttendanceService(db_session)._recompute_day(uuid.UUID(employee_id), day)
    daily = client.get(f"/api/v1/attendance/daily?employee_id={employee_id}&date_from={day}&date_to={day}").json()[0]
    assert daily["break_minutes"] == 30
    assert daily["override_requested_minutes"] == 60
    assert daily["override_limited"] is True
    assert daily["worked_minutes"] == 0


def test_closed_period_requires_rectification_and_invalidates_editable_snapshot(client, db_session):
    _login(client)
    employee_id = _employee(client, db_session)
    day = _complete(db_session, employee_id, minutes=120)
    closed = PayrollPeriod(name="Periodo", start_date=day, end_date=day, status=PERIOD_CLOSED, root_period_id=uuid.uuid4())
    db_session.add(closed); db_session.commit()
    assert client.put(_url(employee_id, day), json={"requested_break_minutes": 30, "reason": "Mayor demanda"}).status_code == 409
    rectification = PayrollPeriod(name="Periodo", start_date=day, end_date=day, status=PERIOD_CALCULATED, root_period_id=closed.root_period_id, version=2, supersedes_period_id=closed.id)
    db_session.add(rectification); db_session.commit()
    response = client.put(_url(employee_id, day), json={"requested_break_minutes": 30, "reason": "Mayor demanda"})
    assert response.status_code == 200
    db_session.refresh(closed); db_session.refresh(rectification)
    assert closed.status == PERIOD_CLOSED
    assert rectification.status == PERIOD_OPEN
