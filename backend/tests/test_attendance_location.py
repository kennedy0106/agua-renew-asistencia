"""Atomic prepared public marking (B4), through the public HTTP interface.

Original case bodies are retained. The finite-schema case is already in B3;
optional settings belong to B5 and private metadata/stamp cases to B6.
Synthetic database access is setup/tampering only, never production data.
"""

from __future__ import annotations

import sys
import types
from datetime import datetime, timedelta, timezone

import jwt
import pytest
from sqlalchemy import select

from app.core.config import get_settings
from app.core.timezone import lima_tz
from app.modules.attendance.models import (
    STORAGE_DATABASE,
    AttendanceEvidence,
    AttendanceRecord,
)
from tests.image_helpers import valid_jpeg_b64, valid_png_b64
from tests.test_attendance_hardening import _employee, _login, _nonce_of

PREPARE_PATH = "/api/v1/attendance/attempt/prepare"


def _prep_model():
    """Importa el modelo cuando ya existe; mantiene el RED como 404 conductual."""
    from app.modules.attendance.models import AttendancePreparation

    return AttendancePreparation

LOCATION = {
    "latitude": -12.046374,
    "longitude": -77.042793,
    "accuracy_m": 12.5,
    "age_ms": 1500,
}


def _identify(client, identifier: str = "EMP-001") -> str:
    response = client.post("/api/v1/attendance/identify", json={"identifier": identifier})
    assert response.status_code == 200, response.text
    return response.json()["marking_token"]


def _prepare(client, token: str, **overrides):
    location = {**LOCATION, **overrides}
    return client.post(PREPARE_PATH, json={"marking_token": token, "location": location})


def _prepare_ok(client, token: str, **overrides) -> dict:
    response = _prepare(client, token, **overrides)
    assert response.status_code == 200, response.text
    return response.json()


def _evidence(client, token: str, *, color=(10, 20, 30), image_b64: str | None = None):
    return client.post(
        "/api/v1/attendance/evidence",
        json={
            "marking_token": token,
            "image_base64": image_b64 or valid_jpeg_b64(color=color),
            "content_type": "image/jpeg",
        },
    )


def _records(client) -> list[dict]:
    response = client.get("/api/v1/attendance")
    assert response.status_code == 200, response.text
    return response.json()


def _summary(client) -> dict:
    response = client.get("/api/v1/attendance/summary")
    assert response.status_code == 200, response.text
    return response.json()


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


def _fake_evidence_media(monkeypatch, rendered: bytes):
    """Inyecta el colaborador de medios puro sin depender del otro worker."""
    module = types.ModuleType("app.modules.attendance.evidence_media")

    calls: list[dict] = []

    def render_stamp(original: bytes, **kwargs) -> bytes:
        calls.append({"original": original, **kwargs})
        return rendered

    def reverse_address(latitude, longitude, *, api_key=""):
        return None

    module.render_stamp = render_stamp
    module.reverse_address = reverse_address
    monkeypatch.setitem(sys.modules, "app.modules.attendance.evidence_media", module)
    return calls


# --- S1/S2/S6/S7/S10/S11/S12: preparación explícita con hora fija ---


def test_prepare_fija_hora_y_vencimiento_de_cinco_minutos(client, db_session):
    _login(client)
    _employee(client, db_session)
    token = _identify(client)
    before_summary = _summary(client)

    body = _prepare_ok(client, token)

    marked_at = datetime.fromisoformat(body["marked_at"])
    expires_at = datetime.fromisoformat(body["expires_at"])
    assert expires_at - marked_at == timedelta(minutes=5)
    assert body["location"]["latitude"] == LOCATION["latitude"]
    assert body["location"]["longitude"] == LOCATION["longitude"]
    assert body["location"]["accuracy_m"] == LOCATION["accuracy_m"]
    observed_at = datetime.fromisoformat(body["location"]["observed_at"])
    assert observed_at == marked_at - timedelta(milliseconds=LOCATION["age_ms"])
    assert body["location"]["address"] is None or isinstance(body["location"]["address"], str)
    assert body["marking_token"] != token

    # La preparación no crea asistencia ni mueve contadores.
    assert _records(client) == []
    assert _summary(client) == before_summary


