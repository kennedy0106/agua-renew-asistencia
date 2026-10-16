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


def test_commitment_list_query_budget_is_constant(client, db_session):
    """The list adds no per-commitment read: N commitments cost the same as one."""
    actor_id = _login(client)
    employee_id = _employee(client, db_session, "RCV-001", "75000001")
    _schedule(db_session, employee_id)
    first_day = _manual_day(
        db_session, employee_id, date(2026, 10, 1), actor_id, recovery_minutes=30,
    )
    first = _commitment(db_session, employee_id, _DAY, 120, actor_id)
    _apply(db_session, first_day, first, 30)
    db_session.commit()

    path = "/api/v1/attendance/recovery-commitments"
    params = {"employee_id": str(employee_id)}
    response, one = _count_selects(db_session, lambda: client.get(path, params=params))
    assert response.status_code == 200, response.text
    assert [row["pending_minutes"] for row in response.json()] == [90]

    for offset in range(1, 5):
        _commitment(db_session, employee_id, _DAY + timedelta(days=offset), 120, actor_id)
    db_session.commit()

    response, many = _count_selects(db_session, lambda: client.get(path, params=params))
    assert response.status_code == 200, response.text
    assert len(response.json()) == 5
    assert many == one
    print(f"RECOVERY_LIST_SELECTS one={one} five={many}")


