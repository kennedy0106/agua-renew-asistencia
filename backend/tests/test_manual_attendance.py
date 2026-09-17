"""HST-01: carga histórica sin contaminar las sesiones del kiosco."""
from datetime import date
import uuid

from app.modules.attendance.manual_models import ManualAttendanceDay
from app.modules.payroll.models import PayrollPeriod

def _login(client):
    assert client.post("/api/v1/auth/login", json={"username": "admin", "password": "Admin123!"}).status_code == 200

def _employee(client, db):
    response = client.post("/api/v1/employees", json={"dni":"71234567","employee_code":"HST-01","first_name":"Historia","last_name":"Prueba","job_role_id":str(db._test_job_roles["Operario"]),"hire_date":"2026-01-01"})
    assert response.status_code == 201, response.text
    return response.json()["id"]

def _batch(employee_id, **row):
    item = {"employee_id":employee_id,"worked_minutes_net":480,"normal_minutes":480,"additional_minutes":0,"recovery_minutes":0,"reason":"Regularización documentada","recovery_allocations":[]}
    item.update(row)
    return {"work_date":"2026-09-01","rows":[item],"idempotency_key":"hst-01-test-key","approve_additional":False}

def _preview_token(client, payload):
    response = client.post("/api/v1/attendance/manual-days/preview", json=payload)
    assert response.status_code == 200, response.text
    return response.json()["preview_token"]

def test_manual_day_persists_exact_net_without_kiosk_session(client, db_session):
    _login(client); employee = _employee(client, db_session)
    response = client.post("/api/v1/attendance/manual-days/batch", json=_batch(employee))
    assert response.status_code == 200, response.text
    item = db_session.query(ManualAttendanceDay).one()
    assert (item.worked_minutes_net, item.normal_minutes, item.additional_minutes, item.recovery_minutes) == (480, 480, 0, 0)
    assert client.get("/api/v1/attendance", params={"employee_id": employee}).json() == []

def test_manual_batch_is_idempotent_and_rejects_wrong_distribution(client, db_session):
    _login(client); employee = _employee(client, db_session); payload = _batch(employee, worked_minutes_net=390, normal_minutes=390)
    first = client.post("/api/v1/attendance/manual-days/batch", json=payload); second = client.post("/api/v1/attendance/manual-days/batch", json=payload)
    assert first.status_code == second.status_code == 200
    assert db_session.query(ManualAttendanceDay).count() == 1
    bad = _batch(employee, worked_minutes_net=100, normal_minutes=90); bad["idempotency_key"] = "hst-01-test-other"
    assert client.post("/api/v1/attendance/manual-days/batch", json=bad).status_code == 422

def test_manual_day_rejects_existing_session(client, db_session):
    _login(client); employee = _employee(client, db_session)
    from app.modules.attendance.models import AttendanceRecord
    from app.core.timezone import lima_tz
    from datetime import datetime
    db_session.add(AttendanceRecord(employee_id=uuid.UUID(employee), work_date=date(2026,9,1), check_in_at=datetime(2026,9,1,8,tzinfo=lima_tz()), check_out_at=datetime(2026,9,1,17,tzinfo=lima_tz()), worked_minutes=480, status="COMPLETE")); db_session.commit()
    response=client.post("/api/v1/attendance/manual-days/batch",json=_batch(employee))
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "DAY_ALREADY_HAS_ATTENDANCE"

def test_kiosk_rejects_manual_day_as_the_other_source(client, db_session, monkeypatch):
    """A31: the reciprocal kiosk path cannot add a session over an HST day."""
    from datetime import datetime, timezone
    import pytest
    from fastapi import HTTPException
    from app.modules.attendance.service import AttendanceService
    import app.modules.attendance.service as attendance_service_module

    _login(client); employee = _employee(client, db_session)
    assert client.post("/api/v1/attendance/manual-days/batch", json=_batch(employee)).status_code == 200

    class FixedDateTime(datetime):
        @classmethod
        def now(cls, tz=None):
            value = datetime(2026, 9, 1, 13, 0, tzinfo=timezone.utc)
            return value if tz else value.replace(tzinfo=None)

    monkeypatch.setattr(attendance_service_module, "datetime", FixedDateTime)
    with pytest.raises(HTTPException) as raised:
        AttendanceService(db_session).check_in(uuid.UUID(employee))
    assert raised.value.status_code == 409

