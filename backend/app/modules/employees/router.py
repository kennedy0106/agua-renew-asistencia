"""Rutas de empleados: /api/v1/employees

Permisos (decisión de negocio):
- GET (lista y detalle): cualquier usuario autenticado.
- POST / PATCH / deactivate: ADMIN y JEFE (BOSS) — tanto el admin general
  como cualquier usuario con rol ADMIN o BOSS pueden crear/editarlos.
  SUPERVISOR solo consulta.
"""

import uuid

from fastapi import APIRouter, Depends, status
from sqlalchemy.orm import Session

from app.core.permissions import get_current_user, require_any_role
from app.db.session import get_db
from app.modules.employees.schemas import EmployeeCreate, EmployeeOut, EmployeeUpdate
from app.modules.employees.service import EmployeeService

router = APIRouter(prefix="/api/v1/employees", tags=["employees"])

can_manage_employees = require_any_role("ADMIN", "BOSS")


def _to_out(employee) -> EmployeeOut:
    return EmployeeOut(
        id=employee.id,
        dni=employee.dni,
        employee_code=employee.employee_code,
        first_name=employee.first_name,
        last_name=employee.last_name,
        job_role_id=employee.job_role_id,
        job_role_name=employee.job_role.name if employee.job_role else None,
        hire_date=employee.hire_date,
        termination_date=employee.termination_date,
        active=employee.active,
        created_at=employee.created_at,
        updated_at=employee.updated_at,
    )


@router.get("", response_model=list[EmployeeOut])
def list_employees(
    active: bool | None = None,
    job_role_id: uuid.UUID | None = None,
    search: str | None = None,
    db: Session = Depends(get_db),
    _: object = Depends(get_current_user),
) -> list[EmployeeOut]:
    employees = EmployeeService(db).list_all(active=active, job_role_id=job_role_id, search=search)
    return [_to_out(e) for e in employees]


@router.post("", response_model=EmployeeOut, status_code=status.HTTP_201_CREATED)
def create_employee(payload: EmployeeCreate, db: Session = Depends(get_db), _: object = Depends(can_manage_employees)) -> EmployeeOut:
    employee = EmployeeService(db).create(
        dni=payload.dni,
        employee_code=payload.employee_code,
        first_name=payload.first_name,
        last_name=payload.last_name,
        job_role_id=payload.job_role_id,
        hire_date=payload.hire_date,
    )
    return _to_out(employee)


@router.get("/{employee_id}", response_model=EmployeeOut)
def get_employee(employee_id: uuid.UUID, db: Session = Depends(get_db), _: object = Depends(get_current_user)) -> EmployeeOut:
    return _to_out(EmployeeService(db).get(employee_id))


@router.patch("/{employee_id}", response_model=EmployeeOut)
def update_employee(employee_id: uuid.UUID, payload: EmployeeUpdate, db: Session = Depends(get_db), _: object = Depends(can_manage_employees)) -> EmployeeOut:
    employee = EmployeeService(db).update(
        employee_id,
        dni=payload.dni,
        employee_code=payload.employee_code,
        first_name=payload.first_name,
        last_name=payload.last_name,
        job_role_id=payload.job_role_id,
        hire_date=payload.hire_date,
        termination_date=payload.termination_date,
    )
    return _to_out(employee)


@router.post("/{employee_id}/deactivate", response_model=EmployeeOut)
def deactivate_employee(employee_id: uuid.UUID, db: Session = Depends(get_db), _: object = Depends(can_manage_employees)) -> EmployeeOut:
    return _to_out(EmployeeService(db).deactivate(employee_id))
