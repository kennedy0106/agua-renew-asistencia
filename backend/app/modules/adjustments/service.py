"""Servicio de ajustes de horas y saldo.

Saldo = minutos trabajados − minutos esperados + ajustes APROBADOS.
La diferencia negativa NUNCA se descuenta sola del sueldo: queda como
saldo a recuperar (decisión explícita del jefe).
"""

import uuid
from datetime import date, datetime, timedelta

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.modules.adjustments.models import (
    ADJUSTMENT_APPROVED,
    ADJUSTMENT_PENDING,
    ADJUSTMENT_REJECTED,
    AdjustmentOperationReceipt,
    HourAdjustment,
)
from app.modules.attendance.manual_operations import lock_operation, payload_hash
from app.modules.attendance.manual_service import ManualAttendanceService
from app.core.timezone import lima_now
from app.modules.adjustments.repository import AdjustmentRepository
from app.modules.attendance.models import AttendanceRecord
from app.modules.attendance.manual_models import ManualAttendanceDay
from app.modules.attendance.totals import ordinary_minutes, recovery_credit_minutes, worked_minutes as actual_worked_minutes
from app.modules.audit.repository import AuditRepository
from app.modules.employees.models import Employee
from app.modules.employees.repository import EmployeeRepository
from app.modules.schedules.service import ScheduleService


