"""Rutas ADMIN de terminales de marcación."""

import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, status
from sqlalchemy.orm import Session

from app.core.permissions import require_admin
from app.db.session import get_db
from app.modules.devices.schemas import DeviceCreate, DeviceCreatedOut, DeviceOut
from app.modules.devices.service import DeviceService
from app.modules.users.models import User

router = APIRouter(prefix="/api/v1/devices", tags=["devices"])


def _out(device, pairing_code: str | None = None, pairing_expires_at: datetime | None = None):
    payload = {
        "id": device.id,
        "name": device.name,
        "device_code": device.device_code,
        "active": device.active,
        "last_sync_at": device.last_sync_at,
        "created_at": device.created_at,
        "updated_at": device.updated_at,
    }
    if pairing_code is not None:
        payload["pairing_code"] = pairing_code
        payload["pairing_expires_at"] = pairing_expires_at or device.pairing_expires_at
        return DeviceCreatedOut.model_validate(payload)
    return DeviceOut.model_validate(payload)


@router.get("", response_model=list[DeviceOut])
def list_devices(db: Session = Depends(get_db), _: User = Depends(require_admin)) -> list[DeviceOut]:
    return [_out(device) for device in DeviceService(db).list_devices()]


@router.post("", response_model=DeviceCreatedOut, status_code=status.HTTP_201_CREATED)
def create_device(
    payload: DeviceCreate, db: Session = Depends(get_db), _: User = Depends(require_admin)
) -> DeviceCreatedOut:
    device, code = DeviceService(db).create(payload.name)
    return _out(device, pairing_code=code)


@router.post("/{device_id}/pairing-code", response_model=DeviceCreatedOut)
def rotate_pairing_code(
    device_id: uuid.UUID, db: Session = Depends(get_db), _: User = Depends(require_admin)
) -> DeviceCreatedOut:
    device, code = DeviceService(db).rotate_pairing_code(device_id)
    return _out(device, pairing_code=code)


@router.post("/{device_id}/revoke", response_model=DeviceOut)
def revoke_device(
    device_id: uuid.UUID, db: Session = Depends(get_db), _: User = Depends(require_admin)
) -> DeviceOut:
    return _out(DeviceService(db).revoke(device_id))
