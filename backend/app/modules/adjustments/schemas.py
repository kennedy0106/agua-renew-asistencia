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
    created_at: datetime
    updated_at: datetime


class BalanceOut(BaseModel):
    date_from: date
    date_to: date
    worked_minutes: int
    expected_minutes: int
    adjustment_minutes: int
    overtime_minutes: int = 0
    recovery_credit_minutes: int = 0
    balance_minutes: int
