"""Regresiones focalizadas CAL-01 a CAL-03."""
import uuid
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

from sqlalchemy import select
from app.modules.attendance.models import AttendanceRecord
from app.modules.attendance.manual_models import ManualAttendanceDay
from app.modules.users.models import User


def _login(client):
    response = client.post("/api/v1/auth/login", json={"username": "admin", "password": "Admin123!"})
    assert response.status_code == 200, response.text


def _employee(client, job_role_id, effective_from: str = "2026-08-01"):
    response = client.post("/api/v1/employees", json={
        "dni": "72845632", "employee_code": "CAL-001", "first_name": "Cálculo",
        "last_name": "Prueba", "job_role_id": str(job_role_id),
    })
    assert response.status_code == 201, response.text
    employee_id = response.json()["id"]
    salary = client.post(f"/api/v1/employees/{employee_id}/salary-settings", json={
        "effective_from": effective_from, "monthly_salary": "650.00", "overtime_enabled": True,
    })
    assert salary.status_code == 201, salary.text
    schedule = client.post(f"/api/v1/employees/{employee_id}/schedule", json={
        "effective_from": effective_from, "monday_minutes": 300, "tuesday_minutes": 300,
        "wednesday_minutes": 300, "thursday_minutes": 300, "friday_minutes": 300,
    })
    assert schedule.status_code == 201, schedule.text
    return uuid.UUID(employee_id)


def test_weekly_rest_preview_uses_historical_reference_and_approval(client, db_session):
    _login(client)
    employee_id = _employee(client, db_session._test_job_roles["Operario"], "2026-01-01")
    rule = client.post("/api/v1/work-calendar/weekly-rest-rules", json={
        "employee_id": str(employee_id), "weekly_rest_weekday": 6, "reference_daily_minutes": 300,
        "source": "Contrato", "reason": "Descanso semanal acordado", "effective_from": "2026-08-01",
    })
    assert rule.status_code == 201, rule.text
    db_session.add(AttendanceRecord(
        employee_id=employee_id, work_date=date(2026, 8, 2),
        check_in_at=datetime(2026, 8, 2, 8, tzinfo=timezone.utc),
        check_out_at=datetime(2026, 8, 2, 13, tzinfo=timezone.utc), worked_minutes=300, status="COMPLETE",
    ))
    db_session.commit()
    preview = client.post("/api/v1/work-calendar/valuations/preview", json={
        "employee_id": str(employee_id), "work_date": "2026-08-02", "source_kind": "WEEKLY_REST",
    })
    assert preview.status_code == 200, preview.text
    payload = preview.json()
    assert Decimal(str(payload["amount"])) == Decimal("43.33")
    approved = client.post(f"/api/v1/work-calendar/valuations/{payload['id']}/approve", json={
        "expected_version": payload["version"], "preview_token": payload["preview_token"],
        "idempotency_key": "cal-test-approve-weekly-rest", "reason": "Aprobación de prueba",
    })
    assert approved.status_code == 200, approved.text
    assert approved.json()["status"] == "APPROVED"
    # The same submitted preview is a receipt replay, not a second approval.
    replay = client.post(f"/api/v1/work-calendar/valuations/{payload['id']}/approve", json={
        "expected_version": payload["version"], "preview_token": payload["preview_token"],
        "idempotency_key": "cal-test-approve-weekly-rest", "reason": "Aprobación de prueba",
    })
    assert replay.status_code == 200, replay.text
    assert replay.json() == approved.json()
    conflict = client.post(f"/api/v1/work-calendar/valuations/{payload['id']}/approve", json={
        "expected_version": payload["version"], "preview_token": payload["preview_token"],
        "idempotency_key": "cal-test-approve-weekly-rest", "reason": "Motivo distinto",
    })
    assert conflict.status_code == 409
    period = client.post("/api/v1/payroll/periods", json={"year": 2026, "month": 8, "period_kind": "FIRST_HALF"})
    assert period.status_code == 201, period.text
    calculated = client.post(f"/api/v1/payroll/periods/{period.json()['id']}/calculate")
    assert calculated.status_code == 200, calculated.text
    row = calculated.json()[0]
    assert Decimal(str(row["special_day_amount"])) == Decimal("43.33")
    assert Decimal(str(row["overtime_amount"])) == Decimal("0.00")
    csv = client.get(f"/api/v1/exports/salaries.csv?period_id={period.json()['id']}")
    assert csv.status_code == 200
    assert "Descanso/Feriado" in csv.content.decode("utf-8-sig")


