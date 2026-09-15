"""Rutas de empleados: /api/v1/employees

Permisos (decisión de negocio):
- GET (lista y detalle): cualquier usuario autenticado.
- POST / PATCH / deactivate: ADMIN y JEFE (BOSS) — tanto el admin general
  como cualquier usuario con rol ADMIN o BOSS pueden crear/editarlos.
  SUPERVISOR solo consulta.
"""

import io
import uuid

from fastapi import APIRouter, Depends, Response, status
from sqlalchemy.orm import Session

from app.core.permissions import get_current_operational_user, require_any_role
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
        qr_token=employee.qr_token,
        created_at=employee.created_at,
        updated_at=employee.updated_at,
    )


@router.get("", response_model=list[EmployeeOut])
def list_employees(
    active: bool | None = None,
    job_role_id: uuid.UUID | None = None,
    search: str | None = None,
    db: Session = Depends(get_db),
    _: object = Depends(get_current_operational_user),
) -> list[EmployeeOut]:
    employees = EmployeeService(db).list_all(active=active, job_role_id=job_role_id, search=search)
    return [_to_out(e) for e in employees]


@router.post("", response_model=EmployeeOut, status_code=status.HTTP_201_CREATED)
def create_employee(payload: EmployeeCreate, db: Session = Depends(get_db), _: object = Depends(can_manage_employees)) -> EmployeeOut:
    employee = EmployeeService(db).create(
        dni=payload.dni,
        first_name=payload.first_name,
        last_name=payload.last_name,
        job_role_id=payload.job_role_id,
        hire_date=payload.hire_date,
    )
    return _to_out(employee)


@router.get("/{employee_id}", response_model=EmployeeOut)
def get_employee(employee_id: uuid.UUID, db: Session = Depends(get_db), _: object = Depends(get_current_operational_user)) -> EmployeeOut:
    return _to_out(EmployeeService(db).get(employee_id))


@router.patch("/{employee_id}", response_model=EmployeeOut)
def update_employee(employee_id: uuid.UUID, payload: EmployeeUpdate, db: Session = Depends(get_db), _: object = Depends(can_manage_employees)) -> EmployeeOut:
    employee = EmployeeService(db).update(
        employee_id,
        dni=payload.dni,
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


@router.post("/{employee_id}/activate", response_model=EmployeeOut)
def activate_employee(employee_id: uuid.UUID, db: Session = Depends(get_db), _: object = Depends(can_manage_employees)) -> EmployeeOut:
    """Reactivar un empleado cesado (no borra historial; solo active = True)."""
    return _to_out(EmployeeService(db).activate(employee_id))


@router.post("/{employee_id}/qr/rotate", response_model=EmployeeOut)
def rotate_employee_qr(
    employee_id: uuid.UUID, db: Session = Depends(get_db), _: object = Depends(can_manage_employees)
) -> EmployeeOut:
    """Revoca el QR actual y genera uno nuevo. El payload anterior deja de identificar."""
    return _to_out(EmployeeService(db).rotate_qr(employee_id))


@router.get("/{employee_id}/qr", response_class=Response)
def get_employee_qr(employee_id: uuid.UUID, db: Session = Depends(get_db), _: object = Depends(get_current_operational_user)) -> Response:
    """QR único del empleado (SVG). Escanea a un identificador estable: AR:<qr_token>.

    El token es aleatorio y único (server-side); la imagen se genera al vuelo
    a partir de él. No se expone el DNI ni el código interno en el QR.
    """
    employee = EmployeeService(db).get(employee_id)
    payload = f"AR:{employee.qr_token}"

    import qrcode
    import qrcode.image.svg

    factory = qrcode.image.svg.SvgPathImage
    img = qrcode.make(payload, image_factory=factory, box_size=10, border=2)
    buffer = io.BytesIO()
    img.save(buffer)
    svg = buffer.getvalue().decode("utf-8")

    return Response(
        content=svg,
        media_type="image/svg+xml",
        headers={"Content-Disposition": f'inline; filename="qr-{employee.employee_code}.svg"'},
    )
