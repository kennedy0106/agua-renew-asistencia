"""Sesión verificada y recuperación supervisada (R2/R4/R5).

Pruebas aisladas con SQLite en memoria; no tocan PostgreSQL real ni
infraestructura. La autorización de un jefe nunca debe editar una asistencia
confirmada ni emitir un token de marcación nuevo.
"""

from datetime import datetime, timedelta, timezone
import uuid

import jwt
import pytest
from sqlalchemy import func, select

from app.core.config import get_settings
from app.core.security import create_attendance_token, decode_attendance_token
from app.modules.attendance.models import (
    AttendanceAttemptResolution,
    AttendanceConsumedNonce,
    AttendanceEvent,
    AttendanceEvidence,
    AttendancePreparation,
    AttendanceRecoveryRequest,
    AttendanceRecord,
)
from app.modules.audit.models import AuditLog

from tests.image_helpers import valid_jpeg_b64


def test_public_recovery_returns_historical_review_without_consumed(client, db_session):
    from app.modules.users.models import User

    _login(client)
    employee_id = _employee(client, db_session)
    token = _identify(client)["marking_token"]
    nonce = decode_attendance_token(token)["nonce"]
    actor = db_session.scalar(select(User).where(User.username == "admin"))
    old_time = datetime(2026, 10, 21, 14, 0, tzinfo=timezone.utc)
    record = AttendanceRecord(
        employee_id=uuid.UUID(employee_id),
        work_date=old_time.date(),
        check_in_at=old_time,
        status="OPEN",
    )
    db_session.add(record)
    db_session.flush()
    record_id = record.id
    db_session.add(AttendanceAttemptResolution(
        nonce=nonce,
        employee_id=record.employee_id,
        device_id=uuid.UUID(_device_id(client)),
        action="CHECK_IN",
        resolution="REVIEWED_CONFIRMED",
        attendance_record_id=record_id,
        reason="Confirmación histórica verificada",
        resolved_by_user_id=actor.id,
    ))
    db_session.commit()
    request = _create_recovery_request(client, _expire_marking_token(token))
    resolved = client.post(
        f"/api/v1/attendance/recovery-requests/admin/{request['id']}/resolve",
        json={"decision": "CONFIRM_EXISTING", "reason": "Devolver el registro revisado"},
    )
    assert resolved.status_code == 200, resolved.text
    public = client.get(f"/api/v1/attendance/recovery-requests/{request['id']}")
    assert public.status_code == 200
    confirmation = public.json()["confirmation"]
    assert confirmation is not None
    assert confirmation["id"] == str(record_id)
    assert confirmation["work_date"] == "2026-10-21"
    # SQLite drops tzinfo on roundtrip; production PostgreSQL retains UTC.
    returned_time = datetime.fromisoformat(confirmation["check_in_at"])
    if returned_time.tzinfo is None:
        returned_time = returned_time.replace(tzinfo=timezone.utc)
    assert returned_time == old_time
    assert public.json()["can_reidentify"] is False
    assert _count(db_session, AttendanceConsumedNonce) == 0
    assert _count(db_session, AttendanceRecord) == 1


def _login(client, username: str = "admin", password: str = "Admin123!") -> None:
    assert client.post(
        "/api/v1/auth/login", json={"username": username, "password": password}
    ).status_code == 200


def _employee(client, db_session, *, dni: str = "72845632", employee_code: str = "EMP-001") -> str:
    response = client.post(
        "/api/v1/employees",
        json={
            "dni": dni,
            "employee_code": employee_code,
            "first_name": "Ana",
            "last_name": "López",
            "job_role_id": str(db_session._test_job_roles["Operario"]),
        },
    )
    assert response.status_code == 201, response.text
    return response.json()["id"]


def _identify(client, identifier: str = "EMP-001") -> dict:
    response = client.post("/api/v1/attendance/identify", json={"identifier": identifier})
    assert response.status_code == 200, response.text
    return response.json()


def _device_id(client) -> str:
    from app.core.security import decode_terminal_token

    payload = decode_terminal_token(client.cookies.get("agua_renew_terminal"))
    assert payload is not None
    return str(payload["sub"])


