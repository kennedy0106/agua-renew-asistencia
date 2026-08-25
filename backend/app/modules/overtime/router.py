"""Rutas de horas extra: /api/v1/employees/{id}/overtime/*

ADMIN/BOSS únicamente: alimenta decisiones salariales. La detección es
informativa; el pago solo ocurre vía ajuste OVERTIME aprobado.
"""

import uuid
from datetime import date

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.core.permissions import require_any_role
from app.db.session import get_db
from app.modules.overtime.schemas import OvertimeDetectItem, OvertimeValueOut
from app.modules.overtime.service import OvertimeService

router = APIRouter(prefix="/api/v1/employees", tags=["overtime"])

require_salary_access = require_any_role("ADMIN", "BOSS")


@router.get("/{employee_id}/overtime/detect", response_model=list[OvertimeDetectItem])
def detect_overtime(
    employee_id: uuid.UUID,
    date_from: date,
    date_to: date,
    db: Session = Depends(get_db),
    _: object = Depends(require_salary_access),
) -> list[OvertimeDetectItem]:
    return OvertimeService(db).detect(employee_id, date_from, date_to)


@router.get("/{employee_id}/overtime/value", response_model=OvertimeValueOut)
def overtime_value(
    employee_id: uuid.UUID,
    date_from: date,
    date_to: date,
    db: Session = Depends(get_db),
    _: object = Depends(require_salary_access),
) -> OvertimeValueOut:
    return OvertimeService(db).value(employee_id, date_from, date_to)