def test_manual_day_versioned_update_and_void(client, db_session):
    from app.modules.audit.models import AuditLog
    _login(client); employee = _employee(client, db_session)
    created = client.post("/api/v1/attendance/manual-days/batch", json=_batch(employee)).json()["created"][0]
    patch = {"employee_id": employee, "worked_minutes_net": 390, "normal_minutes": 390, "additional_minutes": 0, "recovery_minutes": 0, "reason": "Corrección documentada", "recovery_allocations": [], "expected_version": 1}
    patch["preview_token"] = _preview_token(client, {"work_date": "2026-09-01", "rows": [{key: value for key, value in patch.items() if key not in {"expected_version", "preview_token"}}], "idempotency_key": "edit-preview-test", "editing_manual_day_id": created, "expected_version": 1})
    updated = client.patch(f"/api/v1/attendance/manual-days/{created}", json=patch)
    assert updated.status_code == 200, updated.text
    assert updated.json()["worked_minutes_net"] == 390 and updated.json()["version"] == 2
    stale = client.patch(f"/api/v1/attendance/manual-days/{updated.json()['id']}", json={**patch, "expected_version": 1})
    assert stale.status_code == 409 and stale.json()["detail"]["code"] == "STALE_VERSION"
    audit = db_session.query(AuditLog).filter(AuditLog.action == "versioned_update").one()
    assert str(audit.entity_id) == updated.json()["id"] and audit.old_values["version"] == 1 and audit.new_values["version"] == 2
    assert client.post(f"/api/v1/attendance/manual-days/{updated.json()['id']}/void", json={"expected_version":2,"reason":"Anulación de prueba"}).status_code == 200

def test_recovery_credit_is_once_at_permission_and_never_ordinary(client, db_session):
    _login(client); employee = _employee(client, db_session)
    commitment = client.post("/api/v1/attendance/recovery-commitments", json={"employee_id": employee, "permission_date": "2026-09-01", "agreed_minutes": 120, "covered_before": False, "reference": "Permiso pendiente histórico"})
    assert commitment.status_code == 200, commitment.text
    payload = _batch(employee, worked_minutes_net=120, normal_minutes=0, recovery_minutes=120, recovery_allocations=[{"commitment_id": commitment.json()["id"], "minutes": 120}])
    payload["work_date"] = "2026-09-02"; payload["idempotency_key"] = "hst-recovery-credit"
    assert client.post("/api/v1/attendance/manual-days/batch", json=payload).status_code == 200
    balance = client.get(f"/api/v1/employees/{employee}/balance", params={"date_from":"2026-09-01", "date_to":"2026-09-02"})
    assert balance.status_code == 200, balance.text
    assert balance.json()["worked_minutes"] == 0
    assert balance.json()["recovery_credit_minutes"] == 120
    assert balance.json()["balance_minutes"] == 120
    # Una anulación libera la aplicación y no deja crédito/tiempo duplicado.
    item = client.get("/api/v1/attendance/manual-days").json()[0]
    assert client.post(f"/api/v1/attendance/manual-days/{item['id']}/void", json={"expected_version": item["version"], "reason":"Prueba de reversión"}).status_code == 200
    assert client.get(f"/api/v1/employees/{employee}/balance", params={"date_from":"2026-09-01", "date_to":"2026-09-02"}).json()["recovery_credit_minutes"] == 0

def test_covered_recovery_does_not_grant_credit_twice(client, db_session):
    _login(client); employee = _employee(client, db_session)
    commitment = client.post("/api/v1/attendance/recovery-commitments", json={"employee_id": employee, "permission_date": "2026-09-01", "agreed_minutes": 60, "covered_before": True, "reference": "Permiso ya reconocido"}).json()
    payload = _batch(employee, worked_minutes_net=60, normal_minutes=0, recovery_minutes=60, recovery_allocations=[{"commitment_id": commitment["id"], "minutes": 60}])
    payload["work_date"] = "2026-09-02"; payload["idempotency_key"] = "hst-recovery-covered"
    assert client.post("/api/v1/attendance/manual-days/batch", json=payload).status_code == 200
    balance = client.get(f"/api/v1/employees/{employee}/balance", params={"date_from":"2026-09-01", "date_to":"2026-09-02"}).json()
    assert balance["worked_minutes"] == 0 and balance["recovery_credit_minutes"] == 0


