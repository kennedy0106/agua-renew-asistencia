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

import hashlib
import json
import uuid
from calendar import monthrange
from datetime import date, datetime, timedelta
from decimal import Decimal, ROUND_HALF_UP

from fastapi import HTTPException, status
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.modules.adjustments.models import HourAdjustment
from app.modules.adjustments.repository import AdjustmentRepository
from app.modules.attendance.models import AttendanceRecord
from app.modules.attendance.totals import worked_minutes as consolidated_worked_minutes
from app.modules.attendance.manual_models import ManualAttendanceDay, ManualRecoveryApplication
from app.modules.attendance.service import AttendanceService
from app.modules.audit.repository import AuditRepository
from app.modules.employees.models import Employee
from app.modules.overtime.service import OvertimeService
from app.modules.payroll.models import (
    PERIOD_CALCULATED,
    PERIOD_CLOSED,
    PERIOD_OPEN,
    RECORD_EXCLUDED,
    RECORD_PREVIEW,
    PayrollPeriod,
    PayrollRecord,
)
from app.modules.payroll.repository import PayrollRepository
from app.modules.salary.service import SalaryService
from app.modules.schedules.service import ScheduleService
from app.core.timezone import lima_tz

_CENTS = Decimal("0.01")


def _report_today() -> date:
    """Fecha operacional para la vista informativa, siempre en Lima."""
    return datetime.now(lima_tz()).date()


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
        last_day = monthrange(start_date.year, start_date.month)[1]
        if start_date.day != 1 or end_date != date(start_date.year, start_date.month, last_day):
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="El periodo debe cubrir un mes calendario completo",
            )
        period = self.repo.create_period(name=name.strip(), start_date=start_date, end_date=end_date)
        self.db.commit()
        self.db.refresh(period)
        return period

    def list_periods(self) -> list[PayrollPeriod]:
        return self.repo.list_periods()

    def _get_period_or_404(self, period_id: uuid.UUID, *, for_update: bool = False) -> PayrollPeriod:
        period = self.repo.get_period(period_id, for_update=for_update)
        if period is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Periodo no encontrado")
        return period

    # --- Cálculo ---

    def calculate(self, period_id: uuid.UUID) -> list[PayrollRecord]:
        period = self._get_period_or_404(period_id, for_update=True)
        if period.status == PERIOD_CLOSED:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="El periodo está cerrado: no se puede recalcular",
            )

        snapshots = self._eligible_snapshots(period)
        existing = {record.employee_id: record for record in self.repo.list_records(period_id)}
        predecessor: dict[uuid.UUID, PayrollRecord] = {}
        if period.supersedes_period_id:
            predecessor = {
                record.employee_id: record for record in self.repo.list_records(period.supersedes_period_id)
            }
        try:
            for snapshot in snapshots:
                employee_id = snapshot["employee_id"]
                record = existing.pop(employee_id, None)
                if record is None:
                    record = PayrollRecord()
                    record.payroll_period_id = period_id
                    record.employee_id = employee_id
                    record.manual_adjustment = Decimal("0.00")
                    prev = predecessor.get(employee_id)
                    if prev is not None:
                        record.manual_adjustment = prev.manual_adjustment
                        record.notes = prev.notes
                record.monthly_salary = snapshot["monthly_salary"]
                record.worked_minutes = snapshot["worked_minutes"]
                record.expected_minutes = snapshot["expected_minutes"]
                record.overtime_minutes = snapshot["overtime_minutes"]
                record.overtime_amount = snapshot["overtime_amount"]
                record.adjustment_minutes = snapshot["adjustment_minutes"]
                record.adjustment_amount = Decimal("0.00")
                record.base_salary = snapshot["base_salary"]
                record.missing_salary_days = snapshot["missing_salary_days"]
                record.total = (record.base_salary + record.overtime_amount + record.manual_adjustment).quantize(
                    _CENTS, rounding=ROUND_HALF_UP
                )
                record.status = RECORD_PREVIEW
                record.payable = True
                self.db.add(record)

            for leftover in existing.values():
                leftover.status = RECORD_EXCLUDED
                leftover.payable = False
                self.db.add(leftover)

            period.status = PERIOD_CALCULATED
            period.inputs_fingerprint = self._fingerprint(snapshots)
            self.db.add(period)
            self.db.commit()
        except Exception:
            self.db.rollback()
            raise
        return self.repo.list_records(period_id)

    def _eligible_snapshots(self, period: PayrollPeriod) -> list[dict]:
        salaries = SalaryService(self.db)
        schedules = ScheduleService(self.db)
        adjustments = AdjustmentRepository(self.db)
        overtime = OvertimeService(self.db)
        snapshots: list[dict] = []
        for employee in self._employees_for_period(period):
            base, reference_salary, missing_salary_days = self._prorated_base(employee, period, salaries)
            if reference_salary is None:
                continue
            valued_overtime = overtime.value(employee.id, period.start_date, period.end_date)
            overtime_minutes = valued_overtime["overtime_minutes"]
            overtime_amount = valued_overtime["value"]
            manual_additional = self._approved_manual_additional(employee.id, period)
            manual_distribution = self._manual_distribution(employee.id, period)
            # OvertimeService ya incorpora el importe aprobado de P; aquí solo
            # conservamos su identidad/distribución en el fingerprint.
            snapshots.append(
                {
                    "employee_id": employee.id,
                    "monthly_salary": reference_salary.monthly_salary,
                    "worked_minutes": self._sum_worked_minutes(employee.id, period),
                    "expected_minutes": self._sum_expected_minutes(schedules, employee, period),
                    "overtime_minutes": overtime_minutes,
                    "overtime_amount": overtime_amount,
                    "manual_additional": manual_additional["fingerprint"],
                    "manual_distribution": manual_distribution,
                    "adjustment_minutes": adjustments.approved_minutes_in_range(
                        employee.id, period.start_date, period.end_date
                    )
                    - overtime_minutes,
                    "base_salary": base,
                    "missing_salary_days": missing_salary_days,
                }
            )
        snapshots.sort(key=lambda item: str(item["employee_id"]))
        return snapshots

    def _manual_distribution(self, employee_id: uuid.UUID, period: PayrollPeriod) -> list[dict]:
        """Representación estable de N/P/R y aplicaciones para invalidar snapshots.

        Dos cargas con el mismo W no son equivalentes si cambia su tratamiento,
        su versión o el compromiso origen de R.
        """
        rows = self.db.scalars(select(ManualAttendanceDay).where(
            ManualAttendanceDay.employee_id == employee_id,
            ManualAttendanceDay.work_date >= period.start_date,
            ManualAttendanceDay.work_date <= period.end_date,
            ManualAttendanceDay.voided_at.is_(None),
        ))
        output = []
        for row in sorted(rows, key=lambda item: str(item.id)):
            allocations = self.db.execute(select(ManualRecoveryApplication.commitment_id, ManualRecoveryApplication.minutes).where(ManualRecoveryApplication.manual_day_id == row.id)).all()
            output.append({"id": str(row.id), "version": row.version, "work_date": row.work_date.isoformat(), "W": row.worked_minutes_net, "N": row.normal_minutes, "P": row.additional_minutes, "R": row.recovery_minutes, "payment_status": row.payment_status, "allocations": sorted(({"commitment_id": str(commitment_id), "minutes": minutes} for commitment_id, minutes in allocations), key=lambda item: item["commitment_id"])})
        return output

    def _approved_manual_additional(self, employee_id: uuid.UUID, period: PayrollPeriod) -> dict:
        rows = list(self.db.scalars(select(ManualAttendanceDay).where(
            ManualAttendanceDay.employee_id == employee_id,
            ManualAttendanceDay.work_date >= period.start_date,
            ManualAttendanceDay.work_date <= period.end_date,
            ManualAttendanceDay.voided_at.is_(None),
            ManualAttendanceDay.payment_status == "APPROVED",
            ManualAttendanceDay.additional_minutes > 0,
        )))
        return {
            "minutes": sum(row.additional_minutes for row in rows),
            "amount": sum((row.approved_additional_amount or Decimal("0.00") for row in rows), Decimal("0.00")),
            "fingerprint": [
                {"id": str(row.id), "version": row.version, "minutes": row.additional_minutes,
                 "amount": str(row.approved_additional_amount), "snapshot": row.payment_snapshot,
                 "concept": row.payment_concept, "reference": row.source_reference}
                for row in sorted(rows, key=lambda item: str(item.id))
            ],
        }

    @staticmethod
    def _fingerprint(snapshots: list[dict]) -> str:
        payload = [
            {
                "employee_id": str(item["employee_id"]),
                "monthly_salary": str(item["monthly_salary"]),
                "worked_minutes": item["worked_minutes"],
                "expected_minutes": item["expected_minutes"],
                "overtime_minutes": item["overtime_minutes"],
                "overtime_amount": str(item["overtime_amount"]),
                "manual_additional": item.get("manual_additional", []),
                "manual_distribution": item.get("manual_distribution", []),
                "adjustment_minutes": item["adjustment_minutes"],
                "base_salary": str(item["base_salary"]),
                "missing_salary_days": item["missing_salary_days"],
            }
            for item in snapshots
        ]
        return hashlib.sha256(json.dumps(payload, sort_keys=True).encode("utf-8")).hexdigest()

    def _employees_for_period(self, period: PayrollPeriod) -> list[Employee]:
        return list(
            self.db.scalars(
                select(Employee).where(
                    or_(Employee.hire_date.is_(None), Employee.hire_date <= period.end_date),
                    or_(Employee.termination_date.is_(None), Employee.termination_date >= period.start_date),
                )
            )
        )

    @staticmethod
    def _employment_bounds(employee: Employee, period: PayrollPeriod) -> tuple[date, date]:
        return (
            max(period.start_date, employee.hire_date or period.start_date),
            min(period.end_date, employee.termination_date or period.end_date),
        )

    def _prorated_base(self, employee: Employee, period: PayrollPeriod, salaries: SalaryService):
        active_from, active_to = self._employment_bounds(employee, period)
        if active_from > active_to:
            return Decimal("0.00"), None, 0
        days_in_month = Decimal(monthrange(period.start_date.year, period.start_date.month)[1])
        total = Decimal("0")
        reference = None
        missing_salary_days = 0
        day = active_from
        while day <= active_to:
            salary = salaries.get_for_date(employee.id, day)
            if salary is not None:
                reference = reference or salary
                total += salary.monthly_salary / days_in_month
            else:
                missing_salary_days += 1
            day += timedelta(days=1)
        return total.quantize(_CENTS, rounding=ROUND_HALF_UP), reference, missing_salary_days

    def _sum_worked_minutes(self, employee_id: uuid.UUID, period: PayrollPeriod) -> int:
        total = self.db.scalar(
            select(func.coalesce(func.sum(AttendanceRecord.worked_minutes), 0)).where(
                AttendanceRecord.employee_id == employee_id,
                AttendanceRecord.status == "COMPLETE",
                AttendanceRecord.work_date >= period.start_date,
                AttendanceRecord.work_date <= period.end_date,
            )
        )
        return consolidated_worked_minutes(self.db, employee_id, period.start_date, period.end_date)

    def _sum_expected_minutes(self, schedules: ScheduleService, employee: Employee, period: PayrollPeriod) -> int:
        active_from, active_to = self._employment_bounds(employee, period)
        if active_from > active_to:
            return 0
        total = 0
        day = active_from
        while day <= active_to:
            total += schedules.expected_minutes(employee.id, day)
            day += timedelta(days=1)
        return total

    def readiness(self, period_id: uuid.UUID) -> dict:
        period = self._get_period_or_404(period_id)
        blockers: list[dict] = []
        warnings: list[dict] = []
        salaries = SalaryService(self.db)
        schedules = ScheduleService(self.db)
        for employee in self._employees_for_period(period):
            active_from, active_to = self._employment_bounds(employee, period)
            day = active_from
            missing_salary = False
            missing_schedule = False
            while day <= active_to:
                missing_salary = missing_salary or salaries.get_for_date(employee.id, day) is None
                missing_schedule = missing_schedule or schedules.repo.get_for_date(employee.id, day) is None
                day += timedelta(days=1)
            if missing_salary:
                blockers.append({"code": "MISSING_SALARY", "message": "Empleado sin sueldo para parte del periodo", "employee_id": str(employee.id)})
            if missing_schedule:
                blockers.append({"code": "MISSING_SCHEDULE", "message": "Empleado sin jornada para parte del periodo", "employee_id": str(employee.id)})

        open_records = self.db.scalars(
            select(AttendanceRecord).where(
                AttendanceRecord.status == "OPEN",
                AttendanceRecord.work_date >= period.start_date,
                AttendanceRecord.work_date <= period.end_date,
            )
        )
        for record in open_records:
            blockers.append({"code": "OPEN_ATTENDANCE", "message": "Entrada sin salida", "employee_id": str(record.employee_id), "attendance_record_id": str(record.id)})
        long_records = self.db.scalars(
            select(AttendanceRecord).where(
                AttendanceRecord.status == "COMPLETE",
                AttendanceRecord.work_date >= period.start_date,
                AttendanceRecord.work_date <= period.end_date,
                AttendanceRecord.check_out_at.is_not(None),
            )
        )
        for record in long_records:
            if record.check_out_at and (record.check_out_at - record.check_in_at).total_seconds() > 16 * 3600:
                blockers.append({"code": "LONG_ATTENDANCE", "message": "Sesión mayor de 16 horas", "employee_id": str(record.employee_id), "attendance_record_id": str(record.id)})
        pending = self.db.scalars(
            select(HourAdjustment).where(
                HourAdjustment.status == "PENDING",
                HourAdjustment.adjustment_date >= period.start_date,
                HourAdjustment.adjustment_date <= period.end_date,
            )
        )
        for adjustment in pending:
            blockers.append({"code": "PENDING_ADJUSTMENT", "message": "Ajuste pendiente de aprobación o rechazo", "employee_id": str(adjustment.employee_id)})
        pending_manual = self.db.scalars(select(ManualAttendanceDay).where(ManualAttendanceDay.payment_status == "PENDING", ManualAttendanceDay.work_date >= period.start_date, ManualAttendanceDay.work_date <= period.end_date, ManualAttendanceDay.voided_at.is_(None)))
        for item in pending_manual:
            blockers.append({"code": "PENDING_HISTORICAL_ADDITIONAL", "message": "Hay adicional histórico pendiente de valoración o aprobación", "employee_id": str(item.employee_id)})
        overtime = OvertimeService(self.db)
        for employee in self._employees_for_period(period):
            valued = overtime.value(employee.id, period.start_date, period.end_date)
            unpaid = [
                item
                for item in valued["breakdown"]
                if item.get("skip_reason") or (item["minutes"] > 0 and item["value"] == Decimal("0.00"))
            ]
            if unpaid:
                blockers.append(
                    {
                        "code": "UNVALUED_OVERTIME",
                        "message": "Hay horas extra aprobadas sin valor o con tratamiento documentado pendiente",
                        "employee_id": str(employee.id),
                    }
                )
        return {"ready": not blockers, "blockers": blockers, "warnings": warnings}

    def create_rectification(self, period_id: uuid.UUID, reason: str, current_user_id: uuid.UUID | None) -> PayrollPeriod:
        original = self._get_period_or_404(period_id)
        if original.status != PERIOD_CLOSED:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Solo se rectifican periodos cerrados")
        latest_version = self.db.scalar(
            select(func.max(PayrollPeriod.version)).where(PayrollPeriod.root_period_id == original.root_period_id)
        ) or original.version
        rectification = PayrollPeriod(
            name=original.name,
            start_date=original.start_date,
            end_date=original.end_date,
            root_period_id=original.root_period_id,
            version=latest_version + 1,
            supersedes_period_id=original.id,
            rectification_reason=reason.strip(),
            status=PERIOD_OPEN,
        )
        self.db.add(rectification)
        self.db.flush()
        AuditRepository(self.db).create(
            entity_type="payroll_period",
            entity_id=rectification.id,
            action="rectification_created",
            old_values={"period_id": str(original.id), "version": original.version},
            new_values={"period_id": str(rectification.id), "version": rectification.version},
            reason=reason.strip(),
            performed_by=current_user_id,
            commit=False,
        )
        self.db.commit()
        self.db.refresh(rectification)
        return rectification

    def list_records(self, period_id: uuid.UUID) -> list[PayrollRecord]:
        self._get_period_or_404(period_id)
        return self.repo.list_records(period_id)

    def summary(self, period_id: uuid.UUID) -> dict:
        """Totales del periodo (los calcula el backend; el frontend solo muestra)."""
        period = self._get_period_or_404(period_id)
        records = self.repo.list_records(period_id, payable_only=True)
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

    def daily_report(self, period_id: uuid.UUID) -> dict:
        """Descompone un periodo calculado por empleado y jornada.

        Es una vista de consulta: parte de los importes ya almacenados en
        ``PayrollRecord`` y no escribe ni recalcula el periodo. El sueldo base
        de cada empleado se distribuye proporcionalmente a los minutos de
        jornada vigentes dentro del periodo; el redondeo se ajusta en la última
        jornada para que el acumulado sea exactamente el snapshot.

        Los ajustes de horas aprobados no alteran dinero automáticamente por
        la regla actual del producto, por lo que su importe es siempre 0.00.
        Un ajuste manual de planilla tampoco tiene fecha en el esquema actual:
        se entrega únicamente en el resumen del empleado, sin atribuirlo a una
        jornada artificial.
        """
        period = self._get_period_or_404(period_id)
        records = self.repo.list_records(period_id, payable_only=True)
        schedules = ScheduleService(self.db)
        overtime = OvertimeService(self.db)
        today = _report_today()
        daily: list[dict] = []
        employee_summaries: list[dict] = []

        for record in records:
            employee = record.employee
            if employee is None:
                continue
            active_from, active_to = self._employment_bounds(employee, period)
            if active_from > active_to:
                continue

            attendance_by_day = self._attendance_by_day(employee.id, active_from, active_to)
            approved_by_day = self._approved_adjustments_by_day(employee.id, active_from, active_to)
            overtime_by_day = {
                item["adjustment_date"]: {
                    "minutes": int(item["minutes"]),
                    "amount": item["value"],
                }
                for item in overtime.value(employee.id, active_from, active_to)["breakdown"]
            }

            days: list[dict] = []
            day = active_from
            while day <= active_to:
                expected_minutes = schedules.expected_minutes(employee.id, day)
                overtime_item = overtime_by_day.get(day, {"minutes": 0, "amount": Decimal("0.00")})
                approved_minutes = approved_by_day.get(day, 0)
                attendance = attendance_by_day.get(day)
                worked_minutes = int(attendance["worked_minutes"]) if attendance else 0
                if expected_minutes > 0 or worked_minutes > 0 or approved_minutes != 0 or overtime_item["minutes"] > 0:
                    days.append(
                        {
                            "work_date": day,
                            "worked_minutes": worked_minutes,
                            "expected_minutes": expected_minutes,
                            "overtime_minutes": overtime_item["minutes"],
                            "overtime_amount": overtime_item["amount"],
                            "approved_adjustment_minutes": approved_minutes,
                            # Estos datos no cambian el snapshot de planilla. Solo
                            # permiten que la vista informativa sepa si la jornada
                            # actual ya terminó o sigue recibiendo marcaciones.
                            "has_attendance": attendance is not None,
                            "has_open_entry": bool(attendance["has_open_entry"]) if attendance else False,
                        }
                    )
                day += timedelta(days=1)

            self._allocate_base_amount(days, record.base_salary)
            self._allocate_overtime_amount(days, record.overtime_amount)
            for item in days:
                item["approved_adjustment_amount"] = Decimal("0.00")
                self._set_recognized_amounts(item, today)
                daily.append(
                    {
                        "employee_id": employee.id,
                        "employee_name": f"{employee.first_name} {employee.last_name}",
                        **item,
                    }
                )

            recognized_total = sum((item["recognized_total_amount"] for item in days), Decimal("0.00"))
            employee_summaries.append(
                {
                    "employee_id": employee.id,
                    "employee_name": f"{employee.first_name} {employee.last_name}",
                    "worked_minutes": sum(item["worked_minutes"] for item in days),
                    "expected_minutes": sum(item["expected_minutes"] for item in days),
                    "programmed_base_amount": sum((item["base_amount"] for item in days), Decimal("0.00")),
                    "recognized_base_amount": sum((item["recognized_base_amount"] for item in days), Decimal("0.00")),
                    "overtime_minutes": sum(item["overtime_minutes"] for item in days),
                    "recognized_overtime_amount": sum((item["recognized_overtime_amount"] for item in days), Decimal("0.00")),
                    "approved_adjustment_minutes": sum(item["approved_adjustment_minutes"] for item in days),
                    "approved_adjustment_amount": Decimal("0.00"),
                    "recognized_total_amount": recognized_total,
                    "future_pending_base_amount": sum(
                        (item["base_amount"] for item in days if item["work_date"] > today), Decimal("0.00")
                    ),
                    "review_difference_amount": sum(
                        (item["review_difference_amount"] for item in days), Decimal("0.00")
                    ),
                    "manual_adjustment": record.manual_adjustment,
                    "official_total_snapshot": record.total,
                }
            )

        daily.sort(key=lambda item: (item["employee_name"] or "", item["work_date"]))
        employee_summaries.sort(key=lambda item: item["employee_name"] or "")
        return {
            "period_id": period.id,
            "start_date": period.start_date,
            "end_date": period.end_date,
            "daily": daily,
            "employees": employee_summaries,
        }

    @staticmethod
    def _set_recognized_amounts(item: dict, today: date) -> None:
        """Calcula el reconocimiento informativo sin cambiar el snapshot.

        Hoy se mantiene PENDING mientras no exista asistencia o haya alguna
        sesión abierta. Cuando todas las sesiones de hoy están cerradas, aplica
        exactamente la misma clasificación informativa que un día pasado.
        """
        work_date = item["work_date"]
        expected_minutes = item["expected_minutes"]
        can_recognize = work_date < today or (
            work_date == today and item["has_attendance"] and not item["has_open_entry"]
        )
        if work_date > today:
            status = "FUTURE_PENDING"
            recognized_minutes = 0
        elif not can_recognize:
            status = "PENDING"
            recognized_minutes = 0
        else:
            recognized_minutes = max(
                0,
                min(item["worked_minutes"] + item["approved_adjustment_minutes"], expected_minutes),
            )
            if expected_minutes <= 0:
                status = "RECOGNIZED" if item["overtime_minutes"] > 0 else "NO_ATTENDANCE"
            elif recognized_minutes == 0:
                status = "NO_ATTENDANCE"
            elif recognized_minutes < expected_minutes:
                status = "PARTIAL"
            else:
                status = "RECOGNIZED"

        if expected_minutes > 0:
            recognized_base = (
                item["base_amount"] * Decimal(recognized_minutes) / Decimal(expected_minutes)
            ).quantize(_CENTS, rounding=ROUND_HALF_UP)
        else:
            recognized_base = Decimal("0.00")
        recognized_overtime = item["overtime_amount"] if can_recognize else Decimal("0.00")
        recognized_total = (recognized_base + recognized_overtime).quantize(_CENTS, rounding=ROUND_HALF_UP)
        review_difference = (
            item["base_amount"] + item["overtime_amount"] - recognized_total
            if can_recognize
            else Decimal("0.00")
        ).quantize(_CENTS, rounding=ROUND_HALF_UP)
        item.update(
            recognized_minutes=recognized_minutes,
            status=status,
            recognized_base_amount=recognized_base,
            recognized_overtime_amount=recognized_overtime,
            recognized_total_amount=recognized_total,
            review_difference_amount=review_difference,
        )

    def _attendance_by_day(self, employee_id: uuid.UUID, date_from: date, date_to: date) -> dict[date, dict]:
        """Consolidado diario de asistencia para la vista informativa.

        ``AttendanceService.list_daily`` descuenta un único refrigerio (y su
        override) y elimina sesiones solapadas. No se usa el valor persistido
        por sesión porque puede ser anterior a una corrección diaria. La señal
        de sesión abierta permite distinguir una salida recién registrada de
        una jornada que todavía está en curso.
        """
        daily = AttendanceService(self.db).list_daily(
            employee_id=employee_id, date_from=date_from, date_to=date_to
        )
        return {
            item["work_date"]: {
                "worked_minutes": int(item["worked_minutes"]),
                "has_open_entry": bool(item["has_open_entry"]),
            }
            for item in daily
        }

    def _approved_adjustments_by_day(self, employee_id: uuid.UUID, date_from: date, date_to: date) -> dict[date, int]:
        rows = self.db.execute(
            select(HourAdjustment.adjustment_date, func.coalesce(func.sum(HourAdjustment.minutes), 0))
            .where(
                HourAdjustment.employee_id == employee_id,
                HourAdjustment.status == "APPROVED",
                HourAdjustment.adjustment_type != "OVERTIME",
                HourAdjustment.adjustment_date >= date_from,
                HourAdjustment.adjustment_date <= date_to,
            )
            .group_by(HourAdjustment.adjustment_date)
        )
        return {adjustment_date: int(minutes or 0) for adjustment_date, minutes in rows}

    @staticmethod
    def _allocate_base_amount(days: list[dict], total_base: Decimal) -> None:
        """Reparte el snapshot por minutos pactados y conserva los céntimos."""
        scheduled = [item for item in days if item["expected_minutes"] > 0]
        for item in days:
            item["base_amount"] = Decimal("0.00")
        if not scheduled:
            return
        total_minutes = sum(item["expected_minutes"] for item in scheduled)
        allocated = Decimal("0.00")
        for item in scheduled[:-1]:
            amount = (total_base * Decimal(item["expected_minutes"]) / Decimal(total_minutes)).quantize(
                _CENTS, rounding=ROUND_HALF_UP
            )
            item["base_amount"] = amount
            allocated += amount
        scheduled[-1]["base_amount"] = (total_base - allocated).quantize(_CENTS, rounding=ROUND_HALF_UP)

    @staticmethod
    def _allocate_overtime_amount(days: list[dict], total_overtime: Decimal) -> None:
        """Atribuye el snapshot de HE a sus días sin perder céntimos.

        La valoración en vivo aporta la distribución por día, pero el total
        visible siempre es el que quedó almacenado en el registro de planilla.
        Si una valoración histórica ya no aporta peso monetario, los minutos
        aprobados funcionan como ponderador de respaldo.
        """
        overtime_days = [item for item in days if item["overtime_minutes"] > 0]
        if not overtime_days:
            return
        monetary_weight = sum((item["overtime_amount"] for item in overtime_days), Decimal("0.00"))
        if monetary_weight > 0:
            weights = [item["overtime_amount"] for item in overtime_days]
        else:
            weights = [Decimal(item["overtime_minutes"]) for item in overtime_days]
        total_weight = sum(weights, Decimal("0"))
        for item in days:
            item["overtime_amount"] = Decimal("0.00")
        if total_weight <= 0:
            return
        allocated = Decimal("0.00")
        for item, weight in zip(overtime_days[:-1], weights[:-1], strict=True):
            amount = (total_overtime * weight / total_weight).quantize(_CENTS, rounding=ROUND_HALF_UP)
            item["overtime_amount"] = amount
            allocated += amount
        overtime_days[-1]["overtime_amount"] = (total_overtime - allocated).quantize(_CENTS, rounding=ROUND_HALF_UP)

    # --- Ajuste manual y cierre ---

    def set_manual_adjustment(
        self, record_id: uuid.UUID, *, amount: Decimal, notes: str | None, current_user_id: uuid.UUID | None
    ) -> PayrollRecord:
        preview = self.repo.get_record(record_id)
        if preview is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Registro no encontrado")
        period = self._get_period_or_404(preview.payroll_period_id, for_update=True)
        record = self.repo.get_record(record_id, for_update=True)
        if record is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Registro no encontrado")
        # Revalidar tras los bloqueos: populate_existing descarta el estado cacheado.
        if period.status == PERIOD_CLOSED:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="El periodo está cerrado: no se puede ajustar",
            )
        if not record.payable:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="El registro quedó fuera del cálculo pagable",
            )

        old_total = record.total
        old_manual = record.manual_adjustment
        saved = self.repo.set_manual_adjustment(record, amount=amount, notes=notes)
        AuditRepository(self.db).create(
            entity_type="payroll_record",
            entity_id=record_id,
            action="manual_adjustment",
            old_values={"manual_adjustment": str(old_manual), "total": str(old_total)},
            new_values={
                "manual_adjustment": str(amount),
                "total": str(saved.total),
                "notes": saved.notes,
            },
            reason=notes,
            performed_by=current_user_id,
            commit=False,
        )
        self.db.commit()
        self.db.refresh(saved)
        return saved

    def confirm(self, period_id: uuid.UUID, current_user_id: uuid.UUID | None) -> PayrollPeriod:
        period = self._get_period_or_404(period_id, for_update=True)
        if period.status != PERIOD_CALCULATED:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"El periodo debe estar CALCULATED para confirmarse (estado: {period.status})",
            )
        live = self._fingerprint(self._eligible_snapshots(period))
        if not period.inputs_fingerprint or live != period.inputs_fingerprint:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="La previsualización está desactualizada: vuelva a calcular antes de cerrar",
            )
        readiness = self.readiness(period_id)
        if not readiness["ready"]:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={"message": "El periodo tiene bloqueos pendientes", **readiness},
            )
        self.repo.confirm_all(period_id)
        closed = self.repo.set_period_status(period, PERIOD_CLOSED)
        AuditRepository(self.db).create(
            entity_type="payroll_period",
            entity_id=period_id,
            action="close",
            old_values={"status": PERIOD_CALCULATED},
            new_values={"status": PERIOD_CLOSED, "inputs_fingerprint": period.inputs_fingerprint},
            reason=f"Cierre del periodo {period.name}",
            performed_by=current_user_id,
            commit=False,
        )
        self.db.commit()
        self.db.refresh(closed)
        return closed
