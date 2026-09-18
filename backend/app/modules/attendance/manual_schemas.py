import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import Literal
from pydantic import BaseModel, Field, model_validator

class RecoveryAllocationIn(BaseModel):
    commitment_id: uuid.UUID
    minutes: int = Field(gt=0, le=1440)

class ManualDayIn(BaseModel):
    employee_id: uuid.UUID
    worked_minutes_net: int = Field(ge=0, le=1440)
    normal_minutes: int = Field(ge=0, le=1440)
    additional_minutes: int = Field(ge=0, le=1440)
    recovery_minutes: int = Field(ge=0, le=1440)
    known_check_in_at: datetime | None = None
    known_check_out_at: datetime | None = None
    known_break_minutes: int | None = Field(default=None, ge=0, le=1440)
    day_context: Literal["ORDINARY", "UNSCHEDULED", "SPECIAL"] = "ORDINARY"
    source_reference: str | None = Field(default=None, max_length=200)
    payment_method: Literal["OVERTIME", "REVIEWED"] | None = None
    payment_concept: str | None = Field(default=None, max_length=120)
    reviewed_additional_amount: Decimal | None = Field(default=None, gt=0)
    reason: str = Field(min_length=3, max_length=500)
    recovery_allocations: list[RecoveryAllocationIn] = []

    @model_validator(mode="after")
    def parts_and_allocations_match(self):
        if not self.reason.strip():
            raise ValueError("REASON_REQUIRED")
        if self.worked_minutes_net != self.normal_minutes + self.additional_minutes + self.recovery_minutes:
            raise ValueError("MINUTE_ALLOCATION_MISMATCH")
        if sum(item.minutes for item in self.recovery_allocations) != self.recovery_minutes:
            raise ValueError("RECOVERY_ALLOCATION_MISMATCH")
        if len({item.commitment_id for item in self.recovery_allocations}) != len(self.recovery_allocations):
            raise ValueError("DUPLICATE_RECOVERY_COMMITMENT")
        if self.additional_minutes and self.payment_method is None:
            raise ValueError("PAYMENT_METHOD_REQUIRED")
        if self.additional_minutes and self.day_context != "ORDINARY" and self.payment_method == "OVERTIME":
            raise ValueError("SPECIAL_CONTEXT_REQUIRES_REVIEWED_PAYMENT")
        if self.payment_method == "REVIEWED" and self.additional_minutes:
            if (self.reviewed_additional_amount is None or not self.payment_concept
                    or not self.payment_concept.strip() or not self.source_reference
                    or not self.source_reference.strip()):
                raise ValueError("REVIEWED_PAYMENT_DETAILS_REQUIRED")
        if self.reviewed_additional_amount is not None and self.payment_method != "REVIEWED":
            raise ValueError("REVIEWED_PAYMENT_METHOD_REQUIRED")
        for known_time in (self.known_check_in_at, self.known_check_out_at):
            if known_time is not None and known_time.tzinfo is None:
                raise ValueError("KNOWN_TIME_TIMEZONE_REQUIRED")
        return self

class ManualBatchIn(BaseModel):
    work_date: date
    rows: list[ManualDayIn] = Field(min_length=1, max_length=50)
    idempotency_key: str = Field(min_length=8, max_length=128)
    approve_additional: bool = False
    # A preview is a server-derived representation of both the content and
    # the valuation.  It is deliberately short lived/stateless: a change in
    # salary, policy, schedule or row data changes the hash and requires a
    # new explicit preview.
    preview_token: str | None = Field(default=None, min_length=64, max_length=64)
    editing_manual_day_id: uuid.UUID | None = None
    expected_version: int | None = Field(default=None, ge=1)