def _prepare(client, token: str, **overrides) -> dict:
    payload = {
        "latitude": -12.046374,
        "longitude": -77.042793,
        "accuracy_m": 12.5,
        "age_ms": 1500,
    }
    payload.update(overrides)
    response = client.post(
        "/api/v1/attendance/attempt/prepare",
        json={"marking_token": token, "location": payload},
    )
    assert response.status_code == 200, response.text
    return response.json()


def _store_photo(client, token: str, color=(1, 2, 3)) -> None:
    response = client.post(
        "/api/v1/attendance/evidence",
        json={
            "marking_token": token,
            "image_base64": valid_jpeg_b64(color=color),
            "content_type": "image/jpeg",
        },
    )
    assert response.status_code == 201, response.text


def _expire_marking_token(token: str) -> str:
    settings = get_settings()
    payload = jwt.decode(
        token,
        settings.secret_key,
        algorithms=[settings.jwt_algorithm],
        options={"verify_exp": False},
    )
    payload["exp"] = datetime.now(timezone.utc) - timedelta(minutes=5)
    return jwt.encode(payload, settings.secret_key, algorithm=settings.jwt_algorithm)


def _create_recovery_request(client, token: str, expected: int = 201) -> dict:
    response = client.post(
        "/api/v1/attendance/recovery-requests", json={"marking_token": token}
    )
    assert response.status_code == expected, response.text
    return response.json()


def _open_second_browser(db_session, identifier: str = "EMP-001"):
    from fastapi.testclient import TestClient

    from app.db.session import get_db
    from app.main import app

    other = TestClient(app)

    def _override():
        yield db_session

    app.dependency_overrides[get_db] = _override
    identified = other.post("/api/v1/attendance/identify", json={"identifier": identifier})
    assert identified.status_code == 200, identified.text
    return other


def _count(db_session, model) -> int:
    db_session.expire_all()
    return int(db_session.scalar(select(func.count()).select_from(model)) or 0)


# --- R2: terminal/verify ---


def test_verify_requires_cookie_token_and_same_browser_without_attendance_effects(
    client, db_session
):
    _login(client)
    _employee(client, db_session)
    identified = _identify(client)
    token = identified["marking_token"]
    device_id = _device_id(client)

    verified = client.post(
        "/api/v1/attendance/terminal/verify", json={"marking_token": token}
    )
    assert verified.status_code == 200, verified.text
    body = verified.json()
    assert body["verified"] is True
    assert body["employee_id"] == identified["employee"]["id"]
    assert body["action"] == "CHECK_IN"
    assert body["device_id"] == device_id
    fresh = body["marking_token"]
    # Verificar no renueva ni extiende el permiso: mismo token y vencimiento.
    assert fresh == token
    decoded_original = decode_attendance_token(token)
    assert decoded_original is not None
    assert body["expires_at"] is not None

    # Sin efectos de asistencia: sólo la identificación previa (que no escribe).
    assert _count(db_session, AttendanceRecord) == 0
    assert _count(db_session, AttendanceEvent) == 0
    assert _count(db_session, AttendanceConsumedNonce) == 0
    assert _count(db_session, AttendancePreparation) == 0
    assert _count(db_session, AttendanceEvidence) == 0


