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

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.core.permissions import get_current_operational_user, require_any_role
from app.db.session import get_db
from app.modules.adjustments.schemas import (
    AdjustmentCreate,
    AdjustmentApprove,
    AdjustmentOut,
    AdjustmentUpdate,
    AdjustmentVoid,
    BalanceOut,
    RejectRequest,
)
from app.modules.adjustments.service import AdjustmentService
from app.modules.users.models import User

router = APIRouter(prefix="/api/v1", tags=["adjustments"])

can_manage_adjustments = require_any_role("ADMIN", "BOSS")


def _to_out(adjustment, service: AdjustmentService) -> AdjustmentOut:
    # A replay is intentionally a frozen JSON receipt rather than the current
    # mutable row (a later approve/void must not rewrite an earlier answer).
    if isinstance(adjustment, dict):
        return AdjustmentOut.model_validate(adjustment)
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
        version=adjustment.version,
        supersedes_id=adjustment.supersedes_id,
        voided_at=adjustment.voided_at,
        voided_by=adjustment.voided_by,
        void_reason=adjustment.void_reason,
        approval_snapshot=(
            service.approval_snapshot(adjustment)
            if adjustment.status == "PENDING" and adjustment.voided_at is None
            else adjustment.approval_snapshot_data
        ),
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
    return _to_out(adjustment, AdjustmentService(db))


@router.get("/employees/{employee_id}/adjustments", response_model=list[AdjustmentOut])
def list_adjustments(
    employee_id: uuid.UUID,
    include_voided: bool = False,
    db: Session = Depends(get_db),
    _: object = Depends(get_current_operational_user),
) -> list[AdjustmentOut]:
    service = AdjustmentService(db)
    rows = service.list_for_employee_including_voided(employee_id) if include_voided else service.list_for_employee(employee_id)
    return [_to_out(a, service) for a in rows]


@router.get("/employees/{employee_id}/balance", response_model=BalanceOut)
def get_balance(
    employee_id: uuid.UUID,
    date_from: date | None = None,
    date_to: date | None = None,
    db: Session = Depends(get_db),
    _: object = Depends(get_current_operational_user),
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
    payload: AdjustmentApprove | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(can_manage_adjustments),
) -> AdjustmentOut:
    service = AdjustmentService(db)
    if payload is None:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail={"code": "PREVIEW_REQUIRED", "message": "La aprobación exige versión, contenido e importe previsualizados"})
    return _to_out(service.approve_versioned(
        adjustment_id, expected_version=payload.expected_version,
        expected_snapshot=payload.expected_snapshot, idempotency_key=payload.idempotency_key,
        actor_id=user.id,
    ), service)


@router.patch("/adjustments/{adjustment_id}/reject", response_model=AdjustmentOut)
def reject_adjustment(
    adjustment_id: uuid.UUID,
    payload: RejectRequest,
    db: Session = Depends(get_db),
    user: User = Depends(can_manage_adjustments),
) -> AdjustmentOut:
    if payload.expected_version is None or payload.idempotency_key is None:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail={"code": "VERSION_AND_KEY_REQUIRED", "message": "El rechazo exige versión e identificador de operación"})
    service = AdjustmentService(db)
    return _to_out(service.reject_versioned(
        adjustment_id, expected_version=payload.expected_version, reason=payload.reason,
        idempotency_key=payload.idempotency_key, actor_id=user.id,
    ), service)


@router.patch("/adjustments/{adjustment_id}", response_model=AdjustmentOut)
def update_adjustment(
    adjustment_id: uuid.UUID,
    payload: AdjustmentUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(can_manage_adjustments),
) -> AdjustmentOut:
    service = AdjustmentService(db)
    return _to_out(service.update_versioned(
        adjustment_id, adjustment_date=payload.adjustment_date, minutes=payload.minutes,
        adjustment_type=payload.adjustment_type, reason=payload.reason,
        expected_version=payload.expected_version, idempotency_key=payload.idempotency_key,
        actor_id=user.id,
    ), service)


@router.post("/adjustments/{adjustment_id}/void", response_model=AdjustmentOut)
def void_adjustment(
    adjustment_id: uuid.UUID,
    payload: AdjustmentVoid,
    db: Session = Depends(get_db),
    user: User = Depends(can_manage_adjustments),
) -> AdjustmentOut:
    service = AdjustmentService(db)
    return _to_out(service.void_versioned(
        adjustment_id, expected_version=payload.expected_version, reason=payload.reason,
        idempotency_key=payload.idempotency_key, actor_id=user.id,
    ), service)
