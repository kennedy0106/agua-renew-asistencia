"""Regresiones del perfil: agenda, acumulado, carga multidía y ajustes legacy."""

from datetime import date, datetime, timezone
from decimal import Decimal
import uuid

from sqlalchemy import event

from app.modules.attendance.manual_models import ManualAttendanceDay
from app.modules.attendance.models import AttendanceRecord
from app.modules.attendance.agenda_service import EmployeeAgendaService
from app.modules.attendance.service import AttendanceService
from app.modules.adjustments.models import HourAdjustment
from app.modules.adjustments.service import AdjustmentService
from app.modules.overtime.service import OvertimeService
from app.modules.payroll.models import PERIOD_CALCULATED, PayrollPeriod, PayrollRecord
from app.modules.work_calendar.models import SpecialDayValuation, VALUATION_APPROVED


def _login(client):
    assert client.post("/api/v1/auth/login", json={"username": "admin", "password": "Admin123!"}).status_code == 200


def _employee(client, db):
    response = client.post("/api/v1/employees", json={
        "dni": "74561234", "employee_code": "AGENDA-01", "first_name": "Agenda",
        "last_name": "Prueba", "job_role_id": str(db._test_job_roles["Operario"]),
        "hire_date": "2026-08-01",
    })
    assert response.status_code == 201, response.text
    return response.json()["id"]


def _configure(client, employee_id):
    assert client.post(f"/api/v1/employees/{employee_id}/salary-settings", json={
        "effective_from": "2026-08-01", "monthly_salary": "1500.00", "overtime_enabled": True,
    }).status_code == 201
    assert client.post(f"/api/v1/employees/{employee_id}/schedule", json={
        "effective_from": "2026-08-01", "monday_minutes": 480, "tuesday_minutes": 480,
        "wednesday_minutes": 480, "thursday_minutes": 480, "friday_minutes": 480,
    }).status_code == 201


def _multi(employee_id, dates=("2026-08-03", "2026-08-04"), key="agenda-multi-001"):
    return {
        "employee_id": employee_id, "work_dates": list(dates), "idempotency_key": key,
        "template": {
            "worked_minutes_net": 480, "normal_minutes": 480, "additional_minutes": 0,
            "recovery_minutes": 0, "reason": "Regularización múltiple documentada",
            "recovery_allocations": [],
        },
    }


def _select_count(db_session, call):
    """Cuenta SELECTs de una única lectura, sin incluir la preparación."""
    statements = 0

    def count_select(_conn, _cursor, statement, _parameters, _context, _executemany):
        nonlocal statements
        if statement.lstrip().upper().startswith("SELECT"):
            statements += 1

    event.listen(db_session.bind, "before_cursor_execute", count_select)
    try:
        result = call()
    finally:
        event.remove(db_session.bind, "before_cursor_execute", count_select)
    return result, statements


def test_multi_is_atomic_idempotent_and_feed_employee_agenda(client, db_session):
    _login(client)
    employee = _employee(client, db_session)
    _configure(client, employee)
    payload = _multi(employee)
    preview = client.post("/api/v1/attendance/manual-days/multi/preview", json=payload)
    assert preview.status_code == 200, preview.text
    assert [item["status"] for item in preview.json()["items"]] == ["READY", "READY"]
    first = client.post("/api/v1/attendance/manual-days/multi", json=payload)
    assert first.status_code == 200, first.text
    second = client.post("/api/v1/attendance/manual-days/multi", json=payload)
    assert second.status_code == 200 and second.json() == first.json()
    assert db_session.query(ManualAttendanceDay).count() == 2
    # Un rechazo en una fecha hace atómico todo el lote: la válida tampoco se
    # persiste. La fecha futura es una regla HST, no un error de transporte.
    conflict = client.post("/api/v1/attendance/manual-days/multi", json=_multi(employee, ("2026-08-05", "2026-10-02"), "agenda-multi-002"))
    assert conflict.status_code == 409
    assert db_session.query(ManualAttendanceDay).count() == 2
    agenda = client.get(f"/api/v1/employees/{employee}/attendance-agenda", params={"date_from": "2026-08-03", "date_to": "2026-08-05"})
    assert agenda.status_code == 200, agenda.text
    days = {item["work_date"]: item for item in agenda.json()["days"]}
    assert "MANUAL" in days["2026-08-03"]["statuses"]
    assert "NO_RECORD" in days["2026-08-05"]["statuses"]
    assert days["2026-08-03"]["manual_day"]["normal_minutes"] == 480
    invalid = _multi(employee, ("2026-08-06",), "agenda-multi-invalid")
    invalid["template"]["normal_minutes"] = 420
    response = client.post("/api/v1/attendance/manual-days/multi/preview", json=invalid)
    assert response.status_code == 422


