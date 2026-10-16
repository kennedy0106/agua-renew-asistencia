"""Presupuesto de consultas de planilla (S2/S3) con resultados intactos.

Los fan-outs corregidos son per-empleado/día: readiness (sueldo y jornada),
minutos esperados, prorrateo salarial, reporte diario (jornada, sueldo y
crédito de recuperación) e insumos de snapshot de recuperación (componentes y
aplicaciones).  Estos tests fijan que:

- el número de SELECT no crece con los días del tramo ni con la cantidad de
  compromisos de recuperación;
- la respuesta pública es idéntica a la referencia escalar (paridad);
- el fingerprint del snapshot sigue detectando cambios en los insumos de
  recuperación y no se invalida sin cambios.

Solo SQLite en memoria; nunca se registran parámetros SQL ni secretos.
"""

import uuid
from datetime import date, datetime, timezone

from sqlalchemy import event, select

from app.modules.attendance.manual_models import (
    ManualAttendanceDay,
    ManualRecoveryApplication,
    RecoveryCommitment,
)
from app.modules.attendance.models import AttendanceRecord
from app.modules.payroll import service as payroll_service
from app.modules.salary.service import SalaryService
from app.modules.schedules.service import ScheduleService
from app.modules.users.models import User

_AUGUST = (2026, 8)
_SEPTEMBER = (2026, 9)
_BEFORE_PERIOD = date(2026, 7, 31)
_STAMP = datetime(2026, 8, 3, 12, tzinfo=timezone.utc)


# --- Infraestructura de fixtures públicas ---


def _login(client) -> None:
    response = client.post("/api/v1/auth/login", json={"username": "admin", "password": "Admin123!"})
    assert response.status_code == 200, response.text


def _admin_id(db_session) -> uuid.UUID:
    admin_id = db_session.scalar(select(User.id).where(User.username == "admin"))
    assert admin_id is not None
    return admin_id


def _employee(client, db_session, *, dni: str, code: str, hire_date: str = "2026-08-01") -> str:
    response = client.post(
        "/api/v1/employees",
        json={
            "dni": dni,
            "employee_code": code,
            "first_name": "Budget",
            "last_name": "Fixture",
            "job_role_id": str(db_session._test_job_roles["Operario"]),
            "hire_date": hire_date,
        },
    )
    assert response.status_code == 201, response.text
    return response.json()["id"]


def _configure(
    client,
    employee_id: str,
    *,
    effective_from: str = "2026-08-01",
    monthly_salary: str = "1500.00",
    schedule: dict | None = None,
) -> None:
    response = client.post(
        f"/api/v1/employees/{employee_id}/salary-settings",
        json={"effective_from": effective_from, "monthly_salary": monthly_salary, "overtime_enabled": True},
    )
    assert response.status_code == 201, response.text
    response = client.post(
        f"/api/v1/employees/{employee_id}/schedule",
        json={
            "effective_from": effective_from,
            "monday_minutes": 480,
            "tuesday_minutes": 480,
            "wednesday_minutes": 480,
            "thursday_minutes": 480,
            "friday_minutes": 480,
            "saturday_minutes": 240,
            "sunday_minutes": 0,
            "break_minutes": 60,
            "break_applies_after_minutes": 360,
            **(schedule or {}),
        },
    )
    assert response.status_code == 201, response.text


def _period(client, year: int, month: int) -> dict:
    response = client.post("/api/v1/payroll/periods", json={"year": year, "month": month})
    assert response.status_code == 201, response.text
    return response.json()


def _freeze_report_day(monkeypatch, moment: date = _BEFORE_PERIOD) -> None:
    """Ninguna jornada del periodo es pasada: readiness no agrega bloqueos por fecha."""
    monkeypatch.setattr(payroll_service, "_report_today", lambda: moment)


def _measure(db_session, call):
    """Ejecuta ``call`` y devuelve (respuesta, SELECT, DML) sin registrar parámetros."""
    statements: list[str] = []

    def listener(conn, cursor, statement, parameters, context, executemany):
        statements.append(statement)

    db_session.expire_all()
    event.listen(db_session.bind, "before_cursor_execute", listener)
    try:
        response = call()
    finally:
        event.remove(db_session.bind, "before_cursor_execute", listener)
    selects = [statement for statement in statements if statement.lstrip().upper().startswith("SELECT")]
    dml = [statement for statement in statements if statement.lstrip().upper().split(None, 1)[0] in {"INSERT", "UPDATE", "DELETE"}]
    return response, len(selects), dml


def _bodies(responses):
    return [response.json() for response in responses]


# --- Paridad escalar de los lotes de sueldo/jornada ---


def _scalar_get_for_days(service, employee_days, **_options):
    return {
        (employee_id, day): service.repo.get_for_date(employee_id, day)
        for employee_id, days in employee_days.items()
        for day in sorted(set(days))
    }


def _scalar_schedules_for_days(service, employee_days, **_options):
    return {
        (employee_id, day): service.repo.get_for_date(employee_id, day)
        for employee_id, days in employee_days.items()
        for day in sorted(set(days))
    }


def _scalar_expected_minutes_for_days(service, employee_days, **_options):
    return {
        (employee_id, day): service.expected_minutes(employee_id, day)
        for employee_id, days in employee_days.items()
        for day in sorted(set(days))
    }
