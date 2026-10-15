"""Schemas de asistencia."""

import uuid
from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.core.text import require_visible_text


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
    event_type: str | None = None


class EvidenceRequest(BaseModel):
    marking_token: str
    image_base64: str = Field(min_length=8, max_length=3_000_000)
    content_type: str = Field(default="image/jpeg", max_length=40)


class AttemptStatusRequest(BaseModel):
    marking_token: str


AttemptState = Literal["CONFIRMED", "PENDING", "EXPIRED_UNCONFIRMED", "CANCELLED", "REVIEWED"]


class AttemptStatusResponse(BaseModel):
    state: AttemptState
    record: AttendanceRecordOut | None = None
    evidence_ready: bool = False
    write_token_valid: bool = False
    can_restart: bool = False
    nonce: str | None = None
    resolution_id: str | None = None
    reason: str | None = None


class AttemptResolveRequest(BaseModel):
    marking_token: str
    reason_code: Literal["TOKEN_EXPIRED", "PHOTO_RETAKE", "USER_CANCELLED"]


class AttemptReviewRequest(BaseModel):
    reason: str = Field(min_length=3, max_length=500)

    @field_validator("reason")
    @classmethod
    def reason_visible(cls, value: str) -> str:
        return require_visible_text(value, field="motivo")


class IdentifyResponse(BaseModel):
    employee: dict
    state: dict
    server_time: str
    server_time_label: str
    marking_token: str
    marking_action: str


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
    break_source: Literal["SCHEDULE", "OVERRIDE", "NONE"]
    override_requested_minutes: int | None = None
    override_limited: bool = False
    worked_minutes: int
    ordinary_minutes: int = 0
    additional_minutes: int = 0
    recovery_minutes: int = 0
    expected_minutes: int
    difference_minutes: int
    has_open_entry: bool
    incident_codes: list[str]


class AttendanceBreakOverrideRequest(BaseModel):
    requested_break_minutes: int = Field(ge=0, le=1440)
    reason: str = Field(min_length=3, max_length=500)

    @field_validator("reason")
    @classmethod
    def reason_visible(cls, value: str) -> str:
        return require_visible_text(value, field="motivo")


class AttendanceBreakOverrideDeleteRequest(BaseModel):
    reason: str = Field(min_length=3, max_length=500)

    @field_validator("reason")
    @classmethod
    def reason_visible(cls, value: str) -> str:
        return require_visible_text(value, field="motivo")


class AttendanceCorrection(BaseModel):
    """Corrección de un registro (Fase 8). El motivo es obligatorio.

    Campos opcionales: enviar explícitamente null para LIMPIAR
    check_out_at o notes (el backend recalcula lo derivado).
    """

    check_in_at: datetime | None = None
    check_out_at: datetime | None = None
    notes: str | None = Field(default=None, max_length=255)
    reason: str = Field(min_length=3, max_length=500)

    @field_validator("reason")
    @classmethod
    def reason_visible(cls, value: str) -> str:
        return require_visible_text(value, field="motivo")