def test_prepare_es_idempotente_por_nonce_y_no_reemplaza_el_snapshot(client, db_session):
    _login(client)
    _employee(client, db_session)
    token = _identify(client)

    first = _prepare_ok(client, token)
    second = _prepare_ok(client, token, latitude=10.0, longitude=10.0, accuracy_m=40.0, age_ms=40000)

    assert second["marked_at"] == first["marked_at"]
    assert second["expires_at"] == first["expires_at"]
    assert second["location"] == first["location"]
    assert _records(client) == []


def test_prepare_valida_rangos_finitos_antes_de_mutar(client, db_session):
    _login(client)
    _employee(client, db_session)
    token = _identify(client)
    before_summary = _summary(client)

    # Bordes aceptados.
    assert _prepare(client, token, accuracy_m=50.0, age_ms=59999).status_code == 200
    token_boundary = _identify(client)
    assert _prepare(client, token_boundary, accuracy_m=0.5, age_ms=0).status_code == 200

    rejected = [
        {"accuracy_m": 0},
        {"accuracy_m": -1.0},
        {"accuracy_m": 50.0001},
        {"age_ms": -1},
        {"age_ms": 60001},
        {"latitude": 90.0001},
        {"latitude": -90.0001},
        {"longitude": 180.0001},
        {"longitude": -180.0001},
    ]
    for case in rejected:
        fresh_token = _identify(client)
        response = _prepare(client, fresh_token, **case)
        assert response.status_code == 422, (case, response.status_code, response.text)

    assert _records(client) == []
    assert _summary(client) == before_summary
    # Solo los dos bordes aceptados persistieron preparación.
    db_session.expire_all()
    assert len(list(db_session.scalars(select(_prep_model())))) == 2




def test_prepare_exige_token_valido_y_mismo_navegador(client, db_session):
    _login(client)
    _employee(client, db_session)
    token = _identify(client)

    assert _prepare(client, "token-invalido").status_code == 401
    assert _prepare(client, _expire_marking_token(token)).status_code == 401

    from tests.test_attendance_hardening import _open_second_browser

    other = _open_second_browser(db_session)
    try:
        denied = other.post(PREPARE_PATH, json={"marking_token": token, "location": LOCATION})
        assert denied.status_code == 401
    finally:
        other.close()
    assert _records(client) == []


def test_prepare_empleado_inactivo_no_muta(client, db_session):
    _login(client)
    employee_id = _employee(client, db_session)
    token = _identify(client)
    assert client.post(f"/api/v1/employees/{employee_id}/deactivate").status_code == 200
    before_summary = _summary(client)

    assert _prepare(client, token).status_code == 403
    assert _records(client) == []
    assert _summary(client) == before_summary
    db_session.expire_all()
    assert db_session.scalar(select(_prep_model())) is None


# --- S12: evidencia y marcación exigen preparación previa ---


def test_evidencia_y_marcacion_exigen_preparacion_sin_mutar(client, db_session):
    _login(client)
    _employee(client, db_session)
    token_in = _identify(client)
    before_summary = _summary(client)

    # Sin preparación: ni foto ni marcación (entrada).
    assert _evidence(client, token_in).status_code == 409
    assert client.post("/api/v1/attendance/check-in", json={"marking_token": token_in}).status_code == 409
    assert _records(client) == []
    assert _summary(client) == before_summary

    # Con preparación el flujo firmado vuelve a funcionar.
    prepared = _prepare_ok(client, token_in)
    assert _evidence(client, token_in).status_code == 201
    marked = client.post(
        "/api/v1/attendance/check-in", json={"marking_token": prepared["marking_token"]}
    )
    assert marked.status_code == 201, marked.text
    assert marked.json()["check_in_at"].startswith(prepared["marked_at"][:19])

    # Sin preparación: la salida tampoco escribe ni cierra el registro.
    token_out = _identify(client)
    before_out = _summary(client)
    assert _evidence(client, token_out).status_code == 409
    assert client.post("/api/v1/attendance/check-out", json={"marking_token": token_out}).status_code == 409
    assert _summary(client) == before_out
    db_session.expire_all()
    stored = db_session.get(AttendanceRecord, __import__("uuid").UUID(marked.json()["id"]))
    assert stored is not None
    assert stored.check_out_at is None


