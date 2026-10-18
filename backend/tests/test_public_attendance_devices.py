"""Flujo público de asistencia desde cualquier dispositivo (S1-S3).

Sin login ni aprobación previa de equipo: la primera identificación válida
establece un contexto de navegador (cookie firmada) que se reutiliza mientras
siga vigente. El pairing manual quedó retirado (HTTP 410).

Reglas de prueba (refuerzo test-only):
- El cliente ADMIN solo prepara datos y observa estado por HTTP
  (``GET /api/v1/devices``, ``GET /api/v1/attendance``, ``/summary``).
- Cada navegador público es un ``TestClient`` HTTPS anónimo y separado. Nunca
  inicia sesión y jamás hereda cookies ni cabeceras del administrador.
- Las aserciones usan solo HTTP público/administrativo: no se inspeccionan el
  ORM de dispositivos ni helpers criptográficos privados.
- ``db_session`` solo se usa para inyectar la dependencia de BD de prueba.

Cambio de formato respecto de la versión previa: se eliminaron las lecturas
directas a la base (``select(AttendanceDevice)``), el helper privado
``decode_terminal_token`` y el bootstrap implícito del admin como navegador
público; en su lugar, clientes HTTPS aislados y observación vía endpoints.
"""

import contextlib
import uuid

import pytest
from fastapi.testclient import TestClient

from app.db.session import get_db
from app.main import app
from tests.image_helpers import valid_jpeg_b64

HTTPS_BASE_URL = "https://testserver"


@contextlib.contextmanager
def production_env(monkeypatch):
    from app.core.config import get_settings

    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("SECRET_KEY", "una-clave-secreta-de-al-menos-32-caracteres-123456")
    monkeypatch.setenv("SESSION_COOKIE_SECURE", "true")
    monkeypatch.setenv("SESSION_COOKIE_SAMESITE", "none")
    get_settings.cache_clear()
    try:
        yield
    finally:
        monkeypatch.setenv("ENVIRONMENT", "development")
        get_settings.cache_clear()


@pytest.fixture(autouse=True)
def _clear_db_override():
    yield
    app.dependency_overrides.pop(get_db, None)


def _client(db_session) -> TestClient:
    """TestClient HTTPS aislado (jar propio) sobre la BD de prueba inyectada."""

    def _override():
        yield db_session

    app.dependency_overrides[get_db] = _override
    return TestClient(app, base_url=HTTPS_BASE_URL)


def _admin(db_session) -> TestClient:
    admin = _client(db_session)
    login = admin.post("/api/v1/auth/login", json={"username": "admin", "password": "Admin123!"})
    assert login.status_code == 200, login.text
    return admin


def _guest(db_session) -> TestClient:
    """Navegador anónimo: nunca inicia sesión ni comparte cookies del admin."""
    return _client(db_session)


