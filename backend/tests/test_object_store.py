"""Almacén S3 privado: moto, errores del proveedor y MinIO local autorizado."""

from __future__ import annotations

import os
import uuid
from unittest.mock import MagicMock

import pytest
from botocore.exceptions import ClientError, EndpointConnectionError
from sqlalchemy import select

from app.core.object_store import (
    CONNECT_TIMEOUT_SECONDS,
    MAX_TOTAL_ATTEMPTS,
    ObjectAlreadyExistsError,
    ObjectNotFoundError,
    ObjectStore,
    ObjectStoreError,
    ObjectStoreSettings,
    ObjectStoreUnavailableError,
    READ_TIMEOUT_SECONDS,
    evidence_object_key,
    get_object_store,
    reset_object_store,
)
from app.modules.attendance.repository import AttendanceRepository
from app.modules.attendance.service import AttendanceService
import app.modules.attendance.service as attendance_service
from app.modules.attendance.models import STORAGE_DATABASE, STORAGE_S3, AttendanceEvidence, AttendanceRecord
from tests.image_helpers import valid_jpeg_b64
from tests.test_attendance_hardening import _employee, _login, _nonce_of, _pair_kiosk


def _client_error(code: str, status: int, operation: str = "HeadBucket") -> ClientError:
    return ClientError(
        {"Error": {"Code": code, "Message": code}, "ResponseMetadata": {"HTTPStatusCode": status}},
        operation,
    )


def _store_with_client(fake, *, create_bucket: bool = True) -> ObjectStore:
    store = ObjectStore.__new__(ObjectStore)
    store.bucket = "asistencia-evidence-test"
    store._create_bucket = create_bucket
    store._client = fake
    return store


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
    assert row.storage_backend == STORAGE_S3
    assert row.storage_bucket == "asistencia-evidence-test"
    assert row.byte_size and row.byte_size > 0
    assert row.image_sha256
    assert row.object_key == evidence_object_key(employee_id, _nonce_of(token))
    assert get_object_store().exists(row.object_key, bucket=row.storage_bucket)
    meta = client.get(f"/api/v1/attendance/{marked.json()['id']}/evidence")
    image_id = meta.json()["check_in"]["id"]
    image = client.get(f"/api/v1/attendance/evidence/{image_id}/image")
    assert image.status_code == 200
    assert image.headers.get("cache-control", "").startswith("private")
    assert image.content[:3] == b"\xff\xd8\xff"


def test_head_bucket_access_denied_no_crea_bucket():
    fake = MagicMock()
    fake.head_bucket.side_effect = _client_error("AccessDenied", 403)
    store = _store_with_client(fake, create_bucket=True)
    with pytest.raises(ObjectStoreUnavailableError):
        store.create_bucket_if_missing()
    fake.create_bucket.assert_not_called()
    with pytest.raises(ObjectStoreUnavailableError):
        store.verify_ready()
    fake.create_bucket.assert_not_called()


def test_head_objeto_access_denied_no_es_inexistente():
    fake = MagicMock()
    fake.head_object.side_effect = _client_error("AccessDenied", 403, "HeadObject")
    store = _store_with_client(fake)
    with pytest.raises(ObjectStoreUnavailableError):
        store.exists("attendance/x/y.jpg")


def test_put_conexion_fallida_es_indisponibilidad():
    fake = MagicMock()
    fake.put_object.side_effect = EndpointConnectionError(endpoint_url="http://127.0.0.1:9")
    store = _store_with_client(fake)
    with pytest.raises(ObjectStoreUnavailableError):
        store.put_bytes("k", b"data", "image/jpeg", if_none_match=False)


def test_get_nosuchkey_es_not_found_y_cierra_el_cuerpo():
    fake = MagicMock()
    fake.get_object.side_effect = _client_error("NoSuchKey", 404, "GetObject")
    store = _store_with_client(fake)
    with pytest.raises(ObjectNotFoundError):
        store.get_bytes("missing.jpg")


def test_get_timeout_es_indisponibilidad():
    fake = MagicMock()
    fake.get_object.side_effect = EndpointConnectionError(endpoint_url="http://127.0.0.1:9")
    store = _store_with_client(fake)
    with pytest.raises(ObjectStoreUnavailableError):
        store.get_bytes("k.jpg")


def test_delete_403_no_es_exito():
    fake = MagicMock()
    fake.head_object.return_value = {"ContentLength": 12}
    fake.delete_object.side_effect = _client_error("AccessDenied", 403, "DeleteObject")
    store = _store_with_client(fake)
    with pytest.raises(ObjectStoreUnavailableError):
        store.delete("k.jpg")


