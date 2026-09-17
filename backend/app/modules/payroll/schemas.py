"""Schemas de planilla (payroll)."""

import uuid
from datetime import date, datetime
from decimal import Decimal

from pydantic import BaseModel, Field, field_validator

from app.core.text import require_visible_text


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
    payable: bool = True
    notes: str | None
    created_at: datetime
    updated_at: datetime


class ManualAdjustmentRequest(BaseModel):
    amount: Decimal = Field(max_digits=12, decimal_places=2, description="Monto con signo (viáticos, bonos, descuentos)")
    notes: str = Field(min_length=3, max_length=255, description="Motivo obligatorio (queda en auditoría)")

    @field_validator("notes")
    @classmethod
    def notes_visible(cls, value: str) -> str:
        return require_visible_text(value, field="motivo")


class RectificationRequest(BaseModel):
    reason: str = Field(min_length=3, max_length=500)

    @field_validator("reason")
    @classmethod
    def reason_visible(cls, value: str) -> str:
        return require_visible_text(value, field="motivo")


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


class PayrollDailyReportItemOut(BaseModel):
    """Importe informativo de una jornada dentro de un periodo calculado.

    El sueldo base se reparte entre los minutos pactados de cada día. Los
    ajustes manuales siguen siendo propios del periodo porque el modelo actual
    no les asigna una fecha concreta.
    """

    employee_id: uuid.UUID
    employee_name: str | None = None
    work_date: date
    worked_minutes: int
    ordinary_minutes: int = 0
    additional_minutes: int = 0
    recovery_minutes: int = 0
    expected_minutes: int
    recognized_minutes: int
    status: str
    base_amount: Decimal
    recognized_base_amount: Decimal
    overtime_minutes: int
    overtime_amount: Decimal
    recognized_overtime_amount: Decimal
    approved_adjustment_minutes: int
    approved_adjustment_amount: Decimal
    recognized_total_amount: Decimal
    review_difference_amount: Decimal


class PayrollEmployeeDailySummaryOut(BaseModel):
    employee_id: uuid.UUID
    employee_name: str | None = None
    worked_minutes: int
    ordinary_minutes: int = 0
    expected_minutes: int
    programmed_base_amount: Decimal
    recognized_base_amount: Decimal
    overtime_minutes: int
    recognized_overtime_amount: Decimal
    approved_adjustment_minutes: int
    approved_adjustment_amount: Decimal
    recognized_total_amount: Decimal
    future_pending_base_amount: Decimal
    review_difference_amount: Decimal
    manual_adjustment: Decimal
    official_total_snapshot: Decimal


class PayrollDailyReportOut(BaseModel):
    period_id: uuid.UUID
    start_date: date
    end_date: date
    daily: list[PayrollDailyReportItemOut]
    employees: list[PayrollEmployeeDailySummaryOut]
