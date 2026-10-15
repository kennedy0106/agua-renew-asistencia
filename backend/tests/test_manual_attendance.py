"""HST-01: carga histórica sin contaminar las sesiones del kiosco."""
from datetime import date
import uuid

from app.modules.attendance.manual_models import ManualAttendanceDay
from app.modules.attendance.manual_models import ManualAttendanceIdempotency
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


def _approve_adjustment(client, adjustment: dict):
    response = client.patch(f"/api/v1/adjustments/{adjustment['id']}/approve", json={
        "expected_version": adjustment["version"], "expected_snapshot": adjustment["approval_snapshot"],
        "idempotency_key": f"manual-approve-{adjustment['id']}",
    })
    assert response.status_code == 200, response.text
    return response

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


def test_h693_batch_receipt_is_scoped_and_returns_original_result(client, db_session):
    """C01/C03/C07: an authenticated v2 receipt replays before day state."""
    _login(client); employee = _employee(client, db_session)
    payload = _batch(employee, worked_minutes_net=120, normal_minutes=120)
    payload["idempotency_key"] = "hst-h693-batch-receipt"
    first = client.post("/api/v1/attendance/manual-days/batch", json=payload)
    assert first.status_code == 200, first.text
    second = client.post("/api/v1/attendance/manual-days/batch", json=payload)
    assert second.status_code == 200 and second.json() == first.json()
    receipt = db_session.get(ManualAttendanceIdempotency, payload["idempotency_key"])
    assert receipt.protocol_version == 2 and receipt.operation_type == "BATCH" and receipt.actor_user_id is not None
    queried = client.get(f"/api/v1/attendance/manual-operations/{payload['idempotency_key']}")
    assert queried.status_code == 200 and queried.json()["result"] == first.json()
    changed = {**payload, "rows": [{**payload["rows"][0], "worked_minutes_net": 60, "normal_minutes": 60}]}
    conflict = client.post("/api/v1/attendance/manual-days/batch", json=changed)
    assert conflict.status_code == 409 and conflict.json()["detail"]["code"] == "IDEMPOTENCY_CONFLICT"
    assert db_session.query(ManualAttendanceDay).count() == 1
    client.cookies.clear()
    assert client.get(f"/api/v1/attendance/manual-operations/{payload['idempotency_key']}").status_code == 401
    assert client.post("/api/v1/auth/login", json={"username": "boss", "password": "Boss123!"}).status_code == 200
    assert client.get(f"/api/v1/attendance/manual-operations/{payload['idempotency_key']}").status_code == 404
    client.cookies.clear()
    assert client.post("/api/v1/auth/login", json={"username": "supervisor", "password": "Sup123!"}).status_code == 200
    assert client.get(f"/api/v1/attendance/manual-operations/{payload['idempotency_key']}").status_code == 403


def test_h693_replay_binds_the_preview_decision_and_hides_unscoped_v1(client, db_session):
    """B09/C03/C12: retry metadata is excluded, but preview is not a free pass."""
    _login(client); employee = _employee(client, db_session)
    payload = _batch(employee, worked_minutes_net=120, normal_minutes=120)
    payload["idempotency_key"] = "hst-h693-preview-bound"
    first = client.post("/api/v1/attendance/manual-days/batch", json=payload)
    assert first.status_code == 200, first.text
    # A batch replay with a different expected preview is a different
    # decision, even if the underlying row happens to be the same.
    altered = {**payload, "preview_token": "b" * 64}
    rejected = client.post("/api/v1/attendance/manual-days/batch", json=altered)
    assert rejected.status_code == 409
    assert rejected.json()["detail"]["code"] == "IDEMPOTENCY_CONFLICT"
    db_session.add(ManualAttendanceIdempotency(
        idempotency_key="hst-h693-v1-unscoped", payload_hash="c" * 64,
        result={"created": ["legacy"]}, protocol_version=1,
    ))
    db_session.commit()
    legacy = client.get("/api/v1/attendance/manual-operations/hst-h693-v1-unscoped")
    assert legacy.status_code == 404
    assert legacy.json()["detail"]["code"] == "OPERATION_NOT_CONFIRMED"


