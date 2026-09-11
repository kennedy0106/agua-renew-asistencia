"""Schemas de horas extra (tramos diarios, seccion_horas_extra.md)."""

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
    adjustment_date: date
    minutes: int
    first_two_minutes: int
    additional_minutes: int
    first_two_hours_rate: Decimal
    additional_hours_rate: Decimal
    source: str
    hourly_rate: Decimal
    value: Decimal
    skip_reason: str | None = None


class OvertimeValueOut(BaseModel):
    date_from: date
    date_to: date
    overtime_minutes: int
    value: Decimal
    breakdown: list[OvertimeValueItem]
