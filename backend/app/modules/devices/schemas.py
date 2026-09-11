"""Schemas de terminales de marcación."""

import uuid
from datetime import datetime

from pydantic import BaseModel, Field


class DeviceCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)


class DeviceOut(BaseModel):
    id: uuid.UUID
    name: str
    device_code: str
    active: bool
    last_sync_at: datetime | None
    created_at: datetime
    updated_at: datetime


class DeviceCreatedOut(DeviceOut):
    pairing_code: str
    pairing_expires_at: datetime


class PairingRequest(BaseModel):
    pairing_code: str = Field(min_length=6, max_length=64)