def test_verify_distinguishes_missing_invalid_revoked_expired_and_foreign(client, db_session):
    _login(client)
    _employee(client, db_session)
    identified = _identify(client)
    token = identified["marking_token"]
    device_id = _device_id(client)

    client.cookies.clear()
    missing = client.post("/api/v1/attendance/terminal/verify", json={"marking_token": token})
    assert missing.status_code == 401
    assert missing.json()["detail"]["code"] == "TERMINAL_COOKIE_MISSING"

    client.cookies.set("agua_renew_terminal", "not-a-jwt")
    invalid = client.post("/api/v1/attendance/terminal/verify", json={"marking_token": token})
    assert invalid.status_code == 401
    assert invalid.json()["detail"]["code"] == "TERMINAL_SESSION_INVALID"

    # Restaurar el contexto original y revocarlo desde ADMIN.
    client.cookies.clear()
    _login(client)
    fresh = _identify(client)
    device_id = _device_id(client)
    revoked = client.post(f"/api/v1/devices/{device_id}/revoke")
    assert revoked.status_code == 200
    revoked_verify = client.post(
        "/api/v1/attendance/terminal/verify", json={"marking_token": fresh["marking_token"]}
    )
    assert revoked_verify.status_code == 401
    assert revoked_verify.json()["detail"]["code"] == "TERMINAL_SESSION_REVOKED"

    # Navegador nuevo con su propia cookie y un token ajeno.
    _login(client)
    own = _identify(client)
    other = _open_second_browser(db_session)
    try:
        other_token = _identify(other)["marking_token"]
        foreign = client.post(
            "/api/v1/attendance/terminal/verify", json={"marking_token": other_token}
        )
        assert foreign.status_code == 401
        assert foreign.json()["detail"]["code"] == "MARKING_TOKEN_FOREIGN_DEVICE"
    finally:
        other.close()

    expired = client.post(
        "/api/v1/attendance/terminal/verify",
        json={"marking_token": _expire_marking_token(own["marking_token"])},
    )
    assert expired.status_code == 401
    assert expired.json()["detail"]["code"] == "MARKING_TOKEN_EXPIRED"


def test_verify_rejects_token_without_signed_browser(client, db_session):
    _login(client)
    employee_id = _employee(client, db_session)
    _identify(client)  # establece cookie/contexto
    unbound = create_attendance_token(employee_id, action="CHECK_IN", device_id=None)
    response = client.post(
        "/api/v1/attendance/terminal/verify", json={"marking_token": unbound}
    )
    assert response.status_code == 401
    assert response.json()["detail"]["code"] == "MARKING_TOKEN_NOT_BOUND"


# --- R4: solicitud pública ---


def test_recovery_request_accepts_expired_token_and_stores_no_full_token(client, db_session):
    _login(client)
    _employee(client, db_session)
    identified = _identify(client)
    token = identified["marking_token"]
    _prepare(client, token)
    expired = _expire_marking_token(token)

    created = _create_recovery_request(client, expired)
    assert created["status"] == "PENDING"
    assert created["can_reidentify"] is False
    assert created["confirmation"] is None

    row = db_session.scalar(select(AttendanceRecoveryRequest))
    assert row is not None
    assert row.nonce == decode_attendance_token(token)["nonce"]
    assert str(row.employee_id) == identified["employee"]["id"]
    assert row.action == "CHECK_IN"
    assert row.status == "PENDING"
    assert row.token_sha256 is not None and len(row.token_sha256) == 64
    assert row.token_sha256 != expired
    assert row.token_issued_at is not None
    assert row.token_expires_at is not None
    assert str(row.original_device_id) == _device_id(client)
    assert str(row.requester_device_id) == _device_id(client)

    # Una solicitud no crea resolución ni asistencia: no autoriza marcar.
    assert _count(db_session, AttendanceAttemptResolution) == 0
    assert _count(db_session, AttendanceRecord) == 0


def test_recovery_request_is_idempotent_per_nonce_and_requester(client, db_session):
    _login(client)
    _employee(client, db_session)
    token = _identify(client)["marking_token"]
    expired = _expire_marking_token(token)

    first = _create_recovery_request(client, expired)
    second = _create_recovery_request(client, expired, expected=200)
    assert second["id"] == first["id"]
    assert _count(db_session, AttendanceRecoveryRequest) == 1


def test_recovery_request_bootstraps_cookie_and_get_proves_ownership(client, db_session):
    _login(client)
    _employee(client, db_session)
    token = _identify(client)["marking_token"]
    expired = _expire_marking_token(token)
    original_device = _device_id(client)

    client.cookies.clear()
    created = _create_recovery_request(client, expired)
    new_cookie = client.cookies.get("agua_renew_terminal")
    assert new_cookie
    assert _device_id(client) != original_device

    own = client.get(f"/api/v1/attendance/recovery-requests/{created['id']}")
    assert own.status_code == 200
    assert own.json()["id"] == created["id"]
    assert own.json()["status"] == "PENDING"

    other = _open_second_browser(db_session)
    try:
        denied = other.get(f"/api/v1/attendance/recovery-requests/{created['id']}")
        assert denied.status_code == 404
        assert denied.json()["detail"]["code"] == "RECOVERY_REQUEST_NOT_FOUND"
    finally:
        other.close()


