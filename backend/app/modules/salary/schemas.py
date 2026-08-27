"""Schemas de configuración salarial."""

import uuid
from datetime import date, datetime
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class SalarySettingCreate(BaseModel):
    effective_from: date
    monthly_salary: Decimal = Field(gt=0, max_digits=12, decimal_places=2)
    overtime_enabled: bool = False
    use_custom_overtime_rates: bool = False
    custom_first_two_hours_rate: Decimal | None = Field(default=None, ge=25, max_digits=5, decimal_places=2)
    custom_additional_hours_rate: Decimal | None = Field(default=None, ge=35, max_digits=5, decimal_places=2)

    @model_validator(mode="after")
    def _validate_custom_rates(self):
        if self.use_custom_overtime_rates:
            if self.custom_first_two_hours_rate is None or self.custom_additional_hours_rate is None:
                raise ValueError(
                    "use_custom_overtime_rates requiere custom_first_two_hours_rate y custom_additional_hours_rate"
                )
        return self


class SalarySettingOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    employee_id: uuid.UUID
    monthly_salary: Decimal
    overtime_enabled: bool
    use_custom_overtime_rates: bool
    custom_first_two_hours_rate: Decimal | None
    custom_additional_hours_rate: Decimal | None
    effective_from: date
    effective_to: date | None
    created_at: datetime
    updated_at: datetime
