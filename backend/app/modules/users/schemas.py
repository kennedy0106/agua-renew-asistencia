"""Schemas de gestión de usuarios del sistema."""

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class UserCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    username: str = Field(min_length=3, max_length=50)
    system_role_id: uuid.UUID
    employee_id: uuid.UUID | None = None


class UserUpdate(BaseModel):
    system_role_id: uuid.UUID | None = None
    active: bool | None = None
    employee_id: uuid.UUID | None = None  # null = desvincular empleado


class ResetPasswordRequest(BaseModel):
    new_password: str = Field(min_length=8, max_length=128)


class ChangePasswordRequest(BaseModel):
    current_password: str = Field(min_length=1, max_length=128)
    new_password: str = Field(min_length=8, max_length=128)


class AdminUserOut(BaseModel):
    id: uuid.UUID
    username: str
    system_role_id: uuid.UUID
    role: str | None
    employee_id: uuid.UUID | None
    employee_name: str | None
    active: bool
    must_change_password: bool
    last_login_at: datetime | None
    created_at: datetime


class CreatedAdminUserOut(AdminUserOut):
    """Única respuesta que contiene la clave temporal, solo al crear."""

    temporary_password: str