def test_dashboard_reads_batch_schedule_history_instead_of_querying_each_day(client, db_session):
    """Regresión N+1: 12 fechas no deben generar 12 SELECT de jornada."""
    _login(client)
    employee_id = _employee(client, db_session)
    _configure(client, employee_id)
    employee_uuid = uuid.UUID(employee_id)
    for day in range(3, 15):
        check_in = datetime(2026, 8, day, 13, tzinfo=timezone.utc)
        db_session.add(
            AttendanceRecord(
                employee_id=employee_uuid,
                work_date=date(2026, 8, day),
                check_in_at=check_in,
                check_out_at=check_in.replace(hour=22),
                worked_minutes=540,
                status="COMPLETE",
            )
        )
    db_session.commit()

    attendance = AttendanceService(db_session)
    daily, daily_selects = _select_count(
        db_session,
        lambda: attendance.list_daily(
            employee_id=employee_uuid,
            date_from=date(2026, 8, 3),
            date_to=date(2026, 8, 14),
        ),
    )
    assert len(daily) == 12
    # registros, HST, jornadas y overrides: fijo, no 2 consultas por día.
    assert daily_selects <= 4

    records, record_selects = _select_count(
        db_session,
        lambda: attendance.list_records(
            employee_id=employee_uuid,
            date_from=date(2026, 8, 3),
            date_to=date(2026, 8, 14),
        ),
    )
    assert len(records) == 12
    assert record_selects <= 2

    agenda, agenda_selects = _select_count(
        db_session,
        lambda: EmployeeAgendaService(db_session).agenda(
            employee_uuid, date(2026, 8, 3), date(2026, 8, 14)
        ),
    )
    assert len(agenda["days"]) == 12
    # Incluye historial/auditoría, pero no una jornada por cada fecha.
    assert agenda_selects <= 14

    detected, overtime_selects = _select_count(
        db_session,
        lambda: OvertimeService(db_session).detect(
            employee_uuid, date(2026, 8, 3), date(2026, 8, 14)
        ),
    )
    assert len(detected) == 10
    assert overtime_selects <= 3

    balance, balance_selects = _select_count(
        db_session,
        lambda: AdjustmentService(db_session).balance(
            employee_uuid, date(2026, 8, 3), date(2026, 8, 14)
        ),
    )
    assert balance["expected_minutes"] == 480 * 10
    # Totales y conceptos mantienen sus consultas propias; la jornada queda
    # en una sola lectura y el total no crece con los 12 días.
    assert balance_selects <= 9

    for day in range(3, 15):
        if date(2026, 8, day).weekday() < 5:
            db_session.add(
                HourAdjustment(
                    employee_id=employee_uuid,
                    adjustment_date=date(2026, 8, day),
                    minutes=60,
                    adjustment_type="OVERTIME",
                    reason="Fila histórica para regresión de lote",
                    status="APPROVED",
                )
            )
    db_session.commit()
    overtime_value, value_selects = _select_count(
        db_session,
        lambda: OvertimeService(db_session).value(
            employee_uuid, date(2026, 8, 3), date(2026, 8, 14)
        ),
    )
    assert overtime_value["overtime_minutes"] == 600
    # empleado, ajustes, salarios, jornadas, política y HST; no una lectura
    # salarial/jornada/política por cada fecha de horas extra.
    assert value_selects <= 6


