"""Schemas de planilla (payroll)."""

import uuid
from datetime import date, datetime
from decimal import Decimal

from pydantic import BaseModel, Field


class PayrollPeriodCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    start_date: date
    end_date: date


class PayrollPeriodOut(BaseModel):
    id: uuid.UUID
    name: str
    start_date: date
    end_date: date
    status: str
    root_period_id: uuid.UUID
    version: int
    supersedes_period_id: uuid.UUID | None
    rectification_reason: str | None
    created_at: datetime
    updated_at: datetime


class PayrollRecordOut(BaseModel):
    id: uuid.UUID
    payroll_period_id: uuid.UUID
    employee_id: uuid.UUID
    employee_name: str | None = None
    monthly_salary: Decimal
    worked_minutes: int
    expected_minutes: int
    overtime_minutes: int
    overtime_amount: Decimal
    adjustment_minutes: int
    adjustment_amount: Decimal
    base_salary: Decimal
    manual_adjustment: Decimal
    missing_salary_days: int = 0
    total: Decimal
    status: str
    notes: str | None
    created_at: datetime
    updated_at: datetime


class ManualAdjustmentRequest(BaseModel):
    amount: Decimal = Field(max_digits=12, decimal_places=2, description="Monto con signo (viáticos, bonos, descuentos)")
    notes: str = Field(min_length=3, max_length=255, description="Motivo obligatorio (queda en auditoría)")


class RectificationRequest(BaseModel):
    reason: str = Field(min_length=3, max_length=500)


class ReadinessIssue(BaseModel):
    code: str
    message: str
    employee_id: uuid.UUID | None = None
    attendance_record_id: uuid.UUID | None = None


class PayrollReadinessOut(BaseModel):
    ready: bool
    blockers: list[ReadinessIssue]
    warnings: list[ReadinessIssue]


class PayrollSummaryOut(BaseModel):
    period_id: uuid.UUID
    name: str
    start_date: date
    end_date: date
    status: str
    employee_count: int
    total_base: Decimal
    total_overtime: Decimal
    total_manual: Decimal
    total: Decimal
