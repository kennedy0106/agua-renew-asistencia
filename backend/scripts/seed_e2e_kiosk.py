"""Datos ficticios para la suite Chromium + FastAPI + PostgreSQL desechable.

Solo se ejecuta con ALLOW_TEST_DB_RESET=1 y TEST_DATABASE_URL local.
No toca Neon ni bases que no sean asistencia_test.
"""

import os
import sys

from app.core.security import hash_password
from app.core.test_db import assert_disposable_postgres_url
from app.modules.job_roles.repository import JobRoleRepository
from app.modules.system_roles.repository import SystemRoleRepository
from app.modules.users.repository import UserRepository
from scripts.seed_roles import seed as seed_roles

ADMIN_USERNAME = "admin"
ADMIN_PASSWORD = "Admin123!"
JOB_ROLE_NAME = "Operario"


def main() -> None:
    if os.environ.get("ALLOW_TEST_DB_RESET") != "1":
        raise SystemExit("ALLOW_TEST_DB_RESET=1 es obligatorio para sembrar datos de e2e")
    url = os.environ.get("TEST_DATABASE_URL") or os.environ.get("DATABASE_URL") or ""
    try:
        assert_disposable_postgres_url(url)
    except ValueError as exc:
        raise SystemExit(str(exc)) from exc

    from app.db.session import SessionLocal

    if SessionLocal is None:
        raise SystemExit("ERROR: DATABASE_URL no está configurado")
    db = SessionLocal()
    try:
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
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
