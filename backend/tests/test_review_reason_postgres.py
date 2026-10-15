"""A01/A02: persistencia del motivo de revisión en PostgreSQL vía Alembic + HTTP."""

import os

import pytest
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, func, select, text
from sqlalchemy.orm import sessionmaker

from app.core.security import hash_password
from app.core.test_db import assert_disposable_postgres_url
from app.db.session import get_db
from app.main import app
from app.modules.attendance.models import AttendanceAttemptResolution
from app.modules.audit.models import AuditLog
from app.modules.job_roles.repository import JobRoleRepository
from app.modules.system_roles.repository import SystemRoleRepository
from app.modules.users.repository import UserRepository
from scripts.seed_roles import ROLES
from tests.image_helpers import valid_jpeg_b64
from tests.test_attendance_hardening import _login, _mark, _nonce_of, _pair_kiosk

pytestmark = pytest.mark.integration


@pytest.fixture()
def pg_http_client(monkeypatch: pytest.MonkeyPatch):
    url = os.environ.get("TEST_DATABASE_URL", "").strip()
    if not url:
        pytest.skip("TEST_DATABASE_URL no configurado")
    if os.environ.get("ALLOW_TEST_DB_RESET") != "1":
        pytest.skip("ALLOW_TEST_DB_RESET=1 es obligatorio para DROP SCHEMA")
    try:
        assert_disposable_postgres_url(url)
    except ValueError as exc:
        pytest.skip(str(exc))

    from app.core.config import get_settings

    monkeypatch.setenv("DATABASE_URL", url)
    monkeypatch.setenv("DATABASE_URL_UNPOOLED", url)
    get_settings.cache_clear()

    engine = create_engine(url)
    with engine.begin() as conn:
        conn.execute(text("DROP SCHEMA public CASCADE"))
        conn.execute(text("CREATE SCHEMA public"))

    command.upgrade(Config("alembic.ini"), "head")
    factory = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    session = factory()

    roles = {}
    role_repo = SystemRoleRepository(session)
    for name, description in ROLES:
        role = role_repo.create(name=name, description=description)
        roles[name] = role.id
    job_roles = {}
    job_repo = JobRoleRepository(session)
    for name in ("Operario", "Chofer"):
        job_roles[name] = job_repo.create(name=name).id
    users = UserRepository(session)
    users.create(username="admin", password_hash=hash_password("Admin123!"), system_role_id=roles["ADMIN"])
    session.commit()
    session._test_job_roles = job_roles  # type: ignore[attr-defined]

    def override_get_db():
        yield session

    app.dependency_overrides[get_db] = override_get_db
    try:
        with TestClient(app) as client:
            yield client, session
    finally:
        app.dependency_overrides.pop(get_db, None)
        session.close()
        engine.dispose()
        get_settings.cache_clear()


def test_postgres_review_motivos_80_81_120_500_y_rechazo_501(pg_http_client) -> None:
    client, db_session = pg_http_client
    _login(client)
    _pair_kiosk(client)
    cases = (
        (3, "abc"),
        (80, "W" * 80),
        (81, "X" * 81),
        (120, "Y" * 120),
        (500, "C" * 500),
    )
    for index, (length, reason) in enumerate(cases, start=1):
        code = f"EMP-P{index}"
        created = client.post(
            "/api/v1/employees",
            json={
                "dni": f"6114503{index}",
                "employee_code": code,
                "first_name": f"P{index}",
                "last_name": "López",
                "job_role_id": str(db_session._test_job_roles["Operario"]),
            },
        )
        assert created.status_code == 201, created.text
        token, marked = _mark(client, created.json()["employee_code"])
        nonce = _nonce_of(token)
        reviewed = client.post(f"/api/v1/attendance/attempts/{nonce}/review", json={"reason": reason})
        assert reviewed.status_code == 200, reviewed.text
        assert reviewed.json()["state"] == "REVIEWED"
        kiosk = client.post("/api/v1/attendance/attempt/status", json={"marking_token": token})
        assert kiosk.status_code == 200
        assert kiosk.json()["state"] == "REVIEWED"
        db_session.expire_all()
        stored = db_session.get(AttendanceAttemptResolution, nonce)
        assert stored is not None
        assert stored.reason == reason
        assert len(stored.reason) == length
        audit = db_session.scalar(
            select(AuditLog).where(AuditLog.action == "ATTEMPT_REVIEWED", AuditLog.reason == reason)
        )
        assert audit is not None
        assert marked["id"]

    created = client.post(
        "/api/v1/employees",
        json={
            "dni": "61145099",
            "employee_code": "EMP-P501",
            "first_name": "P501",
            "last_name": "López",
            "job_role_id": str(db_session._test_job_roles["Operario"]),
        },
    )
    assert created.status_code == 201, created.text
    token, _marked = _mark(client, created.json()["employee_code"])
    nonce = _nonce_of(token)
    before_resolutions = db_session.scalar(select(func.count()).select_from(AttendanceAttemptResolution))
    before_audits = db_session.scalar(
        select(func.count()).select_from(AuditLog).where(AuditLog.action == "ATTEMPT_REVIEWED")
    )
    rejected = client.post(f"/api/v1/attendance/attempts/{nonce}/review", json={"reason": "Z" * 501})
    assert rejected.status_code == 422
    db_session.expire_all()
    assert db_session.scalar(select(func.count()).select_from(AttendanceAttemptResolution)) == before_resolutions
    assert (
        db_session.scalar(select(func.count()).select_from(AuditLog).where(AuditLog.action == "ATTEMPT_REVIEWED"))
        == before_audits
    )
    assert db_session.get(AttendanceAttemptResolution, nonce) is None