def test_recovery_credit_excludes_approved_legacy_coverage_at_origin(client, db_session):
    """A06/A24: N360 + ajuste aprobado120 + R120 no acredita 120 dos veces."""
    _login(client); employee = _employee(client, db_session)
    schedule = {"effective_from":"2026-08-01", "monday_minutes":480, "tuesday_minutes":480, "wednesday_minutes":480, "thursday_minutes":480, "friday_minutes":480}
    assert client.post(f"/api/v1/employees/{employee}/schedule", json=schedule).status_code == 201
    assert client.post(f"/api/v1/employees/{employee}/salary-settings", json={"effective_from":"2026-08-01", "monthly_salary":"1500.00", "overtime_enabled":True}).status_code == 201
    period_response = client.post("/api/v1/payroll/periods", json={"name":"HST crédito origen", "start_date":"2026-09-01", "end_date":"2026-09-30"})
    assert period_response.status_code == 201, period_response.text
    period = period_response.json()
    origin = _batch(employee, worked_minutes_net=360, normal_minutes=360)
    origin["idempotency_key"] = "hst-origin-n360"
    assert client.post("/api/v1/attendance/manual-days/batch", json=origin).status_code == 200
    adjustment = client.post(f"/api/v1/employees/{employee}/adjustments", json={"adjustment_date":"2026-09-01", "minutes":120, "adjustment_type":"OTRO", "reason":"Cobertura legado del permiso"})
    assert adjustment.status_code == 201, adjustment.text
    assert client.patch(f"/api/v1/adjustments/{adjustment.json()['id']}/approve").status_code == 200
    commitment = client.post("/api/v1/attendance/recovery-commitments", json={"employee_id":employee, "permission_date":"2026-09-01", "agreed_minutes":120, "covered_before":False, "reference":"Permiso con cobertura legado"})
    assert commitment.status_code == 200, commitment.text
    recovery = _batch(employee, worked_minutes_net=120, normal_minutes=0, recovery_minutes=120, recovery_allocations=[{"commitment_id":commitment.json()["id"], "minutes":120}])
    recovery.update(work_date="2026-09-02", idempotency_key="hst-r120-after-legacy")
    assert client.post("/api/v1/attendance/manual-days/batch", json=recovery).status_code == 200
    balance = client.get(f"/api/v1/employees/{employee}/balance", params={"date_from":"2026-09-01", "date_to":"2026-09-02"}).json()
    assert (balance["ordinary_minutes"], balance["adjustment_minutes"], balance["recovery_credit_minutes"]) == (360, 120, 0)
    assert client.post(f"/api/v1/payroll/periods/{period['id']}/calculate").status_code == 200
    report = client.get(f"/api/v1/payroll/periods/{period['id']}/daily-report")
    assert report.status_code == 200, report.text
    origin_day = next(day for day in report.json()["daily"] if day["work_date"] == "2026-09-01")
    assert (origin_day["ordinary_minutes"], origin_day["recognized_minutes"]) == (360, 480)


