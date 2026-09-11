"""Enrolamiento y emparejamiento de terminales de kiosco."""

import hashlib
import secrets
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.modules.attendance.models import AttendanceDevice
from app.modules.devices.repository import DeviceRepository

_PAIRING_MINUTES = 15


def _hash_code(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


class DeviceService:
    def __init__(self, db: Session) -> None:
        self.db = db
        self.repo = DeviceRepository(db)

    def list_devices(self) -> list[AttendanceDevice]:
        return self.repo.list_devices()

    def create(self, name: str) -> tuple[AttendanceDevice, str]:
        device = AttendanceDevice(
            name=name.strip(),
            device_code=f"KIOSK-{secrets.token_hex(4).upper()}",
            token_version=1,
            active=True,
        )
        code = self._issue_pairing_code(device)
        return self.repo.save(device), code

    def rotate_pairing_code(self, device_id: uuid.UUID) -> tuple[AttendanceDevice, str]:
        device = self._get_active_or_any(device_id)
        if not device.active:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="El terminal está revocado")
        code = self._issue_pairing_code(device)
        return self.repo.save(device), code

    def revoke(self, device_id: uuid.UUID) -> AttendanceDevice:
        device = self._get_active_or_any(device_id)
        device.active = False
        device.pairing_code_hash = None
        device.pairing_expires_at = None
        device.token_version = (device.token_version or 1) + 1
        return self.repo.save(device)

    def pair(self, pairing_code: str) -> AttendanceDevice:
        digest = _hash_code(pairing_code.strip())
        device = self.repo.get_by_pairing_hash(digest)
        now = datetime.now(timezone.utc)
        expires = device.pairing_expires_at if device is not None else None
        if expires is not None and expires.tzinfo is None:
            expires = expires.replace(tzinfo=timezone.utc)
        if device is None or not device.active or expires is None or expires < now:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Código de emparejamiento inválido o vencido")
        device.pairing_code_hash = None
        device.pairing_expires_at = None
        device.last_sync_at = now
        return self.repo.save(device)

    def get_active(self, device_id: uuid.UUID, token_version: int | None = None) -> AttendanceDevice:
        device = self.repo.get(device_id)
        if device is None or not device.active:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Terminal no autorizado")
        if token_version is not None and int(device.token_version or 1) != int(token_version):
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Terminal revocado")
        return device

    def _get_active_or_any(self, device_id: uuid.UUID) -> AttendanceDevice:
        device = self.repo.get(device_id)
        if device is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Terminal no encontrado")
        return device

    def _issue_pairing_code(self, device: AttendanceDevice) -> str:
        code = secrets.token_urlsafe(12)
        device.pairing_code_hash = _hash_code(code)
        device.pairing_expires_at = datetime.now(timezone.utc) + timedelta(minutes=_PAIRING_MINUTES)
        return code
