"""Rutas de planilla: /api/v1/payroll/* — SOLO ADMIN/BOSS (privacidad salarial).

Flujo: crear periodo (OPEN) → calcular (CALCULATED + preview) → ajustes
manuales con motivo → confirmar (CLOSED, inmutable).
"""

import uuid
from decimal import Decimal

from fastapi import APIRouter, Depends, status
from sqlalchemy.orm import Session

from app.core.permissions import require_any_role
from app.db.session import get_db
from app.modules.payroll.schemas import (
    ManualAdjustmentRequest,
    PayrollPeriodCreate,
    PayrollPeriodOut,
    PayrollDailyReportOut,
    PayrollReadinessOut,
    PayrollRecordOut,
    PayrollSummaryOut,
    RectificationRequest,
)
from app.modules.payroll.service import PayrollService
from app.modules.users.models import User

router = APIRouter(prefix="/api/v1/payroll", tags=["payroll"])

require_salary_access = require_any_role("ADMIN", "BOSS")


def _period_out(period) -> PayrollPeriodOut:
    return PayrollPeriodOut(
        id=period.id,
        name=period.name,
        start_date=period.start_date,
        end_date=period.end_date,
        status=period.status,
        root_period_id=period.root_period_id,
        version=period.version,
        supersedes_period_id=period.supersedes_period_id,
        rectification_reason=period.rectification_reason,
        created_at=period.created_at,
        updated_at=period.updated_at,
    )


def _record_out(record) -> PayrollRecordOut:
    return PayrollRecordOut(
        id=record.id,
        payroll_period_id=record.payroll_period_id,
        employee_id=record.employee_id,
        employee_name=(
            f"{record.employee.first_name} {record.employee.last_name}"
            if record.employee
            else None
        ),
        monthly_salary=record.monthly_salary,
        worked_minutes=record.worked_minutes,
        expected_minutes=record.expected_minutes,
        overtime_minutes=record.overtime_minutes,
        overtime_amount=record.overtime_amount,
        adjustment_minutes=record.adjustment_minutes,
        adjustment_amount=record.adjustment_amount,
        base_salary=record.base_salary,
        manual_adjustment=record.manual_adjustment,
        missing_salary_days=record.missing_salary_days,
        total=record.total,
        status=record.status,
        payable=record.payable,
        notes=record.notes,
        created_at=record.created_at,
        updated_at=record.updated_at,
    )


@router.post("/periods", response_model=PayrollPeriodOut, status_code=status.HTTP_201_CREATED)
def create_period(
    payload: PayrollPeriodCreate,
    db: Session = Depends(get_db),
    _: object = Depends(require_salary_access),
) -> PayrollPeriodOut:
    return _period_out(
        PayrollService(db).create_period(
            name=payload.name, start_date=payload.start_date, end_date=payload.end_date
        )
    )


@router.get("/periods", response_model=list[PayrollPeriodOut])
def list_periods(db: Session = Depends(get_db), _: object = Depends(require_salary_access)) -> list[PayrollPeriodOut]:
    return [_period_out(p) for p in PayrollService(db).list_periods()]


@router.post("/periods/{period_id}/calculate", response_model=list[PayrollRecordOut])
def calculate_period(
    period_id: uuid.UUID,
    db: Session = Depends(get_db),
    _: object = Depends(require_salary_access),
) -> list[PayrollRecordOut]:
    records = PayrollService(db).calculate(period_id)
    return [_record_out(r) for r in records]


@router.get("/periods/{period_id}/records", response_model=list[PayrollRecordOut])
def period_records(
    period_id: uuid.UUID,
    db: Session = Depends(get_db),
    _: object = Depends(require_salary_access),
) -> list[PayrollRecordOut]:
    return [_record_out(r) for r in PayrollService(db).list_records(period_id)]


@router.get("/periods/{period_id}/summary", response_model=PayrollSummaryOut)
def period_summary(
    period_id: uuid.UUID,
    db: Session = Depends(get_db),
    _: object = Depends(require_salary_access),
) -> PayrollSummaryOut:
    return PayrollService(db).summary(period_id)


@router.get("/periods/{period_id}/daily-report", response_model=PayrollDailyReportOut)
def period_daily_report(
    period_id: uuid.UUID,
    db: Session = Depends(get_db),
    _: object = Depends(require_salary_access),
) -> PayrollDailyReportOut:
    """Desglose diario informativo anclado al snapshot del periodo."""
    return PayrollService(db).daily_report(period_id)


@router.get("/periods/{period_id}/readiness", response_model=PayrollReadinessOut)
def period_readiness(
    period_id: uuid.UUID,
    db: Session = Depends(get_db),
    _: object = Depends(require_salary_access),
) -> PayrollReadinessOut:
    return PayrollService(db).readiness(period_id)


@router.post("/periods/{period_id}/rectifications", response_model=PayrollPeriodOut, status_code=status.HTTP_201_CREATED)
def create_rectification(
    period_id: uuid.UUID,
    payload: RectificationRequest,
    db: Session = Depends(get_db),
    user: User = Depends(require_salary_access),
) -> PayrollPeriodOut:
    return _period_out(PayrollService(db).create_rectification(period_id, payload.reason, user.id))


@router.patch("/records/{record_id}/adjustment", response_model=PayrollRecordOut)
def manual_adjustment(
    record_id: uuid.UUID,
    payload: ManualAdjustmentRequest,
    db: Session = Depends(get_db),
    user: User = Depends(require_salary_access),
) -> PayrollRecordOut:
    record = PayrollService(db).set_manual_adjustment(
        record_id, amount=payload.amount, notes=payload.notes, current_user_id=user.id
    )
    return _record_out(record)


@router.post("/periods/{period_id}/confirm", response_model=PayrollPeriodOut)
def confirm_period(
    period_id: uuid.UUID,
    db: Session = Depends(get_db),
    user: User = Depends(require_salary_access),
) -> PayrollPeriodOut:
    return _period_out(PayrollService(db).confirm(period_id, user.id))
