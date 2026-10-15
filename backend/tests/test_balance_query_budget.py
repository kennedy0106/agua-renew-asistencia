"""Public balance results stay unchanged while duplicate reads are grouped."""
import re
import uuid
from datetime import date, datetime, timedelta, timezone

import pytest
from sqlalchemy import event

from app.modules.adjustments.models import HourAdjustment
from app.modules.attendance.manual_models import (
    ManualAttendanceDay, ManualRecoveryApplication, RecoveryCommitment,
)
from app.modules.attendance.models import AttendanceRecord
from app.modules.schedules.models import WorkSchedule
from test_employee_read_timing import employee_client, real_db
from test_attendance_summary_timing import timing_flag


_DAY = date(2026, 10, 15)
_STAMP = datetime(2026, 10, 15, 12, tzinfo=timezone.utc)


@pytest.mark.parametrize("dataset", ["empty", "mixed", "recovery"])
def test_balance_preserves_results_with_three_fewer_reads(
    dataset, employee_client, real_db, timing_flag,
):
    client, employee_reference = employee_client
    employee_id = uuid.UUID(employee_reference)
    auth = client.get("/api/v1/auth/me")
    assert auth.status_code == 200, auth.text
    actor_id = uuid.UUID(auth.json()["id"])
    expected_minutes = 600 if dataset == "recovery" else 480
    if dataset != "empty":
        with real_db[0]() as db:
            db.add(WorkSchedule(
                employee_id=employee_id, effective_from=_DAY,
                thursday_minutes=expected_minutes,
            ))
            db.add_all([
                AttendanceRecord(
                    employee_id=employee_id, work_date=_DAY,
                    check_in_at=_STAMP, check_out_at=_STAMP + timedelta(hours=7),
                    worked_minutes=420, status="COMPLETE",
                ),
                AttendanceRecord(
                    employee_id=employee_id, work_date=_DAY,
                    check_in_at=_STAMP + timedelta(hours=8), status="OPEN",
                ),
                AttendanceRecord(
                    employee_id=employee_id, work_date=_DAY - timedelta(days=1),
                    check_in_at=_STAMP - timedelta(days=1), check_out_at=_STAMP,
                    worked_minutes=999, status="COMPLETE",
                ),
            ])
            active = ManualAttendanceDay(
                employee_id=employee_id, work_date=_DAY, worked_minutes_net=120,
                normal_minutes=60, recovery_minutes=60, reason="Balance fixture",
                payment_snapshot={"break_minutes": 15}, created_by_user_id=actor_id,
            )
            voided = ManualAttendanceDay(
                employee_id=employee_id, work_date=_DAY, worked_minutes_net=200,
                normal_minutes=200, version=2, voided_at=_STAMP,
                reason="Voided fixture", created_by_user_id=actor_id,
            )
            db.add_all([active, voided, ManualAttendanceDay(
                employee_id=employee_id, work_date=_DAY - timedelta(days=1),
                worked_minutes_net=500, normal_minutes=500,
                reason="Out of range", created_by_user_id=actor_id,
            )])
            for minutes, kind, state, is_voided, day in [
                (30, "RECUPERACION", "APPROVED", False, _DAY),
                (-10, "RECUPERACION", "APPROVED", False, _DAY),
                (60, "OVERTIME", "APPROVED", False, _DAY),
                (444, "RECUPERACION", "PENDING", False, _DAY),
                (333, "RECUPERACION", "REJECTED", False, _DAY),
                (222, "RECUPERACION", "APPROVED", True, _DAY),
                (777, "RECUPERACION", "APPROVED", False, _DAY - timedelta(days=1)),
            ]:
                db.add(HourAdjustment(
                    employee_id=employee_id, adjustment_date=day, minutes=minutes,
                    adjustment_type=kind, status=state, reason="Balance fixture",
                    voided_at=_STAMP if is_voided else None,
                ))
            if dataset == "recovery":
                commitment = RecoveryCommitment(
                    employee_id=employee_id, permission_date=_DAY,
                    agreed_minutes=90, reference="Recovery fixture",
                    created_by_user_id=actor_id,
                )
                db.add(commitment)
                db.flush()
                db.add_all([
                    ManualRecoveryApplication(manual_day_id=active.id, commitment_id=commitment.id, minutes=60),
                    ManualRecoveryApplication(manual_day_id=voided.id, commitment_id=commitment.id, minutes=20),
                ])
            db.commit()

    empty = dataset == "empty"
    credit = 60 if dataset == "recovery" else 0
    expected = {
        "date_from": _DAY.isoformat(), "date_to": _DAY.isoformat(),
        "worked_minutes": 0 if empty else 480,
        "actual_worked_minutes": 0 if empty else 525,
        "ordinary_minutes": 0 if empty else 480,
        "expected_minutes": 0 if empty else expected_minutes,
        "adjustment_minutes": 0 if empty else 20,
        "overtime_minutes": 0 if empty else 60,
        "recovery_credit_minutes": credit,
        "balance_minutes": 0 if empty else 480 - expected_minutes + 20 + credit,
    }
    timing_flag(False)
    counts = []
    for _ in range(2):
        statements = []

        def record_sql(_conn, _cursor, statement, *_args):
            statements.append(statement)

        event.listen(real_db[1], "before_cursor_execute", record_sql)
        try:
            response = client.get(
                f"/api/v1/employees/{employee_reference}/balance",
                params={"date_from": _DAY.isoformat(), "date_to": _DAY.isoformat()},
            )
        finally:
            event.remove(real_db[1], "before_cursor_execute", record_sql)
        assert response.status_code == 200, response.text
        assert response.json() == expected
        assert not any(re.match(r"\s*(INSERT|UPDATE|DELETE)\b", sql, re.I) for sql in statements)
        assert all(re.match(r"\s*SELECT\b", sql, re.I) for sql in statements)
        counts.append(len(statements))
    budget = 12 if dataset == "recovery" else 7
    print(f"BALANCE_READS dataset={dataset} observed={counts} target={budget}")
    assert counts == [budget, budget]
