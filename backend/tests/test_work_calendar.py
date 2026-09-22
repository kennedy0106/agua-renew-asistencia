"""Regresiones focalizadas CAL-01 a CAL-03."""
import uuid
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

from sqlalchemy import select
from app.modules.adjustments.models import HourAdjustment
from app.modules.attendance.models import AttendanceRecord
from app.modules.attendance.manual_models import ManualAttendanceDay
from app.modules.attendance.totals import special_day_known_minutes
from app.modules.overtime.service import OvertimeService
from app.modules.payroll.models import PayrollPeriod
from app.modules.users.models import User
from app.modules.work_calendar.models import SpecialDayValuation


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


def test_may_day_catalog_keeps_special_treatment_and_values_effective_hours(client, db_session):
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
    # Las horas efectivas sobre la referencia se pagan (no se topan ni exigen revisión).
    assert payload["status"] == "PENDING"
    assert payload["calculation"]["known_minutes"] == 360
    assert payload["calculation"]["excess_minutes"] == 60
    # Trato especial de Primero de Mayo: pago del día + trabajo al 100% de las
    # horas efectivas: 21.67 + 2 × 21.6667 × 360/300 = 21.67 + 52.00 = 73.67.
    assert Decimal(str(payload["amount"])) == Decimal("73.67")
    components = {item["component_kind"]: (item["minutes"], Decimal(item["amount"])) for item in payload["components"]}
    assert components["MAY_DAY_PAID"] == (0, Decimal("21.67"))
    assert components["MAY_DAY_WORK"] == (360, Decimal("52.00"))
    approved = client.post(f"/api/v1/work-calendar/valuations/{payload['id']}/approve", json={
        "expected_version": payload["version"], "preview_token": payload["preview_token"],
        "idempotency_key": "cal-test-may-day-effective", "reason": "Aprobación de horas efectivas",
    })
    assert approved.status_code == 200, approved.text
    assert approved.json()["status"] == "APPROVED"


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


def test_approved_special_day_excludes_ordinary_overtime(client, db_session):
    """Un feriado aprobado no se re-paga como hora extra ordinaria del mismo día."""
    _login(client)
    employee_id = _employee(client, db_session._test_job_roles["Operario"], "2026-01-01")
    assert client.post("/api/v1/work-calendar/holidays/catalogs/2026").status_code == 201
    db_session.add(AttendanceRecord(
        employee_id=employee_id, work_date=date(2026, 6, 29),
        check_in_at=datetime(2026, 6, 29, 8, tzinfo=timezone.utc),
        check_out_at=datetime(2026, 6, 29, 13, tzinfo=timezone.utc), worked_minutes=300, status="COMPLETE",
    ))
    db_session.commit()
    # 2026-06-29 (lunes) cae dentro de la jornada L-V; sin feriado sería una
    # jornada ordinaria y una HE de 60 min valdría 25%.
    adjustment = client.post(f"/api/v1/employees/{employee_id}/adjustments", json={
        "adjustment_date": "2026-06-29", "minutes": 60, "adjustment_type": "OVERTIME",
        "reason": "Sobretiempo en feriado",
    })
    assert adjustment.status_code == 201, adjustment.text
    payload = adjustment.json()
    approved_adj = client.patch(f"/api/v1/adjustments/{payload['id']}/approve", json={
        "expected_version": payload["version"], "expected_snapshot": payload["approval_snapshot"],
        "idempotency_key": "cal-test-holiday-overtime-exclusion",
    })
    assert approved_adj.status_code == 200, approved_adj.text

    preview = client.post("/api/v1/work-calendar/valuations/preview", json={
        "employee_id": str(employee_id), "work_date": "2026-06-29", "source_kind": "HOLIDAY",
    })
    assert preview.status_code == 200, preview.text
    value = preview.json()
    assert value["source_kind"] == "HOLIDAY"
    assert Decimal(str(value["amount"])) == Decimal("43.33")
    approved = client.post(f"/api/v1/work-calendar/valuations/{value['id']}/approve", json={
        "expected_version": value["version"], "preview_token": value["preview_token"],
        "idempotency_key": "cal-test-holiday-valuation", "reason": "Feriado trabajado",
    })
    assert approved.status_code == 200, approved.text

    overtime = client.get(f"/api/v1/employees/{employee_id}/overtime/value?date_from=2026-06-01&date_to=2026-06-30").json()
    # La misma jornada ya se valora como feriado: no se duplica como HE ordinaria.
    assert Decimal(str(overtime["value"])) == Decimal("0.00")
    assert overtime["overtime_minutes"] == 0


