"""Servicio de planilla: periodos, cálculo con snapshot y cierre.

Reglas del MVP:
- El payroll se calcula DESPUÉS de asistencia/ajustes, nunca antes.
- Cálculo por empleado ACTIVO con sueldo vigente en el periodo:
    total = base_salary (sueldo mensual) + overtime_amount + special_day_amount
            + manual_adjustment
  adjustment_amount se conserva en 0.00: los ajustes de horas NO cambian el
  monto automáticamente (nada automático en dinero); su efecto monetario se
  aplica vía ajuste manual con motivo, si el jefe lo decide.
- Divisor legal fijo (D.S. 012-92-TR art. 2): el valor día de un trabajador
  mensual es el sueldo dividido entre 30 y el de uno quincenal entre 15. Es el
  mismo valor día en febrero (28 o 29 días), en un mes de 30 y en uno de 31.
  El sueldo mensual remunera el mes completo (incluye descanso semanal y
  feriados), por lo que el divisor no se usa para multiplicar días calendario
  sueltos: sirve para valores unitarios, valoraciones y descuentos.
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
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.legal import daily_value, daily_value_out, fortnight_halves
from app.modules.adjustments.models import HourAdjustment
from app.modules.adjustments.repository import AdjustmentRepository
from app.modules.attendance.models import AttendanceRecord
from app.modules.attendance.totals import worked_minutes as consolidated_worked_minutes
from app.modules.attendance.manual_models import ManualAttendanceDay, ManualRecoveryApplication, RecoveryCommitment
from app.modules.attendance.totals import recovery_credit_components
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
    PAYROLL_MONTH_MONTHLY_LEGACY,
    PAYROLL_MONTH_SEMIMONTHLY,
    PERIOD_FIRST_HALF,
    PERIOD_MONTHLY,
    PERIOD_SECOND_HALF,
    PayrollPeriod,
    PayrollRecord,
)
from app.modules.payroll.repository import PayrollRepository
from app.modules.salary.service import SalaryService
from app.modules.schedules.service import ScheduleService
from app.modules.work_calendar.models import (
    SpecialDayValuation, VALUATION_APPROVED, VALUATION_PENDING, VALUATION_REVIEW_REQUIRED,
)
from app.core.timezone import lima_tz

_CENTS = Decimal("0.01")
_RATE = Decimal("0.0001")


def _report_today() -> date:
    """Fecha operacional para la vista informativa, siempre en Lima."""
    return datetime.now(lima_tz()).date()


class PayrollService:
    def __init__(self, db: Session) -> None:
        self.db = db
        self.repo = PayrollRepository(db)

    # --- Periodos ---

    def create_period(
        self, *, name: str | None, start_date: date | None, end_date: date | None,
        year: int | None = None, month: int | None = None, period_kind: str = PERIOD_MONTHLY,
    ) -> PayrollPeriod:
        if period_kind not in (PERIOD_MONTHLY, PERIOD_FIRST_HALF, PERIOD_SECOND_HALF):
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Tipo de periodo inválido")
        if year is not None or month is not None:
            if year is None or month is None:
                raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Año y mes deben indicarse juntos")
            last_day = monthrange(year, month)[1]
            canonical_start, canonical_end = (
                (date(year, month, 1), date(year, month, last_day)) if period_kind == PERIOD_MONTHLY
                else (date(year, month, 1), date(year, month, 15)) if period_kind == PERIOD_FIRST_HALF
                else (date(year, month, 16), date(year, month, last_day))
            )
            if (start_date and start_date != canonical_start) or (end_date and end_date != canonical_end):
                raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Las fechas no corresponden al tipo de periodo")
            start_date, end_date = canonical_start, canonical_end
        if start_date is None or end_date is None:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Indique fechas o año y mes")
        if start_date > end_date:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="start_date no puede ser posterior a end_date",
            )
        # Preserve the public conflict contract for a range that already
        # overlaps an existing period, even if the proposed range also spans
        # months.  Semimonthly creation repeats this check after its monthly
        # lock to close the concurrent-create race.
        if self.repo.find_overlap(start_date, end_date) is not None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Ya existe un periodo que se solapa con esas fechas",
            )
        if start_date.month != end_date.month or start_date.year != end_date.year:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="El periodo debe pertenecer a un solo mes")
        last_day = monthrange(start_date.year, start_date.month)[1]
        if period_kind == PERIOD_MONTHLY and (start_date.day != 1 or end_date != date(start_date.year, start_date.month, last_day)):
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="El periodo debe cubrir un mes calendario completo",
            )
        if period_kind != PERIOD_MONTHLY:
            # A full legacy period and semimonthly periods cannot coexist.
            legacy = self.db.scalar(select(PayrollPeriod.id).where(
                PayrollPeriod.start_date == date(start_date.year, start_date.month, 1),
                PayrollPeriod.end_date == date(start_date.year, start_date.month, last_day),
                PayrollPeriod.period_kind == PERIOD_MONTHLY,
            ))
            if legacy:
                raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="El mes ya tiene una liquidación mensual")
            parent = self.repo.get_month(start_date.year, start_date.month, for_update=True)
            if parent is None:
                # The unique monthly root is the concurrency gate for Q1/Q2.
                # A competing request may win the insert; reload and lock it
                # instead of leaking a PostgreSQL IntegrityError to the caller.
                try:
                    with self.db.begin_nested():
                        parent = self.repo.create_month(year=start_date.year, month=start_date.month, mode=PAYROLL_MONTH_SEMIMONTHLY)
                except IntegrityError:
                    parent = self.repo.get_month(start_date.year, start_date.month, for_update=True)
                    if parent is None:
                        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="No se pudo obtener el mes de liquidación; reintente")
            elif parent.mode != PAYROLL_MONTH_SEMIMONTHLY:
                raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="El mes está configurado para liquidación mensual")
            payroll_month_id = parent.id
        else:
            payroll_month_id = None
        # For semimonthly periods this runs after locking the monthly parent,
        # making two concurrent Q1 (or Q2) creations deterministic.
        if self.repo.find_overlap(start_date, end_date) is not None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Ya existe un periodo que se solapa con esas fechas",
            )
        default_name = f"{'Primera' if period_kind == PERIOD_FIRST_HALF else 'Segunda' if period_kind == PERIOD_SECOND_HALF else 'Mensual'} quincena {start_date.strftime('%m/%Y')}" if period_kind != PERIOD_MONTHLY else f"{start_date.strftime('%m/%Y')}"
        period = self.repo.create_period(name=(name or default_name).strip(), start_date=start_date, end_date=end_date, payroll_month_id=payroll_month_id, period_kind=period_kind)
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
                record.special_day_amount = snapshot["special_day_amount"]
                record.adjustment_minutes = snapshot["adjustment_minutes"]
                record.adjustment_amount = Decimal("0.00")
                record.base_salary = snapshot["base_salary"]
                record.missing_salary_days = snapshot["missing_salary_days"]
                record.total = (record.base_salary + record.overtime_amount + record.special_day_amount + record.manual_adjustment).quantize(
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
            base, reference_salary, missing_salary_days = self._base_for_period(employee, period, salaries)
            if reference_salary is None:
                continue
            valued_overtime = overtime.value(employee.id, period.start_date, period.end_date)
            overtime_minutes = valued_overtime["overtime_minutes"]
            overtime_amount = valued_overtime["value"]
            manual_additional = self._approved_manual_additional(employee.id, period)
            manual_distribution = self._manual_distribution(employee.id, period)
            incoming_recovery_inputs = self._incoming_recovery_inputs(employee.id, period)
            special_days = self._approved_special_days(employee.id, period)
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
                    "special_day_amount": special_days["amount"],
                    "special_days": special_days["fingerprint"],
                    "manual_additional": manual_additional["fingerprint"],
                    "manual_distribution": manual_distribution,
                    "incoming_recovery_inputs": incoming_recovery_inputs,
                    # P manual is not an HourAdjustment.  Never subtract it
                    # from the legacy set: that created phantom negative
                    # adjustments in snapshots/CSV.
                    "adjustment_minutes": adjustments.approved_minutes_in_range(
                        employee.id, period.start_date, period.end_date, adjustment_type=None
                    ) - adjustments.approved_minutes_in_range(
                        employee.id, period.start_date, period.end_date, adjustment_type="OVERTIME"
                    ),
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

    def _incoming_recovery_inputs(self, employee_id: uuid.UUID, period: PayrollPeriod) -> list[dict]:
        """Stable origin-month input for R worked in any other month.

        It is fingerprint-only: actual work remains in the work-month's
        distribution and is never added to this period's worked minutes.
        """
        commitments = list(self.db.scalars(select(RecoveryCommitment).where(
            RecoveryCommitment.employee_id == employee_id,
            RecoveryCommitment.permission_date >= period.start_date,
            RecoveryCommitment.permission_date <= period.end_date,
        ).order_by(RecoveryCommitment.id)))
        result = []
        for commitment in commitments:
            components = recovery_credit_components(self.db, commitment)
            applications = self.db.execute(
                select(ManualRecoveryApplication, ManualAttendanceDay)
                .join(ManualAttendanceDay, ManualAttendanceDay.id == ManualRecoveryApplication.manual_day_id)
                .where(ManualRecoveryApplication.commitment_id == commitment.id, ManualAttendanceDay.voided_at.is_(None))
                .order_by(ManualRecoveryApplication.manual_day_id, ManualRecoveryApplication.id)
            ).all()
            result.append({
                "commitment_id": str(commitment.id), "permission_date": commitment.permission_date.isoformat(),
                "agreed_minutes": commitment.agreed_minutes, "covered_before": commitment.covered_before,
                "status": commitment.status,
                **{key: value for key, value in components.items() if key not in {"covered_before", "applied_minutes"}},
                "applications": [{"application_id": str(application.id), "manual_day_id": str(day.id), "manual_day_version": day.version, "work_date": day.work_date.isoformat(), "minutes": application.minutes} for application, day in applications],
            })
        return result

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

    def _approved_special_days(self, employee_id: uuid.UUID, period: PayrollPeriod) -> dict:
        rows = list(self.db.scalars(select(SpecialDayValuation).where(
            SpecialDayValuation.employee_id == employee_id,
            SpecialDayValuation.work_date >= period.start_date,
            SpecialDayValuation.work_date <= period.end_date,
            SpecialDayValuation.status == VALUATION_APPROVED,
            SpecialDayValuation.voided_at.is_(None),
        )))
        return {"amount": sum((row.amount for row in rows), Decimal("0.00")), "fingerprint": [
            {"id": str(row.id), "work_date": row.work_date.isoformat(), "source_kind": row.source_kind,
             "version": row.version, "amount": str(row.amount), "calculation": row.calculation}
            for row in sorted(rows, key=lambda row: str(row.id))
        ]}

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
                "special_day_amount": str(item.get("special_day_amount", "0.00")),
                "special_days": item.get("special_days", []),
                "manual_additional": item.get("manual_additional", []),
                "manual_distribution": item.get("manual_distribution", []),
                "incoming_recovery_inputs": item.get("incoming_recovery_inputs", []),
                "adjustment_minutes": item["adjustment_minutes"],
                "base_salary": str(item["base_salary"]),
                "missing_salary_days": item["missing_salary_days"],
            }
            for item in sorted(snapshots, key=lambda value: str(value["employee_id"]))
        ]
        return hashlib.sha256(json.dumps(payload, sort_keys=True).encode("utf-8")).hexdigest()

    def _employees_for_period(self, period: PayrollPeriod) -> list[Employee]:
        return list(
            self.db.scalars(
                select(Employee).where(
                    or_(Employee.hire_date.is_(None), Employee.hire_date <= period.end_date),
                    or_(Employee.termination_date.is_(None), Employee.termination_date >= period.start_date),
                ).order_by(Employee.id)
            )
        )

    @staticmethod
    def _employment_bounds(employee: Employee, period: PayrollPeriod) -> tuple[date, date]:
        return (
            max(period.start_date, employee.hire_date or period.start_date),
            min(period.end_date, employee.termination_date or period.end_date),
        )

    def _prorated_base(self, employee: Employee, period: PayrollPeriod, salaries: SalaryService):
        """Base del periodo mensual con el modelo de 30 días legales (D.S. 012-92-TR, art. 2).

        - **Mes calendario completo**: cada fecha calendario aporta su treintavo
          legal (sueldo vigente / 30) y, al cierre, se normaliza la diferencia
          entre 30 y los días reales del mes con el sueldo vigente a fin de mes.
          Así un mes estable paga exactamente el sueldo (ni 31/30 ni 28/30), un
          aumento el día 16 da Q1 325 + Q2 350 = 675 en enero y en febrero, y un
          día 31 no crea un treintavo adicional.
        - **Periodo parcial** (alta, cese o filas históricas anteriores a la
          validación de mes completo): suma treintavos reales del valor día
          legal (sueldo / 30), sin normalización de mes completo.
        """
        active_from, active_to = self._employment_bounds(employee, period)
        if active_from > active_to:
            return Decimal("0.00"), None, 0
        month_days = monthrange(period.start_date.year, period.start_date.month)[1]
        month_start = date(period.start_date.year, period.start_date.month, 1)
        month_end = date(period.start_date.year, period.start_date.month, month_days)
        covers_month = active_from <= month_start and active_to >= month_end
        total = Decimal("0")
        reference = None
        closing = None
        missing_salary_days = 0
        day = active_from
        while day <= active_to:
            salary = salaries.get_for_date(employee.id, day)
            if salary is None:
                missing_salary_days += 1
            else:
                reference = reference or salary
                closing = salary
                # Treintavo legal sin redondear por día para conservar céntimos.
                total += daily_value(salary.monthly_salary)
            day += timedelta(days=1)
        if covers_month and closing is not None and missing_salary_days == 0:
            # Normalización de cierre: 30 días legales contra los días reales,
            # valorados con el sueldo vigente a fin de mes. Un día 31 resta su
            # treintavo y febrero lo completa.
            total += (Decimal(30) - Decimal(month_days)) * daily_value(closing.monthly_salary)
        return total.quantize(_CENTS, rounding=ROUND_HALF_UP), reference, missing_salary_days

    def _base_for_period(self, employee: Employee, period: PayrollPeriod, salaries: SalaryService):
        if period.period_kind == PERIOD_MONTHLY:
            return self._prorated_base(employee, period, salaries)
        month_start = date(period.start_date.year, period.start_date.month, 1)
        month_end = date(period.start_date.year, period.start_date.month, monthrange(period.start_date.year, period.start_date.month)[1])
        # CAL-04 deliberately does not invent allocation for hires, exits or
        # salary history changes. The monthly legacy calculation remains valid.
        if (employee.hire_date and employee.hire_date > month_start) or (employee.termination_date and employee.termination_date < month_end):
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="BASE_ALLOCATION_REVIEW_REQUIRED")
        first = salaries.get_for_date(employee.id, month_start)
        last = salaries.get_for_date(employee.id, month_end)
        if first is None or last is None or first.id != last.id:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="BASE_ALLOCATION_REVIEW_REQUIRED")
        # Quincena ÷ 15 devuelve el mismo valor día que el mes ÷ 30.
        q1, _ = fortnight_halves(first.monthly_salary)
        base = q1 if period.period_kind == PERIOD_FIRST_HALF else first.monthly_salary - q1
        return base.quantize(_CENTS, rounding=ROUND_HALF_UP), first, 0

    @staticmethod
    def allocate_semimonthly_base(monthly_salary: Decimal) -> tuple[Decimal, Decimal]:
        """Q1/Q2 del sueldo mensual: la quincena entre 15 da el valor día legal."""
        return fortnight_halves(monthly_salary)

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
                HourAdjustment.voided_at.is_(None),
                HourAdjustment.adjustment_date >= period.start_date,
                HourAdjustment.adjustment_date <= period.end_date,
            )
        )
        for adjustment in pending:
            blockers.append({"code": "PENDING_ADJUSTMENT", "message": "Ajuste pendiente de aprobación o rechazo", "employee_id": str(adjustment.employee_id)})
        pending_manual = self.db.scalars(select(ManualAttendanceDay).where(ManualAttendanceDay.payment_status == "PENDING", ManualAttendanceDay.work_date >= period.start_date, ManualAttendanceDay.work_date <= period.end_date, ManualAttendanceDay.voided_at.is_(None)))
        for item in pending_manual:
            blockers.append({"code": "PENDING_HISTORICAL_ADDITIONAL", "message": "Hay adicional histórico pendiente de valoración o aprobación", "employee_id": str(item.employee_id)})
        special_review = self.db.scalars(select(SpecialDayValuation).where(
            SpecialDayValuation.work_date >= period.start_date, SpecialDayValuation.work_date <= period.end_date,
            SpecialDayValuation.voided_at.is_(None),
            SpecialDayValuation.status.in_((VALUATION_PENDING, VALUATION_REVIEW_REQUIRED)),
        ))
        for item in special_review:
            code = "SPECIAL_DAY_OVERTIME_REVIEW_REQUIRED" if item.status == VALUATION_REVIEW_REQUIRED else "PENDING_SPECIAL_DAY_VALUATION"
            blockers.append({"code": code, "message": "La valoración de descanso o feriado requiere revisión", "employee_id": str(item.employee_id)})
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
            "total_special_day": sum((r.special_day_amount for r in records), Decimal("0.00")),
            "total_manual": sum((r.manual_adjustment for r in records), Decimal("0.00")),
            "total": sum((r.total for r in records), Decimal("0.00")),
        }

    def monthly_consolidation(self, year: int, month: int) -> dict:
        """Read-only monthly view selecting exactly one current version per root.

        It deliberately never creates a payroll month/period.  A rectification
        replaces its root's older version instead of being counted as a second
        payment.
        """
        if month < 1 or month > 12:
            raise HTTPException(status_code=422, detail="Mes inválido")
        last = monthrange(year, month)[1]
        candidates = list(self.db.scalars(select(PayrollPeriod).where(
            PayrollPeriod.start_date >= date(year, month, 1),
            PayrollPeriod.end_date <= date(year, month, last),
        ).order_by(PayrollPeriod.root_period_id, PayrollPeriod.version.desc())))
        current: dict[uuid.UUID, PayrollPeriod] = {}
        for period in candidates:
            current.setdefault(period.root_period_id, period)
        periods = sorted(current.values(), key=lambda item: (item.start_date, item.period_kind, item.id.hex))
        employees: dict[uuid.UUID, dict] = {}
        for period in periods:
            for record in self.repo.list_records(period.id, payable_only=True):
                item = employees.setdefault(record.employee_id, {
                    "employee_id": record.employee_id,
                    "employee_name": f"{record.employee.first_name} {record.employee.last_name}" if record.employee else None,
                    "base_amount": Decimal("0.00"), "overtime_amount": Decimal("0.00"),
                    "special_day_amount": Decimal("0.00"), "manual_adjustment": Decimal("0.00"),
                    "total": Decimal("0.00"), "period_ids": [],
                })
                item["base_amount"] += record.base_salary
                item["overtime_amount"] += record.overtime_amount
                item["special_day_amount"] += record.special_day_amount
                item["manual_adjustment"] += record.manual_adjustment
                item["total"] += record.total
                item["period_ids"].append(period.id)
        rows = sorted(employees.values(), key=lambda item: str(item["employee_id"]))
        return {
            "year": year, "month": month, "periods": [{"id": item.id, "period_kind": item.period_kind,
                "version": item.version, "status": item.status, "start_date": item.start_date, "end_date": item.end_date} for item in periods],
            "employees": rows,
            "total": sum((item["total"] for item in rows), Decimal("0.00")),
        }

    def daily_report(self, period_id: uuid.UUID) -> dict:
        """Descompone un periodo calculado por empleado y jornada.

        Es una vista de consulta: parte de los importes ya almacenados en
        ``PayrollRecord`` y no escribe ni recalcula el periodo.

        La representación diaria del sueldo **no se reparte entre jornadas
        programadas** (nada de 325/13 = 25.00). Se listan todas las fechas
        calendario del tramo dentro de la relación laboral —incluidos descansos
        o días sin jornada— y cada fecha aporta su treintavo legal (sueldo
        vigente / 30). La base oficial del snapshot se concilia con una
        regularización separada y anclada al cierre: 15 fechas suman 325.00 y un
        mes de 28/29/31 días regulariza su desfase sin inflar una jornada.

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
            special_by_day = {
                row.work_date: row.amount
                for row in self.db.scalars(select(SpecialDayValuation).where(
                    SpecialDayValuation.employee_id == employee.id,
                    SpecialDayValuation.work_date >= active_from,
                    SpecialDayValuation.work_date <= active_to,
                    SpecialDayValuation.status == VALUATION_APPROVED,
                    SpecialDayValuation.voided_at.is_(None),
                ))
            }
            period_days = [
                active_from + timedelta(days=offset)
                for offset in range((active_to - active_from).days + 1)
            ]
            # Sueldo vigente por fecha (una sola lectura): el reporte diario es
            # una vista viva y un aumento intrames debe valorar cada jornada con
            # el sueldo de esa fecha, sin tocar snapshots oficiales ni CLOSED.
            salary_by_day = SalaryService(self.db).get_for_days({employee.id: period_days})

            days: list[dict] = []
            day = active_from
            while day <= active_to:
                expected_minutes = schedules.expected_minutes(employee.id, day)
                overtime_item = overtime_by_day.get(day, {"minutes": 0, "amount": Decimal("0.00")})
                special_amount = special_by_day.get(day, Decimal("0.00"))
                # Recovery is recognized at the permission origin, not at the
                # later recovery-work date; R remains separate from presence.
                from app.modules.attendance.totals import recovery_credit_minutes
                approved_minutes = approved_by_day.get(day, 0) + recovery_credit_minutes(self.db, employee.id, day, day)
                attendance = attendance_by_day.get(day)
                worked_minutes = int(attendance["worked_minutes"]) if attendance else 0
                ordinary_minutes = int(attendance.get("ordinary_minutes", worked_minutes)) if attendance else 0
                recovery_minutes = int(attendance.get("recovery_minutes", 0)) if attendance else 0
                additional_minutes = int(attendance.get("additional_minutes", 0)) if attendance else 0
                # La vista diaria es calendario puro: toda fecha del tramo en
                # relación laboral aparece, incluso descanso o día sin jornada,
                # para que una primera quincena 1–15 tenga 15 fechas. La base no
                # se reparte entre jornadas programadas: cada fecha aporta su
                # treintavo legal (sueldo vigente / 30).
                salary = salary_by_day.get((employee.id, day))
                monthly_salary = salary.monthly_salary if salary is not None else record.monthly_salary
                legal_raw = daily_value(monthly_salary)
                days.append(
                    {
                        "work_date": day,
                        "worked_minutes": worked_minutes,
                        "ordinary_minutes": ordinary_minutes,
                        "additional_minutes": additional_minutes,
                        "recovery_minutes": recovery_minutes,
                        "expected_minutes": expected_minutes,
                        "overtime_minutes": overtime_item["minutes"],
                        "overtime_amount": overtime_item["amount"],
                        "special_day_amount": special_amount,
                        "approved_adjustment_minutes": approved_minutes,
                        # Estos datos no cambian el snapshot de planilla. Solo
                        # permiten que la vista informativa sepa si la jornada
                        # actual ya terminó o sigue recibiendo marcaciones.
                        "has_attendance": attendance is not None,
                        "has_open_entry": bool(attendance["has_open_entry"]) if attendance else False,
                        "legal_daily_raw": legal_raw,
                        "legal_daily_value": legal_raw.quantize(_RATE, rounding=ROUND_HALF_UP),
                        # Base atribuida por calendario: treintavo legal de la
                        # fecha, a centavos. Nunca una cuota del tramo entre
                        # jornadas programadas.
                        "base_amount": legal_raw.quantize(_CENTS, rounding=ROUND_HALF_UP),
                        "regularization_amount": Decimal("0.00"),
                        # Valor día legal de una jornada completa, a centavos.
                        "legal_base_amount": (
                            legal_raw.quantize(_CENTS, rounding=ROUND_HALF_UP) if expected_minutes > 0
                            else Decimal("0.00")
                        ),
                    }
                )
                day += timedelta(days=1)

            self._allocate_overtime_amount(days, record.overtime_amount)
            self._allocate_special_day_amount(days, record.special_day_amount)
            # Regularización separada y anclada al cierre: base oficial del
            # snapshot menos la base de calendario mostrada. Absorbe el ajuste
            # por longitud real del mes (28/29/31) y el redondeo a céntimos sin
            # inflar una jornada ni repartir la base entre días programados.
            calendar_base_total = sum((item["base_amount"] for item in days), Decimal("0.00")).quantize(
                _CENTS, rounding=ROUND_HALF_UP
            )
            regularization_total = (record.base_salary - calendar_base_total).quantize(_CENTS, rounding=ROUND_HALF_UP)
            if days and regularization_total != Decimal("0.00"):
                days[-1]["regularization_amount"] = regularization_total
            for item in days:
                item["approved_adjustment_amount"] = Decimal("0.00")
                # El reconocido y la revisión se valoran con el sueldo vigente
                # crudo / 30 de la fecha, no con la base de calendario ni con
                # mitades ya redondeadas.
                self._set_recognized_amounts(item, today, item["legal_daily_raw"])
                daily.append(
                    {
                        "employee_id": employee.id,
                        "employee_name": f"{employee.first_name} {employee.last_name}",
                        **{
                            key: value
                            for key, value in item.items()
                            if key not in ("legal_daily_raw", "recognized_base_raw")
                        },
                    }
                )

            # La base reconocida se acumula desde los importes crudos y se
            # redondea una sola vez en el resumen: sumar filas ya redondeadas
            # podía exceder la base del tramo por céntimos y volver negativo el
            # saldo no atribuido. Las filas diarias se mantienen a céntimos.
            recognized_base_raw_total = sum(
                (item["recognized_base_raw"] for item in days), Decimal("0.00")
            )
            recognized_base = recognized_base_raw_total.quantize(_CENTS, rounding=ROUND_HALF_UP)
            recognized_overtime = sum(
                (item["recognized_overtime_amount"] for item in days), Decimal("0.00")
            ).quantize(_CENTS, rounding=ROUND_HALF_UP)
            recognized_special = sum(
                (item["recognized_special_day_amount"] for item in days), Decimal("0.00")
            ).quantize(_CENTS, rounding=ROUND_HALF_UP)
            recognized_total = (recognized_base + recognized_overtime + recognized_special).quantize(
                _CENTS, rounding=ROUND_HALF_UP
            )
            # Base del tramo = base de calendario + regularización de cierre.
            # Es exactamente el snapshot oficial; los componentes se informan
            # por separado para que la vista concilie a centavos.
            programmed_base = (calendar_base_total + regularization_total).quantize(_CENTS, rounding=ROUND_HALF_UP)
            # Saldo de la base oficial que la asistencia no explica: incluye
            # descansos, feriados, ausencias y jornadas futuras. No es un
            # descuento ni un importe devengado y no se recorta con un clamp: una
            # diferencia material debe seguir visible.
            unattributed_base = (programmed_base - recognized_base).quantize(_CENTS, rounding=ROUND_HALF_UP)
            future_pending_base = sum(
                (item["legal_daily_raw"] for item in days if item["work_date"] > today and item["expected_minutes"] > 0),
                Decimal("0.00"),
            ).quantize(_CENTS, rounding=ROUND_HALF_UP)
            employee_summaries.append(
                {
                    "employee_id": employee.id,
                    "employee_name": f"{employee.first_name} {employee.last_name}",
                    "worked_minutes": sum(item["worked_minutes"] for item in days),
                    "ordinary_minutes": sum(item.get("ordinary_minutes", item["worked_minutes"]) for item in days),
                    "expected_minutes": sum(item["expected_minutes"] for item in days),
                    # Base del tramo (calendario + regularización) = snapshot.
                    "programmed_base_amount": programmed_base,
                    # Base atribuida por calendario: suma de treintavos diarios.
                    "calendar_base_amount": calendar_base_total,
                    # Ajuste separado por longitud del mes (28/29/31) y redondeo,
                    # anclado al cierre. No se reparte entre jornadas.
                    "regularization_amount": regularization_total,
                    "recognized_base_amount": recognized_base,
                    "unattributed_base_amount": unattributed_base,
                    "overtime_minutes": sum(item["overtime_minutes"] for item in days),
                    "recognized_overtime_amount": recognized_overtime,
                    "special_day_amount": sum((item["special_day_amount"] for item in days), Decimal("0.00")),
                    "recognized_special_day_amount": recognized_special,
                    "approved_adjustment_minutes": sum(item["approved_adjustment_minutes"] for item in days),
                    "approved_adjustment_amount": Decimal("0.00"),
                    "recognized_total_amount": recognized_total,
                    # Proyección a valor día legal de las jornadas futuras; los
                    # días futuros no aportan al reconocido ni a la revisión.
                    "future_pending_base_amount": future_pending_base,
                    "review_difference_amount": sum(
                        (item["review_difference_amount"] for item in days), Decimal("0.00")
                    ),
                    "manual_adjustment": record.manual_adjustment,
                    "official_total_snapshot": record.total,
                    # Valor día legal (sueldo / 30, D.S. 012-92-TR art. 2) del
                    # sueldo vigente al cierre del tramo (o al inicio si aún no
                    # hay sueldo a la última fecha). Con sueldo variable es una
                    # referencia del tramo, no un promedio.
                    "legal_daily_value": daily_value_out(
                        (salary_by_day.get((employee.id, active_to)) or salary_by_day.get((employee.id, active_from)) or record).monthly_salary
                    ),
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
    def _set_recognized_amounts(item: dict, today: date, legal_daily_raw: Decimal) -> None:
        """Calcula el reconocimiento informativo sin cambiar el snapshot.

        El importe reconocido por asistencia se valora a **valor día legal**
        (sueldo mensual crudo / 30, D.S. 012-92-TR art. 2), no con una cuota del
        tramo: un día completo reconocido vale 21.67 con sueldo 650, no 25.00 ni
        27.08. La base atribuida por calendario y su saldo no atribuido a
        asistencia se exponen aparte. La diferencia por revisar usa la misma
        referencia legal.

        Un día sin jornada (descanso o feriado no programado) se informa como
        ``NO_SCHEDULE``: no es una ausencia. Hoy se mantiene PENDING mientras no
        exista asistencia o haya alguna sesión abierta. Cuando todas las sesiones
        de hoy están cerradas, aplica la misma clasificación que un día pasado.
        """
        work_date = item["work_date"]
        expected_minutes = item["expected_minutes"]
        can_recognize = work_date < today or (
            work_date == today and item["has_attendance"] and not item["has_open_entry"]
        )
        if work_date > today:
            status = "FUTURE_PENDING"
            recognized_minutes = 0
        elif expected_minutes <= 0:
            recognized_minutes = 0
            if can_recognize and (item["overtime_minutes"] > 0 or item.get("special_day_amount", Decimal("0.00")) > 0):
                status = "RECOGNIZED"
            else:
                status = "NO_SCHEDULE"
        elif not can_recognize:
            status = "PENDING"
            recognized_minutes = 0
        else:
            recognized_minutes = max(
                0,
                min(item.get("ordinary_minutes", item["worked_minutes"]) + item["approved_adjustment_minutes"], expected_minutes),
            )
            if recognized_minutes == 0:
                status = "NO_ATTENDANCE"
            elif recognized_minutes < expected_minutes:
                status = "PARTIAL"
            else:
                status = "RECOGNIZED"

        if expected_minutes > 0 and recognized_minutes > 0:
            recognized_base_raw = legal_daily_raw * Decimal(recognized_minutes) / Decimal(expected_minutes)
            recognized_base = recognized_base_raw.quantize(_CENTS, rounding=ROUND_HALF_UP)
        else:
            recognized_base_raw = Decimal("0.00")
            recognized_base = Decimal("0.00")
        recognized_overtime = item["overtime_amount"] if can_recognize else Decimal("0.00")
        recognized_special = item.get("special_day_amount", Decimal("0.00")) if can_recognize else Decimal("0.00")
        recognized_total = (recognized_base + recognized_overtime + recognized_special).quantize(_CENTS, rounding=ROUND_HALF_UP)
        if can_recognize and expected_minutes > 0:
            missing_minutes = max(0, expected_minutes - recognized_minutes)
            missing_base = (
                legal_daily_raw * Decimal(missing_minutes) / Decimal(expected_minutes)
            ).quantize(_CENTS, rounding=ROUND_HALF_UP)
        else:
            missing_base = Decimal("0.00")
        review_difference = (
            missing_base + item["overtime_amount"] + item.get("special_day_amount", Decimal("0.00"))
            - recognized_overtime - recognized_special
            if can_recognize
            else Decimal("0.00")
        ).quantize(_CENTS, rounding=ROUND_HALF_UP)
        item.update(
            recognized_minutes=recognized_minutes,
            status=status,
            recognized_base_amount=recognized_base,
            recognized_base_raw=recognized_base_raw,
            recognized_overtime_amount=recognized_overtime,
            recognized_special_day_amount=recognized_special,
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
                "ordinary_minutes": int(item.get("ordinary_minutes", item["worked_minutes"])),
                "additional_minutes": int(item.get("additional_minutes", 0)),
                "recovery_minutes": int(item.get("recovery_minutes", 0)),
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
                HourAdjustment.voided_at.is_(None),
                HourAdjustment.adjustment_type != "OVERTIME",
                HourAdjustment.adjustment_date >= date_from,
                HourAdjustment.adjustment_date <= date_to,
            )
            .group_by(HourAdjustment.adjustment_date)
        )
        return {adjustment_date: int(minutes or 0) for adjustment_date, minutes in rows}

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

    @staticmethod
    def _allocate_special_day_amount(days: list[dict], total_special: Decimal) -> None:
        special_days = [item for item in days if item.get("special_day_amount", Decimal("0.00")) > 0]
        if not special_days:
            return
        weights = [item["special_day_amount"] for item in special_days]
        total_weight = sum(weights, Decimal("0"))
        allocated = Decimal("0.00")
        for item in days:
            item.setdefault("special_day_amount", Decimal("0.00"))
        for item, weight in zip(special_days[:-1], weights[:-1], strict=True):
            amount = (total_special * weight / total_weight).quantize(_CENTS, rounding=ROUND_HALF_UP)
            item["special_day_amount"] = amount; allocated += amount
        special_days[-1]["special_day_amount"] = (total_special - allocated).quantize(_CENTS, rounding=ROUND_HALF_UP)

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