def test_substitution_requires_24_hours_and_administrative_evidence(client, db_session):
    _login(client)
    employee_id = _employee(client, db_session._test_job_roles["Operario"])
    client.post("/api/v1/work-calendar/weekly-rest-rules", json={
        "employee_id": str(employee_id), "weekly_rest_weekday": 6, "reference_daily_minutes": 300,
        "source": "Contrato", "reason": "Descanso semanal acordado", "effective_from": "2026-08-01",
    })
    start = datetime(2026, 8, 9, 5, tzinfo=timezone.utc)
    short = client.post("/api/v1/work-calendar/rest-substitutions", json={
        "employee_id": str(employee_id), "original_date": "2026-08-09", "substitute_start": start.isoformat(),
        "substitute_end": (start + timedelta(hours=23)).isoformat(), "reference": "Acta", "reason": "Descanso", "idempotency_key": "cal-test-short-substitution",
    })
    assert short.status_code == 422
    proposed = client.post("/api/v1/work-calendar/rest-substitutions", json={
        "employee_id": str(employee_id), "original_date": "2026-08-09", "substitute_start": start.isoformat(),
        "substitute_end": (start + timedelta(hours=24)).isoformat(), "reference": "Acta", "reason": "Descanso", "idempotency_key": "cal-test-substitution",
    })
    assert proposed.status_code == 201, proposed.text
    approved = client.post(f"/api/v1/work-calendar/rest-substitutions/{proposed.json()['id']}/approve", json={
        "expected_version": 1, "reason": "Aprobar", "idempotency_key": "cal-test-substitution-approve",
    })
    assert approved.status_code == 200, approved.text
    replay = client.post(f"/api/v1/work-calendar/rest-substitutions/{proposed.json()['id']}/approve", json={
        "expected_version": 1, "reason": "Aprobar", "idempotency_key": "cal-test-substitution-approve",
    })
    assert replay.status_code == 200
    assert replay.json() == approved.json()
    conflict = client.post(f"/api/v1/work-calendar/rest-substitutions/{proposed.json()['id']}/approve", json={
        "expected_version": 1, "reason": "Aprobar distinto", "idempotency_key": "cal-test-substitution-approve",
    })
    assert conflict.status_code == 409
    without_evidence = client.post(f"/api/v1/work-calendar/rest-substitutions/{proposed.json()['id']}/verify", json={
        "expected_version": 2, "reason": "Verificar", "idempotency_key": "cal-test-substitution-verify",
    })
    assert without_evidence.status_code == 422
    verified = client.post(f"/api/v1/work-calendar/rest-substitutions/{proposed.json()['id']}/verify", json={
        "expected_version": 2, "reason": "Verificar", "idempotency_key": "cal-test-substitution-verify-2", "evidence": {"acta": "ACT-01"},
    })
    assert verified.status_code == 200, verified.text
    assert verified.json()["status"] == "ENJOYED"


def test_may_day_catalog_and_excess_remain_review_required(client, db_session):
    _login(client)
    employee_id = _employee(client, db_session._test_job_roles["Operario"], "2026-01-01")
    # Catalog endpoint is idempotent and exposes May Day as its own treatment.
    assert client.post("/api/v1/work-calendar/holidays/catalogs/2026").status_code == 201
    db_session.add(AttendanceRecord(
        employee_id=employee_id, work_date=date(2026, 5, 1),
        check_in_at=datetime(2026, 5, 1, 8, tzinfo=timezone.utc),
        check_out_at=datetime(2026, 5, 1, 14, tzinfo=timezone.utc), worked_minutes=360, status="COMPLETE",
    ))
    db_session.commit()
    preview = client.post("/api/v1/work-calendar/valuations/preview", json={"employee_id": str(employee_id), "work_date": "2026-05-01"})
    assert preview.status_code == 200, preview.text
    payload = preview.json()
    assert payload["source_kind"] == "MAY_DAY_COINCIDENCE"
    assert payload["status"] == "REVIEW_REQUIRED"
    assert payload["calculation"]["excess_minutes"] == 60
    rejected = client.post(f"/api/v1/work-calendar/valuations/{payload['id']}/approve", json={
        "expected_version": payload["version"], "preview_token": payload["preview_token"],
        "idempotency_key": "cal-test-may-day-excess", "reason": "Intento controlado",
    })
    assert rejected.status_code == 409
    assert "SPECIAL_DAY_OVERTIME_REVIEW_REQUIRED" in rejected.text


