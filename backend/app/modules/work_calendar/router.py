import uuid
from datetime import date

from fastapi import APIRouter, Depends, status
from sqlalchemy.orm import Session

from app.core.permissions import require_any_role
from app.db.session import get_db
from app.modules.users.models import User
from app.modules.work_calendar.schemas import (
    HolidayCalendarCreate, RestSubstitutionCreate, SpecialDayApprovalRequest,
    SpecialDayPreviewRequest, SpecialDayReconcileRequest, SubstitutionAction,
    WeeklyRestRuleCorrect, WeeklyRestRuleCreate,
)
from app.modules.work_calendar.service import SpecialDayValuationService, WorkCalendarService

router = APIRouter(prefix="/api/v1/work-calendar", tags=["work-calendar"])
_manage = require_any_role("ADMIN", "BOSS")


def _item_out(item):
    if isinstance(item, dict):
        return item
    return {"id": str(item.id), "employee_id": str(item.employee_id), "original_date": item.original_date,
        "origin_kind": item.origin_kind,
        "substitute_start": item.substitute_start, "substitute_end": item.substitute_end, "reference": item.reference,
        "reason": item.reason, "status": item.status, "version": item.version, "evidence": item.evidence}


@router.get("/employees/{employee_id}/days")
def resolve_days(employee_id: uuid.UUID, date_from: date, date_to: date, db: Session = Depends(get_db), _: User = Depends(_manage)):
    return WorkCalendarService(db).resolve_employee_range(employee_id, date_from, date_to)


@router.post("/weekly-rest-rules", status_code=status.HTTP_201_CREATED)
def set_weekly_rest_rule(payload: WeeklyRestRuleCreate, db: Session = Depends(get_db), user: User = Depends(_manage)):
    item = WorkCalendarService(db).set_weekly_rest_rule(payload, user.id)
    return {"id": str(item.id), "employee_id": str(item.employee_id), "weekly_rest_weekday": item.weekly_rest_weekday,
        "reference_daily_minutes": item.reference_daily_minutes, "effective_from": item.effective_from, "version": item.version}


@router.post("/weekly-rest-rules/corrections", status_code=status.HTTP_201_CREATED)
def correct_weekly_rest_rule(payload: WeeklyRestRuleCorrect, db: Session = Depends(get_db), user: User = Depends(_manage)):
    return WorkCalendarService(db).correct_weekly_rest_rule(payload, user.id)


@router.post("/holidays", status_code=status.HTTP_201_CREATED)
def create_holiday(payload: HolidayCalendarCreate, db: Session = Depends(get_db), user: User = Depends(_manage)):
    item = WorkCalendarService(db).create_holiday(payload, user.id)
    return {"id": str(item.id), "holiday_date": item.holiday_date, "name": item.name, "day_kind": item.day_kind, "scope": item.scope}


@router.post("/holidays/catalogs/2026", status_code=status.HTTP_201_CREATED)
def load_2026_catalog(db: Session = Depends(get_db), _: User = Depends(_manage)):
    return {"created": WorkCalendarService(db).ensure_2026_national_holidays()}


@router.post("/rest-substitutions", status_code=status.HTTP_201_CREATED)
def propose_substitution(payload: RestSubstitutionCreate, db: Session = Depends(get_db), user: User = Depends(_manage)):
    return _item_out(WorkCalendarService(db).propose_substitution(payload, user.id))


@router.post("/rest-substitutions/{item_id}/approve")
def approve_substitution(item_id: uuid.UUID, payload: SubstitutionAction, db: Session = Depends(get_db), user: User = Depends(_manage)):
    return _item_out(WorkCalendarService(db).approve_substitution(item_id, payload, user.id))


@router.post("/rest-substitutions/{item_id}/verify")
def verify_substitution(item_id: uuid.UUID, payload: SubstitutionAction, db: Session = Depends(get_db), user: User = Depends(_manage)):
    return _item_out(WorkCalendarService(db).verify_substitution(item_id, payload, user.id))


@router.post("/rest-substitutions/{item_id}/cancel")
def cancel_substitution(item_id: uuid.UUID, payload: SubstitutionAction, db: Session = Depends(get_db), user: User = Depends(_manage)):
    return _item_out(WorkCalendarService(db).cancel_substitution(item_id, payload, user.id))


@router.post("/valuations/preview")
def preview_valuation(payload: SpecialDayPreviewRequest, db: Session = Depends(get_db), user: User = Depends(_manage)):
    return SpecialDayValuationService.out(SpecialDayValuationService(db).preview(payload.employee_id, payload.work_date, payload.source_kind, user.id))


@router.post("/valuations/{valuation_id}/approve")
def approve_valuation(valuation_id: uuid.UUID, payload: SpecialDayApprovalRequest, db: Session = Depends(get_db), user: User = Depends(_manage)):
    result = SpecialDayValuationService(db).approve(valuation_id, payload=payload, actor=user.id)
    return result if isinstance(result, dict) else SpecialDayValuationService.out(result)


@router.post("/valuations/{valuation_id}/reconcile")
def reconcile_valuation(valuation_id: uuid.UUID, payload: SpecialDayReconcileRequest, db: Session = Depends(get_db), user: User = Depends(_manage)):
    result = SpecialDayValuationService(db).reconcile_existing_payment(valuation_id, payload=payload, actor=user.id)
    return result if isinstance(result, dict) else SpecialDayValuationService.out(result)
