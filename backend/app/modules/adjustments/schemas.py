"""Schemas de ajustes de horas."""

import uuid
from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, Field, field_validator

from app.core.text import require_visible_text


class AdjustmentCreate(BaseModel):
    adjustment_date: date
    minutes: int = Field(ge=-1440, le=1440, description="Minutos, con signo (ej. +200 recuperación, -120 permiso)")
    adjustment_type: Literal["PERMISO", "RECUPERACION", "OTRO", "OVERTIME"]
    reason: str = Field(min_length=3, max_length=500)

    @field_validator("reason")
    @classmethod
    def reason_visible(cls, value: str) -> str:
        return require_visible_text(value, field="motivo")


class RejectRequest(BaseModel):
    reason: str = Field(min_length=3, max_length=500)
    expected_version: int | None = Field(default=None, ge=1)
    idempotency_key: str | None = Field(default=None, min_length=8, max_length=128)

    @field_validator("reason")
    @classmethod
    def reason_visible(cls, value: str) -> str:
        return require_visible_text(value, field="motivo")


class AdjustmentOut(BaseModel):
    id: uuid.UUID
    employee_id: uuid.UUID
    adjustment_date: date
    minutes: int
    adjustment_type: str
    reason: str
    status: str
    approved_by: uuid.UUID | None
    approved_by_username: str | None
    approved_at: datetime | None
    version: int = 1
    supersedes_id: uuid.UUID | None = None
    voided_at: datetime | None = None
    voided_by: uuid.UUID | None = None
    void_reason: str | None = None
    approval_snapshot: dict | None = None
    created_at: datetime
    updated_at: datetime


class AdjustmentUpdate(BaseModel):
    adjustment_date: date
    minutes: int = Field(ge=-1440, le=1440)
    adjustment_type: Literal["PERMISO", "RECUPERACION", "OTRO", "OVERTIME"]
    reason: str = Field(min_length=3, max_length=500)
    expected_version: int = Field(ge=1)
    idempotency_key: str = Field(min_length=8, max_length=128)

    @field_validator("reason")
    @classmethod
    def reason_visible(cls, value: str) -> str:
        return require_visible_text(value, field="motivo")


class AdjustmentVoid(BaseModel):
    expected_version: int = Field(ge=1)
    reason: str = Field(min_length=3, max_length=500)
    idempotency_key: str = Field(min_length=8, max_length=128)

    @field_validator("reason")
    @classmethod
    def reason_visible(cls, value: str) -> str:
        return require_visible_text(value, field="motivo")


class AdjustmentApprove(BaseModel):
    expected_version: int = Field(ge=1)
    expected_snapshot: dict
    idempotency_key: str = Field(min_length=8, max_length=128)


class BalanceOut(BaseModel):
    date_from: date
    date_to: date
    worked_minutes: int
    actual_worked_minutes: int = 0
    ordinary_minutes: int = 0
    expected_minutes: int
    adjustment_minutes: int
    overtime_minutes: int = 0
    recovery_credit_minutes: int = 0
    balance_minutes: int