def test_recovery_credit_does_not_treat_approved_overtime_as_origin_coverage(client, db_session):
    """A24: E120 paga adicional; no cubre el faltante N de un permiso."""
    _login(client); employee = _employee(client, db_session)
    schedule = {"effective_from":"2026-08-01", "monday_minutes":480, "tuesday_minutes":480, "wednesday_minutes":480, "thursday_minutes":480, "friday_minutes":480}
    assert client.post(f"/api/v1/employees/{employee}/schedule", json=schedule).status_code == 201
    origin = _batch(employee, worked_minutes_net=360, normal_minutes=360)
    origin["idempotency_key"] = "hst-origin-n360-overtime"
    assert client.post("/api/v1/attendance/manual-days/batch", json=origin).status_code == 200
    overtime = client.post(f"/api/v1/employees/{employee}/adjustments", json={"adjustment_date":"2026-09-01", "minutes":120, "adjustment_type":"OVERTIME", "reason":"Adicional legado separado"})
    assert overtime.status_code == 201, overtime.text
    assert client.patch(f"/api/v1/adjustments/{overtime.json()['id']}/approve").status_code == 200
    commitment = client.post("/api/v1/attendance/recovery-commitments", json={"employee_id":employee, "permission_date":"2026-09-01", "agreed_minutes":120, "covered_before":False, "reference":"Permiso no cubierto por adicional"})
    assert commitment.status_code == 200, commitment.text
    recovery = _batch(employee, worked_minutes_net=120, normal_minutes=0, recovery_minutes=120, recovery_allocations=[{"commitment_id":commitment.json()["id"], "minutes":120}])
    recovery.update(work_date="2026-09-02", idempotency_key="hst-r120-after-overtime")
    assert client.post("/api/v1/attendance/manual-days/batch", json=recovery).status_code == 200
    balance = client.get(f"/api/v1/employees/{employee}/balance", params={"date_from":"2026-09-01", "date_to":"2026-09-02"}).json()
    assert (balance["ordinary_minutes"], balance["overtime_minutes"], balance["recovery_credit_minutes"]) == (360, 120, 120)

def test_reviewed_additional_approves_incremental_amount(client, db_session):
    _login(client); employee = _employee(client, db_session)
    payload = _batch(employee, worked_minutes_net=90, normal_minutes=0, additional_minutes=90, payment_method="REVIEWED", payment_concept="Feriado trabajado", source_reference="Acta RRHH 001", reviewed_additional_amount="125.50")
    payload["idempotency_key"] = "hst-reviewed-amount"; payload["approve_additional"] = True; payload["preview_token"] = _preview_token(client, payload)
    response = client.post("/api/v1/attendance/manual-days/batch", json=payload)
    assert response.status_code == 200, response.text
    item = client.get(f"/api/v1/attendance/manual-days/{response.json()['created'][0]}").json()
    assert item["payment_status"] == "APPROVED"
    assert item["approved_additional_amount"] == "125.50"

def test_reviewed_additional_requires_positive_amount_concept_and_reference(client, db_session):
    _login(client); employee = _employee(client, db_session)
    base = dict(worked_minutes_net=60, normal_minutes=0, additional_minutes=60, payment_method="REVIEWED", payment_concept="Adicional revisado", source_reference="Acta HST 01", reviewed_additional_amount="10.00")
    for index, override in enumerate(({"reviewed_additional_amount": "0"}, {"payment_concept": ""}, {"source_reference": ""})):
        payload = _batch(employee, **(base | override))
        payload["idempotency_key"] = f"hst-reviewed-invalid-{index}"
        response = client.post("/api/v1/attendance/manual-days/preview", json=payload)
        assert response.status_code == 422, response.text

def test_manual_distribution_enters_payroll_fingerprint_and_invalidates_calculation(client, db_session):
    _login(client); employee = _employee(client, db_session)
    assert client.post(f"/api/v1/employees/{employee}/salary-settings", json={"effective_from":"2026-08-01","monthly_salary":"1500.00","overtime_enabled":True}).status_code == 201
    assert client.post(f"/api/v1/employees/{employee}/schedule", json={"effective_from":"2026-08-01","monday_minutes":480,"tuesday_minutes":480,"wednesday_minutes":480,"thursday_minutes":480,"friday_minutes":480}).status_code == 201
    period = client.post("/api/v1/payroll/periods", json={"name":"Septiembre 2026","start_date":"2026-09-01","end_date":"2026-09-30"}).json()
    payload = _batch(employee, worked_minutes_net=60, normal_minutes=0, additional_minutes=60, payment_method="REVIEWED", payment_concept="Adicional contractual", source_reference="Acta 22", reviewed_additional_amount="12.50")
    payload["idempotency_key"] = "hst-payroll-fingerprint"; payload["approve_additional"] = True; payload["preview_token"] = _preview_token(client, payload)
    assert client.post("/api/v1/attendance/manual-days/batch", json=payload).status_code == 200
    records = client.post(f"/api/v1/payroll/periods/{period['id']}/calculate").json()
    assert records[0]["overtime_minutes"] == 60 and records[0]["overtime_amount"] == "12.50"
    fingerprint = db_session.get(PayrollPeriod, uuid.UUID(period["id"])).inputs_fingerprint
    item = client.get("/api/v1/attendance/manual-days").json()[0]
    update = {"employee_id":employee,"worked_minutes_net":60,"normal_minutes":60,"additional_minutes":0,"recovery_minutes":0,"reason":"Reclasificación justificada","recovery_allocations":[],"expected_version":item["version"]}
    update["preview_token"] = _preview_token(client, {"work_date": "2026-09-01", "rows": [{key: value for key, value in update.items() if key not in {"expected_version", "preview_token"}}], "idempotency_key": "fingerprint-edit-preview", "editing_manual_day_id": item["id"], "expected_version": item["version"]})
    assert client.patch(f"/api/v1/attendance/manual-days/{item['id']}", json=update).status_code == 200
    db_session.expire_all(); state = db_session.get(PayrollPeriod, uuid.UUID(period["id"]))
    assert state.status == "OPEN" and state.inputs_fingerprint is None
    recalculated = client.post(f"/api/v1/payroll/periods/{period['id']}/calculate").json()[0]
    assert recalculated["overtime_minutes"] == 0
    db_session.expire_all(); assert db_session.get(PayrollPeriod, uuid.UUID(period["id"])).inputs_fingerprint != fingerprint