def test_h693_preview_binds_configuration_identity_even_when_amount_is_equal(client, db_session):
    """B02: sueldo/jornada proporcionales no pueden conservar una decisión vieja."""
    from app.modules.salary.models import SalarySetting
    from app.modules.schedules.models import WorkSchedule

    _login(client); employee = _employee(client, db_session)
    assert client.post(f"/api/v1/employees/{employee}/salary-settings", json={"effective_from":"2026-08-01", "monthly_salary":"1500.00", "overtime_enabled":True}).status_code == 201
    assert client.post(f"/api/v1/employees/{employee}/schedule", json={"effective_from":"2026-08-01", "monday_minutes":480, "tuesday_minutes":480, "wednesday_minutes":480, "thursday_minutes":480, "friday_minutes":480}).status_code == 201
    payload = _batch(employee, worked_minutes_net=120, normal_minutes=0, additional_minutes=120, payment_method="OVERTIME")
    payload.update(idempotency_key="hst-h693-config-identity", approve_additional=True)
    payload["preview_token"] = _preview_token(client, payload)
    salary = db_session.query(SalarySetting).filter_by(employee_id=uuid.UUID(employee)).one()
    schedule = db_session.query(WorkSchedule).filter_by(employee_id=uuid.UUID(employee)).one()
    salary.monthly_salary = 3000
    for field in ("monday_minutes", "tuesday_minutes", "wednesday_minutes", "thursday_minutes", "friday_minutes"):
        setattr(schedule, field, 960)
    db_session.commit()
    response = client.post("/api/v1/attendance/manual-days/batch", json=payload)
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "STALE_PREVIEW"


def test_h693_persists_the_exact_validated_valuation_without_second_estimate(client, db_session, monkeypatch):
    """B03: un cambio tras construir preview no altera el importe persistido."""
    from app.modules.attendance.manual_service import ManualAttendanceService
    from app.modules.salary.models import SalarySetting

    _login(client); employee = _employee(client, db_session)
    assert client.post(f"/api/v1/employees/{employee}/salary-settings", json={"effective_from":"2026-08-01", "monthly_salary":"1500.00", "overtime_enabled":True}).status_code == 201
    assert client.post(f"/api/v1/employees/{employee}/schedule", json={"effective_from":"2026-08-01", "monday_minutes":480, "tuesday_minutes":480, "wednesday_minutes":480, "thursday_minutes":480, "friday_minutes":480}).status_code == 201
    payload = _batch(employee, worked_minutes_net=120, normal_minutes=0, additional_minutes=120, payment_method="OVERTIME")
    payload.update(idempotency_key="hst-h693-one-valuation", approve_additional=True)
    preview = client.post("/api/v1/attendance/manual-days/preview", json=payload).json()
    payload["preview_token"] = preview["preview_token"]
    expected_amount = preview["rows"][0]["payment"]["amount"]
    original = ManualAttendanceService.preview

    def change_after_verified(self, request, **kwargs):
        result = original(self, request, **kwargs)
        self.db.query(SalarySetting).filter_by(employee_id=uuid.UUID(employee)).one().monthly_salary = 9000
        return result

    monkeypatch.setattr(ManualAttendanceService, "preview", change_after_verified)
    response = client.post("/api/v1/attendance/manual-days/batch", json=payload)
    assert response.status_code == 200, response.text
    item = client.get(f"/api/v1/attendance/manual-days/{response.json()['created'][0]}").json()
    assert item["approved_additional_amount"] == expected_amount
    assert item["payment_snapshot"]["amount"] == expected_amount


def test_h693_unrelated_integrity_failure_rolls_back_instead_of_claiming_duplicate(client, db_session, monkeypatch):
    """B07/C11: sólo la restricción del día se traduce a MANUAL_DAY_EXISTS."""
    import pytest
    from sqlalchemy.exc import IntegrityError
    from app.modules.audit.repository import AuditRepository

    _login(client); employee = _employee(client, db_session)
    def fail_audit(*args, **kwargs):
        raise IntegrityError("audit insert", {}, Exception("different constraint"))
    monkeypatch.setattr(AuditRepository, "create", fail_audit)
    with pytest.raises(IntegrityError):
        client.post("/api/v1/attendance/manual-days/batch", json=_batch(employee))
    assert db_session.query(ManualAttendanceDay).count() == 0
    assert db_session.query(ManualAttendanceIdempotency).count() == 0


