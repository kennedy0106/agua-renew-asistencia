import uuid
from datetime import date
from typing import Literal

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.core.permissions import require_any_role
from app.db.session import get_db
from app.modules.attendance.agenda_service import EmployeeAgendaService

router = APIRouter(prefix="/api/v1/employees", tags=["employee-attendance-agenda"])
_salary_access = require_any_role("ADMIN", "BOSS")


@router.get("/{employee_id}/attendance-agenda")
def employee_attendance_agenda(
    employee_id: uuid.UUID, date_from: date, date_to: date,
    db: Session = Depends(get_db), _: object = Depends(_salary_access),
):
    return EmployeeAgendaService(db).agenda(employee_id, date_from, date_to)


@router.get("/{employee_id}/payroll-accrual")
def employee_payroll_accrual(
    employee_id: uuid.UUID,
    period: Literal["FIRST_HALF", "SECOND_HALF", "MONTH", "CUSTOM"] = "MONTH",
    anchor_date: date | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    db: Session = Depends(get_db), _: object = Depends(_salary_access),
):
    return EmployeeAgendaService(db).accrual(
        employee_id, period=period, anchor_date=anchor_date or date.today(),
        date_from=date_from, date_to=date_to,
    )
