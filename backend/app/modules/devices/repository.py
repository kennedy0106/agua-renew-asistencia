"""Repositorio de terminales de marcación."""

import uuid
from datetime import datetime

from sqlalchemy import select
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

    def save(self, device: AttendanceDevice) -> AttendanceDevice:
        self.db.add(device)
        self.db.commit()
        self.db.refresh(device)
        return device
