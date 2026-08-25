"""Tests de jornadas laborales: días, vigencia histórica, permisos y 409."""

import uuid
from datetime import date, timedelta

from app.modules.schedules.service import ScheduleService

MONDAY = date(2026, 8, 24)  # lunes
SUNDAY = date(2026, 8, 30)  # domingo


def _login(client, username: str, password: str) -> None:
    response = client.post("/api/v1/auth/login", json={"username": username, "password": password})
    assert response.status_code == 200, response.text


def _create_employee(client, job_role_id: str) -> str:
    response = client.post(
        "/api/v1/employees",
        json={
            "dni": "72845632",
            "employee_code": "EMP-001",
            "first_name": "Juan",
            "last_name": "Pérez",
            "job_role_id": job_role_id,
        },
    )
    assert response.status_code == 201, response.text
    return response.json()["id"]


def _schedule_payload(effective_from: str, **days):
    payload = {"effective_from": effective_from, "monday_minutes": 480, "break_minutes": 60}
    payload.update(days)
    return payload


# --- Permisos ---

def test_get_schedule_requiere_auth(client, db_session):
    assert client.get(f"/api/v1/employees/{uuid.uuid4()}/schedule").status_code == 401


def test_get_schedule_sin_jornada_404(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))
    _login(client, "supervisor", "Sup123!")
    assert client.get(f"/api/v1/employees/{emp}/schedule").status_code == 404


def test_post_schedule_como_admin(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))
    response = client.post(
        f"/api/v1/employees/{emp}/schedule", json=_schedule_payload("2026-08-01")
    )
    assert response.status_code == 201
    body = response.json()
    assert body["monday_minutes"] == 480
    assert body["break_minutes"] == 60
    assert body["effective_to"] is None  # vigente


def test_post_schedule_como_boss_permitido(client, db_session):
    _login(client, "boss", "Boss123!")
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))
    response = client.post(
        f"/api/v1/employees/{emp}/schedule", json=_schedule_payload("2026-08-01")
    )
    assert response.status_code == 201


def test_post_schedule_como_supervisor_forbidden(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))
    _login(client, "supervisor", "Sup123!")
    response = client.post(
        f"/api/v1/employees/{emp}/schedule", json=_schedule_payload("2026-08-01")
    )
    assert response.status_code == 403


def test_post_schedule_empleado_inexistente_404(client):
    _login(client, "admin", "Admin123!")
    response = client.post(
        f"/api/v1/employees/{uuid.uuid4()}/schedule", json=_schedule_payload("2026-08-01")
    )
    assert response.status_code == 404


# --- expected_minutes ---

def test_expected_minutes_dia_laborable_y_no_laborable(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))
    client.post(
        f"/api/v1/employees/{emp}/schedule",
        json={"effective_from": "2026-08-01", "monday_minutes": 480, "sunday_minutes": 0},
    )
    service = ScheduleService(db_session)
    assert MONDAY.weekday() == 0
    assert service.expected_minutes(uuid.UUID(emp), MONDAY) == 480
    assert service.expected_minutes(uuid.UUID(emp), SUNDAY) == 0  # día no laborable


def test_expected_minutes_sin_jornada_es_cero(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))
    service = ScheduleService(db_session)
    assert service.expected_minutes(uuid.UUID(emp), MONDAY) == 0


# --- Vigencia histórica ---

def test_cambio_de_jornada_preserva_historial(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))
    emp_uuid = uuid.UUID(emp)

    # Jornada A: lunes 480 desde agosto.
    client.post(
        f"/api/v1/employees/{emp}/schedule",
        json={"effective_from": "2026-08-01", "monday_minutes": 480},
    )
    # Jornada B: lunes 360 desde septiembre.
    response = client.post(
        f"/api/v1/employees/{emp}/schedule",
        json={"effective_from": "2026-09-01", "monday_minutes": 360},
    )
    assert response.status_code == 201

    history = client.get(f"/api/v1/employees/{emp}/schedule/history").json()
    assert len(history) == 2
    by_from = {h["effective_from"]: h for h in history}
    assert by_from["2026-08-01"]["effective_to"] == "2026-08-31"  # cerrada
    assert by_from["2026-09-01"]["effective_to"] is None  # vigente

    service = ScheduleService(db_session)
    assert service.expected_minutes(emp_uuid, date(2026, 8, 24)) == 480  # jornada A
    assert service.expected_minutes(emp_uuid, date(2026, 9, 7)) == 360  # jornada B

    # Consulta por fecha específica.
    old = client.get(f"/api/v1/employees/{emp}/schedule?date=2026-08-24").json()
    assert old["monday_minutes"] == 480


def test_solapamiento_de_jornada_conflict(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))
    client.post(
        f"/api/v1/employees/{emp}/schedule",
        json={"effective_from": "2026-09-01", "monday_minutes": 480},
    )
    response = client.post(
        f"/api/v1/employees/{emp}/schedule",
        json={"effective_from": "2026-08-15", "monday_minutes": 480},
    )
    assert response.status_code == 409


# --- Validaciones ---

def test_minutos_negativos_rechazados(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))
    response = client.post(
        f"/api/v1/employees/{emp}/schedule",
        json={"effective_from": "2026-08-01", "monday_minutes": -10},
    )
    assert response.status_code == 422


def test_minutos_mas_de_24h_rechazados(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))
    response = client.post(
        f"/api/v1/employees/{emp}/schedule",
        json={"effective_from": "2026-08-01", "tuesday_minutes": 1500},
    )
    assert response.status_code == 422
