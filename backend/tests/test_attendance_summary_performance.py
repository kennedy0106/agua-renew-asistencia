"""Public dashboard counters keep their values with one database round trip."""

import re
from datetime import date, datetime, timedelta

import pytest
from sqlalchemy import event

from app.core.timezone import lima_tz
from app.modules.attendance import router as attendance_router
from app.modules.attendance.models import AttendanceRecord
from app.modules.employees.models import Employee
from test_attendance_admin import _login


_DAY = date(2026, 10, 15)
_PATH = "/api/v1/attendance/summary"


@pytest.mark.parametrize("dataset", ["empty", "employees_only", "mixed"])
def test_summary_preserves_counters_with_one_round_trip(client, db_session, monkeypatch, dataset):
    class FrozenDatetime(datetime):
        @classmethod
        def now(cls, tz=None):
            instant = datetime(2026, 10, 15, 12, tzinfo=lima_tz())
            return instant.astimezone(tz) if tz else instant.replace(tzinfo=None)

    monkeypatch.setattr(attendance_router, "datetime", FrozenDatetime)
    _login(client, "admin", "Admin123!")
    employees = []
    if dataset != "empty":
        for index in range(3):
            employee = Employee(
                dni=f"9000000{index}", employee_code=f"SUMMARY-{index}",
                first_name="Summary", last_name=f"Fixture {index}",
                job_role_id=db_session._test_job_roles["Operario"],
                qr_token=f"summary-query-budget-{index}", active=index < 2,
            )
            db_session.add(employee)
            employees.append(employee)
        db_session.flush()
    if dataset == "mixed":
        def attendance(employee, day, hour, *, complete):
            check_in = datetime.combine(day, datetime.min.time(), tzinfo=lima_tz()) + timedelta(hours=hour)
            db_session.add(AttendanceRecord(
                employee_id=employee.id, work_date=day, check_in_at=check_in,
                check_out_at=check_in + timedelta(hours=1) if complete else None,
                worked_minutes=60 if complete else None,
                status="COMPLETE" if complete else "OPEN",
            ))

        # Multiple shifts count once as present but separately as checked out.
        attendance(employees[0], _DAY, 8, complete=True)
        attendance(employees[0], _DAY, 10, complete=True)
        attendance(employees[1], _DAY, 12, complete=False)
        # Attendance from inactive employees still counts, as in the old API.
        attendance(employees[2], _DAY, 8, complete=True)
        # Open entries are all-time; completed/present entries are date-scoped.
        attendance(employees[0], _DAY - timedelta(days=1), 12, complete=False)
        attendance(employees[2], _DAY - timedelta(days=1), 8, complete=True)
        attendance(employees[2], _DAY + timedelta(days=1), 8, complete=True)
    db_session.commit()
    expected = {
        "employees_active": 0 if dataset == "empty" else 2,
        "present_today": 3 if dataset == "mixed" else 0,
        "no_entry_today": 2 if dataset == "employees_only" else 0,
        "open_entries": 2 if dataset == "mixed" else 0,
        "checked_out_today": 3 if dataset == "mixed" else 0,
    }
    statement_batches = []
    for _ in range(2):
        statements = []

        def record_sql(conn, cursor, statement, parameters, context, executemany):
            statements.append(statement)

        db_session.expire_all()
        event.listen(db_session.bind, "before_cursor_execute", record_sql)
        try:
            response = client.get(_PATH)
        finally:
            event.remove(db_session.bind, "before_cursor_execute", record_sql)
        assert response.status_code == 200, response.text
        assert response.json() == expected
        assert not any(re.match(r"\s*(INSERT|UPDATE|DELETE)\b", sql, re.I) for sql in statements)
        statement_batches.append(statements)
    service_counts = [
        sum(bool(re.search(r"\bFROM\s+(employees|attendance_records)\b", sql, re.I)) for sql in batch)
        for batch in statement_batches
    ]
    assert service_counts == [1, 1], f"summary counter SELECTs per request: {service_counts}"