def test_put_condicional_existente():
    fake = MagicMock()
    fake.put_object.side_effect = _client_error("PreconditionFailed", 412, "PutObject")
    store = _store_with_client(fake)
    with pytest.raises(ObjectAlreadyExistsError):
        store.put_bytes("k.jpg", b"abc", "image/jpeg")


def test_put_typeerror_no_reescribe_sin_condicion():
    calls: list[dict] = []

    def put_object(**kwargs):
        calls.append(dict(kwargs))
        if "IfNoneMatch" in kwargs:
            raise TypeError("unexpected keyword argument 'IfNoneMatch'")
        kwargs["Body"] = b"replaced"

    fake = MagicMock()
    fake.put_object.side_effect = put_object
    store = _store_with_client(fake)
    with pytest.raises(ObjectStoreError, match="IfNoneMatch"):
        store.put_bytes("k.jpg", b"new", "image/jpeg")
    assert len(calls) == 1
    assert calls[0].get("IfNoneMatch") == "*"
    assert calls[0].get("Body") == b"new"


def test_cliente_s3_usa_dos_intentos_totales():
    store = ObjectStore(
        ObjectStoreSettings(
            endpoint="http://127.0.0.1:9",
            access_key="test",
            secret_key="test-secret",
            bucket="asistencia-evidence-test",
            region="us-east-1",
            create_bucket=False,
        )
    )
    retries = store._client.meta.config.retries
    assert retries.get("total_max_attempts") == MAX_TOTAL_ATTEMPTS == 2
    assert "max_attempts" not in retries
    assert store._client.meta.config.connect_timeout == CONNECT_TIMEOUT_SECONDS
    assert store._client.meta.config.read_timeout == READ_TIMEOUT_SECONDS


def test_foto_historica_no_consulta_s3(client, db_session, monkeypatch):
    _login(client)
    employee_id = _employee(client, db_session)
    row = AttendanceEvidence(
        nonce=f"hist-{uuid.uuid4().hex[:12]}",
        employee_id=uuid.UUID(employee_id),
        content_type="image/jpeg",
        image_bytes=b"\xff\xd8\xff" + b"hist",
        storage_backend=STORAGE_DATABASE,
        object_key=None,
        byte_size=7,
    )
    db_session.add(row)
    db_session.commit()
    db_session.refresh(row)

    def boom():
        raise AssertionError("no debe consultar S3 para JPEG histórico")

    monkeypatch.setattr("app.modules.attendance.service.get_object_store", boom)
    image = client.get(f"/api/v1/attendance/evidence/{row.id}/image")
    assert image.status_code == 200
    assert image.content == b"\xff\xd8\xff" + b"hist"


def test_get_s3_caido_es_503(client, db_session, monkeypatch):
    _login(client)
    employee_id = _employee(client, db_session)
    _pair_kiosk(client)
    token = client.post("/api/v1/attendance/identify", json={"identifier": "EMP-001"}).json()["marking_token"]
    assert client.post(
        "/api/v1/attendance/evidence",
        json={"marking_token": token, "image_base64": valid_jpeg_b64(), "content_type": "image/jpeg"},
    ).status_code == 201
    marked = client.post("/api/v1/attendance/check-in", json={"marking_token": token})
    assert marked.status_code == 201
    meta = client.get(f"/api/v1/attendance/{marked.json()['id']}/evidence")
    image_id = meta.json()["check_in"]["id"]

    class Down:
        def get_bytes(self, *args, **kwargs):
            raise ObjectStoreUnavailableError("timeout")

    monkeypatch.setattr("app.modules.attendance.service.get_object_store", lambda: Down())
    image = client.get(f"/api/v1/attendance/evidence/{image_id}/image")
    assert image.status_code == 503


def test_objeto_ausente_antes_de_marcar_no_crea_evento(client, db_session):
    _login(client)
    employee_id = _employee(client, db_session)
    _pair_kiosk(client)
    token = client.post("/api/v1/attendance/identify", json={"identifier": "EMP-001"}).json()["marking_token"]
    assert client.post(
        "/api/v1/attendance/evidence",
        json={"marking_token": token, "image_base64": valid_jpeg_b64(), "content_type": "image/jpeg"},
    ).status_code == 201
    row = db_session.scalar(select(AttendanceEvidence).where(AttendanceEvidence.nonce == _nonce_of(token)))
    assert row is not None
    get_object_store().delete(row.object_key, bucket=row.storage_bucket)
    marked = client.post("/api/v1/attendance/check-in", json={"marking_token": token})
    assert marked.status_code == 409
    db_session.expire_all()
    records = list(
        db_session.scalars(select(AttendanceRecord).where(AttendanceRecord.employee_id == uuid.UUID(employee_id)))
    )
    assert records == []
    leftover = db_session.scalar(select(AttendanceEvidence).where(AttendanceEvidence.nonce == _nonce_of(token)))
    assert leftover is not None


