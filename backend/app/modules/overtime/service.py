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
- Tarifa ordinaria: sueldo mensual / 30 / horas de jornada del día
  (minutos programados del weekday, sin restar refrigerio).
- Dinero SIEMPRE en Decimal; se redondea a céntimos una sola vez por día.
"""

import uuid
from datetime import date
from decimal import Decimal, ROUND_HALF_UP

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.modules.adjustments.models import ADJUSTMENT_APPROVED
from app.modules.adjustments.repository import AdjustmentRepository
from app.modules.attendance.repository import AttendanceRepository
from app.modules.attendance.manual_models import ManualAttendanceDay
from app.modules.employees.repository import EmployeeRepository
from app.modules.overtime_policy.service import OvertimePolicyService
from app.modules.salary.service import SalaryService
from app.modules.schedules.service import ScheduleService

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
        by_day: dict[date, int] = {}
        for record in records:
            if record.status != "COMPLETE" or record.worked_minutes is None:
                continue
            by_day[record.work_date] = by_day.get(record.work_date, 0) + record.worked_minutes
        detected = []
        for work_date, worked_minutes in sorted(by_day.items()):
            expected = schedules.expected_minutes(employee_id, work_date)
            if expected <= 0:
                continue  # A3: sin jornada configurada → no es sobretiempo
            extra = worked_minutes - expected
            if extra > 0:
                detected.append(
                    {
                        "work_date": work_date,
                        "worked_minutes": worked_minutes,
                        "expected_minutes": expected,
                        "extra_minutes": extra,
                    }
                )
        return detected

    def hourly_rate(self, employee_id: uuid.UUID, ref: date) -> Decimal:
        """Sueldo / 30 / horas de jornada del día (R04)."""
        salary = SalaryService(self.db).get_for_date(employee_id, ref)
        if salary is None:
            return Decimal("0")
        day_minutes = ScheduleService(self.db).expected_minutes(employee_id, ref)
        if day_minutes <= 0:
            return Decimal("0")
        hours = Decimal(day_minutes) / Decimal(60)
        return (salary.monthly_salary / Decimal(30) / hours).quantize(_RATE, rounding=ROUND_HALF_UP)

    def _raw_hourly_rate(self, employee_id: uuid.UUID, ref: date) -> Decimal:
        salary = SalaryService(self.db).get_for_date(employee_id, ref)
        if salary is None:
            return Decimal("0")
        day_minutes = ScheduleService(self.db).expected_minutes(employee_id, ref)
        if day_minutes <= 0:
            return Decimal("0")
        hours = Decimal(day_minutes) / Decimal(60)
        return salary.monthly_salary / Decimal(30) / hours

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
            first_two = min(total_minutes, _FIRST_TWO_MINUTES)
            additional = max(total_minutes - _FIRST_TWO_MINUTES, 0)
            if salary is None or not salary.overtime_enabled:
                skip_reason = "MISSING_SALARY" if salary is None else "DISABLED"
                breakdown.append(
                    {
                        "adjustment_date": day,
                        "minutes": total_minutes,
                        "first_two_minutes": first_two,
                        "additional_minutes": additional,
                        "first_two_hours_rate": Decimal("0.00"),
                        "additional_hours_rate": Decimal("0.00"),
                        "source": skip_reason.lower(),
                        "hourly_rate": Decimal("0"),
                        "value": Decimal("0.00"),
                        "skip_reason": skip_reason,
                    }
                )
                continue

            rates = policy.get_effective_overtime_rates(employee_id, day)
            hourly = self._raw_hourly_rate(employee_id, day)
            if hourly <= 0:
                skip_reason = "MISSING_SCHEDULE"
                breakdown.append(
                    {
                        "adjustment_date": day,
                        "minutes": total_minutes,
                        "first_two_minutes": first_two,
                        "additional_minutes": additional,
                        "first_two_hours_rate": Decimal("0.00"),
                        "additional_hours_rate": Decimal("0.00"),
                        "source": skip_reason.lower(),
                        "hourly_rate": Decimal("0"),
                        "value": Decimal("0.00"),
                        "skip_reason": skip_reason,
                    }
                )
                continue

            item_value = (
                Decimal(first_two)
                * hourly
                / Decimal(60)
                * (Decimal("1") + rates["first_two_hours_rate"] / Decimal(100))
                + Decimal(additional)
                * hourly
                / Decimal(60)
                * (Decimal("1") + rates["additional_hours_rate"] / Decimal(100))
            ).quantize(_CENTS, rounding=ROUND_HALF_UP)
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
                    "hourly_rate": hourly.quantize(_RATE, rounding=ROUND_HALF_UP),
                    "value": item_value,
                    "skip_reason": None,
                }
            )

        manual = list(
            self.db.scalars(
                select(ManualAttendanceDay).where(
                    ManualAttendanceDay.employee_id == employee_id,
                    ManualAttendanceDay.work_date >= date_from,
                    ManualAttendanceDay.work_date <= date_to,
                    ManualAttendanceDay.voided_at.is_(None),
                    ManualAttendanceDay.payment_status == "APPROVED",
                )
            )
        )
        for item in manual:
            snapshot = item.payment_snapshot or {}
            amount = Decimal(str(snapshot.get("amount") or "0.00"))
            total += amount
            breakdown.append({"adjustment_date": item.work_date, "minutes": item.additional_minutes, "first_two_minutes": min(item.additional_minutes, _FIRST_TWO_MINUTES), "additional_minutes": max(0, item.additional_minutes - _FIRST_TWO_MINUTES), "first_two_hours_rate": Decimal(str(snapshot.get("first_two_hours_rate") or "0")), "additional_hours_rate": Decimal(str(snapshot.get("additional_hours_rate") or "0")), "source": "historical_manual", "hourly_rate": Decimal(str(snapshot.get("hourly_rate") or "0")), "value": amount, "skip_reason": None})
        return {
            "date_from": date_from,
            "date_to": date_to,
            "overtime_minutes": sum(a.minutes for a in adjustments) + sum(item.additional_minutes for item in manual),
            "value": total.quantize(_CENTS, rounding=ROUND_HALF_UP),
            "breakdown": breakdown,
        }
