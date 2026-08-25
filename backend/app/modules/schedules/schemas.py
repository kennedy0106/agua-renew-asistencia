"""Schemas de jornadas laborales."""

import uuid
from datetime import date, datetime

from pydantic import BaseModel, ConfigDict, Field

_MAX_DAY = 1440  # 24 h


class WorkScheduleCreate(BaseModel):
    effective_from: date
    monday_minutes: int = Field(default=0, ge=0, le=_MAX_DAY)
    tuesday_minutes: int = Field(default=0, ge=0, le=_MAX_DAY)
    wednesday_minutes: int = Field(default=0, ge=0, le=_MAX_DAY)
    thursday_minutes: int = Field(default=0, ge=0, le=_MAX_DAY)
    friday_minutes: int = Field(default=0, ge=0, le=_MAX_DAY)
    saturday_minutes: int = Field(default=0, ge=0, le=_MAX_DAY)
    sunday_minutes: int = Field(default=0, ge=0, le=_MAX_DAY)
    break_minutes: int = Field(default=0, ge=0, le=_MAX_DAY)


class WorkScheduleOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    employee_id: uuid.UUID
    monday_minutes: int
    tuesday_minutes: int
    wednesday_minutes: int
    thursday_minutes: int
    friday_minutes: int
    saturday_minutes: int
    sunday_minutes: int
    break_minutes: int
    effective_from: date
    effective_to: date | None
    created_at: datetime
    updated_at: datetime
