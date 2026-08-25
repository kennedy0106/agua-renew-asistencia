"""Fase 17 — Estabilización: escenarios A–I del plan.

Cada escenario es un flujo completo por la API (TestClient + SQLite):
marcación → saldo → ajustes → payroll, verificando la matemática exacta.
"""

import uuid
from datetime import datetime, timedelta

from app.core.timezone import lima_tz


def _login(client, username: str, password: str) -> None:
    response = client.post("/api/v1/auth/login", json={"username": username, "password": password})
    assert response.status_code == 200, response.text


def _today_lima():
    return datetime.now(lima_tz()).date()


def _create_employee(client, db_session, dni="72845632", code="EMP-001", name="Juan", last="Pérez") -> str:
    response = client.post(
        "/api/v1/employees",
        json={
            "dni": dni,
            "employee_code": code,
            "first_name": name,
            "last_name": last,
            "job_role_id": str(db_session._test_job_roles["Operario"]),
        },
    )
    assert response.status_code == 201, response.text
    return response.json()["id"]


def _set_schedule(client, employee_id: str, start: str, minutes=480, break_minutes=60, **overrides):
    payload = {
        "effective_from": start,
        "monday_minutes": minutes,
        "tuesday_minutes": minutes,
        "wednesday_minutes": minutes,
        "thursday_minutes": minutes,
        "friday_minutes": minutes,
        "saturday_minutes": minutes,
        "sunday_minutes": 0,
        "break_minutes": break_minutes,
    }
    payload.update(overrides)
    response = client.post(f"/api/v1/employees/{employee_id}/schedule", json=payload)
    assert response.status_code == 201, response.text


def _set_salary(client, employee_id: str, amount: str, effective_from: str, **overrides):
    payload = {
        "effective_from": effective_from,
        "monthly_salary": amount,
        "overtime_enabled": True,
        "overtime_method": "PERCENTAGE",
        "overtime_percentage": "25.00",
        "overtime_fixed_rate": None,
    }
    payload.update(overrides)
    response = client.post(f"/api/v1/employees/{employee_id}/salary-settings", json=payload)
    assert response.status_code == 201, response.text


