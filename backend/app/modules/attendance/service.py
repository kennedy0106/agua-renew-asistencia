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
from collections.abc import Iterable
from datetime import date, datetime, timedelta, timezone

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError, InterfaceError, OperationalError
from sqlalchemy.orm import Session, joinedload

from app.core.images import MAX_INPUT_BYTES, verify_and_normalize
from app.core.object_store import (
    ObjectAlreadyExistsError,
    ObjectNotFoundError,
    ObjectStoreError,
    evidence_object_key,
    get_object_store,
)
from app.core.config import get_settings
from app.core.security import (
    create_attendance_token,
    decode_attendance_token,
    decode_attendance_token_for_recovery,
    renew_attendance_token,
)
from app.core.timezone import lima_tz
from app.modules.attendance.models import (
    STORAGE_S3,
    AttendanceAttemptResolution,
    AttendanceBreakOverride,
    AttendanceConsumedNonce,
    AttendanceEvent,
    AttendanceEvidence,
    AttendancePreparation,
    AttendanceRecord,
)
from app.modules.attendance.manual_models import ManualAttendanceDay
from app.modules.attendance.repository import AttendanceRepository
from app.modules.audit.repository import AuditRepository
from app.modules.employees.repository import EmployeeRepository
from app.modules.payroll.models import PERIOD_CALCULATED, PERIOD_CLOSED, PERIOD_OPEN, PayrollPeriod
from app.modules.schedules.repository import WorkScheduleRepository
from app.modules.schedules.service import ScheduleService

_MISSING = object()  # sentinela: distingue "no enviado" de "enviado como null"

