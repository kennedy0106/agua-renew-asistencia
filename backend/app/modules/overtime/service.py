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
- Tarifa ordinaria (D.S. 007-2002-TR, art. 12): valor día legal / horas de la
  jornada del día (minutos programados del weekday, sin restar refrigerio),
  donde valor día = sueldo mensual / 30 (D.S. 012-92-TR, art. 2). El divisor 30
  es fijo: no depende de si el mes tiene 28, 29, 30 o 31 días.
- Dinero SIEMPRE en Decimal; se redondea a céntimos una sola vez por día.
"""

import uuid
from datetime import date
from decimal import Decimal, ROUND_HALF_UP

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.legal import daily_value, hourly_value, hourly_value_out
from app.modules.adjustments.models import ADJUSTMENT_APPROVED
from app.modules.adjustments.repository import AdjustmentRepository
from app.modules.attendance.repository import AttendanceRepository
from app.modules.attendance.manual_models import ManualAttendanceDay
from app.modules.employees.repository import EmployeeRepository
from app.modules.overtime_policy.service import OvertimePolicyService
from app.modules.overtime_policy.models import MIN_ADDITIONAL_HOURS, MIN_FIRST_TWO_HOURS
from app.modules.salary.service import SalaryService
from app.modules.schedules.service import ScheduleService
from app.modules.work_calendar.service import WorkCalendarService

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
        by_day: dict[date, int] = {}
        for record in records:
            if record.status != "COMPLETE" or record.worked_minutes is None:
                continue
            by_day[record.work_date] = by_day.get(record.work_date, 0) + record.worked_minutes
        detected = []
        expected_by_day = ScheduleService(self.db).expected_minutes_for_days(
            {employee_id: by_day.keys()}
        )
        for work_date, worked_minutes in sorted(by_day.items()):
            expected = expected_by_day[(employee_id, work_date)]
            if expected <= 0:
                # Una jornada cero no es HE ordinaria. CAL expone estos casos
                # mediante su calendario y preview, sin añadir consultas por
                # día a este detector de alto tráfico.
                continue
            extra = worked_minutes - expected
            if extra > 0:
                detected.append(
                    {
                        "work_date": work_date,
                        "worked_minutes": worked_minutes,
                        "expected_minutes": expected,
                        "extra_minutes": extra,
                        "classification": "ORDINARY_OVERTIME",
                    }
                )
        return detected

    def hourly_rate(self, employee_id: uuid.UUID, ref: date) -> Decimal:
        """Valor día legal / horas de la jornada del día (D.S. 007-2002-TR, art. 12)."""
        salary = SalaryService(self.db).get_for_date(employee_id, ref)
        if salary is None:
            return Decimal("0")
        day_minutes = ScheduleService(self.db).expected_minutes(employee_id, ref)
        if day_minutes <= 0:
            return Decimal("0")
        return hourly_value_out(salary.monthly_salary, day_minutes)

    def _raw_hourly_rate(self, employee_id: uuid.UUID, ref: date) -> Decimal:
        salary = SalaryService(self.db).get_for_date(employee_id, ref)
        if salary is None:
            return Decimal("0")
        day_minutes = ScheduleService(self.db).expected_minutes(employee_id, ref)
        if day_minutes <= 0:
            return Decimal("0")
        return hourly_value(salary.monthly_salary, day_minutes)

    def special_day_hourly_rate(self, employee_id: uuid.UUID, ref: date) -> Decimal:
        """Tarifa de CAL-01/03 usando referencia histórica, aun con jornada cero."""
        salary = SalaryService(self.db).get_for_date(employee_id, ref)
        if salary is None:
            return Decimal("0")
        reference = WorkCalendarService(self.db).resolve_employee_day(employee_id, ref)["reference_daily_minutes"]
        return daily_value(salary.monthly_salary) / (Decimal(reference) / Decimal(60))

    @staticmethod
    def _effective_rates_from_history(salary, policies, day: date) -> dict:
        """Equivalente en memoria de la política vigente para un lote diario."""
        if salary is not None and salary.use_custom_overtime_rates:
            return {
                "first_two_hours_rate": salary.custom_first_two_hours_rate,
                "additional_hours_rate": salary.custom_additional_hours_rate,
                "source": "employee_override",
            }
        policy = next(
            (
                item
                for item in policies
                if item.effective_from <= day
                and (item.effective_to is None or item.effective_to >= day)
            ),
            None,
        )
        if policy is not None:
            return {
                "first_two_hours_rate": policy.first_two_hours_rate,
                "additional_hours_rate": policy.additional_hours_rate,
                "source": "company_policy",
            }
        return {
            "first_two_hours_rate": MIN_FIRST_TWO_HOURS.quantize(Decimal("0.01")),
            "additional_hours_rate": MIN_ADDITIONAL_HOURS.quantize(Decimal("0.01")),
            "source": "company_policy",
        }

    def value(self, employee_id: uuid.UUID, date_from: date, date_to: date) -> dict:
        """Valor monetario de las horas extra APROBADAS en el rango, por tramos diarios."""
        self._get_employee(employee_id)
        if date_from > date_to:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="date_from no puede ser posterior a date_to",
            )

        adjustments = self.adjustments.list_in_range(
            employee_id, date_from, date_to,
            status=ADJUSTMENT_APPROVED, adjustment_type="OVERTIME",
            # Un día con descanso/feriado valorado (aunque siga pendiente de
            # aprobación) nunca se re-paga como hora extra ordinaria.
            exclude_active_special_days=True,
        )

        # Rows approved through the versioned contract carry the exact
        # valuation that was reviewed.  They must never be repriced when a
        # salary, schedule or policy changes after approval.  Older rows have
        # no snapshot and retain the pre-existing dynamic calculation.
        snapshotted_adjustments = [item for item in adjustments if item.approval_snapshot_data]
        dynamic_adjustments = [item for item in adjustments if not item.approval_snapshot_data]

        # Agrupar los legados sin snapshot por día (tramo diario reiniciado).
        by_day: dict[date, int] = {}
        for adj in dynamic_adjustments:
            by_day[adj.adjustment_date] = by_day.get(adj.adjustment_date, 0) + adj.minutes

        salaries = SalaryService(self.db)
        policy = OvertimePolicyService(self.db)
        dynamic_days = list(by_day)
        salary_by_day = salaries.get_for_days({employee_id: dynamic_days})
        schedule_minutes_by_day = ScheduleService(self.db).expected_minutes_for_days(
            {employee_id: dynamic_days}
        )
        # list_history ya viene de más reciente a más antigua, el mismo
        # desempate usado por get_for_date.
        policy_history = policy.list_history()

        total = Decimal("0.00")
        breakdown = []

        for day, total_minutes in sorted(by_day.items()):
            salary = salary_by_day[(employee_id, day)]
            first_two = min(total_minutes, _FIRST_TWO_MINUTES)
            additional = max(total_minutes - _FIRST_TWO_MINUTES, 0)
            if salary is None or not salary.overtime_enabled:
                skip_reason = "MISSING_SALARY" if salary is None else "DISABLED"
                breakdown.append(
                    {
                        "adjustment_date": day,
                        "minutes": total_minutes,
                        "payable_minutes": total_minutes,
                        "requested_minutes": total_minutes,
                        "break_minutes": 0,
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

            rates = self._effective_rates_from_history(salary, policy_history, day)
            day_minutes = schedule_minutes_by_day[(employee_id, day)]
            # Valor día legal / horas de la jornada del trabajador (art. 12).
            hourly = hourly_value(salary.monthly_salary, day_minutes)
            if hourly <= 0:
                skip_reason = "MISSING_SCHEDULE"
                breakdown.append(
                    {
                        "adjustment_date": day,
                        "minutes": total_minutes,
                        "payable_minutes": total_minutes,
                        "requested_minutes": total_minutes,
                        "break_minutes": 0,
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
                    "requested_minutes": total_minutes,
                    "break_minutes": 0,
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

        for item in snapshotted_adjustments:
            valuation = (item.approval_snapshot_data or {}).get("valuation") or {}
            valuation_inputs = valuation.get("valuation_inputs") or {}
            amount = Decimal(str(valuation.get("amount") or "0.00"))
            payable_minutes = int(valuation.get("minutes", item.minutes))
            requested_minutes = int(valuation.get("requested_minutes", item.minutes))
            break_minutes = int(valuation.get("break_minutes", 0))
            total += amount
            breakdown.append({
                "adjustment_date": item.adjustment_date, "minutes": payable_minutes,
                "payable_minutes": payable_minutes,
                "requested_minutes": requested_minutes, "break_minutes": break_minutes,
                "first_two_minutes": min(payable_minutes, _FIRST_TWO_MINUTES),
                "additional_minutes": max(0, payable_minutes - _FIRST_TWO_MINUTES),
                "first_two_hours_rate": Decimal(str(valuation.get("first_two_hours_rate") or "0")),
                "additional_hours_rate": Decimal(str(valuation.get("additional_hours_rate") or "0")),
                # Preserve the valuation provenance shown at approval while
                # still making clear the number itself is snapshotted.
                "source": valuation_inputs.get("rate_source") or "approved_adjustment_snapshot",
                "hourly_rate": Decimal(str(valuation.get("hourly_rate") or "0")),
                "value": amount,
                "skip_reason": (
                    "DISABLED" if valuation.get("reason") == "OVERTIME_DISABLED"
                    else valuation.get("reason")
                ),
            })

        from app.modules.work_calendar.models import (
            SpecialDayValuation,
            VALUATION_APPROVED,
            VALUATION_PENDING,
            VALUATION_REVIEW_REQUIRED,
        )
        manual = list(self.db.scalars(select(ManualAttendanceDay).where(
            ManualAttendanceDay.employee_id == employee_id,
            ManualAttendanceDay.work_date >= date_from,
            ManualAttendanceDay.work_date <= date_to,
            ManualAttendanceDay.voided_at.is_(None),
            ManualAttendanceDay.payment_status == "APPROVED",
            ManualAttendanceDay.work_date.not_in(select(SpecialDayValuation.work_date).where(
                SpecialDayValuation.employee_id == employee_id,
                SpecialDayValuation.work_date >= date_from,
                SpecialDayValuation.work_date <= date_to,
                SpecialDayValuation.status.in_((VALUATION_APPROVED, VALUATION_PENDING, VALUATION_REVIEW_REQUIRED)),
                SpecialDayValuation.voided_at.is_(None),
            )),
        )))
        for item in manual:
            snapshot = item.payment_snapshot or {}
            amount = Decimal(str(snapshot.get("amount") or "0.00"))
            # El adicional pagable vive en el snapshot; el pedido crudo queda
            # en ``additional_minutes`` y ya no se usa para pagar.
            payable = int(snapshot.get("minutes", item.additional_minutes))
            break_minutes = int(snapshot.get("break_minutes", 0))
            total += amount
            breakdown.append({"adjustment_date": item.work_date, "minutes": payable, "payable_minutes": payable, "requested_minutes": item.additional_minutes, "break_minutes": break_minutes, "first_two_minutes": min(payable, _FIRST_TWO_MINUTES), "additional_minutes": max(0, payable - _FIRST_TWO_MINUTES), "first_two_hours_rate": Decimal(str(snapshot.get("first_two_hours_rate") or "0")), "additional_hours_rate": Decimal(str(snapshot.get("additional_hours_rate") or "0")), "source": "historical_manual", "hourly_rate": Decimal(str(snapshot.get("hourly_rate") or "0")), "value": amount, "skip_reason": None})
        overtime_minutes = (
            sum(item["minutes"] for item in breakdown)
        )
        return {
            "date_from": date_from,
            "date_to": date_to,
            "overtime_minutes": overtime_minutes,
            "value": total.quantize(_CENTS, rounding=ROUND_HALF_UP),
            "breakdown": breakdown,
        }
