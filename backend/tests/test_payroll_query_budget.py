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


def test_scalar_reference_parity_across_effective_date_boundaries(client, db_session, monkeypatch):
    """El lote conserva resultados con cambio de sueldo y jornada a mitad de mes."""
    _login(client)
    _freeze_report_day(monkeypatch)
    employee_id = _employee(client, db_session, dni="75210001", code="PAR-01")
    _configure(client, employee_id, effective_from="2026-08-01", monthly_salary="1500.00")
    # Cambio de sueldo/jornada vigente desde el 16: el límite de vigencia debe
    # resolverse igual en lote que escalarmente.
    _configure(
        client, employee_id, effective_from="2026-08-16", monthly_salary="1800.00",
        schedule={"monday_minutes": 300, "tuesday_minutes": 300, "wednesday_minutes": 300,
                  "thursday_minutes": 300, "friday_minutes": 300, "saturday_minutes": 240},
    )
    # Segundo empleado con alta a mitad de mes y sin cambio de sueldo: el lote
    # cruza empleados y debe respetar el tramo laboral de cada uno.
    second_id = _employee(client, db_session, dni="75210002", code="PAR-02", hire_date="2026-08-10")
    _configure(client, second_id, effective_from="2026-08-10", monthly_salary="1950.00")
    employee_uuid = uuid.UUID(employee_id)
    db_session.add(AttendanceRecord(
        employee_id=employee_uuid, work_date=date(2026, 8, 5),
        check_in_at=_STAMP, check_out_at=_STAMP.replace(hour=18), worked_minutes=300, status="COMPLETE",
    ))
    db_session.add(AttendanceRecord(
        employee_id=employee_uuid, work_date=date(2026, 8, 20),
        check_in_at=_STAMP.replace(day=20), check_out_at=_STAMP.replace(day=20, hour=18),
        worked_minutes=480, status="COMPLETE",
    ))
    commitment = RecoveryCommitment(
        employee_id=employee_uuid, permission_date=date(2026, 8, 10),
        agreed_minutes=120, reference="Paridad", created_by_user_id=_admin_id(db_session),
    )
    db_session.add(commitment)
    db_session.commit()
    period = _period(client, *_AUGUST)

    optimized_calculate, _, _ = _measure(
        db_session, lambda: client.post(f"/api/v1/payroll/periods/{period['id']}/calculate")
    )
    assert optimized_calculate.status_code == 200, optimized_calculate.text
    optimized_readiness, _, _ = _measure(
        db_session, lambda: client.get(f"/api/v1/payroll/periods/{period['id']}/readiness")
    )
    optimized_report, _, _ = _measure(
        db_session, lambda: client.get(f"/api/v1/payroll/periods/{period['id']}/daily-report")
    )
    optimized_records, _, _ = _measure(
        db_session, lambda: client.get(f"/api/v1/payroll/periods/{period['id']}/records")
    )

    monkeypatch.setattr(SalaryService, "get_for_days", _scalar_get_for_days)
    monkeypatch.setattr(ScheduleService, "schedules_for_days", _scalar_schedules_for_days)
    monkeypatch.setattr(ScheduleService, "expected_minutes_for_days", _scalar_expected_minutes_for_days)

    reference_calculate, _, _ = _measure(
        db_session, lambda: client.post(f"/api/v1/payroll/periods/{period['id']}/calculate")
    )
    reference_readiness, _, _ = _measure(
        db_session, lambda: client.get(f"/api/v1/payroll/periods/{period['id']}/readiness")
    )
    reference_report, _, _ = _measure(
        db_session, lambda: client.get(f"/api/v1/payroll/periods/{period['id']}/daily-report")
    )
    reference_records, _, _ = _measure(
        db_session, lambda: client.get(f"/api/v1/payroll/periods/{period['id']}/records")
    )

    assert optimized_readiness.status_code == reference_readiness.status_code == 200
    assert optimized_calculate.status_code == reference_calculate.status_code == 200
    assert optimized_report.status_code == reference_report.status_code == 200
    assert optimized_records.status_code == reference_records.status_code == 200
    assert _bodies([optimized_readiness, optimized_calculate, optimized_report, optimized_records]) == \
        _bodies([reference_readiness, reference_calculate, reference_report, reference_records])
    # El salto de sueldo del día 16 se valoró con el sueldo vigente de cada fecha.
    assert len(optimized_report.json()["daily"]) == 31 + 22


