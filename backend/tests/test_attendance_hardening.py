"""Invariantes nuevas: prueba de identidad y consolidación diaria."""

from datetime import date, datetime, timezone

from app.modules.attendance.models import AttendanceRecord
from app.modules.attendance.service import AttendanceService
from app.modules.schedules.repository import WorkScheduleRepository

from tests.image_helpers import invalid_jpeg_b64, valid_jpeg_b64


def _login(client) -> None:
    assert client.post(
        "/api/v1/auth/login", json={"username": "admin", "password": "Admin123!"}
    ).status_code == 200


def _employee(client, db_session) -> str:
    response = client.post(
        "/api/v1/employees",
        json={
            "dni": "72845632",
            "employee_code": "EMP-001",
            "first_name": "Ana",
            "last_name": "López",
            "job_role_id": str(db_session._test_job_roles["Operario"]),
        },
    )
    assert response.status_code == 201
    return response.json()["id"]


def _pair_kiosk(client, name: str = "Kiosco A") -> dict:
    created = client.post("/api/v1/devices", json={"name": name})
    assert created.status_code == 201, created.text
    paired = client.post("/api/v1/attendance/terminal/pair", json={"pairing_code": created.json()["pairing_code"]})
    assert paired.status_code == 200, paired.text
    return created.json()


def test_identificacion_entrega_token_para_marcar(client, db_session):
    _login(client)
    _employee(client, db_session)
    identified = client.post("/api/v1/attendance/identify", json={"identifier": "EMP-001"})
    assert identified.status_code == 200
    token = identified.json()["marking_token"]
    assert identified.json()["marking_action"] == "CHECK_IN"

    without_photo = client.post("/api/v1/attendance/check-in", json={"marking_token": token})
    assert without_photo.status_code == 400

    evidence = client.post(
        "/api/v1/attendance/evidence",
        json={"marking_token": token, "image_base64": valid_jpeg_b64(), "content_type": "image/jpeg"},
    )
    assert evidence.status_code == 201, evidence.text
    marked = client.post("/api/v1/attendance/check-in", json={"marking_token": token})
    assert marked.status_code == 201
    replay = client.post("/api/v1/attendance/check-in", json={"marking_token": token})
    assert replay.status_code == 201
    assert replay.json()["id"] == marked.json()["id"]

    checkout_identify = client.post("/api/v1/attendance/identify", json={"identifier": "EMP-001"})
    assert checkout_identify.json()["marking_action"] == "CHECK_OUT"
    wrong = client.post("/api/v1/attendance/check-out", json={"marking_token": token})
    assert wrong.status_code == 401
    out_token = checkout_identify.json()["marking_token"]
    photo = client.post(
        "/api/v1/attendance/evidence",
        json={"marking_token": out_token, "image_base64": valid_jpeg_b64(), "content_type": "image/jpeg"},
    )
    assert photo.status_code == 201
    out = client.post("/api/v1/attendance/check-out", json={"marking_token": out_token})
    assert out.status_code == 200
    assert out.json()["status"] == "COMPLETE"
    replay_in = client.post("/api/v1/attendance/check-in", json={"marking_token": token})
    assert replay_in.status_code == 201
    assert replay_in.json()["status"] == "OPEN"
    assert replay_in.json()["event_type"] == "CHECK_IN"

    replay_out = client.post("/api/v1/attendance/check-out", json={"marking_token": out_token})
    assert replay_out.status_code == 200
    assert replay_out.json()["status"] == "COMPLETE"
    assert replay_out.json()["event_type"] == "CHECK_OUT"

    other = client.post("/api/v1/attendance/check-in", json={"employee_id": identified.json()["employee"]["id"]})
    assert other.status_code == 201
    unused_out = client.post("/api/v1/attendance/identify", json={"identifier": "EMP-001"}).json()["marking_token"]
    assert client.post("/api/v1/attendance/check-out", json={"employee_id": identified.json()["employee"]["id"]}).status_code == 200
    newer = client.post("/api/v1/attendance/check-in", json={"employee_id": identified.json()["employee"]["id"]})
    assert newer.status_code == 201
    photo_stale = client.post(
        "/api/v1/attendance/evidence",
        json={"marking_token": unused_out, "image_base64": valid_jpeg_b64(), "content_type": "image/jpeg"},
    )
    assert photo_stale.status_code == 201
    stale_out = client.post("/api/v1/attendance/check-out", json={"marking_token": unused_out})
    assert stale_out.status_code == 409


