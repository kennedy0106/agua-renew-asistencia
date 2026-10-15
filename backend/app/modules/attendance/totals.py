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

def manual_payable_break_minutes(manual: ManualAttendanceDay) -> int:
    """Refrigerio incremental aplicado a una carga histórica (snapshot inmutable)."""
    snapshot = manual.payment_snapshot or {}
    try:
        return max(0, int(snapshot.get("break_minutes") or 0))
    except (TypeError, ValueError):
        return 0


def manual_payable_net_minutes(manual: ManualAttendanceDay) -> int:
    """Neto pagable de una carga: pedido crudo menos el refrigerio del snapshot."""
    return max(0, int(manual.worked_minutes_net) - manual_payable_break_minutes(manual))


def worked_minutes(db: Session, employee_id: uuid.UUID, date_from: date, date_to: date) -> int:
    sessions = db.scalar(select(func.coalesce(func.sum(AttendanceRecord.worked_minutes), 0)).where(AttendanceRecord.employee_id == employee_id, AttendanceRecord.status == "COMPLETE", AttendanceRecord.work_date >= date_from, AttendanceRecord.work_date <= date_to)) or 0
    manual = sum(
        manual_payable_net_minutes(item)
        for item in manual_days(db, employee_id, date_from, date_to)
    )
    return int(sessions) + int(manual)


def special_day_known_minutes(db: Session, employee_id: uuid.UUID, work_date: date) -> int:
    """Minutos netos trabajados que una valoración especial debe pagar.

    La asistencia/carga ya contiene el trabajo.  Si el día no tiene ninguna
    fila de asistencia (solo sobretiempo aprobado registrado como ajuste), se
    incorporan los minutos pagables de esos ajustes para no dejarlos fuera del
    descanso/feriado y sin duplicarlos cuando sí existe una fila.
    """
    from app.modules.adjustments.models import ADJUSTMENT_APPROVED, HourAdjustment

    base = worked_minutes(db, employee_id, work_date, work_date)
    has_row = db.scalar(select(AttendanceRecord.id).where(
        AttendanceRecord.employee_id == employee_id,
        AttendanceRecord.work_date == work_date,
        AttendanceRecord.status == "COMPLETE",
    )) is not None
    if not has_row:
        has_row = db.scalar(select(ManualAttendanceDay.id).where(
            ManualAttendanceDay.employee_id == employee_id,
            ManualAttendanceDay.work_date == work_date,
            ManualAttendanceDay.voided_at.is_(None),
        )) is not None
    if has_row:
        return base
    adjustments = list(db.scalars(select(HourAdjustment).where(
        HourAdjustment.employee_id == employee_id,
        HourAdjustment.adjustment_date == work_date,
        HourAdjustment.adjustment_type == "OVERTIME",
        HourAdjustment.status == ADJUSTMENT_APPROVED,
        HourAdjustment.voided_at.is_(None),
    )))
    for adjustment in adjustments:
        valuation = (adjustment.approval_snapshot_data or {}).get("valuation") or {}
        base += int(valuation.get("minutes", adjustment.minutes))
    return base

def ordinary_minutes(db: Session, employee_id: uuid.UUID, date_from: date, date_to: date) -> int:
    """Tiempo que puede acreditar cumplimiento ordinario; P/R no cubren faltantes."""
    sessions = db.scalar(select(func.coalesce(func.sum(AttendanceRecord.worked_minutes), 0)).where(AttendanceRecord.employee_id == employee_id, AttendanceRecord.status == "COMPLETE", AttendanceRecord.work_date >= date_from, AttendanceRecord.work_date <= date_to)) or 0
    manual = db.scalar(select(func.coalesce(func.sum(ManualAttendanceDay.normal_minutes), 0)).where(ManualAttendanceDay.employee_id == employee_id, ManualAttendanceDay.voided_at.is_(None), ManualAttendanceDay.work_date >= date_from, ManualAttendanceDay.work_date <= date_to)) or 0
    return int(sessions) + int(manual)

def recovery_credit_components(db: Session, commitment: RecoveryCommitment) -> dict[str, int | bool]:
    """Canonical origin-side recovery inputs shared by balances/fingerprints."""
    employee_id = commitment.employee_id
    applied = db.scalar(select(func.coalesce(func.sum(ManualRecoveryApplication.minutes), 0)).join(ManualAttendanceDay).where(
        ManualRecoveryApplication.commitment_id == commitment.id,
        ManualAttendanceDay.voided_at.is_(None),
    )) or 0
    expected = ScheduleService(db).expected_minutes(employee_id, commitment.permission_date)
    present = ordinary_minutes(db, employee_id, commitment.permission_date, commitment.permission_date)
    legacy_coverage = db.scalar(
        select(func.coalesce(func.sum(HourAdjustment.minutes), 0)).where(
            HourAdjustment.employee_id == employee_id,
            HourAdjustment.adjustment_date == commitment.permission_date,
            HourAdjustment.status == ADJUSTMENT_APPROVED,
            HourAdjustment.voided_at.is_(None),
            HourAdjustment.minutes > 0,
            HourAdjustment.adjustment_type != "OVERTIME",
        )
    ) or 0
    missing = max(expected - present - int(legacy_coverage), 0) if expected > 0 else max(commitment.agreed_minutes - int(legacy_coverage), 0)
    return {
        "covered_before": commitment.covered_before,
        "applied_minutes": int(applied),
        "expected_minutes_at_origin": int(expected),
        "ordinary_minutes_at_origin": int(present),
        "legacy_coverage_minutes": int(legacy_coverage),
        "effective_credit_minutes": 0 if commitment.covered_before else min(int(applied), commitment.agreed_minutes, missing),
    }


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
        credit += int(recovery_credit_components(db, commitment)["effective_credit_minutes"])
    return credit
