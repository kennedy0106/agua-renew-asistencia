"""Private evidence metadata and derivative HTTP contracts from the frozen donor."""
from __future__ import annotations

import sys
import types

from sqlalchemy import select

from app.modules.attendance.models import STORAGE_DATABASE, AttendanceEvidence, AttendanceRecord
from tests.test_attendance_hardening import _employee, _login
from tests.test_attendance_location import (
    LOCATION,
    _evidence,
    _fake_evidence_media,
    _identify,
    _prepare_ok,
    _records,
)


def test_evidence_metadata_agrega_ubicacion_sin_romper_claves_previas(client, db_session):
    _login(client)
    _employee(client, db_session)
    token = _identify(client)
    prepared = _prepare_ok(client, token)
    assert _evidence(client, token).status_code == 201
    record = client.post("/api/v1/attendance/check-in", json={"marking_token": token}).json()

    meta = client.get(f"/api/v1/attendance/{record['id']}/evidence")
    assert meta.status_code == 200
    check_in = meta.json()["check_in"]
    # Claves previas intactas.
    assert {"id", "captured_at", "content_type", "available"} <= set(check_in)
    assert check_in["available"] is True
    # Metadatos aditivos de la preparación.
    assert check_in["marked_at"].startswith(prepared["marked_at"][:19])
    assert check_in["location"]["latitude"] == LOCATION["latitude"]
    assert check_in["location"]["longitude"] == LOCATION["longitude"]
    assert check_in["location"]["accuracy_m"] == LOCATION["accuracy_m"]
    assert check_in["location"]["observed_at"].startswith(prepared["location"]["observed_at"][:19])
    assert check_in["stamped_available"] is True


def test_evidencia_historica_no_fabrica_ubicacion_ni_sello(client, db_session):
    _login(client)
    employee_id = _employee(client, db_session)
    record = client.post("/api/v1/attendance/check-in", json={"employee_id": employee_id}).json()
    row = AttendanceEvidence(
        nonce="legacy-location-0001",
        employee_id=__import__("uuid").UUID(employee_id),
        attendance_record_id=__import__("uuid").UUID(record["id"]),
        content_type="image/jpeg",
        image_bytes=b"\xff\xd8\xff" + b"legacy",
        storage_backend=STORAGE_DATABASE,
        object_key=None,
        byte_size=8,
    )
    db_session.add(row)
    db_session.commit()
    db_session.refresh(row)

    meta = client.get(f"/api/v1/attendance/{record['id']}/evidence")
    assert meta.status_code == 200
    check_in = meta.json()["check_in"]
    assert check_in["marked_at"] is None
    assert check_in["location"] is None
    assert check_in["stamped_available"] is False

    original = client.get(f"/api/v1/attendance/evidence/{row.id}/image")
    assert original.status_code == 200
    assert original.content == b"\xff\xd8\xff" + b"legacy"
    assert client.get(f"/api/v1/attendance/evidence/{row.id}/stamped-image").status_code == 409


