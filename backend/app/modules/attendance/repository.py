"""Repositorio de registros de asistencia."""

import uuid
from datetime import date

from sqlalchemy import func, select
from sqlalchemy.orm import Session, joinedload

from app.modules.attendance.models import (
    AttendanceAttemptResolution,
    AttendanceConsumedNonce,
    AttendanceEvidence,
    AttendanceRecord,
)
from app.modules.employees.models import Employee


class AttendanceRepository:
    def __init__(self, db: Session) -> None:
        self.db = db

    def get_open(self, employee_id: uuid.UUID, *, for_update: bool = False) -> AttendanceRecord | None:
        """Entrada abierta (sin salida) del empleado, la más reciente."""
        query = (
            select(AttendanceRecord)
            .where(
                AttendanceRecord.employee_id == employee_id,
                AttendanceRecord.check_out_at.is_(None),
            )
            .order_by(AttendanceRecord.check_in_at.desc())
            .limit(1)
        )
        if for_update:
            query = query.with_for_update()
        return self.db.scalar(query)

    def get_by_id(self, record_id: uuid.UUID) -> AttendanceRecord | None:
        return self.db.scalar(select(AttendanceRecord).where(AttendanceRecord.id == record_id))

    def save(self, record: AttendanceRecord, *, commit: bool = True) -> AttendanceRecord:
        self.db.add(record)
        if commit:
            self.db.commit()
            self.db.refresh(record)
        else:
            self.db.flush()
        return record

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

    # --- Panel administrativo (Fase 7) ---

    def list_records(
        self,
        *,
        employee_id: uuid.UUID | None = None,
        date_from: date | None = None,
        date_to: date | None = None,
        status: str | None = None,
    ) -> list[AttendanceRecord]:
        query = select(AttendanceRecord).options(joinedload(AttendanceRecord.employee))
        if employee_id is not None:
            query = query.where(AttendanceRecord.employee_id == employee_id)
        if date_from is not None:
            query = query.where(AttendanceRecord.work_date >= date_from)
        if date_to is not None:
            query = query.where(AttendanceRecord.work_date <= date_to)
        if status is not None:
            query = query.where(AttendanceRecord.status == status)
        query = query.order_by(AttendanceRecord.work_date.desc(), AttendanceRecord.check_in_at.desc())
        return list(self.db.scalars(query))

    def count_active_employees(self) -> int:
        return self.db.scalar(
            select(func.count()).select_from(Employee).where(Employee.active.is_(True))
        )

    def count_distinct_employees_on(self, day: date) -> int:
        return self.db.scalar(
            select(func.count(func.distinct(AttendanceRecord.employee_id))).where(
                AttendanceRecord.work_date == day
            )
        )

    def count_open(self) -> int:
        return self.db.scalar(
            select(func.count())
            .select_from(AttendanceRecord)
            .where(AttendanceRecord.status == "OPEN")
        )

    def count_complete_on(self, day: date) -> int:
        return self.db.scalar(
            select(func.count())
            .select_from(AttendanceRecord)
            .where(AttendanceRecord.status == "COMPLETE", AttendanceRecord.work_date == day)
        )

    def lock_employee_for_attempt(self, employee_id: uuid.UUID) -> Employee:
        """Bloquea la fila del empleado (coordinación del intento). Sin joins."""
        employee = self.db.scalar(select(Employee).where(Employee.id == employee_id).with_for_update())
        if employee is None:
            from fastapi import HTTPException, status

            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Empleado no encontrado")
        return employee

    def get_resolution(self, nonce: str) -> AttendanceAttemptResolution | None:
        return self.db.scalar(
            select(AttendanceAttemptResolution)
            .where(AttendanceAttemptResolution.nonce == nonce)
            .execution_options(populate_existing=True)
        )

    def get_consumed_nonce(self, nonce: str) -> AttendanceConsumedNonce | None:
        return self.db.scalar(
            select(AttendanceConsumedNonce)
            .where(AttendanceConsumedNonce.nonce == nonce)
            .execution_options(populate_existing=True)
        )

    def get_evidence_by_nonce(self, nonce: str) -> AttendanceEvidence | None:
        return self.db.scalar(
            select(AttendanceEvidence)
            .where(AttendanceEvidence.nonce == nonce)
            .execution_options(populate_existing=True)
        )