def test_commitment_list_preserves_pending_covered_and_filters(client, db_session):
    """Active-only filter, employee filter and voided applications stay unchanged."""
    actor_id = _login(client)
    employee_a = _employee(client, db_session, "RCV-002", "75000002")
    employee_b = _employee(client, db_session, "RCV-003", "75000003")
    active_day = _manual_day(
        db_session, employee_a, date(2026, 10, 2), actor_id, recovery_minutes=30,
    )
    voided_day = _manual_day(
        db_session, employee_a, date(2026, 10, 3), actor_id,
        recovery_minutes=20, voided=True,
    )
    first = _commitment(db_session, employee_a, _DAY, 120, actor_id, reference="Uno")
    second = _commitment(
        db_session, employee_a, _DAY + timedelta(days=1), 120, actor_id,
        covered_before=True, reference="Dos",
    )
    _commitment(
        db_session, employee_a, _DAY + timedelta(days=2), 120, actor_id,
        status="VOIDED", reference="Tres",
    )
    other = _commitment(
        db_session, employee_b, _DAY + timedelta(days=3), 120, actor_id, reference="Otro",
    )
    _apply(db_session, active_day, first, 30)
    _apply(db_session, voided_day, first, 20)
    db_session.commit()

    response = client.get(
        "/api/v1/attendance/recovery-commitments",
        params={"employee_id": str(employee_a)},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    expected_ids = [
        str(item.id)
        for item in db_session.scalars(
            select(RecoveryCommitment).where(
                RecoveryCommitment.status == "ACTIVE",
                RecoveryCommitment.employee_id == employee_a,
            )
        )
    ]
    assert [row["id"] for row in body] == expected_ids
    assert all(set(row) == _COMMITMENT_KEYS for row in body)
    assert body == [
        {
            "id": str(first.id), "employee_id": str(employee_a),
            "permission_date": "2026-09-01", "agreed_minutes": 120,
            "pending_minutes": 90, "covered_before": False, "reference": "Uno",
        },
        {
            "id": str(second.id), "employee_id": str(employee_a),
            "permission_date": "2026-09-02", "agreed_minutes": 120,
            "pending_minutes": 120, "covered_before": True, "reference": "Dos",
        },
    ]
    unfiltered = client.get("/api/v1/attendance/recovery-commitments").json()
    assert {row["id"] for row in unfiltered} == {
        str(first.id), str(second.id), str(other.id),
    }


def test_balance_recovery_credit_query_budget_is_constant(client, db_session):
    """Balance credit reads do not grow with the number of commitments or days."""
    actor_id = _login(client)
    employee_id = _employee(client, db_session, "RCV-004", "75000004")
    _schedule(db_session, employee_id)
    params = {"date_from": "2026-09-01", "date_to": "2026-09-05"}
    path = f"/api/v1/employees/{employee_id}/balance"

    counts: list[int] = []
    credits: list[int] = []
    for index in range(5):
        app_day = _manual_day(
            db_session, employee_id, date(2026, 10, 10) + timedelta(days=index),
            actor_id, recovery_minutes=60,
        )
        commitment = _commitment(
            db_session, employee_id, _DAY + timedelta(days=index), 120, actor_id,
        )
        _apply(db_session, app_day, commitment, 60)
        db_session.commit()

        response, selects = _count_selects(db_session, lambda: client.get(path, params=params))
        assert response.status_code == 200, response.text
        counts.append(selects)
        credits.append(response.json()["recovery_credit_minutes"])

    assert credits == [60, 120, 180, 240, 300]
    assert counts == [counts[0]] * 5
    print(f"BALANCE_CREDIT_SELECTS credits={credits} selects={counts}")


def test_recovery_credit_rules_preserve_caps_covered_and_voided(client, db_session):
    """covered_before, agreed cap, missing cap, ordinary/legacy coverage and voided rows."""
    actor_id = _login(client)
    employee_id = _employee(client, db_session, "RCV-005", "75000005")
    _schedule(db_session, employee_id)

    # A: already recognized before => no credit even with applications.
    a_day = _manual_day(
        db_session, employee_id, date(2026, 10, 20), actor_id, recovery_minutes=60,
    )
    covered = _commitment(db_session, employee_id, _DAY, 120, actor_id, covered_before=True)
    _apply(db_session, a_day, covered, 60)

    # B: agreed cap 60 with 90 applied => credit capped at 60 (missing 480).
    b_day_a = _manual_day(
        db_session, employee_id, date(2026, 10, 21), actor_id, recovery_minutes=60,
    )
    b_day_b = _manual_day(
        db_session, employee_id, date(2026, 10, 22), actor_id, recovery_minutes=30,
    )
    capped = _commitment(db_session, employee_id, _DAY + timedelta(days=1), 60, actor_id)
    _apply(db_session, b_day_a, capped, 60)
    _apply(db_session, b_day_b, capped, 30)

    # C: only a voided application => applied 0.
    c_day = _manual_day(
        db_session, employee_id, date(2026, 10, 23), actor_id,
        recovery_minutes=120, voided=True,
    )
    voided = _commitment(db_session, employee_id, _DAY + timedelta(days=2), 120, actor_id)
    _apply(db_session, c_day, voided, 120)

    # D: ordinary presence reduces the missing minutes below the agreed cap.
    _manual_day(
        db_session, employee_id, _DAY + timedelta(days=3), actor_id, normal_minutes=400,
    )
    d_day = _manual_day(
        db_session, employee_id, date(2026, 10, 24), actor_id, recovery_minutes=120,
    )
    ordinary = _commitment(db_session, employee_id, _DAY + timedelta(days=3), 120, actor_id)
    _apply(db_session, d_day, ordinary, 120)

    # E: approved legacy coverage counts; overtime/voided/pending must not.
    e_date = _DAY + timedelta(days=4)
    db_session.add_all([
        HourAdjustment(
            employee_id=employee_id, adjustment_date=e_date, minutes=400,
            adjustment_type="OTRO", status=ADJUSTMENT_APPROVED,
            reason="Cobertura legado del permiso",
        ),
        HourAdjustment(
            employee_id=employee_id, adjustment_date=e_date, minutes=500,
            adjustment_type="OVERTIME", status=ADJUSTMENT_APPROVED,
            reason="Adicional no cubre permiso",
        ),
        HourAdjustment(
            employee_id=employee_id, adjustment_date=e_date, minutes=500,
            adjustment_type="OTRO", status="PENDING",
            reason="Pendiente no cubre permiso",
        ),
        HourAdjustment(
            employee_id=employee_id, adjustment_date=e_date, minutes=500,
            adjustment_type="OTRO", status=ADJUSTMENT_APPROVED, voided_at=_STAMP,
            reason="Anulado no cubre permiso",
        ),
    ])
    e_day = _manual_day(
        db_session, employee_id, date(2026, 10, 25), actor_id, recovery_minutes=120,
    )
    legacy = _commitment(db_session, employee_id, e_date, 120, actor_id)
    _apply(db_session, e_day, legacy, 120)
    db_session.commit()

    balance = client.get(
        f"/api/v1/employees/{employee_id}/balance",
        params={"date_from": "2026-09-01", "date_to": "2026-09-05"},
    )
    assert balance.status_code == 200, balance.text
    # 0 covered + 60 agreed cap + 0 voided + 80 missing cap + 80 legacy-reduced.
    assert balance.json()["recovery_credit_minutes"] == 220


def test_recovery_credit_honors_permission_date_range(client, db_session):
    """Commitments outside the requested range never contribute credit."""
    actor_id = _login(client)
    employee_id = _employee(client, db_session, "RCV-006", "75000006")
    _schedule(db_session, employee_id)
    for index, permission in enumerate((_DAY, _DAY + timedelta(days=14))):
        day = _manual_day(
            db_session, employee_id, date(2026, 10, 26) + timedelta(days=index),
            actor_id, recovery_minutes=60,
        )
        commitment = _commitment(db_session, employee_id, permission, 120, actor_id)
        _apply(db_session, day, commitment, 60)
    db_session.commit()

    inside = client.get(
        f"/api/v1/employees/{employee_id}/balance",
        params={"date_from": "2026-09-01", "date_to": "2026-09-02"},
    )
    assert inside.status_code == 200, inside.text
    assert inside.json()["recovery_credit_minutes"] == 60
    outside = client.get(
        f"/api/v1/employees/{employee_id}/balance",
        params={"date_from": "2026-09-20", "date_to": "2026-09-30"},
    )
    assert outside.status_code == 200, outside.text
    assert outside.json()["recovery_credit_minutes"] == 0


def test_bulk_components_preserve_schedule_vigencia_tie_order(client, db_session):
    """The bulk seam keeps the same effective-date winner as the scalar read."""
    from app.modules.attendance.totals import (
        recovery_credit_components,
        recovery_credit_components_for_commitments,
    )

    actor_id = _login(client)
    employee_id = _employee(client, db_session, "RCV-008", "75000008")
    for effective_from, effective_to, tuesday in (
        (date(2026, 8, 1), date(2026, 8, 31), 480),
        (date(2026, 8, 15), None, 600),
        (date(2026, 9, 1), None, 720),
    ):
        db_session.add(WorkSchedule(
            employee_id=employee_id, effective_from=effective_from,
            effective_to=effective_to, tuesday_minutes=tuesday,
        ))
    expectations = {}
    for permission, minutes in (
        (date(2026, 8, 11), 100), (date(2026, 8, 18), 100), (date(2026, 9, 8), 100),
    ):
        day = _manual_day(
            db_session, employee_id, permission + timedelta(days=60), actor_id,
            recovery_minutes=minutes,
        )
        commitment = _commitment(db_session, employee_id, permission, 120, actor_id)
        _apply(db_session, day, commitment, minutes)
        expectations[commitment.id] = minutes
    db_session.commit()

    commitments = list(
        db_session.scalars(
            select(RecoveryCommitment)
            .where(RecoveryCommitment.employee_id == employee_id)
            .order_by(RecoveryCommitment.permission_date)
        )
    )
    scalar = {item.id: recovery_credit_components(db_session, item) for item in commitments}
    bulk = recovery_credit_components_for_commitments(db_session, commitments)
    assert bulk == scalar
    assert [bulk[item.id]["expected_minutes_at_origin"] for item in commitments] == [480, 600, 720]
    assert {item.id: bulk[item.id]["effective_credit_minutes"] for item in commitments} == expectations


def test_bulk_components_match_scalar_and_use_constant_reads(client, db_session):
    """The shared payroll seam returns the scalar values with a flat read count."""
    from app.modules.attendance.totals import (
        recovery_credit_components,
        recovery_credit_components_for_commitments,
        recovery_credit_minutes,
        recovery_credit_minutes_by_day,
    )

    actor_id = _login(client)
    employee_id = _employee(client, db_session, "RCV-007", "75000007")
    _schedule(db_session, employee_id)

    covered_day = _manual_day(
        db_session, employee_id, date(2026, 10, 1), actor_id, recovery_minutes=90,
    )
    covered = _commitment(db_session, employee_id, _DAY, 120, actor_id, covered_before=True)
    _apply(db_session, covered_day, covered, 90)

    cap_day_a = _manual_day(
        db_session, employee_id, date(2026, 10, 2), actor_id, recovery_minutes=60,
    )
    cap_day_b = _manual_day(
        db_session, employee_id, date(2026, 10, 3), actor_id, recovery_minutes=30,
    )
    capped = _commitment(db_session, employee_id, _DAY + timedelta(days=1), 60, actor_id)
    _apply(db_session, cap_day_a, capped, 60)
    _apply(db_session, cap_day_b, capped, 30)

    voided_day = _manual_day(
        db_session, employee_id, date(2026, 10, 4), actor_id,
        recovery_minutes=120, voided=True,
    )
    voided = _commitment(db_session, employee_id, _DAY + timedelta(days=2), 120, actor_id)
    _apply(db_session, voided_day, voided, 120)

    empty = _commitment(db_session, employee_id, _DAY + timedelta(days=3), 120, actor_id)

    before_schedule = _commitment(db_session, employee_id, date(2026, 8, 20), 120, actor_id)
    pre_day = _manual_day(
        db_session, employee_id, date(2026, 10, 5), actor_id, recovery_minutes=120,
    )
    _apply(db_session, pre_day, before_schedule, 120)
    db_session.commit()

    commitments = list(
        db_session.scalars(
            select(RecoveryCommitment)
            .where(RecoveryCommitment.employee_id == employee_id)
            .order_by(RecoveryCommitment.permission_date)
        )
    )
    assert [item.id for item in commitments] == [
        before_schedule.id, covered.id, capped.id, voided.id, empty.id,
    ]

    scalar = {item.id: recovery_credit_components(db_session, item) for item in commitments}
    bulk, bulk_selects = _count_selects(
        db_session,
        lambda: recovery_credit_components_for_commitments(db_session, commitments),
        expire=False,
    )
    assert bulk == scalar
    assert bulk[covered.id]["effective_credit_minutes"] == 0
    assert bulk[covered.id]["covered_before"] is True
    assert bulk[capped.id]["effective_credit_minutes"] == 60
    assert bulk[voided.id]["applied_minutes"] == 0
    assert bulk[empty.id]["effective_credit_minutes"] == 0
    assert bulk[before_schedule.id]["effective_credit_minutes"] == 120

    _, scalar_selects = _count_selects(
        db_session,
        lambda: [recovery_credit_components(db_session, item) for item in commitments],
        expire=False,
    )
    assert bulk_selects == 5
    assert scalar_selects == 5 * len(commitments)
    print(f"RECOVERY_COMPONENT_SELECTS bulk={bulk_selects} scalar={scalar_selects}")

    _, one = _count_selects(
        db_session,
        lambda: recovery_credit_components_for_commitments(db_session, commitments[:1]),
        expire=False,
    )
    assert one == bulk_selects

    by_day = recovery_credit_minutes_by_day(
        db_session, employee_id, date(2026, 8, 1), date(2026, 9, 30),
    )
    assert by_day == {
        date(2026, 8, 20): 120,
        date(2026, 9, 1): 0,
        date(2026, 9, 2): 60,
        date(2026, 9, 3): 0,
        date(2026, 9, 4): 0,
    }
    assert by_day.get(date(2026, 9, 20), 0) == 0
    assert recovery_credit_minutes(
        db_session, employee_id, date(2026, 8, 1), date(2026, 9, 30),
    ) == sum(by_day.values())
