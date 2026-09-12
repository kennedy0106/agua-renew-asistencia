"""Servicio de asistencia: reglas de marcación pública.

- La hora SIEMPRE la define el backend (UTC en BD, presentación en
  America/Lima). Nunca se confía en el reloj del navegador.
- Check-in: rechazado si hay una entrada abierta (doble entrada).
- Check-out: rechazado sin entrada abierta; worked_minutes = duración −
  refrigerio de la jornada vigente en la fecha (0 si no hay jornada).
- Empleado cesado no puede marcar.
"""

import base64
import uuid
from datetime import date, datetime, timedelta, timezone

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.images import MAX_INPUT_BYTES, verify_and_normalize
from app.core.config import get_settings
from app.core.security import create_attendance_token, decode_attendance_token, decode_attendance_token_for_recovery
from app.core.timezone import lima_tz
from app.modules.attendance.models import (
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

    def _get_active_employee(self, employee_id: uuid.UUID):
        employee = EmployeeRepository(self.db).get_by_id(employee_id)
        if employee is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Empleado no encontrado")
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
        if decoded.get("did") and device_id and str(decoded["did"]) != str(device_id):
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="El token no corresponde a este terminal")
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
        existing = self.db.scalar(select(AttendanceEvidence).where(AttendanceEvidence.nonce == nonce))
        consumed = self.db.get(AttendanceConsumedNonce, nonce)
        if existing is not None:
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
        evidence = AttendanceEvidence(
            nonce=nonce,
            employee_id=employee_id,
            device_id=device_id,
            content_type=ctype,
            image_bytes=normalized,
            image_sha256=digest,
        )
        self.db.add(evidence)
        try:
            self.db.commit()
        except IntegrityError:
            self.db.rollback()
            existing = self.db.scalar(select(AttendanceEvidence).where(AttendanceEvidence.nonce == nonce))
            if existing is None:
                raise
            if existing.image_sha256 and existing.image_sha256 != digest:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="Ya hay una foto distinta para este intento; identifique de nuevo",
                )
            return existing
        self.db.refresh(evidence)
        return evidence

    def _evidence_or_400(self, nonce: str, employee_id: uuid.UUID) -> AttendanceEvidence:
        evidence = self.db.scalar(select(AttendanceEvidence).where(AttendanceEvidence.nonce == nonce))
        if evidence is None or evidence.employee_id != employee_id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Debe capturar una foto nueva antes de marcar",
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
        existing = self.db.get(AttendanceConsumedNonce, nonce)
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

    def attempt_status(self, marking_token: str, *, device_id: uuid.UUID | None = None) -> dict:
        decoded = decode_attendance_token_for_recovery(marking_token)
        if decoded is None:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Identificación vencida o inválida")
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
        employee_id = uuid.UUID(str(decoded["sub"]))
        self._get_active_employee(employee_id)
        nonce = str(decoded["nonce"])
        token_action = str(decoded.get("action") or "")
        consumed = self.db.get(AttendanceConsumedNonce, nonce)
        if consumed is None or not consumed.result_payload:
            return {"state": "PENDING", "record": None}
        if consumed.employee_id != employee_id:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Identificación vencida o inválida")
        if consumed.action != token_action:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Identificación vencida o inválida")
        if consumed.device_id is None or consumed.device_id != device_id:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="El token no corresponde a este terminal",
            )
        created_at = consumed.created_at
        if created_at.tzinfo is None:
            created_at = created_at.replace(tzinfo=timezone.utc)
        window = timedelta(minutes=get_settings().attempt_recovery_minutes)
        if datetime.now(timezone.utc) - created_at > window:
            raise HTTPException(
                status_code=status.HTTP_410_GONE,
                detail="El plazo para recuperar este intento ya venció",
            )
        return {"state": "CONFIRMED", "record": consumed.result_payload}

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
    ) -> AttendanceRecord | dict:
        self._get_active_employee(employee_id)
        if token_device_id and device_id and str(device_id) != str(token_device_id):
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="El token no corresponde a este terminal")
        if nonce:
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
                evidence = self.db.scalar(select(AttendanceEvidence).where(AttendanceEvidence.nonce == nonce))
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
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Ya tiene una entrada abierta; marque su salida primero",
            ) from exc
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
    ) -> AttendanceRecord | dict:
        self._get_active_employee(employee_id)
        if token_device_id and device_id and str(device_id) != str(token_device_id):
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="El token no corresponde a este terminal")
        if nonce:
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
                evidence = self.db.scalar(select(AttendanceEvidence).where(AttendanceEvidence.nonce == nonce))
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
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="La entrada de este intento ya no está abierta",
            ) from exc
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

    def purge_abandoned_evidence(self, *, older_than_hours: int = 24) -> int:
        cutoff = datetime.now(timezone.utc) - timedelta(hours=older_than_hours)
        rows = list(
            self.db.scalars(
                select(AttendanceEvidence).where(
                    AttendanceEvidence.attendance_record_id.is_(None),
                    AttendanceEvidence.captured_at < cutoff,
                )
            )
        )
        deleted = 0
        for row in rows:
            consumed = self.db.get(AttendanceConsumedNonce, row.nonce)
            if consumed is None:
                self.db.delete(row)
                deleted += 1
        self.db.commit()
        return deleted


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