def test_multi_additional_links_kiosk_and_versions_existing_hst(client, db_session):
    _login(client)
    employee = _employee(client, db_session)
    _configure(client, employee)
    initial = _multi(employee, ("2026-08-03",), "agenda-hst-initial")
    assert client.post("/api/v1/attendance/manual-days/multi", json=initial).status_code == 200
    hst = _multi(employee, ("2026-08-03",), "agenda-hst-replace")
    hst["template"].update({
        "worked_minutes_net": 480, "normal_minutes": 420, "additional_minutes": 60,
        "payment_method": "OVERTIME", "reason": "Redistribución con adicional",
    })
    replacement_preview = client.post("/api/v1/attendance/manual-days/multi/preview", json=hst)
    assert replacement_preview.status_code == 200, replacement_preview.text
    assert replacement_preview.json()["items"][0]["operation"] == "REPLACE_HST"
    replacement = client.post("/api/v1/attendance/manual-days/multi", json=hst)
    assert replacement.status_code == 200, replacement.text
    history = client.get("/api/v1/attendance/manual-days", params={"employee_id": employee, "include_voided": "true"}).json()
    assert len(history) == 2
    assert any(item["voided_at"] for item in history)
    assert next(item for item in history if item["voided_at"] is None)["additional_minutes"] == 60

    # A kiosk attendance gets only a linked P adjustment. Its 480 attended
    # minutes are not copied into HST, so the same work is never summed twice.
    db_session.add(AttendanceRecord(
        employee_id=uuid.UUID(employee), work_date=date(2026, 8, 6),
        check_in_at=datetime(2026, 8, 6, 13, tzinfo=timezone.utc),
        check_out_at=datetime(2026, 8, 6, 21, tzinfo=timezone.utc),
        worked_minutes=480, status="COMPLETE",
    ))
    db_session.commit()
    kiosk = _multi(employee, ("2026-08-06",), "agenda-kiosk-additional")
    kiosk["template"].update({
        "worked_minutes_net": 60, "normal_minutes": 0, "additional_minutes": 60,
        "payment_method": "OVERTIME", "reason": "Actividad adicional de kiosco",
    })
    preview = client.post("/api/v1/attendance/manual-days/multi/preview", json=kiosk)
    assert preview.status_code == 200, preview.text
    assert preview.json()["items"][0]["operation"] == "LINKED_OVERTIME"
    kiosk["approve_additional"] = True
    kiosk["preview_token"] = preview.json()["preview_token"]
    saved = client.post("/api/v1/attendance/manual-days/multi", json=kiosk)
    assert saved.status_code == 200, saved.text
    assert saved.json()["items"][0]["operation"] == "LINKED_OVERTIME"
    assert db_session.query(ManualAttendanceDay).filter_by(employee_id=uuid.UUID(employee), work_date=date(2026, 8, 6)).count() == 0
    agenda = client.get(f"/api/v1/employees/{employee}/attendance-agenda", params={"date_from": "2026-08-06", "date_to": "2026-08-06"}).json()
    assert agenda["days"][0]["worked_minutes"] == 480
    assert "OVERTIME_APPROVED" in agenda["days"][0]["statuses"]


def test_accrual_uses_payroll_proration_without_creating_period(client, db_session):
    _login(client)
    employee = _employee(client, db_session)
    _configure(client, employee)
    response = client.get(f"/api/v1/employees/{employee}/payroll-accrual", params={
        "period": "MONTH", "anchor_date": "2026-08-20",
    })
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["date_from"] == "2026-08-01" and body["date_to"] == "2026-08-31"
    assert body["base_amount"] == 1500.0
    assert body["estimated_total"] == 1500.0
    assert body["closed_period"] is None


def test_half_months_reconcile_exactly_with_month_when_cents_do_not_divide(client, db_session):
    _login(client)
    employee = _employee(client, db_session)
    assert client.post(f"/api/v1/employees/{employee}/salary-settings", json={
        "effective_from": "2026-08-01", "monthly_salary": "1500.01", "overtime_enabled": True,
    }).status_code == 201
    first = client.get(f"/api/v1/employees/{employee}/payroll-accrual", params={"period": "FIRST_HALF", "anchor_date": "2026-08-20"}).json()
    second = client.get(f"/api/v1/employees/{employee}/payroll-accrual", params={"period": "SECOND_HALF", "anchor_date": "2026-08-20"}).json()
    month = client.get(f"/api/v1/employees/{employee}/payroll-accrual", params={"period": "MONTH", "anchor_date": "2026-08-20"}).json()
    assert first["base_amount"] + second["base_amount"] == month["base_amount"] == 1500.01