def test_refrigerio_se_descuenta_una_vez_en_jornada_partida(client, db_session):
    _login(client)
    employee_id = _employee(client, db_session)
    employee_uuid = __import__("uuid").UUID(employee_id)
    WorkScheduleRepository(db_session).create(
        employee_id=employee_uuid,
        effective_from=date(2026, 8, 1),
        monday_minutes=480,
        break_minutes=60,
        break_applies_after_minutes=360,
    )
    records = [
        AttendanceRecord(
            employee_id=employee_uuid,
            work_date=date(2026, 8, 3),
            check_in_at=datetime(2026, 8, 3, 13, 0, tzinfo=timezone.utc),
            check_out_at=datetime(2026, 8, 3, 17, 0, tzinfo=timezone.utc),
            status="COMPLETE",
            worked_minutes=240,
        ),
        AttendanceRecord(
            employee_id=employee_uuid,
            work_date=date(2026, 8, 3),
            check_in_at=datetime(2026, 8, 3, 18, 0, tzinfo=timezone.utc),
            check_out_at=datetime(2026, 8, 3, 22, 0, tzinfo=timezone.utc),
            status="COMPLETE",
            worked_minutes=240,
        ),
    ]
    db_session.add_all(records)
    db_session.commit()

    total = AttendanceService(db_session)._recompute_day(employee_uuid, date(2026, 8, 3))
    assert total == 420
    assert sum(record.worked_minutes for record in records) == 420
    daily = AttendanceService(db_session).list_daily(
        employee_id=employee_uuid, date_from=date(2026, 8, 3), date_to=date(2026, 8, 3)
    )[0]
    assert daily["session_count"] == 2
    assert daily["gross_minutes"] == 480
    assert daily["break_minutes"] == 60
    assert daily["worked_minutes"] == 420


def test_evidencia_rechaza_bytes_arbitrarios(client, db_session):
    _login(client)
    _employee(client, db_session)
    token = client.post("/api/v1/attendance/identify", json={"identifier": "EMP-001"}).json()["marking_token"]
    rejected = client.post(
        "/api/v1/attendance/evidence",
        json={"marking_token": token, "image_base64": invalid_jpeg_b64(), "content_type": "image/jpeg"},
    )
    assert rejected.status_code == 422
    tiny = client.post(
        "/api/v1/attendance/evidence",
        json={"marking_token": token, "image_base64": valid_jpeg_b64(width=10, height=10), "content_type": "image/jpeg"},
    )
    assert tiny.status_code == 422


def test_evidencia_mismo_nonce_foto_distinta_409(client, db_session):
    _login(client)
    _employee(client, db_session)
    token = client.post("/api/v1/attendance/identify", json={"identifier": "EMP-001"}).json()["marking_token"]
    first = client.post(
        "/api/v1/attendance/evidence",
        json={"marking_token": token, "image_base64": valid_jpeg_b64(color=(10, 20, 30)), "content_type": "image/jpeg"},
    )
    assert first.status_code == 201
    second = client.post(
        "/api/v1/attendance/evidence",
        json={"marking_token": token, "image_base64": valid_jpeg_b64(color=(200, 10, 10)), "content_type": "image/jpeg"},
    )
    assert second.status_code == 409
    same = client.post(
        "/api/v1/attendance/evidence",
        json={"marking_token": token, "image_base64": valid_jpeg_b64(color=(10, 20, 30)), "content_type": "image/jpeg"},
    )
    assert same.status_code == 201
    assert same.json()["id"] == first.json()["id"]