def test_manual_p_is_real_work_but_not_ordinary_and_never_creates_phantom_adjustment(client, db_session):
    """A02/A04: W is shown as work, N is the only ordinary recognition."""
    _login(client); employee = _employee(client, db_session)
    assert client.post(f"/api/v1/employees/{employee}/salary-settings", json={"effective_from":"2026-08-01","monthly_salary":"1500.00","overtime_enabled":True}).status_code == 201
    assert client.post(f"/api/v1/employees/{employee}/schedule", json={"effective_from":"2026-08-01","monday_minutes":480,"tuesday_minutes":480,"wednesday_minutes":480,"thursday_minutes":480,"friday_minutes":480}).status_code == 201
    period = client.post("/api/v1/payroll/periods", json={"name":"HST P 2026","start_date":"2026-09-01","end_date":"2026-09-30"}).json()
    payload = _batch(employee, worked_minutes_net=480, normal_minutes=0, additional_minutes=480, payment_method="REVIEWED", payment_concept="Adicional autorizado", source_reference="Acta HST P", reviewed_additional_amount="125.50")
    payload.update(idempotency_key="hst-p-no-ordinary", approve_additional=True)
    payload["preview_token"] = _preview_token(client, payload)
    assert client.post("/api/v1/attendance/manual-days/batch", json=payload).status_code == 200
    calculated = client.post(f"/api/v1/payroll/periods/{period['id']}/calculate")
    assert calculated.status_code == 200, calculated.text
    assert calculated.json()[0]["adjustment_minutes"] == 0
    report = client.get(f"/api/v1/payroll/periods/{period['id']}/daily-report")
    assert report.status_code == 200, report.text
    day = next(item for item in report.json()["daily"] if item["work_date"] == "2026-09-01")
    assert (day["worked_minutes"], day["ordinary_minutes"], day["additional_minutes"], day["recovery_minutes"], day["recognized_minutes"]) == (480, 0, 480, 0, 0)

