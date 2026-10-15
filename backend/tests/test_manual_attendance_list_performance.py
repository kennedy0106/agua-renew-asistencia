"""Public manual-history query budget and isolated local timing samples."""
import os
import statistics
import time
import uuid
from datetime import date, datetime, timedelta

import pytest
from sqlalchemy import event

from app.modules.attendance.manual_models import (
    ManualAttendanceDay, ManualRecoveryApplication, RecoveryCommitment,
)
from app.modules.users.models import User
from test_manual_attendance import _employee, _login


@pytest.fixture()
def history(client, db_session):
    _login(client)
    employee = uuid.UUID(_employee(client, db_session))
    actor = db_session.query(User).filter_by(username="admin").one().id
    commitment = RecoveryCommitment(
        employee_id=employee, permission_date=date(2026, 1, 1),
        agreed_minutes=3000, reference="Local history fixture", created_by_user_id=actor,
    )
    db_session.add(commitment)
    db_session.flush()
    rows = []
    for index in range(51):
        row = ManualAttendanceDay(
            employee_id=employee, work_date=date(2026, 2, 1) + timedelta(days=index),
            worked_minutes_net=480, normal_minutes=450 if index % 2 else 480,
            recovery_minutes=30 if index % 2 else 0, reason="Local history fixture",
            created_by_user_id=actor,
            voided_at=datetime(2026, 4, 1) if index == 50 else None,
            void_reason="Fixture void" if index == 50 else None,
        )
        db_session.add(row)
        db_session.flush()
        if index % 2:
            db_session.add(ManualRecoveryApplication(
                manual_day_id=row.id, commitment_id=commitment.id, minutes=30,
            ))
        rows.append(row)
    db_session.commit()
    return employee, rows


def _read(client, db_session, params):
    selects = []

    def count_select(conn, cursor, statement, parameters, context, executemany):
        if statement.lstrip().upper().startswith("SELECT"):
            selects.append(statement)

    # Keep authentication/role reads in the measured public request.
    db_session.expire_all()
    event.listen(db_session.bind, "before_cursor_execute", count_select)
    try:
        start = time.perf_counter()
        response = client.get("/api/v1/attendance/manual-days", params=params)
        elapsed = (time.perf_counter() - start) * 1000
    finally:
        event.remove(db_session.bind, "before_cursor_execute", count_select)
    assert response.status_code == 200
    service_selects = sum(
        "FROM manual_attendance_days" in sql or "FROM manual_recovery_applications" in sql
        for sql in selects
    )
    return response.json(), elapsed, len(selects), service_selects


@pytest.mark.parametrize("size", [0, 1, 50])
def test_history_has_constant_query_budget(client, db_session, history, size):
    employee, _ = history
    params = {"employee_id": str(employee), "limit": size or 50, "offset": 0, "include_voided": False}
    if size == 0:
        params["date_from"] = "2026-12-01"
    samples = 7 if size == 50 else 1
    timings, counts, service_counts = [], [], []
    expected = None
    for _ in range(samples):
        body, elapsed, count, service_count = _read(client, db_session, params)
        assert len(body) == size
        if expected is None:
            expected = body
        assert body == expected
        timings.append(round(elapsed, 3))
        counts.append(count)
        service_counts.append(service_count)
    if size == 50:
        print(f"LOCAL_MANUAL_HISTORY phase={os.environ.get('MANUAL_HISTORY_PHASE', 'check')} "
              f"samples_ms={timings} median_ms={statistics.median(timings):.3f} "
              f"min_ms={min(timings):.3f} max_ms={max(timings):.3f} "
              f"http_status=200 rows=50 total_selects={counts} service_selects={service_counts}")
    assert service_counts == [1 if size == 0 else 2] * samples


def test_history_preserves_detail_filters_pagination_and_voided(client, db_session, history):
    employee, rows = history
    detail = []
    for row in reversed(rows):
        response = client.get(f"/api/v1/attendance/manual-days/{row.id}")
        assert response.status_code == 200
        detail.append(response.json())
    active = [row for row in detail if row["voided_at"] is None]
    body, _, _, _ = _read(client, db_session, {"limit": 50})
    assert body == active
    assert any(row["recovery_allocations"] for row in body)
    assert any(not row["recovery_allocations"] for row in body)
    body, _, _, _ = _read(client, db_session, {"employee_id": str(employee), "include_voided": True, "offset": 1, "limit": 3})
    assert body == detail[1:4]
    body, _, _, _ = _read(client, db_session, {"include_voided": True, "limit": 100})
    assert body == detail
    body, _, _, _ = _read(client, db_session, {"date_from": "2026-02-10", "date_to": "2026-02-12"})
    assert body == [row for row in active if "2026-02-10" <= row["work_date"] <= "2026-02-12"]
    body, _, _, _ = _read(client, db_session, {"employee_id": str(uuid.uuid4())})
    assert body == []