def test_stamped_image_deriva_del_original_y_conserva_hash_y_clave(client, db_session, monkeypatch):
    rendered = b"\xff\xd8\xff" + b"STAMPED-FAKE"
    calls = _fake_evidence_media(monkeypatch, rendered)
    _login(client)
    _employee(client, db_session)
    token = _identify(client)
    prepared = _prepare_ok(client, token)
    assert _evidence(client, token, color=(3, 4, 5)).status_code == 201
    record = client.post("/api/v1/attendance/check-in", json={"marking_token": token}).json()

    meta = client.get(f"/api/v1/attendance/{record['id']}/evidence").json()
    evidence_id = meta["check_in"]["id"]
    db_session.expire_all()
    row = db_session.get(AttendanceEvidence, __import__("uuid").UUID(evidence_id))
    original_key, original_hash = row.object_key, row.image_sha256
    original_bytes = client.get(f"/api/v1/attendance/evidence/{evidence_id}/image").content

    stored = client.get(f"/api/v1/attendance/evidence/{evidence_id}/stamped-image")
    assert stored.status_code == 200, stored.text
    assert stored.headers["content-type"].startswith("image/jpeg")
    assert stored.content == rendered
    assert calls and calls[0]["original"] == original_bytes
    assert calls[0]["employee_name"] == "Ana López"
    assert calls[0]["employee_code"] == "EMP-001"
    assert calls[0]["event_type"] == "CHECK_IN"
    assert calls[0]["marked_at"].isoformat().startswith(prepared["marked_at"][:19])
    assert calls[0]["latitude"] == LOCATION["latitude"]
    assert calls[0]["evidence_id"] == evidence_id

    # El original no se reemplaza: bytes, hash y clave intactos.
    again = client.get(f"/api/v1/attendance/evidence/{evidence_id}/image")
    assert again.content == original_bytes
    db_session.expire_all()
    refreshed = db_session.get(AttendanceEvidence, __import__("uuid").UUID(evidence_id))
    assert refreshed.object_key == original_key
    assert refreshed.image_sha256 == original_hash
    assert len(list(db_session.scalars(select(AttendanceEvidence)))) == 1


def test_stamped_image_respeta_roles_y_exige_confirmacion(client, db_session, monkeypatch):
    _fake_evidence_media(monkeypatch, b"\xff\xd8\xff" + b"STAMPED")
    _login(client)
    _employee(client, db_session)
    token = _identify(client)
    _prepare_ok(client, token)
    assert _evidence(client, token, color=(7, 8, 9)).status_code == 201
    record = client.post("/api/v1/attendance/check-in", json={"marking_token": token}).json()
    evidence_id = client.get(f"/api/v1/attendance/{record['id']}/evidence").json()["check_in"]["id"]

    # Confirmado y preparado: disponible para ADMIN; no para SUPERVISOR.
    assert client.get(f"/api/v1/attendance/evidence/{evidence_id}/stamped-image").status_code == 200
    assert client.post("/api/v1/auth/login", json={"username": "supervisor", "password": "Sup123!"}).status_code == 200
    assert client.get(f"/api/v1/attendance/evidence/{evidence_id}/stamped-image").status_code == 403
    assert client.get(f"/api/v1/attendance/{record['id']}/evidence").status_code == 403


def test_stamped_image_falla_no_anula_evento(client, db_session, monkeypatch):
    """Un fallo del derivado no revierte ni duplica la confirmación."""
    module = types.ModuleType("app.modules.attendance.evidence_media")

    def render_stamp(original: bytes, **kwargs) -> bytes:
        raise RuntimeError("renderer no disponible")

    module.render_stamp = render_stamp
    module.reverse_address = lambda *args, **kwargs: None
    module.STAMP_VERSION = "v2"
    monkeypatch.setitem(sys.modules, "app.modules.attendance.evidence_media", module)

    _login(client)
    _employee(client, db_session)
    token = _identify(client)
    _prepare_ok(client, token)
    assert _evidence(client, token).status_code == 201
    record = client.post("/api/v1/attendance/check-in", json={"marking_token": token}).json()
    evidence_id = client.get(f"/api/v1/attendance/{record['id']}/evidence").json()["check_in"]["id"]

    original = client.get(f"/api/v1/attendance/evidence/{evidence_id}/image").content
    failed = client.get(f"/api/v1/attendance/evidence/{evidence_id}/stamped-image")
    assert failed.status_code == 503
    # Nunca devuelve el original como si estuviera sellado.
    assert failed.content != original

    db_session.expire_all()
    stored = db_session.get(AttendanceRecord, __import__("uuid").UUID(record["id"]))
    assert stored is not None
    assert stored.status == "OPEN"
    assert len(_records(client)) == 1