def test_recovery_request_rejects_unreadable_signature_without_rows(client, db_session):
    _login(client)
    _employee(client, db_session)
    token = _identify(client)["marking_token"]
    tampered = token[:-2] + ("aa" if not token.endswith("aa") else "bb")
    response = client.post(
        "/api/v1/attendance/recovery-requests", json={"marking_token": tampered}
    )
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "RECOVERY_TOKEN_UNREADABLE"
    assert _count(db_session, AttendanceRecoveryRequest) == 0


def test_recovery_request_rate_limit(client, db_session):
    _login(client)
    _employee(client, db_session)
    for index in range(5):
        token = _identify(client)["marking_token"]
        _create_recovery_request(client, _expire_marking_token(token))
    sixth = _identify(client)["marking_token"]
    limited = client.post(
        "/api/v1/attendance/recovery-requests",
        json={"marking_token": _expire_marking_token(sixth)},
    )
    assert limited.status_code == 429
    assert limited.json()["detail"]["code"] == "RECOVERY_RATE_LIMITED"


# --- R5: panel y resolución ---


def _request_with_preparation(client, db_session) -> tuple[str, dict]:
    token = _identify(client)["marking_token"]
    _prepare(client, token)
    request = _create_recovery_request(client, token)
    return token, request


def test_admin_can_inspect_preparation_only_and_authorize_under_lock(client, db_session):
    _login(client)
    _employee(client, db_session)
    token, request = _request_with_preparation(client, db_session)

    listing = client.get("/api/v1/attendance/recovery-requests/admin")
    assert listing.status_code == 200
    assert [item["id"] for item in listing.json()] == [request["id"]]
    assert listing.json()[0]["employee_name"] == "Ana López"

    detail = client.get(f"/api/v1/attendance/recovery-requests/admin/{request['id']}")
    assert detail.status_code == 200
    body = detail.json()
    assert body["attempt"]["state"] == "PREPARATION_ONLY"
    assert body["attempt"]["inconsistent"] is False
    assert body["attempt"]["can_authorize"] is True
    assert body["attempt"]["preparation"]["marked_at"] is not None
    assert body["attempt"]["evidence"]["ready"] is False
    assert body["attempt"]["consumed"]["present"] is False
    assert body["attempt"]["resolution"]["present"] is False
    assert "AUTHORIZE_REIDENTIFY" in body["attempt"]["available_actions"]

    nonce = str(decode_attendance_token(token)["nonce"])
    legacy = client.get(f"/api/v1/attendance/attempts/{nonce}")
    assert legacy.status_code == 200
    assert legacy.json()["state"] == "PREPARATION_ONLY"
    assert legacy.json()["preparation"]["marked_at"] is not None

    resolved = client.post(
        f"/api/v1/attendance/recovery-requests/admin/{request['id']}/resolve",
        json={"decision": "AUTHORIZE_REIDENTIFY", "reason": "Revisión autorizada por jefe"},
    )
    assert resolved.status_code == 200, resolved.text
    resolved_body = resolved.json()
    assert resolved_body["request"]["status"] == "AUTHORIZED"
    assert resolved_body["request"]["resolved_by_username"] == "admin"
    assert resolved_body["attempt"]["state"] == "CANCELLED"
    assert resolved_body["attempt"]["resolution"]["resolution"] == "CANCELLED_UNCONFIRMED"
    assert resolved_body["attempt"]["resolution"]["resolved_by_user_id"] is not None
    db_session.expire_all()
    resolution_row = db_session.scalar(select(AttendanceAttemptResolution))
    assert resolution_row is not None
    assert str(resolution_row.device_id) == _device_id(client)

    # El navegador solicitante ve la aceptación y puede volver a identificarse.
    public = client.get(f"/api/v1/attendance/recovery-requests/{request['id']}")
    assert public.status_code == 200
    assert public.json()["can_reidentify"] is True
    status_attempt = client.post(
        "/api/v1/attendance/attempt/status", json={"marking_token": token}
    )
    assert status_attempt.status_code == 200
    assert status_attempt.json()["state"] == "CANCELLED"
    assert status_attempt.json()["can_restart"] is True

    # Un envío tardío con el nonce viejo se rechaza por la resolución durable.
    late = client.post("/api/v1/attendance/check-in", json={"marking_token": token})
    assert late.status_code == 409

    audit = db_session.scalar(
        select(AuditLog).where(AuditLog.action == "RECOVERY_REQUEST_RESOLVED")
    )
    assert audit is not None
    assert audit.reason == "Revisión autorizada por jefe"
    assert audit.performed_by is not None