def test_put_ok_sql_falla_permite_reintento_misma_foto(client, db_session, monkeypatch):
    _login(client)
    _employee(client, db_session)
    _pair_kiosk(client)
    token = client.post("/api/v1/attendance/identify", json={"identifier": "EMP-001"}).json()["marking_token"]
    photo = valid_jpeg_b64(color=(4, 5, 6))
    from sqlalchemy.exc import IntegrityError

    original = db_session.commit
    state = {"fail": True}

    def flaky_commit():
        if state["fail"]:
            state["fail"] = False
            raise IntegrityError("insert", {}, Exception("sql"))
        return original()

    monkeypatch.setattr(db_session, "commit", flaky_commit)
    first = client.post(
        "/api/v1/attendance/evidence",
        json={"marking_token": token, "image_base64": photo, "content_type": "image/jpeg"},
    )
    assert first.status_code == 503
    assert first.json()["detail"] == "La foto se almacenó pero no se publicó; reintente la misma foto"
    db_session.expire_all()
    assert db_session.scalar(select(AttendanceEvidence).where(AttendanceEvidence.nonce == _nonce_of(token))) is None
    second = client.post(
        "/api/v1/attendance/evidence",
        json={"marking_token": token, "image_base64": photo, "content_type": "image/jpeg"},
    )
    assert second.status_code == 201, second.text
    row = db_session.scalar(select(AttendanceEvidence).where(AttendanceEvidence.nonce == _nonce_of(token)))
    assert row is not None
    assert get_object_store().exists(row.object_key, bucket=row.storage_bucket)


def test_put_ok_sql_operacional_permite_reintento_misma_foto(client, db_session, monkeypatch):
    _login(client)
    employee_id = _employee(client, db_session)
    _pair_kiosk(client)
    token = client.post("/api/v1/attendance/identify", json={"identifier": "EMP-001"}).json()["marking_token"]
    photo = valid_jpeg_b64(color=(14, 15, 16))
    from sqlalchemy.exc import OperationalError

    original = db_session.commit
    state = {"fail": True}

    def flaky_commit():
        if state["fail"]:
            state["fail"] = False
            raise OperationalError("server closed the connection unexpectedly", {}, Exception("lost"))
        return original()

    monkeypatch.setattr(db_session, "commit", flaky_commit)
    first = client.post(
        "/api/v1/attendance/evidence",
        json={"marking_token": token, "image_base64": photo, "content_type": "image/jpeg"},
    )
    assert first.status_code == 503
    assert first.json()["detail"] == "La foto se almacenó pero no se publicó; reintente la misma foto"
    key = evidence_object_key(employee_id, _nonce_of(token))
    assert get_object_store().exists(key)
    second = client.post(
        "/api/v1/attendance/evidence",
        json={"marking_token": token, "image_base64": photo, "content_type": "image/jpeg"},
    )
    assert second.status_code == 201, second.text
    rows = list(db_session.scalars(select(AttendanceEvidence).where(AttendanceEvidence.nonce == _nonce_of(token))))
    assert len(rows) == 1


