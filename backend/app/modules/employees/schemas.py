"""Schemas de empleados."""

import uuid
from datetime import date, datetime

from pydantic import BaseModel, ConfigDict, Field


class EmployeeCreate(BaseModel):
    dni: str = Field(min_length=8, max_length=8, description="DNI peruano (8 dígitos)")
    employee_code: str = Field(min_length=1, max_length=20, description="Código interno")
    first_name: str = Field(min_length=1, max_length=100)
    last_name: str = Field(min_length=1, max_length=100)
    job_role_id: uuid.UUID
    hire_date: date | None = None


class EmployeeUpdate(BaseModel):
    dni: str | None = Field(default=None, min_length=8, max_length=8)
    employee_code: str | None = Field(default=None, min_length=1, max_length=20)
    first_name: str | None = Field(default=None, min_length=1, max_length=100)
    last_name: str | None = Field(default=None, min_length=1, max_length=100)
    job_role_id: uuid.UUID | None = None
    hire_date: date | None = None
    termination_date: date | None = None


class EmployeeOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    dni: str
    employee_code: str
    first_name: str
    last_name: str
    job_role_id: uuid.UUID
    job_role_name: str | None = None
    hire_date: date | None
    termination_date: date | None
    active: bool
    qr_token: str
    created_at: datetime
    updated_at: datetime
