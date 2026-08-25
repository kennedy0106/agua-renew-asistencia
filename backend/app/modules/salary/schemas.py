"""Schemas de configuración salarial."""

import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class SalarySettingCreate(BaseModel):
    effective_from: date
    monthly_salary: Decimal = Field(gt=0, max_digits=12, decimal_places=2)
    overtime_enabled: bool = False
    overtime_method: Literal["PERCENTAGE", "FIXED_RATE", "MANUAL"] = "PERCENTAGE"
    overtime_percentage: Decimal | None = Field(default=None, ge=0, max_digits=5, decimal_places=2)
    overtime_fixed_rate: Decimal | None = Field(default=None, ge=0, max_digits=12, decimal_places=2)

    @model_validator(mode="after")
    def _validate_method_consistency(self):
        if self.overtime_enabled:
            if self.overtime_method == "PERCENTAGE" and self.overtime_percentage is None:
                raise ValueError("El método PERCENTAGE requiere overtime_percentage")
            if self.overtime_method == "FIXED_RATE" and self.overtime_fixed_rate is None:
                raise ValueError("El método FIXED_RATE requiere overtime_fixed_rate")
        return self


class SalarySettingOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    employee_id: uuid.UUID
    monthly_salary: Decimal
    overtime_enabled: bool
    overtime_method: str
    overtime_percentage: Decimal | None
    overtime_fixed_rate: Decimal | None
    effective_from: date
    effective_to: date | None
    created_at: datetime
    updated_at: datetime