def test_admin_can_authorize_signed_nonce_without_rows(client, db_session):
    _login(client)
    _employee(client, db_session)
    token = _identify(client)["marking_token"]
    request = _create_recovery_request(client, token)

    detail = client.get(f"/api/v1/attendance/recovery-requests/admin/{request['id']}").json()
    assert detail["attempt"]["state"] == "EMPTY"
    assert detail["attempt"]["can_authorize"] is True

    resolved = client.post(
        f"/api/v1/attendance/recovery-requests/admin/{request['id']}/resolve",
        json={"decision": "AUTHORIZE_REIDENTIFY", "reason": "Nonce firmado sin filas"},
    )
    assert resolved.status_code == 200
    assert resolved.json()["request"]["status"] == "AUTHORIZED"


def test_admin_confirmed_attempt_is_returned_without_editing(client, db_session):
    _login(client)
    _employee(client, db_session)
    token = _identify(client)["marking_token"]
    _prepare(client, token)
    _store_photo(client, token)
    marked = client.post("/api/v1/attendance/check-in", json={"marking_token": token})
    assert marked.status_code == 201, marked.text
    original = marked.json()

    request = _create_recovery_request(client, _expire_marking_token(token))
    detail = client.get(f"/api/v1/attendance/recovery-requests/admin/{request['id']}")
    assert detail.status_code == 200
    body = detail.json()
    assert body["attempt"]["state"] == "CONFIRMED"
    assert body["attempt"]["record"]["id"] == original["id"]
    assert "CONFIRM_EXISTING" in body["attempt"]["available_actions"]

    resolved = client.post(
        f"/api/v1/attendance/recovery-requests/admin/{request['id']}/resolve",
        json={"decision": "CONFIRM_EXISTING", "reason": "Confirmación existente verificada"},
    )
    assert resolved.status_code == 200, resolved.text
    assert resolved.json()["request"]["status"] == "CONFIRMED_EXISTING"
    assert resolved.json()["attempt"]["record"]["id"] == original["id"]

    # La asistencia confirmada permanece intacta.
    db_session.expire_all()
    record = db_session.get(AttendanceRecord, uuid.UUID(original["id"]))
    assert record is not None
    assert record.check_in_at.isoformat().startswith(original["check_in_at"][:19])
    assert record.status == "OPEN"

    public = client.get(f"/api/v1/attendance/recovery-requests/{request['id']}")
    assert public.status_code == 200
    assert public.json()["confirmation"]["id"] == original["id"]
    assert public.json()["can_reidentify"] is False


def test_admin_rejects_without_authorizing(client, db_session):
    _login(client)
    _employee(client, db_session)
    token = _identify(client)["marking_token"]
    request = _create_recovery_request(client, token)
    resolved = client.post(
        f"/api/v1/attendance/recovery-requests/admin/{request['id']}/resolve",
        json={"decision": "REJECT", "reason": "No corresponde autorizar"},
    )
    assert resolved.status_code == 200
    assert resolved.json()["request"]["status"] == "REJECTED"
    assert resolved.json()["attempt"]["resolution"]["present"] is False
    assert _count(db_session, AttendanceAttemptResolution) == 0