def test_h693_ambiguous_commit_recovers_receipt_or_reports_unknown(db_session):
    """C10: error de commit sólo converge si existe el recibo durable exacto."""
    import pytest
    from fastapi import HTTPException
    from sqlalchemy.exc import OperationalError
    from app.modules.attendance.manual_operations import commit_with_receipt_recovery
    from app.modules.users.models import User

    actor = db_session.query(User).filter_by(username="admin").one()
    key = "hst-h693-ambiguous-commit"
    digest = "d" * 64
    result = {"created": ["durable-result"]}
    db_session.add(ManualAttendanceIdempotency(
        idempotency_key=key, payload_hash=digest, result=result,
        protocol_version=2, actor_user_id=actor.id, operation_type="BATCH", http_status=200,
    ))
    db_session.commit()

    class AmbiguousSession:
        def __init__(self, bind): self.bind = bind; self.rolled_back = False
        def commit(self): raise OperationalError("COMMIT", {}, Exception("connection lost"))
        def rollback(self): self.rolled_back = True
        def get_bind(self): return self.bind

    recovered = commit_with_receipt_recovery(
        AmbiguousSession(db_session.get_bind()), key=key, digest=digest, actor_id=actor.id,
        operation_type="BATCH", target_manual_day_id=None, result=result,
    )
    assert recovered == result
    with pytest.raises(HTTPException) as raised:
        commit_with_receipt_recovery(
            AmbiguousSession(db_session.get_bind()), key="hst-h693-not-committed", digest=digest,
            actor_id=actor.id, operation_type="BATCH", target_manual_day_id=None, result=result,
        )
    assert raised.value.status_code == 503
    assert raised.value.detail["code"] == "OPERATION_RESULT_UNKNOWN"


def test_e08_http_commit_and_rollback_failures_keep_controlled_unknown(client, db_session, monkeypatch):
    """E08: real HTTP batch keeps 503 when commit and cleanup both lose connectivity."""
    from sqlalchemy.exc import OperationalError

    _login(client); employee = _employee(client, db_session)
    original_commit, original_rollback = db_session.commit, db_session.rollback
    monkeypatch.setattr(db_session, "commit", lambda: (_ for _ in ()).throw(OperationalError("COMMIT", {}, Exception("offline"))))
    monkeypatch.setattr(db_session, "rollback", lambda: (_ for _ in ()).throw(OperationalError("ROLLBACK", {}, Exception("offline"))))
    response = client.post("/api/v1/attendance/manual-days/batch", json=_batch(employee, idempotency_key="hst-e08-cleanup-fails"))
    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "OPERATION_RESULT_UNKNOWN"
    # Restore explicitly before the shared SQLite fixture tears down, then
    # prove the original DTO/key can make one later, revalidated decision.
    monkeypatch.setattr(db_session, "commit", original_commit)
    monkeypatch.setattr(db_session, "rollback", original_rollback)
    db_session.rollback()
    recovered = client.post("/api/v1/attendance/manual-days/batch", json=_batch(employee, idempotency_key="hst-e08-cleanup-fails"))
    assert recovered.status_code == 200, recovered.text
    assert db_session.query(ManualAttendanceDay).count() == 1


def test_batch_business_http_error_rolls_back_and_keeps_its_contract(client, db_session, monkeypatch):
    """Only the helper's ambiguous 503 bypasses batch cleanup, never 409 business errors."""
    from app.modules.attendance.manual_service import ManualAttendanceService

    _login(client); employee = _employee(client, db_session)
    original_preview, original_rollback = ManualAttendanceService.preview, db_session.rollback
    rollbacks: list[str] = []

    def payment_not_approvable(self, payload, **kwargs):
        return {"preview_token": "p" * 64, "rows": [{"payment": {"status": "NOT_APPLICABLE", "amount": None}}]}

    def tracked_rollback():
        rollbacks.append("rollback")
        return original_rollback()

    monkeypatch.setattr(ManualAttendanceService, "preview", payment_not_approvable)
    monkeypatch.setattr(db_session, "rollback", tracked_rollback)
    payload = _batch(employee, worked_minutes_net=120, normal_minutes=0, additional_minutes=120, payment_method="OVERTIME")
    payload.update(approve_additional=True, preview_token="p" * 64, idempotency_key="hst-business-error-rolls-back")
    response = client.post("/api/v1/attendance/manual-days/batch", json=payload)
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "PAYMENT_REVIEW_REQUIRED"
    assert rollbacks == ["rollback"]
    assert db_session.query(ManualAttendanceDay).count() == 0
    assert db_session.query(ManualAttendanceIdempotency).count() == 0
    monkeypatch.setattr(ManualAttendanceService, "preview", original_preview)


