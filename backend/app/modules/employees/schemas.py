"""Schemas de empleados."""

import uuid
from datetime import date, datetime

from pydantic import BaseModel, ConfigDict, Field


class DniLookupRequest(BaseModel):
    """Solicitud explícita de consulta RENIEC durante el alta de personal."""

    dni: str = Field(pattern=r"^\d{8}$", description="DNI peruano de 8 dígitos")


class DniLookupOut(BaseModel):
    dni: str
    first_name: str
    first_last_name: str
    second_last_name: str | None = None
    full_name: str


class EmployeeCreate(BaseModel):
    # Extras se ignoran por compatibilidad de clientes anteriores; el servidor
    # siempre asigna employee_code y nunca acepta controlarlo desde el payload.
    dni: str = Field(min_length=8, max_length=8, description="DNI peruano (8 dígitos)")
    first_name: str = Field(min_length=1, max_length=100)
    last_name: str = Field(min_length=1, max_length=100)
    job_role_id: uuid.UUID
    hire_date: date | None = None


class EmployeeUpdate(BaseModel):
    # employee_code deliberadamente no pertenece al contrato de edición.
    dni: str | None = Field(default=None, min_length=8, max_length=8)
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
