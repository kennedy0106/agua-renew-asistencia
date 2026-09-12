"""Datos ficticios para la suite Chromium + FastAPI + PostgreSQL desechable.

Solo se ejecuta con ALLOW_TEST_DB_RESET=1 y TEST_DATABASE_URL explícita.
No toca Neon ni usa SessionLocal/DATABASE_URL de la aplicación.
"""

from __future__ import annotations

import os
import sys
from collections.abc import Callable

from sqlalchemy import Engine, create_engine
from sqlalchemy.orm import Session

from app.core.security import hash_password
from app.core.test_db import normalize_postgres_url, require_explicit_test_authorization, validated_test_url
from app.modules.job_roles.repository import JobRoleRepository
from app.modules.system_roles.repository import SystemRoleRepository
from app.modules.users.repository import UserRepository
from scripts.seed_roles import seed as seed_roles

ADMIN_USERNAME = "admin"
ADMIN_PASSWORD = "Admin123!"
JOB_ROLE_NAME = "Operario"

CreateEngine = Callable[..., Engine]


def seed_test_data(db: Session) -> None:
    seed_roles(db)
    roles = SystemRoleRepository(db)
    admin_role = roles.get_by_name("ADMIN")
    if admin_role is None:
        raise SystemExit("ERROR: el rol ADMIN no existe")
    users = UserRepository(db)
    if users.get_by_username(ADMIN_USERNAME) is None:
        users.create(
            username=ADMIN_USERNAME,
            password_hash=hash_password(ADMIN_PASSWORD),
            system_role_id=admin_role.id,
        )
    jobs = JobRoleRepository(db)
    if jobs.get_active_by_name(JOB_ROLE_NAME) is None:
        jobs.create(name=JOB_ROLE_NAME)
    print("Seed e2e kiosco listo (admin ficticio + cargo Operario).")


def main(*, create_engine_fn: CreateEngine = create_engine) -> None:
    try:
        require_explicit_test_authorization()
    except ValueError as exc:
        raise SystemExit(str(exc)) from exc
    try:
        test_url = validated_test_url(os.environ.get("TEST_DATABASE_URL", ""))
    except ValueError as exc:
        raise SystemExit(str(exc)) from exc

    engine = create_engine_fn(normalize_postgres_url(test_url), pool_pre_ping=True)
    try:
        with Session(engine, autoflush=False) as db:
            try:
                seed_test_data(db)
                db.commit()
            except Exception:
                db.rollback()
                raise
    finally:
        engine.dispose()


if __name__ == "__main__":
    sys.exit(main())
