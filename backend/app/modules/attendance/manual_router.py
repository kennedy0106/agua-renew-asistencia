import uuid
from datetime import date
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from app.core.permissions import require_admin_or_boss
from app.db.session import get_db
from app.modules.attendance.manual_schemas import CommitmentIn, ManualBatchIn, ManualMultiBatchIn, ManualUpdateIn, PaymentApproveIn, VoidIn
from app.modules.attendance.manual_service import ManualAttendanceService

router = APIRouter(prefix="/api/v1/attendance", tags=["manual-attendance"])
_manage = require_admin_or_boss

@router.get("/manual-days")
def list_manual_days(employee_id: uuid.UUID | None = None, date_from: date | None = None, date_to: date | None = None, include_voided: bool = False, offset: int = 0, limit: int = 50, db: Session = Depends(get_db), _: object = Depends(_manage)):
    return ManualAttendanceService(db).list(employee_id, date_from, date_to, offset=max(0, offset), limit=min(max(1, limit), 100), include_voided=include_voided)

@router.post("/manual-days/preview")
def preview_manual_days(payload: ManualBatchIn, db: Session = Depends(get_db), _: object = Depends(_manage)):
    return ManualAttendanceService(db).preview(payload)

@router.post("/manual-days/batch")
def create_manual_days(payload: ManualBatchIn, db: Session = Depends(get_db), user=Depends(_manage)):
    return ManualAttendanceService(db).batch(payload, user.id)


@router.post("/manual-days/multi/preview")
def preview_manual_days_multi(payload: ManualMultiBatchIn, db: Session = Depends(get_db), _: object = Depends(_manage)):
    return ManualAttendanceService(db).preview_multi(payload)


@router.post("/manual-days/multi")
def create_manual_days_multi(payload: ManualMultiBatchIn, db: Session = Depends(get_db), user=Depends(_manage)):
    return ManualAttendanceService(db).batch_multi(payload, user.id)

@router.post("/manual-days/{manual_day_id}/payment/approve")
def approve_manual_payment(manual_day_id: uuid.UUID, payload: PaymentApproveIn, db: Session = Depends(get_db), user=Depends(_manage)):
    return ManualAttendanceService(db).approve(manual_day_id, user.id, payload.expected_version, payload.expected_snapshot, payload.idempotency_key)

@router.get("/manual-days/{manual_day_id}")
def get_manual_day(manual_day_id: uuid.UUID, db: Session = Depends(get_db), _: object = Depends(_manage)):
    return ManualAttendanceService(db).get(manual_day_id)

@router.patch("/manual-days/{manual_day_id}")
def update_manual_day(manual_day_id: uuid.UUID, payload: ManualUpdateIn, db: Session = Depends(get_db), user=Depends(_manage)):
    return ManualAttendanceService(db).update(manual_day_id, payload, payload.expected_version, user.id, payload.idempotency_key)

@router.post("/manual-days/{manual_day_id}/void")
def void_manual_day(manual_day_id: uuid.UUID, payload: VoidIn, db: Session = Depends(get_db), user=Depends(_manage)):
    return ManualAttendanceService(db).void(manual_day_id, payload.expected_version, payload.reason, user.id, payload.idempotency_key)

@router.get("/manual-operations/{idempotency_key}")
def get_manual_operation(idempotency_key: str, db: Session = Depends(get_db), user=Depends(_manage)):
    return ManualAttendanceService(db).get_operation(idempotency_key, user.id)

@router.post("/recovery-commitments")
def create_recovery_commitment(payload: CommitmentIn, db: Session = Depends(get_db), user=Depends(_manage)):
    return ManualAttendanceService(db).create_commitment(payload, user.id)

@router.get("/recovery-commitments")
def list_recovery_commitments(employee_id: uuid.UUID | None = None, db: Session = Depends(get_db), _: object = Depends(_manage)):
    return ManualAttendanceService(db).list_commitments(employee_id)
