"""Tests del motor de payroll: periodos, cálculo, ajuste manual y cierre."""

import csv as csv_module
import io
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


def _parse_salary_csv(client, period_id: str, include_excluded: bool = False) -> list[list[str]]:
    suffix = "&include_excluded=true" if include_excluded else ""
    response = client.get(f"/api/v1/exports/salaries.csv?period_id={period_id}{suffix}")
    assert response.status_code == 200, response.text
    return list(csv_module.reader(io.StringIO(response.content.decode("utf-8-sig"))))


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
    assert record["overtime_amount"] == "7.81"
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


def test_recalcular_conserva_ajuste_manual(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))
    _set_salary(client, emp)
    period = _create_period(client)
    record = client.post(f"/api/v1/payroll/periods/{period['id']}/calculate").json()[0]
    client.patch(
        f"/api/v1/payroll/records/{record['id']}/adjustment",
        json={"amount": "50.00", "notes": "Movilidad aprobada"},
    )

    recalculated = client.post(f"/api/v1/payroll/periods/{period['id']}/calculate").json()[0]
    assert recalculated["id"] == record["id"]
    assert recalculated["manual_adjustment"] == "50.00"
    assert recalculated["notes"] == "Movilidad aprobada"
    assert recalculated["total"] == "1550.00"


def test_prorratea_alta_y_cambios_de_sueldo(client, db_session):
    _login(client, "admin", "Admin123!")
    response = client.post(
        "/api/v1/employees",
        json={
            "dni": "72845632",
            "employee_code": "EMP-001",
            "first_name": "Juan",
            "last_name": "Pérez",
            "job_role_id": str(db_session._test_job_roles["Operario"]),
            "hire_date": "2026-08-16",
        },
    )
    emp = response.json()["id"]
    _set_salary(client, emp, monthly_salary="1550.00")
    client.post(
        f"/api/v1/employees/{emp}/salary-settings",
        json={"effective_from": "2026-08-24", "monthly_salary": "3100.00", "overtime_enabled": False},
    )
    period = _create_period(client)

    record = client.post(f"/api/v1/payroll/periods/{period['id']}/calculate").json()[0]
    # 8 días a 1550/31 + 8 días a 3100/31, alta inclusiva del 16 al 31.
    assert record["base_salary"] == "1200.00"


def test_readiness_bloquea_pendientes_y_rectifica_version(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))
    _set_salary(client, emp)
    pending = client.post(
        f"/api/v1/employees/{emp}/adjustments",
        json={"adjustment_date": "2026-08-25", "minutes": 30, "adjustment_type": "OTRO", "reason": "Revisión pendiente"},
    ).json()
    period = _create_period(client)
    client.post(f"/api/v1/payroll/periods/{period['id']}/calculate")

    readiness = client.get(f"/api/v1/payroll/periods/{period['id']}/readiness").json()
    assert readiness["ready"] is False
    assert any(issue["code"] == "PENDING_ADJUSTMENT" for issue in readiness["blockers"])
    assert client.post(f"/api/v1/payroll/periods/{period['id']}/confirm").status_code == 409

    client.patch(f"/api/v1/adjustments/{pending['id']}/reject", json={"reason": "No corresponde"})
    assert client.post(f"/api/v1/payroll/periods/{period['id']}/confirm").status_code == 200
    rectified = client.post(
        f"/api/v1/payroll/periods/{period['id']}/rectifications",
        json={"reason": "Corrección posterior de asistencia"},
    )
    assert rectified.status_code == 201
    assert rectified.json()["version"] == 2
    assert rectified.json()["supersedes_period_id"] == period["id"]


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


# --- Resumen (Fase 12) ---

def test_summary_totales_del_periodo(client, db_session):
    _login(client, "admin", "Admin123!")
    emp1 = _create_employee(client, str(db_session._test_job_roles["Operario"]), "72845632", "EMP-001")
    emp2 = _create_employee(client, str(db_session._test_job_roles["Chofer"]), "71112233", "EMP-002")
    _set_salary(client, emp1, monthly_salary="1500.00")
    _set_salary(client, emp2, monthly_salary="1100.00")
    _add_approved_overtime(client, emp1, minutes=60)  # 1er tramo → 7.81
    _add_approved_overtime(client, emp2, minutes=30)  # 1er tramo → 2.86

    period = _create_period(client)
    client.post(f"/api/v1/payroll/periods/{period['id']}/calculate")
    records = client.get(f"/api/v1/payroll/periods/{period['id']}/records").json()
    client.patch(
        f"/api/v1/payroll/records/{records[0]['id']}/adjustment",
        json={"amount": "50.00", "notes": "viáticos"},
    )

    summary = client.get(f"/api/v1/payroll/periods/{period['id']}/summary").json()
    assert summary["employee_count"] == 2
    assert summary["total_base"] == "2600.00"  # 1500 + 1100
    assert summary["total_overtime"] == "10.67"
    assert summary["total_manual"] == "50.00"
    assert summary["total"] == "2660.67"


def test_summary_supervisor_forbidden(client, db_session):
    _login(client, "admin", "Admin123!")
    period = _create_period(client)
    _login(client, "supervisor", "Sup123!")
    assert client.get(f"/api/v1/payroll/periods/{period['id']}/summary").status_code == 403


def test_summary_periodo_inexistente_404(client):
    _login(client, "admin", "Admin123!")
    assert client.get(f"/api/v1/payroll/periods/{uuid.uuid4()}/summary").status_code == 404