def test_holiday_substitution_may_be_enjoyed_outside_the_origin_week(client, db_session):
    _login(client)
    employee_id = _employee(client, db_session._test_job_roles["Operario"], "2026-01-01")
    catalog = client.post("/api/v1/work-calendar/holidays/catalogs/2026")
    assert catalog.status_code == 201
    calendar = client.get(f"/api/v1/work-calendar/employees/{employee_id}/days", params={
        "date_from": "2026-06-07", "date_to": "2026-06-07",
    })
    assert calendar.status_code == 200
    assert calendar.json()[0]["holiday"]["name"] == "Día de la Bandera"
    # Sunday has no configured schedule and no weekly rule: a valuation must
    # ask for a historical reference, never value it as a one-minute journey.
    db_session.add(AttendanceRecord(employee_id=employee_id, work_date=date(2026, 6, 7),
        check_in_at=datetime(2026, 6, 7, 8, tzinfo=timezone.utc), check_out_at=datetime(2026, 6, 7, 13, tzinfo=timezone.utc), worked_minutes=300, status="COMPLETE"))
    db_session.commit()
    reference_missing = client.post("/api/v1/work-calendar/valuations/preview", json={"employee_id": str(employee_id), "work_date": "2026-06-07", "source_kind": "HOLIDAY"})
    assert reference_missing.status_code == 422
    assert "REFERENCE_JOURNEY_REQUIRED" in reference_missing.text
    # June 14 is deliberately in the following Monday-Sunday week.  The
    # weekly-rest same-week restriction must not be applied to a holiday.
    start = datetime(2026, 6, 14, 5, tzinfo=timezone.utc)
    proposed = client.post("/api/v1/work-calendar/rest-substitutions", json={
        "employee_id": str(employee_id), "original_date": "2026-06-07", "origin_kind": "HOLIDAY",
        "substitute_start": start.isoformat(), "substitute_end": (start + timedelta(hours=24)).isoformat(),
        "reference": "Acuerdo por feriado", "reason": "Descanso sustitutorio de feriado",
        "idempotency_key": "cal-test-holiday-outside-week",
    })
    assert proposed.status_code == 201, proposed.text
    assert proposed.json()["origin_kind"] == "HOLIDAY"
    replay = client.post("/api/v1/work-calendar/rest-substitutions", json={
        "employee_id": str(employee_id), "original_date": "2026-06-07", "origin_kind": "HOLIDAY",
        "substitute_start": start.isoformat(), "substitute_end": (start + timedelta(hours=24)).isoformat(),
        "reference": "Acuerdo por feriado", "reason": "Descanso sustitutorio de feriado",
        "idempotency_key": "cal-test-holiday-outside-week",
    })
    assert replay.status_code == 201
    assert replay.json() == proposed.json()


def test_special_components_reference_and_manual_work_guard(client, db_session):
    _login(client)
    employee_id = _employee(client, db_session._test_job_roles["Operario"], "2026-01-01")
    client.post("/api/v1/work-calendar/weekly-rest-rules", json={
        "employee_id": str(employee_id), "weekly_rest_weekday": 6, "reference_daily_minutes": 300,
        "source": "Contrato", "reason": "Regla de referencia", "effective_from": "2026-01-01",
    })
    db_session.add(AttendanceRecord(employee_id=employee_id, work_date=date(2026, 8, 2),
        check_in_at=datetime(2026, 8, 2, 8, tzinfo=timezone.utc), check_out_at=datetime(2026, 8, 2, 13, tzinfo=timezone.utc), worked_minutes=300, status="COMPLETE"))
    db_session.commit()
    value = client.post("/api/v1/work-calendar/valuations/preview", json={"employee_id": str(employee_id), "work_date": "2026-08-02", "source_kind": "WEEKLY_REST"})
    assert value.status_code == 200
    assert [item["component_kind"] for item in value.json()["components"]] == ["WEEKLY_REST_WORK", "WEEKLY_REST_SURCHARGE"]
    assert sum(Decimal(item["amount"]) for item in value.json()["components"]) == Decimal(value.json()["amount"])

    # A manual HST-01 day is physical work for the purpose of enjoying a
    # substitution and blocks verification just like a kiosk record.
    start = datetime(2026, 8, 9, 5, tzinfo=timezone.utc)
    proposed = client.post("/api/v1/work-calendar/rest-substitutions", json={
        "employee_id": str(employee_id), "original_date": "2026-08-09", "substitute_start": start.isoformat(),
        "substitute_end": (start + timedelta(hours=24)).isoformat(), "reference": "Acta", "reason": "Descanso", "idempotency_key": "cal-manual-guard-proposal",
    })
    assert proposed.status_code == 201, proposed.text
    approved = client.post(f"/api/v1/work-calendar/rest-substitutions/{proposed.json()['id']}/approve", json={"expected_version": 1, "reason": "Aprobar", "idempotency_key": "cal-manual-guard-approve"})
    assert approved.status_code == 200
    actor = db_session.scalar(select(User).where(User.username == "admin"))
    db_session.add(ManualAttendanceDay(employee_id=employee_id, work_date=date(2026, 8, 9), worked_minutes_net=60,
        normal_minutes=60, additional_minutes=0, recovery_minutes=0, reason="Trabajo administrativo", created_by_user_id=actor.id))
    db_session.commit()
    blocked = client.post(f"/api/v1/work-calendar/rest-substitutions/{proposed.json()['id']}/verify", json={
        "expected_version": 2, "reason": "Verificar", "idempotency_key": "cal-manual-guard-verify", "evidence": {"acta": "A-1"},
    })
    assert blocked.status_code == 409
    assert "carga administrativa incompatible" in blocked.text
