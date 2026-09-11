"""Servicio de ajustes de horas y saldo.

Saldo = minutos trabajados − minutos esperados + ajustes APROBADOS.
La diferencia negativa NUNCA se descuenta sola del sueldo: queda como
saldo a recuperar (decisión explícita del jefe).
"""

import uuid
from datetime import date, datetime, timedelta

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.modules.adjustments.models import (
    ADJUSTMENT_APPROVED,
    ADJUSTMENT_PENDING,
    ADJUSTMENT_REJECTED,
    HourAdjustment,
)
from app.modules.adjustments.repository import AdjustmentRepository
from app.modules.attendance.models import AttendanceRecord
from app.modules.audit.repository import AuditRepository
from app.modules.employees.repository import EmployeeRepository
from app.modules.schedules.service import ScheduleService


class AdjustmentService:
    def __init__(self, db: Session) -> None:
        self.db = db
        self.repo = AdjustmentRepository(db)

    def _get_employee(self, employee_id: uuid.UUID):
        employee = EmployeeRepository(self.db).get_by_id(employee_id)
        if employee is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Empleado no encontrado")
        return employee

    def create(
        self,
        *,
        employee_id: uuid.UUID,
        adjustment_date: date,
        minutes: int,
        adjustment_type: str,
        reason: str,
    ) -> HourAdjustment:
        self._get_employee(employee_id)
        if adjustment_type == "OVERTIME" and minutes <= 0:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Las horas extra deben registrarse con minutos positivos",
            )
        return self.repo.create(
            employee_id=employee_id,
            adjustment_date=adjustment_date,
            minutes=minutes,
            adjustment_type=adjustment_type,
            reason=reason.strip(),
        )

    def list_for_employee(self, employee_id: uuid.UUID) -> list[HourAdjustment]:
        self._get_employee(employee_id)
        return self.repo.list_for_employee(employee_id)

    def approve(self, adjustment_id: uuid.UUID, approver_id: uuid.UUID) -> HourAdjustment:
        adjustment = self._get_or_404(adjustment_id)
        if adjustment.status != ADJUSTMENT_PENDING:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"El ajuste ya fue {adjustment.status.lower()}; solo se pueden aprobar pendientes",
            )
        saved = self.repo.set_status(adjustment, status=ADJUSTMENT_APPROVED, approved_by=approver_id)
        AuditRepository(self.db).create(
            entity_type="adjustment",
            entity_id=adjustment_id,
            action="approve",
            old_values={"status": ADJUSTMENT_PENDING},
            new_values={"status": ADJUSTMENT_APPROVED, "minutes": adjustment.minutes},
            reason=f"Aprobación del ajuste de {adjustment.minutes} min ({adjustment.adjustment_type})",
            performed_by=approver_id,
        )
        return saved

    def reject(self, adjustment_id: uuid.UUID, approver_id: uuid.UUID, reason: str) -> HourAdjustment:
        adjustment = self._get_or_404(adjustment_id)
        if adjustment.status != ADJUSTMENT_PENDING:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"El ajuste ya fue {adjustment.status.lower()}; solo se pueden rechazar pendientes",
            )
        saved = self.repo.set_status(adjustment, status=ADJUSTMENT_REJECTED, approved_by=approver_id)
        AuditRepository(self.db).create(
            entity_type="adjustment",
            entity_id=adjustment_id,
            action="reject",
            old_values={"status": ADJUSTMENT_PENDING},
            new_values={"status": ADJUSTMENT_REJECTED},
            reason=reason.strip(),
            performed_by=approver_id,
        )
        return saved

    def balance(
        self, employee_id: uuid.UUID, date_from: date, date_to: date
    ) -> dict:
        """Saldo del empleado en el rango (trabajado − esperado + ajustes aprobados)."""
        if date_from > date_to:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="date_from no puede ser posterior a date_to",
            )
        self._get_employee(employee_id)

        worked = self.db.scalar(
            select(func.coalesce(func.sum(AttendanceRecord.worked_minutes), 0)).where(
                AttendanceRecord.employee_id == employee_id,
                AttendanceRecord.status == "COMPLETE",
                AttendanceRecord.work_date >= date_from,
                AttendanceRecord.work_date <= date_to,
            )
        )
        worked = int(worked or 0)

        expected = 0
        schedules = ScheduleService(self.db)
        day = date_from
        while day <= date_to:
            expected += schedules.expected_minutes(employee_id, day)
            day += timedelta(days=1)

        adjustments = self.repo.approved_minutes_in_range(
            employee_id, date_from, date_to, adjustment_type=None
        )
        overtime_minutes = self.repo.approved_minutes_in_range(
            employee_id, date_from, date_to, adjustment_type="OVERTIME"
        )
        hour_adjustments = adjustments - overtime_minutes

        return {
            "date_from": date_from,
            "date_to": date_to,
            "worked_minutes": worked,
            "expected_minutes": expected,
            "adjustment_minutes": hour_adjustments,
            "overtime_minutes": overtime_minutes,
            "balance_minutes": worked - expected + hour_adjustments,
        }

    def _get_or_404(self, adjustment_id: uuid.UUID) -> HourAdjustment:
        adjustment = self.repo.get_by_id(adjustment_id)
        if adjustment is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Ajuste no encontrado")
        return adjustment
