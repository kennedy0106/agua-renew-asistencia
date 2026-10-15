import uuid
from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, Field, field_validator

from app.core.text import require_visible_text


class WeeklyRestRuleCreate(BaseModel):
    employee_id: uuid.UUID
    weekly_rest_weekday: int = Field(ge=0, le=6)
    reference_daily_minutes: int = Field(gt=0, le=1440)
    source: str = Field(min_length=3, max_length=80)
    reason: str = Field(min_length=3, max_length=500)
    effective_from: date

    @field_validator("source", "reason")
    @classmethod
    def visible(cls, value: str) -> str:
        return require_visible_text(value, field="motivo")


class WeeklyRestRuleCorrect(BaseModel):
    employee_id: uuid.UUID
    weekly_rest_weekday: int = Field(ge=0, le=6)
    reference_daily_minutes: int = Field(gt=0, le=1440)
    source: str = Field(min_length=3, max_length=80)
    reason: str = Field(min_length=3, max_length=500)
    effective_from: date
    expected_version: int = Field(ge=1)
    idempotency_key: str = Field(min_length=8, max_length=128)

    @field_validator("source", "reason")
    @classmethod
    def visible(cls, value: str) -> str:
        return require_visible_text(value, field="motivo")


class RestSubstitutionCreate(BaseModel):
    employee_id: uuid.UUID
    original_date: date
    # Los clientes HST-01 publicados antes de CAL-03 representan descanso semanal.
    origin_kind: Literal["WEEKLY_REST", "HOLIDAY"] = "WEEKLY_REST"
    substitute_start: datetime
    substitute_end: datetime
    reference: str = Field(min_length=3, max_length=500)
    reason: str = Field(min_length=3, max_length=500)
    idempotency_key: str = Field(min_length=8, max_length=128)

    @field_validator("reference", "reason")
    @classmethod
    def visible(cls, value: str) -> str:
        return require_visible_text(value, field="motivo")


class SubstitutionAction(BaseModel):
    expected_version: int = Field(ge=1)
    reason: str = Field(min_length=3, max_length=500)
    idempotency_key: str = Field(min_length=8, max_length=128)
    evidence: dict | None = None

    @field_validator("reason")
    @classmethod
    def visible(cls, value: str) -> str:
        return require_visible_text(value, field="motivo")


class HolidayCalendarCreate(BaseModel):
    holiday_date: date
    name: str = Field(min_length=3, max_length=160)
    scope: str = Field(default="NATIONAL", min_length=3, max_length=40)
    day_kind: Literal["HOLIDAY", "COMPENSABLE", "MAY_DAY"] = "HOLIDAY"
    source: str = Field(min_length=3, max_length=250)

    @field_validator("name", "source")
    @classmethod
    def holiday_visible(cls, value: str) -> str:
        return require_visible_text(value, field="feriado")


class SpecialDayPreviewRequest(BaseModel):
    employee_id: uuid.UUID
    work_date: date
    source_kind: Literal["WEEKLY_REST", "HOLIDAY", "MAY_DAY_COINCIDENCE"] | None = None


class SpecialDayApprovalRequest(BaseModel):
    expected_version: int = Field(ge=1)
    preview_token: str = Field(min_length=16, max_length=128)
    idempotency_key: str = Field(min_length=8, max_length=128)
    reason: str = Field(min_length=3, max_length=500)

    @field_validator("reason")
    @classmethod
    def approval_visible(cls, value: str) -> str:
        return require_visible_text(value, field="motivo")


class SpecialDayReconcileRequest(BaseModel):
    expected_version: int = Field(ge=1)
    reference: str = Field(min_length=3, max_length=500)
    idempotency_key: str = Field(min_length=8, max_length=128)

    @field_validator("reference")
    @classmethod
    def reconciliation_visible(cls, value: str) -> str:
        return require_visible_text(value, field="referencia")
