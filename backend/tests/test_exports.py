"""Tests de exportaciones CSV: contenido, BOM UTF-8 y permisos."""

import io
import csv as csv_module
from datetime import datetime

from app.core.timezone import lima_tz


def _login(client, username: str, password: str) -> None:
    response = client.post("/api/v1/auth/login", json={"username": username, "password": password})
    assert response.status_code == 200, response.text


def _parse_csv(response):
    raw = response.content
    assert raw.startswith(b"\xef\xbb\xbf"), "Falta el BOM UTF-8"
    return list(csv_module.reader(io.StringIO(raw.decode("utf-8-sig"))))


def _create_employee(client, db_session, dni="72845632", code="EMP-001") -> str:
    response = client.post(
        "/api/v1/employees",
        json={
            "dni": dni,
            "employee_code": code,
            "first_name": "Juan",
            "last_name": "Pérez",
            "job_role_id": str(db_session._test_job_roles["Operario"]),
        },
    )
    assert response.status_code == 201, response.text
    return response.json()["id"]


def _make_complete_record(client, employee_id: str) -> None:
    check_in = client.post("/api/v1/attendance/check-in", json={"employee_id": employee_id}).json()
    client.post("/api/v1/attendance/check-out", json={"employee_id": employee_id})
    today = datetime.now(lima_tz()).date()
    client.patch(
        f"/api/v1/attendance/{check_in['id']}",
        json={
            "check_in_at": datetime(today.year, today.month, today.day, 8, 0).isoformat(),
            "check_out_at": datetime(today.year, today.month, today.day, 16, 0).isoformat(),
            "reason": "Fijar horario de prueba",
        },
    )


# --- Asistencia ---

def test_csv_asistencia_requiere_auth(client):
    assert client.get("/api/v1/exports/attendance.csv").status_code == 401


def test_csv_asistencia_contenido_y_bom(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, db_session)
    _make_complete_record(client, emp)
    _login(client, "supervisor", "Sup123!")  # cualquier autenticado puede exportar

    response = client.get("/api/v1/exports/attendance.csv")
    assert response.status_code == 200
    assert "text/csv" in response.headers["content-type"]
    assert "attachment" in response.headers["content-disposition"]

    rows = _parse_csv(response)
    header = rows[0]
    assert header[0] == "Fecha"
    assert "Trabajado (min)" in header
    assert len(rows) == 2
    data = rows[1]
    assert data[1] == "Juan Pérez"  # acentos intactos gracias al BOM
    assert data[2] == "72845632"
    assert data[3] == "Operario"
    assert data[6] == "480"  # trabajado
    assert data[9] == "COMPLETE"


def test_csv_asistencia_filtro_por_empleado(client, db_session):
    _login(client, "admin", "Admin123!")
    emp1 = _create_employee(client, db_session, "72845632", "EMP-001")
    emp2 = _create_employee(client, db_session, "71112233", "EMP-002")
    _make_complete_record(client, emp1)
    _make_complete_record(client, emp2)

    response = client.get(f"/api/v1/exports/attendance.csv?employee_id={emp1}")
    rows = _parse_csv(response)
    assert len(rows) == 2  # header + 1 fila
    assert rows[1][2] == "72845632"


def test_csv_asistencia_vacio_solo_header(client):
    _login(client, "admin", "Admin123!")
    response = client.get("/api/v1/exports/attendance.csv?date_from=2030-01-01&date_to=2030-01-31")
    rows = _parse_csv(response)
    assert len(rows) == 1


# --- Sueldos ---

def _create_calculated_period(client, db_session) -> dict:
    emp = _create_employee(client, db_session, "72845632", "EMP-001")
    client.post(
        f"/api/v1/employees/{emp}/salary-settings",
        json={
            "effective_from": "2026-08-01",
            "monthly_salary": "1500.00",
            "overtime_enabled": False,
            "overtime_method": "PERCENTAGE",
            "overtime_percentage": "25.00",
            "overtime_fixed_rate": None,
        },
    )
    period = client.post(
        "/api/v1/payroll/periods",
        json={"name": "Agosto 2026", "start_date": "2026-08-01", "end_date": "2026-08-31"},
    ).json()
    client.post(f"/api/v1/payroll/periods/{period['id']}/calculate")
    return period


def test_csv_sueldos_supervisor_forbidden(client):
    _login(client, "supervisor", "Sup123!")
    assert client.get("/api/v1/exports/salaries.csv?period_id=00000000-0000-0000-0000-000000000000").status_code == 403


def test_csv_sueldos_contenido(client, db_session):
    _login(client, "boss", "Boss123!")  # BOSS puede ver sueldos
    period = _create_calculated_period(client, db_session)

    response = client.get(f"/api/v1/exports/salaries.csv?period_id={period['id']}")
    assert response.status_code == 200
    rows = _parse_csv(response)
    header = rows[0]
    assert header[4] == "Sueldo base (S/)"
    assert header[12] == "Total (S/)"
    assert len(rows) == 2
    data = rows[1]
    assert data[0] == "Agosto 2026"
    assert data[1] == "Juan Pérez"
    assert data[4] == "1500.00"
    assert data[12] == "1500.00"


def test_csv_sueldos_periodo_inexistente_404(client):
    _login(client, "admin", "Admin123!")
    assert (
        client.get(
            "/api/v1/exports/salaries.csv?period_id=00000000-0000-0000-0000-000000000000"
        ).status_code
        == 404
    )
