"""Schemas de gestión de usuarios del sistema."""

import uuid
from datetime import datetime

from pydantic import BaseModel, Field


class UserCreate(BaseModel):
    username: str = Field(min_length=3, max_length=50)
    password: str = Field(min_length=8, max_length=128)
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
    last_login_at: datetime | None
    created_at: datetime
