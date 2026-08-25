"""Tests del motor de payroll: periodos, cálculo, ajuste manual y cierre."""

import uuid
from datetime import datetime

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


def _set_salary(client, employee_id: str, **overrides):
    payload = {
        "effective_from": "2026-08-01",
        "monthly_salary": "1500.00",
        "overtime_enabled": True,
        "overtime_method": "PERCENTAGE",
        "overtime_percentage": "25.00",
        "overtime_fixed_rate": None,
    }
    payload.update(overrides)
    response = client.post(f"/api/v1/employees/{employee_id}/salary-settings", json=payload)
    assert response.status_code == 201, response.text


def _add_approved_overtime(client, employee_id: str, minutes: int = 60) -> str:
    response = client.post(
        f"/api/v1/employees/{employee_id}/adjustments",
        json={
            "adjustment_date": "2026-08-25",
            "minutes": minutes,
            "adjustment_type": "OVERTIME",
            "reason": "HE de prueba",
        },
    )
    assert response.status_code == 201, response.text
    adj_id = response.json()["id"]
    client.patch(f"/api/v1/adjustments/{adj_id}/approve")
    return adj_id


def _create_period(client, name: str = "Agosto 2026", start: str = "2026-08-01", end: str = "2026-08-31") -> dict:
    response = client.post(
        "/api/v1/payroll/periods", json={"name": name, "start_date": start, "end_date": end}
    )
    assert response.status_code == 201, response.text
    return response.json()


# --- Periodos ---

def test_crear_periodo(client):
    _login(client, "admin", "Admin123!")
    period = _create_period(client)
    assert period["status"] == "OPEN"


def test_periodo_solapado_conflict(client):
    _login(client, "admin", "Admin123!")
    _create_period(client)
    response = client.post(
        "/api/v1/payroll/periods",
        json={"name": "Agosto B", "start_date": "2026-08-15", "end_date": "2026-09-15"},
    )
    assert response.status_code == 409


def test_periodo_fechas_invalidas_422(client):
    _login(client, "admin", "Admin123!")
    response = client.post(
        "/api/v1/payroll/periods",
        json={"name": "Invalido", "start_date": "2026-09-01", "end_date": "2026-08-01"},
    )
    assert response.status_code == 422


# --- Cálculo ---

def test_calcular_crea_preview_con_sueldo(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))
    _set_salary(client, emp)
    period = _create_period(client)

    records = client.post(f"/api/v1/payroll/periods/{period['id']}/calculate").json()
    assert len(records) == 1
    record = records[0]
    assert record["employee_name"] == "Juan Pérez"
    assert record["base_salary"] == "1500.00"
    assert record["total"] == "1500.00"
    assert record["worked_minutes"] == 0
    assert record["status"] == "PREVIEW"

    period = client.get("/api/v1/payroll/periods").json()[0]
    assert period["status"] == "CALCULATED"


def test_calcular_incluye_horas_extra(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))
    _set_salary(client, emp)
    _add_approved_overtime(client, emp, minutes=60)
    period = _create_period(client)

    records = client.post(f"/api/v1/payroll/periods/{period['id']}/calculate").json()
    record = records[0]
    assert record["overtime_minutes"] == 60
    assert record["overtime_amount"] == "7.81"  # tarifa fallback 6.25 × 25% × 1 h
    assert record["total"] == "1507.81"


def test_calcular_excluye_empleado_sin_sueldo(client, db_session):
    _login(client, "admin", "Admin123!")
    _create_employee(client, str(db_session._test_job_roles["Operario"]))  # sin salary_settings
    period = _create_period(client)

    records = client.post(f"/api/v1/payroll/periods/{period['id']}/calculate").json()
    assert records == []


