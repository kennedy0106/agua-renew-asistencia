"""Rutas de asistencia.

Marcación pública (sin auth):
- POST /identify, /check-in, /check-out

Panel administrativo (autenticado; cualquier rol puede consultar):
- GET / (lista con filtros) y GET /summary (indicadores del día)
"""

import uuid
from datetime import date, datetime

from fastapi import APIRouter, Depends, status
from sqlalchemy.orm import Session

from app.core.permissions import get_current_user
from app.core.timezone import lima_tz
from app.db.session import get_db
from app.modules.attendance.schemas import (
    AttendanceListItem,
    AttendanceRecordOut,
    AttendanceSummary,
    CheckInRequest,
    CheckOutRequest,
    IdentifyRequest,
    IdentifyResponse,
)
from app.modules.attendance.service import AttendanceService

router = APIRouter(prefix="/api/v1/attendance", tags=["attendance"])


@router.post("/identify", response_model=IdentifyResponse)
def identify(payload: IdentifyRequest, db: Session = Depends(get_db)) -> IdentifyResponse:
    return AttendanceService(db).identify(payload.identifier)


@router.post("/check-in", response_model=AttendanceRecordOut, status_code=status.HTTP_201_CREATED)
def check_in(payload: CheckInRequest, db: Session = Depends(get_db)) -> AttendanceRecordOut:
    return AttendanceService(db).check_in(payload.employee_id)


@router.post("/check-out", response_model=AttendanceRecordOut)
def check_out(payload: CheckOutRequest, db: Session = Depends(get_db)) -> AttendanceRecordOut:
    return AttendanceService(db).check_out(payload.employee_id)


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
