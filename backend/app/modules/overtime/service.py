"""Servicio de horas extra (Fase 10).

- DETECTAR ≠ PAGAR: la detección solo propone los días con sobretiempo; el
  JEFE clasifica creando un ajuste OVERTIME (aprobación explícita).
- El valor monetario se calcula SOLO sobre ajustes OVERTIME APROBADOS, con
  el método del salary_settings vigente en la fecha del ajuste:
    PERCENTAGE → minutos × tarifa/min × (1 + recargo%)
    FIXED_RATE  → horas × tarifa fija
    MANUAL      → 0 (el monto se ingresa a mano en el periodo)
  Si overtime_enabled = false → 0 (no se paga horas extra).
- La tarifa por hora se deriva: sueldo mensual / minutos esperados del mes
  (jornada vigente); sin jornada → fallback documentado de 240 h (30×8).
- Dinero SIEMPRE en Decimal.
"""

import uuid
from calendar import monthrange
from datetime import date
from decimal import Decimal, ROUND_HALF_UP

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.modules.adjustments.models import ADJUSTMENT_APPROVED, ADJUSTMENT_TYPES
from app.modules.adjustments.repository import AdjustmentRepository
from app.modules.attendance.repository import AttendanceRepository
from app.modules.employees.repository import EmployeeRepository
from app.modules.salary.service import SalaryService
from app.modules.schedules.service import ScheduleService

_FALLBACK_MONTH_MINUTES = 14400  # 240 h (30 días × 8 h), Perú: tarifa mensual estándar.
_CENTS = Decimal("0.01")
_RATE = Decimal("0.0001")


class OvertimeService:
    def __init__(self, db: Session) -> None:
        self.db = db
        self.adjustments = AdjustmentRepository(db)

    def _get_employee(self, employee_id: uuid.UUID):
        employee = EmployeeRepository(self.db).get_by_id(employee_id)
        if employee is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Empleado no encontrado")
        return employee

    def detect(self, employee_id: uuid.UUID, date_from: date, date_to: date) -> list[dict]:
        """Días con sobretiempo (trabajado > esperado). Solo informativo."""
        self._get_employee(employee_id)
        if date_from > date_to:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="date_from no puede ser posterior a date_to",
            )
        records = AttendanceRepository(self.db).list_records(
            employee_id=employee_id, date_from=date_from, date_to=date_to
        )
        schedules = ScheduleService(self.db)
        detected = []
        for record in records:
            if record.status != "COMPLETE" or record.worked_minutes is None:
                continue
            expected = schedules.expected_minutes(employee_id, record.work_date)
            extra = record.worked_minutes - expected
            if extra > 0:
                detected.append(
                    {
                        "work_date": record.work_date,
                        "worked_minutes": record.worked_minutes,
                        "expected_minutes": expected,
                        "extra_minutes": extra,
                    }
                )
        return detected

    def _expected_month_minutes(self, employee_id: uuid.UUID, ref: date) -> int:
        """Minutos esperados del mes (jornada vigente día a día)."""
        schedules = ScheduleService(self.db)
        _, last_day = monthrange(ref.year, ref.month)
        total = 0
        for day in range(1, last_day + 1):
            total += schedules.expected_minutes(employee_id, date(ref.year, ref.month, day))
        return total

    def hourly_rate(self, employee_id: uuid.UUID, ref: date) -> Decimal:
        """Tarifa por hora derivada del sueldo mensual (S/ por hora)."""
        salary = SalaryService(self.db).get_for_date(employee_id, ref)
        if salary is None:
            return Decimal("0")
        expected = self._expected_month_minutes(employee_id, ref)
        if expected <= 0:
            expected = _FALLBACK_MONTH_MINUTES
        return (salary.monthly_salary * Decimal(60) / Decimal(expected)).quantize(_RATE, rounding=ROUND_HALF_UP)

    def value(self, employee_id: uuid.UUID, date_from: date, date_to: date) -> dict:
        """Valor monetario de las horas extra APROBADAS en el rango."""
        self._get_employee(employee_id)
        if date_from > date_to:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="date_from no puede ser posterior a date_to",
            )

        adjustments = [
            a
            for a in self.adjustments.list_for_employee(employee_id)
            if a.status == ADJUSTMENT_APPROVED
            and a.adjustment_type == "OVERTIME"
            and date_from <= a.adjustment_date <= date_to
        ]

        salaries = SalaryService(self.db)
        total = Decimal("0.00")
        method: str | None = None
        rate: Decimal | None = None
        breakdown = []

        for adj in adjustments:
            salary = salaries.get_for_date(employee_id, adj.adjustment_date)
            if salary is None or not salary.overtime_enabled:
                continue  # sin configuración o deshabilitado → no se paga

            method = salary.overtime_method
            if method == "MANUAL":
                continue  # el monto se define a mano en el periodo (payroll)

            hourly = self.hourly_rate(employee_id, adj.adjustment_date)
            rate = hourly
            minutes = Decimal(adj.minutes)

            if method == "PERCENTAGE":
                percentage = salary.overtime_percentage or Decimal("0")
                per_minute = hourly / Decimal(60) * (Decimal("1") + percentage / Decimal(100))
                item_value = (minutes * per_minute).quantize(_CENTS, rounding=ROUND_HALF_UP)
            else:  # FIXED_RATE
                fixed = salary.overtime_fixed_rate or Decimal("0")
                item_value = (minutes / Decimal(60) * fixed).quantize(_CENTS, rounding=ROUND_HALF_UP)

            total += item_value
            breakdown.append(
                {
                    "adjustment_id": adj.id,
                    "adjustment_date": adj.adjustment_date,
                    "minutes": adj.minutes,
                    "rate": hourly,
                    "value": item_value,
                }
            )

        return {
            "date_from": date_from,
            "date_to": date_to,
            "method": method,
            "overtime_minutes": sum(a.minutes for a in adjustments),
            "hourly_rate": rate,
            "value": total.quantize(_CENTS, rounding=ROUND_HALF_UP),
            "breakdown": breakdown,
        }