def test_e09_http_commit_cleanup_failure_recovers_exact_durable_receipt(client, db_session, monkeypatch):
    """E09/E11: one healthy alternative connection returns the original receipt once."""
    from app.modules.audit.models import AuditLog
    from sqlalchemy.exc import OperationalError

    _login(client); employee = _employee(client, db_session)
    payload = _batch(employee, idempotency_key="hst-e09-committed-receipt")
    original_commit, original_rollback = db_session.commit, db_session.rollback

    def commit_then_disconnect():
        original_commit()
        raise OperationalError("COMMIT", {}, Exception("response lost after commit"))

    monkeypatch.setattr(db_session, "commit", commit_then_disconnect)
    monkeypatch.setattr(db_session, "rollback", lambda: (_ for _ in ()).throw(OperationalError("ROLLBACK", {}, Exception("offline"))))
    first = client.post("/api/v1/attendance/manual-days/batch", json=payload)
    assert first.status_code == 200, first.text
    monkeypatch.setattr(db_session, "commit", original_commit)
    monkeypatch.setattr(db_session, "rollback", original_rollback)
    replay = client.post("/api/v1/attendance/manual-days/batch", json=payload)
    assert replay.status_code == 200 and replay.json() == first.json()
    assert db_session.query(ManualAttendanceDay).count() == 1
    assert db_session.query(ManualAttendanceIdempotency).filter_by(idempotency_key=payload["idempotency_key"]).count() == 1
    assert db_session.query(AuditLog).filter_by(action="created").count() == 1


def test_e10_alternative_recovery_connection_failure_is_stable_unknown(client, db_session, monkeypatch):
    """E10: a failed sole recovery connection neither loops nor guesses success."""
    from sqlalchemy.exc import OperationalError
    import app.modules.attendance.manual_operations as manual_operations

    _login(client); employee = _employee(client, db_session)
    original_commit, original_rollback = db_session.commit, db_session.rollback

    class OfflineRecovery:
        def __init__(self, bind):
            self.bind = bind
        def __enter__(self):
            raise OperationalError("SELECT", {}, Exception("offline"))
        def __exit__(self, *args):
            return False

    monkeypatch.setattr(db_session, "commit", lambda: (_ for _ in ()).throw(OperationalError("COMMIT", {}, Exception("offline"))))
    monkeypatch.setattr(db_session, "rollback", lambda: (_ for _ in ()).throw(OperationalError("ROLLBACK", {}, Exception("offline"))))
    monkeypatch.setattr(manual_operations, "Session", OfflineRecovery)
    response = client.post("/api/v1/attendance/manual-days/batch", json=_batch(employee, idempotency_key="hst-e10-alt-offline"))
    assert response.status_code == 503
    assert response.json()["detail"] == {"code": "OPERATION_RESULT_UNKNOWN", "message": "No se pudo confirmar el resultado; reintente con la misma clave"}
    monkeypatch.setattr(db_session, "commit", original_commit)
    monkeypatch.setattr(db_session, "rollback", original_rollback)
    db_session.rollback()
    assert db_session.query(ManualAttendanceDay).count() == 0


def test_e12_programming_error_is_not_relabelled_as_ambiguous_result(db_session):
    """E12: implementation defects retain their exception type for diagnosis."""
    import pytest
    from sqlalchemy.exc import ProgrammingError
    from app.modules.attendance.manual_operations import commit_with_receipt_recovery
    from app.modules.users.models import User

    actor = db_session.query(User).filter_by(username="admin").one()

    class BrokenImplementationSession:
        def commit(self):
            raise ProgrammingError("COMMIT", {}, Exception("bad SQL"))

    with pytest.raises(ProgrammingError):
        commit_with_receipt_recovery(
            BrokenImplementationSession(), key="hst-e12-programming", digest="p" * 64,
            actor_id=actor.id, operation_type="BATCH", target_manual_day_id=None, result={"created": []},
        )


def test_e04_closed_edit_is_rejected_then_rectification_allows_the_same_business_change(client, db_session):
    """E04: a previewed edit cannot cross CLOSED, but an editable rectification can."""
    from app.modules.payroll.models import PERIOD_CLOSED, PERIOD_OPEN

    _login(client); employee = _employee(client, db_session)
    source = client.post("/api/v1/attendance/manual-days/batch", json=_batch(employee, idempotency_key="hst-e04-source"))
    assert source.status_code == 200
    source_id = source.json()["created"][0]
    patch = {"employee_id": employee, "worked_minutes_net": 120, "normal_minutes": 120, "additional_minutes": 0, "recovery_minutes": 0, "reason": "Edición E04", "recovery_allocations": [], "expected_version": 1, "idempotency_key": "hst-e04-edit"}
    patch["preview_token"] = _preview_token(client, {"work_date": "2026-09-01", "rows": [{key: value for key, value in patch.items() if key not in {"expected_version", "preview_token", "idempotency_key"}}], "idempotency_key": "hst-e04-preview", "editing_manual_day_id": source_id, "expected_version": 1})
    root = uuid.uuid4()
    closed = PayrollPeriod(name="E04 cerrado", start_date=date(2026, 9, 1), end_date=date(2026, 9, 30), status=PERIOD_CLOSED, root_period_id=root, version=1)
    db_session.add(closed); db_session.commit()
    blocked = client.patch(f"/api/v1/attendance/manual-days/{source_id}", json=patch)
    assert blocked.status_code == 409 and blocked.json()["detail"]["code"] == "PAYROLL_CLOSED"
    rectification = PayrollPeriod(name="E04 rectificación", start_date=date(2026, 9, 1), end_date=date(2026, 9, 30), status=PERIOD_OPEN, root_period_id=root, version=2, supersedes_period_id=closed.id)
    db_session.add(rectification); db_session.commit()
    accepted = client.patch(f"/api/v1/attendance/manual-days/{source_id}", json={**patch, "idempotency_key": "hst-e04-after-rectification"})
    assert accepted.status_code == 200, accepted.text