def test_terminal_emparejado_se_exige_en_produccion(client, db_session, monkeypatch):
    from app.core.config import get_settings

    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("SECRET_KEY", "una-clave-secreta-de-al-menos-32-caracteres-123456")
    get_settings.cache_clear()
    try:
        _login(client)
        _employee(client, db_session)
        denied = client.post("/api/v1/attendance/identify", json={"identifier": "EMP-001"})
        assert denied.status_code == 401
        created = client.post("/api/v1/devices", json={"name": "Tablet planta"})
        assert created.status_code == 201, created.text
        code = created.json()["pairing_code"]
        paired = client.post("/api/v1/attendance/terminal/pair", json={"pairing_code": code})
        assert paired.status_code == 200
        ok = client.post("/api/v1/attendance/identify", json={"identifier": "EMP-001"})
        assert ok.status_code == 200
        client.post(f"/api/v1/devices/{created.json()['id']}/revoke")
        revoked = client.post("/api/v1/attendance/identify", json={"identifier": "EMP-001"})
        assert revoked.status_code == 401
    finally:
        monkeypatch.setenv("ENVIRONMENT", "development")
        get_settings.cache_clear()


def test_png_se_normaliza_a_jpeg(client, db_session):
    _login(client)
    _employee(client, db_session)
    token = client.post("/api/v1/attendance/identify", json={"identifier": "EMP-001"}).json()["marking_token"]
    from tests.image_helpers import valid_png_b64

    accepted = client.post(
        "/api/v1/attendance/evidence",
        json={"marking_token": token, "image_base64": valid_png_b64(), "content_type": "image/jpeg"},
    )
    assert accepted.status_code == 201
    assert accepted.json()["content_type"] == "image/jpeg"


def test_imagen_excesiva_se_rechaza(client, db_session):
    _login(client)
    _employee(client, db_session)
    token = client.post("/api/v1/attendance/identify", json={"identifier": "EMP-001"}).json()["marking_token"]
    huge = client.post(
        "/api/v1/attendance/evidence",
        json={
            "marking_token": token,
            "image_base64": valid_jpeg_b64(width=4001, height=240),
            "content_type": "image/jpeg",
        },
    )
    assert huge.status_code == 422
    oversized = client.post(
        "/api/v1/attendance/evidence",
        json={"marking_token": token, "image_base64": "a" * 3_000_001, "content_type": "image/jpeg"},
    )
    assert oversized.status_code == 422


def test_token_de_otro_terminal_se_rechaza(client, db_session):
    from fastapi.testclient import TestClient
    from app.main import app
    from app.db.session import get_db

    _login(client)
    _employee(client, db_session)
    first = client.post("/api/v1/devices", json={"name": "Tablet A"})
    second = client.post("/api/v1/devices", json={"name": "Tablet B"})
    assert first.status_code == 201 and second.status_code == 201

    def _override():
        yield db_session

    other = TestClient(app)
    app.dependency_overrides[get_db] = _override
    try:
        assert client.post("/api/v1/attendance/terminal/pair", json={"pairing_code": first.json()["pairing_code"]}).status_code == 200
        assert other.post("/api/v1/attendance/terminal/pair", json={"pairing_code": second.json()["pairing_code"]}).status_code == 200
        token = client.post("/api/v1/attendance/identify", json={"identifier": "EMP-001"}).json()["marking_token"]
        denied = other.post(
            "/api/v1/attendance/evidence",
            json={"marking_token": token, "image_base64": valid_jpeg_b64(), "content_type": "image/jpeg"},
        )
        assert denied.status_code == 401
    finally:
        other.close()


