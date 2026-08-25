"""Rutas públicas de marcación: /api/v1/attendance/*

NO requieren autenticación: el trabajador se identifica con DNI o código.
La validación de empleado activo ocurre en el servicio. Solo exponen la
información mínima del empleado (nunca datos salariales).
"""

from fastapi import APIRouter, Depends, status
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.modules.attendance.schemas import (
    AttendanceRecordOut,
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
