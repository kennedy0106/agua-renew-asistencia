"""Recuperación supervisada de intentos de asistencia.

Reglas duras:
- Una solicitud nunca emite un token de marcación ni registra asistencia.
- El token original puede estar vencido: sólo se usa su firma y estructura para
  identificar el caso; nunca se guarda completo.
- Cualquier cierre del nonce ocurre bajo el mismo lock de empleado que usan
  check-in/check-out y reutiliza ``AttendanceAttemptResolution``.
- Una confirmación existente se devuelve sin editar horas ni evidencia.
- Un intento inconsistente no se autoriza: queda para corrección manual.
"""

from __future__ import annotations

import hashlib
import uuid
from datetime import datetime, timezone

from fastapi import HTTPException, status
from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, joinedload

from app.core.security import decode_attendance_token_for_recovery
from app.modules.attendance.models import (
    RECOVERY_AUTHORIZED,
    RECOVERY_CONFIRMED_EXISTING,
    RECOVERY_PENDING,
    RECOVERY_REJECTED,
    AttendanceAttemptResolution,
    AttendanceConsumedNonce,
    AttendanceDevice,
    AttendanceEvidence,
    AttendancePreparation,
    AttendanceRecoveryRequest,
    AttendanceRecord,
)
from app.modules.attendance.recovery_schemas import (
    RecoveryAttemptInspection,
    RecoveryConfirmationOut,
    RecoveryConsumedInspection,
    RecoveryDeviceRef,
    RecoveryEmployeeRef,
    RecoveryEvidenceInspection,
    RecoveryRequestAdminDetail,
    RecoveryRequestAdminItem,
    RecoveryRequestStatusOut,
    RecoveryResolutionInspection,
)
from app.modules.attendance.repository import AttendanceRepository
from app.modules.audit.repository import AuditRepository
from app.modules.employees.models import Employee
from app.modules.employees.repository import EmployeeRepository

DECISION_AUTHORIZE = "AUTHORIZE_REIDENTIFY"
DECISION_REJECT = "REJECT"
DECISION_CONFIRM = "CONFIRM_EXISTING"


def _as_utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _jwt_datetime(value: object) -> datetime | None:
    """PyJWT entrega ``iat``/``exp`` como datetime o epoch numérico.

    Nunca se inventa una fecha: si el claim no es convertible, queda nulo.
    """
    if isinstance(value, datetime):
        return _as_utc(value)
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        try:
            return datetime.fromtimestamp(float(value), tz=timezone.utc)
        except (OverflowError, OSError, ValueError):
            return None
    return None