# --- S3/S5/L3: la hora oficial es la preparada, no la de subida ---


def test_marcacion_usa_hora_preparada_para_registro_evento_y_jornada(client, db_session):
    _login(client)
    _employee(client, db_session)
    in_token = _identify(client)
    in_prep = _prepare_ok(client, in_token)
    assert _evidence(client, in_token).status_code == 201
    record = client.post("/api/v1/attendance/check-in", json={"marking_token": in_token}).json()

    assert record["check_in_at"].startswith(in_prep["marked_at"][:19])
    expected_day = datetime.fromisoformat(in_prep["marked_at"]).astimezone(lima_tz()).date().isoformat()
    assert record["work_date"] == expected_day

    db_session.expire_all()
    stored = db_session.get(AttendanceRecord, __import__("uuid").UUID(record["id"]))
    assert stored is not None
    assert stored.check_in_at.isoformat().startswith(in_prep["marked_at"][:19])

    out_token = _identify(client)
    out_prep = _prepare_ok(client, out_token)
    assert _evidence(client, out_token, color=(9, 9, 9)).status_code == 201
    completed = client.post("/api/v1/attendance/check-out", json={"marking_token": out_token})
    assert completed.status_code == 200, completed.text
    body = completed.json()
    assert body["check_out_at"].startswith(out_prep["marked_at"][:19])
    assert body["worked_minutes"] == int(
        (
            datetime.fromisoformat(out_prep["marked_at"]) - datetime.fromisoformat(in_prep["marked_at"])
        ).total_seconds()
        // 60
    )


def test_checkout_no_puede_preceder_a_la_entrada(client, db_session):
    _login(client)
    _employee(client, db_session)
    in_token = _identify(client)
    _prepare_ok(client, in_token)
    assert _evidence(client, in_token).status_code == 201
    record = client.post("/api/v1/attendance/check-in", json={"marking_token": in_token}).json()

    out_token = _identify(client)
    _prepare_ok(client, out_token)
    assert _evidence(client, out_token, color=(4, 4, 4)).status_code == 201

    # Tamper de setup: la hora preparada queda antes de la entrada.
    nonce = _nonce_of(out_token)
    preparation = db_session.scalar(select(_prep_model()).where(_prep_model().nonce == nonce))
    assert preparation is not None
    preparation.marked_at = datetime.fromisoformat(record["check_in_at"]) - timedelta(minutes=10)
    db_session.add(preparation)
    db_session.commit()

    conflict = client.post("/api/v1/attendance/check-out", json={"marking_token": out_token})
    assert conflict.status_code == 409
    db_session.expire_all()
    stored = db_session.get(AttendanceRecord, __import__("uuid").UUID(record["id"]))
    assert stored is not None
    assert stored.check_out_at is None
    assert len(_records(client)) == 1


