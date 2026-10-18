"""Rutas ADMIN de contextos de marcación.

La creación manual de terminales y la emisión de códigos de emparejamiento
están retiradas (HTTP 410): cada navegador obtiene su contexto al identificarse
en el flujo público. Se conservan la autenticación ADMIN, el listado y la
revocación de un contexto vigente.
"""

import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.core.permissions import require_admin
from app.db.session import get_db
from app.modules.devices.schemas import DeviceOut
from app.modules.devices.service import DeviceService
from app.modules.users.models import User

router = APIRouter(prefix="/api/v1/devices", tags=["devices"])


def _out(device) -> DeviceOut:
    return DeviceOut.model_validate(
        {
            "id": device.id,
            "name": device.name,
            "device_code": device.device_code,
            "active": device.active,
            "last_sync_at": device.last_sync_at,
            "created_at": device.created_at,
            "updated_at": device.updated_at,
        }
    )


@router.get("", response_model=list[DeviceOut])
def list_devices(db: Session = Depends(get_db), _: User = Depends(require_admin)) -> list[DeviceOut]:
    return [_out(device) for device in DeviceService(db).list_devices()]


@router.post("", status_code=status.HTTP_410_GONE)
def create_device(_: User = Depends(require_admin)) -> dict:
    """Retirado: el contexto del navegador se crea al identificar al trabajador."""
    raise HTTPException(
        status_code=status.HTTP_410_GONE,
        detail="La creación manual de terminales fue retirada; el navegador se habilita al identificarse",
    )


@router.post("/{device_id}/pairing-code", status_code=status.HTTP_410_GONE)
def rotate_pairing_code(device_id: uuid.UUID, _: User = Depends(require_admin)) -> dict:
    """Retirado: ya no se emiten códigos de emparejamiento."""
    raise HTTPException(
        status_code=status.HTTP_410_GONE,
        detail="Los códigos de emparejamiento fueron retirados; el navegador se habilita al identificarse",
    )


@router.post("/{device_id}/revoke", response_model=DeviceOut)
def revoke_device(
    device_id: uuid.UUID, db: Session = Depends(get_db), _: User = Depends(require_admin)
) -> DeviceOut:
    return _out(DeviceService(db).revoke(device_id))