class ManualDayTemplate(BaseModel):
    """Valores comunes de una carga multidía de un único empleado."""

    worked_minutes_net: int = Field(ge=0, le=1440)
    normal_minutes: int = Field(ge=0, le=1440)
    additional_minutes: int = Field(ge=0, le=1440)
    recovery_minutes: int = Field(ge=0, le=1440)
    known_check_in_at: datetime | None = None
    known_check_out_at: datetime | None = None
    known_break_minutes: int | None = Field(default=None, ge=0, le=1440)
    day_context: Literal["ORDINARY", "UNSCHEDULED", "SPECIAL"] = "ORDINARY"
    source_reference: str | None = Field(default=None, max_length=200)
    payment_method: Literal["OVERTIME", "REVIEWED"] | None = None
    payment_concept: str | None = Field(default=None, max_length=120)
    reviewed_additional_amount: Decimal | None = Field(default=None, gt=0)
    reason: str = Field(min_length=3, max_length=500)
    recovery_allocations: list[RecoveryAllocationIn] = []

    @model_validator(mode="after")
    def parts_and_allocations_match(self):
        if not self.reason.strip():
            raise ValueError("REASON_REQUIRED")
        if self.worked_minutes_net != self.normal_minutes + self.additional_minutes + self.recovery_minutes:
            raise ValueError("MINUTE_ALLOCATION_MISMATCH")
        if sum(item.minutes for item in self.recovery_allocations) != self.recovery_minutes:
            raise ValueError("RECOVERY_ALLOCATION_MISMATCH")
        if len({item.commitment_id for item in self.recovery_allocations}) != len(self.recovery_allocations):
            raise ValueError("DUPLICATE_RECOVERY_COMMITMENT")
        if self.additional_minutes and self.payment_method is None:
            raise ValueError("PAYMENT_METHOD_REQUIRED")
        if self.additional_minutes and self.day_context != "ORDINARY" and self.payment_method == "OVERTIME":
            raise ValueError("SPECIAL_CONTEXT_REQUIRES_REVIEWED_PAYMENT")
        if self.payment_method == "REVIEWED" and self.additional_minutes and (
            self.reviewed_additional_amount is None or not self.payment_concept or not self.payment_concept.strip()
            or not self.source_reference or not self.source_reference.strip()
        ):
            raise ValueError("REVIEWED_PAYMENT_DETAILS_REQUIRED")
        if self.reviewed_additional_amount is not None and self.payment_method != "REVIEWED":
            raise ValueError("REVIEWED_PAYMENT_METHOD_REQUIRED")
        for known_time in (self.known_check_in_at, self.known_check_out_at):
            if known_time is not None and known_time.tzinfo is None:
                raise ValueError("KNOWN_TIME_TIMEZONE_REQUIRED")
        return self


class ManualDayOverrideIn(BaseModel):
    work_date: date
    worked_minutes_net: int | None = Field(default=None, ge=0, le=1440)
    normal_minutes: int | None = Field(default=None, ge=0, le=1440)
    additional_minutes: int | None = Field(default=None, ge=0, le=1440)
    recovery_minutes: int | None = Field(default=None, ge=0, le=1440)
    known_check_in_at: datetime | None = None
    known_check_out_at: datetime | None = None
    known_break_minutes: int | None = Field(default=None, ge=0, le=1440)
    day_context: Literal["ORDINARY", "UNSCHEDULED", "SPECIAL"] | None = None
    source_reference: str | None = Field(default=None, max_length=200)
    payment_method: Literal["OVERTIME", "REVIEWED"] | None = None
    payment_concept: str | None = Field(default=None, max_length=120)
    reviewed_additional_amount: Decimal | None = Field(default=None, gt=0)
    reason: str | None = Field(default=None, min_length=3, max_length=500)
    recovery_allocations: list[RecoveryAllocationIn] | None = None


class ManualMultiBatchIn(BaseModel):
    employee_id: uuid.UUID
    work_dates: list[date] = Field(min_length=1, max_length=50)
    template: ManualDayTemplate
    overrides: list[ManualDayOverrideIn] = []
    idempotency_key: str = Field(min_length=8, max_length=128)
    approve_additional: bool = False
    preview_token: str | None = Field(default=None, min_length=64, max_length=64)

    @model_validator(mode="after")
    def dates_are_unique_and_overrides_belong(self):
        if len(set(self.work_dates)) != len(self.work_dates):
            raise ValueError("DUPLICATE_WORK_DATE")
        override_dates = [item.work_date for item in self.overrides]
        if len(set(override_dates)) != len(override_dates):
            raise ValueError("DUPLICATE_WORK_DATE_OVERRIDE")
        if not set(override_dates).issubset(set(self.work_dates)):
            raise ValueError("OVERRIDE_DATE_NOT_SELECTED")
        template = self.template.model_dump(mode="python")
        for override in self.overrides:
            data = dict(template)
            data.update(override.model_dump(mode="python", exclude={"work_date"}, exclude_unset=True))
            # Reutiliza la misma validación para valores comunes y excepciones
            # antes de llegar al servicio (422, nunca 500).
            ManualDayTemplate(**data)
        return self

class ManualUpdateIn(ManualDayIn):
    expected_version: int = Field(ge=1)
    preview_token: str = Field(min_length=64, max_length=64)
    idempotency_key: str = Field(min_length=8, max_length=128)

class VoidIn(BaseModel):
    expected_version: int = Field(ge=1)
    reason: str = Field(min_length=3, max_length=500)
    idempotency_key: str = Field(min_length=8, max_length=128)

class PaymentApproveIn(BaseModel):
    expected_version: int = Field(ge=1)
    expected_snapshot: dict
    idempotency_key: str = Field(min_length=8, max_length=128)

class CommitmentIn(BaseModel):
    employee_id: uuid.UUID
    permission_date: date
    agreed_minutes: int = Field(gt=0, le=1440)
    covered_before: bool
    reference: str = Field(min_length=3, max_length=500)