# Plazo fijo del permiso de escritura preparado (S10/S11): los reintentos de
# subida/marcación no reinician la ventana de cinco minutos.
PREPARATION_WINDOW = timedelta(minutes=5)


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

    # --- Preparación explícita de ubicación (S1-S12) ---

    @staticmethod
    def _employee_label(employee) -> str:
        return f"{employee.first_name} {employee.last_name}".strip()

    def _get_preparation(self, nonce: str) -> AttendancePreparation | None:
        return self.db.scalar(
            select(AttendancePreparation)
            .where(AttendancePreparation.nonce == nonce)
            .execution_options(populate_existing=True)
        )

    @staticmethod
    def _preparation_is_open(preparation: AttendancePreparation) -> bool:
        return datetime.now(timezone.utc) < _as_utc(preparation.expires_at)

    @staticmethod
    def _preparation_location(preparation: AttendancePreparation) -> dict:
        return {
            "latitude": preparation.latitude,
            "longitude": preparation.longitude,
            "accuracy_m": preparation.accuracy_m,
            "observed_at": _as_utc(preparation.observed_at),
            "address": preparation.address,
        }

    def _preparation_snapshot(self, preparation: AttendancePreparation) -> dict:
        return {
            "marked_at": _as_utc(preparation.marked_at),
            "expires_at": _as_utc(preparation.expires_at),
            "location": self._preparation_location(preparation),
        }

    def _prepared_response(self, preparation: AttendancePreparation, decoded: dict) -> dict:
        snapshot = self._preparation_snapshot(preparation)
        snapshot["marking_token"] = renew_attendance_token(
            decoded, expires_at=_as_utc(preparation.expires_at)
        )
        return snapshot

    def _require_preparation(
        self,
        nonce: str,
        employee_id: uuid.UUID,
        action: str,
        *,
        device_id: uuid.UUID | None = None,
    ) -> AttendancePreparation:
        preparation = self._get_preparation(nonce)
        if preparation is None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Falta preparar la ubicación de este intento; identifique y prepare de nuevo",
            )
        if preparation.employee_id != employee_id or preparation.action != action:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Identificación vencida o inválida")
        if (
            preparation.device_id is None
            or device_id is None
            or preparation.device_id != device_id
        ):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="El token no corresponde a este terminal",
            )
        if not self._preparation_is_open(preparation):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="La preparación de ubicación venció; identifique y prepare de nuevo",
            )
        return preparation

    @staticmethod
    def _require_signed_browser(decoded: dict, device_id: uuid.UUID | None) -> None:
        """Toda preparación nueva exige did firmado y contexto de navegador real."""
        token_did = decoded.get("did")
        if not token_did or device_id is None or str(token_did) != str(device_id):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="El token no corresponde a este terminal",
            )

    def _validate_preparation_target(
        self, employee_id: uuid.UUID, action: str, record_id: uuid.UUID | None
    ) -> None:
        """Valida el objetivo antes de persistir, sin mutar nada.

        Evita snapshots obsoletos cuando el estado cambió desde la identificación:
        una salida cuyo registro ya se cerró, o una entrada con jornada ya abierta.
        """
        if action == "CHECK_OUT":
            record = self.repo.get_by_id(record_id) if record_id is not None else None
            if record is None or record.employee_id != employee_id or record.check_out_at is not None:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="La entrada de este intento ya no está abierta",
                )
            return
        if self.repo.get_open(employee_id) is not None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Ya tiene una entrada abierta; marque su salida primero",
            )

    def _resolve_address(self, preparation: AttendancePreparation | None) -> None:
        """Enriquecimiento opcional: ausencia, cuota o caída nunca fallan la marcación."""
        if preparation is None or preparation.address is not None:
            return
        try:
            from importlib import import_module

            module = import_module("app.modules.attendance.evidence_media")
            result = module.reverse_address(
                preparation.latitude,
                preparation.longitude,
                api_key=get_settings().geoapify_api_key,
            )
        except Exception:
            return
        formatted = None
        if isinstance(result, dict):
            formatted = result.get("formatted") or result.get("address")
        if formatted:
            preparation.address = str(formatted)[:500]
            self.db.add(preparation)

    def prepare_attempt(
        self, marking_token: str, *, location: dict, device_id: uuid.UUID | None = None
    ) -> dict:
        """Fija la hora oficial y la ubicación de un intento firmado (idempotente)."""
        decoded = decode_attendance_token(marking_token)
        if decoded is None:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Identificación vencida o inválida")
        self._require_signed_browser(decoded, device_id)
        employee_id = uuid.UUID(str(decoded["sub"]))
        employee = self._get_active_employee(employee_id)
        nonce = str(decoded["nonce"])
        action = str(decoded["action"])
        self.repo.lock_employee_for_attempt(employee_id)
        decoded = decode_attendance_token(marking_token)
        if decoded is None:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Identificación vencida o inválida")
        existing = self._get_preparation(nonce)
        if existing is not None:
            if existing.employee_id != employee_id or existing.action != action:
                raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Identificación vencida o inválida")
            if existing.device_id != device_id:
                raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="El token no corresponde a este terminal")
            return self._prepared_response(existing, decoded)
        resolution, consumed, _evidence = self._fresh_attempt_rows(nonce)
        if resolution is not None:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Este intento ya fue resuelto; identifique de nuevo")
        if consumed is not None:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Esta marcación ya se confirmó; identifique de nuevo")
        now = datetime.now(timezone.utc)
        record_id = None
        if decoded.get("rid"):
            try:
                record_id = uuid.UUID(str(decoded["rid"]))
            except ValueError:
                record_id = None
        self._validate_preparation_target(employee_id, action, record_id)
        preparation = AttendancePreparation(
            nonce=nonce,
            employee_id=employee_id,
            device_id=device_id,
            action=action,
            attendance_record_id=record_id,
            marked_at=now,
            expires_at=now + PREPARATION_WINDOW,
            latitude=float(location["latitude"]),
            longitude=float(location["longitude"]),
            accuracy_m=float(location["accuracy_m"]),
            age_ms=int(location["age_ms"]),
            observed_at=now - timedelta(milliseconds=int(location["age_ms"])),
            employee_name=self._employee_label(employee),
            employee_code=employee.employee_code,
        )
        self.db.add(preparation)
        try:
            self.db.commit()
        except IntegrityError:
            self.db.rollback()
            existing = self._get_preparation(nonce)
            if existing is None:
                raise
            return self._prepared_response(existing, decoded)
        self.db.refresh(preparation)
        return self._prepared_response(preparation, decoded)

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
        self._require_preparation(
            nonce, employee_id, str(decoded.get("action") or ""), device_id=device_id
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
        preparation: AttendancePreparation | None = None,
        write_payload: dict | None = None,
    ) -> dict:
        preparation_snapshot = (
            self._preparation_snapshot(preparation) if preparation is not None else None
        )
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
                    "marking_token": None,
                    "preparation": preparation_snapshot,
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
                "marking_token": None,
                "preparation": preparation_snapshot,
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
                "marking_token": None,
                "preparation": preparation_snapshot,
            }
        if preparation is not None and not self._preparation_is_open(preparation):
            # El plazo persistido manda: una preparación vencida no ofrece escritura
            # aunque el JWT presentado siga vigente.
            return {
                "state": "EXPIRED_UNCONFIRMED",
                "record": None,
                "evidence_ready": evidence is not None,
                "write_token_valid": False,
                "can_restart": False,
                "nonce": nonce,
                "resolution_id": None,
                "reason": None,
                "marking_token": None,
                "preparation": preparation_snapshot,
            }
        if preparation is not None and self._preparation_is_open(preparation) and write_payload is not None:
            # Recuperación acotada: el mismo navegador recibe un token equivalente
            # con el vencimiento EXACTO de la preparación; nunca lo extiende.
            return {
                "state": "PENDING",
                "record": None,
                "evidence_ready": evidence is not None,
                "write_token_valid": True,
                "can_restart": False,
                "nonce": nonce,
                "resolution_id": None,
                "reason": None,
                "marking_token": renew_attendance_token(
                    write_payload, expires_at=_as_utc(preparation.expires_at)
                ),
                "preparation": preparation_snapshot,
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
                "marking_token": None,
                "preparation": preparation_snapshot,
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
            "marking_token": None,
            "preparation": preparation_snapshot,
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
            preparation=self._get_preparation(nonce),
            write_payload=decoded,
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
            preparation=self._get_preparation(nonce),
            write_payload=decoded,
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
            preparation = self._require_preparation(
                nonce, employee_id, "CHECK_IN", device_id=device_id
            )
            if require_evidence:
                self._evidence_or_400(nonce, employee_id)
        else:
            preparation = None

        if self.repo.get_open(employee_id) is not None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Ya tiene una entrada abierta; marque su salida primero",
            )

        # La hora oficial es la preparada por el servidor antes de subir la foto.
        now = _as_utc(preparation.marked_at) if preparation is not None else datetime.now(timezone.utc)
        # The employee lock also protects this check from another shift closing
        # between validation and commit. Never move the reserved time forward.
        if preparation is not None and self.db.scalar(
            select(AttendanceRecord.id)
            .where(
                AttendanceRecord.employee_id == employee_id,
                AttendanceRecord.check_out_at > now,
            )
            .limit(1)
        ) is not None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="La hora preparada es anterior a una jornada ya cerrada; cancele este intento e identifique de nuevo",
            )
        work_date = now.astimezone(lima_tz()).date()
        # A historical administrative day and a kiosk session are mutually
        # exclusive sources for one employee/date.  Both services lock the
        # employee first, so this check remains valid through the commit.
        if self.db.scalar(
            select(ManualAttendanceDay.id).where(
                ManualAttendanceDay.employee_id == employee_id,
                ManualAttendanceDay.work_date == work_date,
                ManualAttendanceDay.voided_at.is_(None),
            )
        ) is not None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="La jornada tiene una carga histórica; no se mezclan fuentes",
            )
        try:
            self._resolve_address(preparation)
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
            preparation = self._require_preparation(
                nonce, employee_id, "CHECK_OUT", device_id=device_id
            )
            if require_evidence:
                self._evidence_or_400(nonce, employee_id)
        else:
            preparation = None

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

        now = _as_utc(preparation.marked_at) if preparation is not None else datetime.now(timezone.utc)
        if _as_utc(record.check_in_at) > now:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="La hora preparada de salida es anterior a la entrada; identifique de nuevo",
            )
        try:
            self._resolve_address(preparation)
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
        self.repo.lock_employee_for_attempt(record.employee_id)
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
        nonces = {item.nonce for item in items}
        nonces.update(event.external_event_id for event in events if event.external_event_id)
        preparations = (
            {
                preparation.nonce: preparation
                for preparation in self.db.scalars(
                    select(AttendancePreparation).where(AttendancePreparation.nonce.in_(nonces))
                )
            }
            if nonces
            else {}
        )
        check_in = None
        check_out = None
        for event in events:
            evidence = by_nonce.get(event.external_event_id)
            payload = self._evidence_metadata(
                evidence, preparations.get(event.external_event_id)
            )
            if event.event_type == "CHECK_IN":
                check_in = payload
            elif event.event_type == "CHECK_OUT":
                check_out = payload
        if check_in is None and items:
            check_in = self._evidence_metadata(items[0], preparations.get(items[0].nonce))
        return {"record_id": str(record.id), "check_in": check_in, "check_out": check_out}

    def _evidence_metadata(
        self,
        evidence: AttendanceEvidence | None,
        preparation: AttendancePreparation | None,
    ) -> dict:
        """Claves históricas de evidencia + metadatos aditivos de la preparación.

        Nunca fabrica coordenadas/horas para evidencia anterior: sin preparación
        quedan explícitamente nulas y sin sello disponible.
        """
        return {
            "id": str(evidence.id) if evidence else None,
            "captured_at": evidence.captured_at.isoformat() if evidence else None,
            "content_type": evidence.content_type if evidence else None,
            "available": evidence is not None,
            "marked_at": _as_utc(preparation.marked_at) if preparation else None,
            "location": self._preparation_location(preparation) if preparation else None,
            "stamped_available": bool(
                evidence is not None
                and evidence.attendance_record_id is not None
                and preparation is not None
            ),
        }

    def get_stamped_evidence_payload(self, evidence_id: uuid.UUID) -> tuple[bytes, str]:
        """Derivado privado sellado, generado perezosamente desde el original.

        El original (clave/hash) no se modifica; un fallo del derivado no anula
        ni duplica el evento confirmado.
        """
        evidence = self.get_evidence_image(evidence_id)
        if evidence.attendance_record_id is None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="La evidencia aún no está confirmada; no hay imagen sellada",
            )
        preparation = self._get_preparation(evidence.nonce)
        if preparation is None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="La evidencia no tiene preparación de ubicación; no se fabrica sello",
            )
        try:
            store = get_object_store()
        except ObjectStoreError as exc:
            self._raise_store_http(exc)
        bucket = evidence.storage_bucket or store.bucket
        key = f"attendance/{evidence.employee_id}/{evidence.nonce}.stamped.jpg"
        try:
            return store.get_bytes(key, bucket=bucket), "image/jpeg"
        except ObjectNotFoundError:
            pass
        except ObjectStoreError as exc:
            self._raise_store_http(exc)
        original, _content_type = self.get_evidence_payload(evidence_id)
        from importlib import import_module

        try:
            media = import_module("app.modules.attendance.evidence_media")
        except Exception as exc:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="El sello de evidencia no está disponible; la marcación permanece confirmada",
            ) from exc
        try:
            rendered = media.render_stamp(
                original,
                employee_name=preparation.employee_name,
                employee_code=preparation.employee_code or "",
                event_type=preparation.action,
                marked_at=_as_utc(preparation.marked_at),
                latitude=preparation.latitude,
                longitude=preparation.longitude,
                accuracy_m=preparation.accuracy_m,
                address=preparation.address,
                evidence_id=str(evidence.id),
            )
        except Exception as exc:
            # Falla controlada: NUNCA se devuelve el original como si estuviera
            # sellado, y el evento confirmado no se revierte ni se duplica.
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="El sello de evidencia no está disponible; la marcación permanece confirmada",
            ) from exc
        try:
            store.put_bytes(key, rendered, "image/jpeg", bucket=bucket)
        except ObjectAlreadyExistsError:
            pass
        except ObjectStoreError:
            # El sello es un derivado: persisitir no puede anular la marcación.
            pass
        return rendered, "image/jpeg"



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
        break_to_apply, _source, _requested, _limited = self._break_details(employee_id, work_date, gross)
        remaining_break = break_to_apply
        for index in range(len(contributions) - 1, -1, -1):
            deducted = min(contributions[index], remaining_break)
            contributions[index] -= deducted
            remaining_break -= deducted
        for record, minutes in zip(records, contributions, strict=True):
            record.worked_minutes = minutes
            self.db.add(record)
        # El flush hace visibles los minutos nuevos (la sesión corre sin
        # autoflush) y deja el commit al final, después de revalorizar.
        self.db.flush()
        # Una valoración especial vigente del mismo empleado/día parte de estos
        # minutos netos ya consolidados: se recalcula (o se exige rectificación
        # si su planilla está cerrada) sin crear filas ni descontar de nuevo el
        # refrigerio.  Si revalorizar falla, nada se confirma.
        from app.modules.work_calendar.service import SpecialDayValuationService

        SpecialDayValuationService(self.db).recompute_for_day(employee_id, work_date)
        if commit:
            self.db.commit()
        return gross - break_to_apply

    def _break_override(self, employee_id: uuid.UUID, work_date: date) -> AttendanceBreakOverride | None:
        return self.db.scalar(
            select(AttendanceBreakOverride).where(
                AttendanceBreakOverride.employee_id == employee_id,
                AttendanceBreakOverride.work_date == work_date,
            )
        )

    def _break_details(self, employee_id: uuid.UUID, work_date: date, gross: int) -> tuple[int, str, int | None, bool]:
        """Devuelve descuento efectivo y su procedencia sin perder el pedido real."""
        override = self._break_override(employee_id, work_date)
        schedule = WorkScheduleRepository(self.db).get_for_date(employee_id, work_date)
        return self._break_details_from_values(override, schedule, gross)

    @staticmethod
    def _break_details_from_values(
        override: AttendanceBreakOverride | None, schedule, gross: int
    ) -> tuple[int, str, int | None, bool]:
        """Aplica la regla de refrigerio sobre datos ya cargados.

        ``list_daily`` la usa para no consultar override y jornada por cada
        empleado/día. Las mutaciones siguen pasando por ``_break_details``.
        """
        if override is not None:
            effective = min(override.requested_break_minutes, gross)
            return effective, "OVERRIDE", override.requested_break_minutes, effective != override.requested_break_minutes
        if schedule and gross >= schedule.break_applies_after_minutes:
            return min(schedule.break_minutes, gross), "SCHEDULE", None, False
        return 0, "NONE", None, False

    def daily_break_plan(
        self,
        employee_id: uuid.UUID,
        work_date: date,
        *,
        additional_minutes: int = 0,
        ordinary_minutes: int | None = None,
        ordinary_known_break_minutes: int | None = None,
    ) -> dict:
        """Cálculo canónico de la presencia diaria y su único refrigerio.

        Combina las sesiones de kiosco completadas del día, la parte ordinaria
        de una carga histórica vigente (o la fila candidata que se está
        previsualizando) y el tiempo adicional solicitado.  La jornada sólo
        aplica **un** refrigerio: si la presencia ordinaria ya lo activó, el
        incremental es cero y el adicional se paga completo.
        """
        requested = max(0, int(additional_minutes))
        override = self._break_override(employee_id, work_date)
        schedule = WorkScheduleRepository(self.db).get_for_date(employee_id, work_date)
        records = [
            item
            for item in self.repo.list_records(
                employee_id=employee_id, date_from=work_date, date_to=work_date
            )
            if item.status == "COMPLETE" and item.check_out_at is not None
        ]
        manual = None
        if ordinary_minutes is None and not records:
            manual = self.db.scalar(
                select(ManualAttendanceDay).where(
                    ManualAttendanceDay.employee_id == employee_id,
                    ManualAttendanceDay.work_date == work_date,
                    ManualAttendanceDay.voided_at.is_(None),
                )
            )
        return self.daily_break_plan_from_values(
            work_date,
            requested,
            override=override,
            schedule=schedule,
            records=records,
            manual=manual,
            ordinary_minutes=ordinary_minutes,
            ordinary_known_break_minutes=ordinary_known_break_minutes,
        )

    def break_plan_inputs_for_days(
        self, employee_id: uuid.UUID, days: Iterable[date]
    ) -> dict[date, dict]:
        """Resuelve las entradas del refrigerio de varios días en lote.

        Es solo lectura: trae en una consulta por fuente el override, la
        jornada, las marcaciones completas y la carga manual vigente que
        ``daily_break_plan`` resolvería fila a fila, sin cambiar reglas.
        """
        unique_days = sorted(set(days))
        if not unique_days:
            return {}
        overrides = self._break_overrides_for_days({employee_id: set(unique_days)})
        schedules = ScheduleService(self.db).schedules_for_days({employee_id: unique_days})
        records_by_day: dict[date, list[AttendanceRecord]] = {}
        for record in self.repo.list_records(
            employee_id=employee_id, date_from=unique_days[0], date_to=unique_days[-1]
        ):
            if record.status == "COMPLETE" and record.check_out_at is not None:
                records_by_day.setdefault(record.work_date, []).append(record)
        manual_by_day = {
            item.work_date: item
            for item in self.db.scalars(
                select(ManualAttendanceDay).where(
                    ManualAttendanceDay.employee_id == employee_id,
                    ManualAttendanceDay.work_date >= unique_days[0],
                    ManualAttendanceDay.work_date <= unique_days[-1],
                    ManualAttendanceDay.voided_at.is_(None),
                )
            )
        }
        return {
            day: {
                "override": overrides.get((employee_id, day)),
                "schedule": schedules.get((employee_id, day)),
                "records": records_by_day.get(day, []),
                "manual": manual_by_day.get(day),
            }
            for day in unique_days
        }

    @staticmethod
    def daily_break_plan_from_values(
        work_date: date,
        requested: int,
        *,
        override: AttendanceBreakOverride | None,
        schedule,
        records: list[AttendanceRecord],
        manual: ManualAttendanceDay | None,
        ordinary_minutes: int | None = None,
        ordinary_known_break_minutes: int | None = None,
    ) -> dict:
        """Aritmética pura del refrigerio sobre entradas ya resueltas.

        Comparte exactamente la regla escalar: la única diferencia es que no
        consulta la base; recibe el override, la jornada, las marcaciones
        completas y la carga manual vigente del día.
        """
        if ordinary_minutes is not None:
            ordinary_gross = max(0, int(ordinary_minutes)) + max(
                0, int(ordinary_known_break_minutes or 0)
            )
            presence_source = "MANUAL"
        elif records:
            ordinary_gross = AttendanceService._gross_for_records(records)
            presence_source = "KIOSK"
        elif manual is not None:
            ordinary_gross = int(manual.normal_minutes) + int(manual.known_break_minutes or 0)
            presence_source = "MANUAL"
        else:
            ordinary_gross = 0
            presence_source = "NONE"
        break_before, _source_before, _requested_before, _limited_before = AttendanceService._break_details_from_values(
            override, schedule, ordinary_gross
        )
        break_after, source_after, _requested_after, _limited_after = AttendanceService._break_details_from_values(
            override, schedule, ordinary_gross + requested
        )
        scheduled_day_minutes = (
            getattr(
                schedule,
                ("monday_minutes", "tuesday_minutes", "wednesday_minutes", "thursday_minutes",
                 "friday_minutes", "saturday_minutes", "sunday_minutes")[work_date.weekday()],
            )
            if schedule
            else 0
        )
        if ordinary_gross > 0:
            # Hay presencia ordinaria registrada: el refrigerio incremental nace
            # de ella y el adicional se paga completo si el día ya lo activó.
            incremental = min(requested, max(0, break_after - break_before))
        elif scheduled_day_minutes <= 0 and requested > 0:
            # Día sin jornada programada (descanso semanal o feriado) cuyo único
            # registro es un ajuste OVERTIME: sus minutos representan toda la
            # presencia del día y activan un único refrigerio al alcanzar el
            # umbral (Daniel 2026-09-13: 510 -> 60 de refrigerio, 450 pagables).
            incremental = min(requested, break_after)
        else:
            # Día laborable: el ajuste es tiempo adicional sobre una jornada
            # programada; no se infiere presencia ordinaria ausente ni se
            # inventa un refrigerio.
            incremental = 0
        return {
            "requested_minutes": requested,
            "ordinary_gross_minutes": ordinary_gross,
            "break_before_minutes": break_before,
            "break_after_minutes": break_after,
            "break_minutes": incremental,
            "payable_minutes": requested - incremental,
            "break_source": source_after,
            "presence_source": presence_source,
            "scheduled_day_minutes": scheduled_day_minutes,
            "schedule_break_minutes": schedule.break_minutes if schedule else 0,
            "break_applies_after_minutes": schedule.break_applies_after_minutes if schedule else 0,
        }

    def _break_overrides_for_days(
        self, employee_days: dict[uuid.UUID, set[date]]
    ) -> dict[tuple[uuid.UUID, date], AttendanceBreakOverride]:
        """Carga de una vez los overrides que pueden pertenecer al resumen."""
        employee_ids = list(employee_days)
        all_days = [day for days in employee_days.values() for day in days]
        if not employee_ids or not all_days:
            return {}
        overrides = self.db.scalars(
            select(AttendanceBreakOverride).where(
                AttendanceBreakOverride.employee_id.in_(employee_ids),
                AttendanceBreakOverride.work_date >= min(all_days),
                AttendanceBreakOverride.work_date <= max(all_days),
            )
        )
        requested = {
            (employee_id, day)
            for employee_id, days in employee_days.items()
            for day in days
        }
        return {
            (item.employee_id, item.work_date): item
            for item in overrides
            if (item.employee_id, item.work_date) in requested
        }

    @staticmethod
    def _gross_for_records(records: list[AttendanceRecord]) -> int:
        complete = sorted(
            [item for item in records if item.check_out_at is not None], key=lambda item: _as_utc(item.check_in_at)
        )
        gross = 0
        cursor: datetime | None = None
        for item in complete:
            start, end = _as_utc(item.check_in_at), _as_utc(item.check_out_at)
            effective_start = max(start, cursor) if cursor is not None else start
            gross += max(0, int((end - effective_start).total_seconds() // 60))
            cursor = max(cursor, end) if cursor is not None else end
        return gross

    def _ensure_break_override_allowed(self, employee_id: uuid.UUID, work_date: date) -> list[AttendanceRecord]:
        today = datetime.now(lima_tz()).date()
        if work_date > today:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="El refrigerio solo se ajusta hasta la fecha actual")
        self._get_employee_or_404(employee_id)
        records = self.repo.list_records(employee_id=employee_id, date_from=work_date, date_to=work_date)
        complete = [record for record in records if record.status == "COMPLETE" and record.check_out_at is not None]
        if not complete:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Debe existir al menos una sesión completada para ajustar el refrigerio")
        if any(record.status == "OPEN" or record.check_out_at is None for record in records):
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Cierre todas las marcaciones del día antes de ajustar el refrigerio")
        return records

    def _invalidate_open_payroll_for_day(self, work_date: date) -> None:
        """Evita snapshots obsoletos sin tocar un periodo cerrado.

        Un CLOSED exige una rectificación OPEN/CALCULATED para el mismo root;
        de existir, esa versión queda OPEN y deberá recalcularse explícitamente.
        """
        periods = list(self.db.scalars(select(PayrollPeriod).where(PayrollPeriod.start_date <= work_date, PayrollPeriod.end_date >= work_date)))
        closed = [period for period in periods if period.status == PERIOD_CLOSED]
        for period in closed:
            editable = self.db.scalar(
                select(PayrollPeriod).where(
                    PayrollPeriod.root_period_id == period.root_period_id,
                    PayrollPeriod.status.in_((PERIOD_OPEN, PERIOD_CALCULATED)),
                    PayrollPeriod.start_date <= work_date,
                    PayrollPeriod.end_date >= work_date,
                )
            )
            if editable is None:
                raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="La planilla está cerrada: cree una rectificación antes de ajustar el refrigerio")
        for period in periods:
            if period.status == PERIOD_CALCULATED:
                period.status = PERIOD_OPEN
                period.inputs_fingerprint = None
                self.db.add(period)

    def _daily_item(self, employee_id: uuid.UUID, work_date: date) -> dict:
        item = next((item for item in self.list_daily(employee_id=employee_id, date_from=work_date, date_to=work_date) if item["work_date"] == work_date), None)
        if item is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No se encontró resumen diario")
        return item

    def set_break_override(self, employee_id: uuid.UUID, work_date: date, *, requested_break_minutes: int, reason: str, current_user_id: uuid.UUID | None) -> dict:
        records = self._ensure_break_override_allowed(employee_id, work_date)
        gross = self._gross_for_records(records)
        if requested_break_minutes > gross:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="El refrigerio no puede superar la presencia efectiva del día")
        self._invalidate_open_payroll_for_day(work_date)
        override = self._break_override(employee_id, work_date)
        old_values = None if override is None else {"requested_break_minutes": override.requested_break_minutes, "reason": override.reason}
        if override is None:
            override = AttendanceBreakOverride(employee_id=employee_id, work_date=work_date, requested_break_minutes=requested_break_minutes, reason=reason.strip(), created_by_user_id=current_user_id)
            self.db.add(override)
            action = "break_override_created"
        else:
            override.requested_break_minutes, override.reason, override.created_by_user_id = requested_break_minutes, reason.strip(), current_user_id
            self.db.add(override)
            action = "break_override_updated"
        # El refrigerio debe estar persistido antes de recalcular: la sesión
        # corre sin autoflush, y el neto (y su valoración) deben partir del
        # override nuevo, no del automático previo.
        self.db.flush()
        self._recompute_day(employee_id, work_date, commit=False)
        self.db.flush()
        AuditRepository(self.db).create(entity_type="attendance_break_override", entity_id=override.id, action=action, old_values=old_values, new_values={"employee_id": str(employee_id), "work_date": work_date.isoformat(), "requested_break_minutes": requested_break_minutes}, reason=reason.strip(), performed_by=current_user_id, commit=False)
        try:
            self.db.commit()
        except IntegrityError as exc:
            self.db.rollback()
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="El refrigerio fue actualizado por otra operación; vuelva a consultar") from exc
        return self._daily_item(employee_id, work_date)

    def clear_break_override(self, employee_id: uuid.UUID, work_date: date, *, reason: str, current_user_id: uuid.UUID | None) -> dict:
        self._ensure_break_override_allowed(employee_id, work_date)
        self._invalidate_open_payroll_for_day(work_date)
        override = self._break_override(employee_id, work_date)
        if override is None:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="La jornada ya usa el cálculo automático de refrigerio")
        old_values = {"employee_id": str(employee_id), "work_date": work_date.isoformat(), "requested_break_minutes": override.requested_break_minutes, "reason": override.reason}
        override_id = override.id
        self.db.delete(override)
        self.db.flush()
        self._recompute_day(employee_id, work_date, commit=False)
        gross = self._gross_for_records(self.repo.list_records(employee_id=employee_id, date_from=work_date, date_to=work_date))
        _effective, break_source, _requested, _limited = self._break_details(employee_id, work_date, gross)
        AuditRepository(self.db).create(entity_type="attendance_break_override", entity_id=override_id, action="break_override_cleared", old_values=old_values, new_values={"break_source": break_source}, reason=reason.strip(), performed_by=current_user_id, commit=False)
        try:
            self.db.commit()
        except IntegrityError as exc:
            self.db.rollback()
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="El refrigerio fue actualizado por otra operación; vuelva a consultar") from exc
        return self._daily_item(employee_id, work_date)

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
        employee_days: dict[uuid.UUID, set[date]] = {}
        for record in records:
            employee_days.setdefault(record.employee_id, set()).add(record.work_date)
        expected_by_day = ScheduleService(self.db).expected_minutes_for_days(
            employee_days
        )
        result = []
        for record in records:
            expected = expected_by_day[(record.employee_id, record.work_date)]
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
        counts = self.repo.summary_counts(today)
        active = counts["employees_active"]
        present = counts["present_today"]
        return {
            "employees_active": active,
            "present_today": present,
            "no_entry_today": max(0, active - present),
            "open_entries": counts["open_entries"],
            "checked_out_today": counts["checked_out_today"],
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
        manual_query = (
            select(ManualAttendanceDay)
            .options(joinedload(ManualAttendanceDay.employee))
            .where(ManualAttendanceDay.voided_at.is_(None))
        )
        if employee_id is not None:
            manual_query = manual_query.where(ManualAttendanceDay.employee_id == employee_id)
        if date_from is not None:
            manual_query = manual_query.where(ManualAttendanceDay.work_date >= date_from)
        if date_to is not None:
            manual_query = manual_query.where(ManualAttendanceDay.work_date <= date_to)
        manual_rows = list(self.db.scalars(manual_query))

        employee_days: dict[uuid.UUID, set[date]] = {}
        for group_employee_id, work_date in groups:
            employee_days.setdefault(group_employee_id, set()).add(work_date)
        for item in manual_rows:
            employee_days.setdefault(item.employee_id, set()).add(item.work_date)
        schedules = ScheduleService(self.db)
        schedules_by_day = schedules.schedules_for_days(employee_days)
        expected_by_day = {
            (item_employee_id, item_day): (
                getattr(schedule, ("monday_minutes", "tuesday_minutes", "wednesday_minutes", "thursday_minutes", "friday_minutes", "saturday_minutes", "sunday_minutes")[item_day.weekday()])
                if schedule else 0
            )
            for (item_employee_id, item_day), schedule in schedules_by_day.items()
        }
        overrides_by_day = self._break_overrides_for_days(employee_days)
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
            break_minutes, break_source, override_requested_minutes, override_limited = self._break_details_from_values(
                overrides_by_day.get((group_employee_id, work_date)),
                schedules_by_day[(group_employee_id, work_date)], gross
            )
            # El neto se deriva del total efectivo y conserva coherencia incluso
            # si una fila antigua fue creada antes del recálculo diario.
            worked = gross - break_minutes
            expected = expected_by_day[(group_employee_id, work_date)]
            employee = sessions[0].employee
            result.append(
                {
                    "employee_id": group_employee_id,
                    "employee_name": f"{employee.first_name} {employee.last_name}" if employee else None,
                    "work_date": work_date,
                    "session_count": len(sessions),
                    "gross_minutes": gross,
                    "break_minutes": break_minutes,
                    "break_source": break_source,
                    "override_requested_minutes": override_requested_minutes,
                    "override_limited": override_limited,
                    "worked_minutes": worked,
                    # Las sesiones del kiosco son presencia ordinaria.  No
                    # depender de los defaults del schema: estos valores se
                    # consumen junto con las filas históricas W/N/P/R.
                    "ordinary_minutes": worked,
                    "additional_minutes": 0,
                    "recovery_minutes": 0,
                    "expected_minutes": expected,
                    "difference_minutes": worked - expected,
                    "has_open_entry": has_open,
                    "incident_codes": sorted(incidents),
                }
            )
        # Las cargas históricas son presencia real declarada, pero nunca se
        # someten por segunda vez al descuento de refrigerio de sesiones.
        for item in manual_rows:
            employee = item.employee
            expected = expected_by_day[(item.employee_id, item.work_date)]
            result.append({"employee_id": item.employee_id, "employee_name": f"{employee.first_name} {employee.last_name}" if employee else None, "work_date": item.work_date, "session_count": 0, "gross_minutes": item.worked_minutes_net, "break_minutes": 0, "break_source": "NONE", "override_requested_minutes": None, "override_limited": False, "worked_minutes": item.worked_minutes_net, "ordinary_minutes": item.normal_minutes, "additional_minutes": item.additional_minutes, "recovery_minutes": item.recovery_minutes, "expected_minutes": expected, "difference_minutes": item.normal_minutes - expected, "has_open_entry": False, "incident_codes": ["HISTORICAL_MANUAL"]})
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

        # Todos los escritores que pueden decidir entre kiosco y carga
        # histórica toman primero la fila Employee.  Tomarla antes de mutar
        # work_date/corroborar ManualAttendanceDay evita que una corrección
        # cruce de fecha mientras batch decide que esa fecha está libre.
        self.repo.lock_employee_for_attempt(record.employee_id)
        record = self.db.scalar(
            select(AttendanceRecord)
            .where(AttendanceRecord.id == record_id)
            .execution_options(populate_existing=True)
            .with_for_update()
        )
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

        manual_conflict = self.db.scalar(
            select(ManualAttendanceDay.id).where(
                ManualAttendanceDay.employee_id == record.employee_id,
                ManualAttendanceDay.work_date == record.work_date,
                ManualAttendanceDay.voided_at.is_(None),
            )
        )
        if manual_conflict is not None:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="La fecha tiene carga histórica administrativa; no se pueden mezclar fuentes")

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
