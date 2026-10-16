"""Un único consolidado de presencia real y carga histórica activa."""
import uuid
from collections.abc import Iterable
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


def balance_presence_minutes(
    db: Session, employee_id: uuid.UUID, date_from: date, date_to: date,
) -> tuple[int, int]:
    """Read ordinary and actual worked minutes together for the balance panel."""
    sessions = int(db.scalar(
        select(func.coalesce(func.sum(AttendanceRecord.worked_minutes), 0)).where(
            AttendanceRecord.employee_id == employee_id,
            AttendanceRecord.status == "COMPLETE",
            AttendanceRecord.work_date >= date_from,
            AttendanceRecord.work_date <= date_to,
        )
    ) or 0)
    rows = manual_days(db, employee_id, date_from, date_to)
    return (
        sessions + sum(int(item.normal_minutes or 0) for item in rows),
        sessions + sum(manual_payable_net_minutes(item) for item in rows),
    )


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


def recovery_credit_components_for_commitments(
    db: Session, commitments: Iterable[RecoveryCommitment],
) -> dict[uuid.UUID, dict[str, int | bool]]:
    """Bulk origin-side recovery inputs for many commitments.

    Returns exactly the same component keys/values as
    :func:`recovery_credit_components`, but resolves each source with one
    grouped read instead of one read per commitment.  The rules are unchanged:
    applications only count when their manual day is not voided, ``missing`` is
    expected minus ordinary minus legacy coverage when the origin day has an
    expected journey (otherwise agreed minutes minus legacy coverage), and
    ``effective_credit_minutes`` is capped by applied, agreed and missing.
    """
    items = list(commitments)
    if not items:
        return {}
    commitment_ids = {item.id for item in items}
    employee_days: dict[uuid.UUID, set[date]] = {}
    for item in items:
        employee_days.setdefault(item.employee_id, set()).add(item.permission_date)
    employee_ids = set(employee_days)
    days = {day for origin_days in employee_days.values() for day in origin_days}

    applied_rows = db.execute(
        select(
            ManualRecoveryApplication.commitment_id,
            func.coalesce(func.sum(ManualRecoveryApplication.minutes), 0),
        )
        .join(ManualAttendanceDay, ManualAttendanceDay.id == ManualRecoveryApplication.manual_day_id)
        .where(
            ManualRecoveryApplication.commitment_id.in_(commitment_ids),
            ManualAttendanceDay.voided_at.is_(None),
        )
        .group_by(ManualRecoveryApplication.commitment_id)
    ).all()
    applied_by_commitment = {commitment_id: int(total) for commitment_id, total in applied_rows}

    expected_by_day = ScheduleService(db).expected_minutes_for_days(employee_days, preserve_scalar_ties=True)

    present_by_origin: dict[tuple[uuid.UUID, date], int] = {}
    for employee_id, work_date, total in db.execute(
        select(
            AttendanceRecord.employee_id,
            AttendanceRecord.work_date,
            func.coalesce(func.sum(AttendanceRecord.worked_minutes), 0),
        )
        .where(
            AttendanceRecord.employee_id.in_(employee_ids),
            AttendanceRecord.work_date.in_(days),
            AttendanceRecord.status == "COMPLETE",
        )
        .group_by(AttendanceRecord.employee_id, AttendanceRecord.work_date)
    ).all():
        present_by_origin[(employee_id, work_date)] = int(total)
    for employee_id, work_date, total in db.execute(
        select(
            ManualAttendanceDay.employee_id,
            ManualAttendanceDay.work_date,
            func.coalesce(func.sum(ManualAttendanceDay.normal_minutes), 0),
        )
        .where(
            ManualAttendanceDay.employee_id.in_(employee_ids),
            ManualAttendanceDay.work_date.in_(days),
            ManualAttendanceDay.voided_at.is_(None),
        )
        .group_by(ManualAttendanceDay.employee_id, ManualAttendanceDay.work_date)
    ).all():
        origin = (employee_id, work_date)
        present_by_origin[origin] = present_by_origin.get(origin, 0) + int(total)

    legacy_by_origin = {
        (employee_id, adjustment_date): int(total)
        for employee_id, adjustment_date, total in db.execute(
            select(
                HourAdjustment.employee_id,
                HourAdjustment.adjustment_date,
                func.coalesce(func.sum(HourAdjustment.minutes), 0),
            )
            .where(
                HourAdjustment.employee_id.in_(employee_ids),
                HourAdjustment.adjustment_date.in_(days),
                HourAdjustment.status == ADJUSTMENT_APPROVED,
                HourAdjustment.voided_at.is_(None),
                HourAdjustment.minutes > 0,
                HourAdjustment.adjustment_type != "OVERTIME",
            )
            .group_by(HourAdjustment.employee_id, HourAdjustment.adjustment_date)
        ).all()
    }

    components: dict[uuid.UUID, dict[str, int | bool]] = {}
    for item in items:
        origin = (item.employee_id, item.permission_date)
        applied = applied_by_commitment.get(item.id, 0)
        expected = int(expected_by_day.get(origin) or 0)
        present = present_by_origin.get(origin, 0)
        legacy = legacy_by_origin.get(origin, 0)
        missing = (
            max(expected - present - legacy, 0)
            if expected > 0
            else max(item.agreed_minutes - legacy, 0)
        )
        components[item.id] = {
            "covered_before": item.covered_before,
            "applied_minutes": applied,
            "expected_minutes_at_origin": expected,
            "ordinary_minutes_at_origin": present,
            "legacy_coverage_minutes": legacy,
            "effective_credit_minutes": 0 if item.covered_before else min(applied, item.agreed_minutes, missing),
        }
    return components


def recovery_credit_minutes(db: Session, employee_id: uuid.UUID, date_from: date, date_to: date) -> int:
    """Crédito en la fecha del permiso, sin convertir R en presencia ordinaria.

    ``covered_before`` representa C=O (ya reconocido); de otro modo C=0.
    Cada compromiso se cuenta una única vez aunque tenga varias aplicaciones.
    """
    commitments = list(db.scalars(select(RecoveryCommitment).where(
        RecoveryCommitment.employee_id == employee_id,
        RecoveryCommitment.permission_date >= date_from,
        RecoveryCommitment.permission_date <= date_to,
    )))
    components = recovery_credit_components_for_commitments(db, commitments)
    return sum(
        int(components[commitment.id]["effective_credit_minutes"])
        for commitment in commitments
    )


def recovery_credit_minutes_by_day(
    db: Session, employee_id: uuid.UUID, date_from: date, date_to: date,
) -> dict[date, int]:
    """Crédito por fecha de permiso para un empleado (fechas ausentes = 0)."""
    commitments = list(db.scalars(select(RecoveryCommitment).where(
        RecoveryCommitment.employee_id == employee_id,
        RecoveryCommitment.permission_date >= date_from,
        RecoveryCommitment.permission_date <= date_to,
    )))
    components = recovery_credit_components_for_commitments(db, commitments)
    by_day: dict[date, int] = {}
    for commitment in commitments:
        credit = int(components[commitment.id]["effective_credit_minutes"])
        by_day[commitment.permission_date] = by_day.get(commitment.permission_date, 0) + credit
    return by_day