def _special_day_with_attendance(client, db_session, *, worked_minutes: int = 300):
    """Empleado con descanso semanal configurado y una asistencia completada."""
    _login(client)
    employee_id = _employee(client, db_session._test_job_roles["Operario"], "2026-01-01")
    rule = client.post("/api/v1/work-calendar/weekly-rest-rules", json={
        "employee_id": str(employee_id), "weekly_rest_weekday": 6, "reference_daily_minutes": 300,
        "source": "Contrato", "reason": "Descanso semanal acordado", "effective_from": "2026-01-01",
    })
    assert rule.status_code == 201, rule.text
    record = AttendanceRecord(
        employee_id=employee_id, work_date=date(2026, 8, 2),
        check_in_at=datetime(2026, 8, 2, 8, tzinfo=timezone.utc),
        check_out_at=datetime(2026, 8, 2, 8 + worked_minutes // 60, worked_minutes % 60, tzinfo=timezone.utc),
        worked_minutes=worked_minutes, status="COMPLETE",
    )
    db_session.add(record)
    db_session.commit()
    return employee_id, record


def _preview_and_approve(client, employee_id, *, key: str):
    preview = client.post("/api/v1/work-calendar/valuations/preview", json={
        "employee_id": str(employee_id), "work_date": "2026-08-02", "source_kind": "WEEKLY_REST",
    })
    assert preview.status_code == 200, preview.text
    value = preview.json()
    approved = client.post(f"/api/v1/work-calendar/valuations/{value['id']}/approve", json={
        "expected_version": value["version"], "preview_token": value["preview_token"],
        "idempotency_key": key, "reason": "Aprobación de prueba",
    })
    assert approved.status_code == 200, approved.text
    assert approved.json()["status"] == "APPROVED"
    return value


def _stored_valuation(db_session, valuation_id: str) -> SpecialDayValuation:
    db_session.expire_all()
    row = db_session.scalar(select(SpecialDayValuation).where(SpecialDayValuation.id == uuid.UUID(valuation_id)))
    assert row is not None
    return row


def test_pending_valuation_recomputes_on_break_change(client, db_session):
    """Un refrigerio nuevo recalcula la valoración PENDIENTE sin descuentos dobles."""
    employee_id, _record = _special_day_with_attendance(client, db_session)
    preview = client.post("/api/v1/work-calendar/valuations/preview", json={
        "employee_id": str(employee_id), "work_date": "2026-08-02", "source_kind": "WEEKLY_REST",
    })
    assert preview.status_code == 200, preview.text
    value = preview.json()
    assert value["status"] == "PENDING"
    assert value["worked_minutes"] == 300
    assert Decimal(value["amount"]) == Decimal("43.33")
    original_token = value["preview_token"]

    response = client.put(f"/api/v1/attendance/daily/{employee_id}/2026-08-02/break", json={
        "requested_break_minutes": 30, "reason": "Refrigerio ajustado por jefe",
    })
    assert response.status_code == 200, response.text
    assert response.json()["worked_minutes"] == 270

    row = _stored_valuation(db_session, value["id"])
    assert row.status == "PENDING"
    assert row.worked_minutes == 270
    assert row.reference_daily_minutes == 300
    assert Decimal(str(row.amount)) == Decimal("39.00")
    assert row.preview_token and row.preview_token != original_token
    assert row.version == value["version"] + 1
    assert row.calculation["known_minutes"] == 270
    assert row.approved_at is None and row.approved_by_user_id is None
    components = {item.component_kind: item for item in row.components}
    assert components["WEEKLY_REST_WORK"].minutes == 270
    assert components["WEEKLY_REST_SURCHARGE"].minutes == 270
    assert sum(Decimal(str(item.amount)) for item in row.components) == Decimal("39.00")
    # La valoración sigue siendo la única activa: no se creó una fila ajena.
    active = db_session.scalars(select(SpecialDayValuation).where(
        SpecialDayValuation.employee_id == employee_id,
        SpecialDayValuation.work_date == date(2026, 8, 2), SpecialDayValuation.voided_at.is_(None),
    )).all()
    assert len(active) == 1


def test_approved_valuation_reopens_to_pending_when_hours_change_in_open_period(client, db_session):
    """Una valoración aprobada en planilla abierta se invalida y exige nueva aprobación."""
    employee_id, record = _special_day_with_attendance(client, db_session)
    value = _preview_and_approve(client, employee_id, key="cal-recompute-open-approve")

    period = client.post("/api/v1/payroll/periods", json={"year": 2026, "month": 8, "period_kind": "FIRST_HALF"})
    assert period.status_code == 201, period.text
    period_id = period.json()["id"]
    calculated = client.post(f"/api/v1/payroll/periods/{period_id}/calculate")
    assert calculated.status_code == 200, calculated.text
    assert Decimal(str(calculated.json()[0]["special_day_amount"])) == Decimal("43.33")

    corrected = client.patch(f"/api/v1/attendance/{record.id}", json={
        "check_out_at": datetime(2026, 8, 2, 12, tzinfo=timezone.utc).isoformat(),
        "reason": "Corrección de salida del jefe",
    })
    assert corrected.status_code == 200, corrected.text
    assert corrected.json()["worked_minutes"] == 240

    row = _stored_valuation(db_session, value["id"])
    assert row.status == "PENDING"
    assert row.worked_minutes == 240
    assert Decimal(str(row.amount)) == Decimal("34.67")
    assert row.preview_token is not None
    assert row.approved_at is None and row.approved_by_user_id is None
    assert row.version > value["version"]
    assert row.calculation["known_minutes"] == 240
    assert row.calculation["excess_minutes"] == 0

    db_session.expire_all()
    reopened = db_session.get(PayrollPeriod, uuid.UUID(period_id))
    assert reopened.status == "OPEN"
    assert reopened.inputs_fingerprint is None


def test_approved_valuation_in_closed_period_blocks_hours_change(client, db_session):
    """Un pago cerrado no se modifica en silencio: exige rectificación explícita."""
    employee_id, record = _special_day_with_attendance(client, db_session)
    value = _preview_and_approve(client, employee_id, key="cal-recompute-closed-approve")

    period = client.post("/api/v1/payroll/periods", json={"year": 2026, "month": 8, "period_kind": "FIRST_HALF"})
    assert period.status_code == 201, period.text
    period_id = period.json()["id"]
    assert client.post(f"/api/v1/payroll/periods/{period_id}/calculate").status_code == 200
    closed = client.post(f"/api/v1/payroll/periods/{period_id}/confirm")
    assert closed.status_code == 200, closed.text
    assert closed.json()["status"] == "CLOSED"

    blocked = client.patch(f"/api/v1/attendance/{record.id}", json={
        "check_out_at": datetime(2026, 8, 2, 12, tzinfo=timezone.utc).isoformat(),
        "reason": "Intento de corrección sobre pago cerrado",
    })
    assert blocked.status_code == 409, blocked.text
    assert "RECTIFICATION" in blocked.text

    # La operación se revierte por completo: ni la asistencia ni la valoración cambian.
    db_session.rollback()
    row = _stored_valuation(db_session, value["id"])
    assert row.status == "APPROVED"
    assert row.worked_minutes == 300
    assert Decimal(str(row.amount)) == Decimal("43.33")
    stored_record = db_session.get(AttendanceRecord, record.id)
    assert stored_record.worked_minutes == 300


def test_pending_valuation_recomputes_on_manual_attendance(client, db_session):
    """Una carga histórica también revaloriza el descanso/feriado pendiente."""
    _login(client)
    employee_id = _employee(client, db_session._test_job_roles["Operario"], "2026-01-01")
    rule = client.post("/api/v1/work-calendar/weekly-rest-rules", json={
        "employee_id": str(employee_id), "weekly_rest_weekday": 1, "reference_daily_minutes": 300,
        "source": "Contrato", "reason": "Descanso semanal del martes", "effective_from": "2026-01-01",
    })
    assert rule.status_code == 201, rule.text
    preview = client.post("/api/v1/work-calendar/valuations/preview", json={
        "employee_id": str(employee_id), "work_date": "2026-09-01", "source_kind": "WEEKLY_REST",
    })
    assert preview.status_code == 200, preview.text
    value = preview.json()
    assert value["status"] == "PENDING" and value["worked_minutes"] == 0

    created = client.post("/api/v1/attendance/manual-days/batch", json={
        "work_date": "2026-09-01",
        "rows": [{
            "employee_id": str(employee_id), "worked_minutes_net": 240, "normal_minutes": 240,
            "additional_minutes": 0, "recovery_minutes": 0, "reason": "Trabajo documentado",
            "recovery_allocations": [],
        }],
        "idempotency_key": "cal-manual-recompute", "approve_additional": False,
    })
    assert created.status_code == 200, created.text

    row = _stored_valuation(db_session, value["id"])
    assert row.status == "PENDING"
    assert row.worked_minutes == 240
    assert Decimal(str(row.amount)) == Decimal("34.67")
    assert row.preview_token is not None


def test_weekly_rest_reference_correction_is_versioned_same_date(client, db_session):
    """La corrección 480->300 es versionada, misma fecha y no muta la regla previa."""
    _login(client)
    employee_id = _employee(client, db_session._test_job_roles["Operario"], "2026-01-01")
    rule = client.post("/api/v1/work-calendar/weekly-rest-rules", json={
        "employee_id": str(employee_id), "weekly_rest_weekday": 6, "reference_daily_minutes": 480,
        "source": "Contrato", "reason": "Referencia inicial", "effective_from": "2026-08-01",
    })
    assert rule.status_code == 201, rule.text
    # Divergencia visible: la jornada real es 300, la regla dice 480.
    day = client.get(f"/api/v1/work-calendar/employees/{employee_id}/days", params={
        "date_from": "2026-08-02", "date_to": "2026-08-02",
    }).json()[0]
    assert day["reference_daily_minutes"] == 300
    assert day["reference_diverges_from_rule"] is True

    db_session.add(AttendanceRecord(
        employee_id=employee_id, work_date=date(2026, 8, 2),
        check_in_at=datetime(2026, 8, 2, 8, tzinfo=timezone.utc),
        check_out_at=datetime(2026, 8, 2, 13, tzinfo=timezone.utc), worked_minutes=300, status="COMPLETE",
    ))
    db_session.commit()
    preview = client.post("/api/v1/work-calendar/valuations/preview", json={
        "employee_id": str(employee_id), "work_date": "2026-08-02", "source_kind": "WEEKLY_REST",
    })
    payload = preview.json()
    assert Decimal(str(payload["amount"])) == Decimal("43.33")
    approve = client.post(f"/api/v1/work-calendar/valuations/{payload['id']}/approve", json={
        "expected_version": payload["version"], "preview_token": payload["preview_token"],
        "idempotency_key": "cal-reference-approve", "reason": "Aprobación previa",
    })
    assert approve.status_code == 200, approve.text

    corrected = client.post("/api/v1/work-calendar/weekly-rest-rules/corrections", json={
        "employee_id": str(employee_id), "weekly_rest_weekday": 6, "reference_daily_minutes": 300,
        "source": "Contrato", "reason": "Corrección a la jornada real",
        "effective_from": "2026-08-01", "expected_version": 1, "idempotency_key": "cal-reference-correct",
    })
    assert corrected.status_code == 201, corrected.text
    assert corrected.json()["version"] == 2
    replay = client.post("/api/v1/work-calendar/weekly-rest-rules/corrections", json={
        "employee_id": str(employee_id), "weekly_rest_weekday": 6, "reference_daily_minutes": 300,
        "source": "Contrato", "reason": "Corrección a la jornada real",
        "effective_from": "2026-08-01", "expected_version": 1, "idempotency_key": "cal-reference-correct",
    })
    assert replay.status_code == 201 and replay.json() == corrected.json()

    after = client.get(f"/api/v1/work-calendar/employees/{employee_id}/days", params={
        "date_from": "2026-08-02", "date_to": "2026-08-02",
    }).json()[0]
    assert after["reference_daily_minutes"] == 300
    assert after["reference_diverges_from_rule"] is False
    stored = db_session.scalar(select(SpecialDayValuation).where(SpecialDayValuation.id == uuid.UUID(payload["id"])))
    assert stored.status == "PENDING" and stored.version > payload["version"]


def test_rest_day_overtime_excluded_and_folded_into_special_pay(client, db_session):
    """Un adicional en descanso no se paga como HE; alimenta la valoración especial."""
    _login(client)
    employee_id = _employee(client, db_session._test_job_roles["Operario"], "2026-01-01")
    client.post("/api/v1/work-calendar/weekly-rest-rules", json={
        "employee_id": str(employee_id), "weekly_rest_weekday": 6, "reference_daily_minutes": 300,
        "source": "Contrato", "reason": "Descanso semanal", "effective_from": "2026-08-01",
    })
    created = client.post(f"/api/v1/employees/{employee_id}/adjustments", json={
        "adjustment_date": "2026-08-02", "minutes": 300, "adjustment_type": "OVERTIME",
        "reason": "Trabajo en descanso",
    })
    assert created.status_code == 201, created.text
    pending = created.json()
    approved = client.patch(f"/api/v1/adjustments/{pending['id']}/approve", json={
        "expected_version": pending["version"], "expected_snapshot": pending["approval_snapshot"],
        "idempotency_key": "cal-rest-ot-approve",
    })
    assert approved.status_code == 200, approved.text
    # En un día de descanso la jornada es 0: el ajuste no se valora como HE
    # ordinaria (quedaría sin importe); se paga vía la valoración especial.
    before = OvertimeService(db_session).value(employee_id, date(2026, 8, 2), date(2026, 8, 2))
    assert before["overtime_minutes"] == 300 and Decimal(str(before["value"])) == Decimal("0.00")

    preview = client.post("/api/v1/work-calendar/valuations/preview", json={
        "employee_id": str(employee_id), "work_date": "2026-08-02", "source_kind": "WEEKLY_REST",
    })
    assert preview.status_code == 200, preview.text
    value = preview.json()
    # No hay fila de asistencia: el adicional aprobado entra como minutos netos.
    assert value["worked_minutes"] == 300
    assert Decimal(str(value["amount"])) == Decimal("43.33")
    # Con la valoración activa (aunque siga PENDING) se excluye de HE ordinaria.
    after = OvertimeService(db_session).value(employee_id, date(2026, 8, 2), date(2026, 8, 2))
    assert after["overtime_minutes"] == 0
    assert Decimal(str(after["value"])) == Decimal("0.00")


def test_notes_only_correction_keeps_approved_valuation_untouched(client, db_session):
    """Una corrección que no cambia el neto no renueva ni invalida la aprobación."""
    employee_id, record = _special_day_with_attendance(client, db_session)
    value = _preview_and_approve(client, employee_id, key="cal-notes-only-approve")
    original = _stored_valuation(db_session, value["id"])
    original_version = original.version
    original_amount = original.amount

    corrected = client.patch(f"/api/v1/attendance/{record.id}", json={
        "notes": "Se registra una incidencia sin alterar horas",
        "reason": "Anotar incidencia administrativa",
    })
    assert corrected.status_code == 200, corrected.text

    row = _stored_valuation(db_session, value["id"])
    assert row.status == "APPROVED"
    assert row.version == original_version
    assert row.worked_minutes == 300
    assert row.amount == original_amount
    assert row.approved_at is not None


def test_special_day_known_minutes_dedups_rows_and_includes_orphan_overtime(client, db_session):
    """No duplica asistencia/carga + OVERTIME y sí incorpora el ajuste sin fila."""
    _login(client)
    employee_id = _employee(client, db_session._test_job_roles["Operario"], "2026-01-01")
    # Día con asistencia de kiosco y un OVERTIME aprobado el mismo día.
    db_session.add(AttendanceRecord(
        employee_id=employee_id, work_date=date(2026, 8, 10),
        check_in_at=datetime(2026, 8, 10, 13, tzinfo=timezone.utc),
        check_out_at=datetime(2026, 8, 10, 18, tzinfo=timezone.utc),
        worked_minutes=300, status="COMPLETE",
    ))
    # Día con carga histórica pagable y un OVERTIME aprobado el mismo día.
    db_session.add(ManualAttendanceDay(
        employee_id=employee_id, work_date=date(2026, 8, 11), worked_minutes_net=300,
        normal_minutes=300, additional_minutes=0, recovery_minutes=0, reason="Carga histórica",
        payment_status="NOT_APPLICABLE", payment_snapshot={"break_minutes": 0}, version=1,
        created_by_user_id=db_session.scalar(select(User).where(User.username == "admin")).id,
    ))
    # Cada ajuste aprobado publica sus minutos pagables en la valoración.
    def overtime(work_date, payable, requested, brk):
        db_session.add(HourAdjustment(
            employee_id=employee_id, adjustment_date=work_date, minutes=requested,
            adjustment_type="OVERTIME", status="APPROVED", reason="Sobretiempo aprobado", version=1,
            approval_snapshot_data={"valuation": {
                "minutes": payable, "requested_minutes": requested, "break_minutes": brk,
            }},
        ))

    overtime(date(2026, 8, 10), 240, 300, 60)
    overtime(date(2026, 8, 11), 240, 300, 60)
    # Día sin fila de asistencia: sólo un OVERTIME aprobado.
    overtime(date(2026, 8, 12), 240, 300, 60)
    db_session.commit()

    # Con fila de asistencia, el neto es el de la fila: el ajuste no se duplica.
    assert special_day_known_minutes(db_session, employee_id, date(2026, 8, 10)) == 300
    # Con carga histórica, el neto pagable de la fila manda: el ajuste no se duplica.
    assert special_day_known_minutes(db_session, employee_id, date(2026, 8, 11)) == 300
    # Sin fila alguna, se incorporan los minutos pagables del ajuste aprobado.
    assert special_day_known_minutes(db_session, employee_id, date(2026, 8, 12)) == 240