def test_h693_operation_query_database_failure_is_not_reported_as_missing(db_session, monkeypatch):
    """C10: no poder consultar no equivale a confirmar que no hubo commit."""
    import pytest
    from fastapi import HTTPException
    from sqlalchemy.exc import OperationalError
    from app.modules.attendance.manual_service import ManualAttendanceService
    from app.modules.users.models import User

    actor = db_session.query(User).filter_by(username="admin").one()
    monkeypatch.setattr(db_session, "get", lambda *args, **kwargs: (_ for _ in ()).throw(OperationalError("SELECT", {}, Exception("offline"))))
    with pytest.raises(HTTPException) as raised:
        ManualAttendanceService(db_session).get_operation("unknown-key", actor.id)
    assert raised.value.status_code == 503
    assert raised.value.detail["code"] == "OPERATION_RESULT_UNKNOWN"


def test_h693_update_and_void_replay_their_immutable_receipts(client, db_session):
    """C04/C05/C09: retries do not create a successor/audit twice."""
    from app.modules.audit.models import AuditLog
    _login(client); employee = _employee(client, db_session)
    source = client.post("/api/v1/attendance/manual-days/batch", json=_batch(employee)).json()["created"][0]
    patch = {"employee_id": employee, "worked_minutes_net": 360, "normal_minutes": 360, "additional_minutes": 0, "recovery_minutes": 0, "reason": "Corrección H693", "recovery_allocations": [], "expected_version": 1, "idempotency_key": "hst-h693-update"}
    patch["preview_token"] = _preview_token(client, {"work_date": "2026-09-01", "rows": [{key: value for key, value in patch.items() if key not in {"expected_version", "preview_token", "idempotency_key"}}], "idempotency_key": "preview-h693-update", "editing_manual_day_id": source, "expected_version": 1})
    first = client.patch(f"/api/v1/attendance/manual-days/{source}", json=patch)
    second = client.patch(f"/api/v1/attendance/manual-days/{source}", json=patch)
    assert first.status_code == second.status_code == 200 and second.json()["id"] == first.json()["id"]
    replacement = first.json()
    assert db_session.query(AuditLog).filter(AuditLog.action == "versioned_update").count() == 1
    next_patch = {**patch, "worked_minutes_net": 300, "normal_minutes": 300, "expected_version": replacement["version"], "idempotency_key": "hst-h693-update-two"}
    next_patch["preview_token"] = _preview_token(client, {"work_date": "2026-09-01", "rows": [{key: value for key, value in next_patch.items() if key not in {"expected_version", "preview_token", "idempotency_key"}}], "idempotency_key": "preview-h693-update-two", "editing_manual_day_id": replacement["id"], "expected_version": replacement["version"]})
    latest = client.patch(f"/api/v1/attendance/manual-days/{replacement['id']}", json=next_patch)
    assert latest.status_code == 200, latest.text
    queried_original = client.get("/api/v1/attendance/manual-operations/hst-h693-update")
    assert queried_original.status_code == 200
    assert queried_original.json()["result"]["id"] == replacement["id"]
    void = {"expected_version": latest.json()["version"], "reason": "Anulación H693", "idempotency_key": "hst-h693-void"}
    assert client.post(f"/api/v1/attendance/manual-days/{latest.json()['id']}/void", json=void).json() == client.post(f"/api/v1/attendance/manual-days/{latest.json()['id']}/void", json=void).json()
    assert db_session.query(AuditLog).filter(AuditLog.action == "voided").count() == 1
    closed = PayrollPeriod(name="Cierre replay H693", start_date=date(2026, 9, 1), end_date=date(2026, 9, 30), status="CLOSED")
    db_session.add(closed); db_session.commit()
    assert client.patch(f"/api/v1/attendance/manual-days/{source}", json=patch).json() == first.json()
    assert client.post(f"/api/v1/attendance/manual-days/{latest.json()['id']}/void", json=void).status_code == 200


