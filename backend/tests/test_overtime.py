"""Tests de horas extra por tramos diarios (seccion_horas_extra.md)."""

import uuid
from datetime import date, datetime, timedelta

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
    today = _today_lima()
    check_in = datetime(today.year, today.month, today.day, start_hour, 0, tzinfo=lima_tz()).astimezone(
        datetime.now().astimezone().tzinfo  # type: ignore[arg-type]
    )
    local_check_in = check_in.replace(tzinfo=None).isoformat()
    local_check_out = datetime(today.year, today.month, today.day, end_hour, 0).isoformat()
    response = client.patch(
        f"/api/v1/attendance/{record_id}",
        json={"check_in_at": local_check_in, "check_out_at": local_check_out, "reason": "Fijar horario de prueba"},
    )
    assert response.status_code == 200, response.text
    return response.json()


def _create_full_record(client, employee_id: str, start_hour: int, end_hour: int) -> str:
    check_in = client.post("/api/v1/attendance/check-in", json={"employee_id": employee_id}).json()
    client.post("/api/v1/attendance/check-out", json={"employee_id": employee_id})
    return _set_record_times(client, check_in["id"], start_hour, end_hour)


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
    }
    payload.update(overrides)
    response = client.post(f"/api/v1/employees/{employee_id}/salary-settings", json=payload)
    assert response.status_code == 201, response.text
    response = client.post(
        f"/api/v1/employees/{employee_id}/schedule",
        json={
            "effective_from": "2026-08-01",
            "monday_minutes": 480,
            "tuesday_minutes": 480,
            "wednesday_minutes": 480,
            "thursday_minutes": 480,
            "friday_minutes": 480,
            "break_minutes": 60,
            "break_applies_after_minutes": 360,
        },
    )
    assert response.status_code == 201, response.text


def _set_policy(client, first: str = "25.00", additional: str = "35.00", effective_from: str = "2026-08-01"):
    response = client.post(
        "/api/v1/overtime-policy",
        json={
            "effective_from": effective_from,
            "first_two_hours_rate": first,
            "additional_hours_rate": additional,
            "reason": "Política de prueba",
        },
    )
    assert response.status_code == 201, response.text


def _create_and_approve_overtime(client, employee_id: str, minutes: int, day: str = "2026-08-25") -> str:
    response = client.post(
        f"/api/v1/employees/{employee_id}/adjustments",
        json={
            "adjustment_date": day,
            "minutes": minutes,
            "adjustment_type": "OVERTIME",
            "reason": f"Horas extra del {day}",
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
    detected = client.get(f"/api/v1/employees/{emp}/overtime/detect?date_from={today}&date_to={today}").json()
    assert len(detected) == 1
    assert detected[0]["worked_minutes"] == 600
    assert detected[0]["expected_minutes"] == 480
    assert detected[0]["extra_minutes"] == 120


def test_detect_permisos(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))
    _login(client, "supervisor", "Sup123!")
    today = _today_lima().isoformat()
    assert client.get(f"/api/v1/employees/{emp}/overtime/detect?date_from={today}&date_to={today}").status_code == 403


# --- Valor por tramos (política general por defecto) ---

def test_valor_primer_tramo_usa_25(client, db_session):
    """60 min (primer tramo) → 25% recargo con política general."""
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))
    _set_policy(client)  # 25/35
    _set_salary(client, emp)
    _create_and_approve_overtime(client, emp, minutes=60)

    result = client.get(f"/api/v1/employees/{emp}/overtime/value?date_from=2026-08-01&date_to=2026-08-31").json()
    assert result["overtime_minutes"] == 60
    # Agosto 2026 tiene 21 días L-V: 168 horas esperadas.
    assert result["breakdown"][0]["hourly_rate"] == "8.9286"
    assert result["breakdown"][0]["first_two_minutes"] == 60
    assert result["breakdown"][0]["additional_minutes"] == 0
    # 60 min × (6.25/60 × 1.25) = 7.8125 → 7.81
    assert result["value"] == "11.16"


