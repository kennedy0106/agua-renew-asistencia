import hashlib
import json
import uuid
from typing import List
from datetime import date, datetime
from decimal import Decimal, ROUND_HALF_UP

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.timezone import lima_tz
from app.modules.attendance.manual_models import ManualAttendanceDay, ManualAttendanceIdempotency, ManualRecoveryApplication, RecoveryCommitment
from app.modules.attendance.models import AttendanceRecord
from app.modules.attendance.manual_schemas import CommitmentIn, ManualBatchIn, ManualDayIn
from app.modules.audit.repository import AuditRepository
from app.modules.employees.models import Employee
from app.modules.overtime_policy.service import OvertimePolicyService
from app.modules.payroll.models import PERIOD_CALCULATED, PERIOD_CLOSED, PERIOD_OPEN, PayrollPeriod
from app.modules.salary.service import SalaryService
from app.modules.schedules.service import ScheduleService

_CENTS = Decimal("0.01")

class ManualAttendanceService:
    def __init__(self, db: Session): self.db = db

    @staticmethod
    def _error(code: str, detail: str, http=status.HTTP_422_UNPROCESSABLE_ENTITY):
        raise HTTPException(status_code=http, detail={"code": code, "message": detail})

    def _employee(self, employee_id: uuid.UUID) -> Employee:
        employee = self.db.get(Employee, employee_id)
        if not employee: self._error("EMPLOYEE_NOT_FOUND", "Empleado no encontrado", status.HTTP_404_NOT_FOUND)
        return employee

    def _assert_date(self, employee: Employee, work_date: date) -> None:
        if work_date >= datetime.now(lima_tz()).date(): self._error("HISTORICAL_DATE_REQUIRED", "La carga debe ser de una fecha anterior a hoy")
        if employee.hire_date and work_date < employee.hire_date: self._error("OUTSIDE_EMPLOYMENT", "La fecha es anterior al ingreso")
        if employee.termination_date and work_date > employee.termination_date: self._error("OUTSIDE_EMPLOYMENT", "La fecha es posterior al cese")

    def _assert_not_closed(self, work_date: date) -> None:
        # Comparte el lock del cierre de planilla y vuelve a leer su estado antes
        # de modificar una carga. Sin este lock, una aprobación/edición podría
        # pasar la comprobación y confirmar después de que otro proceso cierre.
        period = self.db.scalar(
            select(PayrollPeriod)
            .where(PayrollPeriod.start_date <= work_date, PayrollPeriod.end_date >= work_date)
            .with_for_update()
        )
        if period is not None and period.status == PERIOD_CLOSED:
            self._error("PAYROLL_CLOSED", "El periodo está cerrado; cree una rectificación antes de modificarlo", status.HTTP_409_CONFLICT)

    def _invalidate_calculated_periods(self, *affected_dates: date) -> None:
        """Una carga cambia las entradas de planilla; un cálculo previo deja de ser cerrable.

        Los periodos cerrados ya se rechazan antes de llegar aquí. Para los
        calculados se vuelve explícitamente a OPEN: no se conserva un snapshot
        que parezca vigente después de modificar N/P/R o una cobertura origen.
        """
        for affected_date in set(affected_dates):
            for period in self.db.scalars(select(PayrollPeriod).where(
                PayrollPeriod.start_date <= affected_date,
                PayrollPeriod.end_date >= affected_date,
                PayrollPeriod.status == PERIOD_CALCULATED,
            ).with_for_update()):
                period.status = PERIOD_OPEN
                period.inputs_fingerprint = None

    def _recovery_permission_dates(self, manual_day_id: uuid.UUID) -> list[date]:
        return list(self.db.scalars(
            select(RecoveryCommitment.permission_date)
            .join(ManualRecoveryApplication, ManualRecoveryApplication.commitment_id == RecoveryCommitment.id)
            .where(ManualRecoveryApplication.manual_day_id == manual_day_id)
        ))

    def _validate_row(self, work_date: date, row: ManualDayIn, *, exclude_manual_day_id: uuid.UUID | None = None) -> None:
        employee = self._employee(row.employee_id)
        self._assert_date(employee, work_date); self._assert_not_closed(work_date)
        if self.db.scalar(select(AttendanceRecord.id).where(AttendanceRecord.employee_id == row.employee_id, AttendanceRecord.work_date == work_date)):
            self._error("DAY_ALREADY_HAS_ATTENDANCE", "La jornada ya tiene marcaciones; no se mezclan fuentes", status.HTTP_409_CONFLICT)
        if row.known_check_in_at and row.known_check_in_at.astimezone(lima_tz()).date() != work_date:
            self._error("KNOWN_INTERVAL_INCONSISTENT", "La entrada conocida debe pertenecer a la fecha trabajada")
        if row.known_check_in_at and row.known_check_out_at:
            if row.known_check_out_at < row.known_check_in_at: self._error("KNOWN_INTERVAL_INCONSISTENT", "La salida no puede ser anterior a la entrada")
            duration = int((row.known_check_out_at - row.known_check_in_at).total_seconds() // 60)
            if row.worked_minutes_net > duration or (row.known_break_minutes or 0) + row.worked_minutes_net > duration:
                self._error("KNOWN_INTERVAL_INCONSISTENT", "El neto y descanso no caben en el intervalo conocido")
        expected = ScheduleService(self.db).expected_minutes(row.employee_id, work_date)
        if expected and row.normal_minutes > expected:
            self._error("NORMAL_EXCEEDS_EXPECTED", "La parte normal supera la jornada pactada; distribuya el exceso explícitamente")
        for allocation in row.recovery_allocations:
            commitment = self.db.scalar(select(RecoveryCommitment).where(RecoveryCommitment.id == allocation.commitment_id).with_for_update())
            if not commitment or commitment.employee_id != row.employee_id or commitment.status != "ACTIVE": self._error("RECOVERY_COMMITMENT_INVALID", "El compromiso de recuperación no corresponde al empleado", status.HTTP_409_CONFLICT)
            used_query = select(func.coalesce(func.sum(ManualRecoveryApplication.minutes), 0)).join(ManualAttendanceDay).where(ManualRecoveryApplication.commitment_id == commitment.id, ManualAttendanceDay.voided_at.is_(None))
            if exclude_manual_day_id is not None:
                used_query = used_query.where(ManualAttendanceDay.id != exclude_manual_day_id)
            used = self.db.scalar(used_query) or 0
            if int(used) + allocation.minutes > commitment.agreed_minutes: self._error("RECOVERY_EXCEEDS_PENDING", "La recuperación supera el pendiente del compromiso", status.HTTP_409_CONFLICT)

    def estimate_payment(self, employee_id: uuid.UUID, work_date: date, minutes: int, row: ManualDayIn | None = None) -> dict:
        if not minutes: return {"status": "NOT_APPLICABLE", "amount": "0.00", "minutes": 0}
        if row is not None and row.payment_method == "REVIEWED":
            # Importe incremental revisado: no se confunde con el salario base
            # y no se inventa una tasa de sobretiempo para supuestos especiales.
            return {"status": "PENDING", "amount": str(row.reviewed_additional_amount), "minutes": minutes, "method": "REVIEWED", "concept": row.payment_concept, "reference": row.source_reference}
        salary = SalaryService(self.db).get_for_date(employee_id, work_date)
        expected = ScheduleService(self.db).expected_minutes(employee_id, work_date)
        if salary is None or expected <= 0 or not salary.overtime_enabled:
            return {"status": "PENDING", "amount": None, "minutes": minutes, "reason": "HISTORICAL_CONFIGURATION_MISSING" if salary is None or expected <= 0 else "OVERTIME_DISABLED"}
        rates = OvertimePolicyService(self.db).get_effective_overtime_rates(employee_id, work_date)
        hourly = salary.monthly_salary / Decimal(30) / (Decimal(expected) / Decimal(60))
        first = min(minutes, 120); rest = max(0, minutes - 120)
        amount = (Decimal(first) * hourly / 60 * (1 + rates["first_two_hours_rate"] / 100) + Decimal(rest) * hourly / 60 * (1 + rates["additional_hours_rate"] / 100)).quantize(_CENTS, rounding=ROUND_HALF_UP)
        return {"status": "PENDING", "amount": str(amount), "minutes": minutes, "hourly_rate": str(hourly.quantize(Decimal("0.0001"))), "first_two_hours_rate": str(rates["first_two_hours_rate"]), "additional_hours_rate": str(rates["additional_hours_rate"])}

    def preview(self, payload: ManualBatchIn) -> dict:
        if len({r.employee_id for r in payload.rows}) != len(payload.rows): self._error("DUPLICATE_EMPLOYEE_DAY", "Un empleado solo puede aparecer una vez por fecha")
        rows = []
        for row in payload.rows:
            self._validate_row(payload.work_date, row)
            rows.append({"employee_id": str(row.employee_id), "worked_minutes_net": row.worked_minutes_net, "normal_minutes": row.normal_minutes, "additional_minutes": row.additional_minutes, "recovery_minutes": row.recovery_minutes, "payment": self.estimate_payment(row.employee_id, payload.work_date, row.additional_minutes, row), "warning": "NORMAL_MISSING" if ScheduleService(self.db).expected_minutes(row.employee_id, payload.work_date) > row.normal_minutes and row.additional_minutes else None})
        return {"work_date": payload.work_date, "rows": rows}

    def batch(self, payload: ManualBatchIn, actor_id: uuid.UUID) -> dict:
        normalized = payload.model_dump(mode="json")
        digest = hashlib.sha256(json.dumps(normalized, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        prior = self.db.get(ManualAttendanceIdempotency, payload.idempotency_key)
        if prior:
            if prior.payload_hash != digest: self._error("IDEMPOTENCY_CONFLICT", "La clave ya se usó con otro contenido", status.HTTP_409_CONFLICT)
            return prior.result
        preview = self.preview(payload)
        created = []
        try:
            for row in payload.rows:
                existing = self.db.scalar(select(ManualAttendanceDay).where(ManualAttendanceDay.employee_id == row.employee_id, ManualAttendanceDay.work_date == payload.work_date, ManualAttendanceDay.voided_at.is_(None)).with_for_update())
                if existing: self._error("MANUAL_DAY_EXISTS", "Ya existe una carga manual vigente", status.HTTP_409_CONFLICT)
                estimate = self.estimate_payment(row.employee_id, payload.work_date, row.additional_minutes, row)
                payment_status = estimate["status"]
                approved_by = None; approved_at = None
                if payload.approve_additional and row.additional_minutes:
                    if payment_status != "PENDING" or estimate.get("amount") is None: self._error("PAYMENT_REVIEW_REQUIRED", "No hay valoración completa para aprobar", status.HTTP_409_CONFLICT)
                    payment_status = "APPROVED"; approved_by = actor_id; approved_at = datetime.now(lima_tz())
                item = ManualAttendanceDay(employee_id=row.employee_id, work_date=payload.work_date, worked_minutes_net=row.worked_minutes_net, normal_minutes=row.normal_minutes, additional_minutes=row.additional_minutes, recovery_minutes=row.recovery_minutes, day_context=row.day_context, source_reference=row.source_reference, known_check_in_at=row.known_check_in_at, known_check_out_at=row.known_check_out_at, known_break_minutes=row.known_break_minutes, reason=row.reason.strip(), payment_status=payment_status, payment_method=row.payment_method, payment_concept=row.payment_concept, approved_additional_amount=Decimal(str(estimate["amount"])) if payment_status == "APPROVED" and estimate.get("amount") else None, payment_snapshot=estimate, approved_by_user_id=approved_by, approved_at=approved_at, created_by_user_id=actor_id)
                self.db.add(item); self.db.flush()
                for allocation in row.recovery_allocations: self.db.add(ManualRecoveryApplication(manual_day_id=item.id, commitment_id=allocation.commitment_id, minutes=allocation.minutes))
                AuditRepository(self.db).create(entity_type="manual_attendance_day", entity_id=item.id, action="created", old_values=None, new_values={"work_date": payload.work_date.isoformat(), "worked_minutes_net": row.worked_minutes_net, "normal_minutes": row.normal_minutes, "additional_minutes": row.additional_minutes, "recovery_minutes": row.recovery_minutes}, reason=row.reason.strip(), performed_by=actor_id, commit=False)
                created.append(item)
            self._invalidate_calculated_periods(payload.work_date, *(permission_date for item in created for permission_date in self._recovery_permission_dates(item.id)))
            # El resultado idempotente debe ser JSON puro; la previsualización
            # se consulta antes de escribir y contiene objetos date.
            result = {"created": [str(i.id) for i in created]}
            self.db.add(ManualAttendanceIdempotency(idempotency_key=payload.idempotency_key, payload_hash=digest, result=result)); self.db.commit()
        except IntegrityError as exc:
            self.db.rollback()
            self._error("MANUAL_DAY_EXISTS", "Otra operación registró esta jornada; vuelva a consultar", status.HTTP_409_CONFLICT)
        except Exception:
            self.db.rollback(); raise
        return result

    def list(self, employee_id: uuid.UUID | None, date_from: date | None, date_to: date | None, *, offset: int = 0, limit: int = 50) -> list[dict]:
        query = select(ManualAttendanceDay).where(ManualAttendanceDay.voided_at.is_(None)).order_by(ManualAttendanceDay.work_date.desc())
        if employee_id: query = query.where(ManualAttendanceDay.employee_id == employee_id)
        if date_from: query = query.where(ManualAttendanceDay.work_date >= date_from)
        if date_to: query = query.where(ManualAttendanceDay.work_date <= date_to)
        return [self.serialize(x) for x in self.db.scalars(query.offset(offset).limit(limit))]

    def get(self, item_id: uuid.UUID) -> dict:
        item = self.db.get(ManualAttendanceDay, item_id)
        if item is None:
            self._error("MANUAL_DAY_NOT_FOUND", "Carga no encontrada", status.HTTP_404_NOT_FOUND)
        return self.serialize(item)

    def serialize(self, item: ManualAttendanceDay) -> dict:
        allocations = self.db.scalars(select(ManualRecoveryApplication).where(ManualRecoveryApplication.manual_day_id == item.id)).all()
        return {"id": str(item.id), "employee_id": str(item.employee_id), "work_date": item.work_date, "worked_minutes_net": item.worked_minutes_net, "normal_minutes": item.normal_minutes, "additional_minutes": item.additional_minutes, "recovery_minutes": item.recovery_minutes, "day_context": item.day_context, "source_reference": item.source_reference, "known_check_in_at": item.known_check_in_at, "known_check_out_at": item.known_check_out_at, "known_break_minutes": item.known_break_minutes, "reason": item.reason, "payment_status": item.payment_status, "payment_method": item.payment_method, "payment_concept": item.payment_concept, "approved_additional_amount": str(item.approved_additional_amount) if item.approved_additional_amount is not None else None, "payment_snapshot": item.payment_snapshot, "recovery_allocations": [{"commitment_id": str(allocation.commitment_id), "minutes": allocation.minutes} for allocation in allocations], "version": item.version, "created_at": item.created_at}

    def approve(self, item_id: uuid.UUID, actor_id: uuid.UUID, expected_version: int, expected_snapshot: dict) -> dict:
        item = self.db.get(ManualAttendanceDay, item_id)
        if not item or item.voided_at: self._error("MANUAL_DAY_NOT_FOUND", "Carga no encontrada", status.HTTP_404_NOT_FOUND)
        self._assert_not_closed(item.work_date)
        if item.version != expected_version or item.payment_snapshot != expected_snapshot: self._error("STALE_VERSION", "La valoración cambió; vuelva a previsualizar", status.HTTP_409_CONFLICT)
        estimate = item.payment_snapshot if item.payment_snapshot and item.payment_snapshot.get("method") == "REVIEWED" else self.estimate_payment(item.employee_id, item.work_date, item.additional_minutes)
        if estimate["status"] != "PENDING" or estimate.get("amount") is None: self._error("PAYMENT_REVIEW_REQUIRED", "El adicional no tiene una valoración aprobable", status.HTTP_409_CONFLICT)
        item.payment_snapshot = estimate; item.payment_status = "APPROVED"; item.approved_additional_amount = Decimal(str(estimate["amount"])); item.approved_by_user_id = actor_id; item.approved_at = datetime.now(lima_tz()); item.version += 1
        self._invalidate_calculated_periods(item.work_date)
        AuditRepository(self.db).create(entity_type="manual_attendance_day", entity_id=item.id, action="payment_approved", old_values=None, new_values={"payment": estimate}, reason=item.reason, performed_by=actor_id, commit=False); self.db.commit(); return self.serialize(item)

    def void(self, item_id: uuid.UUID, expected_version: int, reason: str, actor_id: uuid.UUID) -> dict:
        item = self.db.scalar(select(ManualAttendanceDay).where(ManualAttendanceDay.id == item_id).with_for_update())
        if not item or item.voided_at: self._error("MANUAL_DAY_NOT_FOUND", "Carga no encontrada", status.HTTP_404_NOT_FOUND)
        self._assert_not_closed(item.work_date)
        if item.version != expected_version: self._error("STALE_VERSION", "La carga fue modificada por otra persona", status.HTTP_409_CONFLICT)
        affected_dates = [item.work_date] + self._recovery_permission_dates(item.id)
        item.voided_at = datetime.now(lima_tz()); item.voided_by_user_id = actor_id; item.void_reason = reason.strip(); item.version += 1
        self._invalidate_calculated_periods(*affected_dates)
        AuditRepository(self.db).create(entity_type="manual_attendance_day", entity_id=item.id, action="voided", old_values={"version": expected_version}, new_values={"version": item.version}, reason=item.void_reason, performed_by=actor_id, commit=False)
        self.db.commit(); return self.serialize(item)

    def update(self, item_id: uuid.UUID, row: ManualDayIn, expected_version: int, actor_id: uuid.UUID) -> dict:
        current = self.db.scalar(select(ManualAttendanceDay).where(ManualAttendanceDay.id == item_id).with_for_update())
        if not current or current.voided_at: self._error("MANUAL_DAY_NOT_FOUND", "Carga no encontrada", status.HTTP_404_NOT_FOUND)
        self._assert_not_closed(current.work_date)
        if current.version != expected_version: self._error("STALE_VERSION", "La carga fue modificada por otra persona", status.HTTP_409_CONFLICT)
        if row.employee_id != current.employee_id: self._error("EMPLOYEE_IMMUTABLE", "No cambie el empleado en una corrección")
        self._validate_row(current.work_date, row, exclude_manual_day_id=current.id)
        current.voided_at = datetime.now(lima_tz()); current.voided_by_user_id = actor_id; current.void_reason = row.reason.strip()
        # Libera el índice parcial activo antes de insertar la nueva versión.
        self.db.flush()
        estimate = self.estimate_payment(row.employee_id, current.work_date, row.additional_minutes, row)
        replacement = ManualAttendanceDay(employee_id=row.employee_id, work_date=current.work_date, worked_minutes_net=row.worked_minutes_net, normal_minutes=row.normal_minutes, additional_minutes=row.additional_minutes, recovery_minutes=row.recovery_minutes, day_context=row.day_context, source_reference=row.source_reference, known_check_in_at=row.known_check_in_at, known_check_out_at=row.known_check_out_at, known_break_minutes=row.known_break_minutes, reason=row.reason.strip(), payment_status=estimate["status"], payment_method=row.payment_method, payment_concept=row.payment_concept, payment_snapshot=estimate, version=current.version + 1, supersedes_id=current.id, created_by_user_id=actor_id)
        self.db.add(replacement); self.db.flush()
        for allocation in row.recovery_allocations: self.db.add(ManualRecoveryApplication(manual_day_id=replacement.id, commitment_id=allocation.commitment_id, minutes=allocation.minutes))
        self._invalidate_calculated_periods(current.work_date, *self._recovery_permission_dates(current.id), *self._recovery_permission_dates(replacement.id))
        AuditRepository(self.db).create(entity_type="manual_attendance_day", entity_id=replacement.id, action="versioned_update", old_values={"id":str(current.id),"version":current.version}, new_values={"version":replacement.version}, reason=row.reason.strip(), performed_by=actor_id, commit=False)
        self.db.commit(); return self.serialize(replacement)

    def create_commitment(self, payload: CommitmentIn, actor_id: uuid.UUID) -> dict:
        employee = self._employee(payload.employee_id); self._assert_date(employee, payload.permission_date); self._assert_not_closed(payload.permission_date)
        item = RecoveryCommitment(**payload.model_dump(), created_by_user_id=actor_id); self.db.add(item); self.db.flush()
        self._invalidate_calculated_periods(item.permission_date)
        AuditRepository(self.db).create(entity_type="recovery_commitment", entity_id=item.id, action="created", old_values=None, new_values={"minutes": item.agreed_minutes, "covered_before": item.covered_before}, reason=item.reference, performed_by=actor_id, commit=False); self.db.commit()
        return {"id": str(item.id), "employee_id": str(item.employee_id), "permission_date": item.permission_date, "agreed_minutes": item.agreed_minutes, "covered_before": item.covered_before, "reference": item.reference}

    def list_commitments(self, employee_id: uuid.UUID | None) -> List[dict]:
        query = select(RecoveryCommitment).where(RecoveryCommitment.status == "ACTIVE")
        if employee_id: query = query.where(RecoveryCommitment.employee_id == employee_id)
        result=[]
        for item in self.db.scalars(query):
            used=self.db.scalar(select(func.coalesce(func.sum(ManualRecoveryApplication.minutes), 0)).join(ManualAttendanceDay).where(ManualRecoveryApplication.commitment_id == item.id, ManualAttendanceDay.voided_at.is_(None))) or 0
            result.append({"id":str(item.id),"employee_id":str(item.employee_id),"permission_date":item.permission_date,"agreed_minutes":item.agreed_minutes,"pending_minutes":item.agreed_minutes-int(used),"covered_before":item.covered_before,"reference":item.reference})
        return result