def test_h693_new_decision_against_voided_version_is_stale_not_missing(client, db_session):
    """C08: una fila anulada existe, pero una nueva decisión sobre ella quedó obsoleta."""
    _login(client); employee = _employee(client, db_session)
    item_id = client.post("/api/v1/attendance/manual-days/batch", json=_batch(employee)).json()["created"][0]
    first = {"expected_version": 1, "reason": "Anulación inicial", "idempotency_key": "hst-h693-first-void"}
    assert client.post(f"/api/v1/attendance/manual-days/{item_id}/void", json=first).status_code == 200
    second = {**first, "idempotency_key": "hst-h693-second-void"}
    response = client.post(f"/api/v1/attendance/manual-days/{item_id}/void", json=second)
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "STALE_VERSION"

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
    patch = {"employee_id": employee, "worked_minutes_net": 390, "normal_minutes": 390, "additional_minutes": 0, "recovery_minutes": 0, "reason": "Corrección documentada", "recovery_allocations": [], "expected_version": 1, "idempotency_key": "hst-versioned-update"}
    patch["preview_token"] = _preview_token(client, {"work_date": "2026-09-01", "rows": [{key: value for key, value in patch.items() if key not in {"expected_version", "preview_token"}}], "idempotency_key": "edit-preview-test", "editing_manual_day_id": created, "expected_version": 1})
    updated = client.patch(f"/api/v1/attendance/manual-days/{created}", json=patch)
    assert updated.status_code == 200, updated.text
    assert updated.json()["worked_minutes_net"] == 390 and updated.json()["version"] == 2
    stale = client.patch(f"/api/v1/attendance/manual-days/{updated.json()['id']}", json={**patch, "expected_version": 1, "idempotency_key": "hst-versioned-update-stale"})
    assert stale.status_code == 409 and stale.json()["detail"]["code"] == "STALE_VERSION"
    audit = db_session.query(AuditLog).filter(AuditLog.action == "versioned_update").one()
    assert str(audit.entity_id) == updated.json()["id"] and audit.old_values["version"] == 1 and audit.new_values["version"] == 2
    assert client.post(f"/api/v1/attendance/manual-days/{updated.json()['id']}/void", json={"expected_version":2,"reason":"Anulación de prueba", "idempotency_key":"hst-versioned-void"}).status_code == 200

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
    assert client.post(f"/api/v1/attendance/manual-days/{item['id']}/void", json={"expected_version": item["version"], "reason":"Prueba de reversión", "idempotency_key":"hst-recovery-credit-void"}).status_code == 200
    assert client.get(f"/api/v1/employees/{employee}/balance", params={"date_from":"2026-09-01", "date_to":"2026-09-02"}).json()["recovery_credit_minutes"] == 0


def test_h693_cross_month_update_invalidates_work_and_permission_periods(client, db_session):
    """A01/A06: a September R changes the August origin fingerprint, not August W."""
    _login(client); employee = _employee(client, db_session)
    assert client.post(f"/api/v1/employees/{employee}/salary-settings", json={"effective_from":"2026-08-01", "monthly_salary":"1500.00", "overtime_enabled":True}).status_code == 201
    assert client.post(f"/api/v1/employees/{employee}/schedule", json={"effective_from":"2026-08-01", "monday_minutes":480, "tuesday_minutes":480, "wednesday_minutes":480, "thursday_minutes":480, "friday_minutes":480}).status_code == 201
    august = client.post("/api/v1/payroll/periods", json={"name":"Agosto H693", "start_date":"2026-08-01", "end_date":"2026-08-31"}).json()
    september = client.post("/api/v1/payroll/periods", json={"name":"Septiembre H693", "start_date":"2026-09-01", "end_date":"2026-09-30"}).json()
    commitment = client.post("/api/v1/attendance/recovery-commitments", json={"employee_id":employee, "permission_date":"2026-08-31", "agreed_minutes":120, "covered_before":False, "reference":"Permiso agosto H693"}).json()
    created = client.post("/api/v1/attendance/manual-days/batch", json=_batch(employee, worked_minutes_net=120, normal_minutes=120)).json()["created"][0]
    assert client.post(f"/api/v1/payroll/periods/{august['id']}/calculate").status_code == 200
    assert client.post(f"/api/v1/payroll/periods/{september['id']}/calculate").status_code == 200
    patch = {"employee_id":employee, "worked_minutes_net":120, "normal_minutes":0, "additional_minutes":0, "recovery_minutes":120, "reason":"Recuperación cruzada H693", "recovery_allocations":[{"commitment_id":commitment["id"], "minutes":120}], "expected_version":1, "idempotency_key":"hst-h693-cross-month"}
    patch["preview_token"] = _preview_token(client, {"work_date":"2026-09-01", "rows":[{key:value for key,value in patch.items() if key not in {"expected_version", "preview_token", "idempotency_key"}}], "idempotency_key":"preview-h693-cross-month", "editing_manual_day_id":created, "expected_version":1})
    updated = client.patch(f"/api/v1/attendance/manual-days/{created}", json=patch)
    assert updated.status_code == 200, updated.text
    db_session.expire_all()
    assert db_session.get(PayrollPeriod, uuid.UUID(august["id"])).status == "OPEN"
    assert db_session.get(PayrollPeriod, uuid.UUID(september["id"])).status == "OPEN"
    august_rows = client.post(f"/api/v1/payroll/periods/{august['id']}/calculate").json()
    assert august_rows[0]["worked_minutes"] == 0  # incoming R never becomes origin-month work