def test_admin_cannot_authorize_inconsistent_attempt(client, db_session):
    _login(client)
    employee_id = _employee(client, db_session)
    token = _identify(client)["marking_token"]
    decoded = decode_attendance_token(token)
    assert decoded is not None
    request = _create_recovery_request(client, token)

    db_session.add(
        AttendanceConsumedNonce(
            nonce=decoded["nonce"],
            action="CHECK_IN",
            event_type="CHECK_IN",
            employee_id=uuid.UUID(employee_id),
            device_id=uuid.UUID(_device_id(client)),
            attendance_record_id=None,
            result_payload=None,
        )
    )
    db_session.commit()

    detail = client.get(f"/api/v1/attendance/recovery-requests/admin/{request['id']}")
    assert detail.json()["attempt"]["state"] == "INCONSISTENT"
    assert detail.json()["attempt"]["inconsistent"] is True
    assert detail.json()["attempt"]["can_authorize"] is False
    assert "AUTHORIZE_REIDENTIFY" not in detail.json()["attempt"]["available_actions"]

    blocked = client.post(
        f"/api/v1/attendance/recovery-requests/admin/{request['id']}/resolve",
        json={"decision": "AUTHORIZE_REIDENTIFY", "reason": "Intento inconsistente"},
    )
    assert blocked.status_code == 409
    assert blocked.json()["detail"]["code"] == "RECOVERY_INCONSISTENT"
    assert _count(db_session, AttendanceAttemptResolution) == 0

    # Rechazar no autoriza ni desbloquea: sólo cierra la solicitud.
    rejected = client.post(
        f"/api/v1/attendance/recovery-requests/admin/{request['id']}/resolve",
        json={"decision": "REJECT", "reason": "Intento inconsistente, revisión manual"},
    )
    assert rejected.status_code == 200
    assert rejected.json()["request"]["status"] == "REJECTED"
    assert _count(db_session, AttendanceAttemptResolution) == 0


def test_recovery_resolution_requires_visible_reason_and_admin_role(client, db_session):
    _login(client)
    _employee(client, db_session)
    token = _identify(client)["marking_token"]
    request = _create_recovery_request(client, token)

    blank = client.post(
        f"/api/v1/attendance/recovery-requests/admin/{request['id']}/resolve",
        json={"decision": "AUTHORIZE_REIDENTIFY", "reason": "   "},
    )
    assert blank.status_code == 422

    _login(client, "supervisor", "Sup123!")
    denied = client.get("/api/v1/attendance/recovery-requests/admin")
    assert denied.status_code == 403

def test_multiple_requesters_same_nonce_resolve_consistently(client, db_session):
    _login(client)
    _employee(client, db_session)
    token = _identify(client)["marking_token"]
    first = _create_recovery_request(client, token)

    other = _open_second_browser(db_session)
    try:
        second = _create_recovery_request(other, token)
        assert second["id"] != first["id"]
        assert _count(db_session, AttendanceRecoveryRequest) == 2

        resolved = client.post(
            f"/api/v1/attendance/recovery-requests/admin/{first['id']}/resolve",
            json={"decision": "AUTHORIZE_REIDENTIFY", "reason": "Cierre único por nonce"},
        )
        assert resolved.status_code == 200, resolved.text

        listed = client.get("/api/v1/attendance/recovery-requests/admin").json()
        assert {item["id"]: item["status"] for item in listed} == {
            first["id"]: "AUTHORIZED",
            second["id"]: "AUTHORIZED",
        }
        assert _count(db_session, AttendanceAttemptResolution) == 1

        own = client.get(f"/api/v1/attendance/recovery-requests/{first['id']}")
        other_view = other.get(f"/api/v1/attendance/recovery-requests/{second['id']}")
        assert own.json()["can_reidentify"] is True
        assert other_view.json()["can_reidentify"] is True
    finally:
        other.close()


def test_unverifiable_original_browser_is_manual_only(client, db_session):
    _login(client)
    employee_id = _employee(client, db_session)
    _identify(client)  # cookie vigente para el solicitante
    unbound = create_attendance_token(employee_id, action="CHECK_IN", device_id=None)
    request = _create_recovery_request(client, unbound)

    detail = client.get(f"/api/v1/attendance/recovery-requests/admin/{request['id']}")
    assert detail.status_code == 200
    assert detail.json()["attempt"]["browser_unverifiable"] is True
    assert detail.json()["attempt"]["state"] == "UNVERIFIABLE_BROWSER"
    assert detail.json()["attempt"]["can_authorize"] is False

    blocked = client.post(
        f"/api/v1/attendance/recovery-requests/admin/{request['id']}/resolve",
        json={"decision": "AUTHORIZE_REIDENTIFY", "reason": "Navegador no demostrable"},
    )
    assert blocked.status_code == 409
    assert blocked.json()["detail"]["code"] == "RECOVERY_BROWSER_UNVERIFIABLE"
    assert _count(db_session, AttendanceAttemptResolution) == 0

    rejected = client.post(
        f"/api/v1/attendance/recovery-requests/admin/{request['id']}/resolve",
        json={"decision": "REJECT", "reason": "Navegador no demostrable"},
    )
    assert rejected.status_code == 200
    assert rejected.json()["request"]["status"] == "REJECTED"