def test_first_half_accrual_includes_approved_special_day_valuation(client, db_session):
    _login(client)
    employee = _employee(client, db_session)
    _configure(client, employee)
    db_session.add(SpecialDayValuation(
        employee_id=uuid.UUID(employee), work_date=date(2026, 8, 9),
        source_kind="WEEKLY_REST", status=VALUATION_APPROVED,
        worked_minutes=480, reference_daily_minutes=480,
        amount=Decimal("25.00"), calculation={},
    ))
    db_session.commit()

    response = client.get(
        f"/api/v1/employees/{employee}/payroll-accrual",
        params={"period": "FIRST_HALF", "anchor_date": "2026-08-20"},
    )

    assert response.status_code == 200, response.text
    assert response.json()["approved_additional_amount"] == 25.0


def test_legacy_adjustment_update_approval_and_void_are_versioned(client, db_session):
    _login(client)
    employee = _employee(client, db_session)
    created = client.post(f"/api/v1/employees/{employee}/adjustments", json={
        "adjustment_date": "2026-08-10", "minutes": 60, "adjustment_type": "OTRO",
        "reason": "Ajuste documentado",
    }).json()
    updated = client.patch(f"/api/v1/adjustments/{created['id']}", json={
        "adjustment_date": "2026-08-11", "minutes": 90, "adjustment_type": "OTRO",
        "reason": "Corrección documentada", "expected_version": created["version"],
        "idempotency_key": "agenda-adjustment-update-001",
    })
    assert updated.status_code == 200, updated.text
    current = updated.json()
    assert current["version"] == 2 and current["status"] == "PENDING"
    assert client.get(f"/api/v1/employees/{employee}/adjustments").json()[0]["id"] == current["id"]
    approved = client.patch(f"/api/v1/adjustments/{current['id']}/approve", json={
        "expected_version": current["version"], "expected_snapshot": current["approval_snapshot"],
        "idempotency_key": "agenda-adjustment-approve-001",
    })
    assert approved.status_code == 200, approved.text
    voided = client.post(f"/api/v1/adjustments/{current['id']}/void", json={
        "expected_version": approved.json()["version"], "reason": "Registro duplicado",
        "idempotency_key": "agenda-adjustment-void-001",
    })
    assert voided.status_code == 200, voided.text
    assert voided.json()["voided_at"] is not None
    # The approval retry is the confirmed approval response, not the later
    # voided row obtained from a mutable lookup.
    approved_replay = client.patch(f"/api/v1/adjustments/{current['id']}/approve", json={
        "expected_version": current["version"], "expected_snapshot": current["approval_snapshot"],
        "idempotency_key": "agenda-adjustment-approve-001",
    })
    assert approved_replay.status_code == 200
    assert approved_replay.json()["status"] == "APPROVED"
    assert approved_replay.json()["voided_at"] is None
    assert client.get(f"/api/v1/employees/{employee}/adjustments").json() == []
    history = client.get(f"/api/v1/employees/{employee}/adjustments", params={"include_voided": "true"}).json()
    assert len(history) == 2 and all(item["voided_at"] is not None for item in history)
    agenda = client.get(f"/api/v1/employees/{employee}/attendance-agenda", params={
        "date_from": "2026-08-10", "date_to": "2026-08-11",
    }).json()
    day = next(item for item in agenda["days"] if item["work_date"] == "2026-08-11")
    assert len(day["adjustment_history"]) == 1
    assert day["adjustment_history"][0]["voided_at"] is not None