def test_evidencia_privada_por_rol(client, db_session):
    _login(client)
    employee_id = _employee(client, db_session)
    token = client.post("/api/v1/attendance/identify", json={"identifier": "EMP-001"}).json()["marking_token"]
    client.post(
        "/api/v1/attendance/evidence",
        json={"marking_token": token, "image_base64": valid_jpeg_b64(), "content_type": "image/jpeg"},
    )
    record = client.post("/api/v1/attendance/check-in", json={"marking_token": token}).json()
    meta = client.get(f"/api/v1/attendance/{record['id']}/evidence")
    assert meta.status_code == 200
    assert meta.json()["check_in"]["available"] is True
    image_id = meta.json()["check_in"]["id"]
    image = client.get(f"/api/v1/attendance/evidence/{image_id}/image")
    assert image.status_code == 200
    assert image.headers["cache-control"] == "private, no-store"
    _login_supervisor = client.post("/api/v1/auth/login", json={"username": "supervisor", "password": "Sup123!"})
    assert _login_supervisor.status_code == 200
    assert client.get(f"/api/v1/attendance/{record['id']}/evidence").status_code == 403
    assert client.get(f"/api/v1/attendance/evidence/{image_id}/image").status_code == 403
    assert employee_id


def test_purge_no_borra_evidencia_confirmada(client, db_session):
    from sqlalchemy import select
    from datetime import datetime, timedelta, timezone

    from app.modules.attendance.models import AttendanceEvidence

    _login(client)
    _employee(client, db_session)
    token = client.post("/api/v1/attendance/identify", json={"identifier": "EMP-001"}).json()["marking_token"]
    abandoned_token = client.post("/api/v1/attendance/identify", json={"identifier": "EMP-001"}).json()["marking_token"]
    client.post(
        "/api/v1/attendance/evidence",
        json={"marking_token": abandoned_token, "image_base64": valid_jpeg_b64(color=(1, 2, 3)), "content_type": "image/jpeg"},
    )
    client.post(
        "/api/v1/attendance/evidence",
        json={"marking_token": token, "image_base64": valid_jpeg_b64(), "content_type": "image/jpeg"},
    )
    client.post("/api/v1/attendance/check-in", json={"marking_token": token})
    cutoff = datetime.now(timezone.utc) - timedelta(hours=48)
    for row in db_session.scalars(select(AttendanceEvidence)):
        row.captured_at = cutoff
        db_session.add(row)
    db_session.commit()
    purged = client.post("/api/v1/attendance/maintenance/purge-abandoned-evidence?older_than_hours=24")
    assert purged.status_code == 200
    assert purged.json()["deleted"] == 1
    remaining = list(db_session.scalars(select(AttendanceEvidence)))
    assert len(remaining) == 1
    assert remaining[0].attendance_record_id is not None


def test_reenvio_misma_foto_tras_confirmar_devuelve_evidencia(client, db_session):
    _login(client)
    _employee(client, db_session)
    photo = valid_jpeg_b64(color=(11, 22, 33))
    token = client.post("/api/v1/attendance/identify", json={"identifier": "EMP-001"}).json()["marking_token"]
    first = client.post(
        "/api/v1/attendance/evidence",
        json={"marking_token": token, "image_base64": photo, "content_type": "image/jpeg"},
    )
    assert first.status_code == 201
    marked = client.post("/api/v1/attendance/check-in", json={"marking_token": token})
    assert marked.status_code == 201
    replay = client.post(
        "/api/v1/attendance/evidence",
        json={"marking_token": token, "image_base64": photo, "content_type": "image/jpeg"},
    )
    assert replay.status_code == 201
    assert replay.json()["id"] == first.json()["id"]
    other = client.post(
        "/api/v1/attendance/evidence",
        json={"marking_token": token, "image_base64": valid_jpeg_b64(color=(200, 1, 1)), "content_type": "image/jpeg"},
    )
    assert other.status_code == 409


