"""Rutas de empleados: /api/v1/employees

Permisos (decisión de negocio):
- GET (lista y detalle): cualquier usuario autenticado.
- POST / PATCH / deactivate: ADMIN y JEFE (BOSS) — tanto el admin general
  como cualquier usuario con rol ADMIN o BOSS pueden crear/editarlos.
  SUPERVISOR solo consulta.
"""

import io
import uuid
from hashlib import sha256

from fastapi import APIRouter, Depends, Request, Response, status
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
def get_employee_qr(
    employee_id: uuid.UUID,
    request: Request,
    format: str = "svg",
    db: Session = Depends(get_db),
    _: object = Depends(get_current_operational_user),
) -> Response:
    """QR único del empleado (SVG). Escanea a un identificador estable: AR:<qr_token>.

    El token es aleatorio y único (server-side); la imagen se genera al vuelo
    a partir de él. No se expone el DNI ni el código interno en el QR.
    """
    employee = EmployeeService(db).get(employee_id)
    output_format = format.lower()
    if output_format not in {"svg", "png", "jpg", "jpeg"}:
        return Response(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, content="Formato QR no soportado")
    payload = f"AR:{employee.qr_token}"
    extension = "jpg" if output_format == "jpeg" else output_format
    etag = f'"{sha256(f"{employee.qr_token}:{extension}:591".encode()).hexdigest()}"'
    headers = {
        "ETag": etag,
        # La URL del QR se mantiene estable para el empleado. Obligar la
        # revalidación evita que, tras rotarlo, una tablet muestre la imagen
        # anterior desde su caché local.
        "Cache-Control": "private, no-cache",
        "Vary": "Cookie",
    }
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=status.HTTP_304_NOT_MODIFIED, headers=headers)

    import qrcode
    buffer = io.BytesIO()
    if output_format == "svg":
        import qrcode.image.svg

        img = qrcode.make(payload, image_factory=qrcode.image.svg.SvgPathImage, box_size=10, border=2)
        img.save(buffer)
        content: bytes | str = buffer.getvalue().decode("utf-8")
        media_type = "image/svg+xml"
    else:
        from PIL import Image

        # 5 × 5 cm a 300 dpi ≈ 591 px. Elegimos un módulo entero y centramos
        # el QR en un lienzo blanco: no se interpola ni se vuelve borroso.
        qr = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_H, box_size=1, border=4)
        qr.add_data(payload)
        qr.make(fit=True)
        modules = qr.modules_count + (qr.border * 2)
        box_size = max(1, 591 // modules)
        image = qr.make_image(fill_color="black", back_color="white", image_factory=None).convert("RGB")
        image = image.resize((modules * box_size, modules * box_size), resample=Image.Resampling.NEAREST)
        canvas = Image.new("RGB", (591, 591), "white")
        offset = ((591 - image.width) // 2, (591 - image.height) // 2)
        canvas.paste(image, offset)
        save_format = "JPEG" if extension == "jpg" else "PNG"
        canvas.save(buffer, format=save_format, dpi=(300, 300), quality=95, optimize=True)
        content = buffer.getvalue()
        media_type = "image/jpeg" if extension == "jpg" else "image/png"

    return Response(
        content=content,
        media_type=media_type,
        headers={**headers, "Content-Disposition": f'inline; filename="qr-{employee.employee_code}.{extension}"'},
    )
