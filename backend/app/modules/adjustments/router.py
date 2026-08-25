"""Rutas de ajustes de horas y saldo.

- POST/GET /api/v1/employees/{id}/adjustments: crear (ADMIN/BOSS) y listar
  (cualquier autenticado). Decisión documentada: los ajustes de horas los
  crean ADMIN/BOSS (el SUPERVISOR registra incidencias de marcación, no
  ajustes).
- GET /api/v1/employees/{id}/balance: cualquier autenticado.
- PATCH /api/v1/adjustments/{id}/approve|reject: ADMIN/BOSS.
"""

import uuid
from datetime import date

from fastapi import APIRouter, Depends, status
from sqlalchemy.orm import Session

from app.core.permissions import get_current_user, require_any_role
from app.db.session import get_db
from app.modules.adjustments.schemas import (
    AdjustmentCreate,
    AdjustmentOut,
    BalanceOut,
    RejectRequest,
)
from app.modules.adjustments.service import AdjustmentService
from app.modules.users.models import User

router = APIRouter(prefix="/api/v1", tags=["adjustments"])

can_manage_adjustments = require_any_role("ADMIN", "BOSS")


def _to_out(adjustment) -> AdjustmentOut:
    return AdjustmentOut(
        id=adjustment.id,
        employee_id=adjustment.employee_id,
        adjustment_date=adjustment.adjustment_date,
        minutes=adjustment.minutes,
        adjustment_type=adjustment.adjustment_type,
        reason=adjustment.reason,
        status=adjustment.status,
        approved_by=adjustment.approved_by,
        approved_by_username=(
            adjustment.approved_by_user.username if adjustment.approved_by_user else None
        ),
        approved_at=adjustment.approved_at,
        created_at=adjustment.created_at,
        updated_at=adjustment.updated_at,
    )


@router.post("/employees/{employee_id}/adjustments", response_model=AdjustmentOut, status_code=status.HTTP_201_CREATED)
def create_adjustment(
    employee_id: uuid.UUID,
    payload: AdjustmentCreate,
    db: Session = Depends(get_db),
    _: object = Depends(can_manage_adjustments),
) -> AdjustmentOut:
    adjustment = AdjustmentService(db).create(
        employee_id=employee_id,
        adjustment_date=payload.adjustment_date,
        minutes=payload.minutes,
        adjustment_type=payload.adjustment_type,
        reason=payload.reason,
    )
    return _to_out(adjustment)


@router.get("/employees/{employee_id}/adjustments", response_model=list[AdjustmentOut])
def list_adjustments(
    employee_id: uuid.UUID,
    db: Session = Depends(get_db),
    _: object = Depends(get_current_user),
) -> list[AdjustmentOut]:
    return [_to_out(a) for a in AdjustmentService(db).list_for_employee(employee_id)]


@router.get("/employees/{employee_id}/balance", response_model=BalanceOut)
def get_balance(
    employee_id: uuid.UUID,
    date_from: date | None = None,
    date_to: date | None = None,
    db: Session = Depends(get_db),
    _: object = Depends(get_current_user),
) -> BalanceOut:
    today = date.today()
    return AdjustmentService(db).balance(
        employee_id,
        date_from or today.replace(day=1),  # primer día del mes
        date_to or today,
    )


@router.patch("/adjustments/{adjustment_id}/approve", response_model=AdjustmentOut)
def approve_adjustment(
    adjustment_id: uuid.UUID,
    db: Session = Depends(get_db),
    user: User = Depends(can_manage_adjustments),
) -> AdjustmentOut:
    return _to_out(AdjustmentService(db).approve(adjustment_id, user.id))


@router.patch("/adjustments/{adjustment_id}/reject", response_model=AdjustmentOut)
def reject_adjustment(
    adjustment_id: uuid.UUID,
    payload: RejectRequest,
    db: Session = Depends(get_db),
    user: User = Depends(can_manage_adjustments),
) -> AdjustmentOut:
    return _to_out(AdjustmentService(db).reject(adjustment_id, user.id, payload.reason))