def test_attempt_status_devuelve_resultado_congelado(client, db_session):
    _login(client)
    _employee(client, db_session)
    device = _pair_kiosk(client)
    token = client.post("/api/v1/attendance/identify", json={"identifier": "EMP-001"}).json()["marking_token"]
    pending = client.post("/api/v1/attendance/attempt/status", json={"marking_token": token})
    assert pending.status_code == 200
    assert pending.json()["state"] == "PENDING"
    assert pending.json()["record"] is None
    client.post(
        "/api/v1/attendance/evidence",
        json={"marking_token": token, "image_base64": valid_jpeg_b64(), "content_type": "image/jpeg"},
    )
    marked = client.post("/api/v1/attendance/check-in", json={"marking_token": token})
    status = client.post("/api/v1/attendance/attempt/status", json={"marking_token": token})
    assert status.status_code == 200
    assert status.json()["state"] == "CONFIRMED"
    assert status.json()["record"]["id"] == marked.json()["id"]
    assert status.json()["record"]["event_type"] == "CHECK_IN"

    other = client.post(
        "/api/v1/employees",
        json={
            "dni": "71119999",
            "employee_code": "EMP-009",
            "first_name": "Luis",
            "last_name": "Paz",
            "job_role_id": str(db_session._test_job_roles["Operario"]),
        },
    )
    assert other.status_code == 201
    other_token = client.post("/api/v1/attendance/identify", json={"identifier": "EMP-009"}).json()["marking_token"]
    isolated = client.post("/api/v1/attendance/attempt/status", json={"marking_token": other_token})
    assert isolated.status_code == 200
    assert isolated.json()["state"] == "PENDING"
    from sqlalchemy import select
    from app.modules.attendance.models import AttendanceConsumedNonce
    import uuid as uuid_mod

    row = db_session.scalar(select(AttendanceConsumedNonce))
    assert row is not None
    assert row.device_id == uuid_mod.UUID(device["id"])


def test_attempt_status_exige_terminal_en_produccion(client, db_session, monkeypatch):
    from app.core.config import get_settings

    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("SECRET_KEY", "una-clave-secreta-de-al-menos-32-caracteres-123456")
    get_settings.cache_clear()
    try:
        denied = client.post("/api/v1/attendance/attempt/status", json={"marking_token": "x"})
        assert denied.status_code == 401
    finally:
        monkeypatch.setenv("ENVIRONMENT", "development")
        get_settings.cache_clear()


def test_doble_canje_de_codigo_emparejamiento(client, db_session):
    from fastapi.testclient import TestClient
    from app.main import app
    from app.db.session import get_db

    _login(client)
    created = client.post("/api/v1/devices", json={"name": "Tablet única"})
    code = created.json()["pairing_code"]
    first = client.post("/api/v1/attendance/terminal/pair", json={"pairing_code": code})
    assert first.status_code == 200
    cookie = first.headers.get("set-cookie", "")
    assert "Max-Age=" in cookie
    from app.core.config import get_settings

    assert str(get_settings().terminal_token_days * 24 * 60 * 60) in cookie

    other = TestClient(app)

    def _override():
        yield db_session

    app.dependency_overrides[get_db] = _override
    try:
        second = other.post("/api/v1/attendance/terminal/pair", json={"pairing_code": code})
        assert second.status_code == 401
        assert "set-cookie" not in {k.lower() for k in second.headers.keys()} or "agua_renew_terminal=" not in second.headers.get("set-cookie", "")
    finally:
        other.close()


def test_codigo_emparejamiento_vencido(client, db_session):
    from datetime import datetime, timedelta, timezone
    import uuid
    from app.modules.attendance.models import AttendanceDevice

    _login(client)
    created = client.post("/api/v1/devices", json={"name": "Tablet vencida"})
    device = db_session.get(AttendanceDevice, uuid.UUID(created.json()["id"]))
    device.pairing_expires_at = datetime.now(timezone.utc) - timedelta(minutes=1)
    db_session.add(device)
    db_session.commit()
    denied = client.post("/api/v1/attendance/terminal/pair", json={"pairing_code": created.json()["pairing_code"]})
    assert denied.status_code == 401


