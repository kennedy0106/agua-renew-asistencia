"""Paridad y presupuesto de consultas del acumulado de planilla (payroll-accrual).

El pendiente legado OVERTIME se valoraba con una lectura escalar por fila
(sueldo, jornada, política, refrigerio y marcaciones).  Estos tests fijan que
la respuesta pública no cambia y que el número de SELECT del GET no crece con
la cantidad de pendientes del mismo periodo.

La referencia escalar se obtiene monkeypatcheando el método batch nuevo hacia
``estimate_payment`` sobre el mismo estado aislado, sin copias de archivos ni
checkout de HEAD.
"""

import os
import statistics
import time
import uuid
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

import pytest
from sqlalchemy import event

from app.modules.adjustments.models import (
    ADJUSTMENT_PENDING,
    ADJUSTMENT_REJECTED,
    HourAdjustment,
)
from app.modules.attendance.manual_models import ManualAttendanceDay
from app.modules.attendance.manual_service import ManualAttendanceService
from app.modules.attendance.models import AttendanceBreakOverride, AttendanceRecord
from app.modules.overtime_policy.models import CompanyOvertimePolicy
from app.modules.salary.models import SalarySetting
from app.modules.schedules.models import WorkSchedule
from app.modules.users.models import User

from test_employee_agenda import _freeze_clocks, _login

_PARAMS = {
    "period": "CUSTOM",
    "anchor_date": "2026-09-20",
    "date_from": "2026-08-01",
    "date_to": "2026-09-30",
}
# Hoy determinista: el corte queda en 2026-09-20, dentro del rango pedido.
_MOMENT = datetime(2026, 9, 20, 12, tzinfo=timezone.utc)


def _create_employee(client, db, *, dni: str, code: str) -> str:
    response = client.post("/api/v1/employees", json={
        "dni": dni, "employee_code": code, "first_name": "Accrual",
        "last_name": "Prueba", "job_role_id": str(db._test_job_roles["Operario"]),
        "hire_date": "2026-08-01",
    })
    assert response.status_code == 201, response.text
    return response.json()["id"]


def _actor(db) -> uuid.UUID:
    return db.query(User).filter_by(username="admin").one().id


def _seed_history(db, employee_uuid) -> None:
    """Sueldo/jornada/política con un corte histórico a setiembre."""
    db.add_all([
        SalarySetting(
            employee_id=employee_uuid, monthly_salary=Decimal("1500.00"),
            overtime_enabled=True, use_custom_overtime_rates=False,
            effective_from=date(2026, 8, 1), effective_to=date(2026, 8, 31),
        ),
        SalarySetting(
            employee_id=employee_uuid, monthly_salary=Decimal("1800.00"),
            overtime_enabled=True, use_custom_overtime_rates=True,
            custom_first_two_hours_rate=Decimal("40.00"),
            custom_additional_hours_rate=Decimal("55.00"),
            effective_from=date(2026, 9, 1), effective_to=None,
        ),
        WorkSchedule(
            employee_id=employee_uuid, monday_minutes=480, tuesday_minutes=480,
            wednesday_minutes=480, thursday_minutes=480, friday_minutes=480,
            break_minutes=60, break_applies_after_minutes=360,
            effective_from=date(2026, 8, 1), effective_to=date(2026, 8, 31),
        ),
        WorkSchedule(
            employee_id=employee_uuid, monday_minutes=300, tuesday_minutes=300,
            wednesday_minutes=300, thursday_minutes=300, friday_minutes=300,
            saturday_minutes=240, sunday_minutes=0,
            break_minutes=60, break_applies_after_minutes=360,
            effective_from=date(2026, 9, 1), effective_to=None,
        ),
        CompanyOvertimePolicy(
            first_two_hours_rate=Decimal("30.00"), additional_hours_rate=Decimal("40.00"),
            effective_from=date(2026, 8, 1), effective_to=date(2026, 8, 31),
            reason="Política de agosto",
        ),
        CompanyOvertimePolicy(
            first_two_hours_rate=Decimal("35.00"), additional_hours_rate=Decimal("45.00"),
            effective_from=date(2026, 9, 1), effective_to=None,
            reason="Política de setiembre",
        ),
    ])
    db.commit()


def _add_overtime(
    db, employee_uuid, day: date, minutes: int, *,
    status: str = ADJUSTMENT_PENDING, voided: bool = False,
) -> HourAdjustment:
    row = HourAdjustment(
        employee_id=employee_uuid, adjustment_date=day, minutes=minutes,
        adjustment_type="OVERTIME", reason="Pendiente legado", status=status,
    )
    if voided:
        row.voided_at = datetime(2026, 9, 21, tzinfo=timezone.utc)
        row.void_reason = "Anulado"
    db.add(row)
    db.commit()
    return row