class AdjustmentService:
    def __init__(self, db: Session) -> None:
        self.db = db
        self.repo = AdjustmentRepository(db)

    def _get_employee(self, employee_id: uuid.UUID):
        employee = EmployeeRepository(self.db).get_by_id(employee_id)
        if employee is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Empleado no encontrado")
        return employee

    def _lock_employee(self, employee_id: uuid.UUID) -> Employee:
        """Serializa escritores con kiosco y carga histórica por empleado."""
        employee = self.db.scalar(
            select(Employee).where(Employee.id == employee_id).with_for_update()
        )
        if employee is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Empleado no encontrado")
        return employee

    def _reject_manual_additional(self, employee_id: uuid.UUID, adjustment_date: date) -> None:
        manual = self.db.scalar(select(ManualAttendanceDay.id).where(
            ManualAttendanceDay.employee_id == employee_id,
            ManualAttendanceDay.work_date == adjustment_date,
            ManualAttendanceDay.additional_minutes > 0,
            ManualAttendanceDay.voided_at.is_(None),
        ))
        if manual is not None:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Existe un adicional histórico vigente; reconcilie antes de registrar sobretiempo legado")

    def create(
        self,
        *,
        employee_id: uuid.UUID,
        adjustment_date: date,
        minutes: int,
        adjustment_type: str,
        reason: str,
    ) -> HourAdjustment:
        # Orden global de escritura: Employee -> registro/ajuste -> guardas.
        # Así un OVERTIME legado no puede pasar la consulta de P manual al
        # mismo tiempo que batch crea dicha carga.
        self._lock_employee(employee_id)
        if adjustment_type == "OVERTIME" and minutes <= 0:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Las horas extra deben registrarse con minutos positivos",
            )
        if adjustment_type == "OVERTIME":
            self._reject_manual_additional(employee_id, adjustment_date)
            existing = self.repo.active_overtime_for_day(employee_id, adjustment_date)
            if existing is not None:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail=(
                        "Ya existe un ajuste de horas extra "
                        f"{existing.status.lower()} para esta jornada. Rechácelo antes de registrar otro."
                    ),
                )
        return self.repo.create(
            employee_id=employee_id,
            adjustment_date=adjustment_date,
            minutes=minutes,
            adjustment_type=adjustment_type,
            reason=reason.strip(),
        )

    def list_for_employee(self, employee_id: uuid.UUID) -> list[HourAdjustment]:
        self._get_employee(employee_id)
        return self.repo.list_for_employee(employee_id)

    def list_for_employee_including_voided(self, employee_id: uuid.UUID) -> list[HourAdjustment]:
        self._get_employee(employee_id)
        return self.repo.list_for_employee(employee_id, include_voided=True)

    def approval_snapshot(self, adjustment: HourAdjustment) -> dict:
        """La decisión de aprobar se ancla al contenido que el usuario vio."""
        snapshot = {
            "id": str(adjustment.id),
            "version": adjustment.version,
            "adjustment_date": adjustment.adjustment_date.isoformat(),
            "minutes": adjustment.minutes,
            "adjustment_type": adjustment.adjustment_type,
            "reason": adjustment.reason,
            "status": adjustment.status,
        }
        if adjustment.adjustment_type == "OVERTIME":
            # El importe y sus entradas de valoración forman parte de la
            # decisión. Un cambio de sueldo/jornada/política invalida el hash.
            # El cálculo canónico aplica el único refrigerio del día sobre la
            # presencia combinada (kiosco + ordinario histórico).  ``minutes``
            # del ajuste conserva el pedido crudo; la valoración publica
            # requested/break/payable.
            snapshot["valuation"] = ManualAttendanceService(self.db).estimate_payment(
                adjustment.employee_id, adjustment.adjustment_date, adjustment.minutes,
            )
        return snapshot

    def _result_snapshot(self, adjustment: HourAdjustment) -> dict:
        """Captura el resultado visible de una mutación para su reintento.

        Un recibo no puede volver a consultar una fila viva: una aprobación o
        anulación posterior cambiaría retroactivamente la respuesta de una
        operación ya confirmada.  Se conserva identidad para compatibilidad,
        pero los recibos nuevos devuelven esta fotografía inmutable.
        """
        def value(item):
            return item.isoformat() if isinstance(item, (uuid.UUID, date, datetime)) else item

        return {
            "id": str(adjustment.id), "employee_id": str(adjustment.employee_id),
            "adjustment_date": adjustment.adjustment_date.isoformat(), "minutes": adjustment.minutes,
            "adjustment_type": adjustment.adjustment_type, "reason": adjustment.reason,
            "status": adjustment.status,
            "approved_by": str(adjustment.approved_by) if adjustment.approved_by else None,
            "approved_by_username": None, "approved_at": value(adjustment.approved_at),
            "version": adjustment.version,
            "supersedes_id": str(adjustment.supersedes_id) if adjustment.supersedes_id else None,
            "voided_at": value(adjustment.voided_at),
            "voided_by": str(adjustment.voided_by) if adjustment.voided_by else None,
            "void_reason": adjustment.void_reason,
            "approval_snapshot": (
                self.approval_snapshot(adjustment)
                if adjustment.status == ADJUSTMENT_PENDING and adjustment.voided_at is None else None
            ),
            "created_at": value(adjustment.created_at), "updated_at": value(adjustment.updated_at),
        }

    def _receipt_or_conflict(
        self, *, key: str, payload: object, actor_id: uuid.UUID,
        operation_type: str, target_id: uuid.UUID,
    ) -> HourAdjustment | dict | None:
        digest = payload_hash(payload)
        lock_operation(self.db, key)
        receipt = self.db.scalar(
            select(AdjustmentOperationReceipt)
            .where(AdjustmentOperationReceipt.idempotency_key == key)
            .execution_options(populate_existing=True)
            .with_for_update()
        )
        if receipt is None:
            return None
        if (
            receipt.payload_hash != digest or receipt.actor_user_id != actor_id
            or receipt.operation_type != operation_type or receipt.target_adjustment_id != target_id
        ):
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail={
                "code": "IDEMPOTENCY_CONFLICT", "message": "La clave ya fue usada para otra operación"
            })
        if "response" in receipt.result:
            return receipt.result["response"]
        # Recibos creados antes de esta versión solo tenían identidad.
        adjustment_id = uuid.UUID(str(receipt.result["adjustment_id"]))
        result = self.repo.get_by_id(adjustment_id)
        if result is None:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail={
                "code": "OPERATION_RESULT_UNAVAILABLE", "message": "El resultado confirmado ya no está disponible"
            })
        return result

    def _store_receipt(
        self, *, key: str, payload: object, actor_id: uuid.UUID,
        operation_type: str, target_id: uuid.UUID, result_id: uuid.UUID,
    ) -> None:
        self.db.add(AdjustmentOperationReceipt(
            idempotency_key=key,
            payload_hash=payload_hash(payload),
            result={
                "adjustment_id": str(result_id),
                "response": self._result_snapshot(self._lock_adjustment(result_id)),
            },
            actor_user_id=actor_id,
            operation_type=operation_type,
            target_adjustment_id=target_id,
        ))

    def _lock_adjustment(self, adjustment_id: uuid.UUID) -> HourAdjustment:
        adjustment = self.db.scalar(
            select(HourAdjustment).where(HourAdjustment.id == adjustment_id)
            .execution_options(populate_existing=True).with_for_update()
        )
        if adjustment is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Ajuste no encontrado")
        return adjustment

    def _assert_adjustment_mutable(self, adjustment: HourAdjustment) -> None:
        if adjustment.voided_at is not None:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail={
                "code": "STALE_VERSION", "message": "El ajuste fue anulado o sustituido; recargue el historial"
            })
        ManualAttendanceService(self.db)._assert_not_closed(adjustment.adjustment_date)

    def _assert_adjustment_values(
        self, *, employee_id: uuid.UUID, adjustment_date: date,
        minutes: int, adjustment_type: str, excluding_id: uuid.UUID | None = None,
    ) -> None:
        if adjustment_type == "OVERTIME" and minutes <= 0:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Las horas extra deben registrarse con minutos positivos")
        if adjustment_type != "OVERTIME":
            return
        self._reject_manual_additional(employee_id, adjustment_date)
        query = select(HourAdjustment.id).where(
            HourAdjustment.employee_id == employee_id,
            HourAdjustment.adjustment_date == adjustment_date,
            HourAdjustment.adjustment_type == "OVERTIME",
            HourAdjustment.status.in_((ADJUSTMENT_PENDING, ADJUSTMENT_APPROVED)),
            HourAdjustment.voided_at.is_(None),
        )
        if excluding_id is not None:
            query = query.where(HourAdjustment.id != excluding_id)
        if self.db.scalar(query) is not None:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Ya existe un ajuste de horas extra vigente para esta jornada")

    def update_versioned(
        self, adjustment_id: uuid.UUID, *, adjustment_date: date, minutes: int,
        adjustment_type: str, reason: str, expected_version: int,
        idempotency_key: str, actor_id: uuid.UUID,
    ) -> HourAdjustment:
        payload = {
            "adjustment_date": adjustment_date.isoformat(), "minutes": minutes,
            "adjustment_type": adjustment_type, "reason": reason,
            "expected_version": expected_version,
        }
        replay = self._receipt_or_conflict(
            key=idempotency_key, payload=payload, actor_id=actor_id,
            operation_type="UPDATE", target_id=adjustment_id,
        )
        if replay is not None:
            return replay
        original = self._get_or_404(adjustment_id)
        self._lock_employee(original.employee_id)
        original = self._lock_adjustment(adjustment_id)
        self._assert_adjustment_mutable(original)
        if original.version != expected_version:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail={"code": "STALE_VERSION", "message": "El ajuste cambió; recargue antes de editar"})
        self._assert_adjustment_values(
            employee_id=original.employee_id, adjustment_date=adjustment_date,
            minutes=minutes, adjustment_type=adjustment_type, excluding_id=original.id,
        )
        # La fecha es una entrada económica: ambos periodos quedan protegidos
        # y los cálculos previos dejan de ser confirmables.
        ManualAttendanceService(self.db)._assert_not_closed(original.adjustment_date, adjustment_date)
        original.voided_at = lima_now()
        original.voided_by = actor_id
        original.void_reason = reason.strip()
        self.db.flush()
        replacement = HourAdjustment(
            employee_id=original.employee_id, adjustment_date=adjustment_date,
            minutes=minutes, adjustment_type=adjustment_type, reason=reason.strip(),
            status=ADJUSTMENT_PENDING, version=original.version + 1,
            supersedes_id=original.id,
        )
        self.db.add(replacement)
        self.db.flush()
        ManualAttendanceService(self.db)._invalidate_calculated_periods(original.adjustment_date, adjustment_date)
        AuditRepository(self.db).create(
            entity_type="adjustment", entity_id=replacement.id, action="versioned_update",
            old_values=self.approval_snapshot(original), new_values=self.approval_snapshot(replacement),
            reason=reason.strip(), performed_by=actor_id, commit=False,
        )
        self._store_receipt(key=idempotency_key, payload=payload, actor_id=actor_id,
                            operation_type="UPDATE", target_id=adjustment_id, result_id=replacement.id)
        try:
            self.db.commit()
        except IntegrityError:
            self.db.rollback()
            return self._receipt_or_conflict(key=idempotency_key, payload=payload, actor_id=actor_id, operation_type="UPDATE", target_id=adjustment_id) or self._get_or_404(replacement.id)
        return replacement

    def void_versioned(
        self, adjustment_id: uuid.UUID, *, expected_version: int, reason: str,
        idempotency_key: str, actor_id: uuid.UUID,
    ) -> HourAdjustment:
        payload = {"expected_version": expected_version, "reason": reason}
        replay = self._receipt_or_conflict(key=idempotency_key, payload=payload, actor_id=actor_id, operation_type="VOID", target_id=adjustment_id)
        if replay is not None:
            return replay
        adjustment = self._get_or_404(adjustment_id)
        self._lock_employee(adjustment.employee_id)
        adjustment = self._lock_adjustment(adjustment_id)
        self._assert_adjustment_mutable(adjustment)
        if adjustment.version != expected_version:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail={"code": "STALE_VERSION", "message": "El ajuste cambió; recargue antes de anular"})
        adjustment.voided_at = lima_now()
        adjustment.voided_by = actor_id
        adjustment.void_reason = reason.strip()
        adjustment.version += 1
        ManualAttendanceService(self.db)._invalidate_calculated_periods(adjustment.adjustment_date)
        AuditRepository(self.db).create(
            entity_type="adjustment", entity_id=adjustment.id, action="voided",
            old_values={"version": expected_version, "status": adjustment.status},
            new_values={"version": adjustment.version, "voided": True}, reason=adjustment.void_reason,
            performed_by=actor_id, commit=False,
        )
        self._store_receipt(key=idempotency_key, payload=payload, actor_id=actor_id,
                            operation_type="VOID", target_id=adjustment_id, result_id=adjustment.id)
        self.db.commit()
        return adjustment

    def approve_versioned(
        self, adjustment_id: uuid.UUID, *, expected_version: int, expected_snapshot: dict,
        idempotency_key: str, actor_id: uuid.UUID,
    ) -> HourAdjustment:
        payload = {"expected_version": expected_version, "expected_snapshot": expected_snapshot}
        replay = self._receipt_or_conflict(key=idempotency_key, payload=payload, actor_id=actor_id, operation_type="APPROVE", target_id=adjustment_id)
        if replay is not None:
            return replay
        adjustment = self._get_or_404(adjustment_id)
        self._lock_employee(adjustment.employee_id)
        adjustment = self._lock_adjustment(adjustment_id)
        self._assert_adjustment_mutable(adjustment)
        if adjustment.version != expected_version or expected_snapshot != self.approval_snapshot(adjustment):
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail={"code": "STALE_PREVIEW", "message": "El contenido cambió; vuelva a revisar antes de aprobar"})
        if adjustment.status != ADJUSTMENT_PENDING:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Solo se pueden aprobar ajustes pendientes")
        self._assert_adjustment_values(employee_id=adjustment.employee_id, adjustment_date=adjustment.adjustment_date, minutes=adjustment.minutes, adjustment_type=adjustment.adjustment_type, excluding_id=adjustment.id)
        # Persist exactly the reviewed content and valuation before changing
        # status.  A later salary/schedule/policy change cannot silently
        # reprice this approved decision.
        approval_snapshot = self.approval_snapshot(adjustment)
        adjustment.approval_snapshot_data = approval_snapshot
        # ``adjustment.minutes`` NUNCA se reescribe: es el pedido crudo.  Los
        # minutos pagables y el refrigerio quedan en la valoración inmutable.
        requested_minutes = adjustment.minutes
        payable_minutes = adjustment.minutes
        break_minutes = 0
        if adjustment.adjustment_type == "OVERTIME":
            valuation = approval_snapshot.get("valuation") or {}
            requested_minutes = int(valuation.get("requested_minutes", adjustment.minutes))
            payable_minutes = int(valuation.get("minutes", adjustment.minutes))
            break_minutes = int(valuation.get("break_minutes", 0))
        adjustment.status = ADJUSTMENT_APPROVED
        adjustment.approved_by = actor_id
        adjustment.approved_at = lima_now()
        ManualAttendanceService(self.db)._invalidate_calculated_periods(adjustment.adjustment_date)
        AuditRepository(self.db).create(
            entity_type="adjustment", entity_id=adjustment.id, action="approve",
            old_values={"status": ADJUSTMENT_PENDING},
            new_values={
                "status": ADJUSTMENT_APPROVED, "minutes": adjustment.minutes,
                "requested_minutes": requested_minutes,
                "payable_minutes": payable_minutes, "break_minutes": break_minutes,
            },
            reason=f"Aprobación del ajuste de {adjustment.minutes} min ({adjustment.adjustment_type})",
            performed_by=actor_id, commit=False,
        )
        self._store_receipt(key=idempotency_key, payload=payload, actor_id=actor_id, operation_type="APPROVE", target_id=adjustment_id, result_id=adjustment.id)
        self.db.commit()
        return adjustment

    def reject_versioned(
        self, adjustment_id: uuid.UUID, *, expected_version: int, reason: str,
        idempotency_key: str, actor_id: uuid.UUID,
    ) -> HourAdjustment:
        payload = {"expected_version": expected_version, "reason": reason}
        replay = self._receipt_or_conflict(key=idempotency_key, payload=payload, actor_id=actor_id, operation_type="REJECT", target_id=adjustment_id)
        if replay is not None:
            return replay
        adjustment = self._get_or_404(adjustment_id)
        self._lock_employee(adjustment.employee_id)
        adjustment = self._lock_adjustment(adjustment_id)
        self._assert_adjustment_mutable(adjustment)
        if adjustment.version != expected_version:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail={"code": "STALE_VERSION", "message": "El ajuste cambió; recargue antes de rechazar"})
        if adjustment.status != ADJUSTMENT_PENDING:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Solo se pueden rechazar ajustes pendientes")
        adjustment.status = ADJUSTMENT_REJECTED
        adjustment.approved_by = actor_id
        adjustment.approved_at = lima_now()
        AuditRepository(self.db).create(entity_type="adjustment", entity_id=adjustment.id, action="reject", old_values={"status": ADJUSTMENT_PENDING}, new_values={"status": ADJUSTMENT_REJECTED}, reason=reason.strip(), performed_by=actor_id, commit=False)
        self._store_receipt(key=idempotency_key, payload=payload, actor_id=actor_id, operation_type="REJECT", target_id=adjustment_id, result_id=adjustment.id)
        self.db.commit()
        return adjustment

    def approve(self, adjustment_id: uuid.UUID, approver_id: uuid.UUID) -> HourAdjustment:
        adjustment = self._get_or_404(adjustment_id)
        self._lock_employee(adjustment.employee_id)
        adjustment = self.db.scalar(
            select(HourAdjustment)
            .where(HourAdjustment.id == adjustment_id)
            .execution_options(populate_existing=True)
            .with_for_update()
        )
        if adjustment is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Ajuste no encontrado")
        if adjustment.status != ADJUSTMENT_PENDING:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"El ajuste ya fue {adjustment.status.lower()}; solo se pueden aprobar pendientes",
            )
        if adjustment.adjustment_type == "OVERTIME":
            self._reject_manual_additional(adjustment.employee_id, adjustment.adjustment_date)
        # Unificar con la ruta versionada: todo OVERTIME nuevo aprobado debe
        # llevar una valoración inmutable con requested/break/payable.
        snapshot = self.approval_snapshot(adjustment)
        adjustment.approval_snapshot_data = snapshot
        saved = self.repo.set_status(adjustment, status=ADJUSTMENT_APPROVED, approved_by=approver_id)
        AuditRepository(self.db).create(
            entity_type="adjustment",
            entity_id=adjustment_id,
            action="approve",
            old_values={"status": ADJUSTMENT_PENDING},
            new_values={
                "status": ADJUSTMENT_APPROVED, "minutes": adjustment.minutes,
                "requested_minutes": int((snapshot.get("valuation") or {}).get("requested_minutes", adjustment.minutes)),
                "payable_minutes": int((snapshot.get("valuation") or {}).get("minutes", adjustment.minutes)),
                "break_minutes": int((snapshot.get("valuation") or {}).get("break_minutes", 0)),
            },
            reason=f"Aprobación del ajuste de {adjustment.minutes} min ({adjustment.adjustment_type})",
            performed_by=approver_id,
        )
        return saved

    def reject(self, adjustment_id: uuid.UUID, approver_id: uuid.UUID, reason: str) -> HourAdjustment:
        adjustment = self._get_or_404(adjustment_id)
        if adjustment.status != ADJUSTMENT_PENDING:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"El ajuste ya fue {adjustment.status.lower()}; solo se pueden rechazar pendientes",
            )
        saved = self.repo.set_status(adjustment, status=ADJUSTMENT_REJECTED, approved_by=approver_id)
        AuditRepository(self.db).create(
            entity_type="adjustment",
            entity_id=adjustment_id,
            action="reject",
            old_values={"status": ADJUSTMENT_PENDING},
            new_values={"status": ADJUSTMENT_REJECTED},
            reason=reason.strip(),
            performed_by=approver_id,
        )
        return saved

    def balance(
        self, employee_id: uuid.UUID, date_from: date, date_to: date
    ) -> dict:
        """Saldo del empleado en el rango (trabajado − esperado + ajustes aprobados)."""
        if date_from > date_to:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="date_from no puede ser posterior a date_to",
            )
        self._get_employee(employee_id)

        worked = ordinary_minutes(self.db, employee_id, date_from, date_to)
        actual_worked = actual_worked_minutes(self.db, employee_id, date_from, date_to)
        recovery_credit = recovery_credit_minutes(self.db, employee_id, date_from, date_to)

        days = [
            date_from + timedelta(days=offset)
            for offset in range((date_to - date_from).days + 1)
        ]
        # Mantener una lectura batched para el saldo de alto tráfico. Las
        # fechas especiales se exponen por CAL y bloquean/corrigen planilla;
        # la obligación histórica se materializa al aprobar la valoración.
        expected_by_day = ScheduleService(self.db).expected_minutes_for_days({employee_id: days})
        expected = sum(expected_by_day.values())

        adjustments = self.repo.approved_minutes_in_range(
            employee_id, date_from, date_to, adjustment_type=None
        )
        overtime_minutes = self.repo.approved_minutes_in_range(
            employee_id, date_from, date_to, adjustment_type="OVERTIME"
        )
        hour_adjustments = adjustments - overtime_minutes

        return {
            "date_from": date_from,
            "date_to": date_to,
            "worked_minutes": worked,
            "actual_worked_minutes": actual_worked,
            "ordinary_minutes": worked,
            "expected_minutes": expected,
            "adjustment_minutes": hour_adjustments,
            "overtime_minutes": overtime_minutes,
            "recovery_credit_minutes": recovery_credit,
            "balance_minutes": worked - expected + hour_adjustments + recovery_credit,
        }

    def _get_or_404(self, adjustment_id: uuid.UUID) -> HourAdjustment:
        adjustment = self.repo.get_by_id(adjustment_id)
        if adjustment is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Ajuste no encontrado")
        return adjustment
