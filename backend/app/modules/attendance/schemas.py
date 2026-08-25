"""Schemas de asistencia."""

import uuid
from datetime import date, datetime

from pydantic import BaseModel, ConfigDict, Field


class IdentifyRequest(BaseModel):
    identifier: str = Field(min_length=1, max_length=20, description="DNI o código interno")


class CheckInRequest(BaseModel):
    employee_id: uuid.UUID


class CheckOutRequest(BaseModel):
    employee_id: uuid.UUID


class AttendanceRecordOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    employee_id: uuid.UUID
    work_date: date
    check_in_at: datetime
    check_out_at: datetime | None
    worked_minutes: int | None
    status: str
    notes: str | None
    created_at: datetime
    updated_at: datetime


class IdentifyResponse(BaseModel):
    employee: dict
    state: dict
    server_time: str
    server_time_label: str
