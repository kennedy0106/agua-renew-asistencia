"""Rutas de asistencia.

Marcación de kiosco (cookie de terminal en producción):
- POST /identify, /evidence, /check-in, /check-out, /terminal/pair

Panel administrativo (autenticado):
- GET / (lista), /summary, /daily, evidencia privada
"""

import uuid
from datetime import date, datetime

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.responses import Response as RawResponse
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.permissions import get_current_user, require_any_role
from app.core.rate_limit import RateLimiter, client_ip
from app.core.security import create_terminal_token, decode_attendance_token, decode_terminal_token, terminal_cookie_kwargs
from app.core.timezone import lima_tz
from app.db.session import get_db
from app.modules.attendance.schemas import (
    AttendanceCorrection,
    AttendanceDailyItem,
    AttendanceListItem,
    AttendanceRecordOut,
    AttendanceSummary,
    AttemptResolveRequest,
    AttemptReviewRequest,
    CheckInRequest,
    CheckOutRequest,
    EvidenceRequest,
    IdentifyRequest,
    IdentifyResponse,
    AttemptStatusRequest,
    AttemptStatusResponse,
)
from app.modules.attendance.service import AttendanceService, _MISSING
from app.modules.devices.schemas import PairingRequest
from app.modules.devices.service import DeviceService

router = APIRouter(prefix="/api/v1/attendance", tags=["attendance"])

can_correct = require_any_role("ADMIN", "BOSS")
can_view_evidence = require_any_role("ADMIN", "BOSS")

_public_limiter = RateLimiter(limit=120, window_seconds=60)
_marking_limiter = RateLimiter(limit=10, window_seconds=60)


def require_terminal(request: Request, db: Session = Depends(get_db)):
    """En producción exige cookie de terminal enrolado. En desarrollo es opcional."""
    token = request.cookies.get("agua_renew_terminal")
    if not token:
        if get_settings().environment == "production":
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Este equipo no está autorizado para marcar")
        return None
    payload = decode_terminal_token(token)
    if payload is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Terminal no autorizado")
    device = DeviceService(db).get_active(uuid.UUID(str(payload["sub"])), token_version=int(payload.get("ver") or 1))
    return device


def _employee_from_marking_payload(
    payload: CheckInRequest | CheckOutRequest, expected_action: str
) -> tuple[uuid.UUID, str | None, bool, str | None, uuid.UUID | None]:
    if payload.marking_token:
        decoded = decode_attendance_token(payload.marking_token)
        if decoded and decoded.get("action") == expected_action:
            try:
                record_id = uuid.UUID(str(decoded["rid"])) if decoded.get("rid") else None
                return uuid.UUID(str(decoded["sub"])), str(decoded["nonce"]), True, decoded.get("did"), record_id
            except ValueError:
                pass
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Identificación vencida o inválida")
    if payload.employee_id is not None and get_settings().environment != "production":
        return payload.employee_id, None, False, None, None
    raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Debe identificar al trabajador nuevamente")


def _rate_limit_public(request: Request) -> None:
    key = f"public:{client_ip(request)}"
    if not _public_limiter.allow(key):
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Demasiadas peticiones. Intente de nuevo en un minuto.",
        )


@router.post("/terminal/pair")
def pair_terminal(
    payload: PairingRequest,
    response: Response,
    db: Session = Depends(get_db),
    _: None = Depends(_rate_limit_public),
) -> dict:
    device = DeviceService(db).pair(payload.pairing_code)
    token = create_terminal_token(str(device.id), device.token_version)
    response.set_cookie(value=token, **terminal_cookie_kwargs())
    return {"id": str(device.id), "name": device.name, "device_code": device.device_code}


@router.post("/identify", response_model=IdentifyResponse)
def identify(
    payload: IdentifyRequest,
    db: Session = Depends(get_db),
    _: None = Depends(_rate_limit_public),
    device=Depends(require_terminal),
) -> IdentifyResponse:
    return AttendanceService(db).identify(payload.identifier, device_id=device.id if device else None)


@router.post("/evidence", status_code=status.HTTP_201_CREATED)
def store_evidence(
    payload: EvidenceRequest,
    db: Session = Depends(get_db),
    _: None = Depends(_rate_limit_public),
    device=Depends(require_terminal),
) -> dict:
    evidence = AttendanceService(db).store_evidence(
        marking_token=payload.marking_token,
        image_base64=payload.image_base64,
        content_type=payload.content_type,
        device_id=device.id if device else None,
    )
    return {"id": str(evidence.id), "content_type": evidence.content_type}


@router.post("/attempt/status", response_model=AttemptStatusResponse)
def attempt_status(
    payload: AttemptStatusRequest,
    db: Session = Depends(get_db),
    _: None = Depends(_rate_limit_public),
    device=Depends(require_terminal),
) -> dict:
    return AttendanceService(db).attempt_status(
        payload.marking_token, device_id=device.id if device else None
    )


@router.post("/attempt/resolve", response_model=AttemptStatusResponse)
def resolve_attempt(
    payload: AttemptResolveRequest,
    db: Session = Depends(get_db),
    _: None = Depends(_rate_limit_public),
    device=Depends(require_terminal),
) -> dict:
    return AttendanceService(db).resolve_attempt(
        payload.marking_token,
        reason_code=payload.reason_code,
        device_id=device.id if device else None,
    )


