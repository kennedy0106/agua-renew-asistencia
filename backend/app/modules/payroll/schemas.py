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
    total: Decimal
    status: str
    notes: str | None
    created_at: datetime
    updated_at: datetime


class ManualAdjustmentRequest(BaseModel):
    amount: Decimal = Field(max_digits=12, decimal_places=2, description="Monto con signo (viáticos, bonos, descuentos)")
    notes: str | None = Field(default=None, max_length=255, description="Motivo (queda en auditoría)")