class RecoveryService:
    def __init__(self, db: Session) -> None:
        self.db = db
        self.repo = AttendanceRepository(db)

    # --- solicitud pública ---

    def create_request(
        self,
        *,
        marking_token: str,
        decoded: dict,
        requester_device_id: uuid.UUID,
    ) -> tuple[AttendanceRecoveryRequest, bool]:
        """Crea (o devuelve) la solicitud idempotente nonce+navegador solicitante."""
        try:
            employee_id = uuid.UUID(str(decoded["sub"]))
        except (KeyError, ValueError, TypeError):
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail={
                    "code": "RECOVERY_TOKEN_UNREADABLE",
                    "message": "No se pudo identificar el intento en esta referencia; consérvela para revisión manual.",
                },
            )
        employee = EmployeeRepository(self.db).get_by_id(employee_id)
        if employee is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail={
                    "code": "RECOVERY_EMPLOYEE_NOT_FOUND",
                    "message": "El intento no corresponde a un trabajador vigente.",
                },
            )
        nonce = str(decoded["nonce"])
        action = str(decoded["action"])
        existing = self._find_by_nonce_and_requester(nonce, requester_device_id)
        if existing is not None:
            return existing, False

        original_device_id = self._device_uuid(decoded.get("did"))
        token_iat = _jwt_datetime(decoded.get("iat"))
        token_exp = _jwt_datetime(decoded.get("exp"))
        request = AttendanceRecoveryRequest(
            nonce=nonce,
            employee_id=employee_id,
            action=action,
            original_device_id=original_device_id,
            requester_device_id=requester_device_id,
            token_sha256=hashlib.sha256(marking_token.encode("utf-8")).hexdigest(),
            token_issued_at=token_iat,
            token_expires_at=token_exp,
            status=RECOVERY_PENDING,
        )
        self.db.add(request)
        try:
            self.db.flush()
            AuditRepository(self.db).create(
                entity_type="attendance_recovery_request",
                entity_id=request.id,
                action="RECOVERY_REQUEST_CREATED",
                old_values=None,
                new_values={
                    "nonce": nonce,
                    "employee_id": str(employee_id),
                    "action": action,
                    "original_device_id": str(original_device_id) if original_device_id else None,
                    "requester_device_id": str(requester_device_id),
                },
                reason="Solicitud de recuperación creada por el navegador",
                performed_by=None,
                commit=False,
            )
            self.db.commit()
        except IntegrityError:
            self.db.rollback()
            existing = self._find_by_nonce_and_requester(nonce, requester_device_id)
            if existing is None:
                raise
            return existing, False
        self.db.refresh(request)
        return request, True

    def _find_by_nonce_and_requester(
        self, nonce: str, requester_device_id: uuid.UUID
    ) -> AttendanceRecoveryRequest | None:
        return self.db.scalar(
            select(AttendanceRecoveryRequest)
            .where(
                AttendanceRecoveryRequest.nonce == nonce,
                AttendanceRecoveryRequest.requester_device_id == requester_device_id,
            )
            .execution_options(populate_existing=True)
        )

    def find_existing(
        self, nonce: str, requester_device_id: uuid.UUID
    ) -> AttendanceRecoveryRequest | None:
        """Lectura idempotente sin consumir límites ni escribir."""
        return self._find_by_nonce_and_requester(nonce, requester_device_id)

    @staticmethod
    def _device_uuid(value: object) -> uuid.UUID | None:
        if not value:
            return None
        try:
            return uuid.UUID(str(value))
        except (ValueError, TypeError):
            return None

    def public_status(
        self, request_id: uuid.UUID, requester_device_id: uuid.UUID
    ) -> RecoveryRequestStatusOut:
        request = self._get_request(request_id)
        if request is None or request.requester_device_id != requester_device_id:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail={
                    "code": "RECOVERY_REQUEST_NOT_FOUND",
                    "message": "Solicitud no encontrada para este navegador.",
                },
            )
        confirmation = None
        if request.status == RECOVERY_CONFIRMED_EXISTING:
            confirmation = self._confirmation_for_nonce(request)
        return RecoveryRequestStatusOut(
            id=request.id,
            status=request.status,
            requested_at=_as_utc(request.requested_at),
            resolved_at=_as_utc(request.resolved_at),
            reason=request.reason,
            can_reidentify=request.status == RECOVERY_AUTHORIZED,
            confirmation=confirmation,
        )

    def _confirmation_for_nonce(
        self, request: AttendanceRecoveryRequest
    ) -> RecoveryConfirmationOut | None:
        consumed = self.repo.get_consumed_nonce(request.nonce)
        if consumed is None:
            return None
        return self._confirmation_from_consumed(consumed, request)

    # --- panel ADMIN/BOSS ---

    def list_admin(
        self,
        *,
        status_filter: str | None,
        employee_id: uuid.UUID | None,
        query: str | None,
        limit: int,
        offset: int,
    ) -> list[RecoveryRequestAdminItem]:
        if status_filter is not None and status_filter not in {
            RECOVERY_PENDING,
            RECOVERY_AUTHORIZED,
            RECOVERY_REJECTED,
            RECOVERY_CONFIRMED_EXISTING,
        }:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail={"code": "RECOVERY_STATUS_INVALID", "message": "Estado de solicitud no válido."},
            )
        statement = (
            select(AttendanceRecoveryRequest)
            .options(
                joinedload(AttendanceRecoveryRequest.employee),
                joinedload(AttendanceRecoveryRequest.resolved_by_user),
            )
            .order_by(AttendanceRecoveryRequest.requested_at.desc())
        )
        if status_filter is not None:
            statement = statement.where(AttendanceRecoveryRequest.status == status_filter)
        if employee_id is not None:
            statement = statement.where(AttendanceRecoveryRequest.employee_id == employee_id)
        if query:
            needle = f"%{query.strip()}%"
            statement = statement.join(
                Employee, AttendanceRecoveryRequest.employee_id == Employee.id
            ).where(
                or_(
                    AttendanceRecoveryRequest.nonce.ilike(needle),
                    Employee.first_name.ilike(needle),
                    Employee.last_name.ilike(needle),
                    Employee.dni.ilike(needle),
                    Employee.employee_code.ilike(needle),
                )
            )
        rows = list(self.db.scalars(statement.limit(limit).offset(offset)))
        return [self._admin_item(row) for row in rows]

    def detail_admin(self, request_id: uuid.UUID) -> RecoveryRequestAdminDetail:
        request = self._get_request(request_id)
        if request is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Solicitud no encontrada")
        return self._admin_detail(request)

    def _get_request(self, request_id: uuid.UUID) -> AttendanceRecoveryRequest | None:
        return self.db.scalar(
            select(AttendanceRecoveryRequest)
            .where(AttendanceRecoveryRequest.id == request_id)
            .execution_options(populate_existing=True)
        )

    def resolve(
        self,
        request_id: uuid.UUID,
        *,
        decision: str,
        reason: str,
        user_id: uuid.UUID,
    ) -> RecoveryRequestAdminDetail:
        if decision not in {DECISION_AUTHORIZE, DECISION_REJECT, DECISION_CONFIRM}:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail={"code": "RECOVERY_DECISION_INVALID", "message": "Decisión de recuperación no válida."},
            )
        # Orden de locks: primero el empleado (igual que check-in, check-out y
        # evidencia), después la solicitud. Dos administradores que resuelven
        # solicitudes distintas del mismo empleado nunca se bloquean en cruz.
        candidate = self._get_request(request_id)
        if candidate is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Solicitud no encontrada")
        self.repo.lock_employee_for_attempt(candidate.employee_id)
        request = self.db.scalar(
            select(AttendanceRecoveryRequest)
            .where(AttendanceRecoveryRequest.id == request_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        if request is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Solicitud no encontrada")
        if request.status in {RECOVERY_AUTHORIZED, RECOVERY_CONFIRMED_EXISTING}:
            if decision == DECISION_REJECT:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail={
                        "code": "RECOVERY_ALREADY_RESOLVED",
                        "message": "La solicitud ya fue resuelta; no puede rechazarse después.",
                    },
                )
            return self._admin_detail(request)
        if request.status == RECOVERY_REJECTED:
            if decision == DECISION_REJECT:
                return self._admin_detail(request)
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={
                    "code": "RECOVERY_ALREADY_RESOLVED",
                    "message": "La solicitud ya fue rechazada; no puede autorizarse después.",
                },
            )

        inspection = self._inspect(request)
        if decision != DECISION_REJECT and inspection.inconsistent:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={
                    "code": "RECOVERY_INCONSISTENT",
                    "message": "El intento es inconsistente y requiere corrección manual; no se autoriza desde aquí.",
                },
            )
        if decision != DECISION_REJECT and inspection.browser_unverifiable:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={
                    "code": "RECOVERY_BROWSER_UNVERIFIABLE",
                    "message": "El navegador original del intento no está demostrado. Requiere revisión manual; no se autoriza automáticamente.",
                },
            )

        if decision == DECISION_CONFIRM:
            if inspection.record is None:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail={
                        "code": "RECOVERY_NOT_CONFIRMED",
                        "message": "No hay una confirmación verificable para devolver.",
                    },
                )
            new_status = RECOVERY_CONFIRMED_EXISTING
        elif decision == DECISION_AUTHORIZE:
            if inspection.record is not None:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail={
                        "code": "RECOVERY_ALREADY_CONFIRMED",
                        "message": "El intento ya tiene una confirmación verificable; devuélvala sin autorizar una nueva identificación.",
                    },
                )
            existing_resolution = self.repo.get_resolution(request.nonce)
            if existing_resolution is None:
                self.db.add(
                    AttendanceAttemptResolution(
                        nonce=request.nonce,
                        employee_id=request.employee_id,
                        # Pertenencia verificada: sólo el navegador firmado en
                        # el token original puede recibir la salida del bloqueo.
                        device_id=request.original_device_id,
                        action=request.action,
                        resolution="CANCELLED_UNCONFIRMED",
                        reason=reason,
                        resolved_by_user_id=user_id,
                        attendance_record_id=None,
                    )
                )
            elif existing_resolution.resolution != "CANCELLED_UNCONFIRMED":
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail={
                        "code": "RECOVERY_INCONSISTENT",
                        "message": "El intento tiene una resolución incompatible; requiere corrección manual.",
                    },
                )
            new_status = RECOVERY_AUTHORIZED
        else:
            new_status = RECOVERY_REJECTED

        # Varias solicitudes pueden compartir el mismo nonce (navegadores
        # solicitantes distintos). La resolución es única por nonce: se cierran
        # todas las pendientes con el mismo resultado, sin duplicar filas.
        siblings = list(
            self.db.scalars(
                select(AttendanceRecoveryRequest)
                .where(
                    AttendanceRecoveryRequest.nonce == request.nonce,
                    AttendanceRecoveryRequest.id != request.id,
                    AttendanceRecoveryRequest.status == RECOVERY_PENDING,
                )
                .with_for_update()
                .execution_options(populate_existing=True)
            )
        )
        now = datetime.now(timezone.utc)
        try:
            for target in (request, *siblings):
                previous_status = target.status
                target.status = new_status
                target.resolved_at = now
                target.resolved_by_user_id = user_id
                target.reason = reason
                self.db.add(target)
                AuditRepository(self.db).create(
                    entity_type="attendance_recovery_request",
                    entity_id=target.id,
                    action="RECOVERY_REQUEST_RESOLVED",
                    old_values={"status": previous_status},
                    new_values={
                        "status": new_status,
                        "decision": decision,
                        "nonce": target.nonce,
                        "employee_id": str(target.employee_id),
                        "reason": reason,
                        "resolved_by_user_id": str(user_id),
                        "affected_request_ids": [str(item.id) for item in (request, *siblings)],
                    },
                    reason=reason,
                    performed_by=user_id,
                    commit=False,
                )
            self.db.commit()
        except IntegrityError:
            self.db.rollback()
            persisted = self._get_request(request_id)
            # Nunca devolver PENDING como éxito: si la transacción falló, la
            # solicitud debe haber quedado realmente en el estado decidido.
            if persisted is None or persisted.status != new_status:
                raise
            return self._admin_detail(persisted)
        self.db.refresh(request)
        return self._admin_detail(request)

    # --- inspección ---

    def _inspect(self, request: AttendanceRecoveryRequest) -> RecoveryAttemptInspection:
        preparation = self.db.scalar(
            select(AttendancePreparation)
            .where(AttendancePreparation.nonce == request.nonce)
            .execution_options(populate_existing=True)
        )
        evidence = self.repo.get_evidence_by_nonce(request.nonce)
        consumed = self.repo.get_consumed_nonce(request.nonce)
        resolution = self.repo.get_resolution(request.nonce)
        original_device_id = request.original_device_id

        inconsistent = False
        browser_unverifiable = original_device_id is None
        record: RecoveryConfirmationOut | None = None

        if preparation is not None:
            if (
                preparation.employee_id != request.employee_id
                or preparation.action != request.action
            ):
                inconsistent = True
            if preparation.device_id is None:
                browser_unverifiable = True
            elif original_device_id is not None and preparation.device_id != original_device_id:
                inconsistent = True

        if evidence is not None:
            if evidence.employee_id != request.employee_id:
                inconsistent = True
            if evidence.device_id is None:
                browser_unverifiable = True
            elif original_device_id is not None and evidence.device_id != original_device_id:
                inconsistent = True

        if consumed is not None:
            if (
                consumed.employee_id != request.employee_id
                or consumed.action != request.action
            ):
                inconsistent = True
            if consumed.device_id is None:
                browser_unverifiable = True
            elif original_device_id is not None and consumed.device_id != original_device_id:
                inconsistent = True
            record = self._confirmation_from_consumed(consumed, request)
            if record is None:
                inconsistent = True
            elif record.employee_id != request.employee_id:
                inconsistent = True

        if resolution is not None:
            if (
                resolution.employee_id != request.employee_id
                or resolution.action != request.action
            ):
                inconsistent = True
            if resolution.device_id != original_device_id:
                inconsistent = True
            if resolution.resolution == "CANCELLED_UNCONFIRMED" and record is not None:
                inconsistent = True
            if resolution.resolution == "REVIEWED_CONFIRMED":
                reviewed_record = (
                    self.db.get(AttendanceRecord, resolution.attendance_record_id)
                    if resolution.attendance_record_id is not None
                    else None
                )
                if reviewed_record is None or reviewed_record.employee_id != request.employee_id:
                    inconsistent = True
                elif record is None:
                    record = self._confirmation_from_record(reviewed_record, request.action)
                if (
                    reviewed_record is not None
                    and resolution.attendance_record_id is not None
                    and record is not None
                    and record.id != resolution.attendance_record_id
                ):
                    inconsistent = True

        # Una evidencia que apunta a un registro sin consumo, o a otro
        # registro/resolución, no es una confirmación consistente.
        if evidence is not None and evidence.attendance_record_id is not None:
            consumed_record_id = (
                consumed.attendance_record_id if consumed is not None else None
            )
            expected_record_id = consumed_record_id or (record.id if record is not None else None)
            if consumed is None or expected_record_id is None:
                inconsistent = True
            elif evidence.attendance_record_id != expected_record_id:
                inconsistent = True
            if (
                resolution is not None
                and resolution.attendance_record_id is not None
                and evidence.attendance_record_id != resolution.attendance_record_id
            ):
                inconsistent = True

        if inconsistent:
            state = "INCONSISTENT"
        elif browser_unverifiable:
            state = "UNVERIFIABLE_BROWSER"
        elif record is not None:
            state = "CONFIRMED"
        elif resolution is not None and resolution.resolution == "CANCELLED_UNCONFIRMED":
            state = "CANCELLED"
        elif resolution is not None and resolution.resolution == "REVIEWED_CONFIRMED":
            state = "REVIEWED"
        elif consumed is not None:
            state = "INCONSISTENT"
        elif preparation is not None:
            expires = _as_utc(preparation.expires_at)
            state = (
                "PREPARATION_ONLY"
                if expires is not None and expires > datetime.now(timezone.utc)
                else "EXPIRED_UNCONFIRMED"
            )
        elif evidence is not None:
            state = "EVIDENCE_ONLY"
        else:
            state = "EMPTY"

        can_authorize = not inconsistent and not browser_unverifiable and record is None
        token_expired = bool(
            request.token_expires_at is not None
            and _as_utc(request.token_expires_at) < datetime.now(timezone.utc)
        )
        available_actions: list[str] = []
        if request.status == RECOVERY_PENDING:
            if record is not None and not browser_unverifiable and not inconsistent:
                available_actions.append("CONFIRM_EXISTING")
            elif can_authorize:
                available_actions.append("AUTHORIZE_REIDENTIFY")
            available_actions.append("REJECT")

        preparation_snapshot = None
        if preparation is not None:
            preparation_snapshot = {
                "marked_at": _as_utc(preparation.marked_at),
                "expires_at": _as_utc(preparation.expires_at),
                "location": {
                    "latitude": preparation.latitude,
                    "longitude": preparation.longitude,
                    "accuracy_m": preparation.accuracy_m,
                    "observed_at": _as_utc(preparation.observed_at),
                    "address": preparation.address,
                },
            }

        return RecoveryAttemptInspection(
            state=state,
            inconsistent=inconsistent,
            browser_unverifiable=browser_unverifiable,
            can_authorize=can_authorize,
            token_expired=token_expired,
            preparation=preparation_snapshot,
            evidence=RecoveryEvidenceInspection(
                ready=evidence is not None,
                evidence_id=evidence.id if evidence is not None else None,
                captured_at=_as_utc(evidence.captured_at) if evidence is not None else None,
                content_type=evidence.content_type if evidence is not None else None,
                record_id=evidence.attendance_record_id if evidence is not None else None,
            ),
            consumed=RecoveryConsumedInspection(
                present=consumed is not None,
                confirmed=record is not None,
                record_id=consumed.attendance_record_id if consumed is not None else None,
                record=record,
                created_at=_as_utc(consumed.created_at) if consumed is not None else None,
                device_id=consumed.device_id if consumed is not None else None,
            ),
            resolution=RecoveryResolutionInspection(
                present=resolution is not None,
                resolution=resolution.resolution if resolution is not None else None,
                reason=resolution.reason if resolution is not None else None,
                resolved_by_user_id=resolution.resolved_by_user_id if resolution is not None else None,
                resolved_at=_as_utc(resolution.resolved_at) if resolution is not None else None,
                record_id=resolution.attendance_record_id if resolution is not None else None,
            ),
            record=record,
            available_actions=available_actions,
        )

    def _admin_detail(self, request: AttendanceRecoveryRequest) -> RecoveryRequestAdminDetail:
        employee = EmployeeRepository(self.db).get_by_id(request.employee_id)
        original_device = (
            self.db.get(AttendanceDevice, request.original_device_id)
            if request.original_device_id is not None
            else None
        )
        requester_device = (
            self.db.get(AttendanceDevice, request.requester_device_id)
            if request.requester_device_id is not None
            else None
        )
        inspection = self._inspect(request)
        item = self._admin_item(request)
        return RecoveryRequestAdminDetail(
            request=item,
            employee=(
                RecoveryEmployeeRef(
                    id=employee.id,
                    dni=employee.dni,
                    employee_code=employee.employee_code,
                    first_name=employee.first_name,
                    last_name=employee.last_name,
                    active=employee.active,
                )
                if employee is not None
                else None
            ),
            original_device=(
                RecoveryDeviceRef(id=original_device.id, name=original_device.name)
                if original_device is not None
                else None
            ),
            requester_device=(
                RecoveryDeviceRef(id=requester_device.id, name=requester_device.name)
                if requester_device is not None
                else None
            ),
            attempt=inspection,
        )

    @staticmethod
    def _admin_item(request: AttendanceRecoveryRequest) -> RecoveryRequestAdminItem:
        employee = request.employee
        resolved_by = request.resolved_by_user
        return RecoveryRequestAdminItem(
            id=request.id,
            nonce=request.nonce,
            employee_id=request.employee_id,
            employee_name=(
                f"{employee.first_name} {employee.last_name}" if employee is not None else None
            ),
            employee_dni=employee.dni if employee is not None else None,
            action=request.action,
            status=request.status,
            requested_at=_as_utc(request.requested_at),
            resolved_at=_as_utc(request.resolved_at),
            resolved_by_username=resolved_by.username if resolved_by is not None else None,
            reason=request.reason,
            original_device_id=request.original_device_id,
            requester_device_id=request.requester_device_id,
        )

    def _confirmation_from_consumed(
        self, consumed: AttendanceConsumedNonce, request: AttendanceRecoveryRequest
    ) -> RecoveryConfirmationOut | None:
        """Confirma contra la fila real, no contra el payload congelado.

        El payload sólo aporta el id cuando la columna está vacía; el empleado,
        la acción, el dispositivo y la existencia del registro se contrastan
        con la base. Cualquier discrepancia devuelve ``None`` (inconsistente).
        """
        payload = consumed.result_payload or {}
        payload_id = payload.get("id") if isinstance(payload, dict) else None
        if isinstance(payload, dict):
            # Un payload divergente no puede sostener una confirmación aunque
            # la columna del registro coincida.
            payload_employee = payload.get("employee_id")
            if payload_employee is not None and str(payload_employee) != str(request.employee_id):
                return None
            payload_event = payload.get("event_type") or payload.get("action")
            if payload_event is not None and str(payload_event) != request.action:
                return None
            payload_checkout = payload.get("check_out_at")
            if request.action == "CHECK_OUT" and payload_checkout is None:
                return None
        record_id = consumed.attendance_record_id
        if payload_id is not None:
            try:
                payload_uuid = uuid.UUID(str(payload_id))
            except (ValueError, TypeError):
                return None
            if record_id is not None and record_id != payload_uuid:
                return None
            record_id = payload_uuid
        if record_id is None:
            return None
        if (
            consumed.employee_id != request.employee_id
            or consumed.action != request.action
            or consumed.device_id is None
            or consumed.device_id != request.original_device_id
        ):
            return None
        record = self.db.get(AttendanceRecord, record_id)
        if record is None or record.employee_id != request.employee_id:
            return None
        return self._confirmation_from_record(record, request.action)

    @staticmethod
    def _confirmation_from_record(
        record: AttendanceRecord, action: str
    ) -> RecoveryConfirmationOut | None:
        if action == "CHECK_OUT" and record.check_out_at is None:
            return None
        return RecoveryConfirmationOut(
            id=record.id,
            employee_id=record.employee_id,
            work_date=record.work_date,
            check_in_at=record.check_in_at,
            check_out_at=record.check_out_at,
            worked_minutes=record.worked_minutes,
            status=record.status,
            event_type=action,
        )
