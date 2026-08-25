"""Tests del panel de asistencia: lista con filtros, esperado/diferencia y resumen."""

import uuid
from datetime import datetime, timedelta

from app.core.timezone import lima_tz


def _login(client, username: str, password: str) -> None:
    response = client.post("/api/v1/auth/login", json={"username": username, "password": password})
    assert response.status_code == 200, response.text


def _create_employee(client, job_role_id: str, dni: str, code: str) -> str:
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


def _full_day(client, employee_id: str) -> None:
    """Registro completo de hoy (check-in + check-out)."""
    assert client.post("/api/v1/attendance/check-in", json={"employee_id": employee_id}).status_code == 201
    assert client.post("/api/v1/attendance/check-out", json={"employee_id": employee_id}).status_code == 200


def _today_iso() -> str:
    return datetime.now(lima_tz()).date().isoformat()


# --- Acceso ---

def test_list_requiere_autenticacion(client):
    assert client.get("/api/v1/attendance").status_code == 401


def test_list_como_supervisor_permitido(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]), "72845632", "EMP-001")
    _full_day(client, emp)
    _login(client, "supervisor", "Sup123!")
    response = client.get("/api/v1/attendance")
    assert response.status_code == 200
    assert len(response.json()) == 1


# --- Lista y filtros ---

def test_lista_con_esperado_y_diferencia(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]), "72845632", "EMP-001")

    # Jornada de 480 min todos los días, vigente desde ayer (cubre hoy).
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
    check_in = client.post("/api/v1/attendance/check-in", json={"employee_id": emp}).json()
    body = client.post("/api/v1/attendance/check-out", json={"employee_id": emp}).json()

    listing = client.get("/api/v1/attendance").json()
    assert len(listing) == 1
    row = listing[0]
    assert row["employee_name"] == "Juan Pérez"
    assert row["expected_minutes"] == 480
    assert row["worked_minutes"] == body["worked_minutes"]
    assert row["difference_minutes"] == body["worked_minutes"] - 480


def test_filtro_por_empleado(client, db_session):
    _login(client, "admin", "Admin123!")
    role = str(db_session._test_job_roles["Operario"])
    emp1 = _create_employee(client, role, "72845632", "EMP-001")
    emp2 = _create_employee(client, role, "71112233", "EMP-002")
    _full_day(client, emp1)
    _full_day(client, emp2)

    listing = client.get(f"/api/v1/attendance?employee_id={emp1}").json()
    assert len(listing) == 1
    assert listing[0]["employee_id"] == emp1


def test_filtro_por_fechas_y_estado(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]), "72845632", "EMP-001")
    _full_day(client, emp)  # COMPLETE hoy
    client.post("/api/v1/attendance/check-in", json={"employee_id": emp})  # OPEN hoy (doble... )

    # Nota: tras el check-out, un nuevo check-in del mismo día crea un segundo registro OPEN.
    today = _today_iso()
    complete = client.get(f"/api/v1/attendance?date_from={today}&date_to={today}&status=COMPLETE").json()
    assert len(complete) == 1
    open_records = client.get(f"/api/v1/attendance?date_from={today}&date_to={today}&status=OPEN").json()
    assert len(open_records) == 1

    empty = client.get("/api/v1/attendance?date_from=2020-01-01&date_to=2020-01-31").json()
    assert empty == []


# --- Resumen del día ---

def test_summary_indicadores(client, db_session):
    _login(client, "admin", "Admin123!")
    role = str(db_session._test_job_roles["Operario"])
    emp1 = _create_employee(client, role, "72845632", "EMP-001")
    emp2 = _create_employee(client, role, "71112233", "EMP-002")
    emp3 = _create_employee(client, role, "73334455", "EMP-003")

    _full_day(client, emp1)  # presente + salida
    client.post("/api/v1/attendance/check-in", json={"employee_id": emp2})  # presente, entrada abierta
    # emp3: sin marcación

    summary = client.get("/api/v1/attendance/summary").json()
    assert summary["employees_active"] == 3
    assert summary["present_today"] == 2
    assert summary["no_entry_today"] == 1
    assert summary["open_entries"] == 1
    assert summary["checked_out_today"] == 1