def test_esperado_acotado_a_alta(client, db_session):
    _login(client, "admin", "Admin123!")
    role = str(db_session._test_job_roles["Operario"])
    full = _create_employee(client, role, dni="11111111", code="EMP-FULL")
    late = client.post(
        "/api/v1/employees",
        json={
            "dni": "22222222",
            "employee_code": "EMP-LATE",
            "first_name": "Ana",
            "last_name": "López",
            "job_role_id": role,
            "hire_date": "2026-08-31",
        },
    ).json()["id"]
    _set_salary(client, full)
    _set_salary(client, late)
    period = _create_period(client)
    records = {r["employee_id"]: r for r in client.post(f"/api/v1/payroll/periods/{period['id']}/calculate").json()}
    assert records[late]["expected_minutes"] == 480
    assert records[full]["expected_minutes"] > records[late]["expected_minutes"]


def test_snapshot_registra_dias_sin_sueldo(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))
    _set_salary(client, emp, effective_from="2026-08-16")
    period = _create_period(client)
    record = client.post(f"/api/v1/payroll/periods/{period['id']}/calculate").json()[0]
    assert record["missing_salary_days"] == 15
    readiness = client.get(f"/api/v1/payroll/periods/{period['id']}/readiness").json()
    assert any(issue["code"] == "MISSING_SALARY" for issue in readiness["blockers"])


def test_recalcular_conserva_bono_de_empleado_inelegible(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))
    _set_salary(client, emp)
    period = _create_period(client)
    record = client.post(f"/api/v1/payroll/periods/{period['id']}/calculate").json()[0]
    client.patch(
        f"/api/v1/payroll/records/{record['id']}/adjustment",
        json={"amount": "50.00", "notes": "Bono que no debe perderse"},
    )
    patched = client.patch(f"/api/v1/employees/{emp}", json={"termination_date": "2026-07-31"})
    assert patched.status_code == 200
    recalculated = client.post(f"/api/v1/payroll/periods/{period['id']}/calculate").json()
    leftover = next(r for r in recalculated if r["employee_id"] == emp)
    assert leftover["manual_adjustment"] == "50.00"
    assert leftover["payable"] is False
    assert leftover["status"] == "EXCLUDED"
    summary = client.get(f"/api/v1/payroll/periods/{period['id']}/summary").json()
    assert summary["employee_count"] == 0
    assert summary["total_manual"] == "0.00"
    listed = client.get(f"/api/v1/payroll/periods/{period['id']}/records").json()
    assert any(item["payable"] is False for item in listed)
    csv_rows = _parse_salary_csv(client, period["id"])
    pagable_rows = [row for row in csv_rows[1:] if row[13] == "PAGABLE"]
    assert pagable_rows == []
    assert csv_rows[-1][12] == "0.00"

    revived = client.post(f"/api/v1/employees/{emp}/deactivate")
    assert revived.status_code == 200
    revived = client.post(f"/api/v1/employees/{emp}/activate")
    assert revived.status_code == 200
    recalculated = client.post(f"/api/v1/payroll/periods/{period['id']}/calculate").json()
    payable = [item for item in recalculated if item["employee_id"] == emp and item["payable"]]
    assert len(payable) == 1
    assert payable[0]["manual_adjustment"] == "50.00"
    summary = client.get(f"/api/v1/payroll/periods/{period['id']}/summary").json()
    assert summary["employee_count"] == 1
    assert summary["total_manual"] == "50.00"


def test_confirmar_exige_recalculo_si_cambia_he(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))
    _set_salary(client, emp)
    period = _create_period(client)
    client.post(f"/api/v1/payroll/periods/{period['id']}/calculate")
    _add_approved_overtime(client, emp, minutes=60)
    stale = client.post(f"/api/v1/payroll/periods/{period['id']}/confirm")
    assert stale.status_code == 409
    client.post(f"/api/v1/payroll/periods/{period['id']}/calculate")
    assert client.post(f"/api/v1/payroll/periods/{period['id']}/confirm").status_code == 200


def test_he_aprobada_sin_pago_bloquea_cierre(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))
    _set_salary(client, emp, overtime_enabled=False)
    _add_approved_overtime(client, emp, minutes=60)
    period = _create_period(client)
    client.post(f"/api/v1/payroll/periods/{period['id']}/calculate")
    readiness = client.get(f"/api/v1/payroll/periods/{period['id']}/readiness").json()
    assert any(issue["code"] == "UNVALUED_OVERTIME" for issue in readiness["blockers"])
    assert client.post(f"/api/v1/payroll/periods/{period['id']}/confirm").status_code == 409


def test_rectificacion_copia_ajuste_manual(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))
    _set_salary(client, emp)
    period = _create_period(client)
    record = client.post(f"/api/v1/payroll/periods/{period['id']}/calculate").json()[0]
    client.patch(
        f"/api/v1/payroll/records/{record['id']}/adjustment",
        json={"amount": "50.00", "notes": "Viáticos originales"},
    )
    assert client.post(f"/api/v1/payroll/periods/{period['id']}/confirm").status_code == 200
    rectified = client.post(
        f"/api/v1/payroll/periods/{period['id']}/rectifications",
        json={"reason": "Reabrir por corrección de asistencia"},
    ).json()
    copied = client.post(f"/api/v1/payroll/periods/{rectified['id']}/calculate").json()[0]
    assert copied["manual_adjustment"] == "50.00"
    assert copied["notes"] == "Viáticos originales"


def test_motivo_solo_espacios_es_rechazado(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))
    _set_salary(client, emp)
    period = _create_period(client)
    record = client.post(f"/api/v1/payroll/periods/{period['id']}/calculate").json()[0]
    response = client.patch(
        f"/api/v1/payroll/records/{record['id']}/adjustment",
        json={"amount": "10.00", "notes": "   "},
    )
    assert response.status_code == 422