def test_revocacion_invalida_cookie_vigente(client, db_session, monkeypatch):
    from app.core.config import get_settings

    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("SECRET_KEY", "una-clave-secreta-de-al-menos-32-caracteres-123456")
    get_settings.cache_clear()
    try:
        _login(client)
        _employee(client, db_session)
        created = client.post("/api/v1/devices", json={"name": "Tablet revocable"})
        paired = client.post("/api/v1/attendance/terminal/pair", json={"pairing_code": created.json()["pairing_code"]})
        assert paired.status_code == 200
        ok = client.post("/api/v1/attendance/identify", json={"identifier": "EMP-001"})
        assert ok.status_code == 200
        client.post(f"/api/v1/devices/{created.json()['id']}/revoke")
        revoked = client.post("/api/v1/attendance/identify", json={"identifier": "EMP-001"})
        assert revoked.status_code == 401
    finally:
        monkeypatch.setenv("ENVIRONMENT", "development")
        get_settings.cache_clear()


def test_imagen_exif_conserva_orientacion(client, db_session):
    from io import BytesIO
    from PIL import Image
    from tests.image_helpers import jpeg_exif_orientation_6_b64

    _login(client)
    _employee(client, db_session)
    token = client.post("/api/v1/attendance/identify", json={"identifier": "EMP-001"}).json()["marking_token"]
    photo = jpeg_exif_orientation_6_b64()
    stored = client.post(
        "/api/v1/attendance/evidence",
        json={"marking_token": token, "image_base64": photo, "content_type": "image/jpeg"},
    )
    assert stored.status_code == 201
    marked = client.post("/api/v1/attendance/check-in", json={"marking_token": token})
    meta = client.get(f"/api/v1/attendance/{marked.json()['id']}/evidence")
    image_id = meta.json()["check_in"]["id"]
    image = client.get(f"/api/v1/attendance/evidence/{image_id}/image")
    assert image.status_code == 200
    decoded = Image.open(BytesIO(image.content))
    assert decoded.size[1] > decoded.size[0]


def _expire_marking_token(token: str) -> str:
    from datetime import datetime, timedelta, timezone

    import jwt
    from app.core.config import get_settings

    settings = get_settings()
    payload = jwt.decode(
        token,
        settings.secret_key,
        algorithms=[settings.jwt_algorithm],
        options={"verify_exp": False},
    )
    payload["exp"] = datetime.now(timezone.utc) - timedelta(minutes=5)
    return jwt.encode(payload, settings.secret_key, algorithm=settings.jwt_algorithm)


def test_recupera_entrada_con_token_corto_vencido(client, db_session):
    from sqlalchemy import func, select
    from app.modules.attendance.models import AttendanceRecord

    _login(client)
    _employee(client, db_session)
    _pair_kiosk(client)
    photo = valid_jpeg_b64()
    token = client.post("/api/v1/attendance/identify", json={"identifier": "EMP-001"}).json()["marking_token"]
    evidence = client.post(
        "/api/v1/attendance/evidence",
        json={"marking_token": token, "image_base64": photo, "content_type": "image/jpeg"},
    )
    assert evidence.status_code == 201
    marked = client.post("/api/v1/attendance/check-in", json={"marking_token": token})
    assert marked.status_code == 201
    expired = _expire_marking_token(token)
    recovered = client.post("/api/v1/attendance/attempt/status", json={"marking_token": expired})
    assert recovered.status_code == 200
    assert recovered.json()["state"] == "CONFIRMED"
    assert recovered.json()["record"]["id"] == marked.json()["id"]
    assert recovered.json()["record"]["check_in_at"].startswith(marked.json()["check_in_at"][:19])
    assert recovered.json()["record"]["event_type"] == "CHECK_IN"
    assert client.post("/api/v1/attendance/check-in", json={"marking_token": expired}).status_code == 401
    assert client.post("/api/v1/attendance/check-out", json={"marking_token": expired}).status_code == 401
    assert client.post(
        "/api/v1/attendance/evidence",
        json={"marking_token": expired, "image_base64": photo, "content_type": "image/jpeg"},
    ).status_code == 401
    db_session.expire_all()
    count = db_session.scalar(select(func.count()).select_from(AttendanceRecord))
    assert count == 1