# --- Readiness: lecturas de sueldo y jornada sin fan-out por día ---


def test_readiness_selects_do_not_grow_with_days_or_employees(client, db_session, monkeypatch):
    _login(client)
    _freeze_report_day(monkeypatch)
    employee_ids = [
        _employee(client, db_session, dni=f"7521001{seat}", code=f"RDY-{seat}")
        for seat in range(3)
    ]
    for employee_id in employee_ids:
        _configure(client, employee_id)
    august = _period(client, *_AUGUST)
    september = _period(client, *_SEPTEMBER)

    august_body, august_selects, august_dml = _measure(
        db_session, lambda: client.get(f"/api/v1/payroll/periods/{august['id']}/readiness")
    )
    september_body, september_selects, september_dml = _measure(
        db_session, lambda: client.get(f"/api/v1/payroll/periods/{september['id']}/readiness")
    )
    assert august_body.status_code == 200, august_body.text
    assert september_body.status_code == 200, september_body.text
    assert august_dml == [] and september_dml == []
    assert august_body.json()["ready"] is True
    assert september_body.json()["ready"] is True
    # 31 días de agosto contra 30 de setiembre: mismos SELECT.
    assert august_selects == september_selects
    # Un empleado adicional no cuesta dos lecturas por cada día del tramo.
    late = _employee(client, db_session, dni="75210019", code="RDY-LATE", hire_date="2026-08-31")
    _configure(client, late)
    _, august_with_late, _ = _measure(
        db_session, lambda: client.get(f"/api/v1/payroll/periods/{august['id']}/readiness")
    )
    assert august_with_late - august_selects <= 12
    assert august_with_late <= 40
    print(f"PAYROLL_READS readiness august={august_selects} september={september_selects} with_late={august_with_late}")


def test_readiness_still_reports_missing_salary_and_schedule(client, db_session, monkeypatch):
    """Contrato observable de readiness preservado tras el lote."""
    _login(client)
    _freeze_report_day(monkeypatch)
    no_schedule = _employee(client, db_session, dni="75210021", code="RDY-NS")
    no_salary = _employee(client, db_session, dni="75210022", code="RDY-NP")
    complete = _employee(client, db_session, dni="75210023", code="RDY-OK")
    _configure(client, complete)
    assert client.post(
        f"/api/v1/employees/{no_schedule}/salary-settings",
        json={"effective_from": "2026-08-01", "monthly_salary": "1500.00", "overtime_enabled": True},
    ).status_code == 201
    assert client.post(
        f"/api/v1/employees/{no_salary}/schedule",
        json={"effective_from": "2026-08-01", "monday_minutes": 480, "tuesday_minutes": 480,
              "wednesday_minutes": 480, "thursday_minutes": 480, "friday_minutes": 480,
              "break_minutes": 60, "break_applies_after_minutes": 360},
    ).status_code == 201
    period = _period(client, *_AUGUST)

    body, _, _ = _measure(
        db_session, lambda: client.get(f"/api/v1/payroll/periods/{period['id']}/readiness")
    )
    assert body.status_code == 200, body.text
    assert body.json()["ready"] is False
    codes = {(issue["code"], issue["employee_id"]) for issue in body.json()["blockers"]}
    assert ("MISSING_SCHEDULE", no_schedule) in codes
    assert ("MISSING_SALARY", no_salary) in codes
    assert not any(employee_id == complete for _, employee_id in codes)


# --- Cálculo y reporte diario: minutos esperados, prorrateo y días ---


