"""Repositorio de terminales de marcación."""

import uuid
from datetime import datetime

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.modules.attendance.models import AttendanceDevice


class DeviceRepository:
    def __init__(self, db: Session) -> None:
        self.db = db

    def list_devices(self) -> list[AttendanceDevice]:
        return list(self.db.scalars(select(AttendanceDevice).order_by(AttendanceDevice.created_at.desc())))

    def get(self, device_id: uuid.UUID) -> AttendanceDevice | None:
        return self.db.get(AttendanceDevice, device_id)

    def get_by_pairing_hash(self, pairing_code_hash: str) -> AttendanceDevice | None:
        return self.db.scalar(
            select(AttendanceDevice).where(AttendanceDevice.pairing_code_hash == pairing_code_hash)
        )

    def consume_pairing_code(self, device_id: uuid.UUID, pairing_code_hash: str, *, last_sync_at: datetime) -> bool:
        result = self.db.execute(
            update(AttendanceDevice)
            .where(
                AttendanceDevice.id == device_id,
                AttendanceDevice.pairing_code_hash == pairing_code_hash,
            )
            .values(pairing_code_hash=None, pairing_expires_at=None, last_sync_at=last_sync_at)
        )
        self.db.commit()
        return int(result.rowcount or 0) == 1

    def save(self, device: AttendanceDevice) -> AttendanceDevice:
        self.db.add(device)
        self.db.commit()
        self.db.refresh(device)
        return device
