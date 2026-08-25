"""Schemas de autenticación y usuarios."""

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class LoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=50)
    password: str = Field(min_length=1, max_length=200)


class UserOut(BaseModel):
    """Usuario visible para el frontend (nunca el hash)."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    username: str
    role: str
    active: bool
    last_login_at: datetime | None
    created_at: datetime


class LogoutResponse(BaseModel):
    status: str = "ok"
