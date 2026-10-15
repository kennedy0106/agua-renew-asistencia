"""Datos ficticios para la suite Chromium + FastAPI + PostgreSQL desechable.

Solo se ejecuta con ALLOW_TEST_DB_RESET=1 y TEST_DATABASE_URL explícita.
No toca Neon ni usa SessionLocal/DATABASE_URL de la aplicación.
"""

from __future__ import annotations

import os
import secrets
import sys
from collections.abc import Callable
from datetime import date
from decimal import Decimal

from sqlalchemy import Engine, create_engine, select
from sqlalchemy.orm import Session

from app.core.security import hash_password
from app.core.test_db import normalize_postgres_url, require_explicit_test_authorization, validated_test_url
from app.modules.job_roles.repository import JobRoleRepository
from app.modules.employees.models import Employee
from app.modules.salary.models import SalarySetting
from app.modules.schedules.models import WorkSchedule
from app.modules.system_roles.repository import SystemRoleRepository
from app.modules.users.repository import UserRepository
from scripts.seed_roles import seed as seed_roles

ADMIN_USERNAME = "admin"
ADMIN_PASSWORD = "Admin123!"
JOB_ROLE_NAME = "Operario"
TABLET_EMPLOYEES = (
    ("10000001", "TBL-ANA-01", "Ana", "Prueba Norte", Decimal("1500.00")),
    ("10000002", "TBL-BRU-02", "Bruno", "Prueba Sur", Decimal("1650.00")),
)

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
    job = jobs.get_active_by_name(JOB_ROLE_NAME)
    if job is None:
        jobs.create(name=JOB_ROLE_NAME)
        job = jobs.get_active_by_name(JOB_ROLE_NAME)
    if job is None:
        raise SystemExit("ERROR: no se pudo crear el cargo Operario")

    today = date.today()
    for dni, employee_code, first_name, last_name, monthly_salary in TABLET_EMPLOYEES:
        employee = db.scalar(select(Employee).where(Employee.employee_code == employee_code))
        if employee is None:
            employee = Employee(
                dni=dni,
                employee_code=employee_code,
                first_name=first_name,
                last_name=last_name,
                job_role_id=job.id,
                qr_token=secrets.token_urlsafe(32),
            )
            db.add(employee)
            db.flush()
        if db.scalar(select(WorkSchedule).where(WorkSchedule.employee_id == employee.id)) is None:
            db.add(
                WorkSchedule(
                    employee_id=employee.id,
                    effective_from=today,
                    monday_minutes=480,
                    tuesday_minutes=480,
                    wednesday_minutes=480,
                    thursday_minutes=480,
                    friday_minutes=480,
                    break_minutes=60,
                    break_applies_after_minutes=360,
                )
            )
        if db.scalar(select(SalarySetting).where(SalarySetting.employee_id == employee.id)) is None:
            db.add(
                SalarySetting(
                    employee_id=employee.id,
                    monthly_salary=monthly_salary,
                    effective_from=today,
                    overtime_enabled=False,
                    use_custom_overtime_rates=False,
                )
            )
    print("Seed e2e kiosco listo (admin, cargo y dos empleados ficticios con jornada y sueldo).")


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
