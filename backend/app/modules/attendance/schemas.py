"""Schemas de asistencia."""

import uuid
from datetime import date, datetime

from pydantic import BaseModel, ConfigDict, Field


class IdentifyRequest(BaseModel):
    identifier: str = Field(min_length=1, max_length=80, description="DNI, código interno o payload QR AR:<token>")


class CheckInRequest(BaseModel):
    marking_token: str | None = None
    employee_id: uuid.UUID | None = Field(default=None, description="Compatibilidad local; prohibido en producción")


class CheckOutRequest(BaseModel):
    marking_token: str | None = None
    employee_id: uuid.UUID | None = Field(default=None, description="Compatibilidad local; prohibido en producción")


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
    marking_token: str


class AttendanceListItem(BaseModel):
    id: uuid.UUID
    employee_id: uuid.UUID
    employee_name: str | None
    job_role_name: str | None
    work_date: date
    check_in_at: datetime
    check_out_at: datetime | None
    worked_minutes: int | None
    expected_minutes: int
    difference_minutes: int | None
    status: str
    notes: str | None


class AttendanceSummary(BaseModel):
    employees_active: int
    present_today: int
    no_entry_today: int
    open_entries: int
    checked_out_today: int


class AttendanceDailyItem(BaseModel):
    employee_id: uuid.UUID
    employee_name: str | None
    work_date: date
    session_count: int
    gross_minutes: int
    break_minutes: int
    worked_minutes: int
    expected_minutes: int
    difference_minutes: int
    has_open_entry: bool
    incident_codes: list[str]


class AttendanceCorrection(BaseModel):
    """Corrección de un registro (Fase 8). El motivo es obligatorio.

    Campos opcionales: enviar explícitamente null para LIMPIAR
    check_out_at o notes (el backend recalcula lo derivado).
    """

    check_in_at: datetime | None = None
    check_out_at: datetime | None = None
    notes: str | None = Field(default=None, max_length=255)
    reason: str = Field(min_length=3, max_length=500)
