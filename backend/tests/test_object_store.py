"""Almacén S3 privado de evidencias: moto in-process y MinIO local."""

import os

import pytest
from sqlalchemy import select

from app.core.object_store import evidence_object_key, get_object_store, reset_object_store
from app.modules.attendance.models import AttendanceEvidence
from tests.image_helpers import valid_jpeg_b64
from tests.test_attendance_hardening import _employee, _login, _nonce_of, _pair_kiosk


def test_evidencia_queda_en_almacen_y_no_en_postgres(client, db_session):
    _login(client)
    employee_id = _employee(client, db_session)
    _pair_kiosk(client)
    token = client.post("/api/v1/attendance/identify", json={"identifier": "EMP-001"}).json()["marking_token"]
    stored = client.post(
        "/api/v1/attendance/evidence",
        json={"marking_token": token, "image_base64": valid_jpeg_b64(color=(9, 8, 7)), "content_type": "image/jpeg"},
    )
    assert stored.status_code == 201, stored.text
    marked = client.post("/api/v1/attendance/check-in", json={"marking_token": token})
    assert marked.status_code == 201
    db_session.expire_all()
    row = db_session.scalar(select(AttendanceEvidence).where(AttendanceEvidence.nonce == _nonce_of(token)))
    assert row is not None
    assert row.image_bytes is None
    assert row.object_key == evidence_object_key(employee_id, _nonce_of(token))
    assert get_object_store().exists(row.object_key)
    meta = client.get(f"/api/v1/attendance/{marked.json()['id']}/evidence")
    image_id = meta.json()["check_in"]["id"]
    image = client.get(f"/api/v1/attendance/evidence/{image_id}/image")
    assert image.status_code == 200
    assert image.headers.get("cache-control", "").startswith("private")
    assert image.content[:3] == b"\xff\xd8\xff"


def _require_live_store() -> str:
    url = os.environ.get("OBJECT_STORE_ENDPOINT", "").strip()
    if url:
        return url
    if os.environ.get("VERIFY_LOCAL") == "1":
        pytest.fail("OBJECT_STORE_ENDPOINT es obligatorio para la verificación local")
    pytest.skip("OBJECT_STORE_ENDPOINT no configurado")


@pytest.mark.live_s3
def test_minio_local_put_get_delete():
    _require_live_store()
    reset_object_store()
    from app.core.config import get_settings

    get_settings.cache_clear()
    store = get_object_store()
    key = "attendance/live-probe/probe.jpg"
    payload = b"\xff\xd8\xff" + b"probe"
    store.put_bytes(key, payload, "image/jpeg")
    assert store.exists(key)
    assert store.get_bytes(key) == payload
    store.delete(key)
    assert store.exists(key) is False
