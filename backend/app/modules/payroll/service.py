"""Servicio de planilla: periodos, cálculo con snapshot y cierre.

Reglas del MVP:
- El payroll se calcula DESPUÉS de asistencia/ajustes, nunca antes.
- Cálculo por empleado ACTIVO con sueldo vigente en el periodo:
    total = base_salary (sueldo mensual) + overtime_amount + manual_adjustment
  adjustment_amount se conserva en 0.00: los ajustes de horas NO cambian el
  monto automáticamente (nada automático en dinero); su efecto monetario se
  aplica vía ajuste manual con motivo, si el jefe lo decide.
- El cierre (CLOSED) congela el snapshot: inmutabilidad.
- Toda operación sensible (ajuste manual, cierre) queda auditada.
"""

import uuid
from datetime import date
from decimal import Decimal, ROUND_HALF_UP

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.modules.adjustments.models import HourAdjustment
from app.modules.adjustments.repository import AdjustmentRepository
from app.modules.attendance.models import AttendanceRecord
from app.modules.audit.repository import AuditRepository
from app.modules.employees.models import Employee
from app.modules.employees.repository import EmployeeRepository
from app.modules.overtime.service import OvertimeService
from app.modules.payroll.models import (
    PERIOD_CALCULATED,
    PERIOD_CLOSED,
    PERIOD_OPEN,
    PayrollPeriod,
    PayrollRecord,
)
from app.modules.payroll.repository import PayrollRepository
from app.modules.salary.service import SalaryService
from app.modules.schedules.service import ScheduleService

_CENTS = Decimal("0.01")