def test_checkout_con_rid_obsoleto_no_escribe_en_otro_registro(client, db_session):
    _login(client)
    employee_id = _employee(client, db_session)
    in_token = _identify(client)
    _prepare_ok(client, in_token)
    assert _evidence(client, in_token).status_code == 201
    first = client.post("/api/v1/attendance/check-in", json={"marking_token": in_token}).json()

    out_token = _identify(client)
    _prepare_ok(client, out_token)
    assert _evidence(client, out_token, color=(6, 6, 6)).status_code == 201

    # El registro objetivo se cierra por la vía de compatibilidad local.
    assert client.post("/api/v1/attendance/check-out", json={"employee_id": employee_id}).status_code == 200
    second = client.post("/api/v1/attendance/check-in", json={"employee_id": employee_id})
    assert second.status_code == 201
    second_id = second.json()["id"]

    stale = client.post("/api/v1/attendance/check-out", json={"marking_token": out_token})
    assert stale.status_code == 409
    db_session.expire_all()
    stored_second = db_session.get(AttendanceRecord, __import__("uuid").UUID(second_id))
    assert stored_second is not None
    assert stored_second.check_out_at is None
    stored_first = db_session.get(AttendanceRecord, __import__("uuid").UUID(first["id"]))
    assert stored_first is not None and stored_first.check_out_at is not None


# --- Recuperación acotada del token de escritura ---


def test_status_pendiente_entrega_token_y_snapshot_sin_extender_plazo(client, db_session):
    _login(client)
    _employee(client, db_session)
    token = _identify(client)
    prepared = _prepare_ok(client, token)
    deadline = prepared["expires_at"]

    # El navegador perdió la respuesta: consulta con el token original (2 min).
    status = client.post("/api/v1/attendance/attempt/status", json={"marking_token": token})
    assert status.status_code == 200, status.text
    body = status.json()
    assert body["state"] == "PENDING"
    assert body["write_token_valid"] is True
    assert body["preparation"]["marked_at"] == prepared["marked_at"]
    assert body["preparation"]["expires_at"] == deadline
    assert body["preparation"]["location"] == prepared["location"]

    renewed = body["marking_token"]
    assert renewed
    payload = jwt.decode(
        renewed, get_settings().secret_key, algorithms=[get_settings().jwt_algorithm]
    )
    assert payload["nonce"] == _nonce_of(token)
    assert datetime.fromtimestamp(payload["exp"], tz=timezone.utc).isoformat().startswith(deadline[:19])

    # El token recuperado completa la marcación dentro del plazo fijo.
    assert _evidence(client, renewed).status_code == 201
    marked = client.post("/api/v1/attendance/check-in", json={"marking_token": renewed})
    assert marked.status_code == 201, marked.text

    # La consulta no extendió el plazo ni creó otra preparación.
    second_status = client.post("/api/v1/attendance/attempt/status", json={"marking_token": token})
    assert second_status.json()["state"] == "CONFIRMED"
    db_session.expire_all()
    preparations = list(db_session.scalars(select(_prep_model())))
    assert len(preparations) == 1
    assert preparations[0].expires_at.isoformat().startswith(deadline[:19])


def test_status_sin_preparacion_expira_sin_inventar(client, db_session):
    _login(client)
    _employee(client, db_session)
    token = _identify(client)
    expired = _expire_marking_token(token)

    assert _evidence(client, expired).status_code == 401
    status = client.post("/api/v1/attendance/attempt/status", json={"marking_token": expired})
    assert status.status_code == 200
    body = status.json()
    assert body["state"] == "EXPIRED_UNCONFIRMED"
    assert body["preparation"] is None
    assert body["marking_token"] is None
    assert client.post("/api/v1/attendance/check-in", json={"marking_token": expired}).status_code == 401


def test_preparacion_vencida_no_permite_marcar(client, db_session):
    _login(client)
    _employee(client, db_session)
    token = _identify(client)
    prepared = _prepare_ok(client, token)
    assert _evidence(client, token).status_code == 201

    nonce = _nonce_of(token)
    row = db_session.scalar(select(_prep_model()).where(_prep_model().nonce == nonce))
    assert row is not None
    row.expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
    db_session.add(row)
    db_session.commit()

    expired = _expire_marking_token(prepared["marking_token"])
    status = client.post("/api/v1/attendance/attempt/status", json={"marking_token": expired})
    assert status.status_code == 200
    assert status.json()["state"] == "EXPIRED_UNCONFIRMED"
    assert status.json()["marking_token"] is None
    assert client.post("/api/v1/attendance/check-in", json={"marking_token": expired}).status_code == 401
    assert _records(client) == []


