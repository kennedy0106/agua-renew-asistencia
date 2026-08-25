"""Tests de configuración salarial: privacidad, vigencia histórica y Decimal."""

import uuid
from datetime import date

from app.modules.salary.service import SalaryService


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


def _salary_payload(effective_from: str = "2026-08-01", **overrides):
    payload = {"effective_from": effective_from, "monthly_salary": "1500.00"}
    payload.update(overrides)
    return payload


# --- Privacidad salarial (MVP §6: solo ADMIN/BOSS) ---

def test_get_salary_requiere_auth(client):
    assert client.get(f"/api/v1/employees/{uuid.uuid4()}/salary-settings").status_code == 401


def test_get_salary_como_supervisor_forbidden(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))
    _login(client, "supervisor", "Sup123!")
    assert client.get(f"/api/v1/employees/{emp}/salary-settings").status_code == 403


def test_post_salary_como_supervisor_forbidden(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))
    _login(client, "supervisor", "Sup123!")
    response = client.post(f"/api/v1/employees/{emp}/salary-settings", json=_salary_payload())
    assert response.status_code == 403


def test_get_salary_como_boss_permitido(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))
    client.post(f"/api/v1/employees/{emp}/salary-settings", json=_salary_payload())
    _login(client, "boss", "Boss123!")
    response = client.get(f"/api/v1/employees/{emp}/salary-settings")
    assert response.status_code == 200
    assert response.json()["monthly_salary"] == "1500.00"


# --- Creación y Decimal ---

def test_set_salary_como_admin(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))
    response = client.post(
        f"/api/v1/employees/{emp}/salary-settings",
        json=_salary_payload(monthly_salary="1500.50"),
    )
    assert response.status_code == 201
    body = response.json()
    assert body["monthly_salary"] == "1500.50"  # Decimal serializado sin perder precisión
    assert body["overtime_enabled"] is False
    assert body["effective_to"] is None


def test_sueldo_negativo_rechazado(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))
    response = client.post(
        f"/api/v1/employees/{emp}/salary-settings",
        json=_salary_payload(monthly_salary="-100.00"),
    )
    assert response.status_code == 422


def test_sueldo_con_mas_de_2_decimales_rechazado(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))
    response = client.post(
        f"/api/v1/employees/{emp}/salary-settings",
        json=_salary_payload(monthly_salary="1500.123"),
    )
    assert response.status_code == 422


def test_metodo_horas_extra_invalido_rechazado(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))
    response = client.post(
        f"/api/v1/employees/{emp}/salary-settings",
        json=_salary_payload(overtime_enabled=True, overtime_method="DESCUENTO"),
    )
    assert response.status_code == 422


def test_percentage_requiere_porcentaje(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))
    response = client.post(
        f"/api/v1/employees/{emp}/salary-settings",
        json=_salary_payload(overtime_enabled=True, overtime_method="PERCENTAGE"),
    )
    assert response.status_code == 422


def test_fixed_rate_requiere_tarifa(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))
    response = client.post(
        f"/api/v1/employees/{emp}/salary-settings",
        json=_salary_payload(overtime_enabled=True, overtime_method="FIXED_RATE"),
    )
    assert response.status_code == 422


def test_porcentaje_valido(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))
    response = client.post(
        f"/api/v1/employees/{emp}/salary-settings",
        json=_salary_payload(overtime_enabled=True, overtime_method="PERCENTAGE", overtime_percentage="25.00"),
    )
    assert response.status_code == 201
    assert response.json()["overtime_percentage"] == "25.00"


# --- Vigencia histórica ---

def test_cambio_de_sueldo_preserva_historial(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))
    emp_uuid = uuid.UUID(emp)

    client.post(f"/api/v1/employees/{emp}/salary-settings", json=_salary_payload(effective_from="2026-08-01", monthly_salary="1300.00"))
    response = client.post(f"/api/v1/employees/{emp}/salary-settings", json=_salary_payload(effective_from="2026-09-01", monthly_salary="1500.00"))
    assert response.status_code == 201

    history = client.get(f"/api/v1/employees/{emp}/salary-settings/history").json()
    assert len(history) == 2
    by_from = {h["effective_from"]: h for h in history}
    assert by_from["2026-08-01"]["monthly_salary"] == "1300.00"
    assert by_from["2026-08-01"]["effective_to"] == "2026-08-31"
    assert by_from["2026-09-01"]["monthly_salary"] == "1500.00"
    assert by_from["2026-09-01"]["effective_to"] is None

    # El servicio resuelve el sueldo vigente en cada fecha.
    service = SalaryService(db_session)
    assert service.get_for_date_or_404(emp_uuid, date(2026, 8, 15)).monthly_salary == 1300
    assert service.get_for_date_or_404(emp_uuid, date(2026, 9, 15)).monthly_salary == 1500

    # Consulta por fecha en la API.
    old = client.get(f"/api/v1/employees/{emp}/salary-settings?date=2026-08-15").json()
    assert old["monthly_salary"] == "1300.00"


def test_solapamiento_de_sueldo_conflict(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))
    client.post(f"/api/v1/employees/{emp}/salary-settings", json=_salary_payload(effective_from="2026-09-01"))
    response = client.post(f"/api/v1/employees/{emp}/salary-settings", json=_salary_payload(effective_from="2026-08-15"))
    assert response.status_code == 409


def test_set_salary_empleado_inexistente_404(client):
    _login(client, "admin", "Admin123!")
    response = client.post(
        f"/api/v1/employees/{uuid.uuid4()}/salary-settings", json=_salary_payload()
    )
    assert response.status_code == 404
