"""Servicio de empleados: validaciones y reglas de negocio.

- DNI peruano: exactamente 8 dígitos.
- DNI y código interno únicos (409 si ya existen).
- El cargo laboral debe existir.
- Cesado = INACTIVO (nunca se borra el historial).
"""

import re
import secrets
import uuid
from datetime import datetime

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.core.timezone import lima_tz
from app.modules.employees.models import Employee
from app.modules.employees.repository import EmployeeRepository
from app.modules.job_roles.repository import JobRoleRepository
from app.modules.salary.repository import SalarySettingRepository
from app.modules.schedules.repository import WorkScheduleRepository

_DNI_RE = re.compile(r"^\d{8}$")


class EmployeeService:
    def __init__(self, db: Session) -> None:
        self.db = db
        self.repo = EmployeeRepository(db)

    def list_all(self, *, active: bool | None = None, job_role_id: uuid.UUID | None = None, search: str | None = None) -> list[Employee]:
        return self.repo.list_all(active=active, job_role_id=job_role_id, search=search)

    def get(self, employee_id: uuid.UUID) -> Employee:
        employee = self.repo.get_by_id(employee_id)
        if employee is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Empleado no encontrado")
        return employee

    def create(
        self,
        *,
        dni: str,
        employee_code: str,
        first_name: str,
        last_name: str,
        job_role_id: uuid.UUID,
        hire_date=None,
    ) -> Employee:
        dni = dni.strip()
        employee_code = employee_code.strip()
        first_name = first_name.strip()
        last_name = last_name.strip()

        if not _DNI_RE.fullmatch(dni):
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="El DNI debe tener exactamente 8 dígitos",
            )
        if not first_name or not last_name:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Nombres y apellidos son obligatorios",
            )
        if not employee_code:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="El código interno es obligatorio",
            )
        self._ensure_unique(dni=dni, employee_code=employee_code)
        self._ensure_job_role_exists(job_role_id)

        # Token QR único (server-side, aleatorio, impredecible).
        qr_token = secrets.token_urlsafe(32)

        return self.repo.create(
            dni=dni,
            employee_code=employee_code,
            first_name=first_name,
            last_name=last_name,
            job_role_id=job_role_id,
            hire_date=hire_date,
            qr_token=qr_token,
        )

    def update(
        self,
        employee_id: uuid.UUID,
        *,
        dni: str | None = None,
        employee_code: str | None = None,
        first_name: str | None = None,
        last_name: str | None = None,
        job_role_id: uuid.UUID | None = None,
        hire_date=None,
        termination_date=None,
    ) -> Employee:
        employee = self.get(employee_id)

        if dni is not None:
            dni = dni.strip()
            if not _DNI_RE.fullmatch(dni):
                raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="El DNI debe tener exactamente 8 dígitos")
            self._ensure_unique(dni=dni, exclude_employee_id=employee_id)
        if employee_code is not None:
            employee_code = employee_code.strip()
            if not employee_code:
                raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="El código interno es obligatorio")
            self._ensure_unique(employee_code=employee_code, exclude_employee_id=employee_id)
        if job_role_id is not None:
            self._ensure_job_role_exists(job_role_id)

        return self.repo.update(
            employee,
            dni=dni,
            employee_code=employee_code,
            first_name=first_name.strip() if first_name is not None else None,
            last_name=last_name.strip() if last_name is not None else None,
            job_role_id=job_role_id,
            hire_date=hire_date,
            termination_date=termination_date,
        )

    def deactivate(self, employee_id: uuid.UUID) -> Employee:
        employee = self.get(employee_id)
        if employee.active:
            # A4: cerrar la vigencia activa de sueldo y jornada al cesar.
            # No se borra historial; solo se cierra effective_to = hoy (Lima).
            today = datetime.now(lima_tz()).date()
            salary_repo = SalarySettingRepository(self.db)
            active_salary = salary_repo.get_active(employee_id)
            if active_salary is not None:
                salary_repo.close_active(employee_id, today)
            schedule_repo = WorkScheduleRepository(self.db)
            active_schedule = schedule_repo.get_active(employee_id)
            if active_schedule is not None:
                schedule_repo.close_active(employee_id, today)
        return self.repo.deactivate(employee)

    def activate(self, employee_id: uuid.UUID) -> Employee:
        employee = self.get(employee_id)
        if not employee.active:
            return self.repo.activate(employee)
        return employee

    # --- helpers ---

    def _ensure_unique(self, *, dni: str | None = None, employee_code: str | None = None, exclude_employee_id: uuid.UUID | None = None) -> None:
        if dni is not None:
            existing = self.repo.get_by_dni(dni)
            if existing is not None and existing.id != exclude_employee_id:
                raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=f"Ya existe un empleado con DNI {dni}")
        if employee_code is not None:
            existing = self.repo.get_by_employee_code(employee_code)
            if existing is not None and existing.id != exclude_employee_id:
                raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=f"Ya existe un empleado con código '{employee_code}'")

    def _ensure_job_role_exists(self, job_role_id: uuid.UUID) -> None:
        role = JobRoleRepository(self.db).get_by_id(job_role_id)
        if role is None:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="El cargo laboral no existe")