def test_approval_rejects_changed_preview_and_repeat_is_stable(client, db_session):
    """A08/A10: actual salary changes invalidate approval; replay is stable."""
    from app.modules.audit.models import AuditLog

    _login(client); employee = _employee(client, db_session)
    assert client.post(f"/api/v1/employees/{employee}/salary-settings", json={"effective_from":"2026-08-01","monthly_salary":"1500.00","overtime_enabled":True}).status_code == 201
    assert client.post(f"/api/v1/employees/{employee}/schedule", json={"effective_from":"2026-08-01","monday_minutes":480,"tuesday_minutes":480,"wednesday_minutes":480,"thursday_minutes":480,"friday_minutes":480}).status_code == 201
    payload = _batch(employee, worked_minutes_net=60, normal_minutes=0, additional_minutes=60, payment_method="OVERTIME")
    payload["idempotency_key"] = "hst-approval-stale"
    created = client.post("/api/v1/attendance/manual-days/batch", json=payload).json()["created"][0]
    item = client.get(f"/api/v1/attendance/manual-days/{created}").json()
    # A real salary configuration becomes effective after the manager saw the
    # preview.  Approval must not silently approve the new, unseen amount.
    changed = client.post(f"/api/v1/employees/{employee}/salary-settings", json={"effective_from":"2026-09-01","monthly_salary":"3000.00","overtime_enabled":True})
    assert changed.status_code == 201, changed.text
    stale = client.post(f"/api/v1/attendance/manual-days/{created}/payment/approve", json={"expected_version": 1, "expected_snapshot": item["payment_snapshot"]})
    assert stale.status_code == 409 and stale.json()["detail"]["code"] == "STALE_PREVIEW"

    refreshed_preview = client.post("/api/v1/attendance/manual-days/preview", json=payload)
    assert refreshed_preview.status_code == 200, refreshed_preview.text
    fresh_snapshot = refreshed_preview.json()["rows"][0]["payment"]
    approved = client.post(f"/api/v1/attendance/manual-days/{created}/payment/approve", json={"expected_version": 1, "expected_snapshot": fresh_snapshot})
    assert approved.status_code == 200, approved.text
    replay = client.post(f"/api/v1/attendance/manual-days/{created}/payment/approve", json={"expected_version": 1, "expected_snapshot": fresh_snapshot})
    assert replay.status_code == 200
    assert replay.json()["version"] == approved.json()["version"] == 2
    assert db_session.query(AuditLog).filter(AuditLog.entity_id == uuid.UUID(created), AuditLog.action == "payment_approved").count() == 1


def test_reviewed_ordinary_amount_cannot_bypass_actual_overtime_policy(client, db_session):
    """A13: REVIEWED is not a path around the live ordinary minimum."""
    _login(client); employee = _employee(client, db_session)
    assert client.post(f"/api/v1/employees/{employee}/salary-settings", json={"effective_from":"2026-08-01","monthly_salary":"1500.00","overtime_enabled":True}).status_code == 201
    assert client.post(f"/api/v1/employees/{employee}/schedule", json={"effective_from":"2026-08-01","monday_minutes":480,"tuesday_minutes":480,"wednesday_minutes":480,"thursday_minutes":480,"friday_minutes":480}).status_code == 201
    payload = _batch(employee, worked_minutes_net=120, normal_minutes=0, additional_minutes=120, payment_method="REVIEWED", payment_concept="Adicional ordinario", source_reference="Acta A13", reviewed_additional_amount="0.01")
    payload["idempotency_key"] = "hst-reviewed-below-live-policy"
    rejected = client.post("/api/v1/attendance/manual-days/preview", json=payload)
    assert rejected.status_code == 422, rejected.text
    assert rejected.json()["detail"]["code"] == "REVIEWED_AMOUNT_BELOW_POLICY"


def test_reviewed_approval_revalidates_live_salary_minimum(client, db_session):
    """A08/A13: subir salario tras guardar REVIEWED pendiente devuelve 409."""
    _login(client); employee = _employee(client, db_session)
    assert client.post(f"/api/v1/employees/{employee}/salary-settings", json={"effective_from":"2026-08-01","monthly_salary":"1500.00","overtime_enabled":True}).status_code == 201
    assert client.post(f"/api/v1/employees/{employee}/schedule", json={"effective_from":"2026-08-01","monday_minutes":480,"tuesday_minutes":480,"wednesday_minutes":480,"thursday_minutes":480,"friday_minutes":480}).status_code == 201
    payload = _batch(employee, worked_minutes_net=120, normal_minutes=0, additional_minutes=120, payment_method="REVIEWED", payment_concept="Adicional ordinario", source_reference="Acta A13 pendiente", reviewed_additional_amount="16.00")
    payload["idempotency_key"] = "hst-reviewed-live-minimum"
    created = client.post("/api/v1/attendance/manual-days/batch", json=payload)
    assert created.status_code == 200, created.text
    item_id = created.json()["created"][0]
    snapshot = client.get(f"/api/v1/attendance/manual-days/{item_id}").json()["payment_snapshot"]
    assert client.post(f"/api/v1/employees/{employee}/salary-settings", json={"effective_from":"2026-09-01","monthly_salary":"3000.00","overtime_enabled":True}).status_code == 201
    response = client.post(f"/api/v1/attendance/manual-days/{item_id}/payment/approve", json={"expected_version":1, "expected_snapshot":snapshot})
    assert response.status_code == 409, response.text
    assert response.json()["detail"]["code"] == "STALE_PREVIEW"

