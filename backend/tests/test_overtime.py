"""Tests de horas extra: detección, clasificación y valor según método."""

import uuid
from datetime import datetime, timedelta

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


def _today_lima():
    return datetime.now(lima_tz()).date()


def _set_record_times(client, record_id: str, start_hour: int, end_hour: int):
    """Corrige un registro a horas exactas de HOY en Lima (recalcula worked)."""
    today = _today_lima()
    check_in = datetime(today.year, today.month, today.day, start_hour, 0, tzinfo=lima_tz()).astimezone(
        datetime.now().astimezone().tzinfo  # type: ignore[arg-type]
    )
    # Enviamos la hora local del navegador del test (misma zona) como ISO sin tz.
    local_check_in = check_in.replace(tzinfo=None).isoformat()
    local_check_out = (
        datetime(today.year, today.month, today.day, end_hour, 0).isoformat()
    )
    response = client.patch(
        f"/api/v1/attendance/{record_id}",
        json={
            "check_in_at": local_check_in,
            "check_out_at": local_check_out,
            "reason": "Fijar horario de prueba",
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


def _create_full_record(client, employee_id: str, start_hour: int, end_hour: int) -> str:
    check_in = client.post("/api/v1/attendance/check-in", json={"employee_id": employee_id}).json()
    client.post("/api/v1/attendance/check-out", json={"employee_id": employee_id})
    body = _set_record_times(client, check_in["id"], start_hour, end_hour)
    return body


def _set_schedule_full_week(client, employee_id: str, minutes: int = 480, break_minutes: int = 0):
    yesterday = (_today_lima() - timedelta(days=1)).isoformat()
    client.post(
        f"/api/v1/employees/{employee_id}/schedule",
        json={
            "effective_from": yesterday,
            "monday_minutes": minutes,
            "tuesday_minutes": minutes,
            "wednesday_minutes": minutes,
            "thursday_minutes": minutes,
            "friday_minutes": minutes,
            "saturday_minutes": minutes,
            "sunday_minutes": minutes,
            "break_minutes": break_minutes,
        },
    )


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


def _create_and_approve_overtime(client, employee_id: str, minutes: int = 60) -> str:
    response = client.post(
        f"/api/v1/employees/{employee_id}/adjustments",
        json={
            "adjustment_date": "2026-08-25",
            "minutes": minutes,
            "adjustment_type": "OVERTIME",
            "reason": "Horas extra del 25",
        },
    )
    assert response.status_code == 201, response.text
    adj_id = response.json()["id"]
    client.patch(f"/api/v1/adjustments/{adj_id}/approve")
    return adj_id


# --- Detección ---

def test_detect_encuentra_sobretiempo(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))
    _set_schedule_full_week(client, emp, break_minutes=0)

    _create_full_record(client, emp, 8, 18)  # 10 h = 600 min trabajados

    today = _today_lima().isoformat()
    detected = client.get(
        f"/api/v1/employees/{emp}/overtime/detect?date_from={today}&date_to={today}"
    ).json()
    assert len(detected) == 1
    item = detected[0]
    assert item["worked_minutes"] == 600
    assert item["expected_minutes"] == 480
    assert item["extra_minutes"] == 120


def test_detect_no_lista_dias_sin_sobretiempo(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))
    _set_schedule_full_week(client, emp, break_minutes=0)
    _create_full_record(client, emp, 8, 16)  # 480 = esperado → sin extra

    today = _today_lima().isoformat()
    detected = client.get(
        f"/api/v1/employees/{emp}/overtime/detect?date_from={today}&date_to={today}"
    ).json()
    assert detected == []


def test_detect_permisos(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))
    _login(client, "supervisor", "Sup123!")
    today = _today_lima().isoformat()
    assert (
        client.get(f"/api/v1/employees/{emp}/overtime/detect?date_from={today}&date_to={today}").status_code
        == 403
    )


# --- Clasificación (ajuste OVERTIME) ---

def test_ajuste_overtime_exige_minutos_positivos(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))
    response = client.post(
        f"/api/v1/employees/{emp}/adjustments",
        json={
            "adjustment_date": "2026-08-25",
            "minutes": -60,
            "adjustment_type": "OVERTIME",
            "reason": "invalido",
        },
    )
    assert response.status_code == 422


# --- Valor según método ---

def test_valor_porcentaje(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))
    _set_salary(client, emp)  # PERCENTAGE 25%, S/1500
    _create_and_approve_overtime(client, emp, minutes=60)

    result = client.get("/api/v1/employees/{}/overtime/value?date_from=2026-08-01&date_to=2026-08-31".format(emp)).json()
    assert result["method"] == "PERCENTAGE"
    assert result["overtime_minutes"] == 60
    # Sin jornada → fallback 240 h → tarifa 1500/240 = 6.25 S/h.
    assert result["hourly_rate"] == "6.2500"
    # 60 min × (6.25/60 × 1.25) = 7.8125 → 7.81
    assert result["value"] == "7.81"
    assert len(result["breakdown"]) == 1


def test_valor_tarifa_fija(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))
    _set_salary(client, emp, overtime_method="FIXED_RATE", overtime_percentage=None, overtime_fixed_rate="10.00")
    _create_and_approve_overtime(client, emp, minutes=60)

    result = client.get("/api/v1/employees/{}/overtime/value?date_from=2026-08-01&date_to=2026-08-31".format(emp)).json()
    assert result["method"] == "FIXED_RATE"
    assert result["value"] == "10.00"  # 1 h × S/10


def test_valor_manual_es_cero(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))
    _set_salary(client, emp, overtime_method="MANUAL", overtime_percentage=None)
    _create_and_approve_overtime(client, emp, minutes=60)

    result = client.get("/api/v1/employees/{}/overtime/value?date_from=2026-08-01&date_to=2026-08-31".format(emp)).json()
    assert result["method"] == "MANUAL"
    assert result["value"] == "0.00"  # el monto se ingresa a mano en el periodo


def test_valor_con_horas_extra_deshabilitadas_es_cero(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))
    _set_salary(client, emp, overtime_enabled=False, overtime_percentage=None)
    _create_and_approve_overtime(client, emp, minutes=60)

    result = client.get("/api/v1/employees/{}/overtime/value?date_from=2026-08-01&date_to=2026-08-31".format(emp)).json()
    assert result["value"] == "0.00"


def test_valor_excluye_pendientes(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))
    _set_salary(client, emp)
    # OVERTIME sin aprobar.
    client.post(
        f"/api/v1/employees/{emp}/adjustments",
        json={
            "adjustment_date": "2026-08-25",
            "minutes": 60,
            "adjustment_type": "OVERTIME",
            "reason": "pendiente",
        },
    )

    result = client.get("/api/v1/employees/{}/overtime/value?date_from=2026-08-01&date_to=2026-08-31".format(emp)).json()
    # El ajuste PENDING no aparece en el cálculo (ni minutos ni valor).
    assert result["overtime_minutes"] == 0
    assert result["value"] == "0.00"


def test_valor_permisos(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))
    _login(client, "supervisor", "Sup123!")
    assert (
        client.get(f"/api/v1/employees/{emp}/overtime/value?date_from=2026-08-01&date_to=2026-08-31").status_code
        == 403
    )


def test_valor_empleado_inexistente_404(client):
    _login(client, "admin", "Admin123!")
    assert (
        client.get(f"/api/v1/employees/{uuid.uuid4()}/overtime/value?date_from=2026-08-01&date_to=2026-08-31").status_code
        == 404
    )
