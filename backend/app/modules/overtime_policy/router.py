"""Rutas de la política general de horas extra (seccion_horas_extra.md §17).

- GET /overtime-policy           → política vigente (ADMIN/BOSS)
- GET /overtime-policy/history   → historial (ADMIN/BOSS)
- GET /overtime-policy/effective → tasas efectivas para un empleado/fecha (ADMIN/BOSS)
- POST /overtime-policy          → nueva política (ADMIN/BOSS; vigencia + motivo)
"""

import uuid
from datetime import date

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.orm import Session

from app.core.permissions import require_any_role
from app.db.session import get_db
from app.modules.overtime_policy.schemas import (
    EffectiveOvertimeRates,
    OvertimePolicyCreate,
    OvertimePolicyOut,
)
from app.modules.overtime_policy.service import OvertimePolicyService

router = APIRouter(prefix="/api/v1/overtime-policy", tags=["overtime-policy"])

require_manage = require_any_role("ADMIN", "BOSS")


@router.get("", response_model=OvertimePolicyOut | None)
def get_active_policy(
    db: Session = Depends(get_db),
    _: object = Depends(require_manage),
):
    return OvertimePolicyService(db).get_active()


@router.get("/history", response_model=list[OvertimePolicyOut])
def get_policy_history(
    db: Session = Depends(get_db),
    _: object = Depends(require_manage),
):
    return OvertimePolicyService(db).list_history()


@router.get("/effective", response_model=EffectiveOvertimeRates)
def get_effective_rates(
    employee_id: uuid.UUID = Query(...),
    date: date = Query(...),
    db: Session = Depends(get_db),
    _: object = Depends(require_manage),
):
    return OvertimePolicyService(db).get_effective_overtime_rates(employee_id, date)


@router.post("", response_model=OvertimePolicyOut, status_code=status.HTTP_201_CREATED)
def set_policy(
    payload: OvertimePolicyCreate,
    db: Session = Depends(get_db),
    user: object = Depends(require_manage),
):
    return OvertimePolicyService(db).set_policy(
        first_two_hours_rate=payload.first_two_hours_rate,
        additional_hours_rate=payload.additional_hours_rate,
        effective_from=payload.effective_from,
        reason=payload.reason,
        performed_by=user.id if user is not None else None,
    )