def test_valor_tercer_tramo_usa_35(client, db_session):
    """180 min = 120 al 25% + 60 al 35%."""
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))
    _set_policy(client)  # 25/35
    _set_salary(client, emp)
    _create_and_approve_overtime(client, emp, minutes=180)

    result = client.get(f"/api/v1/employees/{emp}/overtime/value?date_from=2026-08-01&date_to=2026-08-31").json()
    b = result["breakdown"][0]
    assert b["first_two_minutes"] == 120
    assert b["additional_minutes"] == 60
    assert b["first_two_hours_rate"] == "25.00"
    assert b["additional_hours_rate"] == "35.00"
    # tarifa/min = 6.25/60 = 0.1041667
    # primer tramo: 120 × 0.1041667 × 1.25 = 15.625 → 15.63
    # adicional:    60 × 0.1041667 × 1.35 = 8.4375  → 8.44
    # total = 24.07
    assert result["value"] == "34.37"


def test_contador_se_reinicia_por_dia(client, db_session):
    """2 días con 90 min cada uno → ambos son 'primer tramo' (no acumula)."""
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))
    _set_policy(client)
    _set_salary(client, emp)
    _create_and_approve_overtime(client, emp, minutes=90, day="2026-08-24")
    _create_and_approve_overtime(client, emp, minutes=90, day="2026-08-25")

    result = client.get(f"/api/v1/employees/{emp}/overtime/value?date_from=2026-08-01&date_to=2026-08-31").json()
    assert len(result["breakdown"]) == 2
    for b in result["breakdown"]:
        assert b["first_two_minutes"] == 90
        assert b["additional_minutes"] == 0
    # cada día: 90 × 0.1041667 × 1.25 = 11.71875 → 11.72; total 23.44
    assert result["value"] == "33.48"


def test_valor_con_override_empleado(client, db_session):
    """Override 50/60 en vez de política 25/35."""
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))
    _set_policy(client)  # 25/35 general
    _set_salary(
        client,
        emp,
        use_custom_overtime_rates=True,
        custom_first_two_hours_rate="50.00",
        custom_additional_hours_rate="60.00",
    )
    _create_and_approve_overtime(client, emp, minutes=60)

    result = client.get(f"/api/v1/employees/{emp}/overtime/value?date_from=2026-08-01&date_to=2026-08-31").json()
    b = result["breakdown"][0]
    assert b["source"] == "employee_override"
    assert b["first_two_hours_rate"] == "50.00"
    # 60 × (6.25/60 × 1.50) = 9.375 → 9.38
    assert result["value"] == "13.39"


def test_valor_sin_politica_usa_minimos_legales(client, db_session):
    """Sin política general ni override → mínimos 25/35."""
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))
    _set_salary(client, emp)  # sin override, sin política
    _create_and_approve_overtime(client, emp, minutes=60)

    result = client.get(f"/api/v1/employees/{emp}/overtime/value?date_from=2026-08-01&date_to=2026-08-31").json()
    b = result["breakdown"][0]
    assert b["source"] == "company_policy"
    assert b["first_two_hours_rate"] == "25.00"
    assert b["additional_hours_rate"] == "35.00"


def test_valor_con_horas_extra_deshabilitadas_es_cero(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))
    _set_policy(client)
    _set_salary(client, emp, overtime_enabled=False)
    _create_and_approve_overtime(client, emp, minutes=60)

    result = client.get(f"/api/v1/employees/{emp}/overtime/value?date_from=2026-08-01&date_to=2026-08-31").json()
    assert result["value"] == "0.00"
    assert result["overtime_minutes"] == 60
    assert result["breakdown"][0]["minutes"] == 60
    assert result["breakdown"][0]["skip_reason"] == "DISABLED"


