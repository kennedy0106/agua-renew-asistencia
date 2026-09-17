"""Un único consolidado de presencia real y carga histórica activa."""
import uuid
from datetime import date
from sqlalchemy import func, select
from sqlalchemy.orm import Session
from app.modules.adjustments.models import ADJUSTMENT_APPROVED, HourAdjustment
from app.modules.attendance.models import AttendanceRecord
from app.modules.attendance.manual_models import ManualAttendanceDay, ManualRecoveryApplication, RecoveryCommitment
from app.modules.schedules.service import ScheduleService

def manual_days(db: Session, employee_id: uuid.UUID, date_from: date, date_to: date):
    return list(db.scalars(select(ManualAttendanceDay).where(ManualAttendanceDay.employee_id == employee_id, ManualAttendanceDay.work_date >= date_from, ManualAttendanceDay.work_date <= date_to, ManualAttendanceDay.voided_at.is_(None))))

def worked_minutes(db: Session, employee_id: uuid.UUID, date_from: date, date_to: date) -> int:
    sessions = db.scalar(select(func.coalesce(func.sum(AttendanceRecord.worked_minutes), 0)).where(AttendanceRecord.employee_id == employee_id, AttendanceRecord.status == "COMPLETE", AttendanceRecord.work_date >= date_from, AttendanceRecord.work_date <= date_to)) or 0
    manual = db.scalar(select(func.coalesce(func.sum(ManualAttendanceDay.worked_minutes_net), 0)).where(ManualAttendanceDay.employee_id == employee_id, ManualAttendanceDay.voided_at.is_(None), ManualAttendanceDay.work_date >= date_from, ManualAttendanceDay.work_date <= date_to)) or 0
    return int(sessions) + int(manual)

def ordinary_minutes(db: Session, employee_id: uuid.UUID, date_from: date, date_to: date) -> int:
    """Tiempo que puede acreditar cumplimiento ordinario; P/R no cubren faltantes."""
    sessions = db.scalar(select(func.coalesce(func.sum(AttendanceRecord.worked_minutes), 0)).where(AttendanceRecord.employee_id == employee_id, AttendanceRecord.status == "COMPLETE", AttendanceRecord.work_date >= date_from, AttendanceRecord.work_date <= date_to)) or 0
    manual = db.scalar(select(func.coalesce(func.sum(ManualAttendanceDay.normal_minutes), 0)).where(ManualAttendanceDay.employee_id == employee_id, ManualAttendanceDay.voided_at.is_(None), ManualAttendanceDay.work_date >= date_from, ManualAttendanceDay.work_date <= date_to)) or 0
    return int(sessions) + int(manual)

def recovery_credit_minutes(db: Session, employee_id: uuid.UUID, date_from: date, date_to: date) -> int:
    """Crédito en la fecha del permiso, sin convertir R en presencia ordinaria.

    ``covered_before`` representa C=O (ya reconocido); de otro modo C=0.
    Cada compromiso se cuenta una única vez aunque tenga varias aplicaciones.
    """
    commitments = db.scalars(select(RecoveryCommitment).where(
        RecoveryCommitment.employee_id == employee_id,
        RecoveryCommitment.permission_date >= date_from,
        RecoveryCommitment.permission_date <= date_to,
    ))
    credit = 0
    for commitment in commitments:
        applied = db.scalar(select(func.coalesce(func.sum(ManualRecoveryApplication.minutes), 0)).join(ManualAttendanceDay).where(
            ManualRecoveryApplication.commitment_id == commitment.id,
            ManualAttendanceDay.voided_at.is_(None),
        )) or 0
        if commitment.covered_before:
            continue
        # Recovery repays only the authorized absence at its origin date; it
        # never creates a second ordinary presence or credit beyond the gap.
        expected = ScheduleService(db).expected_minutes(employee_id, commitment.permission_date)
        present = ordinary_minutes(db, employee_id, commitment.permission_date, commitment.permission_date)
        # Los ajustes legados aprobados ya reconocen cobertura de la falta en
        # la fecha origen.  R no puede acreditar por segunda vez los mismos
        # minutos (N360/E480 + ajuste120 + R120 => crédito nuevo 0).
        legacy_coverage = db.scalar(
            select(func.coalesce(func.sum(HourAdjustment.minutes), 0)).where(
                HourAdjustment.employee_id == employee_id,
                HourAdjustment.adjustment_date == commitment.permission_date,
                HourAdjustment.status == ADJUSTMENT_APPROVED,
                HourAdjustment.minutes > 0,
                # OVERTIME remunera trabajo adicional; no cubre la ausencia
                # ordinaria en el permiso ni puede reducir el crédito R.
                HourAdjustment.adjustment_type != "OVERTIME",
            )
        ) or 0
        # A historical commitment can predate a configured schedule; its
        # agreed minutes are then the only authorized missing-time ceiling.
        missing = (
            max(expected - present - int(legacy_coverage), 0)
            if expected > 0
            else max(commitment.agreed_minutes - int(legacy_coverage), 0)
        )
        credit += min(int(applied), commitment.agreed_minutes, missing)
    return credit
