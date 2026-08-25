"""Schemas de cargos laborales."""

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class JobRoleCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100, description="Nombre del cargo (obligatorio)")
    description: str | None = Field(default=None, max_length=255)


class JobRoleUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    description: str | None = Field(default=None, max_length=255)
    active: bool | None = None


class JobRoleOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    description: str | None
    active: bool
    created_at: datetime
    updated_at: datetime