def _create_employee(
    admin, db_session, *, employee_code: str = "EMP-001", dni: str = "72845632", active: bool = True
) -> str:
    response = admin.post(
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
    employee_id = response.json()["id"]
    if not active:
        assert admin.post(f"/api/v1/employees/{employee_id}/deactivate").status_code == 200
    return employee_id


def _identify(guest, identifier: str = "EMP-001"):
    return guest.post("/api/v1/attendance/identify", json={"identifier": identifier})


def _evidence(guest, token: str, color: tuple[int, int, int] = (10, 20, 30)):
    return guest.post(
        "/api/v1/attendance/evidence",
        json={
            "marking_token": token,
            "image_base64": valid_jpeg_b64(color=color),
            "content_type": "image/jpeg",
        },
    )


def _prepare(guest, token: str) -> dict:
    """Preparación explícita de ubicación previa a la foto (S1/S10/S11)."""
    response = guest.post(
        "/api/v1/attendance/attempt/prepare",
        json={
            "marking_token": token,
            "location": {
                "latitude": -12.046374,
                "longitude": -77.042793,
                "accuracy_m": 12.5,
                "age_ms": 1500,
            },
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


def _terminal_cookie(client) -> str | None:
    return client.cookies.get("agua_renew_terminal")


def _set_cookie_header(response) -> str:
    return response.headers.get("set-cookie", "")


def _device_history(admin) -> list[dict]:
    response = admin.get("/api/v1/devices")
    assert response.status_code == 200, response.text
    return response.json()


def _attendance_ids(admin) -> set[str]:
    response = admin.get("/api/v1/attendance")
    assert response.status_code == 200, response.text
    return {item["id"] for item in response.json()}


def _summary(admin) -> dict:
    response = admin.get("/api/v1/attendance/summary")
    assert response.status_code == 200, response.text
    return response.json()


def _assert_private_devices_denied(client) -> None:
    response = client.get("/api/v1/devices")
    assert response.status_code in {401, 403}, response.text


def _web_devices(admin) -> list[dict]:
    return [device for device in _device_history(admin) if device["device_code"].startswith("WEB-")]


def _assert_cookie_flags(response) -> None:
    header = _set_cookie_header(response)
    lowered = header.lower()
    assert "agua_renew_terminal=" in header
    assert "httponly" in lowered
    assert "secure" in lowered
    assert "samesite=none" in lowered


def test_flujo_publico_completo_sin_login_ni_aprobacion_previa(db_session, monkeypatch):
    """S1: navegador anónimo completa entrada y salida sin login ni pairing."""
    with production_env(monkeypatch):
        admin = _admin(db_session)
        _create_employee(admin, db_session)
        guest = _guest(db_session)

        # GET /devices es privado antes de que el anónimo tenga contexto.
        _assert_private_devices_denied(guest)
        before_devices = len(_device_history(admin))

        identified = _identify(guest)
        assert identified.status_code == 200, identified.text
        assert identified.json()["marking_action"] == "CHECK_IN"
        _assert_cookie_flags(identified)
        cookie_in = _terminal_cookie(guest)
        assert cookie_in

        # Y sigue privado aun después de obtener la cookie de contexto.
        _assert_private_devices_denied(guest)

        assert len(_device_history(admin)) == before_devices + 1
        assert len(_web_devices(admin)) == 1
        assert _web_devices(admin)[0]["active"] is True

        in_token = identified.json()["marking_token"]
        assert _evidence(guest, in_token).status_code == 201
        check_in = guest.post("/api/v1/attendance/check-in", json={"marking_token": in_token})
        assert check_in.status_code == 201, check_in.text
        assert check_in.json()["status"] == "OPEN"

        status = guest.post("/api/v1/attendance/attempt/status", json={"marking_token": in_token})
        assert status.status_code == 200
        assert status.json()["state"] == "CONFIRMED"

        replay = guest.post("/api/v1/attendance/check-in", json={"marking_token": in_token})
        assert replay.status_code == 201
        assert replay.json()["id"] == check_in.json()["id"]
        assert len(_attendance_ids(admin)) == 1  # sin duplicados

        out_identified = _identify(guest)
        assert out_identified.status_code == 200
        assert out_identified.json()["marking_action"] == "CHECK_OUT"
        # El mismo navegador reutiliza su contexto: no se reemite cookie.
        assert _terminal_cookie(guest) == cookie_in
        assert len(_web_devices(admin)) == 1

        out_token = out_identified.json()["marking_token"]
        assert _evidence(guest, out_token, color=(9, 9, 9)).status_code == 201
        check_out = guest.post("/api/v1/attendance/check-out", json={"marking_token": out_token})
        assert check_out.status_code == 200, check_out.text
        assert check_out.json()["status"] == "COMPLETE"
        assert check_out.json()["id"] == check_in.json()["id"]

        out_status = guest.post("/api/v1/attendance/attempt/status", json={"marking_token": out_token})
        assert out_status.status_code == 200
        assert out_status.json()["state"] == "CONFIRMED"


def test_mismo_navegador_reutiliza_contexto_sin_crear_dispositivo(db_session, monkeypatch):
    """S1: dos identificaciones del mismo navegador comparten contexto."""
    with production_env(monkeypatch):
        admin = _admin(db_session)
        _create_employee(admin, db_session)
        guest = _guest(db_session)

        first = _identify(guest)
        assert first.status_code == 200, first.text
        cookie = _terminal_cookie(guest)
        count_after_first = len(_device_history(admin))

        second = _identify(guest)
        assert second.status_code == 200
        assert _terminal_cookie(guest) == cookie
        assert len(_device_history(admin)) == count_after_first


def test_navegadores_independientes_reciben_contextos_aislados(db_session, monkeypatch):
    """S1: un segundo navegador obtiene su propio contexto y no usa el token ajeno."""
    with production_env(monkeypatch):
        admin = _admin(db_session)
        _create_employee(admin, db_session)
        guest_a = _guest(db_session)
        guest_b = _guest(db_session)

        identified_a = _identify(guest_a)
        assert identified_a.status_code == 200, identified_a.text
        token_a = identified_a.json()["marking_token"]
        cookie_a = _terminal_cookie(guest_a)

        identified_b = _identify(guest_b)
        assert identified_b.status_code == 200
        cookie_b = _terminal_cookie(guest_b)
        assert cookie_a and cookie_b and cookie_a != cookie_b
        assert len(_web_devices(admin)) == 2

        denied = _evidence(guest_b, token_a)
        assert denied.status_code == 401


def test_identificacion_invalida_no_persiste_ni_muta_registros(db_session, monkeypatch):
    """S1/S2: identificador inexistente no crea dispositivo ni registros."""
    with production_env(monkeypatch):
        admin = _admin(db_session)
        _create_employee(admin, db_session)
        guest = _guest(db_session)
        before_devices = len(_device_history(admin))
        before_records = _attendance_ids(admin)
        before_summary = _summary(admin)

        missing = _identify(guest, "NO-EXISTE")
        assert missing.status_code == 404
        _assert_private_devices_denied(guest)
        assert _terminal_cookie(guest) is None
        assert len(_device_history(admin)) == before_devices
        assert _attendance_ids(admin) == before_records
        assert _summary(admin) == before_summary


def test_identificacion_empleado_inactivo_no_muta_estado(db_session, monkeypatch):
    """S1/S2: trabajador inactivo no crea dispositivo ni registros."""
    with production_env(monkeypatch):
        admin = _admin(db_session)
        _create_employee(admin, db_session, active=False)
        guest = _guest(db_session)
        before_devices = len(_device_history(admin))
        before_records = _attendance_ids(admin)
        before_summary = _summary(admin)

        denied = _identify(guest)
        assert denied.status_code == 403
        assert _terminal_cookie(guest) is None
        assert len(_device_history(admin)) == before_devices
        assert _attendance_ids(admin) == before_records
        assert _summary(admin) == before_summary


def test_cookie_manipulada_no_renueva_y_habilita_contexto_nuevo(db_session, monkeypatch):
    """S1: una cookie manipulada no renueva; una identificación fresca crea otro contexto."""
    with production_env(monkeypatch):
        admin = _admin(db_session)
        _create_employee(admin, db_session)
        guest = _guest(db_session)

        identified = _identify(guest)
        assert identified.status_code == 200, identified.text
        token = identified.json()["marking_token"]
        original = _terminal_cookie(guest)
        assert original

        stored = next(c for c in guest.cookies.jar if c.name == "agua_renew_terminal")
        guest.cookies.set("agua_renew_terminal", "cookie-manipulada", domain=stored.domain, path=stored.path)
        assert _terminal_cookie(guest) == "cookie-manipulada"

        denied = guest.post("/api/v1/attendance/attempt/status", json={"marking_token": token})
        assert denied.status_code == 401

        fresh = _identify(guest)
        assert fresh.status_code == 200, fresh.text
        new_cookie = _terminal_cookie(guest)
        assert new_cookie and new_cookie not in {"cookie-manipulada", original}
        stale = guest.post("/api/v1/attendance/attempt/status", json={"marking_token": token})
        assert stale.status_code == 401


def test_revocacion_invalida_contexto_y_permite_identidad_nueva(db_session, monkeypatch):
    """S1: revocar invalida el contexto; una identificación fresca crea otro contexto."""
    with production_env(monkeypatch):
        admin = _admin(db_session)
        _create_employee(admin, db_session)
        guest = _guest(db_session)

        identified = _identify(guest)
        assert identified.status_code == 200, identified.text
        token = identified.json()["marking_token"]
        original = _terminal_cookie(guest)

        web_devices = _web_devices(admin)
        assert len(web_devices) == 1
        revoke = admin.post(f"/api/v1/devices/{web_devices[0]['id']}/revoke")
        assert revoke.status_code == 200, revoke.text

        revoked = guest.post("/api/v1/attendance/attempt/status", json={"marking_token": token})
        assert revoked.status_code == 401

        fresh = _identify(guest)
        assert fresh.status_code == 200, fresh.text
        new_cookie = _terminal_cookie(guest)
        assert new_cookie and new_cookie != original
        # El contexto revocado no se reactiva ni transfiere el intento previo.
        assert guest.post("/api/v1/attendance/attempt/status", json={"marking_token": token}).status_code == 401
        assert len(_web_devices(admin)) == 2


def test_pairing_retirado_sin_mutaciones_y_admin_autenticado(db_session):
    """S3: rutas de pairing retiradas (410) sin mutar; el admin sigue autenticado."""
    admin = _admin(db_session)
    _create_employee(admin, db_session)
    guest = _guest(db_session)

    _assert_private_devices_denied(guest)
    before_devices = len(_device_history(admin))
    before_records = _attendance_ids(admin)

    assert guest.post("/api/v1/attendance/terminal/pair", json={"pairing_code": "cualquiera"}).status_code == 410
    assert admin.post("/api/v1/devices", json={"name": "Tablet manual"}).status_code == 410
    assert admin.post(f"/api/v1/devices/{uuid.uuid4()}/pairing-code").status_code == 410

    assert len(_device_history(admin)) == before_devices
    assert _attendance_ids(admin) == before_records

    # El administrador conserva autenticación y listado; el anónimo no.
    assert admin.get("/api/v1/devices").status_code == 200
    assert guest.post("/api/v1/devices", json={"name": "Sin sesión"}).status_code in {401, 403}
    _assert_private_devices_denied(guest)

    identified = _identify(guest)
    assert identified.status_code == 200
    _assert_private_devices_denied(guest)


def test_identificacion_publica_rechaza_employee_id_crudo(db_session, monkeypatch):
    """S2: en producción no existe atajo por employee_id sin identificación."""
    with production_env(monkeypatch):
        admin = _admin(db_session)
        employee_id = _create_employee(admin, db_session)
        guest = _guest(db_session)

        identified = _identify(guest)
        assert identified.status_code == 200, identified.text

        bypass = guest.post("/api/v1/attendance/check-in", json={"employee_id": employee_id})
        assert bypass.status_code == 401
        assert _attendance_ids(admin) == set()
