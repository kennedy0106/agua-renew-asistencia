"""Regresiones CAL-04: dos quincenas pagables y centavos conciliados."""
from decimal import Decimal


def _login(client):
    assert client.post("/api/v1/auth/login", json={"username": "admin", "password": "Admin123!"}).status_code == 200


def _employee_with_month(client, role):
    employee = client.post("/api/v1/employees", json={
        "dni": "72845632", "employee_code": "PAY-Q-01", "first_name": "Quincena", "last_name": "Prueba", "job_role_id": str(role),
    })
    assert employee.status_code == 201, employee.text
    employee_id = employee.json()["id"]
    assert client.post(f"/api/v1/employees/{employee_id}/salary-settings", json={"effective_from": "2026-08-01", "monthly_salary": "650.01", "overtime_enabled": True}).status_code == 201
    assert client.post(f"/api/v1/employees/{employee_id}/schedule", json={
        "effective_from": "2026-08-01", "monday_minutes": 480, "tuesday_minutes": 480, "wednesday_minutes": 480,
        "thursday_minutes": 480, "friday_minutes": 480,
    }).status_code == 201
    return employee_id


def test_semimonthly_creation_calculation_and_rounding(client, db_session):
    _login(client)
    _employee_with_month(client, db_session._test_job_roles["Operario"])
    q1 = client.post("/api/v1/payroll/periods", json={"year": 2026, "month": 8, "period_kind": "FIRST_HALF"})
    assert q1.status_code == 201, q1.text
    q2 = client.post("/api/v1/payroll/periods", json={"year": 2026, "month": 8, "period_kind": "SECOND_HALF"})
    assert q2.status_code == 201, q2.text
    assert q1.json()["start_date"] == "2026-08-01" and q1.json()["end_date"] == "2026-08-15"
    assert q2.json()["start_date"] == "2026-08-16" and q2.json()["end_date"] == "2026-08-31"
    q1_rows = client.post(f"/api/v1/payroll/periods/{q1.json()['id']}/calculate")
    q2_rows = client.post(f"/api/v1/payroll/periods/{q2.json()['id']}/calculate")
    assert q1_rows.status_code == 200, q1_rows.text
    assert q2_rows.status_code == 200, q2_rows.text
    assert Decimal(str(q1_rows.json()[0]["base_salary"])) == Decimal("325.01")
    assert Decimal(str(q2_rows.json()[0]["base_salary"])) == Decimal("325.00")
    consolidation = client.get("/api/v1/payroll/months/2026/8/consolidation")
    assert consolidation.status_code == 200, consolidation.text
    row = consolidation.json()["employees"][0]
    assert Decimal(str(row["base_amount"])) == Decimal("650.01")
    assert len(row["period_ids"]) == 2
    csv = client.get("/api/v1/exports/salaries-month.csv?year=2026&month=8")
    assert csv.status_code == 200
    assert "Descanso/Feriado" in csv.content.decode("utf-8-sig")


def test_semimonthly_rejects_salary_history_that_requires_review(client, db_session):
    _login(client)
    employee_id = _employee_with_month(client, db_session._test_job_roles["Operario"])
    changed = client.post(f"/api/v1/employees/{employee_id}/salary-settings", json={"effective_from": "2026-08-16", "monthly_salary": "700.00", "overtime_enabled": True})
    assert changed.status_code == 201, changed.text
    q1 = client.post("/api/v1/payroll/periods", json={"year": 2026, "month": 8, "period_kind": "FIRST_HALF"})
    assert q1.status_code == 201, q1.text
    calculate = client.post(f"/api/v1/payroll/periods/{q1.json()['id']}/calculate")
    assert calculate.status_code == 409
    assert "BASE_ALLOCATION_REVIEW_REQUIRED" in calculate.text