def test_h693_moves_recovery_origin_then_removes_it_without_residual_credit(client, db_session):
    """A02/A03/A06: mover y retirar R invalida los tres meses y sólo acredita el origen activo."""
    from app.modules.attendance.manual_models import ManualRecoveryApplication
    _login(client); employee = _employee(client, db_session)
    assert client.post(f"/api/v1/employees/{employee}/salary-settings", json={"effective_from":"2026-07-01", "monthly_salary":"1500.00", "overtime_enabled":True}).status_code == 201
    assert client.post(f"/api/v1/employees/{employee}/schedule", json={"effective_from":"2026-07-01", "monday_minutes":480, "tuesday_minutes":480, "wednesday_minutes":480, "thursday_minutes":480, "friday_minutes":480}).status_code == 201
    periods = {
        month: client.post("/api/v1/payroll/periods", json={"name":f"{month} H693", "start_date":start, "end_date":end}).json()
        for month, start, end in (("julio","2026-07-01","2026-07-31"),("agosto","2026-08-01","2026-08-31"),("septiembre","2026-09-01","2026-09-30"))
    }
    july = client.post("/api/v1/attendance/recovery-commitments", json={"employee_id":employee,"permission_date":"2026-07-20","agreed_minutes":120,"covered_before":False,"reference":"Permiso julio"}).json()
    august = client.post("/api/v1/attendance/recovery-commitments", json={"employee_id":employee,"permission_date":"2026-08-20","agreed_minutes":120,"covered_before":False,"reference":"Permiso agosto"}).json()
    initial = _batch(employee, worked_minutes_net=120, normal_minutes=0, recovery_minutes=120, recovery_allocations=[{"commitment_id":july["id"],"minutes":120}])
    initial.update(work_date="2026-09-03", idempotency_key="hst-h693-origin-july")
    source = client.post("/api/v1/attendance/manual-days/batch", json=initial).json()["created"][0]
    for period in periods.values(): assert client.post(f"/api/v1/payroll/periods/{period['id']}/calculate").status_code == 200
    old_fingerprints = {name: db_session.get(PayrollPeriod, uuid.UUID(period["id"])).inputs_fingerprint for name, period in periods.items()}
    move = {"employee_id":employee,"worked_minutes_net":120,"normal_minutes":0,"additional_minutes":0,"recovery_minutes":120,"reason":"Mover recuperación a agosto","recovery_allocations":[{"commitment_id":august["id"],"minutes":120}],"expected_version":1,"idempotency_key":"hst-h693-move-origin"}
    move["preview_token"] = _preview_token(client, {"work_date":"2026-09-03","rows":[{k:v for k,v in move.items() if k not in {"expected_version","idempotency_key"}}],"idempotency_key":"preview-move-origin","editing_manual_day_id":source,"expected_version":1})
    moved = client.patch(f"/api/v1/attendance/manual-days/{source}", json=move)
    assert moved.status_code == 200, moved.text
    db_session.expire_all()
    for period in periods.values():
        current = db_session.get(PayrollPeriod, uuid.UUID(period["id"]))
        assert current.status == "OPEN" and current.inputs_fingerprint is None
    july_balance = client.get(f"/api/v1/employees/{employee}/balance?date_from=2026-07-20&date_to=2026-07-20").json()
    august_balance = client.get(f"/api/v1/employees/{employee}/balance?date_from=2026-08-20&date_to=2026-08-20").json()
    assert july_balance["recovery_credit_minutes"] == 0 and august_balance["recovery_credit_minutes"] == 120
    for name, period in periods.items():
        assert client.post(f"/api/v1/payroll/periods/{period['id']}/calculate").status_code == 200
        db_session.expire_all()
        assert db_session.get(PayrollPeriod, uuid.UUID(period["id"])).inputs_fingerprint != old_fingerprints[name]
    remove = {**move,"worked_minutes_net":120,"normal_minutes":120,"recovery_minutes":0,"recovery_allocations":[],"expected_version":moved.json()["version"],"idempotency_key":"hst-h693-remove-origin"}
    remove["preview_token"] = _preview_token(client, {"work_date":"2026-09-03","rows":[{k:v for k,v in remove.items() if k not in {"expected_version","idempotency_key","preview_token"}}],"idempotency_key":"preview-remove-origin","editing_manual_day_id":moved.json()["id"],"expected_version":moved.json()["version"]})
    removed = client.patch(f"/api/v1/attendance/manual-days/{moved.json()['id']}", json=remove)
    assert removed.status_code == 200, removed.text
    assert client.get(f"/api/v1/employees/{employee}/balance?date_from=2026-08-20&date_to=2026-08-20").json()["recovery_credit_minutes"] == 0
    effective_apps = db_session.query(ManualRecoveryApplication).join(ManualAttendanceDay).filter(ManualAttendanceDay.voided_at.is_(None)).count()
    assert effective_apps == 0

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
    _approve_adjustment(client, adjustment.json())
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
    _approve_adjustment(client, overtime.json())
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
    update = {"employee_id":employee,"worked_minutes_net":60,"normal_minutes":60,"additional_minutes":0,"recovery_minutes":0,"reason":"Reclasificación justificada","recovery_allocations":[],"expected_version":item["version"],"idempotency_key":"hst-fingerprint-update"}
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
    stale = client.post(f"/api/v1/attendance/manual-days/{created}/payment/approve", json={"expected_version": 1, "expected_snapshot": item["payment_snapshot"], "idempotency_key":"hst-approval-stale-request"})
    assert stale.status_code == 409 and stale.json()["detail"]["code"] == "STALE_PREVIEW"

    refreshed_preview = client.post("/api/v1/attendance/manual-days/preview", json=payload)
    assert refreshed_preview.status_code == 200, refreshed_preview.text
    fresh_snapshot = refreshed_preview.json()["rows"][0]["payment"]
    approval_payload = {"expected_version": 1, "expected_snapshot": fresh_snapshot, "idempotency_key": "hst-approval-receipt"}
    approved = client.post(f"/api/v1/attendance/manual-days/{created}/payment/approve", json=approval_payload)
    assert approved.status_code == 200, approved.text
    replay = client.post(f"/api/v1/attendance/manual-days/{created}/payment/approve", json=approval_payload)
    assert replay.status_code == 200
    assert replay.json()["version"] == approved.json()["version"] == 2
    assert replay.json() == approved.json()
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
    response = client.post(f"/api/v1/attendance/manual-days/{item_id}/payment/approve", json={"expected_version":1, "expected_snapshot":snapshot, "idempotency_key":"hst-reviewed-live-minimum-approve"})
    assert response.status_code == 409, response.text
    assert response.json()["detail"]["code"] == "STALE_PREVIEW"