def _seed_break_and_presence(db, employee_uuid) -> None:
    """Marcaciones de kiosco, carga manual y override que cambian el refrigerio."""
    actor = _actor(db)
    db.add(AttendanceRecord(
        employee_id=employee_uuid, work_date=date(2026, 8, 5),
        check_in_at=datetime(2026, 8, 5, 13, 0, tzinfo=timezone.utc),
        check_out_at=datetime(2026, 8, 5, 18, 0, tzinfo=timezone.utc),
        worked_minutes=300, status="COMPLETE",
    ))
    db.add(ManualAttendanceDay(
        employee_id=employee_uuid, work_date=date(2026, 8, 6),
        worked_minutes_net=300, normal_minutes=300, additional_minutes=0,
        recovery_minutes=0, reason="Presencia histórica", created_by_user_id=actor,
    ))
    db.add(AttendanceBreakOverride(
        employee_id=employee_uuid, work_date=date(2026, 9, 14),
        requested_break_minutes=30, reason="Refrigerio ajustado",
        created_by_user_id=actor,
    ))
    db.commit()


def _seed_benchmark_rows(db, employee_uuid, count: int = 50) -> list[tuple[date, int]]:
    """Pendientes repetidos sobre 30 fechas, con domingos no laborables."""
    rows: list[tuple[date, int]] = []
    for index in range(count):
        day = date(2026, 9, 1) + timedelta(days=index % 30)
        minutes = 60 + (index % 7) * 30
        _add_overtime(db, employee_uuid, day, minutes)
        rows.append((day, minutes))
    return rows


def _get(client, db_session, employee_id: str, params: dict):
    """GET público medido: SELECT totales (incluye auth) y DML observadas."""
    statements: list[str] = []

    def listener(conn, cursor, statement, parameters, context, executemany):
        statements.append(statement)

    db_session.expire_all()
    event.listen(db_session.bind, "before_cursor_execute", listener)
    try:
        start = time.perf_counter()
        response = client.get(f"/api/v1/employees/{employee_id}/payroll-accrual", params=params)
        elapsed = (time.perf_counter() - start) * 1000
    finally:
        event.remove(db_session.bind, "before_cursor_execute", listener)
    selects = [s for s in statements if s.lstrip().upper().startswith("SELECT")]
    dml = [
        s for s in statements
        if s.lstrip().upper().split(None, 1)[0] in ("INSERT", "UPDATE", "DELETE")
    ]
    return response, len(selects), dml, elapsed


def _scalar_reference(service: ManualAttendanceService, employee_id, requests):
    """Mismo contrato del lote resuelto con la ruta escalar histórica."""
    return {
        (work_date, minutes): service.estimate_payment(employee_id, work_date, minutes)
        for work_date, minutes in requests
    }


def test_accrual_pending_legacy_estimates_match_scalar_reference(client, db_session, monkeypatch):
    _login(client)
    employee_id = _create_employee(client, db_session, dni="74561230", code="ACC-01")
    employee_uuid = uuid.UUID(employee_id)
    _seed_history(db_session, employee_uuid)
    _seed_break_and_presence(db_session, employee_uuid)
    # Distintas fechas y varias filas PENDIENTES el mismo día.
    _add_overtime(db_session, employee_uuid, date(2026, 8, 3), 90)
    _add_overtime(db_session, employee_uuid, date(2026, 8, 4), 200)
    _add_overtime(db_session, employee_uuid, date(2026, 8, 4), 60)
    _add_overtime(db_session, employee_uuid, date(2026, 8, 5), 480)   # kiosco
    _add_overtime(db_session, employee_uuid, date(2026, 8, 6), 480)   # manual
    _add_overtime(db_session, employee_uuid, date(2026, 9, 7), 150)   # tasas custom
    _add_overtime(db_session, employee_uuid, date(2026, 9, 13), 510)  # domingo no laborable
    _add_overtime(db_session, employee_uuid, date(2026, 9, 14), 300)  # override 30
    # Ruido excluido: rechazado, anulado y posterior al corte.
    _add_overtime(db_session, employee_uuid, date(2026, 8, 11), 120, status=ADJUSTMENT_REJECTED)
    _add_overtime(db_session, employee_uuid, date(2026, 8, 12), 120, voided=True)
    _add_overtime(db_session, employee_uuid, date(2026, 9, 25), 120)
    _freeze_clocks(monkeypatch, _MOMENT)

    original = ManualAttendanceService.estimate_payments_batch
    monkeypatch.setattr(ManualAttendanceService, "estimate_payments_batch", _scalar_reference)
    reference, _, _, _ = _get(client, db_session, employee_id, _PARAMS)
    monkeypatch.setattr(ManualAttendanceService, "estimate_payments_batch", original)

    optimized, selects, dml, _ = _get(client, db_session, employee_id, _PARAMS)

    assert reference.status_code == 200, reference.text
    assert optimized.status_code == 200, optimized.text
    assert optimized.json() == reference.json()
    assert dml == []

    body = optimized.json()
    daily = {item["work_date"]: item for item in body["daily"]}
    assert float(body["pending_additional_amount"]) > 0
    for work_date in ("2026-08-03", "2026-08-04", "2026-08-05", "2026-08-06", "2026-09-07", "2026-09-14"):
        assert float(daily[work_date]["pending_additional_amount"]) > 0
    # Domingo no laborable: el refrigerio se computa, pero sin jornada esperada
    # la valoración queda sin importe (MISSING_SCHEDULE) y no suma pendiente.
    assert float(daily["2026-09-13"]["pending_additional_amount"]) == 0
    assert selects > 0


