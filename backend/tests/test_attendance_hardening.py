"""Invariantes nuevas: prueba de identidad y consolidación diaria."""

from datetime import date, datetime, timezone

from app.modules.attendance.models import AttendanceRecord
from app.modules.attendance.service import AttendanceService
from app.modules.schedules.repository import WorkScheduleRepository

TINY_PNG = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)


def _login(client) -> None:
    assert client.post(
        "/api/v1/auth/login", json={"username": "admin", "password": "Admin123!"}
    ).status_code == 200


def _employee(client, db_session) -> str:
    response = client.post(
        "/api/v1/employees",
        json={
            "dni": "72845632",
            "employee_code": "EMP-001",
            "first_name": "Ana",
            "last_name": "López",
            "job_role_id": str(db_session._test_job_roles["Operario"]),
        },
    )
    assert response.status_code == 201
    return response.json()["id"]


def test_identificacion_entrega_token_para_marcar(client, db_session):
    _login(client)
    _employee(client, db_session)
    identified = client.post("/api/v1/attendance/identify", json={"identifier": "EMP-001"})
    assert identified.status_code == 200
    token = identified.json()["marking_token"]
    assert identified.json()["marking_action"] == "CHECK_IN"

    without_photo = client.post("/api/v1/attendance/check-in", json={"marking_token": token})
    assert without_photo.status_code == 400

    evidence = client.post(
        "/api/v1/attendance/evidence",
        json={"marking_token": token, "image_base64": TINY_PNG, "content_type": "image/png"},
    )
    assert evidence.status_code == 201, evidence.text
    marked = client.post("/api/v1/attendance/check-in", json={"marking_token": token})
    assert marked.status_code == 201
    replay = client.post("/api/v1/attendance/check-in", json={"marking_token": token})
    assert replay.status_code == 201
    assert replay.json()["id"] == marked.json()["id"]

    checkout_identify = client.post("/api/v1/attendance/identify", json={"identifier": "EMP-001"})
    assert checkout_identify.json()["marking_action"] == "CHECK_OUT"
    wrong = client.post("/api/v1/attendance/check-out", json={"marking_token": token})
    assert wrong.status_code == 401
    out_token = checkout_identify.json()["marking_token"]
    photo = client.post(
        "/api/v1/attendance/evidence",
        json={"marking_token": out_token, "image_base64": TINY_PNG, "content_type": "image/png"},
    )
    assert photo.status_code == 201
    out = client.post("/api/v1/attendance/check-out", json={"marking_token": out_token})
    assert out.status_code == 200
    assert out.json()["status"] == "COMPLETE"


def test_refrigerio_se_descuenta_una_vez_en_jornada_partida(client, db_session):
    _login(client)
    employee_id = _employee(client, db_session)
    employee_uuid = __import__("uuid").UUID(employee_id)
    WorkScheduleRepository(db_session).create(
        employee_id=employee_uuid,
        effective_from=date(2026, 8, 1),
        monday_minutes=480,
        break_minutes=60,
        break_applies_after_minutes=360,
    )
    records = [
        AttendanceRecord(
            employee_id=employee_uuid,
            work_date=date(2026, 8, 3),
            check_in_at=datetime(2026, 8, 3, 13, 0, tzinfo=timezone.utc),
            check_out_at=datetime(2026, 8, 3, 17, 0, tzinfo=timezone.utc),
            status="COMPLETE",
            worked_minutes=240,
        ),
        AttendanceRecord(
            employee_id=employee_uuid,
            work_date=date(2026, 8, 3),
            check_in_at=datetime(2026, 8, 3, 18, 0, tzinfo=timezone.utc),
            check_out_at=datetime(2026, 8, 3, 22, 0, tzinfo=timezone.utc),
            status="COMPLETE",
            worked_minutes=240,
        ),
    ]
    db_session.add_all(records)
    db_session.commit()

    total = AttendanceService(db_session)._recompute_day(employee_uuid, date(2026, 8, 3))
    assert total == 420
    assert sum(record.worked_minutes for record in records) == 420
    daily = AttendanceService(db_session).list_daily(
        employee_id=employee_uuid, date_from=date(2026, 8, 3), date_to=date(2026, 8, 3)
    )[0]
    assert daily["session_count"] == 2
    assert daily["gross_minutes"] == 480
    assert daily["break_minutes"] == 60
    assert daily["worked_minutes"] == 420