def test_recupera_salida_con_token_corto_vencido(client, db_session):
    _login(client)
    _employee(client, db_session)
    _pair_kiosk(client)
    in_token = client.post("/api/v1/attendance/identify", json={"identifier": "EMP-001"}).json()["marking_token"]
    client.post(
        "/api/v1/attendance/evidence",
        json={"marking_token": in_token, "image_base64": valid_jpeg_b64(), "content_type": "image/jpeg"},
    )
    client.post("/api/v1/attendance/check-in", json={"marking_token": in_token})
    out_token = client.post("/api/v1/attendance/identify", json={"identifier": "EMP-001"}).json()["marking_token"]
    client.post(
        "/api/v1/attendance/evidence",
        json={"marking_token": out_token, "image_base64": valid_jpeg_b64(color=(9, 9, 9)), "content_type": "image/jpeg"},
    )
    marked = client.post("/api/v1/attendance/check-out", json={"marking_token": out_token})
    assert marked.status_code == 200
    expired = _expire_marking_token(out_token)
    recovered = client.post("/api/v1/attendance/attempt/status", json={"marking_token": expired})
    assert recovered.status_code == 200
    assert recovered.json()["state"] == "CONFIRMED"
    assert recovered.json()["record"]["id"] == marked.json()["id"]
    assert recovered.json()["record"]["check_out_at"].startswith(marked.json()["check_out_at"][:19])
    assert recovered.json()["record"]["event_type"] == "CHECK_OUT"
    assert client.post("/api/v1/attendance/check-out", json={"marking_token": expired}).status_code == 401


def test_attempt_status_fuera_de_plazo_410(client, db_session):
    from datetime import datetime, timedelta, timezone
    from sqlalchemy import select
    from app.modules.attendance.models import AttendanceConsumedNonce

    _login(client)
    _employee(client, db_session)
    _pair_kiosk(client)
    token = client.post("/api/v1/attendance/identify", json={"identifier": "EMP-001"}).json()["marking_token"]
    client.post(
        "/api/v1/attendance/evidence",
        json={"marking_token": token, "image_base64": valid_jpeg_b64(), "content_type": "image/jpeg"},
    )
    client.post("/api/v1/attendance/check-in", json={"marking_token": token})
    row = db_session.scalar(select(AttendanceConsumedNonce))
    assert row is not None
    row.created_at = datetime.now(timezone.utc) - timedelta(hours=2)
    db_session.add(row)
    db_session.commit()
    expired = _expire_marking_token(token)
    gone = client.post("/api/v1/attendance/attempt/status", json={"marking_token": expired})
    assert gone.status_code == 410


