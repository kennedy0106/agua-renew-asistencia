"""Repositorio de empleados."""

import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session, joinedload

from app.modules.employees.models import Employee


class EmployeeRepository:
    def __init__(self, db: Session) -> None:
        self.db = db

    def get_by_id(self, employee_id: uuid.UUID) -> Employee | None:
        return self.db.scalar(
            select(Employee)
            .options(joinedload(Employee.job_role))
            .where(Employee.id == employee_id)
        )

    def get_by_dni(self, dni: str) -> Employee | None:
        return self.db.scalar(select(Employee).where(Employee.dni == dni))

    def get_by_employee_code(self, code: str) -> Employee | None:
        return self.db.scalar(select(Employee).where(Employee.employee_code == code))

    def employee_codes(self) -> list[str]:
        return list(self.db.scalars(select(Employee.employee_code).where(Employee.employee_code.like("EMP-%"))))

    def get_by_qr_token(self, qr_token: str) -> Employee | None:
        return self.db.scalar(
            select(Employee)
            .options(joinedload(Employee.job_role))
            .where(Employee.qr_token == qr_token)
        )

    def list_all(
        self,
        *,
        active: bool | None = None,
        job_role_id: uuid.UUID | None = None,
        search: str | None = None,
    ) -> list[Employee]:
        query = select(Employee).options(joinedload(Employee.job_role))
        if active is not None:
            query = query.where(Employee.active.is_(active))
        if job_role_id is not None:
            query = query.where(Employee.job_role_id == job_role_id)
        if search:
            like = f"%{search.strip()}%"
            query = query.where(
                Employee.first_name.ilike(like)
                | Employee.last_name.ilike(like)
                | Employee.dni.ilike(like)
                | Employee.employee_code.ilike(like)
            )
        query = query.order_by(Employee.active.desc(), Employee.last_name.asc(), Employee.first_name.asc())
        return list(self.db.scalars(query))

    def create(
        self,
        *,
        dni: str,
        employee_code: str,
        first_name: str,
        last_name: str,
        job_role_id: uuid.UUID,
        hire_date=None,
        qr_token: str | None = None,
    ) -> Employee:
        employee = Employee(
            dni=dni,
            employee_code=employee_code,
            first_name=first_name,
            last_name=last_name,
            job_role_id=job_role_id,
            hire_date=hire_date,
            qr_token=qr_token,
        )
        self.db.add(employee)
        self.db.commit()
        self.db.refresh(employee)
        return employee

    def update(
        self,
        employee: Employee,
        *,
        dni: str | None = None,
        employee_code: str | None = None,
        first_name: str | None = None,
        last_name: str | None = None,
        job_role_id: uuid.UUID | None = None,
        hire_date=None,
        termination_date=None,
    ) -> Employee:
        if dni is not None:
            employee.dni = dni
        if employee_code is not None:
            employee.employee_code = employee_code
        if first_name is not None:
            employee.first_name = first_name
        if last_name is not None:
            employee.last_name = last_name
        if job_role_id is not None:
            employee.job_role_id = job_role_id
        if hire_date is not None:
            employee.hire_date = hire_date
        if termination_date is not None:
            employee.termination_date = termination_date
        self.db.add(employee)
        self.db.commit()
        self.db.refresh(employee)
        return employee

    def deactivate(self, employee: Employee) -> Employee:
        employee.active = False
        self.db.add(employee)
        self.db.commit()
        self.db.refresh(employee)
        return employee

    def activate(self, employee: Employee) -> Employee:
        employee.active = True
        self.db.add(employee)
        self.db.commit()
        self.db.refresh(employee)
        return employee