def test_recalcular_reemplaza_preview(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))
    _set_salary(client, emp)
    period = _create_period(client)

    first = client.post(f"/api/v1/payroll/periods/{period['id']}/calculate").json()
    assert len(first) == 1

    _add_approved_overtime(client, emp, minutes=60)
    second = client.post(f"/api/v1/payroll/periods/{period['id']}/calculate").json()
    assert len(second) == 1
    assert second[0]["overtime_amount"] == "7.81"
    assert second[0]["total"] == "1507.81"


# --- Ajuste manual ---

def test_ajuste_manual_actualiza_total_y_audita(client, db_session):
    _login(client, "boss", "Boss123!")
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))
    _set_salary(client, emp)
    period = _create_period(client)
    record = client.post(f"/api/v1/payroll/periods/{period['id']}/calculate").json()[0]

    response = client.patch(
        f"/api/v1/payroll/records/{record['id']}/adjustment",
        json={"amount": "50.00", "notes": "Viáticos de la semana"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["manual_adjustment"] == "50.00"
    assert body["total"] == "1550.00"

    _login(client, "admin", "Admin123!")
    logs = client.get("/api/v1/audit-logs").json()
    assert any(
        log["entity_type"] == "payroll_record"
        and log["action"] == "manual_adjustment"
        and log["performed_by_username"] == "boss"
        and log["new_values"]["manual_adjustment"] == "50.00"
        for log in logs
    )


def test_ajuste_manual_negativo(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))
    _set_salary(client, emp)
    period = _create_period(client)
    record = client.post(f"/api/v1/payroll/periods/{period['id']}/calculate").json()[0]

    response = client.patch(
        f"/api/v1/payroll/records/{record['id']}/adjustment",
        json={"amount": "-30.00", "notes": "Descuento autorizado por el jefe"},
    )
    assert response.status_code == 200
    assert response.json()["total"] == "1470.00"


# --- Cierre ---

def test_confirmar_cierra_periodo_y_registros(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))
    _set_salary(client, emp)
    period = _create_period(client)
    client.post(f"/api/v1/payroll/periods/{period['id']}/calculate")

    response = client.post(f"/api/v1/payroll/periods/{period['id']}/confirm")
    assert response.status_code == 200
    assert response.json()["status"] == "CLOSED"

    records = client.get(f"/api/v1/payroll/periods/{period['id']}/records").json()
    assert records[0]["status"] == "CONFIRMED"


def test_no_recalcular_tras_cierre(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))
    _set_salary(client, emp)
    period = _create_period(client)
    client.post(f"/api/v1/payroll/periods/{period['id']}/calculate")
    client.post(f"/api/v1/payroll/periods/{period['id']}/confirm")

    assert client.post(f"/api/v1/payroll/periods/{period['id']}/calculate").status_code == 409


def test_confirmar_sin_calcular_conflict(client):
    _login(client, "admin", "Admin123!")
    period = _create_period(client)
    assert client.post(f"/api/v1/payroll/periods/{period['id']}/confirm").status_code == 409


def test_ajuste_manual_tras_cierre_409(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))
    _set_salary(client, emp)
    period = _create_period(client)
    record = client.post(f"/api/v1/payroll/periods/{period['id']}/calculate").json()[0]
    client.post(f"/api/v1/payroll/periods/{period['id']}/confirm")

    response = client.patch(
        f"/api/v1/payroll/records/{record['id']}/adjustment",
        json={"amount": "50.00", "notes": "tarde"},
    )
    assert response.status_code == 409


# --- Permisos ---

def test_payroll_solo_admin_boss(client, db_session):
    _login(client, "admin", "Admin123!")
    period = _create_period(client)
    _login(client, "supervisor", "Sup123!")

    assert client.get("/api/v1/payroll/periods").status_code == 403
    assert client.post(f"/api/v1/payroll/periods/{period['id']}/calculate").status_code == 403
    assert client.get(f"/api/v1/payroll/periods/{period['id']}/records").status_code == 403
    assert client.post(f"/api/v1/payroll/periods/{period['id']}/confirm").status_code == 403


def test_payroll_requiere_auth(client):
    assert client.get("/api/v1/payroll/periods").status_code == 401