def test_stamped_image_con_renderer_real_produce_jpeg_distinto(client, db_session):
    """Integración de la ruta con el colaborador de medios puro entregado."""
    _login(client)
    _employee(client, db_session)
    token = _identify(client)
    _prepare_ok(client, token)
    assert _evidence(client, token, color=(33, 66, 99)).status_code == 201
    record = client.post("/api/v1/attendance/check-in", json={"marking_token": token}).json()
    evidence_id = client.get(f"/api/v1/attendance/{record['id']}/evidence").json()["check_in"]["id"]

    original = client.get(f"/api/v1/attendance/evidence/{evidence_id}/image").content
    stamped = client.get(f"/api/v1/attendance/evidence/{evidence_id}/stamped-image")
    assert stamped.status_code == 200, stamped.text
    assert stamped.content[:3] == b"\xff\xd8\xff"
    assert stamped.content != original
    cached = client.get(f"/api/v1/attendance/evidence/{evidence_id}/stamped-image")
    assert cached.content == stamped.content


def test_raw_original_no_cambia_tras_sello(client, db_session, monkeypatch):
    """La ruta original sigue sirviendo los mismos bytes que antes del sello."""
    _fake_evidence_media(monkeypatch, b"\xff\xd8\xff" + b"STAMPED-2")
    _login(client)
    _employee(client, db_session)
    token = _identify(client)
    _prepare_ok(client, token)
    assert _evidence(client, token, color=(200, 100, 50)).status_code == 201
    record = client.post("/api/v1/attendance/check-in", json={"marking_token": token}).json()
    evidence_id = client.get(f"/api/v1/attendance/{record['id']}/evidence").json()["check_in"]["id"]

    before = client.get(f"/api/v1/attendance/evidence/{evidence_id}/image")
    assert before.status_code == 200
    assert before.content[:3] == b"\xff\xd8\xff"
    assert client.get(f"/api/v1/attendance/evidence/{evidence_id}/stamped-image").status_code == 200
    after = client.get(f"/api/v1/attendance/evidence/{evidence_id}/image")
    assert after.content == before.content


def test_stamped_image_usa_bucket_original_y_no_escribe_en_default(client, db_session, monkeypatch):
    """A3: el derivado se lee/escribe en el bucket de la fila, no en el default."""
    rendered = b"\xff\xd8\xff" + b"STAMPED-BUCKET"
    calls = _fake_evidence_media(monkeypatch, rendered)
    _login(client)
    _employee(client, db_session)
    token = _identify(client)
    _prepare_ok(client, token)
    assert _evidence(client, token, color=(1, 2, 3)).status_code == 201
    record = client.post("/api/v1/attendance/check-in", json={"marking_token": token}).json()
    evidence_id = client.get(f"/api/v1/attendance/{record['id']}/evidence").json()["check_in"]["id"]

    db_session.expire_all()
    evidence = db_session.get(AttendanceEvidence, __import__("uuid").UUID(evidence_id))
    original_key = evidence.object_key
    original_bucket = evidence.storage_bucket
    assert original_key and original_bucket

    from app.core.config import get_settings
    from app.core.object_store import get_object_store, provision_test_bucket, reset_object_store

    # Un default distinto del bucket histórico de la fila.
    monkeypatch.setenv("OBJECT_STORE_BUCKET", "bucket-sello-nuevo")
    get_settings.cache_clear()
    reset_object_store()
    store = provision_test_bucket()
    assert store.bucket != original_bucket

    stamped_key = original_key.rsplit(".jpg", 1)[0] + ".stamped-v2.jpg"
    first = client.get(f"/api/v1/attendance/evidence/{evidence_id}/stamped-image")
    assert first.status_code == 200, first.text
    assert first.content == rendered
    assert len(calls) == 1
    assert store.exists(stamped_key, bucket=original_bucket) is True
    assert store.exists(stamped_key, bucket=store.bucket) is False

    second = client.get(f"/api/v1/attendance/evidence/{evidence_id}/stamped-image")
    assert second.content == first.content
    assert len(calls) == 1  # no regenera ni escribe de nuevo

    original = client.get(f"/api/v1/attendance/evidence/{evidence_id}/image")
    assert original.status_code == 200
    assert original.content[:3] == b"\xff\xd8\xff"