def _other_device_id(other) -> str:
    from app.core.security import decode_terminal_token

    payload = decode_terminal_token(other.cookies.get("agua_renew_terminal"))
    assert payload is not None
    return str(payload["sub"])


def test_confirmation_rejects_consumed_device_mismatch(client, db_session):
    _login(client)
    _employee(client, db_session)
    token = _identify(client)["marking_token"]
    _prepare(client, token)
    _store_photo(client, token)
    assert client.post("/api/v1/attendance/check-in", json={"marking_token": token}).status_code == 201
    request = _create_recovery_request(client, _expire_marking_token(token))

    other = _open_second_browser(db_session)
    try:
        consumed = db_session.scalar(select(AttendanceConsumedNonce))
        assert consumed is not None
        consumed.device_id = uuid.UUID(_other_device_id(other))
        db_session.add(consumed)
        db_session.commit()

        detail = client.get(f"/api/v1/attendance/recovery-requests/admin/{request['id']}")
        assert detail.json()["attempt"]["inconsistent"] is True
        assert detail.json()["attempt"]["record"] is None
        assert "CONFIRM_EXISTING" not in detail.json()["attempt"]["available_actions"]
    finally:
        other.close()


def test_evidence_and_preparation_foreign_devices_are_inconsistent(client, db_session):
    _login(client)
    _employee(client, db_session)
    token = _identify(client)["marking_token"]
    _prepare(client, token)
    _store_photo(client, token)
    request = _create_recovery_request(client, token)

    other = _open_second_browser(db_session)
    try:
        foreign_device = uuid.UUID(_other_device_id(other))
        evidence = db_session.scalar(select(AttendanceEvidence))
        assert evidence is not None
        evidence.device_id = foreign_device
        db_session.add(evidence)
        db_session.commit()

        detail = client.get(f"/api/v1/attendance/recovery-requests/admin/{request['id']}")
        assert detail.json()["attempt"]["inconsistent"] is True
        assert detail.json()["attempt"]["can_authorize"] is False

        # Restaurar la evidencia y comprobar que la preparación ajena también
        # bloquea la autorización automática.
        evidence.device_id = uuid.UUID(_device_id(client))
        db_session.add(evidence)
        preparation = db_session.scalar(select(AttendancePreparation))
        assert preparation is not None
        preparation.device_id = foreign_device
        db_session.add(preparation)
        db_session.commit()

        detail = client.get(f"/api/v1/attendance/recovery-requests/admin/{request['id']}")
        assert detail.json()["attempt"]["inconsistent"] is True
        assert detail.json()["attempt"]["can_authorize"] is False
    finally:
        other.close()

def test_recovery_rate_limit_does_not_block_idempotent_reread(client, db_session):
    _login(client)
    _employee(client, db_session)
    first_token = _identify(client)["marking_token"]
    first = _create_recovery_request(client, first_token)
    for _ in range(4):
        token = _identify(client)["marking_token"]
        _create_recovery_request(client, token)
    sixth_token = _identify(client)["marking_token"]
    limited = client.post(
        "/api/v1/attendance/recovery-requests",
        json={"marking_token": sixth_token},
    )
    assert limited.status_code == 429

    reread = client.post(
        "/api/v1/attendance/recovery-requests", json={"marking_token": first_token}
    )
    assert reread.status_code == 200
    assert reread.json()["id"] == first["id"]


