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
from app.modules.attendance.manual_schemas import CommitmentIn, ManualBatchIn, ManualDayIn, RecoveryAllocationIn
from app.modules.adjustments.models import ADJUSTMENT_APPROVED, ADJUSTMENT_PENDING, HourAdjustment
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

    def _lock_employees(self, employee_ids: list[uuid.UUID]) -> list[Employee]:
        """Take the common employee/day writer lock in a stable order.

        Kiosk writes already use the employee row as their serialization point.
        Historical writers must take it before inspecting either source of a
        day, otherwise a kiosk and a manual request can both observe an empty
        day.  Keeping this first also gives batch/update/void/approve one
        compatible lock order.
        """
        unique_ids = sorted(set(employee_ids), key=str)
        if not unique_ids:
            return []
        employees = list(self.db.scalars(
            select(Employee)
            .where(Employee.id.in_(unique_ids))
            .order_by(Employee.id)
            .with_for_update()
        ))
        if len(employees) != len(unique_ids):
            self._error("EMPLOYEE_NOT_FOUND", "Empleado no encontrado", status.HTTP_404_NOT_FOUND)
        return employees

    def _lock_commitments(self, commitment_ids: list[uuid.UUID]) -> dict[uuid.UUID, RecoveryCommitment]:
        """Lock commitments after employee/day rows and before payroll periods."""
        unique_ids = sorted(set(commitment_ids), key=str)
        if not unique_ids:
            return {}
        commitments = list(self.db.scalars(
            select(RecoveryCommitment)
            .where(RecoveryCommitment.id.in_(unique_ids))
            .order_by(RecoveryCommitment.id)
            .with_for_update()
        ))
        return {item.id: item for item in commitments}

    def _commitment_ids_for_day(self, manual_day_id: uuid.UUID) -> list[uuid.UUID]:
        return list(self.db.scalars(
            select(ManualRecoveryApplication.commitment_id)
            .where(ManualRecoveryApplication.manual_day_id == manual_day_id)
            .order_by(ManualRecoveryApplication.commitment_id)
        ))

    def _lock_manual_day_after_employee(self, item_id: uuid.UUID) -> ManualAttendanceDay | None:
        """Re-read a version row after the employee serialization lock."""
        return self.db.scalar(
            select(ManualAttendanceDay)
            .where(ManualAttendanceDay.id == item_id)
            .execution_options(populate_existing=True)
            .with_for_update()
        )

    def _assert_date(self, employee: Employee, work_date: date) -> None:
        if work_date >= datetime.now(lima_tz()).date(): self._error("HISTORICAL_DATE_REQUIRED", "La carga debe ser de una fecha anterior a hoy")
        if employee.hire_date and work_date < employee.hire_date: self._error("OUTSIDE_EMPLOYMENT", "La fecha es anterior al ingreso")
        if employee.termination_date and work_date > employee.termination_date: self._error("OUTSIDE_EMPLOYMENT", "La fecha es posterior al cese")

    def _assert_not_closed(self, *work_dates: date) -> None:
        """Lock all affected periods in a deterministic order.

        A closed root may be changed only through its latest non-closed
        rectification.  The former query selected an arbitrary row and could
        reject a valid rectification (or leave a source permission unchecked).
        """
        dates = sorted(set(work_dates))
        if not dates:
            return
        periods = list(self.db.scalars(select(PayrollPeriod).order_by(PayrollPeriod.root_period_id, PayrollPeriod.version).with_for_update()))
        relevant = [p for p in periods if any(p.start_date <= item <= p.end_date for item in dates)]
        by_root: dict[uuid.UUID, list[PayrollPeriod]] = {}
        for period in relevant:
            by_root.setdefault(period.root_period_id, []).append(period)
        for versions in by_root.values():
            latest = max(versions, key=lambda p: p.version)
            if latest.status == PERIOD_CLOSED:
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
            ).order_by(PayrollPeriod.root_period_id, PayrollPeriod.version).with_for_update()):
                period.status = PERIOD_OPEN
                period.inputs_fingerprint = None

    def _recovery_permission_dates(self, manual_day_id: uuid.UUID) -> list[date]:
        return list(self.db.scalars(
            select(RecoveryCommitment.permission_date)
            .join(ManualRecoveryApplication, ManualRecoveryApplication.commitment_id == RecoveryCommitment.id)
            .where(ManualRecoveryApplication.manual_day_id == manual_day_id)
        ))

    def _validate_row(self, work_date: date, row: ManualDayIn, *, exclude_manual_day_id: uuid.UUID | None = None, locked_commitments: dict[uuid.UUID, RecoveryCommitment] | None = None) -> None:
        employee = self._employee(row.employee_id)
        self._assert_date(employee, work_date)
        requested_ids = [allocation.commitment_id for allocation in row.recovery_allocations]
        commitments = (
            {item_id: locked_commitments[item_id] for item_id in requested_ids if item_id in locked_commitments}
            if locked_commitments is not None
            else self._lock_commitments(requested_ids)
        )
        for allocation in row.recovery_allocations:
            commitment = commitments.get(allocation.commitment_id)
            if not commitment or commitment.employee_id != row.employee_id or commitment.status != "ACTIVE": self._error("RECOVERY_COMMITMENT_INVALID", "El compromiso de recuperación no corresponde al empleado", status.HTTP_409_CONFLICT)
        self._assert_not_closed(work_date, *(commitment.permission_date for commitment in commitments.values()))
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
        if row.additional_minutes:
            legacy = self.db.scalar(select(HourAdjustment.id).where(
                HourAdjustment.employee_id == row.employee_id,
                HourAdjustment.adjustment_date == work_date,
                HourAdjustment.adjustment_type == "OVERTIME",
                HourAdjustment.status.in_((ADJUSTMENT_PENDING, ADJUSTMENT_APPROVED)),
            ))
            if legacy:
                self._error("OVERTIME_RECONCILIATION_REQUIRED", "Existe un sobretiempo legado vigente para esta fecha; reconcilie antes de cargar P", status.HTTP_409_CONFLICT)
        if row.payment_method == "REVIEWED" and row.additional_minutes and row.day_context == "ORDINARY":
            ordinary = self.estimate_payment(row.employee_id, work_date, row.additional_minutes)
            if ordinary.get("amount") is not None and row.reviewed_additional_amount < Decimal(str(ordinary["amount"])):
                self._error("REVIEWED_AMOUNT_BELOW_POLICY", "El importe revisado no puede ser menor que la valoración ordinaria aplicable")
        for allocation in row.recovery_allocations:
            commitment = commitments[allocation.commitment_id]
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

    @staticmethod
    def _preview_token(payload: ManualBatchIn, rows: list[dict]) -> str:
        canonical = {
            "work_date": payload.work_date.isoformat(),
            # Include every submitted business field (allocations, known
            # interval, reason/context/reference) as well as the valuation.
            "payload_rows": [row.model_dump(mode="json", exclude={"expected_version", "preview_token"}) for row in payload.rows],
            "rows": [{key: value for key, value in row.items() if key != "warning"} for row in rows],
            "editing_manual_day_id": str(payload.editing_manual_day_id) if payload.editing_manual_day_id else None,
            "expected_version": payload.expected_version,
        }
        return hashlib.sha256(json.dumps(canonical, sort_keys=True, separators=(",", ":"), default=str).encode()).hexdigest()

    def preview(self, payload: ManualBatchIn) -> dict:
        if len({r.employee_id for r in payload.rows}) != len(payload.rows): self._error("DUPLICATE_EMPLOYEE_DAY", "Un empleado solo puede aparecer una vez por fecha")
        # AttendanceService serializa los intentos del kiosco sobre la misma
        # fila de empleado.  La carga histórica toma ese mismo candado, en un
        # orden estable para los lotes, antes de comprobar que no existe una
        # sesión. Así una fuente no puede colarse entre la comprobación y el
        # commit de la otra.
        employee_ids = [row.employee_id for row in payload.rows]
        self._lock_employees(employee_ids)
        rows = []
        if payload.editing_manual_day_id and (payload.expected_version is None or len(payload.rows) != 1):
            self._error("EDIT_PREVIEW_INVALID", "La previsualización de edición exige una única fila y su versión")
        if payload.editing_manual_day_id:
            current = self.db.get(ManualAttendanceDay, payload.editing_manual_day_id)
            if not current or current.voided_at or current.version != payload.expected_version:
                self._error("STALE_VERSION", "La carga cambió; recargue antes de previsualizar", status.HTTP_409_CONFLICT)
            if current.work_date != payload.work_date or current.employee_id != payload.rows[0].employee_id:
                self._error("EDIT_IDENTITY_IMMUTABLE", "Empleado y fecha no cambian en una corrección")
        for row in payload.rows:
            self._validate_row(payload.work_date, row, exclude_manual_day_id=payload.editing_manual_day_id)
            rows.append({"employee_id": str(row.employee_id), "worked_minutes_net": row.worked_minutes_net, "normal_minutes": row.normal_minutes, "additional_minutes": row.additional_minutes, "recovery_minutes": row.recovery_minutes, "payment": self.estimate_payment(row.employee_id, payload.work_date, row.additional_minutes, row), "warning": "NORMAL_MISSING" if ScheduleService(self.db).expected_minutes(row.employee_id, payload.work_date) > row.normal_minutes and row.additional_minutes else None})
        return {"work_date": payload.work_date, "rows": rows, "preview_token": self._preview_token(payload, rows)}

    def batch(self, payload: ManualBatchIn, actor_id: uuid.UUID) -> dict:
        normalized = payload.model_dump(mode="json")
        digest = hashlib.sha256(json.dumps(normalized, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        prior = self.db.get(ManualAttendanceIdempotency, payload.idempotency_key)
        if prior:
            if prior.payload_hash != digest: self._error("IDEMPOTENCY_CONFLICT", "La clave ya se usó con otro contenido", status.HTTP_409_CONFLICT)
            return prior.result
        # Writer order: employee -> existing manual day -> commitments ->
        # payroll periods.  The employee lock also serializes an empty-day
        # insert, for which PostgreSQL cannot lock a row that does not exist.
        self._lock_employees([row.employee_id for row in payload.rows])
        existing = list(self.db.scalars(
            select(ManualAttendanceDay)
            .where(
                ManualAttendanceDay.employee_id.in_([row.employee_id for row in payload.rows]),
                ManualAttendanceDay.work_date == payload.work_date,
                ManualAttendanceDay.voided_at.is_(None),
            )
            .order_by(ManualAttendanceDay.employee_id, ManualAttendanceDay.version)
            .with_for_update()
        ))
        if existing:
            self._error("MANUAL_DAY_EXISTS", "Ya existe una carga manual vigente", status.HTTP_409_CONFLICT)
        preview = self.preview(payload)
        if payload.approve_additional and payload.preview_token != preview["preview_token"]:
            self._error("STALE_PREVIEW", "La valoración o el contenido cambió; vuelva a previsualizar", status.HTTP_409_CONFLICT)
        created = []
        try:
            for row in payload.rows:
                estimate = self.estimate_payment(row.employee_id, payload.work_date, row.additional_minutes, row)
                payment_status = estimate["status"]
                approved_by = None; approved_at = None
                if payload.approve_additional and row.additional_minutes:
                    if payment_status != "PENDING" or estimate.get("amount") is None: self._error("PAYMENT_REVIEW_REQUIRED", "No hay valoración completa para aprobar", status.HTTP_409_CONFLICT)
                    payment_status = "APPROVED"; approved_by = actor_id; approved_at = datetime.now(lima_tz())
                next_version = (self.db.scalar(select(func.max(ManualAttendanceDay.version)).where(ManualAttendanceDay.employee_id == row.employee_id, ManualAttendanceDay.work_date == payload.work_date)) or 0) + 1
                item = ManualAttendanceDay(employee_id=row.employee_id, work_date=payload.work_date, worked_minutes_net=row.worked_minutes_net, normal_minutes=row.normal_minutes, additional_minutes=row.additional_minutes, recovery_minutes=row.recovery_minutes, day_context=row.day_context, source_reference=row.source_reference, known_check_in_at=row.known_check_in_at, known_check_out_at=row.known_check_out_at, known_break_minutes=row.known_break_minutes, reason=row.reason.strip(), payment_status=payment_status, payment_method=row.payment_method, payment_concept=row.payment_concept, approved_additional_amount=Decimal(str(estimate["amount"])) if payment_status == "APPROVED" and estimate.get("amount") else None, payment_snapshot={**estimate, "status": payment_status}, approved_by_user_id=approved_by, approved_at=approved_at, created_by_user_id=actor_id, version=next_version)
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

    def list(self, employee_id: uuid.UUID | None, date_from: date | None, date_to: date | None, *, offset: int = 0, limit: int = 50, include_voided: bool = False) -> list[dict]:
        query = select(ManualAttendanceDay).order_by(ManualAttendanceDay.work_date.desc(), ManualAttendanceDay.version.desc())
        if not include_voided:
            query = query.where(ManualAttendanceDay.voided_at.is_(None))
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
        return {"id": str(item.id), "employee_id": str(item.employee_id), "work_date": item.work_date, "worked_minutes_net": item.worked_minutes_net, "normal_minutes": item.normal_minutes, "additional_minutes": item.additional_minutes, "recovery_minutes": item.recovery_minutes, "day_context": item.day_context, "source_reference": item.source_reference, "known_check_in_at": item.known_check_in_at, "known_check_out_at": item.known_check_out_at, "known_break_minutes": item.known_break_minutes, "reason": item.reason, "payment_status": item.payment_status, "payment_method": item.payment_method, "payment_concept": item.payment_concept, "reviewed_additional_amount": str((item.payment_snapshot or {}).get("amount")) if item.payment_method == "REVIEWED" and (item.payment_snapshot or {}).get("amount") is not None else None, "approved_additional_amount": str(item.approved_additional_amount) if item.approved_additional_amount is not None else None, "payment_snapshot": item.payment_snapshot, "recovery_allocations": [{"commitment_id": str(allocation.commitment_id), "minutes": allocation.minutes} for allocation in allocations], "version": item.version, "supersedes_id": str(item.supersedes_id) if item.supersedes_id else None, "voided_at": item.voided_at, "void_reason": item.void_reason, "created_at": item.created_at}

    def approve(self, item_id: uuid.UUID, actor_id: uuid.UUID, expected_version: int, expected_snapshot: dict) -> dict:
        # Obtain identity without taking the version lock, then use the common
        # writer order used by batch and kiosk requests.
        item = self.db.get(ManualAttendanceDay, item_id)
        if not item:
            self._error("MANUAL_DAY_NOT_FOUND", "Carga no encontrada", status.HTTP_404_NOT_FOUND)
        self._lock_employees([item.employee_id])
        item = self._lock_manual_day_after_employee(item_id)
        if not item:
            self._error("MANUAL_DAY_NOT_FOUND", "Carga no encontrada", status.HTTP_404_NOT_FOUND)
        if item.voided_at:
            # A concurrent void is a stale decision, not a disappearing
            # resource: callers can retry safely after refreshing lineage.
            self._error("STALE_VERSION", "La carga fue anulada por otra persona", status.HTTP_409_CONFLICT)
        commitment_ids = self._commitment_ids_for_day(item.id)
        commitments = self._lock_commitments(commitment_ids)
        self._assert_not_closed(item.work_date, *(commitment.permission_date for commitment in commitments.values()))
        # A lost response may repeat the exact approval request.  It is a
        # stable read, never another version/audit transition.
        if item.payment_status == "APPROVED" and item.payment_snapshot == {**expected_snapshot, "status": "APPROVED"}:
            return self.serialize(item)
        if item.version != expected_version:
            self._error("STALE_VERSION", "La carga cambió; vuelva a previsualizar", status.HTTP_409_CONFLICT)
        allocations = [RecoveryAllocationIn(commitment_id=application.commitment_id, minutes=application.minutes) for application in self.db.scalars(select(ManualRecoveryApplication).where(ManualRecoveryApplication.manual_day_id == item.id))]
        row = ManualDayIn(
            employee_id=item.employee_id, worked_minutes_net=item.worked_minutes_net,
            normal_minutes=item.normal_minutes, additional_minutes=item.additional_minutes,
            recovery_minutes=item.recovery_minutes, known_check_in_at=item.known_check_in_at,
            known_check_out_at=item.known_check_out_at, known_break_minutes=item.known_break_minutes,
            day_context=item.day_context, source_reference=item.source_reference,
            payment_method=item.payment_method, payment_concept=item.payment_concept,
            reviewed_additional_amount=(item.payment_snapshot or {}).get("amount") if item.payment_method == "REVIEWED" else None,
            reason=item.reason, recovery_allocations=allocations,
        )
        # REVIEWED sigue sujeto a las reglas vigentes: al aprobar se vuelve a
        # validar con la configuración actual y se excluye esta misma versión
        # de los límites de recuperación ya bloqueados.
        try:
            self._validate_row(
                item.work_date,
                row,
                exclude_manual_day_id=item.id,
                locked_commitments=commitments,
            )
        except HTTPException as exc:
            # Una valoración REVIEWED que ahora queda bajo el mínimo no se
            # puede aprobar como si fuese la previsualización original. Es
            # una decisión obsoleta (salario/tasa vigente cambió), por lo que
            # conserva el contrato de aprobación 409/STALE_PREVIEW.
            if isinstance(exc.detail, dict) and exc.detail.get("code") == "REVIEWED_AMOUNT_BELOW_POLICY":
                self._error("STALE_PREVIEW", "La configuración cambió; vuelva a previsualizar y corrija el importe", status.HTTP_409_CONFLICT)
            raise
        estimate = self.estimate_payment(item.employee_id, item.work_date, item.additional_minutes, row)
        if {**estimate, "status": "PENDING"} != {**expected_snapshot, "status": "PENDING"}:
            self._error("STALE_PREVIEW", "La configuración cambió; vuelva a previsualizar y apruebe explícitamente", status.HTTP_409_CONFLICT)
        if estimate["status"] != "PENDING" or estimate.get("amount") is None: self._error("PAYMENT_REVIEW_REQUIRED", "El adicional no tiene una valoración aprobable", status.HTTP_409_CONFLICT)
        item.payment_snapshot = {**estimate, "status": "APPROVED"}; item.payment_status = "APPROVED"; item.approved_additional_amount = Decimal(str(estimate["amount"])); item.approved_by_user_id = actor_id; item.approved_at = datetime.now(lima_tz()); item.version += 1
        self._invalidate_calculated_periods(item.work_date)
        AuditRepository(self.db).create(entity_type="manual_attendance_day", entity_id=item.id, action="payment_approved", old_values=None, new_values={"payment": estimate}, reason=item.reason, performed_by=actor_id, commit=False); self.db.commit(); return self.serialize(item)

    def void(self, item_id: uuid.UUID, expected_version: int, reason: str, actor_id: uuid.UUID) -> dict:
        item = self.db.get(ManualAttendanceDay, item_id)
        if not item or item.voided_at: self._error("MANUAL_DAY_NOT_FOUND", "Carga no encontrada", status.HTTP_404_NOT_FOUND)
        self._lock_employees([item.employee_id])
        item = self._lock_manual_day_after_employee(item_id)
        if not item or item.voided_at: self._error("MANUAL_DAY_NOT_FOUND", "Carga no encontrada", status.HTTP_404_NOT_FOUND)
        commitments = self._lock_commitments(self._commitment_ids_for_day(item.id))
        self._assert_not_closed(item.work_date, *(commitment.permission_date for commitment in commitments.values()))
        if item.version != expected_version: self._error("STALE_VERSION", "La carga fue modificada por otra persona", status.HTTP_409_CONFLICT)
        affected_dates = [item.work_date] + self._recovery_permission_dates(item.id)
        item.voided_at = datetime.now(lima_tz()); item.voided_by_user_id = actor_id; item.void_reason = reason.strip(); item.version += 1
        self._invalidate_calculated_periods(*affected_dates)
        AuditRepository(self.db).create(entity_type="manual_attendance_day", entity_id=item.id, action="voided", old_values={"version": expected_version}, new_values={"version": item.version}, reason=item.void_reason, performed_by=actor_id, commit=False)
        self.db.commit(); return self.serialize(item)

    def update(self, item_id: uuid.UUID, row: ManualDayIn, expected_version: int, actor_id: uuid.UUID) -> dict:
        current = self.db.get(ManualAttendanceDay, item_id)
        if not current or current.voided_at: self._error("MANUAL_DAY_NOT_FOUND", "Carga no encontrada", status.HTTP_404_NOT_FOUND)
        self._lock_employees([current.employee_id])
        current = self._lock_manual_day_after_employee(item_id)
        if not current or current.voided_at: self._error("MANUAL_DAY_NOT_FOUND", "Carga no encontrada", status.HTTP_404_NOT_FOUND)
        commitment_ids = self._commitment_ids_for_day(current.id) + [allocation.commitment_id for allocation in row.recovery_allocations]
        commitments = self._lock_commitments(commitment_ids)
        self._assert_not_closed(current.work_date, *(commitment.permission_date for commitment in commitments.values()))
        if current.version != expected_version: self._error("STALE_VERSION", "La carga fue modificada por otra persona", status.HTTP_409_CONFLICT)
        if row.employee_id != current.employee_id: self._error("EMPLOYEE_IMMUTABLE", "No cambie el empleado en una corrección")
        preview = self.preview(ManualBatchIn(
            work_date=current.work_date, rows=[row], idempotency_key="edit-preview-validation",
            editing_manual_day_id=current.id, expected_version=expected_version,
        ))
        # ``preview_token`` is part of ManualUpdateIn; callers cannot turn a
        # previously viewed amount/content into a silent different approval.
        if row.preview_token != preview["preview_token"]:
            self._error("STALE_PREVIEW", "La corrección cambió; vuelva a previsualizar", status.HTTP_409_CONFLICT)
        self._validate_row(current.work_date, row, exclude_manual_day_id=current.id)
        current.voided_at = datetime.now(lima_tz()); current.voided_by_user_id = actor_id; current.void_reason = row.reason.strip()
        # Libera el índice parcial activo antes de insertar la nueva versión.
        self.db.flush()
        estimate = self.estimate_payment(row.employee_id, current.work_date, row.additional_minutes, row)
        replacement = ManualAttendanceDay(employee_id=row.employee_id, work_date=current.work_date, worked_minutes_net=row.worked_minutes_net, normal_minutes=row.normal_minutes, additional_minutes=row.additional_minutes, recovery_minutes=row.recovery_minutes, day_context=row.day_context, source_reference=row.source_reference, known_check_in_at=row.known_check_in_at, known_check_out_at=row.known_check_out_at, known_break_minutes=row.known_break_minutes, reason=row.reason.strip(), payment_status=estimate["status"], payment_method=row.payment_method, payment_concept=row.payment_concept, payment_snapshot={**estimate, "status": estimate["status"]}, version=current.version + 1, supersedes_id=current.id, created_by_user_id=actor_id)
        self.db.add(replacement); self.db.flush()
        for allocation in row.recovery_allocations: self.db.add(ManualRecoveryApplication(manual_day_id=replacement.id, commitment_id=allocation.commitment_id, minutes=allocation.minutes))
        self._invalidate_calculated_periods(current.work_date, *self._recovery_permission_dates(current.id), *self._recovery_permission_dates(replacement.id))
        AuditRepository(self.db).create(entity_type="manual_attendance_day", entity_id=replacement.id, action="versioned_update", old_values={"id":str(current.id),"version":current.version}, new_values={"version":replacement.version}, reason=row.reason.strip(), performed_by=actor_id, commit=False)
        self.db.commit(); return self.serialize(replacement)

    def create_commitment(self, payload: CommitmentIn, actor_id: uuid.UUID) -> dict:
        self._lock_employees([payload.employee_id])
        employee = self._employee(payload.employee_id); self._assert_date(employee, payload.permission_date)
        existing = self.db.scalar(select(RecoveryCommitment).where(
            RecoveryCommitment.employee_id == payload.employee_id,
            RecoveryCommitment.permission_date == payload.permission_date,
            RecoveryCommitment.status == "ACTIVE",
        ).with_for_update())
        if existing:
            self._error("RECOVERY_COMMITMENT_EXISTS", "Ya existe un compromiso activo para este permiso; evite duplicar cobertura", status.HTTP_409_CONFLICT)
        self._assert_not_closed(payload.permission_date)
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
