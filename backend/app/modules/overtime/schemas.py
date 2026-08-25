"""Schemas de horas extra."""

import uuid
from datetime import date
from decimal import Decimal

from pydantic import BaseModel


class OvertimeDetectItem(BaseModel):
    work_date: date
    worked_minutes: int
    expected_minutes: int
    extra_minutes: int


class OvertimeValueItem(BaseModel):
    adjustment_id: uuid.UUID
    adjustment_date: date
    minutes: int
    rate: Decimal | None
    value: Decimal


class OvertimeValueOut(BaseModel):
    date_from: date
    date_to: date
    method: str | None
    overtime_minutes: int
    hourly_rate: Decimal | None
    value: Decimal
    breakdown: list[OvertimeValueItem]