# --- Metadatos aditivos y evidencia sellada ---
















# --- Configuración ---


def _server_error_client():
    """Cliente que devuelve 500 en vez de relanzar, para observar fallos de handler."""
    from fastapi.testclient import TestClient

    from app.main import app

    return TestClient(app, base_url="https://testserver", raise_server_exceptions=False)


def test_prepare_rechaza_json_no_finito_sin_eco(client, db_session):
    """NaN/Infinity (o 1e999) deben ser 422 local y seguro, nunca un 500."""
    _login(client)
    _employee(client, db_session)
    raw = _server_error_client()
    try:
        identified = raw.post("/api/v1/attendance/identify", json={"identifier": "EMP-001"})
        assert identified.status_code == 200, identified.text
        token = identified.json()["marking_token"]
        before_summary = _summary(client)

        bodies = [
            '{"marking_token": "%s", "location": {"latitude": NaN, "longitude": -77.0, "accuracy_m": 5.0, "age_ms": 1000}}' % token,
            '{"marking_token": "%s", "location": {"latitude": Infinity, "longitude": -77.0, "accuracy_m": 5.0, "age_ms": 1000}}' % token,
            '{"marking_token": "%s", "location": {"latitude": 1e999, "longitude": -77.0, "accuracy_m": 5.0, "age_ms": 1000}}' % token,
        ]
        for body in bodies:
            response = raw.post(
                PREPARE_PATH, content=body, headers={"content-type": "application/json"}
            )
            assert response.status_code == 422, (response.status_code, response.text)
            lowered = response.text.lower()
            assert "nan" not in lowered and "infinity" not in lowered, response.text

        assert _records(client) == []
        assert _summary(client) == before_summary
    finally:
        raw.close()


def test_prepare_exige_did_y_navegador_concretos(client, db_session):
    """N4: la preparación nueva exige did firmado y contexto de navegador real."""
    from app.core.security import create_attendance_token

    _login(client)
    employee_id = _employee(client, db_session)
    token = _identify(client)
    before_summary = _summary(client)

    # Sin cookie de contexto (browser id nulo) no se prepara.
    client.cookies.clear()
    assert _prepare(client, token).status_code == 401
    # Un token firmado sin did tampoco prepara.
    assert _prepare(client, create_attendance_token(employee_id, action="CHECK_IN")).status_code == 401

    _login(client)
    assert _records(client) == []
    assert _summary(client) == before_summary


def test_prepare_rechaza_check_in_con_entrada_abierta(client, db_session):
    """N1: no se persiste preparación si el objetivo CHECK_IN cambió de estado."""
    _login(client)
    employee_id = _employee(client, db_session)
    token = _identify(client)
    assert client.post("/api/v1/attendance/check-in", json={"employee_id": employee_id}).status_code == 201
    before_summary = _summary(client)

    denied = _prepare(client, token)
    assert denied.status_code == 409
    assert _summary(client) == before_summary
    db_session.expire_all()
    assert db_session.scalar(select(_prep_model())) is None


def test_prepare_rechaza_check_out_con_rid_cerrado(client, db_session):
    """N1: no se persiste preparación si el registro objetivo ya se cerró."""
    _login(client)
    employee_id = _employee(client, db_session)
    in_token = _identify(client)
    _prepare_ok(client, in_token)
    assert _evidence(client, in_token).status_code == 201
    assert client.post("/api/v1/attendance/check-in", json={"marking_token": in_token}).status_code == 201
    out_token = _identify(client)
    assert client.post("/api/v1/attendance/check-out", json={"employee_id": employee_id}).status_code == 200
    before_summary = _summary(client)

    denied = _prepare(client, out_token)
    assert denied.status_code == 409
    assert _summary(client) == before_summary
    from app.modules.attendance.models import AttendancePreparation

    db_session.expire_all()
    assert db_session.scalar(
        select(AttendancePreparation).where(AttendancePreparation.nonce == _nonce_of(out_token))
    ) is None


