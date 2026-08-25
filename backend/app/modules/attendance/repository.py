"""Repositorio de registros de asistencia."""

import uuid
from datetime import date

from sqlalchemy import select
from sqlalchemy.orm import Session, joinedload

from app.modules.attendance.models import AttendanceRecord


class AttendanceRepository:
    def __init__(self, db: Session) -> None:
        self.db = db

    def get_open(self, employee_id: uuid.UUID) -> AttendanceRecord | None:
        """Entrada abierta (sin salida) del empleado, la más reciente."""
        return self.db.scalar(
            select(AttendanceRecord)
            .where(
                AttendanceRecord.employee_id == employee_id,
                AttendanceRecord.check_out_at.is_(None),
            )
            .order_by(AttendanceRecord.check_in_at.desc())
            .limit(1)
        )

    def get_last(self, employee_id: uuid.UUID) -> AttendanceRecord | None:
        return self.db.scalar(
            select(AttendanceRecord)
            .where(AttendanceRecord.employee_id == employee_id)
            .order_by(AttendanceRecord.check_in_at.desc())
            .limit(1)
        )

    def create(self, *, employee_id: uuid.UUID, work_date: date, check_in_at) -> AttendanceRecord:
        record = AttendanceRecord(
            employee_id=employee_id,
            work_date=work_date,
            check_in_at=check_in_at,
            status="OPEN",
        )
        self.db.add(record)
        self.db.commit()
        self.db.refresh(record)
        return record

    def check_out(self, record: AttendanceRecord, *, check_out_at, worked_minutes: int) -> AttendanceRecord:
        record.check_out_at = check_out_at
        record.worked_minutes = worked_minutes
        record.status = "COMPLETE"
        self.db.add(record)
        self.db.commit()
        self.db.refresh(record)
        return record
