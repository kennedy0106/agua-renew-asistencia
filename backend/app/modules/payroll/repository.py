"""Repositorio de periodos y registros de planilla.

No confirma transacciones: el servicio (unidad de trabajo) hace commit
junto con la auditoría.
"""

import uuid
from datetime import date
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session, joinedload

from app.modules.payroll.models import PayrollPeriod, PayrollRecord


class PayrollRepository:
    def __init__(self, db: Session) -> None:
        self.db = db

    def list_periods(self) -> list[PayrollPeriod]:
        return list(
            self.db.scalars(
                select(PayrollPeriod).order_by(PayrollPeriod.start_date.desc())
            )
        )

    def get_period(self, period_id: uuid.UUID, *, for_update: bool = False) -> PayrollPeriod | None:
        query = select(PayrollPeriod).where(PayrollPeriod.id == period_id)
        if for_update:
            query = query.with_for_update()
        return self.db.scalar(query)

    def find_overlap(self, start_date: date, end_date: date, exclude_id: uuid.UUID | None = None) -> PayrollPeriod | None:
        query = select(PayrollPeriod).where(
            PayrollPeriod.start_date <= end_date,
            PayrollPeriod.end_date >= start_date,
        )
        if exclude_id is not None:
            query = query.where(PayrollPeriod.id != exclude_id)
        return self.db.scalar(query)

    def create_period(self, *, name: str, start_date: date, end_date: date) -> PayrollPeriod:
        period = PayrollPeriod(name=name, start_date=start_date, end_date=end_date)
        self.db.add(period)
        self.db.flush()
        self.db.refresh(period)
        return period

    def set_period_status(self, period: PayrollPeriod, status: str) -> PayrollPeriod:
        period.status = status
        self.db.add(period)
        self.db.flush()
        self.db.refresh(period)
        return period

    def list_records(self, period_id: uuid.UUID, *, payable_only: bool = False) -> list[PayrollRecord]:
        query = (
            select(PayrollRecord)
            .options(joinedload(PayrollRecord.employee))
            .where(PayrollRecord.payroll_period_id == period_id)
        )
        if payable_only:
            query = query.where(PayrollRecord.payable.is_(True))
        return list(self.db.scalars(query.order_by(PayrollRecord.employee_id)))

    def get_record(self, record_id: uuid.UUID, *, for_update: bool = False) -> PayrollRecord | None:
        query = (
            select(PayrollRecord)
            .options(joinedload(PayrollRecord.payroll_period))
            .where(PayrollRecord.id == record_id)
        )
        if for_update:
            query = query.with_for_update()
        return self.db.scalar(query)

    def create_record(
        self,
        *,
        period_id: uuid.UUID,
        employee_id: uuid.UUID,
        monthly_salary: Decimal,
        worked_minutes: int,
        expected_minutes: int,
        overtime_minutes: int,
        overtime_amount: Decimal,
        adjustment_minutes: int,
        adjustment_amount: Decimal,
        base_salary: Decimal,
        total: Decimal,
    ) -> PayrollRecord:
        record = PayrollRecord(
            payroll_period_id=period_id,
            employee_id=employee_id,
            monthly_salary=monthly_salary,
            worked_minutes=worked_minutes,
            expected_minutes=expected_minutes,
            overtime_minutes=overtime_minutes,
            overtime_amount=overtime_amount,
            adjustment_minutes=adjustment_minutes,
            adjustment_amount=adjustment_amount,
            base_salary=base_salary,
            total=total,
            status="PREVIEW",
        )
        self.db.add(record)
        self.db.flush()
        self.db.refresh(record)
        return record

    def set_manual_adjustment(self, record: PayrollRecord, *, amount: Decimal, notes: str | None) -> PayrollRecord:
        record.manual_adjustment = amount
        if notes is not None:
            record.notes = notes
        record.total = record.base_salary + record.overtime_amount + amount
        self.db.add(record)
        self.db.flush()
        self.db.refresh(record)
        return record

    def confirm_all(self, period_id: uuid.UUID) -> None:
        records = self.db.scalars(
            select(PayrollRecord).where(PayrollRecord.payroll_period_id == period_id)
        )
        for record in records:
            if record.payable:
                record.status = "CONFIRMED"
            else:
                record.status = "EXCLUDED"
            self.db.add(record)
        self.db.flush()
