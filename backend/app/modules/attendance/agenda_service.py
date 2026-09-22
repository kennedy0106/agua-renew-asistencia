"""Lecturas del perfil de asistencia: agenda y acumulado sin mutar planilla.

Estas consultas reutilizan asistencia, ajustes, HST-01 y sueldo vigente. No
crean periodos, no recalculan snapshots y nunca generan marcas del kiosco.

La base acumulada no reparte la quincena ni el mes entre los días transcurridos:
cada fecha calendario en relación laboral aporta su treintavo legal (sueldo
vigente / 30) y la conciliación con el sueldo/Q1/Q2 oficial se informa como una
regularización separada, anclada a fechas reales de cierre. El valor día de ley
es sueldo / 30 (D.S. 012-92-TR, art. 2), constante en meses de 28, 29, 30 o 31
días.
"""
from __future__ import annotations

import uuid
from calendar import monthrange
from datetime import date, timedelta
from decimal import Decimal, ROUND_HALF_UP

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.legal import daily_value, daily_value_out, fortnight_halves
from app.core.timezone import lima_now
from app.modules.adjustments.models import ADJUSTMENT_APPROVED, HourAdjustment
from app.modules.adjustments.service import AdjustmentService
from app.modules.attendance.manual_models import ManualAttendanceDay, ManualRecoveryApplication, RecoveryCommitment
from app.modules.attendance.manual_service import ManualAttendanceService
from app.modules.attendance.models import AttendanceRecord
from app.modules.attendance.service import AttendanceService
from app.modules.audit.models import AuditLog
from app.modules.employees.models import Employee
from app.modules.overtime.service import OvertimeService
from app.modules.payroll.models import PERIOD_CALCULATED, PERIOD_CLOSED, PayrollPeriod, PayrollRecord
from app.modules.schedules.service import ScheduleService
from app.modules.salary.service import SalaryService
from app.modules.work_calendar.models import SpecialDayValuation, VALUATION_APPROVED

_CENTS = Decimal("0.01")
_MAX_AGENDA_DAYS = 366