def test_recovery_ip_limit_allows_an_office_with_several_browsers(client, db_session):
    _login(client)
    _employee(client, db_session)
    browsers = []
    try:
        for _ in range(6):
            other = _open_second_browser(db_session)
            browsers.append(other)
            token = _identify(other)["marking_token"]
            created = _create_recovery_request(other, token)
            assert created["status"] == "PENDING"
    finally:
        for other in browsers:
            other.close()


def test_recovery_audit_links_request_entity(client, db_session):
    _login(client)
    _employee(client, db_session)
    token = _identify(client)["marking_token"]
    request = _create_recovery_request(client, token)
    audit = db_session.scalar(
        select(AuditLog).where(AuditLog.action == "RECOVERY_REQUEST_CREATED")
    )
    assert audit is not None
    assert str(audit.entity_id) == request["id"]


def test_evidence_record_link_without_consumed_is_inconsistent(client, db_session):
    _login(client)
    employee_id = _employee(client, db_session)
    token = _identify(client)["marking_token"]
    _prepare(client, token)
    _store_photo(client, token)
    request = _create_recovery_request(client, token)

    evidence = db_session.scalar(select(AttendanceEvidence))
    assert evidence is not None
    # Simula una evidencia que afirma un registro sin consumo.
    orphan = AttendanceRecord(
        employee_id=uuid.UUID(employee_id),
        work_date=datetime.now(timezone.utc).date(),
        check_in_at=datetime.now(timezone.utc),
        status="OPEN",
    )
    db_session.add(orphan)
    db_session.flush()
    evidence.attendance_record_id = orphan.id
    db_session.add(evidence)
    db_session.commit()

    detail = client.get(f"/api/v1/attendance/recovery-requests/admin/{request['id']}")
    assert detail.json()["attempt"]["inconsistent"] is True
    assert detail.json()["attempt"]["can_authorize"] is False


def test_payload_diverging_from_real_record_is_inconsistent(client, db_session):
    _login(client)
    _employee(client, db_session)
    token = _identify(client)["marking_token"]
    _prepare(client, token)
    _store_photo(client, token)
    marked = client.post("/api/v1/attendance/check-in", json={"marking_token": token})
    assert marked.status_code == 201
    request = _create_recovery_request(client, _expire_marking_token(token))

    consumed = db_session.scalar(select(AttendanceConsumedNonce))
    assert consumed is not None
    payload = dict(consumed.result_payload or {})
    payload["event_type"] = "CHECK_OUT"  # diverge del CHECK_IN real
    consumed.result_payload = payload
    db_session.add(consumed)
    db_session.commit()

    detail = client.get(f"/api/v1/attendance/recovery-requests/admin/{request['id']}")
    assert detail.json()["attempt"]["inconsistent"] is True
    assert detail.json()["attempt"]["record"] is None

def test_recovery_migration_is_additive_and_refuses_history_deletion(tmp_path):
    from io import StringIO
    from pathlib import Path
    import re

    from alembic import command
    from alembic.config import Config

    def make_config(output: StringIO) -> Config:
        config = Config(output_buffer=output)
        config.set_main_option(
            "script_location", str(Path(__file__).resolve().parents[1] / "alembic")
        )
        config.set_main_option("sqlalchemy.url", "postgresql://user:pass@127.0.0.1:5432/test")
        return config

    upgrade_output = StringIO()
    command.upgrade(
        make_config(upgrade_output), "u7c8d9e0f1a2:v8d9e0f1a2b3", sql=True
    )
    sql = upgrade_output.getvalue()
    assert re.findall(r"CREATE TABLE (\w+)", sql) == ["attendance_recovery_requests"]
    assert not re.search(
        r"(?i)\b(ALTER TABLE|DROP TABLE|DROP INDEX|INSERT INTO|DELETE FROM)\b", sql
    )
    assert "v8d9e0f1a2b3" in sql and "u7c8d9e0f1a2" in sql

    downgrade_output = StringIO()
    with pytest.raises(RuntimeError, match="evidencia auditable"):
        command.downgrade(
            make_config(downgrade_output), "v8d9e0f1a2b3:u7c8d9e0f1a2", sql=True
        )
    assert not re.search(r"(?i)\b(DROP|DELETE|ALTER)\b", downgrade_output.getvalue())