def test_accrual_excludes_rejected_and_post_cutoff_additional(client, db_session):
    _login(client)
    employee = _employee(client, db_session)
    _configure(client, employee)
    rejected = client.post(f"/api/v1/employees/{employee}/adjustments", json={
        "adjustment_date": "2026-08-12", "minutes": 60, "adjustment_type": "OVERTIME",
        "reason": "Adicional rechazado",
    }).json()
    assert client.patch(f"/api/v1/adjustments/{rejected['id']}/reject", json={
        "expected_version": rejected["version"], "reason": "No corresponde",
        "idempotency_key": "agenda-reject-001",
    }).status_code == 200
    # October remains after the current Lima cutoff in this deterministic test
    # fixture. Its pending item cannot become an amount already accumulated.
    future = client.post(f"/api/v1/employees/{employee}/adjustments", json={
        "adjustment_date": "2026-10-02", "minutes": 60, "adjustment_type": "OVERTIME",
        "reason": "Adicional futuro",
    })
    assert future.status_code == 201, future.text
    august = client.get(f"/api/v1/employees/{employee}/payroll-accrual", params={
        "period": "MONTH", "anchor_date": "2026-08-20",
    }).json()
    october = client.get(f"/api/v1/employees/{employee}/payroll-accrual", params={
        "period": "MONTH", "anchor_date": "2026-10-20",
    }).json()
    assert august["pending_additional_amount"] == 0
    assert october["pending_additional_amount"] == 0


def test_accrual_exposes_calculated_monetary_adjustment_once_and_recovery_agenda(client, db_session):
    _login(client)
    employee = _employee(client, db_session)
    _configure(client, employee)
    period_id = uuid.uuid4()
    period = PayrollPeriod(
        id=period_id, root_period_id=period_id, name="Agosto calculado",
        start_date=date(2026, 8, 1), end_date=date(2026, 8, 31), status=PERIOD_CALCULATED,
    )
    db_session.add(period)
    db_session.add(PayrollRecord(
        payroll_period_id=period_id, employee_id=uuid.UUID(employee), monthly_salary=Decimal("1500.00"),
        worked_minutes=0, expected_minutes=0, overtime_minutes=0, overtime_amount=Decimal("0"),
        adjustment_minutes=0, adjustment_amount=Decimal("0"), base_salary=Decimal("1500"),
        manual_adjustment=Decimal("25.50"), missing_salary_days=0, total=Decimal("1525.50"), status="PREVIEW",
    ))
    db_session.commit()
    whole = client.get(f"/api/v1/employees/{employee}/payroll-accrual", params={
        "period": "MONTH", "anchor_date": "2026-08-20",
    }).json()
    partial = client.get(f"/api/v1/employees/{employee}/payroll-accrual", params={
        "period": "CUSTOM", "anchor_date": "2026-08-20", "date_from": "2026-08-01", "date_to": "2026-08-15",
    }).json()
    assert whole["manual_adjustment_amount"] == 25.5
    assert whole["official_total_snapshot"] is None and whole["closed_period"] is None
    assert partial["manual_adjustment_amount"] == 0

    commitment = client.post("/api/v1/attendance/recovery-commitments", json={
        "employee_id": employee, "permission_date": "2026-08-01", "agreed_minutes": 120,
        "covered_before": False, "reference": "Permiso recuperable documentado",
    })
    assert commitment.status_code == 200, commitment.text
    recovery = _multi(employee, ("2026-08-05",), "agenda-recovery-001")
    recovery["template"].update({
        "worked_minutes_net": 120, "normal_minutes": 0, "recovery_minutes": 120,
        "reason": "Recuperación de permiso", "recovery_allocations": [
            {"commitment_id": commitment.json()["id"], "minutes": 120},
        ],
    })
    assert client.post("/api/v1/attendance/manual-days/multi", json=recovery).status_code == 200
    agenda = client.get(f"/api/v1/employees/{employee}/attendance-agenda", params={
        "date_from": "2026-08-01", "date_to": "2026-08-05",
    }).json()
    by_date = {item["work_date"]: item for item in agenda["days"]}
    assert "PERMISSION" in by_date["2026-08-01"]["statuses"]
    assert "RECOVERY" in by_date["2026-08-05"]["statuses"]