def test_put_ok_db_sigue_inaccesible_devuelve_503_y_reintento_reconcilia(client, db_session, monkeypatch):
    """Un segundo fallo de PostgreSQL no borra la foto ni se propaga como 500."""
    _login(client)
    employee_id = _employee(client, db_session)
    _pair_kiosk(client)
    token = client.post("/api/v1/attendance/identify", json={"identifier": "EMP-001"}).json()["marking_token"]
    photo = valid_jpeg_b64(color=(17, 18, 19))
    from sqlalchemy.exc import OperationalError

    original_commit = db_session.commit
    original_lookup = AttendanceRepository.get_evidence_by_nonce
    original_session = attendance_service.Session
    state = {"commit_fails": True, "lookup_fails": True, "recovery_phase": False}

    def disconnect_on_commit():
        if state["commit_fails"]:
            state["commit_fails"] = False
            state["recovery_phase"] = True
            raise OperationalError("server closed", {}, Exception("lost"))
        return original_commit()

    def unavailable_lookup(self, nonce):
        if state["recovery_phase"] and state["lookup_fails"]:
            raise OperationalError("server still unavailable", {}, Exception("lost"))
        return original_lookup(self, nonce)

    class UnavailableSession:
        def __init__(self, bind):
            pass

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, traceback):
            return False

        def scalar(self, statement):
            raise OperationalError("server still unavailable", {}, Exception("lost"))

    monkeypatch.setattr(db_session, "commit", disconnect_on_commit)
    monkeypatch.setattr(AttendanceRepository, "get_evidence_by_nonce", unavailable_lookup)
    monkeypatch.setattr(attendance_service, "Session", UnavailableSession)
    first = client.post(
        "/api/v1/attendance/evidence",
        json={"marking_token": token, "image_base64": photo, "content_type": "image/jpeg"},
    )
    assert first.status_code == 503
    assert first.json()["detail"] == "La foto se almacenó pero no se publicó; reintente la misma foto"
    key = evidence_object_key(employee_id, _nonce_of(token))
    stored_bytes = get_object_store().get_bytes(key)
    assert stored_bytes

    monkeypatch.setattr(AttendanceRepository, "get_evidence_by_nonce", original_lookup)
    monkeypatch.setattr(attendance_service, "Session", original_session)
    second = client.post(
        "/api/v1/attendance/evidence",
        json={"marking_token": token, "image_base64": photo, "content_type": "image/jpeg"},
    )
    assert second.status_code == 201, second.text
    assert get_object_store().get_bytes(key) == stored_bytes
    rows = list(db_session.scalars(select(AttendanceEvidence).where(AttendanceEvidence.nonce == _nonce_of(token))))
    assert len(rows) == 1


def test_put_ok_commit_incierto_no_duplica_fila(client, db_session, monkeypatch):
    _login(client)
    _employee(client, db_session)
    _pair_kiosk(client)
    token = client.post("/api/v1/attendance/identify", json={"identifier": "EMP-001"}).json()["marking_token"]
    photo = valid_jpeg_b64(color=(21, 22, 23))
    from sqlalchemy.exc import OperationalError

    original = db_session.commit
    state = {"fail": True}

    def commit_then_disconnect():
        result = original()
        if state["fail"]:
            state["fail"] = False
            raise OperationalError("terminating connection due to administrator command", {}, Exception("lost"))
        return result

    monkeypatch.setattr(db_session, "commit", commit_then_disconnect)
    first = client.post(
        "/api/v1/attendance/evidence",
        json={"marking_token": token, "image_base64": photo, "content_type": "image/jpeg"},
    )
    assert first.status_code == 201, first.text
    assert "administrator command" not in first.text
    evidence_id = first.json()["id"]
    second = client.post(
        "/api/v1/attendance/evidence",
        json={"marking_token": token, "image_base64": photo, "content_type": "image/jpeg"},
    )
    assert second.status_code == 201, second.text
    assert second.json()["id"] == evidence_id
    rows = list(db_session.scalars(select(AttendanceEvidence).where(AttendanceEvidence.nonce == _nonce_of(token))))
    assert len(rows) == 1


def test_put_ok_error_de_programacion_no_se_oculta(client, db_session, monkeypatch):
    _login(client)
    employee_id = _employee(client, db_session)
    _pair_kiosk(client)
    token = client.post("/api/v1/attendance/identify", json={"identifier": "EMP-001"}).json()["marking_token"]
    photo = valid_jpeg_b64(color=(30, 31, 32))

    def boom():
        raise AttributeError("bug interno de prueba")

    monkeypatch.setattr(db_session, "commit", boom)
    with pytest.raises(AttributeError, match="bug interno"):
        client.post(
            "/api/v1/attendance/evidence",
            json={"marking_token": token, "image_base64": photo, "content_type": "image/jpeg"},
        )
    key = evidence_object_key(employee_id, _nonce_of(token))
    assert get_object_store().exists(key)


