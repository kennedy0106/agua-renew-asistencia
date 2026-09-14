"""Servicio de asistencia: reglas de marcación pública.

- La hora SIEMPRE la define el backend (UTC en BD, presentación en
  America/Lima). Nunca se confía en el reloj del navegador.
- Check-in: rechazado si hay una entrada abierta (doble entrada).
- Check-out: rechazado sin entrada abierta; worked_minutes = duración −
  refrigerio de la jornada vigente en la fecha (0 si no hay jornada).
- Empleado cesado no puede marcar.
"""

import base64
import hashlib
import uuid
from datetime import date, datetime, timedelta, timezone

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError, InterfaceError, OperationalError
from sqlalchemy.orm import Session

from app.core.images import MAX_INPUT_BYTES, verify_and_normalize
from app.core.object_store import (
    ObjectAlreadyExistsError,
    ObjectNotFoundError,
    ObjectStoreError,
    evidence_object_key,
    get_object_store,
)
from app.core.config import get_settings
from app.core.security import create_attendance_token, decode_attendance_token, decode_attendance_token_for_recovery
from app.core.timezone import lima_tz
from app.modules.attendance.models import (
    STORAGE_S3,
    AttendanceAttemptResolution,
    AttendanceConsumedNonce,
    AttendanceEvent,
    AttendanceEvidence,
    AttendanceRecord,
)
from app.modules.attendance.repository import AttendanceRepository
from app.modules.audit.repository import AuditRepository
from app.modules.employees.repository import EmployeeRepository
from app.modules.schedules.repository import WorkScheduleRepository
from app.modules.schedules.service import ScheduleService

_MISSING = object()  # sentinela: distingue "no enviado" de "enviado como null"


