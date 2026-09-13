"""Fixtures de tests: BD SQLite en memoria + usuarios por rol.

Los tests no tocan Neon: se sobreescribe la dependencia get_db.
"""

import os

import pytest
from fastapi import Depends
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.permissions import require_admin, require_any_role
from app.core.security import hash_password
from app.db.base import Base
from app.db.session import get_db
from app.main import app
from app.modules.system_roles.repository import SystemRoleRepository
from app.modules.users.repository import UserRepository
from scripts.seed_roles import ROLES

# boto3 con endpoint_url no entra en mock_aws salvo que moto conozca el host.
os.environ.setdefault("MOTO_S3_CUSTOM_ENDPOINTS", "http://127.0.0.1:9000")


@pytest.fixture(autouse=True)
def _object_store(request, monkeypatch):
    """S3 privado in-process (moto), salvo pruebas live_s3 contra MinIO."""
    from app.core.config import get_settings
    from app.core.object_store import provision_test_bucket, reset_object_store

    if request.node.get_closest_marker("live_s3"):
        get_settings.cache_clear()
        reset_object_store()
        yield
        reset_object_store()
        get_settings.cache_clear()
        return

    monkeypatch.setenv("MOTO_S3_CUSTOM_ENDPOINTS", "http://127.0.0.1:9000")
    monkeypatch.setenv("OBJECT_STORE_ENDPOINT", "http://127.0.0.1:9000")
    monkeypatch.setenv("OBJECT_STORE_ACCESS_KEY", "test-access")
    monkeypatch.setenv("OBJECT_STORE_SECRET_KEY", "test-secret-key")
    monkeypatch.setenv("OBJECT_STORE_BUCKET", "asistencia-evidence-test")
    monkeypatch.setenv("OBJECT_STORE_REGION", "us-east-1")
    monkeypatch.setenv("OBJECT_STORE_CREATE_BUCKET", "1")
    get_settings.cache_clear()
    reset_object_store()
    from moto import mock_aws

    with mock_aws():
        provision_test_bucket()
        yield
        reset_object_store()
        get_settings.cache_clear()


@pytest.fixture(autouse=True)
def _reset_rate_limiters():
    """Resetea los limiters globales entre tests (evita que se agote el límite)."""
    import app.modules.attendance.router as attendance_router

    attendance_router._public_limiter.reset()
    attendance_router._marking_limiter.reset()
    yield


# Rutas de prueba para verificar el gating por rol (solo existen en tests).
@app.get("/test/admin-only")
def _test_admin_only(user=Depends(require_admin)) -> dict:
    return {"ok": True, "username": user.username}


@app.get("/test/boss-or-admin")
def _test_boss_or_admin(user=Depends(require_any_role("ADMIN", "BOSS"))) -> dict:
    return {"ok": True, "username": user.username}


@pytest.fixture()
def db_session():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    session_factory = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    session = session_factory()

    roles = {}
    role_repo = SystemRoleRepository(session)
    for name, description in ROLES:
        role = role_repo.create(name=name, description=description)
        roles[name] = role.id

    # Cargos laborales de prueba (Fase 2+).
    from app.modules.job_roles.repository import JobRoleRepository

    job_roles = {}
    job_repo = JobRoleRepository(session)
    for name in ("Operario", "Chofer"):
        job_roles[name] = job_repo.create(name=name).id

    users = UserRepository(session)
    users.create(username="admin", password_hash=hash_password("Admin123!"), system_role_id=roles["ADMIN"])
    users.create(username="boss", password_hash=hash_password("Boss123!"), system_role_id=roles["BOSS"])
    users.create(username="supervisor", password_hash=hash_password("Sup123!"), system_role_id=roles["SUPERVISOR"])
    inactive = users.create(
        username="inactive", password_hash=hash_password("Ina123!"), system_role_id=roles["SUPERVISOR"]
    )
    inactive.active = False
    session.commit()

    session._test_job_roles = job_roles  # type: ignore[attr-defined]
    session._test_system_roles = roles  # type: ignore[attr-defined]
    yield session

    session.close()
    Base.metadata.drop_all(engine)


@pytest.fixture()
def client(db_session):
    def override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = override_get_db
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()
