"""Rutas de jornadas: /api/v1/employees/{id}/schedule

- GET: cualquier autenticado (parámetro opcional ?date=YYYY-MM-DD).
- POST: ADMIN y JEFE (configurar jornadas).
"""

import uuid
from datetime import date

from fastapi import APIRouter, Depends, status
from sqlalchemy.orm import Session

from app.core.permissions import get_current_user, require_any_role
from app.db.session import get_db
from app.modules.schedules.schemas import WorkScheduleCreate, WorkScheduleOut
from app.modules.schedules.service import ScheduleService

router = APIRouter(prefix="/api/v1/employees", tags=["schedules"])

can_manage_schedules = require_any_role("ADMIN", "BOSS")


@router.get("/{employee_id}/schedule", response_model=WorkScheduleOut)
def get_schedule(
    employee_id: uuid.UUID,
    date: date | None = None,
    db: Session = Depends(get_db),
    _: object = Depends(get_current_user),
) -> WorkScheduleOut:
    service = ScheduleService(db)
    if date is not None:
        return service.get_for_date_or_404(employee_id, date)
    return service.get_current(employee_id)


@router.get("/{employee_id}/schedule/history", response_model=list[WorkScheduleOut])
def get_schedule_history(
    employee_id: uuid.UUID,
    db: Session = Depends(get_db),
    _: object = Depends(get_current_user),
) -> list[WorkScheduleOut]:
    return ScheduleService(db).list_history(employee_id)


@router.post("/{employee_id}/schedule", response_model=WorkScheduleOut, status_code=status.HTTP_201_CREATED)
def set_schedule(
    employee_id: uuid.UUID,
    payload: WorkScheduleCreate,
    db: Session = Depends(get_db),
    user: object = Depends(can_manage_schedules),
) -> WorkScheduleOut:
    return ScheduleService(db).set_schedule(
        employee_id=employee_id,
        effective_from=payload.effective_from,
        minutes={
            "monday_minutes": payload.monday_minutes,
            "tuesday_minutes": payload.tuesday_minutes,
            "wednesday_minutes": payload.wednesday_minutes,
            "thursday_minutes": payload.thursday_minutes,
            "friday_minutes": payload.friday_minutes,
            "saturday_minutes": payload.saturday_minutes,
            "sunday_minutes": payload.sunday_minutes,
        },
        break_minutes=payload.break_minutes,
        performed_by=user.id if user is not None else None,
    )