def test_accrual_pending_ignores_rejected_voided_and_post_cutoff(client, db_session, monkeypatch):
    _login(client)
    employee_id = _create_employee(client, db_session, dni="74561231", code="ACC-02")
    employee_uuid = uuid.UUID(employee_id)
    _seed_history(db_session, employee_uuid)
    _add_overtime(db_session, employee_uuid, date(2026, 9, 7), 120)
    _freeze_clocks(monkeypatch, _MOMENT)

    baseline, _, _, _ = _get(client, db_session, employee_id, _PARAMS)
    assert baseline.status_code == 200, baseline.text
    _add_overtime(db_session, employee_uuid, date(2026, 9, 8), 120, status=ADJUSTMENT_REJECTED)
    _add_overtime(db_session, employee_uuid, date(2026, 9, 9), 120, voided=True)
    _add_overtime(db_session, employee_uuid, date(2026, 9, 25), 120)  # > corte

    after, _, dml, _ = _get(client, db_session, employee_id, _PARAMS)
    assert after.status_code == 200, after.text
    assert dml == []
    assert after.json() == baseline.json()


def test_accrual_pending_zero_or_negative_minutes_do_not_change_totals(client, db_session, monkeypatch):
    _login(client)
    employee_id = _create_employee(client, db_session, dni="74561232", code="ACC-03")
    employee_uuid = uuid.UUID(employee_id)
    _seed_history(db_session, employee_uuid)
    _add_overtime(db_session, employee_uuid, date(2026, 9, 7), 120)
    _freeze_clocks(monkeypatch, _MOMENT)

    baseline, _, _, _ = _get(client, db_session, employee_id, _PARAMS)
    assert baseline.status_code == 200, baseline.text
    _add_overtime(db_session, employee_uuid, date(2026, 9, 8), 0)
    _add_overtime(db_session, employee_uuid, date(2026, 9, 9), -30)

    after, _, dml, _ = _get(client, db_session, employee_id, _PARAMS)
    assert after.status_code == 200, after.text
    assert dml == []
    assert after.json() == baseline.json()