class PayrollService:
    def __init__(self, db: Session) -> None:
        self.db = db
        self.repo = PayrollRepository(db)

    # --- Periodos ---

    def create_period(self, *, name: str, start_date: date, end_date: date) -> PayrollPeriod:
        if start_date > end_date:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="start_date no puede ser posterior a end_date",
            )
        if self.repo.find_overlap(start_date, end_date) is not None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Ya existe un periodo que se solapa con esas fechas",
            )
        return self.repo.create_period(name=name.strip(), start_date=start_date, end_date=end_date)

    def list_periods(self) -> list[PayrollPeriod]:
        return self.repo.list_periods()

    def _get_period_or_404(self, period_id: uuid.UUID) -> PayrollPeriod:
        period = self.repo.get_period(period_id)
        if period is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Periodo no encontrado")
        return period

    # --- Cálculo ---

    def calculate(self, period_id: uuid.UUID) -> list[PayrollRecord]:
        period = self._get_period_or_404(period_id)
        if period.status == PERIOD_CLOSED:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="El periodo está cerrado: no se puede recalcular",
            )

        self.repo.delete_records(period_id)  # reemplaza el preview anterior

        employees = EmployeeRepository(self.db).list_all(active=True)
        salaries = SalaryService(self.db)
        schedules = ScheduleService(self.db)
        adjustments = AdjustmentRepository(self.db)
        overtime = OvertimeService(self.db)

        created = []
        for employee in employees:
            salary = salaries.get_for_date(employee.id, period.start_date)
            if salary is None:
                continue  # sin sueldo configurado en el periodo → no se incluye

            worked = self._sum_worked_minutes(employee.id, period)
            expected = self._sum_expected_minutes(schedules, employee.id, period)
            overtime_minutes = adjustments.approved_minutes_in_range(
                employee.id, period.start_date, period.end_date, adjustment_type="OVERTIME"
            )
            adjustment_minutes = adjustments.approved_minutes_in_range(
                employee.id, period.start_date, period.end_date
            ) - overtime_minutes
            overtime_amount = overtime.value(employee.id, period.start_date, period.end_date)["value"]

            base = salary.monthly_salary
            total = (base + overtime_amount).quantize(_CENTS, rounding=ROUND_HALF_UP)

            record = self.repo.create_record(
                period_id=period_id,
                employee_id=employee.id,
                monthly_salary=base,
                worked_minutes=worked,
                expected_minutes=expected,
                overtime_minutes=overtime_minutes,
                overtime_amount=overtime_amount,
                adjustment_minutes=adjustment_minutes,
                adjustment_amount=Decimal("0.00"),
                base_salary=base,
                total=total,
            )
            created.append(record)

        self.repo.set_period_status(period, PERIOD_CALCULATED)
        return created

    def _sum_worked_minutes(self, employee_id: uuid.UUID, period: PayrollPeriod) -> int:
        total = self.db.scalar(
            select(func.coalesce(func.sum(AttendanceRecord.worked_minutes), 0)).where(
                AttendanceRecord.employee_id == employee_id,
                AttendanceRecord.status == "COMPLETE",
                AttendanceRecord.work_date >= period.start_date,
                AttendanceRecord.work_date <= period.end_date,
            )
        )
        return int(total or 0)

    @staticmethod
    def _sum_expected_minutes(schedules: ScheduleService, employee_id: uuid.UUID, period: PayrollPeriod) -> int:
        total = 0
        day = period.start_date
        from datetime import timedelta

        while day <= period.end_date:
            total += schedules.expected_minutes(employee_id, day)
            day += timedelta(days=1)
        return total

    def list_records(self, period_id: uuid.UUID) -> list[PayrollRecord]:
        self._get_period_or_404(period_id)
        return self.repo.list_records(period_id)

    def summary(self, period_id: uuid.UUID) -> dict:
        """Totales del periodo (los calcula el backend; el frontend solo muestra)."""
        period = self._get_period_or_404(period_id)
        records = self.repo.list_records(period_id)
        return {
            "period_id": period.id,
            "name": period.name,
            "start_date": period.start_date,
            "end_date": period.end_date,
            "status": period.status,
            "employee_count": len(records),
            "total_base": sum((r.base_salary for r in records), Decimal("0.00")),
            "total_overtime": sum((r.overtime_amount for r in records), Decimal("0.00")),
            "total_manual": sum((r.manual_adjustment for r in records), Decimal("0.00")),
            "total": sum((r.total for r in records), Decimal("0.00")),
        }

    # --- Ajuste manual y cierre ---

    def set_manual_adjustment(
        self, record_id: uuid.UUID, *, amount: Decimal, notes: str | None, current_user_id: uuid.UUID | None
    ) -> PayrollRecord:
        record = self.repo.get_record(record_id)
        if record is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Registro no encontrado")
        if record.payroll_period.status == PERIOD_CLOSED:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="El periodo está cerrado: no se puede ajustar",
            )

        old_total = record.total
        saved = self.repo.set_manual_adjustment(record, amount=amount, notes=notes)
        AuditRepository(self.db).create(
            entity_type="payroll_record",
            entity_id=record_id,
            action="manual_adjustment",
            old_values={"manual_adjustment": str(old_total), "total": str(old_total)},
            new_values={
                "manual_adjustment": str(amount),
                "total": str(saved.total),
                "notes": saved.notes,
            },
            reason=notes or "Ajuste manual de planilla",
            performed_by=current_user_id,
        )
        return saved

    def confirm(self, period_id: uuid.UUID, current_user_id: uuid.UUID | None) -> PayrollPeriod:
        period = self._get_period_or_404(period_id)
        if period.status != PERIOD_CALCULATED:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"El periodo debe estar CALCULATED para confirmarse (estado: {period.status})",
            )
        self.repo.confirm_all(period_id)
        closed = self.repo.set_period_status(period, PERIOD_CLOSED)
        AuditRepository(self.db).create(
            entity_type="payroll_period",
            entity_id=period_id,
            action="close",
            old_values={"status": PERIOD_CALCULATED},
            new_values={"status": PERIOD_CLOSED},
            reason=f"Cierre del periodo {period.name}",
            performed_by=current_user_id,
        )
        return closed