def test_calculate_and_daily_report_selects_do_not_grow_with_days(client, db_session, monkeypatch):
    _login(client)
    _freeze_report_day(monkeypatch)
    for seat in range(3):
        employee_id = _employee(client, db_session, dni=f"7521003{seat}", code=f"CAL-{seat}")
        _configure(client, employee_id)
    august = _period(client, *_AUGUST)
    september = _period(client, *_SEPTEMBER)

    august_calc, august_calc_selects, _ = _measure(
        db_session, lambda: client.post(f"/api/v1/payroll/periods/{august['id']}/calculate")
    )
    assert august_calc.status_code == 200, august_calc.text
    august_report, august_report_selects, _ = _measure(
        db_session, lambda: client.get(f"/api/v1/payroll/periods/{august['id']}/daily-report")
    )
    assert august_report.status_code == 200, august_report.text
    september_calc, september_calc_selects, _ = _measure(
        db_session, lambda: client.post(f"/api/v1/payroll/periods/{september['id']}/calculate")
    )
    assert september_calc.status_code == 200, september_calc.text
    september_report, september_report_selects, _ = _measure(
        db_session, lambda: client.get(f"/api/v1/payroll/periods/{september['id']}/daily-report")
    )
    assert september_report.status_code == 200, september_report.text

    # Los mismos 3 empleados: 31 contra 30 días calendario, mismos SELECT.
    assert august_calc_selects == september_calc_selects
    assert august_report_selects == september_report_selects
    # Filas diarias: 31 por empleado en agosto.
    assert len(august_report.json()["daily"]) == 3 * 31
    assert len(september_report.json()["daily"]) == 3 * 30
    assert august_calc_selects <= 60
    assert august_report_selects <= 50
    print(
        f"PAYROLL_READS calculate august={august_calc_selects} september={september_calc_selects} "
        f"report august={august_report_selects} september={september_report_selects}"
    )


def test_calculate_expected_minutes_respect_employment_bounds(client, db_session, monkeypatch):
    """Los minutos esperados se baten sin cruzar el alta/baja del empleado."""
    _login(client)
    _freeze_report_day(monkeypatch)
    employee_id = _employee(client, db_session, dni="75210039", code="CAL-BOUND", hire_date="2026-08-16")
    _configure(client, employee_id)
    period = _period(client, *_AUGUST)
    response = client.post(f"/api/v1/payroll/periods/{period['id']}/calculate")
    assert response.status_code == 200, response.text
    record = response.json()[0]
    # Lunes a sábado con 480 (lun-vie) y 240 (sábado) del 16 al 31.
    weekdays = sum(
        1 for offset in range(16, 32)
        if date(2026, 8, offset).weekday() <= 4
    )
    saturdays = sum(
        1 for offset in range(16, 32)
        if date(2026, 8, offset).weekday() == 5
    )
    assert record["expected_minutes"] == weekdays * 480 + saturdays * 240
    assert record["missing_salary_days"] == 0


# --- Insumos de snapshot de recuperación: componentes y aplicaciones ---


def _seed_recovery(db_session, employee_uuid, *, permission_day: date, applied_minutes: int = 60) -> RecoveryCommitment:
    commitment = RecoveryCommitment(
        employee_id=employee_uuid, permission_date=permission_day, agreed_minutes=120,
        reference="Presupuesto", created_by_user_id=_admin_id(db_session),
    )
    db_session.add(commitment)
    db_session.flush()
    manual = ManualAttendanceDay(
        employee_id=employee_uuid, work_date=permission_day.replace(day=min(permission_day.day + 10, 28)),
        worked_minutes_net=applied_minutes, normal_minutes=0, additional_minutes=0,
        recovery_minutes=applied_minutes, reason="Presupuesto", created_by_user_id=_admin_id(db_session),
    )
    db_session.add(manual)
    db_session.flush()
    db_session.add(ManualRecoveryApplication(
        manual_day_id=manual.id, commitment_id=commitment.id, minutes=applied_minutes,
    ))
    db_session.commit()
    return commitment


def test_recovery_snapshot_inputs_do_not_grow_with_commitments(client, db_session, monkeypatch):
    _login(client)
    _freeze_report_day(monkeypatch)
    employee_id = _employee(client, db_session, dni="75210041", code="REC-01")
    _configure(client, employee_id)
    employee_uuid = uuid.UUID(employee_id)
    _seed_recovery(db_session, employee_uuid, permission_day=date(2026, 8, 3))
    period = _period(client, *_AUGUST)

    first_calc, first_selects, _ = _measure(
        db_session, lambda: client.post(f"/api/v1/payroll/periods/{period['id']}/calculate")
    )
    assert first_calc.status_code == 200, first_calc.text
    for offset in (4, 5, 6):
        _seed_recovery(db_session, employee_uuid, permission_day=date(2026, 8, offset))
    last_calc, last_selects, _ = _measure(
        db_session, lambda: client.post(f"/api/v1/payroll/periods/{period['id']}/calculate")
    )
    assert last_calc.status_code == 200, last_calc.text
    # Cuatro compromisos con aplicaciones cuestan los mismos SELECT que uno.
    assert last_selects == first_selects
    assert last_selects <= 40
    print(f"PAYROLL_READS recovery_snapshot commitments=1/{first_selects} commitments=4/{last_selects}")


