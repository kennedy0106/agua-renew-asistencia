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

def test_manual_day_versioned_update_and_void(client, db_session):
    from app.modules.audit.models import AuditLog
    _login(client); employee = _employee(client, db_session)
    created = client.post("/api/v1/attendance/manual-days/batch", json=_batch(employee)).json()["created"][0]
    patch = {"employee_id": employee, "worked_minutes_net": 390, "normal_minutes": 390, "additional_minutes": 0, "recovery_minutes": 0, "reason": "Corrección documentada", "recovery_allocations": [], "expected_version": 1}
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

def test_reviewed_additional_approves_incremental_amount(client, db_session):
    _login(client); employee = _employee(client, db_session)
    payload = _batch(employee, worked_minutes_net=90, normal_minutes=0, additional_minutes=90, payment_method="REVIEWED", payment_concept="Feriado trabajado", source_reference="Acta RRHH 001", reviewed_additional_amount="125.50")
    payload["idempotency_key"] = "hst-reviewed-amount"; payload["approve_additional"] = True
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
    payload["idempotency_key"] = "hst-payroll-fingerprint"; payload["approve_additional"] = True
    assert client.post("/api/v1/attendance/manual-days/batch", json=payload).status_code == 200
    records = client.post(f"/api/v1/payroll/periods/{period['id']}/calculate").json()
    assert records[0]["overtime_minutes"] == 60 and records[0]["overtime_amount"] == "12.50"
    fingerprint = db_session.get(PayrollPeriod, uuid.UUID(period["id"])).inputs_fingerprint
    item = client.get("/api/v1/attendance/manual-days").json()[0]
    update = {"employee_id":employee,"worked_minutes_net":60,"normal_minutes":60,"additional_minutes":0,"recovery_minutes":0,"reason":"Reclasificación justificada","recovery_allocations":[],"expected_version":item["version"]}
    assert client.patch(f"/api/v1/attendance/manual-days/{item['id']}", json=update).status_code == 200
    db_session.expire_all(); state = db_session.get(PayrollPeriod, uuid.UUID(period["id"]))
    assert state.status == "OPEN" and state.inputs_fingerprint is None
    recalculated = client.post(f"/api/v1/payroll/periods/{period['id']}/calculate").json()[0]
    assert recalculated["overtime_minutes"] == 0
    db_session.expire_all(); assert db_session.get(PayrollPeriod, uuid.UUID(period["id"])).inputs_fingerprint != fingerprint
