"""Tests de ajustes de horas y saldo: aprobación, rechazo y balance."""

import uuid
from datetime import datetime, timedelta

from app.core.timezone import lima_tz


def _login(client, username: str, password: str) -> None:
    response = client.post("/api/v1/auth/login", json={"username": username, "password": password})
    assert response.status_code == 200, response.text


def _create_employee(client, job_role_id: str, dni: str = "72845632", code: str = "EMP-001") -> str:
    response = client.post(
        "/api/v1/employees",
        json={
            "dni": dni,
            "employee_code": code,
            "first_name": "Juan",
            "last_name": "Pérez",
            "job_role_id": job_role_id,
        },
    )
    assert response.status_code == 201, response.text
    return response.json()["id"]


def _adjustment_payload(**overrides):
    payload = {
        "adjustment_date": "2026-08-25",
        "minutes": 200,
        "adjustment_type": "RECUPERACION",
        "reason": "Recuperación de horas del sábado",
    }
    payload.update(overrides)
    return payload


# --- Permisos de creación ---

def test_crear_ajuste_como_admin(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))
    response = client.post(f"/api/v1/employees/{emp}/adjustments", json=_adjustment_payload())
    assert response.status_code == 201
    body = response.json()
    assert body["status"] == "PENDING"
    assert body["minutes"] == 200
    assert body["adjustment_type"] == "RECUPERACION"


def test_crear_ajuste_como_boss_permitido(client, db_session):
    _login(client, "boss", "Boss123!")
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))
    response = client.post(f"/api/v1/employees/{emp}/adjustments", json=_adjustment_payload())
    assert response.status_code == 201


def test_crear_ajuste_como_supervisor_forbidden(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))
    _login(client, "supervisor", "Sup123!")
    response = client.post(f"/api/v1/employees/{emp}/adjustments", json=_adjustment_payload())
    assert response.status_code == 403


def test_crear_ajuste_sin_auth(client):
    import uuid

    assert client.post(
        f"/api/v1/employees/{uuid.uuid4()}/adjustments", json=_adjustment_payload()
    ).status_code == 401


def test_crear_ajuste_empleado_inexistente_404(client):
    _login(client, "admin", "Admin123!")
    response = client.post(
        f"/api/v1/employees/{uuid.uuid4()}/adjustments", json=_adjustment_payload()
    )
    assert response.status_code == 404


def test_ajuste_minutos_fuera_de_rango_422(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))
    response = client.post(
        f"/api/v1/employees/{emp}/adjustments", json=_adjustment_payload(minutes=1500)
    )
    assert response.status_code == 422
    response = client.post(
        f"/api/v1/employees/{emp}/adjustments", json=_adjustment_payload(minutes=-1500)
    )
    assert response.status_code == 422


def test_ajuste_tipo_invalido_422(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))
    response = client.post(
        f"/api/v1/employees/{emp}/adjustments",
        json=_adjustment_payload(adjustment_type="VACACIONES"),
    )
    assert response.status_code == 422


# --- Aprobación / rechazo ---

def test_aprobar_como_boss(client, db_session):
    _login(client, "boss", "Boss123!")
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))
    adj = client.post(f"/api/v1/employees/{emp}/adjustments", json=_adjustment_payload()).json()

    response = client.patch(f"/api/v1/adjustments/{adj['id']}/approve")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "APPROVED"
    assert body["approved_by_username"] == "boss"


def test_aprobar_dos_veces_conflict(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))
    adj = client.post(f"/api/v1/employees/{emp}/adjustments", json=_adjustment_payload()).json()
    assert client.patch(f"/api/v1/adjustments/{adj['id']}/approve").status_code == 200
    assert client.patch(f"/api/v1/adjustments/{adj['id']}/approve").status_code == 409


def test_rechazar_con_motivo(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))
    adj = client.post(f"/api/v1/employees/{emp}/adjustments", json=_adjustment_payload()).json()
    response = client.patch(
        f"/api/v1/adjustments/{adj['id']}/reject", json={"reason": "No corresponde"}
    )
    assert response.status_code == 200
    assert response.json()["status"] == "REJECTED"


