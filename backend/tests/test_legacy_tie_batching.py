"""Preserve former scalar callers without changing existing bulk defaults."""
import uuid
from datetime import date, timedelta
from decimal import Decimal

import pytest

from app.modules.attendance.totals import recovery_credit_components
from app.modules.employees.models import Employee
from app.modules.salary.models import SalarySetting
from app.modules.salary.service import SalaryService
from app.modules.schedules.models import WorkSchedule
from app.modules.schedules.service import ScheduleService
from test_payroll_query_budget import (
    _admin_id, _configure, _employee, _freeze_report_day, _login, _period,
)
from test_recovery_query_budget import (
    _apply, _commitment, _count_selects, _manual_day,
)

_START = date(2026, 9, 1)
_FIELDS = (
    "monday_minutes", "tuesday_minutes", "wednesday_minutes", "thursday_minutes",
    "friday_minutes", "saturday_minutes", "sunday_minutes",
)


def _population(client, db_session, monkeypatch):
    db_session.bind.hide_parameters = True
    _login(client)
    _freeze_report_day(monkeypatch, date(2026, 8, 31))
    employee = uuid.UUID(_employee(
        client, db_session, dni="75992001", code="TIE-01", hire_date="2026-09-01",
    ))
    _configure(
        client, str(employee), effective_from="2026-09-01",
        schedule={field: 480 for field in _FIELDS},
    )
    db_session.get(Employee, employee).termination_date = date(2026, 9, 20)
    db_session.commit()
    return employee


def test_salary_tie_preserves_calculated_base_and_existing_report_salary(
    client, db_session, monkeypatch,
):
    employee = _population(client, db_session, monkeypatch)
    db_session.add(SalarySetting(
        employee_id=employee, effective_from=_START, monthly_salary=Decimal("2400"),
    ))
    db_session.commit()
    assert SalaryService(db_session).get_for_date(employee, _START).monthly_salary == Decimal("1500")
    period = _period(client, 2026, 9)
    response = client.post(f"/api/v1/payroll/periods/{period['id']}/calculate")
    assert response.status_code == 200, response.text
    assert response.json()[0]["base_salary"] == "1000.00"
    # The report already used bulk salary selection before this optimization.
    # Preserve that existing path, rather than silently fixing its tie policy.
    report = client.get(f"/api/v1/payroll/periods/{period['id']}/daily-report")
    assert report.status_code == 200, report.text
    assert Decimal(report.json()["daily"][0]["legal_daily_value"]) == Decimal("80")


def test_schedule_tie_preserves_calculated_and_reported_expected_minutes(
    client, db_session, monkeypatch,
):
    employee = _population(client, db_session, monkeypatch)
    db_session.add(WorkSchedule(
        employee_id=employee, effective_from=_START,
        **{field: 720 for field in _FIELDS},
    ))
    db_session.commit()
    assert ScheduleService(db_session).expected_minutes(employee, _START) == 480
    period = _period(client, 2026, 9)
    response = client.post(f"/api/v1/payroll/periods/{period['id']}/calculate")
    assert response.status_code == 200, response.text
    assert response.json()[0]["expected_minutes"] == 9600
    report = client.get(f"/api/v1/payroll/periods/{period['id']}/daily-report")
    assert report.status_code == 200, report.text
    assert len(report.json()["daily"]) == 20
    assert all(row["expected_minutes"] == 480 for row in report.json()["daily"])


def test_schedule_tie_preserves_public_recovery_origin_credit(
    client, db_session, monkeypatch,
):
    employee = _population(client, db_session, monkeypatch)
    actor = _admin_id(db_session)
    db_session.add(WorkSchedule(
        employee_id=employee, effective_from=_START,
        **{field: 720 for field in _FIELDS},
    ))
    _manual_day(db_session, employee, _START, actor, normal_minutes=450)
    origin = _commitment(db_session, employee, _START, 120, actor)
    later = _manual_day(
        db_session, employee, date(2026, 10, 1), actor, recovery_minutes=90,
    )
    _apply(db_session, later, origin, 90)
    db_session.commit()
    assert recovery_credit_components(db_session, origin)["effective_credit_minutes"] == 30
    response = client.get(
        f"/api/v1/employees/{employee}/balance",
        params={"date_from": "2026-09-01", "date_to": "2026-09-01"},
    )
    assert response.status_code == 200, response.text
    assert response.json()["recovery_credit_minutes"] == 30


@pytest.mark.parametrize("kind", ["salary", "schedule"])
def test_scalar_tie_opt_in_is_bounded_and_keeps_bulk_default(
    client, db_session, monkeypatch, kind,
):
    employee = _population(client, db_session, monkeypatch)
    if kind == "salary":
        service = SalaryService(db_session)
        first = service.get_for_date(employee, _START)
        second = SalarySetting(
            employee_id=employee, effective_from=_START, monthly_salary=Decimal("2400"),
        )
        resolve = service.get_for_days
    else:
        service = ScheduleService(db_session)
        first = service.repo.get_for_date(employee, _START)
        second = WorkSchedule(
            employee_id=employee, effective_from=_START,
            **{field: 720 for field in _FIELDS},
        )
        resolve = service.schedules_for_days
    first.effective_to = date(2026, 9, 10)
    db_session.add(second)
    db_session.commit()
    days = [_START + timedelta(days=offset) for offset in range(20)]
    reference = {day: service.repo.get_for_date(employee, day).id for day in days}
    original_default, default_reads = _count_selects(
        db_session, lambda: resolve({employee: days}), expire=False,
    )
    assert default_reads == 1
    assert all(item.id == second.id for item in original_default.values())
    compatible, many_reads = _count_selects(
        db_session,
        lambda: resolve({employee: days}, preserve_scalar_ties=True), expire=False,
    )
    _, few_reads = _count_selects(
        db_session,
        lambda: resolve({employee: days[:2]}, preserve_scalar_ties=True), expire=False,
    )
    assert many_reads == few_reads == 2
    assert {day: compatible[(employee, day)].id for day in days} == reference
    assert reference[date(2026, 9, 10)] == first.id
    assert reference[date(2026, 9, 11)] == second.id
