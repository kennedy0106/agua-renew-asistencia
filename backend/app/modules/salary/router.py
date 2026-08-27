"""Rutas de configuración salarial: /api/v1/employees/{id}/salary-settings

PRIVACIDAD SALARIAL (MVP §6): todo este router exige ADMIN o BOSS.
SUPERVISOR y empleados quedan bloqueados incluso para lectura (403).
"""

import uuid
from datetime import date

from fastapi import APIRouter, Depends, status
from sqlalchemy.orm import Session

from app.core.permissions import require_any_role
from app.db.session import get_db
from app.modules.salary.schemas import SalarySettingCreate, SalarySettingOut
from app.modules.salary.service import SalaryService

router = APIRouter(prefix="/api/v1/employees", tags=["salary"])

require_salary_access = require_any_role("ADMIN", "BOSS")


@router.get("/{employee_id}/salary-settings", response_model=SalarySettingOut)
def get_salary(
    employee_id: uuid.UUID,
    date: date | None = None,
    db: Session = Depends(get_db),
    _: object = Depends(require_salary_access),
) -> SalarySettingOut:
    service = SalaryService(db)
    if date is not None:
        return service.get_for_date_or_404(employee_id, date)
    return service.get_current(employee_id)


@router.get("/{employee_id}/salary-settings/history", response_model=list[SalarySettingOut])
def get_salary_history(
    employee_id: uuid.UUID,
    db: Session = Depends(get_db),
    _: object = Depends(require_salary_access),
) -> list[SalarySettingOut]:
    return SalaryService(db).list_history(employee_id)


@router.post(
    "/{employee_id}/salary-settings",
    response_model=SalarySettingOut,
    status_code=status.HTTP_201_CREATED,
)
def set_salary(
    employee_id: uuid.UUID,
    payload: SalarySettingCreate,
    db: Session = Depends(get_db),
    user: object = Depends(require_salary_access),
) -> SalarySettingOut:
    return SalaryService(db).set_salary(
        employee_id=employee_id,
        monthly_salary=payload.monthly_salary,
        effective_from=payload.effective_from,
        overtime_enabled=payload.overtime_enabled,
        use_custom_overtime_rates=payload.use_custom_overtime_rates,
        custom_first_two_hours_rate=payload.custom_first_two_hours_rate,
        custom_additional_hours_rate=payload.custom_additional_hours_rate,
        performed_by=user.id if user is not None else None,
    )