def test_preparacion_vencida_bloquea_escritura_con_token_vigente(client, db_session):
    """N2: el plazo persistido se aplica aunque el JWT siga vigente."""
    _login(client)
    _employee(client, db_session)
    token = _identify(client)
    prepared = _prepare_ok(client, token)
    renewed = prepared["marking_token"]

    row = db_session.scalar(select(_prep_model()))
    assert row is not None
    row.expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
    db_session.add(row)
    db_session.commit()

    before_summary = _summary(client)
    assert _evidence(client, renewed).status_code == 409
    assert client.post("/api/v1/attendance/check-in", json={"marking_token": renewed}).status_code == 409
    assert _records(client) == []
    assert _summary(client) == before_summary

    status = client.post("/api/v1/attendance/attempt/status", json={"marking_token": renewed})
    assert status.status_code == 200
    assert status.json()["state"] == "EXPIRED_UNCONFIRMED"
    assert status.json()["marking_token"] is None
    assert _records(client) == []




def test_entrada_preparada_anterior_no_solapa_jornada_completada(client, db_session):
    """A prepared timestamp cannot reopen an interval preceding a completed shift."""
    from fastapi.testclient import TestClient
    from app.main import app

    _login(client)
    _employee(client, db_session)
    guest = TestClient(app, base_url="https://testserver")
    try:
        older = _prepare_ok(guest, _identify(guest))
        newer = _prepare_ok(guest, _identify(guest))
        assert _evidence(guest, newer["marking_token"]).status_code == 201
        entered = guest.post("/api/v1/attendance/check-in", json={"marking_token": newer["marking_token"]})
        assert entered.status_code == 201, entered.text
        leaving = _prepare_ok(guest, _identify(guest))
        assert _evidence(guest, leaving["marking_token"]).status_code == 201
        left = guest.post("/api/v1/attendance/check-out", json={"marking_token": leaving["marking_token"]})
        assert left.status_code == 200, left.text

        photo = _evidence(guest, older["marking_token"])
        assert photo.status_code == 201, photo.text
        image_path = f"/api/v1/attendance/evidence/{photo.json()['id']}/image"
        original = client.get(image_path)
        assert original.status_code == 200
        records_before, summary_before = _records(client), _summary(client)
        rejected = guest.post("/api/v1/attendance/check-in", json={"marking_token": older["marking_token"]})
        assert rejected.status_code == 409, rejected.text
        assert rejected.json() == {"detail": "La hora preparada es anterior a una jornada ya cerrada; cancele este intento e identifique de nuevo"}
        assert _records(client) == records_before
        assert _summary(client) == summary_before
        assert client.get(image_path).content == original.content
        pending = guest.post("/api/v1/attendance/attempt/status", json={"marking_token": older["marking_token"]})
        assert pending.status_code == 200, pending.text
        assert pending.json()["state"] == "PENDING"
        assert pending.json()["record"] is None
        assert pending.json()["preparation"]["marked_at"] == older["marked_at"]
        assert pending.json()["preparation"]["expires_at"] == older["expires_at"]

        # A later, non-overlapping prepared entry still works for the same worker.
        subsequent = _prepare_ok(guest, _identify(guest))
        assert _evidence(guest, subsequent["marking_token"]).status_code == 201
        accepted = guest.post("/api/v1/attendance/check-in", json={"marking_token": subsequent["marking_token"]})
        assert accepted.status_code == 201, accepted.text
        assert len(_records(client)) == len(records_before) + 1
        assert accepted.json()["check_in_at"] != older["marked_at"]
    finally:
        guest.close()