def test_accrual_pending_amountless_when_configuration_missing(client, db_session, monkeypatch):
    _login(client)
    _freeze_clocks(monkeypatch, _MOMENT)
    params = _PARAMS

    # Sin sueldo ni jornada.
    missing_id = _create_employee(client, db_session, dni="74561233", code="ACC-04")
    _add_overtime(db_session, uuid.UUID(missing_id), date(2026, 9, 7), 120)
    # Sueldo con horas extra deshabilitadas.
    disabled_id = _create_employee(client, db_session, dni="74561234", code="ACC-05")
    disabled_uuid = uuid.UUID(disabled_id)
    db_session.add(SalarySetting(
        employee_id=disabled_uuid, monthly_salary=Decimal("1500.00"),
        overtime_enabled=False, use_custom_overtime_rates=False,
        effective_from=date(2026, 9, 1), effective_to=None,
    ))
    db_session.add(WorkSchedule(
        employee_id=disabled_uuid, monday_minutes=300, tuesday_minutes=300,
        wednesday_minutes=300, thursday_minutes=300, friday_minutes=300,
        sunday_minutes=0, break_minutes=60, break_applies_after_minutes=360,
        effective_from=date(2026, 9, 1), effective_to=None,
    ))
    _add_overtime(db_session, disabled_uuid, date(2026, 9, 7), 120)
    # Jornada con domingo en cero: sin minutos esperados no hay importe.
    zero_id = _create_employee(client, db_session, dni="74561235", code="ACC-06")
    zero_uuid = uuid.UUID(zero_id)
    db_session.add(SalarySetting(
        employee_id=zero_uuid, monthly_salary=Decimal("1500.00"),
        overtime_enabled=True, use_custom_overtime_rates=False,
        effective_from=date(2026, 9, 1), effective_to=None,
    ))
    db_session.add(WorkSchedule(
        employee_id=zero_uuid, sunday_minutes=0, break_minutes=60,
        break_applies_after_minutes=360,
        effective_from=date(2026, 9, 1), effective_to=None,
    ))
    _add_overtime(db_session, zero_uuid, date(2026, 9, 13), 510)
    db_session.commit()

    original = ManualAttendanceService.estimate_payments_batch
    monkeypatch.setattr(ManualAttendanceService, "estimate_payments_batch", _scalar_reference)
    references = {employee_id: _get(client, db_session, employee_id, params)[0] for employee_id in (missing_id, disabled_id, zero_id)}
    monkeypatch.setattr(ManualAttendanceService, "estimate_payments_batch", original)

    for employee_id in (missing_id, disabled_id, zero_id):
        reference = references[employee_id]
        optimized, _, dml, _ = _get(client, db_session, employee_id, params)
        assert optimized.status_code == 200, optimized.text
        assert optimized.json() == reference.json()
        assert dml == []
        assert float(optimized.json()["pending_additional_amount"]) == 0


def test_accrual_select_budget_is_constant_across_pending_rows(client, db_session, monkeypatch):
    _login(client)
    _freeze_clocks(monkeypatch, _MOMENT)
    counts = []
    for index, count in enumerate((1, 5, 50)):
        employee_id = _create_employee(client, db_session, dni=f"7456124{index}", code=f"ACC-1{index}")
        employee_uuid = uuid.UUID(employee_id)
        _seed_history(db_session, employee_uuid)
        _seed_benchmark_rows(db_session, employee_uuid, count)
        response, selects, dml, _ = _get(client, db_session, employee_id, _PARAMS)
        assert response.status_code == 200, response.text
        assert dml == []
        assert float(response.json()["pending_additional_amount"]) > 0
        counts.append(selects)
    # El presupuesto no depende del número de filas pendientes ni de cuántas
    # comparten día: 1, 5 y 50 filas sembradas (1, 5 y 40 elegibles al corte)
    # ejecutan los mismos SELECT.
    assert counts[0] == counts[1] == counts[2]
    assert counts[2] <= 40


def test_accrual_local_timing_samples(client, db_session, monkeypatch):
    _login(client)
    employee_id = _create_employee(client, db_session, dni="74561250", code="ACC-BENCH")
    employee_uuid = uuid.UUID(employee_id)
    _seed_history(db_session, employee_uuid)
    benchmark_rows = _seed_benchmark_rows(db_session, employee_uuid, 50)
    _freeze_clocks(monkeypatch, _MOMENT)

    samples: list[float] = []
    counts: list[int] = []
    expected = None
    for _ in range(7):
        response, selects, dml, elapsed = _get(client, db_session, employee_id, _PARAMS)
        assert response.status_code == 200, response.text
        assert dml == []
        body = response.json()
        if expected is None:
            expected = body
        assert body == expected
        samples.append(round(elapsed, 3))
        counts.append(selects)

    cutoff = date.fromisoformat(expected["cutoff_date"])
    eligible_rows = [(day, minutes) for day, minutes in benchmark_rows if day <= cutoff]
    assert len(eligible_rows) == 40
    assert len({day for day, _ in eligible_rows}) == 20
    assert len(expected["daily"]) == 61
    print(
        f"LOCAL_PAYROLL_ACCRUAL phase={os.environ.get('PAYROLL_ACCRUAL_PHASE', 'check')} "
        f"samples_ms={samples} median_ms={statistics.median(samples):.3f} "
        f"min_ms={min(samples):.3f} max_ms={max(samples):.3f} "
        f"selects={counts} seeded_pending_rows={len(benchmark_rows)} "
        f"seeded_distinct_days={len({day for day, _ in benchmark_rows})} "
        f"eligible_pending_rows={len(eligible_rows)} "
        f"eligible_distinct_days={len({day for day, _ in eligible_rows})} "
        f"daily_rows={len(expected['daily'])} http_status=200"
    )
