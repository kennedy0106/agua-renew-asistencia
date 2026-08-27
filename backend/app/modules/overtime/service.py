"""Servicio de horas extra (tramos diarios — seccion_horas_extra.md).

- DETECTAR ≠ PAGAR: la detección solo propone días con sobretiempo; el JEFE
  clasifica creando un ajuste OVERTIME (aprobación explícita).
- El valor monetario se calcula SOLO sobre ajustes OVERTIME APROBADOS.
- Tramos DIARIOS (el contador se reinicia cada día):
    minutos 0–120   → first_two_hours_rate
    minutos 120+    → additional_hours_rate
- Tasas efectivas resueltas por get_effective_overtime_rates (política general
  o override por empleado). No se duplica la decisión.
- Si overtime_enabled = false en el salary vigente → no se paga horas extra.
- Tarifa por hora derivada: sueldo mensual / minutos esperados del mes.
- Dinero SIEMPRE en Decimal.
"""

import uuid
from calendar import monthrange
from datetime import date
from decimal import Decimal, ROUND_HALF_UP

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.modules.adjustments.models import ADJUSTMENT_APPROVED
from app.modules.adjustments.repository import AdjustmentRepository
from app.modules.attendance.repository import AttendanceRepository
from app.modules.employees.repository import EmployeeRepository
from app.modules.overtime_policy.service import OvertimePolicyService
from app.modules.salary.service import SalaryService
from app.modules.schedules.service import ScheduleService

_FALLBACK_MONTH_MINUTES = 14400  # 240 h (30 días × 8 h), Perú.
_CENTS = Decimal("0.01")
_RATE = Decimal("0.0001")
_FIRST_TWO_MINUTES = 120  # primeras 2 horas del día


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
            if expected <= 0:
                continue  # A3: sin jornada configurada → no es sobretiempo
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
        """Valor monetario de las horas extra APROBADAS en el rango, por tramos diarios."""
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

        # Agrupar minutos aprobados por día (el tramo se reinicia cada día).
        by_day: dict[date, int] = {}
        for adj in adjustments:
            by_day[adj.adjustment_date] = by_day.get(adj.adjustment_date, 0) + adj.minutes

        salaries = SalaryService(self.db)
        policy = OvertimePolicyService(self.db)

        total = Decimal("0.00")
        breakdown = []

        for day, total_minutes in sorted(by_day.items()):
            salary = salaries.get_for_date(employee_id, day)
            if salary is None or not salary.overtime_enabled:
                continue  # sin configuración o deshabilitado → no se paga

            first_two = min(total_minutes, _FIRST_TWO_MINUTES)
            additional = max(total_minutes - _FIRST_TWO_MINUTES, 0)

            rates = policy.get_effective_overtime_rates(employee_id, day)
            hourly = self.hourly_rate(employee_id, day)

            first_value = (
                Decimal(first_two)
                * hourly
                / Decimal(60)
                * (Decimal("1") + rates["first_two_hours_rate"] / Decimal(100))
            ).quantize(_CENTS, rounding=ROUND_HALF_UP)

            additional_value = (
                Decimal(additional)
                * hourly
                / Decimal(60)
                * (Decimal("1") + rates["additional_hours_rate"] / Decimal(100))
            ).quantize(_CENTS, rounding=ROUND_HALF_UP)

            item_value = first_value + additional_value
            total += item_value

            breakdown.append(
                {
                    "adjustment_date": day,
                    "minutes": total_minutes,
                    "first_two_minutes": first_two,
                    "additional_minutes": additional,
                    "first_two_hours_rate": rates["first_two_hours_rate"],
                    "additional_hours_rate": rates["additional_hours_rate"],
                    "source": rates["source"],
                    "hourly_rate": hourly,
                    "value": item_value,
                }
            )

        return {
            "date_from": date_from,
            "date_to": date_to,
            "overtime_minutes": sum(a.minutes for a in adjustments),
            "value": total.quantize(_CENTS, rounding=ROUND_HALF_UP),
            "breakdown": breakdown,
        }