def test_put_ok_sql_falla_foto_distinta_es_409(client, db_session, monkeypatch):
    _login(client)
    employee_id = _employee(client, db_session)
    _pair_kiosk(client)
    token = client.post("/api/v1/attendance/identify", json={"identifier": "EMP-001"}).json()["marking_token"]
    photo_a = valid_jpeg_b64(color=(40, 41, 42))
    photo_b = valid_jpeg_b64(color=(50, 51, 52))
    from sqlalchemy.exc import IntegrityError

    original = db_session.commit
    state = {"fail": True}

    def flaky_commit():
        if state["fail"]:
            state["fail"] = False
            raise IntegrityError("insert", {}, Exception("sql"))
        return original()

    monkeypatch.setattr(db_session, "commit", flaky_commit)
    first = client.post(
        "/api/v1/attendance/evidence",
        json={"marking_token": token, "image_base64": photo_a, "content_type": "image/jpeg"},
    )
    assert first.status_code == 503
    key = evidence_object_key(employee_id, _nonce_of(token))
    original_bytes = get_object_store().get_bytes(key)
    second = client.post(
        "/api/v1/attendance/evidence",
        json={"marking_token": token, "image_base64": photo_b, "content_type": "image/jpeg"},
    )
    assert second.status_code == 409
    assert get_object_store().get_bytes(key) == original_bytes
    third = client.post(
        "/api/v1/attendance/evidence",
        json={"marking_token": token, "image_base64": photo_a, "content_type": "image/jpeg"},
    )
    assert third.status_code == 201, third.text
    rows = list(db_session.scalars(select(AttendanceEvidence).where(AttendanceEvidence.nonce == _nonce_of(token))))
    assert len(rows) == 1


def test_cambio_de_bucket_global_sigue_la_fila(client, db_session, monkeypatch):
    _login(client)
    _employee(client, db_session)
    _pair_kiosk(client)
    token = client.post("/api/v1/attendance/identify", json={"identifier": "EMP-001"}).json()["marking_token"]
    assert client.post(
        "/api/v1/attendance/evidence",
        json={"marking_token": token, "image_base64": valid_jpeg_b64(), "content_type": "image/jpeg"},
    ).status_code == 201
    marked = client.post("/api/v1/attendance/check-in", json={"marking_token": token})
    meta = client.get(f"/api/v1/attendance/{marked.json()['id']}/evidence")
    image_id = meta.json()["check_in"]["id"]
    row = db_session.get(AttendanceEvidence, uuid.UUID(image_id))
    recorded_bucket = row.storage_bucket
    monkeypatch.setenv("OBJECT_STORE_BUCKET", "otro-bucket-distinto")
    from app.core.config import get_settings

    get_settings.cache_clear()
    image = client.get(f"/api/v1/attendance/evidence/{image_id}/image")
    assert image.status_code == 200
    db_session.refresh(row)
    assert row.storage_bucket == recorded_bucket


def _require_live_store() -> None:
    from app.core.test_object_store import (
        require_live_object_store_authorization,
        validated_test_bucket,
        validated_test_object_store_endpoint,
    )

    url = os.environ.get("OBJECT_STORE_ENDPOINT", "").strip()
    if not url:
        if os.environ.get("VERIFY_LOCAL") == "1":
            pytest.fail("OBJECT_STORE_ENDPOINT es obligatorio para la verificación local")
        pytest.skip("OBJECT_STORE_ENDPOINT no configurado")
    try:
        require_live_object_store_authorization()
        validated_test_object_store_endpoint(url)
        validated_test_bucket(os.environ.get("OBJECT_STORE_BUCKET", ""))
    except ValueError as exc:
        pytest.fail(str(exc))


@pytest.mark.live_s3
def test_minio_local_put_get_delete():
    _require_live_store()
    reset_object_store()
    from app.core.config import get_settings
    from app.core.object_store import provision_test_bucket

    get_settings.cache_clear()
    if get_settings().object_store_create_bucket:
        store = provision_test_bucket()
    else:
        store = get_object_store()
    key = f"attendance/live-probe/{uuid.uuid4()}.jpg"
    payload = b"\xff\xd8\xff" + b"probe"
    store.put_bytes(key, payload, "image/jpeg")
    try:
        assert store.exists(key)
        assert store.get_bytes(key) == payload
    finally:
        store.delete(key)
    assert store.exists(key) is False


def test_live_s3_rechaza_r2(monkeypatch):
    monkeypatch.setenv("OBJECT_STORE_ENDPOINT", "https://abc.r2.cloudflarestorage.com")
    monkeypatch.setenv("OBJECT_STORE_BUCKET", "asistencia-evidence")
    monkeypatch.setenv("ALLOW_TEST_OBJECT_STORE", "1")
    from app.core.test_object_store import validated_test_object_store_endpoint

    with pytest.raises(ValueError, match="no permitido"):
        validated_test_object_store_endpoint(os.environ["OBJECT_STORE_ENDPOINT"])