def test_recreate_after_version_and_void_uses_monotonic_version(client, db_session):
    """A26/A27: an audited lineage never reuses version 1."""
    _login(client); employee = _employee(client, db_session)
    payload = _batch(employee, worked_minutes_net=120, normal_minutes=120); payload["idempotency_key"] = "hst-lineage-v1"
    first = client.post("/api/v1/attendance/manual-days/batch", json=payload).json()["created"][0]
    patch = {"employee_id": employee, "worked_minutes_net": 120, "normal_minutes": 120, "additional_minutes": 0, "recovery_minutes": 0, "reason": "Motivo corregido", "recovery_allocations": [], "expected_version": 1}
    patch["preview_token"] = _preview_token(client, {"work_date":"2026-09-01", "rows":[{key:value for key,value in patch.items() if key not in {"expected_version", "preview_token"}}], "idempotency_key":"hst-lineage-preview", "editing_manual_day_id":first, "expected_version":1})
    second = client.patch(f"/api/v1/attendance/manual-days/{first}", json=patch).json()
    assert second["version"] == 2
    assert client.post(f"/api/v1/attendance/manual-days/{second['id']}/void", json={"expected_version":2,"reason":"Anulación documentada"}).status_code == 200
    payload["idempotency_key"] = "hst-lineage-v3"
    recreated = client.post("/api/v1/attendance/manual-days/batch", json=payload)
    assert recreated.status_code == 200, recreated.text
    assert client.get(f"/api/v1/attendance/manual-days/{recreated.json()['created'][0]}").json()["version"] == 4

def test_duplicate_recovery_commitment_and_blank_payment_method_are_rejected(client, db_session):
    """A11/A23: no implicit payment route or duplicate permission credit."""
    _login(client); employee = _employee(client, db_session)
    commitment = {"employee_id":employee,"permission_date":"2026-09-01","agreed_minutes":60,"covered_before":False,"reference":"Permiso único"}
    assert client.post("/api/v1/attendance/recovery-commitments", json=commitment).status_code == 200
    duplicate = client.post("/api/v1/attendance/recovery-commitments", json=commitment)
    assert duplicate.status_code == 409 and duplicate.json()["detail"]["code"] == "RECOVERY_COMMITMENT_EXISTS"
    bad = _batch(employee, worked_minutes_net=60, normal_minutes=0, additional_minutes=60)
    bad["idempotency_key"] = "hst-payment-required"
    assert client.post("/api/v1/attendance/manual-days/preview", json=bad).status_code == 422

def test_closed_root_uses_editable_rectification_and_checks_recovery_permission_date(client, db_session):
    """A17-A20: all affected dates use the latest editable root version."""
    from app.modules.payroll.models import PERIOD_CALCULATED, PERIOD_CLOSED, PERIOD_OPEN
    _login(client); employee = _employee(client, db_session)
    root = uuid.uuid4()
    closed = PayrollPeriod(name="Cerrado", start_date=date(2026, 9, 1), end_date=date(2026, 9, 30), status=PERIOD_CLOSED, root_period_id=root, version=1)
    db_session.add(closed); db_session.commit()
    blocked = client.post("/api/v1/attendance/manual-days/batch", json=_batch(employee))
    assert blocked.status_code == 409 and blocked.json()["detail"]["code"] == "PAYROLL_CLOSED"
    rectification = PayrollPeriod(name="Rectificación", start_date=date(2026, 9, 1), end_date=date(2026, 9, 30), status=PERIOD_CALCULATED, root_period_id=root, version=2, supersedes_period_id=closed.id)
    db_session.add(rectification); db_session.commit()
    allowed = _batch(employee); allowed["idempotency_key"] = "hst-rectification-open"
    assert client.post("/api/v1/attendance/manual-days/batch", json=allowed).status_code == 200
    db_session.refresh(closed); db_session.refresh(rectification)
    assert closed.status == PERIOD_CLOSED and rectification.status == PERIOD_OPEN