def test_valor_excluye_pendientes(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))
    _set_policy(client)
    _set_salary(client, emp)
    client.post(
        f"/api/v1/employees/{emp}/adjustments",
        json={"adjustment_date": "2026-08-25", "minutes": 60, "adjustment_type": "OVERTIME", "reason": "pendiente"},
    )

    result = client.get(f"/api/v1/employees/{emp}/overtime/value?date_from=2026-08-01&date_to=2026-08-31").json()
    assert result["overtime_minutes"] == 0
    assert result["value"] == "0.00"


def test_valor_permisos(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))
    _login(client, "supervisor", "Sup123!")
    assert client.get(f"/api/v1/employees/{emp}/overtime/value?date_from=2026-08-01&date_to=2026-08-31").status_code == 403


def test_valor_empleado_inexistente_404(client):
    _login(client, "admin", "Admin123!")
    assert client.get(f"/api/v1/employees/{uuid.uuid4()}/overtime/value?date_from=2026-08-01&date_to=2026-08-31").status_code == 404


# --- Política general (rutas) ---

def test_policy_bajo_minimo_rechazado(client, db_session):
    _login(client, "admin", "Admin123!")
    response = client.post(
        "/api/v1/overtime-policy",
        json={"effective_from": "2026-08-01", "first_two_hours_rate": "20.00", "additional_hours_rate": "35.00", "reason": "invalida"},
    )
    assert response.status_code == 422


def test_policy_additional_bajo_minimo_rechazado(client, db_session):
    _login(client, "admin", "Admin123!")
    response = client.post(
        "/api/v1/overtime-policy",
        json={"effective_from": "2026-08-01", "first_two_hours_rate": "25.00", "additional_hours_rate": "30.00", "reason": "invalida"},
    )
    assert response.status_code == 422


def test_policy_valida_y_historica(client, db_session):
    _login(client, "admin", "Admin123!")
    _set_policy(client, "25.00", "35.00", "2026-08-01")
    _set_policy(client, "50.00", "50.00", "2026-09-01")

    history = client.get("/api/v1/overtime-policy/history").json()
    assert len(history) == 2
    by_from = {h["effective_from"]: h for h in history}
    assert by_from["2026-08-01"]["first_two_hours_rate"] == "25.00"
    assert by_from["2026-08-01"]["effective_to"] == "2026-08-31"
    assert by_from["2026-09-01"]["first_two_hours_rate"] == "50.00"
    assert by_from["2026-09-01"]["effective_to"] is None


def test_policy_solapamiento_conflict(client, db_session):
    _login(client, "admin", "Admin123!")
    _set_policy(client, "25.00", "35.00", "2026-09-01")
    response = client.post(
        "/api/v1/overtime-policy",
        json={"effective_from": "2026-08-15", "first_two_hours_rate": "30.00", "additional_hours_rate": "40.00", "reason": "solape"},
    )
    assert response.status_code == 409


def test_policy_permisos_supervisor_forbidden(client, db_session):
    _login(client, "admin", "Admin123!")
    _login(client, "supervisor", "Sup123!")
    assert client.get("/api/v1/overtime-policy").status_code == 403
    assert (
        client.post(
            "/api/v1/overtime-policy",
            json={"effective_from": "2026-08-01", "first_two_hours_rate": "25.00", "additional_hours_rate": "35.00", "reason": "no autorizado"},
        ).status_code
        == 403
    )


def test_policy_auditada(client, db_session):
    _login(client, "admin", "Admin123!")
    _set_policy(client, "25.00", "35.00", "2026-08-01")
    # La auditoría quedó registrada con acción UPDATE_OVERTIME_POLICY.
    from app.modules.audit.repository import AuditRepository

    logs = AuditRepository(db_session).list_logs(entity_type="overtime_policy")
    assert len(logs) == 1
    assert logs[0].action == "UPDATE_OVERTIME_POLICY"