def test_recreate_after_version_and_void_uses_monotonic_version(client, db_session):
    """A26/A27: an audited lineage never reuses version 1."""
    _login(client); employee = _employee(client, db_session)
    payload = _batch(employee, worked_minutes_net=120, normal_minutes=120); payload["idempotency_key"] = "hst-lineage-v1"
    first = client.post("/api/v1/attendance/manual-days/batch", json=payload).json()["created"][0]
    patch = {"employee_id": employee, "worked_minutes_net": 120, "normal_minutes": 120, "additional_minutes": 0, "recovery_minutes": 0, "reason": "Motivo corregido", "recovery_allocations": [], "expected_version": 1, "idempotency_key":"hst-lineage-update"}
    patch["preview_token"] = _preview_token(client, {"work_date":"2026-09-01", "rows":[{key:value for key,value in patch.items() if key not in {"expected_version", "preview_token"}}], "idempotency_key":"hst-lineage-preview", "editing_manual_day_id":first, "expected_version":1})
    second = client.patch(f"/api/v1/attendance/manual-days/{first}", json=patch).json()
    assert second["version"] == 2
    assert client.post(f"/api/v1/attendance/manual-days/{second['id']}/void", json={"expected_version":2,"reason":"Anulación documentada", "idempotency_key":"hst-lineage-void"}).status_code == 200
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
