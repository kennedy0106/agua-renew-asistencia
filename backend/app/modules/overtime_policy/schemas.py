"""Schemas de la política de horas extra."""

import uuid
from datetime import date, datetime
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, Field


class OvertimePolicyCreate(BaseModel):
    effective_from: date
    first_two_hours_rate: Decimal = Field(ge=25, max_digits=5, decimal_places=2)
    additional_hours_rate: Decimal = Field(ge=35, max_digits=5, decimal_places=2)
    reason: str = Field(min_length=3, max_length=500)


class OvertimePolicyOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    first_two_hours_rate: Decimal
    additional_hours_rate: Decimal
    effective_from: date
    effective_to: date | None
    reason: str
    created_at: datetime
    updated_at: datetime


class EffectiveOvertimeRates(BaseModel):
    first_two_hours_rate: Decimal
    additional_hours_rate: Decimal
    source: str  # "company_policy" | "employee_override"