def test_rechazar_sin_motivo_422(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))
    adj = client.post(f"/api/v1/employees/{emp}/adjustments", json=_adjustment_payload()).json()
    assert client.patch(f"/api/v1/adjustments/{adj['id']}/reject", json={}).status_code == 422


def test_aprobar_como_supervisor_forbidden(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))
    adj = client.post(f"/api/v1/employees/{emp}/adjustments", json=_adjustment_payload()).json()
    _login(client, "supervisor", "Sup123!")
    assert client.patch(f"/api/v1/adjustments/{adj['id']}/approve").status_code == 403


def test_aprobar_inexistente_404(client):
    _login(client, "admin", "Admin123!")
    assert client.patch(f"/api/v1/adjustments/{uuid.uuid4()}/approve").status_code == 404


# --- Listado ---

def test_listar_ajustes_como_supervisor(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))
    client.post(f"/api/v1/employees/{emp}/adjustments", json=_adjustment_payload())
    client.post(
        f"/api/v1/employees/{emp}/adjustments",
        json=_adjustment_payload(adjustment_type="PERMISO", minutes=-120),
    )
    _login(client, "supervisor", "Sup123!")
    response = client.get(f"/api/v1/employees/{emp}/adjustments")
    assert response.status_code == 200
    assert len(response.json()) == 2


# --- Saldo ---

def test_balance_trabajado_menos_esperado(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))

    # Jornada 480 min todos los días desde ayer.
    yesterday = (datetime.now(lima_tz()).date() - timedelta(days=1)).isoformat()
    client.post(
        f"/api/v1/employees/{emp}/schedule",
        json={
            "effective_from": yesterday,
            "monday_minutes": 480,
            "tuesday_minutes": 480,
            "wednesday_minutes": 480,
            "thursday_minutes": 480,
            "friday_minutes": 480,
            "saturday_minutes": 480,
            "sunday_minutes": 480,
        },
    )
    # Sin marcación hoy → trabajado 0, esperado 480 → saldo -480.
    today = datetime.now(lima_tz()).date().isoformat()
    balance = client.get(f"/api/v1/employees/{emp}/balance?date_from={today}&date_to={today}").json()
    assert balance["worked_minutes"] == 0
    assert balance["expected_minutes"] == 480
    assert balance["adjustment_minutes"] == 0
    assert balance["balance_minutes"] == -480


def test_balance_incluye_solo_ajustes_aprobados(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))

    pending = client.post(
        f"/api/v1/employees/{emp}/adjustments", json=_adjustment_payload(minutes=200)
    ).json()
    approved = client.post(
        f"/api/v1/employees/{emp}/adjustments",
        json=_adjustment_payload(adjustment_date="2026-08-24", minutes=120),
    ).json()
    client.patch(f"/api/v1/adjustments/{approved['id']}/approve")

    balance = client.get(f"/api/v1/employees/{emp}/balance?date_from=2026-08-01&date_to=2026-08-31").json()
    # El PENDING (+200) NO cuenta; solo el aprobado (+120).
    assert balance["adjustment_minutes"] == 120
    # Sin asistencia ni jornada en el rango → saldo = 0 - 0 + 120.
    assert balance["balance_minutes"] == 120
    assert pending["status"] == "PENDING"


def test_balance_rango_invalido_422(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))
    response = client.get(
        f"/api/v1/employees/{emp}/balance?date_from=2026-08-31&date_to=2026-08-01"
    )
    assert response.status_code == 422


def test_auditoria_de_aprobacion_y_rechazo(client, db_session):
    _login(client, "boss", "Boss123!")
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))
    adj = client.post(f"/api/v1/employees/{emp}/adjustments", json=_adjustment_payload()).json()
    client.patch(f"/api/v1/adjustments/{adj['id']}/approve")

    _login(client, "admin", "Admin123!")
    logs = client.get("/api/v1/audit-logs").json()
    assert any(
        log["entity_type"] == "adjustment"
        and log["action"] == "approve"
        and log["performed_by_username"] == "boss"
        for log in logs
    )