def test_recovery_inputs_change_fingerprint_and_recalculate_restores_snapshot(client, db_session, monkeypatch):
    _login(client)
    _freeze_report_day(monkeypatch)
    employee_id = _employee(client, db_session, dni="75210042", code="REC-02")
    _configure(client, employee_id)
    employee_uuid = uuid.UUID(employee_id)
    commitment = _seed_recovery(db_session, employee_uuid, permission_day=date(2026, 8, 3))
    period = _period(client, *_AUGUST)
    assert client.post(f"/api/v1/payroll/periods/{period['id']}/calculate").status_code == 200
    assert client.post(f"/api/v1/payroll/periods/{period['id']}/confirm").status_code == 200

    # El periodo quedó cerrado; una rectificación recalcula y compara fingerprint.
    rectification = client.post(
        f"/api/v1/payroll/periods/{period['id']}/rectifications", json={"reason": "Fingerprint"}
    )
    assert rectification.status_code == 201, rectification.text
    rectified_id = rectification.json()["id"]
    assert client.post(f"/api/v1/payroll/periods/{rectified_id}/calculate").status_code == 200
    manual = ManualAttendanceDay(
        employee_id=employee_uuid, work_date=date(2026, 8, 20), worked_minutes_net=30,
        normal_minutes=0, additional_minutes=0, recovery_minutes=30, reason="Nueva aplicación",
        created_by_user_id=_admin_id(db_session),
    )
    db_session.add(manual)
    db_session.flush()
    db_session.add(ManualRecoveryApplication(
        manual_day_id=manual.id, commitment_id=commitment.id, minutes=30,
    ))
    db_session.commit()
    # Insumo de recuperación cambiado: el snapshot previo queda obsoleto.
    assert client.post(f"/api/v1/payroll/periods/{rectified_id}/confirm").status_code == 409
    # Recalcular captura el nuevo insumo y el cierre vuelve a ser posible.
    assert client.post(f"/api/v1/payroll/periods/{rectified_id}/calculate").status_code == 200
    assert client.post(f"/api/v1/payroll/periods/{rectified_id}/confirm").status_code == 200


def test_daily_report_recovery_credit_selects_do_not_grow_with_days(client, db_session, monkeypatch):
    _login(client)
    _freeze_report_day(monkeypatch)
    employee_id = _employee(client, db_session, dni="75210043", code="REC-03")
    _configure(client, employee_id)
    employee_uuid = uuid.UUID(employee_id)
    _seed_recovery(db_session, employee_uuid, permission_day=date(2026, 8, 3))
    period = _period(client, *_AUGUST)
    assert client.post(f"/api/v1/payroll/periods/{period['id']}/calculate").status_code == 200

    first_report, first_selects, _ = _measure(
        db_session, lambda: client.get(f"/api/v1/payroll/periods/{period['id']}/daily-report")
    )
    assert first_report.status_code == 200, first_report.text
    first_day = next(item for item in first_report.json()["daily"] if item["work_date"] == "2026-08-03")
    # El crédito se reconoce en la fecha del permiso, no en la fecha trabajada.
    assert first_day["approved_adjustment_minutes"] == 60

    for offset in range(4, 14):
        _seed_recovery(db_session, employee_uuid, permission_day=date(2026, 8, offset))
    last_report, last_selects, _ = _measure(
        db_session, lambda: client.get(f"/api/v1/payroll/periods/{period['id']}/daily-report")
    )
    assert last_report.status_code == 200, last_report.text
    assert last_selects == first_selects
    assert last_selects <= 35
    print(f"PAYROLL_READS recovery_daily commitments=1/{first_selects} commitments=11/{last_selects}")
    # Diez fechas de permiso nuevas no alteran el crédito de la primera fecha.
    again = next(item for item in last_report.json()["daily"] if item["work_date"] == "2026-08-03")
    assert again["approved_adjustment_minutes"] == 60
