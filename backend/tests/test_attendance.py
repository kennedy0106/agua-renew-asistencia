"""Tests de marcación pública: identificación, check-in/out y worked_minutes."""

from datetime import datetime, timedelta, timezone

from app.core.timezone import lima_tz
from app.modules.attendance.service import compute_worked_minutes


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


# --- Identificación ---

def test_identify_por_dni(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))
    response = client.post("/api/v1/attendance/identify", json={"identifier": "72845632"})
    assert response.status_code == 200
    body = response.json()
    assert str(body["employee"]["id"]) == emp
    assert body["employee"]["first_name"] == "Juan"
    assert body["state"]["has_open_entry"] is False
    assert body["server_time_label"]  # hora del servidor en Lima


def test_identify_por_codigo(client, db_session):
    _login(client, "admin", "Admin123!")
    _create_employee(client, str(db_session._test_job_roles["Operario"]))
    response = client.post("/api/v1/attendance/identify", json={"identifier": "EMP-001"})
    assert response.status_code == 200


def test_identify_dni_inexistente_404(client):
    response = client.post("/api/v1/attendance/identify", json={"identifier": "99999999"})
    assert response.status_code == 404
    assert "Verifique su DNI" in response.json()["detail"]


def test_identify_empleado_inactivo_403(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))
    client.post(f"/api/v1/employees/{emp}/deactivate")
    response = client.post("/api/v1/attendance/identify", json={"identifier": "72845632"})
    assert response.status_code == 403


# --- Check-in ---

def test_check_in_crea_registro_abierto(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))
    response = client.post("/api/v1/attendance/check-in", json={"employee_id": emp})
    assert response.status_code == 201
    body = response.json()
    assert body["status"] == "OPEN"
    assert body["check_out_at"] is None
    assert body["worked_minutes"] is None
    # work_date = fecha local de Lima de hoy.
    today_lima = datetime.now(lima_tz()).date()
    assert body["work_date"] == today_lima.isoformat()


def test_doble_check_in_rechazado(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))
    assert client.post("/api/v1/attendance/check-in", json={"employee_id": emp}).status_code == 201
    response = client.post("/api/v1/attendance/check-in", json={"employee_id": emp})
    assert response.status_code == 409


def test_check_in_empleado_inexistente_404(client):
    import uuid

    response = client.post(
        "/api/v1/attendance/check-in", json={"employee_id": str(uuid.uuid4())}
    )
    assert response.status_code == 404


def test_check_in_empleado_inactivo_403(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))
    client.post(f"/api/v1/employees/{emp}/deactivate")
    response = client.post("/api/v1/attendance/check-in", json={"employee_id": emp})
    assert response.status_code == 403


# --- Check-out ---

def test_check_out_sin_entrada_409(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))
    response = client.post("/api/v1/attendance/check-out", json={"employee_id": emp})
    assert response.status_code == 409


def test_check_out_completa_registro(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))
    check_in = client.post("/api/v1/attendance/check-in", json={"employee_id": emp}).json()
    response = client.post("/api/v1/attendance/check-out", json={"employee_id": emp})
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "COMPLETE"
    assert body["check_out_at"] is not None
    assert body["worked_minutes"] >= 0

    # worked_minutes = duración − refrigerio (0 si no hay jornada configurada).
    start = datetime.fromisoformat(check_in["check_in_at"])
    end = datetime.fromisoformat(body["check_out_at"])
    expected = max(0, int((end - start).total_seconds() // 60))
    assert body["worked_minutes"] == expected


def test_check_out_descuenta_refrigerio_de_jornada(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))
    # Jornada con 60 min de refrigerio, vigente desde ayer (cubre hoy).
    from datetime import date, timedelta

    yesterday = (datetime.now(lima_tz()).date() - timedelta(days=1)).isoformat()
    client.post(
        f"/api/v1/employees/{emp}/schedule",
        json={"effective_from": yesterday, "monday_minutes": 480, "break_minutes": 60},
    )
    check_in = client.post("/api/v1/attendance/check-in", json={"employee_id": emp}).json()
    body = client.post("/api/v1/attendance/check-out", json={"employee_id": emp}).json()

    start = datetime.fromisoformat(check_in["check_in_at"])
    end = datetime.fromisoformat(body["check_out_at"])
    expected = max(0, int((end - start).total_seconds() // 60) - 60)
    assert body["worked_minutes"] == expected


def test_doble_check_out_rechazado(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))
    client.post("/api/v1/attendance/check-in", json={"employee_id": emp})
    assert client.post("/api/v1/attendance/check-out", json={"employee_id": emp}).status_code == 200
    response = client.post("/api/v1/attendance/check-out", json={"employee_id": emp})
    assert response.status_code == 409


# --- Cálculo puro ---

def test_compute_worked_minutes_normal():
    start = datetime(2026, 8, 24, 8, 0, tzinfo=timezone.utc)
    end = datetime(2026, 8, 24, 17, 0, tzinfo=timezone.utc)
    assert compute_worked_minutes(start, end, 60) == 480


def test_compute_worked_minutes_nunca_negativo():
    start = datetime(2026, 8, 24, 8, 0, tzinfo=timezone.utc)
    end = datetime(2026, 8, 24, 8, 30, tzinfo=timezone.utc)
    assert compute_worked_minutes(start, end, 60) == 0