def _as_utc(dt: datetime) -> datetime:
    """Normaliza a UTC aware. SQLite no preserva tzinfo: asume UTC."""
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def compute_worked_minutes(check_in_at: datetime, check_out_at: datetime, break_minutes: int) -> int:
    """Minutos trabajados (duración − refrigerio), nunca negativo."""
    start = _as_utc(check_in_at)
    end = _as_utc(check_out_at)
    minutes = int((end - start).total_seconds() // 60)
    return max(0, minutes - break_minutes)


class AttendanceService:
    def __init__(self, db: Session) -> None:
        self.db = db
        self.repo = AttendanceRepository(db)

    def _get_employee_or_404(self, employee_id: uuid.UUID):
        employee = EmployeeRepository(self.db).get_by_id(employee_id)
        if employee is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Empleado no encontrado")
        return employee

    def _get_active_employee(self, employee_id: uuid.UUID):
        employee = self._get_employee_or_404(employee_id)
        if not employee.active:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Empleado inactivo: no puede marcar asistencia",
            )
        return employee

    def identify(self, identifier: str, *, device_id: uuid.UUID | None = None) -> dict:
        """Resuelve al trabajador por DNI, código interno o QR (AR:<token>)."""
        identifier = identifier.strip()
        employees = EmployeeRepository(self.db)
        if identifier.upper().startswith("AR:"):
            employee = employees.get_by_qr_token(identifier[3:].strip())
        else:
            employee = (
                employees.get_by_dni(identifier)
                or employees.get_by_employee_code(identifier)
                or employees.get_by_qr_token(identifier)
            )
        if employee is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Trabajador no encontrado. Verifique su DNI, código o QR.",
            )
        if not employee.active:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Empleado inactivo: no puede marcar asistencia",
            )

        open_record = self.repo.get_open(employee.id)
        last_record = self.repo.get_last(employee.id)
        now = datetime.now(timezone.utc)
        now_lima = now.astimezone(lima_tz())
        action = "CHECK_OUT" if open_record is not None else "CHECK_IN"
        return {
            "employee": {
                "id": employee.id,
                "first_name": employee.first_name,
                "last_name": employee.last_name,
                "job_role_name": employee.job_role.name if employee.job_role else None,
                "active": employee.active,
            },
            "state": {
                "has_open_entry": open_record is not None,
                "open_check_in_at": open_record.check_in_at.isoformat() if open_record else None,
                "last_record": (
                    {
                        "id": last_record.id,
                        "work_date": last_record.work_date.isoformat(),
                        "check_in_at": last_record.check_in_at.isoformat(),
                        "check_out_at": last_record.check_out_at.isoformat() if last_record.check_out_at else None,
                        "worked_minutes": last_record.worked_minutes,
                        "status": last_record.status,
                    }
                    if last_record
                    else None
                ),
            },
            "server_time": now_lima.isoformat(),
            "server_time_label": now_lima.strftime("%H:%M"),
            "marking_action": action,
            "marking_token": create_attendance_token(
                str(employee.id),
                action=action,
                record_id=str(open_record.id) if open_record is not None else None,
                device_id=str(device_id) if device_id else None,
            ),
        }

    def store_evidence(
        self,
        *,
        marking_token: str,
        image_base64: str,
        content_type: str,
        device_id: uuid.UUID | None = None,
    ) -> AttendanceEvidence:
        decoded = decode_attendance_token(marking_token)
        if decoded is None:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Identificación vencida o inválida")
        self._require_token_terminal(decoded, device_id)
        employee_id = uuid.UUID(str(decoded["sub"]))
        self._get_active_employee(employee_id)
        nonce = str(decoded["nonce"])
        try:
            raw = base64.b64decode(image_base64.encode("ascii"), validate=True)
        except (ValueError, UnicodeEncodeError) as exc:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Foto inválida") from exc
        if len(raw) > MAX_INPUT_BYTES:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="El tamaño de la foto no es válido")
        normalized, ctype, digest = verify_and_normalize(raw)

        self.repo.lock_employee_for_attempt(employee_id)
        decoded = decode_attendance_token(marking_token)
        if decoded is None:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Identificación vencida o inválida")
        resolution, consumed, existing = self._fresh_attempt_rows(nonce)
        if resolution is not None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Este intento ya no admite evidencia; identifique de nuevo",
            )
        if existing is not None:
            if existing.employee_id != employee_id:
                raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Identificación vencida o inválida")
            if existing.image_sha256 and existing.image_sha256 != digest:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="Ya hay una foto distinta para este intento; identifique de nuevo",
                )
            return existing
        if consumed is not None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Esta marcación ya se confirmó; identifique de nuevo para tomar otra foto",
            )
        try:
            store = get_object_store()
        except ObjectStoreError as exc:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=str(exc),
            ) from exc
        object_key = evidence_object_key(str(employee_id), nonce)
        payload = normalized
        try:
            store.put_bytes(object_key, payload, ctype)
        except ObjectAlreadyExistsError:
            try:
                payload = store.get_bytes(object_key, bucket=store.bucket)
            except ObjectStoreError as exc:
                self._raise_store_http(exc)
            stored_digest = hashlib.sha256(payload).hexdigest()
            if stored_digest != digest:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="Ya hay una foto distinta para este intento; identifique de nuevo",
                )
            digest = stored_digest
        except ObjectStoreError as exc:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=str(exc),
            ) from exc
        if decode_attendance_token(marking_token) is None:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Identificación vencida o inválida")
        evidence = AttendanceEvidence(
            nonce=nonce,
            employee_id=employee_id,
            device_id=device_id,
            content_type=ctype,
            image_bytes=None,
            object_key=object_key,
            storage_backend=STORAGE_S3,
            storage_bucket=store.bucket,
            byte_size=len(payload),
            image_sha256=digest,
        )
        self.db.add(evidence)
        try:
            self.db.commit()
        except (IntegrityError, OperationalError, InterfaceError):
            # Después de un PUT el resultado SQL es incierto. No se borra el
            # objeto: se intenta reconciliar una sola vez, sin reutilizar una
            # transacción que no haya podido volver a un estado válido.
            session_reusable = True
            try:
                self.db.rollback()
            except (OperationalError, InterfaceError):
                session_reusable = False
            self.db.expire_all()
            existing = self._recover_evidence_after_put(nonce, digest, session_reusable=session_reusable)
            if existing is None:
                raise HTTPException(
                    status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                    detail="La foto se almacenó pero no se publicó; reintente la misma foto",
                )
            return existing
        self.db.refresh(evidence)
        return evidence

    def _recover_evidence_after_put(
        self, nonce: str, digest: str, *, session_reusable: bool = True
    ) -> AttendanceEvidence | None:
        try:
            existing = self.repo.get_evidence_by_nonce(nonce) if session_reusable else None
        except (OperationalError, InterfaceError):
            # La conexión que falló al confirmar puede seguir caída. Una sola
            # sesión nueva permite detectar un commit que sí llegó al servidor.
            existing = None
        if existing is None:
            existing = self._lookup_evidence_via_new_session(nonce)
        if existing is None:
            return None
        if existing.image_sha256 and existing.image_sha256 != digest:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Ya hay una foto distinta para este intento; identifique de nuevo",
            )
        return existing

    def _lookup_evidence_via_new_session(self, nonce: str) -> AttendanceEvidence | None:
        try:
            bind = self.db.get_bind()
            if bind is None:
                return None
            with Session(bind) as other:
                # Se devuelve la fila de la sesión alternativa para no volver a
                # consultar la sesión original, potencialmente inválida.
                return other.scalar(select(AttendanceEvidence).where(AttendanceEvidence.nonce == nonce))
        except (OperationalError, InterfaceError):
            return None

    def _raise_store_http(self, exc: ObjectStoreError) -> None:
        if isinstance(exc, ObjectNotFoundError):
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Evidencia no encontrada") from exc
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=str(exc) or "Almacén de evidencias no disponible",
        ) from exc

    def _evidence_or_400(self, nonce: str, employee_id: uuid.UUID) -> AttendanceEvidence:
        evidence = self.repo.get_evidence_by_nonce(nonce)
        if evidence is None or evidence.employee_id != employee_id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Debe capturar una foto nueva antes de marcar",
            )
        if evidence.image_bytes:
            return evidence
        if not evidence.object_key or not evidence.storage_bucket:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="La foto no está disponible; identifique de nuevo o pida revisión",
            )
        try:
            meta = get_object_store().head_object(evidence.object_key, bucket=evidence.storage_bucket)
        except ObjectNotFoundError as exc:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="La foto no está disponible; identifique de nuevo o pida revisión",
            ) from exc
        except ObjectStoreError as exc:
            self._raise_store_http(exc)
        size = meta.get("ContentLength")
        if evidence.byte_size is not None and size is not None and int(size) != evidence.byte_size:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="La foto no está disponible; identifique de nuevo o pida revisión",
            )
        return evidence

    @staticmethod
    def _record_snapshot(record: AttendanceRecord, *, event_type: str) -> dict:
        frozen_status = "OPEN" if event_type == "CHECK_IN" else "COMPLETE"
        return {
            "id": str(record.id),
            "employee_id": str(record.employee_id),
            "work_date": record.work_date.isoformat(),
            "check_in_at": record.check_in_at.isoformat(),
            "check_out_at": record.check_out_at.isoformat() if record.check_out_at else None,
            "worked_minutes": record.worked_minutes,
            "status": frozen_status,
            "notes": record.notes,
            "created_at": record.created_at.isoformat() if record.created_at else record.check_in_at.isoformat(),
            "updated_at": record.updated_at.isoformat() if record.updated_at else record.check_in_at.isoformat(),
            "event_type": event_type,
        }

    def _replay_nonce(self, nonce: str, action: str, employee_id: uuid.UUID) -> dict | None:
        existing = self.repo.get_consumed_nonce(nonce)
        if existing is None:
            return None
        if existing.action != action or existing.employee_id != employee_id:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Identificación vencida o inválida")
        if existing.result_payload:
            return existing.result_payload
        if existing.attendance_record_id is None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="La marcación anterior no se completó; identifique de nuevo",
            )
        record = self.repo.get_by_id(existing.attendance_record_id)
        if record is None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="La marcación anterior no se completó; identifique de nuevo",
            )
        return self._record_snapshot(record, event_type=action)

    @staticmethod
    def _require_token_terminal(decoded: dict, device_id: uuid.UUID | None) -> None:
        token_did = decoded.get("did")
        if token_did and device_id and str(device_id) != str(token_did):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="El token no corresponde a este terminal",
            )

    def _require_kiosk_device(self, decoded: dict, device_id: uuid.UUID | None) -> uuid.UUID:
        if device_id is None:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Este equipo no está autorizado para consultar el intento",
            )
        token_did = decoded.get("did")
        if not token_did or str(token_did) != str(device_id):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="El token no corresponde a este terminal",
            )
        return device_id

    def _fresh_attempt_rows(self, nonce: str):
        return (
            self.repo.get_resolution(nonce),
            self.repo.get_consumed_nonce(nonce),
            self.repo.get_evidence_by_nonce(nonce),
        )

    def _reject_cancelled(self, resolution: AttendanceAttemptResolution | None) -> None:
        if resolution is not None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Este intento ya fue resuelto; identifique de nuevo",
            )

    def _confirmed_within_window(self, consumed: AttendanceConsumedNonce) -> bool:
        created_at = consumed.created_at
        if created_at.tzinfo is None:
            created_at = created_at.replace(tzinfo=timezone.utc)
        window = timedelta(minutes=get_settings().attempt_recovery_minutes)
        return datetime.now(timezone.utc) - created_at <= window

    def _status_from_rows(
        self,
        *,
        nonce: str,
        employee_id: uuid.UUID,
        action: str,
        device_id: uuid.UUID,
        write_token_valid: bool,
        resolution: AttendanceAttemptResolution | None,
        consumed: AttendanceConsumedNonce | None,
        evidence: AttendanceEvidence | None,
    ) -> dict:
        if evidence is not None and (
            evidence.employee_id != employee_id or (evidence.device_id is not None and evidence.device_id != device_id)
        ):
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Identificación vencida o inválida")
        if resolution is not None:
            if resolution.employee_id != employee_id or resolution.action != action:
                raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Identificación vencida o inválida")
            if resolution.device_id != device_id:
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    detail="El token no corresponde a este terminal",
                )
            if consumed is not None and consumed.result_payload and resolution.resolution == "CANCELLED_UNCONFIRMED":
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="El intento tiene una confirmación y una cancelación incompatibles; requiere revisión",
                )
            if resolution.resolution == "CANCELLED_UNCONFIRMED":
                return {
                    "state": "CANCELLED",
                    "record": None,
                    "evidence_ready": evidence is not None,
                    "write_token_valid": False,
                    "can_restart": True,
                    "nonce": nonce,
                    "resolution_id": nonce,
                    "reason": resolution.reason,
                }
            return {
                "state": "REVIEWED",
                "record": None,
                "evidence_ready": evidence is not None,
                "write_token_valid": False,
                "can_restart": True,
                "nonce": nonce,
                "resolution_id": nonce,
                "reason": resolution.reason,
            }
        if consumed is not None:
            if consumed.employee_id != employee_id or consumed.action != action:
                raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Identificación vencida o inválida")
            if consumed.device_id is None or consumed.device_id != device_id:
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    detail="El token no corresponde a este terminal",
                )
            if not consumed.result_payload:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="El intento quedó inconsistente; pida revisión autorizada",
                )
            if not self._confirmed_within_window(consumed):
                raise HTTPException(
                    status_code=status.HTTP_410_GONE,
                    detail="El plazo para recuperar este intento ya venció",
                )
            return {
                "state": "CONFIRMED",
                "record": consumed.result_payload,
                "evidence_ready": True,
                "write_token_valid": write_token_valid,
                "can_restart": False,
                "nonce": nonce,
                "resolution_id": None,
                "reason": None,
            }
        if write_token_valid:
            return {
                "state": "PENDING",
                "record": None,
                "evidence_ready": evidence is not None,
                "write_token_valid": True,
                "can_restart": False,
                "nonce": nonce,
                "resolution_id": None,
                "reason": None,
            }
        return {
            "state": "EXPIRED_UNCONFIRMED",
            "record": None,
            "evidence_ready": evidence is not None,
            "write_token_valid": False,
            "can_restart": False,
            "nonce": nonce,
            "resolution_id": None,
            "reason": None,
        }

    def attempt_status(self, marking_token: str, *, device_id: uuid.UUID | None = None) -> dict:
        decoded = decode_attendance_token_for_recovery(marking_token)
        if decoded is None:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Identificación vencida o inválida")
        device = self._require_kiosk_device(decoded, device_id)
        employee_id = uuid.UUID(str(decoded["sub"]))
        self._get_employee_or_404(employee_id)
        nonce = str(decoded["nonce"])
        action = str(decoded.get("action") or "")
        write_token_valid = decode_attendance_token(marking_token) is not None
        resolution, consumed, evidence = self._fresh_attempt_rows(nonce)
        return self._status_from_rows(
            nonce=nonce,
            employee_id=employee_id,
            action=action,
            device_id=device,
            write_token_valid=write_token_valid,
            resolution=resolution,
            consumed=consumed,
            evidence=evidence,
        )

    def resolve_attempt(
        self,
        marking_token: str,
        *,
        reason_code: str,
        device_id: uuid.UUID | None = None,
    ) -> dict:
        if reason_code not in {"TOKEN_EXPIRED", "PHOTO_RETAKE", "USER_CANCELLED"}:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Motivo de resolución no permitido")
        decoded = decode_attendance_token_for_recovery(marking_token)
        if decoded is None:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Identificación vencida o inválida")
        device = self._require_kiosk_device(decoded, device_id)
        employee_id = uuid.UUID(str(decoded["sub"]))
        action = str(decoded.get("action") or "")
        nonce = str(decoded["nonce"])
        self.repo.lock_employee_for_attempt(employee_id)
        self._get_employee_or_404(employee_id)
        resolution, consumed, evidence = self._fresh_attempt_rows(nonce)
        if evidence is not None and evidence.employee_id != employee_id:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Identificación vencida o inválida")
        status_payload = self._status_from_rows(
            nonce=nonce,
            employee_id=employee_id,
            action=action,
            device_id=device,
            write_token_valid=decode_attendance_token(marking_token) is not None,
            resolution=resolution,
            consumed=consumed,
            evidence=evidence,
        )
        if status_payload["state"] == "CONFIRMED":
            return status_payload
        if status_payload["state"] in {"CANCELLED", "REVIEWED"}:
            return status_payload
        row = AttendanceAttemptResolution(
            nonce=nonce,
            employee_id=employee_id,
            device_id=device,
            action=action,
            resolution="CANCELLED_UNCONFIRMED",
            reason=reason_code,
            resolved_by_user_id=None,
            attendance_record_id=None,
        )
        self.db.add(row)
        AuditRepository(self.db).create(
            entity_type="attendance_attempt",
            entity_id=employee_id,
            action="ATTEMPT_CANCELLED",
            old_values=None,
            new_values={"nonce": nonce, "reason": reason_code, "action": action},
            reason=reason_code,
            performed_by=None,
            commit=False,
        )
        try:
            self.db.commit()
        except IntegrityError:
            self.db.rollback()
            existing = self.repo.get_resolution(nonce)
            if existing is None:
                raise
            return self.attempt_status(marking_token, device_id=device)
        return {
            "state": "CANCELLED",
            "record": None,
            "evidence_ready": evidence is not None,
            "write_token_valid": False,
            "can_restart": True,
            "nonce": nonce,
            "resolution_id": nonce,
            "reason": reason_code,
        }

    def inspect_attempt_admin(self, nonce: str) -> dict:
        resolution, consumed, evidence = self._fresh_attempt_rows(nonce)
        employee_id = None
        action = None
        device_id = None
        if resolution is not None:
            employee_id = resolution.employee_id
            action = resolution.action
            device_id = resolution.device_id
        elif consumed is not None:
            employee_id = consumed.employee_id
            action = consumed.action
            device_id = consumed.device_id
        elif evidence is not None:
            employee_id = evidence.employee_id
            device_id = evidence.device_id
        if employee_id is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Intento no encontrado")
        employee = EmployeeRepository(self.db).get_by_id(employee_id)
        device = None
        if device_id is not None:
            from app.modules.attendance.models import AttendanceDevice

            device = self.db.get(AttendanceDevice, device_id)
        automatable = device_id is not None
        state = "UNKNOWN"
        record = None
        if resolution is not None:
            state = "CANCELLED" if resolution.resolution == "CANCELLED_UNCONFIRMED" else "REVIEWED"
        elif consumed is not None and consumed.result_payload:
            state = "CONFIRMED"
            record = consumed.result_payload
            if not self._confirmed_within_window(consumed):
                state = "CONFIRMED_WINDOW_ELAPSED"
        elif consumed is not None:
            state = "INCONSISTENT"
            automatable = False
        elif evidence is not None:
            state = "EVIDENCE_ONLY"
        return {
            "nonce": nonce,
            "employee_id": str(employee_id),
            "employee_name": f"{employee.first_name} {employee.last_name}" if employee else None,
            "action": action,
            "device_id": str(device_id) if device_id else None,
            "device_name": device.name if device is not None else None,
            "state": state,
            "automatable": automatable,
            "record": record,
            "evidence_ready": evidence is not None,
            "resolution": resolution.resolution if resolution is not None else None,
        }

    def review_attempt(self, nonce: str, *, reason: str, user_id: uuid.UUID) -> dict:
        resolution, consumed, evidence = self._fresh_attempt_rows(nonce)
        employee_id = consumed.employee_id if consumed is not None else (evidence.employee_id if evidence is not None else None)
        if employee_id is None and resolution is not None:
            employee_id = resolution.employee_id
        if employee_id is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Intento no encontrado")
        self.repo.lock_employee_for_attempt(employee_id)
        resolution, consumed, evidence = self._fresh_attempt_rows(nonce)
        if resolution is not None:
            return self.inspect_attempt_admin(nonce)
        if consumed is None or not consumed.result_payload:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="No hay una confirmación verificable para revisar; el terminal debe resolver el intento",
            )
        if consumed.device_id is None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Este registro histórico no tiene terminal demostrable; no se automatiza la pertenencia",
            )
        record_id = consumed.attendance_record_id
        if record_id is None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="El intento quedó inconsistente; requiere revisión manual fuera de este mecanismo",
            )
        row = AttendanceAttemptResolution(
            nonce=nonce,
            employee_id=consumed.employee_id,
            device_id=consumed.device_id,
            action=consumed.action,
            resolution="REVIEWED_CONFIRMED",
            reason=reason,
            resolved_by_user_id=user_id,
            attendance_record_id=record_id,
        )
        self.db.add(row)
        AuditRepository(self.db).create(
            entity_type="attendance_attempt",
            entity_id=consumed.employee_id,
            action="ATTEMPT_REVIEWED",
            old_values={"record_id": str(record_id)},
            new_values={"nonce": nonce, "reason": reason},
            reason=reason,
            performed_by=user_id,
            commit=False,
        )
        try:
            self.db.commit()
        except IntegrityError:
            self.db.rollback()
            existing = self.repo.get_resolution(nonce)
            if existing is None:
                raise
        return self.inspect_attempt_admin(nonce)

    def _consume_nonce(
        self,
        nonce: str,
        action: str,
        employee_id: uuid.UUID,
        record: AttendanceRecord,
        device_id: uuid.UUID | None = None,
    ) -> None:
        replay = self._replay_nonce(nonce, action, employee_id)
        if replay is not None:
            return
        self.db.add(
            AttendanceConsumedNonce(
                nonce=nonce,
                action=action,
                event_type=action,
                employee_id=employee_id,
                device_id=device_id,
                attendance_record_id=record.id,
                result_payload=self._record_snapshot(record, event_type=action),
            )
        )
        self.db.flush()

    def check_in(
        self,
        employee_id: uuid.UUID,
        *,
        nonce: str | None = None,
        require_evidence: bool = False,
        device_id: uuid.UUID | None = None,
        token_device_id: str | None = None,
        marking_token: str | None = None,
    ) -> AttendanceRecord | dict:
        self._get_active_employee(employee_id)
        if token_device_id and device_id and str(device_id) != str(token_device_id):
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="El token no corresponde a este terminal")
        self.repo.lock_employee_for_attempt(employee_id)
        if marking_token and decode_attendance_token(marking_token) is None:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Identificación vencida o inválida")
        if nonce:
            resolution, _consumed, _evidence = self._fresh_attempt_rows(nonce)
            self._reject_cancelled(resolution)
            replay = self._replay_nonce(nonce, "CHECK_IN", employee_id)
            if replay is not None:
                return replay
            if require_evidence:
                self._evidence_or_400(nonce, employee_id)

        if self.repo.get_open(employee_id) is not None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Ya tiene una entrada abierta; marque su salida primero",
            )

        now = datetime.now(timezone.utc)
        work_date = now.astimezone(lima_tz()).date()
        try:
            record = AttendanceRecord(
                employee_id=employee_id,
                work_date=work_date,
                check_in_at=now,
                status="OPEN",
            )
            self.db.add(record)
            self.db.flush()
            if nonce:
                self._consume_nonce(nonce, "CHECK_IN", employee_id, record, device_id=device_id)
                evidence = self.repo.get_evidence_by_nonce(nonce)
                if evidence is not None:
                    evidence.attendance_record_id = record.id
            self._record_event(record, "CHECK_IN", now, external_event_id=nonce, device_id=device_id)
            self.db.commit()
            self.db.refresh(record)
        except IntegrityError as exc:
            self.db.rollback()
            if nonce:
                replay = self._replay_nonce(nonce, "CHECK_IN", employee_id)
                if replay is not None:
                    return replay
            detail = str(getattr(exc, "orig", exc))
            if "uq_attendance_one_open" in detail or "UNIQUE constraint failed" in detail:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="Ya tiene una entrada abierta; marque su salida primero",
                ) from exc
            raise
        return record

    def check_out(
        self,
        employee_id: uuid.UUID,
        *,
        nonce: str | None = None,
        require_evidence: bool = False,
        device_id: uuid.UUID | None = None,
        token_device_id: str | None = None,
        record_id: uuid.UUID | None = None,
        marking_token: str | None = None,
    ) -> AttendanceRecord | dict:
        self._get_active_employee(employee_id)
        if token_device_id and device_id and str(device_id) != str(token_device_id):
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="El token no corresponde a este terminal")
        self.repo.lock_employee_for_attempt(employee_id)
        if marking_token and decode_attendance_token(marking_token) is None:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Identificación vencida o inválida")
        if nonce:
            resolution, _consumed, _evidence = self._fresh_attempt_rows(nonce)
            self._reject_cancelled(resolution)
            replay = self._replay_nonce(nonce, "CHECK_OUT", employee_id)
            if replay is not None:
                return replay
            if require_evidence:
                self._evidence_or_400(nonce, employee_id)

        if record_id is not None:
            record = self.repo.get_by_id(record_id)
            if record is None or record.employee_id != employee_id or record.check_out_at is not None:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="La entrada de este intento ya no está abierta",
                )
            record = self.repo.get_open(employee_id, for_update=True)
            if record is None or record.id != record_id:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="La entrada de este intento ya no está abierta",
                )
        else:
            record = self.repo.get_open(employee_id, for_update=True)
        if record is None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="No tiene una entrada abierta para marcar salida",
            )

        now = datetime.now(timezone.utc)
        try:
            record.check_out_at = now
            record.worked_minutes = compute_worked_minutes(record.check_in_at, now, 0)
            record.status = "COMPLETE"
            self.db.add(record)
            self.db.flush()
            self._recompute_day(employee_id, record.work_date, commit=False)
            if nonce:
                self._consume_nonce(nonce, "CHECK_OUT", employee_id, record, device_id=device_id)
                evidence = self.repo.get_evidence_by_nonce(nonce)
                if evidence is not None:
                    evidence.attendance_record_id = record.id
            self._record_event(record, "CHECK_OUT", now, external_event_id=nonce, device_id=device_id)
            self.db.commit()
            self.db.refresh(record)
        except IntegrityError as exc:
            self.db.rollback()
            if nonce:
                replay = self._replay_nonce(nonce, "CHECK_OUT", employee_id)
                if replay is not None:
                    return replay
            raise
        return record

    def list_evidence_for_record(self, record_id: uuid.UUID) -> dict:
        record = self.repo.get_by_id(record_id)
        if record is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Registro no encontrado")
        items = list(
            self.db.scalars(
                select(AttendanceEvidence).where(AttendanceEvidence.attendance_record_id == record_id)
            )
        )
        events = list(
            self.db.scalars(
                select(AttendanceEvent).where(AttendanceEvent.attendance_record_id == record_id)
            )
        )
        by_nonce = {item.nonce: item for item in items}
        check_in = None
        check_out = None
        for event in events:
            evidence = by_nonce.get(event.external_event_id)
            payload = {
                "id": str(evidence.id) if evidence else None,
                "captured_at": evidence.captured_at.isoformat() if evidence else None,
                "content_type": evidence.content_type if evidence else None,
                "available": evidence is not None,
            }
            if event.event_type == "CHECK_IN":
                check_in = payload
            elif event.event_type == "CHECK_OUT":
                check_out = payload
        if check_in is None and items:
            check_in = {
                "id": str(items[0].id),
                "captured_at": items[0].captured_at.isoformat(),
                "content_type": items[0].content_type,
                "available": True,
            }
        return {"record_id": str(record.id), "check_in": check_in, "check_out": check_out}

    def get_evidence_image(self, evidence_id: uuid.UUID) -> AttendanceEvidence:
        evidence = self.db.get(AttendanceEvidence, evidence_id)
        if evidence is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Evidencia no encontrada")
        return evidence

    def get_evidence_payload(self, evidence_id: uuid.UUID) -> tuple[bytes, str]:
        evidence = self.get_evidence_image(evidence_id)
        if evidence.image_bytes:
            return evidence.image_bytes, evidence.content_type
        if evidence.object_key:
            if not evidence.storage_bucket:
                raise HTTPException(
                    status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                    detail="Ubicación de almacenamiento incompleta; requiere backfill explícito",
                )
            try:
                payload = get_object_store().get_bytes(evidence.object_key, bucket=evidence.storage_bucket)
            except ObjectNotFoundError as exc:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail="Evidencia no encontrada",
                ) from exc
            except ObjectStoreError as exc:
                self._raise_store_http(exc)
            return payload, evidence.content_type
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Evidencia no encontrada")

    MIN_PURGE_HOURS = 24

    def purge_abandoned_evidence(self, *, older_than_hours: int = 24) -> dict:
        if older_than_hours < self.MIN_PURGE_HOURS:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"older_than_hours debe ser al menos {self.MIN_PURGE_HOURS}",
            )
        cutoff = datetime.now(timezone.utc) - timedelta(hours=older_than_hours)
        candidates = list(
            self.db.scalars(
                select(AttendanceEvidence)
                .join(
                    AttendanceAttemptResolution,
                    AttendanceAttemptResolution.nonce == AttendanceEvidence.nonce,
                )
                .where(
                    AttendanceEvidence.attendance_record_id.is_(None),
                    AttendanceEvidence.captured_at < cutoff,
                    AttendanceAttemptResolution.resolution == "CANCELLED_UNCONFIRMED",
                    AttendanceAttemptResolution.resolved_at < cutoff,
                )
            )
        )
        deleted = 0
        omitted: list[dict[str, str]] = []
        store = None
        for snapshot in candidates:
            self.repo.lock_employee_for_attempt(snapshot.employee_id)
            resolution, consumed, evidence = self._fresh_attempt_rows(snapshot.nonce)
            if evidence is None:
                self.db.commit()
                continue
            if evidence.attendance_record_id is not None:
                self.db.commit()
                continue
            if consumed is not None and consumed.attendance_record_id is not None:
                self.db.commit()
                continue
            if resolution is None or resolution.resolution != "CANCELLED_UNCONFIRMED":
                self.db.commit()
                continue
            captured = evidence.captured_at
            if captured.tzinfo is None:
                captured = captured.replace(tzinfo=timezone.utc)
            resolved_at = resolution.resolved_at
            if resolved_at.tzinfo is None:
                resolved_at = resolved_at.replace(tzinfo=timezone.utc)
            if captured >= cutoff or resolved_at >= cutoff:
                self.db.commit()
                continue
            linked_event = self.db.scalar(
                select(AttendanceEvent).where(AttendanceEvent.external_event_id == evidence.nonce)
            )
            if linked_event is not None:
                self.db.commit()
                continue
            if evidence.object_key:
                bucket = (evidence.storage_bucket or "").strip()
                if not bucket:
                    omitted.append(
                        {"nonce": evidence.nonce, "reason": "incomplete_storage_location"}
                    )
                    self.db.commit()
                    continue
                if store is None:
                    try:
                        store = get_object_store()
                    except ObjectStoreError as exc:
                        raise HTTPException(
                            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                            detail=str(exc),
                        ) from exc
                try:
                    store.delete(evidence.object_key, bucket=bucket)
                except ObjectStoreError as exc:
                    self.db.rollback()
                    raise HTTPException(
                        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                        detail=str(exc),
                    ) from exc
            self.db.delete(evidence)
            try:
                self.db.commit()
            except (IntegrityError, OperationalError, InterfaceError):
                self.db.rollback()
                raise
            deleted += 1
        return {"deleted": deleted, "omitted": omitted}


    def _record_event(
        self,
        record: AttendanceRecord,
        event_type: str,
        captured_at: datetime,
        *,
        external_event_id: str | None = None,
        device_id=None,
    ) -> None:
        self.db.add(
            AttendanceEvent(
                employee_id=record.employee_id,
                attendance_record_id=record.id,
                device_id=device_id,
                external_event_id=external_event_id or str(uuid.uuid4()),
                event_type=event_type,
                source='WEB',
                captured_at=captured_at,
            )
        )

    def _recompute_day(self, employee_id: uuid.UUID, work_date: date, *, commit: bool = True) -> int:
        """Distribuye el total diario sin solapes y descuenta un solo refrigerio."""
        records = [
            record
            for record in self.repo.list_records(
                employee_id=employee_id, date_from=work_date, date_to=work_date, status="COMPLETE"
            )
            if record.check_out_at is not None
        ]
        records.sort(key=lambda item: _as_utc(item.check_in_at))
        cursor: datetime | None = None
        contributions: list[int] = []
        for record in records:
            start = _as_utc(record.check_in_at)
            end = _as_utc(record.check_out_at)
            effective_start = max(start, cursor) if cursor is not None else start
            contribution = max(0, int((end - effective_start).total_seconds() // 60))
            contributions.append(contribution)
            cursor = max(cursor, end) if cursor is not None else end

        gross = sum(contributions)
        schedule = WorkScheduleRepository(self.db).get_for_date(employee_id, work_date)
        break_to_apply = 0
        if schedule and gross >= schedule.break_applies_after_minutes:
            break_to_apply = min(schedule.break_minutes, gross)
        remaining_break = break_to_apply
        for index in range(len(contributions) - 1, -1, -1):
            deducted = min(contributions[index], remaining_break)
            contributions[index] -= deducted
            remaining_break -= deducted
        for record, minutes in zip(records, contributions, strict=True):
            record.worked_minutes = minutes
            self.db.add(record)
        if commit:
            self.db.commit()
        else:
            self.db.flush()
        return gross - break_to_apply

    # --- Panel administrativo (Fase 7) ---

    def list_records(
        self,
        *,
        employee_id: uuid.UUID | None = None,
        date_from: date | None = None,
        date_to: date | None = None,
        status_filter: str | None = None,
    ) -> list[dict]:
        """Registros para el panel, con minutos esperados (jornada) y diferencia."""
        records = self.repo.list_records(
            employee_id=employee_id, date_from=date_from, date_to=date_to, status=status_filter
        )
        schedules = ScheduleService(self.db)
        result = []
        for record in records:
            expected = schedules.expected_minutes(record.employee_id, record.work_date)
            result.append(
                {
                    "id": record.id,
                    "employee_id": record.employee_id,
                    "employee_name": (
                        f"{record.employee.first_name} {record.employee.last_name}"
                        if record.employee
                        else None
                    ),
                    "job_role_name": (
                        record.employee.job_role.name if record.employee and record.employee.job_role else None
                    ),
                    "work_date": record.work_date,
                    "check_in_at": record.check_in_at,
                    "check_out_at": record.check_out_at,
                    "worked_minutes": record.worked_minutes,
                    "expected_minutes": expected,
                    "difference_minutes": (
                        record.worked_minutes - expected if record.worked_minutes is not None else None
                    ),
                    "status": record.status,
                    "notes": record.notes,
                }
            )
        return result

    def summary(self, today: date) -> dict:
        """Indicadores simples del dashboard (MVP §29)."""
        active = self.repo.count_active_employees()
        present = self.repo.count_distinct_employees_on(today)
        return {
            "employees_active": active,
            "present_today": present,
            "no_entry_today": max(0, active - present),
            "open_entries": self.repo.count_open(),
            "checked_out_today": self.repo.count_complete_on(today),
        }

    def list_daily(
        self,
        *,
        employee_id: uuid.UUID | None = None,
        date_from: date | None = None,
        date_to: date | None = None,
    ) -> list[dict]:
        records = self.repo.list_records(employee_id=employee_id, date_from=date_from, date_to=date_to)
        groups: dict[tuple[uuid.UUID, date], list[AttendanceRecord]] = {}
        for record in records:
            groups.setdefault((record.employee_id, record.work_date), []).append(record)
        schedules = ScheduleService(self.db)
        result: list[dict] = []
        for (group_employee_id, work_date), sessions in groups.items():
            complete = sorted(
                [item for item in sessions if item.check_out_at is not None],
                key=lambda item: _as_utc(item.check_in_at),
            )
            gross = 0
            cursor: datetime | None = None
            incidents: set[str] = set()
            for item in complete:
                start = _as_utc(item.check_in_at)
                end = _as_utc(item.check_out_at)
                if (end - start).total_seconds() > 16 * 3600:
                    incidents.add("LONG_ATTENDANCE")
                if cursor is not None and start < cursor:
                    incidents.add("OVERLAPPING_SESSIONS")
                effective_start = max(start, cursor) if cursor is not None else start
                gross += max(0, int((end - effective_start).total_seconds() // 60))
                cursor = max(cursor, end) if cursor is not None else end
            has_open = any(item.check_out_at is None for item in sessions)
            if has_open:
                incidents.add("OPEN_ATTENDANCE")
            worked = sum(item.worked_minutes or 0 for item in complete)
            expected = schedules.expected_minutes(group_employee_id, work_date)
            employee = sessions[0].employee
            result.append(
                {
                    "employee_id": group_employee_id,
                    "employee_name": f"{employee.first_name} {employee.last_name}" if employee else None,
                    "work_date": work_date,
                    "session_count": len(sessions),
                    "gross_minutes": gross,
                    "break_minutes": max(0, gross - worked),
                    "worked_minutes": worked,
                    "expected_minutes": expected,
                    "difference_minutes": worked - expected,
                    "has_open_entry": has_open,
                    "incident_codes": sorted(incidents),
                }
            )
        return sorted(result, key=lambda item: (item["work_date"], str(item["employee_id"])), reverse=True)

    # --- Correcciones y auditoría (Fase 8) ---

    @staticmethod
    def _serialize(record: AttendanceRecord) -> dict:
        return {
            "work_date": record.work_date.isoformat(),
            "check_in_at": record.check_in_at.isoformat(),
            "check_out_at": record.check_out_at.isoformat() if record.check_out_at else None,
            "worked_minutes": record.worked_minutes,
            "status": record.status,
            "notes": record.notes,
        }

    def correct_record(
        self,
        record_id: uuid.UUID,
        *,
        reason: str,
        current_user_id: uuid.UUID | None,
        check_in_at=_MISSING,
        check_out_at=_MISSING,
        notes=_MISSING,
    ) -> AttendanceRecord:
        """Corrige un registro de asistencia y lo audita.

        Los valores derivados SIEMPRE los recalcula el backend:
        work_date (de check_in en Lima), worked_minutes (duración −
        refrigerio) y status (OPEN/COMPLETE según haya salida).
        """
        if not reason or not reason.strip():
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="El motivo de la corrección es obligatorio",
            )
        reason = reason.strip()

        record = self.repo.get_by_id(record_id)
        if record is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Registro no encontrado")

        old_date = record.work_date
        old_status = record.status
        old_values = self._serialize(record)

        if check_in_at is not _MISSING:
            if check_in_at is None:
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail="La entrada es obligatoria",
                )
            record.check_in_at = _as_utc(check_in_at)
            record.work_date = record.check_in_at.astimezone(lima_tz()).date()
        if check_out_at is not _MISSING:
            record.check_out_at = None if check_out_at is None else _as_utc(check_out_at)
        if notes is not _MISSING:
            record.notes = notes or None

        if record.check_out_at is not None and _as_utc(record.check_out_at) < _as_utc(record.check_in_at):
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="La salida no puede ser anterior a la entrada",
            )

        if record.check_out_at is None:
            open_other = self.repo.get_open(record.employee_id)
            if open_other is not None and open_other.id != record.id:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="Ya existe otra entrada abierta para este empleado",
                )
            record.status = "OPEN"
            record.worked_minutes = None
        else:
            record.worked_minutes = compute_worked_minutes(record.check_in_at, record.check_out_at, 0)
            record.status = "COMPLETE"

        if old_values == self._serialize(record) and old_date == record.work_date and old_status == record.status:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT, detail="No hay cambios que registrar"
            )

        self.repo.save(record, commit=False)
        dates = {old_date, record.work_date}
        for day in dates:
            self._recompute_day(record.employee_id, day, commit=False)
        self.db.refresh(record)
        new_values = self._serialize(record)
        AuditRepository(self.db).create(
            entity_type="attendance",
            entity_id=record_id,
            action="correction",
            old_values=old_values,
            new_values=new_values,
            reason=reason.strip(),
            performed_by=current_user_id,
            commit=False,
        )
        self.db.commit()
        self.db.refresh(record)
        return record
