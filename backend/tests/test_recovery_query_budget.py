"""Recovery list/credit reads stay constant while results keep their rules.

These tests exercise the public endpoints ``GET /api/v1/attendance/recovery-commitments``
and ``GET /api/v1/employees/{id}/balance`` plus the shared bulk seam payroll
consumes.  Only SELECT statement counts are recorded; no SQL parameters,
credentials or production data are inspected.  Fixtures are isolated in-memory
SQLite sessions.
"""
import uuid
from datetime import date, datetime, timedelta, timezone

from sqlalchemy import event, select

from app.modules.adjustments.models import ADJUSTMENT_APPROVED, HourAdjustment
from app.modules.attendance.manual_models import (
    ManualAttendanceDay,
    ManualRecoveryApplication,
    RecoveryCommitment,
)
from app.modules.schedules.models import WorkSchedule
from app.modules.users.models import User


_DAY = date(2026, 9, 1)
_STAMP = datetime(2026, 9, 1, 12, tzinfo=timezone.utc)
_SCHEDULE_FIELDS = (
    "monday_minutes",
    "tuesday_minutes",
    "wednesday_minutes",
    "thursday_minutes",
    "friday_minutes",
    "saturday_minutes",
    "sunday_minutes",
)
_COMMITMENT_KEYS = {
    "id", "employee_id", "permission_date", "agreed_minutes",
    "pending_minutes", "covered_before", "reference",
}


def _login(client) -> uuid.UUID:
    response = client.post(
        "/api/v1/auth/login",
        json={"username": "admin", "password": "Admin123!"},
    )
    assert response.status_code == 200, response.text
    return uuid.UUID(client.get("/api/v1/auth/me").json()["id"])


def _employee(client, db, code: str, dni: str) -> uuid.UUID:
    response = client.post(
        "/api/v1/employees",
        json={
            "dni": dni,
            "employee_code": code,
            "first_name": "Recovery",
            "last_name": "Fixture",
            "job_role_id": str(db._test_job_roles["Operario"]),
            "hire_date": "2026-01-01",
        },
    )
    assert response.status_code == 201, response.text
    return uuid.UUID(response.json()["id"])


def _schedule(db, employee_id, effective_from=_DAY, minutes=480) -> None:
    db.add(
        WorkSchedule(
            employee_id=employee_id,
            effective_from=effective_from,
            **{field: minutes for field in _SCHEDULE_FIELDS},
        )
    )


def _commitment(
    db, employee_id, permission_date, agreed_minutes, actor_id, *,
    covered_before=False, status="ACTIVE", reference="Recovery fixture",
) -> RecoveryCommitment:
    item = RecoveryCommitment(
        employee_id=employee_id,
        permission_date=permission_date,
        agreed_minutes=agreed_minutes,
        covered_before=covered_before,
        status=status,
        reference=reference,
        created_by_user_id=actor_id,
    )
    db.add(item)
    db.flush()
    return item


def _manual_day(
    db, employee_id, work_date, actor_id, *,
    normal_minutes=0, recovery_minutes=0, voided=False,
) -> ManualAttendanceDay:
    item = ManualAttendanceDay(
        employee_id=employee_id,
        work_date=work_date,
        worked_minutes_net=normal_minutes + recovery_minutes,
        normal_minutes=normal_minutes,
        additional_minutes=0,
        recovery_minutes=recovery_minutes,
        reason="Recovery budget fixture",
        created_by_user_id=actor_id,
        voided_at=_STAMP if voided else None,
    )
    db.add(item)
    db.flush()
    return item


def _apply(db, day, commitment, minutes) -> None:
    db.add(
        ManualRecoveryApplication(
            manual_day_id=day.id, commitment_id=commitment.id, minutes=minutes,
        )
    )


def _count_selects(db_session, call, *, expire: bool = True):
    """Run ``call`` counting SELECT statements only. No parameters are stored."""
    statements = []

    def record(_conn, _cursor, statement, _parameters, _context, _executemany):
        if statement.lstrip().upper().startswith("SELECT"):
            statements.append(statement)

    if expire:
        db_session.expire_all()
    event.listen(db_session.bind, "before_cursor_execute", record)
    try:
        result = call()
    finally:
        event.remove(db_session.bind, "before_cursor_execute", record)
    return result, len(statements)