def _set_exact_times(client, record_id: str, start_hour: int, start_min: int, end_hour: int, end_min: int):
    """Corrige un registro a horas exactas de HOY (Lima) y devuelve worked_minutes."""
    today = _today_lima()
    response = client.patch(
        f"/api/v1/attendance/{record_id}",
        json={
            "check_in_at": datetime(today.year, today.month, today.day, start_hour, start_min).isoformat(),
            "check_out_at": datetime(today.year, today.month, today.day, end_hour, end_min).isoformat(),
            "reason": "Fijar horario del escenario",
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


def _full_day(client, employee_id: str, start_hour: int, start_min: int, end_hour: int, end_min: int) -> dict:
    check_in = client.post("/api/v1/attendance/check-in", json={"employee_id": employee_id}).json()
    client.post("/api/v1/attendance/check-out", json={"employee_id": employee_id})
    return _set_exact_times(client, check_in["id"], start_hour, start_min, end_hour, end_min)


def _add_adjustment(client, employee_id: str, minutes: int, adjustment_type: str, day: str) -> str:
    response = client.post(
        f"/api/v1/employees/{employee_id}/adjustments",
        json={
            "adjustment_date": day,
            "minutes": minutes,
            "adjustment_type": adjustment_type,
            "reason": f"Ajuste {adjustment_type} de prueba",
        },
    )
    assert response.status_code == 201, response.text
    return response.json()["id"]


def _balance(client, employee_id: str, date_from: str, date_to: str) -> dict:
    response = client.get(
        f"/api/v1/employees/{employee_id}/balance?date_from={date_from}&date_to={date_to}"
    )
    assert response.status_code == 200, response.text
    return response.json()


# --- Escenario A: jornada normal → saldo 0, payroll = sueldo ---

def test_escenario_a_jornada_normal(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, db_session)
    _set_schedule(client, emp, "2026-08-01", break_minutes=60)
    _set_salary(client, emp, "1500.00", "2026-08-01")
    today = _today_lima()

    record = _full_day(client, emp, 8, 0, 17, 0)  # 540 min − 60 break = 480
    assert record["worked_minutes"] == 480

    balance = _balance(client, emp, today.isoformat(), today.isoformat())
    assert balance["worked_minutes"] == 480
    assert balance["expected_minutes"] == 480
    assert balance["balance_minutes"] == 0

    period = client.post(
        "/api/v1/payroll/periods",
        json={"name": "Agosto A", "start_date": "2026-08-01", "end_date": "2026-08-31"},
    ).json()
    record_payroll = client.post(f"/api/v1/payroll/periods/{period['id']}/calculate").json()[0]
    assert record_payroll["worked_minutes"] == 480
    assert record_payroll["total"] == "1500.00"


# --- Escenario B: llega tarde → saldo negativo, sin descuento automático ---

def test_escenario_b_llega_tarde(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, db_session)
    _set_schedule(client, emp, "2026-08-01", break_minutes=60)
    today = _today_lima()

    record = _full_day(client, emp, 8, 30, 17, 0)  # 510 − 60 = 450 < 480
    assert record["worked_minutes"] == 450

    balance = _balance(client, emp, today.isoformat(), today.isoformat())
    assert balance["balance_minutes"] == -30  # deuda de horas, no dinero


# --- Escenario C: sale antes → saldo negativo ---

def test_escenario_c_sale_antes(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, db_session)
    _set_schedule(client, emp, "2026-08-01", break_minutes=60)
    today = _today_lima()

    record = _full_day(client, emp, 8, 0, 16, 30)  # 510 − 60 = 450
    assert record["worked_minutes"] == 450

    balance = _balance(client, emp, today.isoformat(), today.isoformat())
    assert balance["balance_minutes"] == -30


# --- Escenario D: permiso + recuperación otro día ---

def test_escenario_d_permiso_y_recuperacion(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, db_session)
    _set_schedule(client, emp, "2026-08-01", break_minutes=60)
    today = _today_lima()

    # Hoy (día laborable): pidió permiso sin marcar. Jefe aprueba PERMISO +480.
    permiso = _add_adjustment(client, emp, 480, "PERMISO", today.isoformat())
    client.patch(f"/api/v1/adjustments/{permiso}/approve")
    balance_permiso = _balance(client, emp, today.isoformat(), today.isoformat())
    assert balance_permiso["worked_minutes"] == 0
    assert balance_permiso["expected_minutes"] == 480
    assert balance_permiso["balance_minutes"] == 0  # 0 − 480 + 480: el día queda cubierto

    # El domingo (no laborable) recupera: el jefe registra RECUPERACION +480 aprobada.
    sunday = today + timedelta(days=(6 - today.weekday()))
    recuperacion = _add_adjustment(client, emp, 480, "RECUPERACION", sunday.isoformat())
    client.patch(f"/api/v1/adjustments/{recuperacion}/approve")
    balance_rec = _balance(client, emp, sunday.isoformat(), sunday.isoformat())
    assert balance_rec["expected_minutes"] == 0  # domingo no laborable
    assert balance_rec["balance_minutes"] == 480  # horas recuperadas para el saldo


# --- Escenario E: horas adicionales detectadas ---

def test_escenario_e_horas_adicionales(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, db_session)
    _set_schedule(client, emp, "2026-08-01", break_minutes=60)
    today = _today_lima()

    _full_day(client, emp, 8, 0, 18, 0)  # 600 − 60 = 540 → extra 60

    detected = client.get(
        f"/api/v1/employees/{emp}/overtime/detect?date_from={today.isoformat()}&date_to={today.isoformat()}"
    ).json()
    assert len(detected) == 1
    assert detected[0]["extra_minutes"] == 60


# --- Escenario F: jefe aprueba SOLO parte como hora extra ---

def test_escenario_f_aprueba_parte_como_hora_extra(client, db_session):
    _login(client, "boss", "Boss123!")  # el jefe clasifica y aprueba
    emp = _create_employee(client, db_session)
    _set_schedule(client, emp, "2026-08-01", break_minutes=60)
    _set_salary(client, emp, "1500.00", "2026-08-01")

    approved = _add_adjustment(client, emp, 60, "OVERTIME", "2026-08-25")
    rejected = _add_adjustment(client, emp, 60, "OVERTIME", "2026-08-26")
    client.patch(f"/api/v1/adjustments/{approved}/approve")
    client.patch(f"/api/v1/adjustments/{rejected}/reject", json={"reason": "No corresponde"})

    period = client.post(
        "/api/v1/payroll/periods",
        json={"name": "Agosto F", "start_date": "2026-08-01", "end_date": "2026-08-31"},
    ).json()
    record = client.post(f"/api/v1/payroll/periods/{period['id']}/calculate").json()[0]
    assert record["overtime_minutes"] == 60  # solo la aprobada
    # Agosto 2026: 26 días L-S × 480 = 12480 min → tarifa 1500×60/12480 = 7.2115
    # → 60 min × (7.2115/60 × 1.25) = 9.01
    assert record["overtime_amount"] == "9.01"
    assert record["total"] == "1509.01"


# --- Escenario G: olvida marcar salida → jefe corrige con motivo ---

def test_escenario_g_olvida_marcar_salida(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, db_session)
    _set_schedule(client, emp, "2026-08-01", break_minutes=60)

    check_in = client.post("/api/v1/attendance/check-in", json={"employee_id": emp}).json()
    assert check_in["status"] == "OPEN"  # sin salida

    # El jefe corrige SOLO la salida (9 h después de la entrada real) con motivo.
    from datetime import datetime as _dt

    check_in_time = _dt.fromisoformat(check_in["check_in_at"])
    response = client.patch(
        f"/api/v1/attendance/{check_in['id']}",
        json={
            "check_out_at": (check_in_time + timedelta(hours=9)).isoformat(),
            "reason": "Olvidó marcar salida",
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "COMPLETE"
    assert body["worked_minutes"] == 480  # 9 h − 60 min de refrigerio

    logs = client.get("/api/v1/audit-logs").json()
    assert any(
        log["entity_type"] == "attendance"
        and log["action"] == "correction"
        and log["reason"] == "Olvidó marcar salida"
        for log in logs
    )


# --- Escenario H: cambio de sueldo en mes posterior (vigencia histórica) ---

def test_escenario_h_cambio_de_sueldo(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, db_session)
    _set_salary(client, emp, "1300.00", "2026-08-01")
    _set_salary(client, emp, "1500.00", "2026-09-01")  # sube el mes siguiente

    agosto = client.post(
        "/api/v1/payroll/periods",
        json={"name": "Agosto H", "start_date": "2026-08-01", "end_date": "2026-08-31"},
    ).json()
    septiembre = client.post(
        "/api/v1/payroll/periods",
        json={"name": "Septiembre H", "start_date": "2026-09-01", "end_date": "2026-09-30"},
    ).json()

    ag_record = client.post(f"/api/v1/payroll/periods/{agosto['id']}/calculate").json()[0]
    sep_record = client.post(f"/api/v1/payroll/periods/{septiembre['id']}/calculate").json()[0]
    assert ag_record["base_salary"] == "1300.00"
    assert sep_record["base_salary"] == "1500.00"


# --- Escenario I: supervisor intenta consultar salario → rechazado ---

def test_escenario_i_supervisor_bloqueado_de_salarios(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, db_session)
    _set_salary(client, emp, "1500.00", "2026-08-01")
    _login(client, "supervisor", "Sup123!")

    assert client.get(f"/api/v1/employees/{emp}/salary-settings").status_code == 403
    assert client.get("/api/v1/payroll/periods").status_code == 403
    assert (
        client.get(f"/api/v1/employees/{emp}/overtime/value?date_from=2026-08-01&date_to=2026-08-31").status_code
        == 403
    )
    assert client.get(f"/api/v1/employees/{emp}/salary-settings/history").status_code == 403
