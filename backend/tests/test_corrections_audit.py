"""Tests de correcciones y auditoría: motivo obligatorio, recálculo y bitácora."""

import uuid
from datetime import datetime, timedelta, timezone

from app.core.timezone import lima_tz


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


def _create_complete_record(client, employee_id: str) -> str:
    """Check-in + check-out → registro COMPLETE; devuelve su id."""
    check_in = client.post("/api/v1/attendance/check-in", json={"employee_id": employee_id}).json()
    client.post("/api/v1/attendance/check-out", json={"employee_id": employee_id})
    return check_in["id"]


# --- Permisos y validación del motivo ---

def test_correccion_requiere_auth(client):
    assert client.patch(f"/api/v1/attendance/{uuid.uuid4()}", json={"reason": "test"}).status_code == 401


def test_correccion_sin_motivo_422(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))
    record_id = _create_complete_record(client, emp)
    response = client.patch(f"/api/v1/attendance/{record_id}", json={"notes": "sin motivo"})
    assert response.status_code == 422


def test_correccion_como_supervisor_forbidden(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))
    record_id = _create_complete_record(client, emp)
    _login(client, "supervisor", "Sup123!")
    response = client.patch(
        f"/api/v1/attendance/{record_id}", json={"notes": "x", "reason": "intento"}
    )
    assert response.status_code == 403


def test_correccion_como_boss_permitido(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))
    record_id = _create_complete_record(client, emp)
    _login(client, "boss", "Boss123!")
    response = client.patch(
        f"/api/v1/attendance/{record_id}", json={"notes": "olvidó marcar", "reason": "Corrección del jefe"}
    )
    assert response.status_code == 200
    assert response.json()["notes"] == "olvidó marcar"


def test_correccion_inexistente_404(client):
    _login(client, "admin", "Admin123!")
    response = client.patch(
        f"/api/v1/attendance/{uuid.uuid4()}", json={"notes": "x", "reason": "test"}
    )
    assert response.status_code == 404


def test_correccion_sin_cambios_409(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))
    record_id = _create_complete_record(client, emp)
    response = client.patch(f"/api/v1/attendance/{record_id}", json={"reason": "sin cambios"})
    assert response.status_code == 409


# --- Recálculo por el backend ---

def test_correccion_recalcula_worked_minutes(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))

    # Jornada con refrigerio 60, vigente desde ayer.
    yesterday = (datetime.now(lima_tz()).date() - timedelta(days=1)).isoformat()
    client.post(
        f"/api/v1/employees/{emp}/schedule",
        json={"effective_from": yesterday, "monday_minutes": 480, "break_minutes": 60},
    )
    record_id = _create_complete_record(client, emp)

    # Corregir la entrada: 8:00 Lima y salida 17:00 Lima del día de hoy.
    today = datetime.now(lima_tz()).date()
    check_in = datetime(today.year, today.month, today.day, 8, 0, tzinfo=lima_tz()).astimezone(timezone.utc)
    check_out = datetime(today.year, today.month, today.day, 17, 0, tzinfo=lima_tz()).astimezone(timezone.utc)
    response = client.patch(
        f"/api/v1/attendance/{record_id}",
        json={
            "check_in_at": check_in.isoformat(),
            "check_out_at": check_out.isoformat(),
            "reason": "El trabajador olvidó marcar; se registra la jornada real",
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "COMPLETE"
    assert body["worked_minutes"] == 480  # 9 h − 60 min de refrigerio
    assert body["work_date"] == today.isoformat()


def test_correccion_limpiar_salida_vuelve_open(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))
    record_id = _create_complete_record(client, emp)

    response = client.patch(
        f"/api/v1/attendance/{record_id}",
        json={"check_out_at": None, "reason": "La salida fue registrada por error"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "OPEN"
    assert body["check_out_at"] is None
    assert body["worked_minutes"] is None


def test_correccion_salida_anterior_a_entrada_422(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))
    record_id = _create_complete_record(client, emp)
    today = datetime.now(lima_tz()).date()
    check_in = datetime(today.year, today.month, today.day, 10, 0, tzinfo=lima_tz()).astimezone(timezone.utc)
    check_out = datetime(today.year, today.month, today.day, 8, 0, tzinfo=lima_tz()).astimezone(timezone.utc)
    response = client.patch(
        f"/api/v1/attendance/{record_id}",
        json={
            "check_in_at": check_in.isoformat(),
            "check_out_at": check_out.isoformat(),
            "reason": "Intento de salida antes de la entrada",
        },
    )
    assert response.status_code == 422
    assert "salida" in response.json()["detail"].lower()


def test_correccion_reapertura_con_otra_open_409(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))
    closed_id = _create_complete_record(client, emp)
    open_entry = client.post("/api/v1/attendance/check-in", json={"employee_id": emp})
    assert open_entry.status_code == 201
    response = client.patch(
        f"/api/v1/attendance/{closed_id}",
        json={"check_out_at": None, "reason": "Reabrir un registro ya cerrado"},
    )
    assert response.status_code == 409


def test_correccion_cambia_work_date_si_entrada_cruza_medianoche(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))
    record_id = _create_complete_record(client, emp)

    # Entrada corregida a las 23:30 Lima del día ANTERIOR.
    today = datetime.now(lima_tz()).date()
    yesterday_evening = datetime(today.year, today.month, today.day - 1, 23, 30, tzinfo=lima_tz()).astimezone(timezone.utc)
    response = client.patch(
        f"/api/v1/attendance/{record_id}",
        json={"check_in_at": yesterday_evening.isoformat(), "reason": "Turno nocturno"},
    )
    assert response.status_code == 200
    assert response.json()["work_date"] == (today - timedelta(days=1)).isoformat()


# --- Auditoría ---

def test_correccion_genera_auditoria_con_old_new(client, db_session):
    _login(client, "boss", "Boss123!")
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))
    record_id = _create_complete_record(client, emp)
    client.patch(
        f"/api/v1/attendance/{record_id}",
        json={"notes": "nueva nota", "reason": "Corrección de prueba"},
    )

    _login(client, "admin", "Admin123!")
    logs = client.get("/api/v1/audit-logs").json()
    assert len(logs) == 1
    entry = logs[0]
    assert entry["entity_type"] == "attendance"
    assert entry["entity_id"] == record_id
    assert entry["action"] == "correction"
    assert entry["reason"] == "Corrección de prueba"
    assert entry["performed_by_username"] == "boss"  # quien corrigió
    assert entry["old_values"]["notes"] is None
    assert entry["new_values"]["notes"] == "nueva nota"
    # Solo cambió notes: la entrada/salida quedan intactas.
    assert entry["old_values"]["check_in_at"] == entry["new_values"]["check_in_at"]
    assert entry["old_values"]["worked_minutes"] == entry["new_values"]["worked_minutes"]


def test_audit_logs_solo_admin(client, db_session):
    _login(client, "boss", "Boss123!")
    assert client.get("/api/v1/audit-logs").status_code == 403


def test_audit_logs_sin_auth(client):
    assert client.get("/api/v1/audit-logs").status_code == 401


def test_audit_logs_filtro_por_entidad(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))
    record1 = _create_complete_record(client, emp)
    record2 = _create_complete_record(client, emp)
    client.patch(f"/api/v1/attendance/{record1}", json={"notes": "a", "reason": "motivo 1"})
    client.patch(f"/api/v1/attendance/{record2}", json={"notes": "b", "reason": "motivo 2"})

    filtered = client.get(f"/api/v1/audit-logs?entity_id={record1}").json()
    assert len(filtered) == 1
    assert filtered[0]["entity_id"] == record1
