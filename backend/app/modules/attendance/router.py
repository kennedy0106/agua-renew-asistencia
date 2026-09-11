"""Rutas de asistencia.

Marcación pública (sin auth):
- POST /identify, /check-in, /check-out

Panel administrativo (autenticado; cualquier rol puede consultar):
- GET / (lista con filtros) y GET /summary (indicadores del día)
"""

import uuid
from datetime import date, datetime

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy.orm import Session

from app.core.permissions import get_current_user, require_any_role
from app.core.rate_limit import RateLimiter, client_ip
from app.core.timezone import lima_tz
from app.db.session import get_db
from app.modules.attendance.schemas import (
    AttendanceCorrection,
    AttendanceDailyItem,
    AttendanceListItem,
    AttendanceRecordOut,
    AttendanceSummary,
    CheckInRequest,
    CheckOutRequest,
    EvidenceRequest,
    IdentifyRequest,
    IdentifyResponse,
)
from app.modules.attendance.service import AttendanceService, _MISSING
from app.core.config import get_settings
from app.core.security import decode_attendance_token

router = APIRouter(prefix="/api/v1/attendance", tags=["attendance"])

can_correct = require_any_role("ADMIN", "BOSS")

# Identificar es compartido por el kiosco; marcar se limita por trabajador.
_public_limiter = RateLimiter(limit=120, window_seconds=60)
_marking_limiter = RateLimiter(limit=10, window_seconds=60)


def _employee_from_marking_payload(
    payload: CheckInRequest | CheckOutRequest, expected_action: str
) -> tuple[uuid.UUID, str | None, bool]:
    if payload.marking_token:
        decoded = decode_attendance_token(payload.marking_token)
        if decoded and decoded.get("action") == expected_action:
            try:
                return uuid.UUID(str(decoded["sub"])), str(decoded["nonce"]), True
            except ValueError:
                pass
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Identificación vencida o inválida")
    if payload.employee_id is not None and get_settings().environment != "production":
        return payload.employee_id, None, False
    raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Debe identificar al trabajador nuevamente")


def _rate_limit_public(request: Request) -> None:
    """Límite anti-abuso para endpoints sin autenticación."""
    key = f"public:{client_ip(request)}"
    if not _public_limiter.allow(key):
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Demasiadas peticiones. Intente de nuevo en un minuto.",
        )


@router.post("/identify", response_model=IdentifyResponse)
def identify(
    payload: IdentifyRequest,
    db: Session = Depends(get_db),
    _: None = Depends(_rate_limit_public),
) -> IdentifyResponse:
    return AttendanceService(db).identify(payload.identifier)


@router.post("/evidence", status_code=status.HTTP_201_CREATED)
def store_evidence(
    payload: EvidenceRequest,
    db: Session = Depends(get_db),
    _: None = Depends(_rate_limit_public),
) -> dict:
    evidence = AttendanceService(db).store_evidence(
        marking_token=payload.marking_token,
        image_base64=payload.image_base64,
        content_type=payload.content_type,
    )
    return {"id": str(evidence.id), "content_type": evidence.content_type}


@router.post("/check-in", response_model=AttendanceRecordOut, status_code=status.HTTP_201_CREATED)
def check_in(
    payload: CheckInRequest,
    db: Session = Depends(get_db),
) -> AttendanceRecordOut:
    employee_id, nonce, require_evidence = _employee_from_marking_payload(payload, "CHECK_IN")
    if not _marking_limiter.allow(f"mark:{employee_id}"):
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail="Demasiadas marcaciones. Intente de nuevo en un minuto.")
    return AttendanceService(db).check_in(employee_id, nonce=nonce, require_evidence=require_evidence)


@router.post("/check-out", response_model=AttendanceRecordOut)
def check_out(
    payload: CheckOutRequest,
    db: Session = Depends(get_db),
) -> AttendanceRecordOut:
    employee_id, nonce, require_evidence = _employee_from_marking_payload(payload, "CHECK_OUT")
    if not _marking_limiter.allow(f"mark:{employee_id}"):
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail="Demasiadas marcaciones. Intente de nuevo en un minuto.")
    return AttendanceService(db).check_out(employee_id, nonce=nonce, require_evidence=require_evidence)


# --- Panel administrativo (Fase 7) ---

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