def test_attempt_status_otro_terminal_y_revocado(client, db_session, monkeypatch):
    from fastapi.testclient import TestClient
    from app.main import app
    from app.db.session import get_db
    from app.core.config import get_settings

    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("SECRET_KEY", "una-clave-secreta-de-al-menos-32-caracteres-123456")
    get_settings.cache_clear()
    try:
        _login(client)
        _employee(client, db_session)
        first = client.post("/api/v1/devices", json={"name": "Tablet A"})
        second = client.post("/api/v1/devices", json={"name": "Tablet B"})
        assert first.status_code == 201 and second.status_code == 201
        assert client.post("/api/v1/attendance/terminal/pair", json={"pairing_code": first.json()["pairing_code"]}).status_code == 200
        token = client.post("/api/v1/attendance/identify", json={"identifier": "EMP-001"}).json()["marking_token"]
        client.post(
            "/api/v1/attendance/evidence",
            json={"marking_token": token, "image_base64": valid_jpeg_b64(), "content_type": "image/jpeg"},
        )
        marked = client.post("/api/v1/attendance/check-in", json={"marking_token": token})
        assert marked.status_code == 201
        expired = _expire_marking_token(token)
        own = client.post("/api/v1/attendance/attempt/status", json={"marking_token": expired})
        assert own.status_code == 200
        assert own.json()["state"] == "CONFIRMED"

        other = TestClient(app)

        def _override():
            yield db_session

        app.dependency_overrides[get_db] = _override
        try:
            assert other.post("/api/v1/attendance/terminal/pair", json={"pairing_code": second.json()["pairing_code"]}).status_code == 200
            denied = other.post("/api/v1/attendance/attempt/status", json={"marking_token": expired})
            assert denied.status_code == 401
        finally:
            other.close()

        client.post(f"/api/v1/devices/{first.json()['id']}/revoke")
        revoked = client.post("/api/v1/attendance/attempt/status", json={"marking_token": expired})
        assert revoked.status_code == 401
    finally:
        monkeypatch.setenv("ENVIRONMENT", "development")
        get_settings.cache_clear()


def test_attempt_status_sin_terminal_401(client, db_session):
    _login(client)
    _employee(client, db_session)
    token = client.post("/api/v1/attendance/identify", json={"identifier": "EMP-001"}).json()["marking_token"]
    pending = client.post("/api/v1/attendance/attempt/status", json={"marking_token": token})
    assert pending.status_code == 401


def test_attempt_status_pending_exige_mismo_terminal(client, db_session):
    from fastapi.testclient import TestClient
    from app.main import app
    from app.db.session import get_db

    _login(client)
    _employee(client, db_session)
    first = _pair_kiosk(client, "Kiosco pendiente A")
    second = client.post("/api/v1/devices", json={"name": "Kiosco pendiente B"})
    assert second.status_code == 201
    token = client.post("/api/v1/attendance/identify", json={"identifier": "EMP-001"}).json()["marking_token"]
    own = client.post("/api/v1/attendance/attempt/status", json={"marking_token": token})
    assert own.status_code == 200
    assert own.json()["state"] == "PENDING"

    other = TestClient(app)

    def _override():
        yield db_session

    app.dependency_overrides[get_db] = _override
    try:
        assert other.post("/api/v1/attendance/terminal/pair", json={"pairing_code": second.json()["pairing_code"]}).status_code == 200
        denied = other.post("/api/v1/attendance/attempt/status", json={"marking_token": token})
        assert denied.status_code == 401
    finally:
        other.close()
    assert first["id"]


def test_attempt_status_pertenencia_nula_401_sin_backfill(client, db_session):
    import uuid
    from sqlalchemy import select
    from app.modules.attendance.models import AttendanceConsumedNonce

    _login(client)
    _employee(client, db_session)
    device = _pair_kiosk(client, "Kiosco nulo")
    token = client.post("/api/v1/attendance/identify", json={"identifier": "EMP-001"}).json()["marking_token"]
    client.post(
        "/api/v1/attendance/evidence",
        json={"marking_token": token, "image_base64": valid_jpeg_b64(), "content_type": "image/jpeg"},
    )
    marked = client.post("/api/v1/attendance/check-in", json={"marking_token": token})
    assert marked.status_code == 201
    row = db_session.scalar(select(AttendanceConsumedNonce))
    assert row is not None
    assert row.device_id == uuid.UUID(device["id"])
    row.device_id = None
    db_session.add(row)
    db_session.commit()
    denied = client.post("/api/v1/attendance/attempt/status", json={"marking_token": token})
    assert denied.status_code == 401
    db_session.expire_all()
    stored = db_session.scalar(select(AttendanceConsumedNonce))
    assert stored is not None
    assert stored.device_id is None
    assert stored.result_payload is not None
    assert stored.result_payload["id"] == marked.json()["id"]