class EmployeeAgendaService:
    def __init__(self, db: Session):
        self.db = db

    def _employee(self, employee_id: uuid.UUID) -> Employee:
        employee = self.db.get(Employee, employee_id)
        if employee is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Empleado no encontrado")
        return employee

    @staticmethod
    def _range(date_from: date, date_to: date) -> list[date]:
        if date_from > date_to:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="date_from no puede ser posterior a date_to")
        if (date_to - date_from).days + 1 > _MAX_AGENDA_DAYS:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=f"El rango máximo es de {_MAX_AGENDA_DAYS} días")
        return [date_from + timedelta(days=offset) for offset in range((date_to - date_from).days + 1)]

    def _adjustment_out(self, item: HourAdjustment) -> dict:
        return {
            "id": str(item.id), "version": item.version,
            "adjustment_date": item.adjustment_date, "minutes": item.minutes,
            "adjustment_type": item.adjustment_type, "reason": item.reason,
            "status": item.status, "approved_by": str(item.approved_by) if item.approved_by else None,
            "approved_at": item.approved_at, "supersedes_id": str(item.supersedes_id) if item.supersedes_id else None,
            "voided_at": item.voided_at, "void_reason": item.void_reason,
            "approval_snapshot": (
                AdjustmentService(self.db).approval_snapshot(item)
                if item.status == "PENDING" else item.approval_snapshot_data
            ),
        }

    def agenda(self, employee_id: uuid.UUID, date_from: date, date_to: date) -> dict:
        employee = self._employee(employee_id)
        days = self._range(date_from, date_to)
        attendance_daily = {
            item["work_date"]: item for item in AttendanceService(self.db).list_daily(
                employee_id=employee_id, date_from=date_from, date_to=date_to
            )
        }
        records_by_day: dict[date, list[AttendanceRecord]] = {}
        for record in self.db.scalars(select(AttendanceRecord).where(
            AttendanceRecord.employee_id == employee_id,
            AttendanceRecord.work_date >= date_from,
            AttendanceRecord.work_date <= date_to,
        ).order_by(AttendanceRecord.check_in_at)):
            records_by_day.setdefault(record.work_date, []).append(record)
        manual_by_day = {
            item.work_date: item for item in self.db.scalars(select(ManualAttendanceDay).where(
                ManualAttendanceDay.employee_id == employee_id,
                ManualAttendanceDay.work_date >= date_from,
                ManualAttendanceDay.work_date <= date_to,
                ManualAttendanceDay.voided_at.is_(None),
            ))
        }
        # The agenda's current card uses the active version, but the profile
        # must also remain an audit trail after a correction or void.  Do not
        # make historical versions disappear merely because they no longer
        # participate in totals.
        manual_history_by_day: dict[date, list[ManualAttendanceDay]] = {}
        for item in self.db.scalars(select(ManualAttendanceDay).where(
            ManualAttendanceDay.employee_id == employee_id,
            ManualAttendanceDay.work_date >= date_from,
            ManualAttendanceDay.work_date <= date_to,
        ).order_by(ManualAttendanceDay.work_date, ManualAttendanceDay.version)):
            manual_history_by_day.setdefault(item.work_date, []).append(item)
        adjustments_by_day: dict[date, list[HourAdjustment]] = {}
        for item in self.db.scalars(select(HourAdjustment).where(
            HourAdjustment.employee_id == employee_id,
            HourAdjustment.adjustment_date >= date_from,
            HourAdjustment.adjustment_date <= date_to,
            HourAdjustment.voided_at.is_(None),
        ).order_by(HourAdjustment.created_at)):
            adjustments_by_day.setdefault(item.adjustment_date, []).append(item)
        adjustment_history_by_day: dict[date, list[HourAdjustment]] = {}
        for item in self.db.scalars(select(HourAdjustment).where(
            HourAdjustment.employee_id == employee_id,
            HourAdjustment.adjustment_date >= date_from,
            HourAdjustment.adjustment_date <= date_to,
        ).order_by(HourAdjustment.adjustment_date, HourAdjustment.created_at)):
            adjustment_history_by_day.setdefault(item.adjustment_date, []).append(item)
        commitments_by_day: dict[date, list[RecoveryCommitment]] = {}
        commitments = list(self.db.scalars(select(RecoveryCommitment).where(
            RecoveryCommitment.employee_id == employee_id,
            RecoveryCommitment.permission_date >= date_from,
            RecoveryCommitment.permission_date <= date_to,
        )))
        for commitment in commitments:
            commitments_by_day.setdefault(commitment.permission_date, []).append(commitment)
        applied_by_commitment = {
            commitment_id: int(minutes or 0)
            for commitment_id, minutes in self.db.execute(
                select(ManualRecoveryApplication.commitment_id, func.coalesce(func.sum(ManualRecoveryApplication.minutes), 0))
                .join(ManualAttendanceDay)
                .where(
                    ManualRecoveryApplication.commitment_id.in_([item.id for item in commitments] or [uuid.uuid4()]),
                    ManualAttendanceDay.voided_at.is_(None),
                ).group_by(ManualRecoveryApplication.commitment_id)
            )
        }
        manual_service = ManualAttendanceService(self.db)
        history_ids = [
            *[item for rows in manual_history_by_day.values() for item in rows],
            *[item for rows in adjustment_history_by_day.values() for item in rows],
        ]
        audit_ids = [item.id for item in history_ids]
        audit_by_id: dict[uuid.UUID, list[dict]] = {}
        if audit_ids:
            for log in self.db.scalars(select(AuditLog).where(AuditLog.entity_id.in_(audit_ids)).order_by(AuditLog.created_at.desc())):
                audit_by_id.setdefault(log.entity_id, []).append({
                    "id": str(log.id), "action": log.action, "reason": log.reason,
                    "created_at": log.created_at, "performed_by": str(log.performed_by) if log.performed_by else None,
                })
        expected_by_day = ScheduleService(self.db).expected_minutes_for_days(
            {employee_id: days}
        )
        today = lima_now().date()
        output: list[dict] = []
        for work_date in days:
            expected = expected_by_day[(employee_id, work_date)]
            manual = manual_by_day.get(work_date)
            sessions = records_by_day.get(work_date, [])
            daily = attendance_daily.get(work_date)
            adjustments = adjustments_by_day.get(work_date, [])
            statuses: list[str] = []
            within_employment = not (
                (employee.hire_date and work_date < employee.hire_date)
                or (employee.termination_date and work_date > employee.termination_date)
            )
            if not within_employment:
                statuses.append("OUTSIDE_EMPLOYMENT")
            elif manual is not None:
                statuses.append("MANUAL")
            elif sessions:
                statuses.append("OPEN" if any(item.check_out_at is None for item in sessions) else "COMPLETE")
            elif expected <= 0:
                statuses.append("REST")
            elif work_date > today:
                statuses.append("FUTURE")
            else:
                # No se deduce falta: solamente una jornada programada sin dato.
                statuses.append("NO_RECORD")
            if any(item.adjustment_type == "PERMISO" and item.status == ADJUSTMENT_APPROVED for item in adjustments):
                statuses.append("PERMISSION")
            if any(item.adjustment_type == "RECUPERACION" and item.status == ADJUSTMENT_APPROVED for item in adjustments):
                statuses.append("RECOVERY")
            # HST recovery is represented by R and its commitment records the
            # permission on the origin date.  They are independent from legacy
            # adjustments and therefore need their own agenda indicators.
            if manual and manual.recovery_minutes:
                statuses.append("RECOVERY")
            if commitments_by_day.get(work_date):
                statuses.append("PERMISSION")
            if manual and manual.additional_minutes:
                statuses.append("OVERTIME_APPROVED" if manual.payment_status == "APPROVED" else "OVERTIME_PENDING")
            if any(item.adjustment_type == "OVERTIME" for item in adjustments):
                statuses.append("OVERTIME_APPROVED" if any(item.adjustment_type == "OVERTIME" and item.status == ADJUSTMENT_APPROVED for item in adjustments) else "OVERTIME_PENDING")
            output.append({
                "work_date": work_date, "expected_minutes": expected, "statuses": sorted(set(statuses)),
                "worked_minutes": int((daily or {}).get("worked_minutes", 0)),
                "attendance": [{
                    "id": str(item.id), "status": item.status, "check_in_at": item.check_in_at,
                    "check_out_at": item.check_out_at, "worked_minutes": item.worked_minutes,
                } for item in sessions],
                "manual_day": ({**manual_service.serialize(manual), "history": audit_by_id.get(manual.id, [])} if manual else None),
                "adjustments": [{**self._adjustment_out(item), "history": audit_by_id.get(item.id, [])} for item in adjustments],
                "manual_history": [
                    {**manual_service.serialize(item), "history": audit_by_id.get(item.id, [])}
                    for item in manual_history_by_day.get(work_date, [])
                ],
                "adjustment_history": [
                    {**self._adjustment_out(item), "history": audit_by_id.get(item.id, [])}
                    for item in adjustment_history_by_day.get(work_date, [])
                ],
                "recovery_commitments": [{
                    "id": str(item.id), "permission_date": item.permission_date,
                    "agreed_minutes": item.agreed_minutes, "covered_before": item.covered_before,
                    "status": item.status, "applied_minutes": applied_by_commitment.get(item.id, 0),
                } for item in commitments_by_day.get(work_date, [])],
            })
        return {
            "employee_id": str(employee_id), "employee_name": f"{employee.first_name} {employee.last_name}",
            "date_from": date_from, "date_to": date_to, "days": output,
        }

    def accrual(
        self, employee_id: uuid.UUID, *, period: str, anchor_date: date,
        date_from: date | None = None, date_to: date | None = None,
    ) -> dict:
        employee = self._employee(employee_id)
        if period == "FIRST_HALF":
            date_from = anchor_date.replace(day=1)
            date_to = anchor_date.replace(day=15)
        elif period == "SECOND_HALF":
            date_from = anchor_date.replace(day=16)
            date_to = anchor_date.replace(day=monthrange(anchor_date.year, anchor_date.month)[1])
        elif period == "MONTH":
            date_from = anchor_date.replace(day=1)
            date_to = anchor_date.replace(day=monthrange(anchor_date.year, anchor_date.month)[1])
        elif period != "CUSTOM" or date_from is None or date_to is None:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="CUSTOM requiere date_from y date_to")
        assert date_from is not None and date_to is not None
        days = self._range(date_from, date_to)
        today = lima_now().date()
        cutoff = min(today, date_to)
        # The accumulated view is "hasta el corte".  Future rows must neither
        # become pending money nor leak approved money into a past cutoff.
        manual_by_day = {item.work_date: item for item in self.db.scalars(select(ManualAttendanceDay).where(
            ManualAttendanceDay.employee_id == employee_id, ManualAttendanceDay.work_date >= date_from,
            ManualAttendanceDay.work_date <= cutoff, ManualAttendanceDay.voided_at.is_(None),
        ))}
        legacy_by_day: dict[date, list[HourAdjustment]] = {}
        for item in self.db.scalars(select(HourAdjustment).where(
            HourAdjustment.employee_id == employee_id, HourAdjustment.adjustment_date >= date_from,
            HourAdjustment.adjustment_date <= cutoff, HourAdjustment.voided_at.is_(None),
            HourAdjustment.adjustment_type == "OVERTIME",
        )):
            legacy_by_day.setdefault(item.adjustment_date, []).append(item)
        approved_values = {}
        if date_from <= cutoff:
            approved_values = {
                item["adjustment_date"]: Decimal(str(item["value"]))
                for item in OvertimeService(self.db).value(employee_id, date_from, cutoff)["breakdown"]
            }
        special_by_day: dict[date, Decimal] = {}
        pending_special_by_day: dict[date, Decimal] = {}
        for item in self.db.scalars(select(SpecialDayValuation).where(
            SpecialDayValuation.employee_id == employee_id,
            SpecialDayValuation.work_date >= date_from,
            SpecialDayValuation.work_date <= cutoff,
            SpecialDayValuation.voided_at.is_(None),
        )):
            target = special_by_day if item.status == VALUATION_APPROVED else pending_special_by_day
            target[item.work_date] = target.get(item.work_date, Decimal("0.00")) + item.amount
        salary_service = SalaryService(self.db)
        # ``base_amount`` de cada fecha es SIEMPRE el treintavo legal puro
        # (sueldo vigente / 30) redondeado a céntimos; el evento de regularización
        # jamás se suma a la base del día. Toda la conciliación con el sueldo
        # mensual y con Q1/Q2 —incluido el residuo de redondear cada fila— vive
        # en ``regularization_amount``, de modo que
        # sum(base_amount) + sum(regularization_amount) = base_amount del resumen
        # exactamente a céntimos para MONTH, FIRST_HALF, SECOND_HALF y CUSTOM.
        # Los días posteriores al corte no aportan.
        base_by_day: dict[date, Decimal] = {}
        regularization_by_day: dict[date, Decimal] = {}
        # Valor día de ley por fecha (sueldo / 30), independiente del reparto.
        legal_daily_by_day: dict[date, Decimal] = {}
        # Se acumulan los sueldos y se divide entre 30 una sola vez: sumar
        # divisiones truncadas sesgaba el redondeo (15 × 1500.01/30 caía bajo
        # 750.005 y bajaba a 750.00).
        base_salary_sum = Decimal("0.00")
        event_numerator_total = Decimal("0.00")
        months = {(item.year, item.month) for item in days}
        for year, month in months:
            month_start = date(year, month, 1)
            month_end = date(year, month, monthrange(year, month)[1])
            month_days = [
                month_start + timedelta(days=offset)
                for offset in range((month_end - month_start).days + 1)
            ]
            active_days = [
                item_day for item_day in month_days
                if not (
                    (employee.hire_date and item_day < employee.hire_date)
                    or (employee.termination_date and item_day > employee.termination_date)
                )
            ]
            salary_by_day = salary_service.get_for_days({employee_id: active_days})
            for item_day in active_days:
                salary = salary_by_day.get((employee_id, item_day))
                if salary is None:
                    continue
                legal_daily_by_day[item_day] = daily_value_out(salary.monthly_salary)
                if date_from <= item_day <= date_to and item_day <= cutoff:
                    base_salary_sum += salary.monthly_salary
                    base_by_day[item_day] = daily_value(salary.monthly_salary).quantize(
                        _CENTS, rounding=ROUND_HALF_UP
                    )
        # Normalización de cierre por cada mes completo y ya transcurrido
        # (fin de mes <= corte). El sueldo mensual remunera 30 días legales: se
        # concilia Q2 con el sueldo vigente al cierre para que un día 31 no cree
        # un treintavo extra y febrero complete los 30 días. Q1 conserva los
        # treintavos reales de 1–15 y Q2 cierra en 15 treintavos del sueldo de
        # cierre (con aumento el 16: Q1 325 + Q2 350 = 675, en enero o agosto).
        # Altas o ceses parciales no llevan normalización: suman treintavos
        # reales. Cada conciliación se lleva como numerador (×30) para dividir
        # una sola vez y no sesgar el redondeo.
        for year, month in months:
            month_start = date(year, month, 1)
            month_end = date(year, month, monthrange(year, month)[1])
            if (employee.hire_date and employee.hire_date > month_start) or (
                employee.termination_date and employee.termination_date < month_end
            ):
                continue
            if not (date_from <= month_end <= date_to and month_end <= cutoff):
                continue
            closing = salary_service.get_for_date(employee_id, month_end)
            midpoint = salary_service.get_for_date(employee_id, date(year, month, 15))
            if closing is None or midpoint is None:
                continue
            month_days = [
                month_start + timedelta(days=offset)
                for offset in range((month_end - month_start).days + 1)
            ]
            salary_by_month = salary_service.get_for_days({employee_id: month_days})
            month_salary_sum = sum(
                (
                    salary.monthly_salary
                    for item_day in month_days
                    if (salary := salary_by_month.get((employee_id, item_day))) is not None
                ),
                Decimal("0.00"),
            )
            second_half_salary_sum = sum(
                (
                    salary.monthly_salary
                    for item_day in month_days
                    if item_day.day >= 16
                    and (salary := salary_by_month.get((employee_id, item_day))) is not None
                ),
                Decimal("0.00"),
            )
            days_in_month = Decimal(monthrange(year, month)[1])
            month_numerator = month_salary_sum + (Decimal(30) - days_in_month) * closing.monthly_salary
            month_target = (month_numerator / Decimal(30)).quantize(_CENTS, rounding=ROUND_HALF_UP)
            q1_target, _ = fortnight_halves(midpoint.monthly_salary)
            q2_target = (month_target - q1_target).quantize(_CENTS, rounding=ROUND_HALF_UP)
            event_numerator = Decimal(30) * q2_target - second_half_salary_sum
            event_numerator_total += event_numerator
            regularization_by_day[month_end] = (
                regularization_by_day.get(month_end, Decimal("0.00"))
                + (event_numerator / Decimal(30)).quantize(_CENTS, rounding=ROUND_HALF_UP)
            ).quantize(_CENTS, rounding=ROUND_HALF_UP)
        base_total = ((base_salary_sum + event_numerator_total) / Decimal(30)).quantize(
            _CENTS, rounding=ROUND_HALF_UP
        )
        # Residuo de redondear cada treintavo. Se acumula en la última fecha del
        # rango (ancla de cierre) para que los componentes visibles sumen la base
        # exacta del resumen sin agregar ni perder un centavo.
        rounded_base_total = sum(base_by_day.values(), Decimal("0.00"))
        residual = (
            base_total - rounded_base_total - sum(regularization_by_day.values(), Decimal("0.00"))
        ).quantize(_CENTS, rounding=ROUND_HALF_UP)
        eligible_days = [item_day for item_day in days if item_day <= cutoff]
        if eligible_days and residual != Decimal("0.00"):
            anchor = eligible_days[-1]
            regularization_by_day[anchor] = regularization_by_day.get(anchor, Decimal("0.00")) + residual
        # Regularización visible total = base conciliada - treintavos mostrados.
        closing_regularization = (base_total - rounded_base_total).quantize(_CENTS, rounding=ROUND_HALF_UP)
        daily: list[dict] = []
        approved_total = Decimal("0.00")
        pending_total = Decimal("0.00")
        for work_date in days:
            base_amount = base_by_day.get(work_date, Decimal("0.00"))
            regularization_amount = regularization_by_day.get(work_date, Decimal("0.00"))
            manual = manual_by_day.get(work_date)
            approved = approved_values.get(work_date, Decimal("0.00"))
            approved += special_by_day.get(work_date, Decimal("0.00"))
            pending = Decimal("0.00")
            pending += pending_special_by_day.get(work_date, Decimal("0.00"))
            if manual and manual.additional_minutes and manual.payment_status != "APPROVED":
                amount = (manual.payment_snapshot or {}).get("amount")
                pending += Decimal(str(amount)) if amount is not None else Decimal("0.00")
            for overtime in legacy_by_day.get(work_date, []):
                if overtime.status == "PENDING":
                    estimate = ManualAttendanceService(self.db).estimate_payment(employee_id, work_date, overtime.minutes)
                    if estimate.get("amount") is not None:
                        pending += Decimal(str(estimate["amount"]))
            approved_total += approved
            pending_total += pending
            daily.append({
                "work_date": work_date,
                # Treintavo legal del día (0 en días futuros). El evento de
                # regularización y el residuo de redondeo se informan aparte y
                # nunca se reparten entre jornadas ni se suman a la base del día.
                "base_amount": base_amount,
                "regularization_amount": regularization_amount,
                "legal_daily_value": legal_daily_by_day.get(work_date, Decimal("0.00")),
                "approved_additional_amount": approved, "pending_additional_amount": pending,
                "estimated_total_amount": (base_amount + regularization_amount + approved).quantize(_CENTS, rounding=ROUND_HALF_UP),
            })
        record = self.db.execute(select(PayrollRecord, PayrollPeriod).join(PayrollPeriod).where(
            PayrollRecord.employee_id == employee_id,
            PayrollPeriod.start_date == date_from, PayrollPeriod.end_date == date_to,
            PayrollPeriod.status.in_((PERIOD_CALCULATED, PERIOD_CLOSED)),
        ).order_by(PayrollPeriod.version.desc())).first()
        manual_adjustment = Decimal("0.00")
        official = None
        closed_period = None
        if record is not None:
            payroll_record, payroll_period = record
            manual_adjustment = payroll_record.manual_adjustment
            # A calculated period may contribute a documented monetary manual
            # adjustment, but only a CLOSED period is an official snapshot.
            official = payroll_record.total if payroll_period.status == PERIOD_CLOSED else None
            closed_period = ({"id": str(payroll_period.id), "version": payroll_period.version, "status": payroll_period.status}
                             if payroll_period.status == PERIOD_CLOSED else None)
        cutoff_salary = salary_service.get_for_date(employee_id, cutoff)
        legal_daily_value = daily_value_out(cutoff_salary.monthly_salary) if cutoff_salary else Decimal("0.00")
        return {
            "employee_id": str(employee_id), "date_from": date_from, "date_to": date_to,
            "cutoff_date": cutoff, "base_amount": base_total,
            # Componente de conciliación exacta con el sueldo/Q1/Q2 oficial.
            # Distinto del valor diario y solo presente cuando el periodo cerró.
            "closing_regularization_amount": closing_regularization,
            # Valor día de ley (sueldo / 30): referencia para descuentos y
            # valoraciones. No cambia si el mes tiene 28, 29, 30 o 31 días.
            "legal_daily_value": legal_daily_value,
            "approved_additional_amount": approved_total.quantize(_CENTS),
            "pending_additional_amount": pending_total.quantize(_CENTS),
            "manual_adjustment_amount": manual_adjustment,
            "estimated_total": (base_total + approved_total + manual_adjustment).quantize(_CENTS),
            "official_total_snapshot": official, "closed_period": closed_period, "daily": daily,
        }