@router.get("/attempts/{nonce}")
def inspect_attempt(
    nonce: str,
    db: Session = Depends(get_db),
    _: object = Depends(can_correct),
) -> dict:
    return AttendanceService(db).inspect_attempt_admin(nonce)


@router.post("/attempts/{nonce}/review")
def review_attempt(
    nonce: str,
    payload: AttemptReviewRequest,
    db: Session = Depends(get_db),
    user=Depends(can_correct),
) -> dict:
    return AttendanceService(db).review_attempt(nonce, reason=payload.reason, user_id=user.id)


@router.post("/check-in", response_model=AttendanceRecordOut, status_code=status.HTTP_201_CREATED)
def check_in(
    payload: CheckInRequest,
    db: Session = Depends(get_db),
    device=Depends(require_terminal),
) -> AttendanceRecordOut:
    employee_id, nonce, require_evidence, token_did, _record_id = _employee_from_marking_payload(payload, "CHECK_IN")
    if not _marking_limiter.allow(f"mark:{employee_id}"):
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail="Demasiadas marcaciones. Intente de nuevo en un minuto.")
    return AttendanceService(db).check_in(
        employee_id,
        nonce=nonce,
        require_evidence=require_evidence,
        device_id=device.id if device else None,
        token_device_id=token_did,
        marking_token=payload.marking_token,
    )


@router.post("/check-out", response_model=AttendanceRecordOut)
def check_out(
    payload: CheckOutRequest,
    db: Session = Depends(get_db),
    device=Depends(require_terminal),
) -> AttendanceRecordOut:
    employee_id, nonce, require_evidence, token_did, record_id = _employee_from_marking_payload(payload, "CHECK_OUT")
    if not _marking_limiter.allow(f"mark:{employee_id}"):
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail="Demasiadas marcaciones. Intente de nuevo en un minuto.")
    return AttendanceService(db).check_out(
        employee_id,
        nonce=nonce,
        require_evidence=require_evidence,
        device_id=device.id if device else None,
        token_device_id=token_did,
        record_id=record_id,
        marking_token=payload.marking_token,
    )


@router.get("", response_model=list[AttendanceListItem])
def list_attendance(
    employee_id: uuid.UUID | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    status: str | None = None,
    db: Session = Depends(get_db),
    _: object = Depends(get_current_user),
) -> list[AttendanceListItem]:
    return AttendanceService(db).list_records(
        employee_id=employee_id, date_from=date_from, date_to=date_to, status_filter=status
    )


@router.get("/summary", response_model=AttendanceSummary)
def attendance_summary(db: Session = Depends(get_db), _: object = Depends(get_current_user)) -> AttendanceSummary:
    today = datetime.now(lima_tz()).date()
    return AttendanceService(db).summary(today)


@router.get("/daily", response_model=list[AttendanceDailyItem])
def daily_attendance(
    employee_id: uuid.UUID | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    db: Session = Depends(get_db),
    _: object = Depends(get_current_user),
) -> list[AttendanceDailyItem]:
    return AttendanceService(db).list_daily(
        employee_id=employee_id, date_from=date_from, date_to=date_to
    )


@router.post("/maintenance/purge-abandoned-evidence")
def purge_abandoned_evidence(
    db: Session = Depends(get_db),
    _: object = Depends(require_any_role("ADMIN")),
    older_than_hours: int = 24,
) -> dict:
    deleted = AttendanceService(db).purge_abandoned_evidence(older_than_hours=older_than_hours)
    return {"deleted": deleted}


@router.get("/{record_id}/evidence")
def record_evidence(
    record_id: uuid.UUID,
    db: Session = Depends(get_db),
    _: object = Depends(can_view_evidence),
) -> dict:
    return AttendanceService(db).list_evidence_for_record(record_id)


@router.get("/evidence/{evidence_id}/image")
def evidence_image(
    evidence_id: uuid.UUID,
    db: Session = Depends(get_db),
    _: object = Depends(can_view_evidence),
) -> RawResponse:
    payload, content_type = AttendanceService(db).get_evidence_payload(evidence_id)
    return RawResponse(
        content=payload,
        media_type=content_type,
        headers={"Cache-Control": "private, no-store"},
    )


@router.patch("/{record_id}", response_model=AttendanceRecordOut)
def correct_attendance(
    record_id: uuid.UUID,
    payload: AttendanceCorrection,
    db: Session = Depends(get_db),
    user=Depends(can_correct),
) -> AttendanceRecordOut:
    """Corrige un registro (motivo obligatorio). El backend recalcula todo lo derivado."""
    return AttendanceService(db).correct_record(
        record_id,
        reason=payload.reason,
        current_user_id=user.id,
        check_in_at=payload.check_in_at if "check_in_at" in payload.model_fields_set else _MISSING,
        check_out_at=payload.check_out_at if "check_out_at" in payload.model_fields_set else _MISSING,
        notes=payload.notes if "notes" in payload.model_fields_set else _MISSING,
    )
