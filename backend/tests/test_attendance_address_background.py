"""Dirección en segundo plano: fuera del bloqueo y del commit de la marcación.

Cubre el contrato nuevo:
- ``check_in``/``check_out`` no geocodifican dentro del servicio ni antes del
  commit; la geocodificación corre en ``BackgroundTasks`` tras la respuesta.
- La tarea abre su propia sesión, guarda la dirección y nunca toca la
  marcación, el evento, el nonce ni la evidencia.
- Replay idempotente no reprograma ni sobrescribe una dirección existente.
- Un fallo de geocodificación (o de la tarea) deja la respuesta igual y
  ``address`` en null.
- El sello sin dirección no se persiste; con dirección se persiste una vez.

Tráfico del proveedor: siempre simulado (nunca Geoapify real).
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import select

from app.core.config import get_settings
from app.core.object_store import get_object_store
from app.modules.attendance import evidence_media
from app.modules.attendance import service as attendance_service
from app.modules.attendance.models import AttendancePreparation, AttendanceRecord
from app.modules.attendance.service import AttendanceService, enrich_preparation_address
from tests.test_attendance_hardening import _device_id, _employee, _login, _nonce_of
from tests.test_attendance_location import (
    _evidence,
    _fake_evidence_media,
    _identify,
    _prepare_ok,
)

ADDRESS = "Referencia sintética de Lima"
API_KEY = "synthetic-b5-key-not-secret"


def _preparation(db_session, nonce: str) -> AttendancePreparation | None:
    """Lee la preparación desde cero (la tarea escribe en otra sesión)."""
    db_session.expire_all()
    return db_session.scalar(
        select(AttendancePreparation).where(AttendancePreparation.nonce == nonce)
    )


def _spy(monkeypatch, *, error: Exception | None = None):
    calls: list[tuple[float, float]] = []

    def reverse_address(latitude, longitude, *, api_key=""):
        calls.append((latitude, longitude))
        if error is not None:
            raise error
        return {"formatted": ADDRESS}

    monkeypatch.setattr(evidence_media, "reverse_address", reverse_address)
    monkeypatch.setattr(get_settings(), "geoapify_api_key", API_KEY)
    return calls


def _check_in_ready(client, db_session):
    _login(client)
    employee_id = _employee(client, db_session)
    token = _identify(client)
    prepared = _prepare_ok(client, token)
    assert _evidence(client, prepared["marking_token"]).status_code == 201
    return employee_id, token, prepared


def test_check_in_no_geocodifica_dentro_del_servicio(client, db_session, monkeypatch):
    """El servicio confirma sin llamar al proveedor; la tarea lo hace después."""
    employee_id, token, prepared = _check_in_ready(client, db_session)
    calls = _spy(monkeypatch)
    nonce = _nonce_of(token)

    record = AttendanceService(db_session).check_in(
        uuid.UUID(employee_id),
        nonce=nonce,
        device_id=uuid.UUID(_device_id(client)),
        marking_token=prepared["marking_token"],
    )

    assert isinstance(record, AttendanceRecord)
    assert record.status == "OPEN"
    assert calls == []  # nada de geocodificación dentro de check_in
    assert _preparation(db_session, nonce).address is None

    # La tarea de fondo sí enriquece, y la marcación ya estaba confirmada.
    enrich_preparation_address(nonce)
    assert len(calls) == 1
    assert _preparation(db_session, nonce).address == ADDRESS
    still_open = db_session.get(AttendanceRecord, record.id)
    assert still_open is not None and still_open.status == "OPEN"


def test_marcacion_nueva_guarda_direccion_tras_la_respuesta(
    client, db_session, monkeypatch
):
    """Con TestClient las BackgroundTasks corren al responder: la BD la tiene."""
    employee_id, token, prepared = _check_in_ready(client, db_session)
    calls = _spy(monkeypatch)

    response = client.post(
        "/api/v1/attendance/check-in", json={"marking_token": prepared["marking_token"]}
    )
    assert response.status_code == 201, response.text
    check_in_nonce = _nonce_of(prepared["marking_token"])
    assert _preparation(db_session, check_in_nonce).address == ADDRESS
    assert len(calls) == 1

    out_token = _identify(client)
    prepared_out = _prepare_ok(client, out_token)
    assert _evidence(client, prepared_out["marking_token"]).status_code == 201
    closed = client.post(
        "/api/v1/attendance/check-out", json={"marking_token": prepared_out["marking_token"]}
    )
    assert closed.status_code == 200, closed.text
    assert closed.json()["status"] == "COMPLETE"
    out_nonce = _nonce_of(prepared_out["marking_token"])
    assert _preparation(db_session, out_nonce).address == ADDRESS
    assert len(calls) == 2


def test_replay_idempotente_no_reprograma_ni_sobrescribe(client, db_session, monkeypatch):
    employee_id, token, prepared = _check_in_ready(client, db_session)
    calls = _spy(monkeypatch)

    first = client.post(
        "/api/v1/attendance/check-in", json={"marking_token": prepared["marking_token"]}
    )
    assert first.status_code == 201, first.text
    nonce = _nonce_of(prepared["marking_token"])
    assert len(calls) == 1

    # Una dirección ya guardada no se vuelve a consultar ni se pisa.
    preparation = _preparation(db_session, nonce)
    preparation.address = "Dirección previa confirmada"
    db_session.commit()

    replay = client.post(
        "/api/v1/attendance/check-in", json={"marking_token": prepared["marking_token"]}
    )
    assert replay.status_code == 201, replay.text
    assert replay.json()["id"] == first.json()["id"]
    assert len(calls) == 1
    assert _preparation(db_session, nonce).address == "Dirección previa confirmada"

    # Ni siquiera invocada de nuevo la tarea sobrescribe.
    enrich_preparation_address(nonce)
    assert len(calls) == 1
    assert _preparation(db_session, nonce).address == "Dirección previa confirmada"
    assert AttendanceService(db_session).repo.get_open(uuid.UUID(employee_id)) is not None


@pytest.mark.parametrize("failure", ["provider", "task"])
def test_fallo_de_direccion_no_cambia_la_marcacion(
    client, db_session, monkeypatch, failure
):
    employee_id, token, prepared = _check_in_ready(client, db_session)
    if failure == "provider":
        _spy(monkeypatch, error=RuntimeError("synthetic provider failure"))
    else:
        # El fallo de la propia tarea (p. ej. BD) tampoco se propaga.
        monkeypatch.setattr(
            attendance_service,
            "geocode_formatted_address",
            lambda latitude, longitude: (_ for _ in ()).throw(RuntimeError("synthetic task failure")),
        )

    response = client.post(
        "/api/v1/attendance/check-in", json={"marking_token": prepared["marking_token"]}
    )

    assert response.status_code == 201, response.text
    assert response.json()["status"] == "OPEN"
    nonce = _nonce_of(prepared["marking_token"])
    assert _preparation(db_session, nonce).address is None
    open_record = AttendanceService(db_session).repo.get_open(uuid.UUID(employee_id))
    assert open_record is not None and open_record.id is not None
    assert open_record.status == "OPEN"


class _RecordingStore:
    """Almacén real con registro de escrituras del derivado."""

    def __init__(self, inner):
        self._inner = inner
        self.writes: list[str] = []

    def __getattr__(self, name):
        return getattr(self._inner, name)

    def put_bytes(self, key, data, content_type, *, bucket=None, if_none_match=True):
        self.writes.append(key)
        return self._inner.put_bytes(
            key, data, content_type, bucket=bucket, if_none_match=if_none_match
        )


def test_sello_sin_direccion_no_se_persiste_y_con_direccion_si(
    client, db_session, monkeypatch
):
    rendered = b"\xff\xd8\xff" + b"STAMPED-BACKGROUND"
    calls = _fake_evidence_media(monkeypatch, rendered)
    store = _RecordingStore(get_object_store())
    monkeypatch.setattr(attendance_service, "get_object_store", lambda: store)

    _login(client)
    _employee(client, db_session)
    token = _identify(client)
    _prepare_ok(client, token)
    assert _evidence(client, token, color=(4, 5, 6)).status_code == 201
    record = client.post("/api/v1/attendance/check-in", json={"marking_token": token}).json()
    evidence_id = client.get(f"/api/v1/attendance/{record['id']}/evidence").json()["check_in"]["id"]
    nonce = _nonce_of(token)
    assert _preparation(db_session, nonce).address is None
    store.writes.clear()  # sólo interesan las escrituras del derivado sellado

    first = client.get(f"/api/v1/attendance/evidence/{evidence_id}/stamped-image")
    assert first.status_code == 200, first.text
    assert first.content == rendered
    assert store.writes == []  # sin dirección: se renderiza, no se persiste
    second = client.get(f"/api/v1/attendance/evidence/{evidence_id}/stamped-image")
    assert second.status_code == 200
    assert store.writes == []
    assert len(calls) == 2  # se regenera al no haber derivado guardado

    preparation = _preparation(db_session, nonce)
    preparation.address = ADDRESS
    db_session.commit()

    with_address = client.get(f"/api/v1/attendance/evidence/{evidence_id}/stamped-image")
    assert with_address.status_code == 200
    assert with_address.content == rendered
    assert len(store.writes) == 1
    assert store.writes[0].endswith(f"{nonce}.stamped-v2.jpg")
    assert calls[-1]["address"] == ADDRESS

    cached = client.get(f"/api/v1/attendance/evidence/{evidence_id}/stamped-image")
    assert cached.content == with_address.content
    assert len(store.writes) == 1
    assert len(calls) == 3  # el segundo acceso lee el derivado persistido


# --- Regresiones de la revisión (aislamiento, conexiones, orden, replays) ---


def test_sin_fixture_client_la_tarea_nunca_abre_sessionlocal(monkeypatch):
    """Hallazgo Alto: clientes propios no deben alcanzar la BD configurada."""
    import app.db.session as db_session_module

    def _forbidden(*args, **kwargs):
        raise AssertionError("una prueba abrió SessionLocal desde una tarea de fondo")

    monkeypatch.setattr(db_session_module, "SessionLocal", _forbidden)
    assert attendance_service._task_session_factory() is None
    enrich_preparation_address("nonce-sintetico")  # no lanza ni abre nada


class _CountingFactory:
    """Fábrica de sesiones de la tarea que cuenta las sesiones abiertas."""

    def __init__(self, inner):
        self._inner = inner
        self.open = 0

    def __call__(self):
        session = self._inner()
        factory = self
        factory.open += 1
        state = {"closed": False}
        original_close = session.close

        def close():
            if not state["closed"]:
                state["closed"] = True
                factory.open -= 1
            original_close()

        session.close = close
        return session


def test_geocodifica_sin_sesion_abierta_y_tras_enviar_la_respuesta(
    client, db_session, monkeypatch
):
    """Hallazgos Medio y Bajo: sin conexión retenida y después del cuerpo HTTP."""
    from sqlalchemy.orm import sessionmaker

    _employee_id, _token, prepared = _check_in_ready(client, db_session)
    counting = _CountingFactory(
        sessionmaker(bind=db_session.get_bind(), autoflush=False, autocommit=False)
    )
    monkeypatch.setattr(attendance_service, "_task_session_factory", lambda: counting)
    events: list[str] = []

    def reverse_address(latitude, longitude, *, api_key=""):
        events.append(f"geocode open_sessions={counting.open}")
        # La transacción de la petición también se cerró antes de geocodificar.
        assert not db_session.in_transaction()
        return {"formatted": ADDRESS}

    monkeypatch.setattr(evidence_media, "reverse_address", reverse_address)
    monkeypatch.setattr(get_settings(), "geoapify_api_key", API_KEY)

    inner_app = client._transport.app

    async def recording_app(scope, receive, send):
        async def recording_send(message):
            if message["type"] == "http.response.body" and not message.get("more_body"):
                events.append("body")
            await send(message)

        await inner_app(scope, receive, recording_send)

    monkeypatch.setattr(client._transport, "app", recording_app)
    response = client.post(
        "/api/v1/attendance/check-in", json={"marking_token": prepared["marking_token"]}
    )

    assert response.status_code == 201, response.text
    assert events == ["body", "geocode open_sessions=0"]
    assert counting.open == 0
    assert _preparation(db_session, _nonce_of(prepared["marking_token"])).address == ADDRESS


def test_update_condicional_no_pisa_direccion_escrita_durante_la_consulta(
    client, db_session, monkeypatch
):
    """Si otra escritura guarda una dirección mientras se geocodifica, se respeta."""
    from sqlalchemy.orm import sessionmaker

    _employee_id, _token, prepared = _check_in_ready(client, db_session)
    nonce = _nonce_of(prepared["marking_token"])
    monkeypatch.setattr(attendance_service, "_task_session_factory", lambda: None)
    body = {"marking_token": prepared["marking_token"]}
    assert client.post("/api/v1/attendance/check-in", json=body).status_code == 201

    factory = sessionmaker(bind=db_session.get_bind(), autoflush=False, autocommit=False)
    monkeypatch.setattr(attendance_service, "_task_session_factory", lambda: factory)

    def reverse_address(latitude, longitude, *, api_key=""):
        with factory() as other:
            other.execute(
                attendance_service.update(AttendancePreparation)
                .where(AttendancePreparation.nonce == nonce)
                .values(address="Escrita en paralelo")
            )
            other.commit()
        return {"formatted": ADDRESS}

    monkeypatch.setattr(evidence_media, "reverse_address", reverse_address)
    monkeypatch.setattr(get_settings(), "geoapify_api_key", API_KEY)
    enrich_preparation_address(nonce)
    assert _preparation(db_session, nonce).address == "Escrita en paralelo"


def test_replay_de_salida_no_reprograma(client, db_session, monkeypatch):
    _employee_id, _token, prepared = _check_in_ready(client, db_session)
    calls = _spy(monkeypatch)
    body_in = {"marking_token": prepared["marking_token"]}
    assert client.post("/api/v1/attendance/check-in", json=body_in).status_code == 201
    out_token = _identify(client)
    prepared_out = _prepare_ok(client, out_token)
    assert _evidence(client, prepared_out["marking_token"]).status_code == 201
    body = {"marking_token": prepared_out["marking_token"]}
    first = client.post("/api/v1/attendance/check-out", json=body)
    assert first.status_code == 200, first.text
    assert len(calls) == 2

    replay = client.post("/api/v1/attendance/check-out", json=body)
    assert replay.status_code == 200, replay.text
    assert replay.json()["id"] == first.json()["id"]
    assert len(calls) == 2  # el replay no vuelve a consultar al proveedor


def test_replay_con_direccion_nula_no_reprograma(client, db_session, monkeypatch):
    """Comportamiento aceptado: si la primera tarea no pudo, el replay no reintenta."""
    _employee_id, _token, prepared = _check_in_ready(client, db_session)
    calls = _spy(monkeypatch, error=RuntimeError("synthetic provider failure"))
    body = {"marking_token": prepared["marking_token"]}
    assert client.post("/api/v1/attendance/check-in", json=body).status_code == 201
    assert len(calls) == 1
    nonce = _nonce_of(prepared["marking_token"])
    assert _preparation(db_session, nonce).address is None

    replay = client.post("/api/v1/attendance/check-in", json=body)
    assert replay.status_code == 201, replay.text
    assert len(calls) == 1
    assert _preparation(db_session, nonce).address is None
