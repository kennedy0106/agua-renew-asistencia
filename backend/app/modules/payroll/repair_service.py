"""Reparación auditada y acotada de periodos OPEN/CALCULATED.

Reglas:
- Dry-run por defecto.  ``--apply`` exige actor y motivo.
- Nunca muta snapshots CLOSED: sólo los reporta como pendientes de
  rectificación (``PayrollService.create_rectification``).
- Idempotente: si una regla ya quedó corregida o un pago ya está en estado
  revisable, una segunda ejecución no genera acciones.
"""
from __future__ import annotations

import uuid
from datetime import date

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.timezone import lima_now
from app.modules.adjustments.models import ADJUSTMENT_APPROVED, HourAdjustment
from app.modules.adjustments.service import AdjustmentService
from app.modules.attendance.manual_models import ManualAttendanceDay
from app.modules.attendance.manual_service import ManualAttendanceService
from app.modules.attendance.service import AttendanceService
from app.modules.audit.repository import AuditRepository
from app.modules.payroll.models import PERIOD_CLOSED, PayrollPeriod
from app.modules.schedules.service import ScheduleService
from app.modules.work_calendar.models import (
    EmployeeWeeklyRestRule,
    SpecialDayValuation,
    VALUATION_APPROVED,
)
from app.modules.work_calendar.schemas import WeeklyRestRuleCorrect
from app.modules.work_calendar.service import WorkCalendarService


class PayrollRepairService:
    def __init__(self, db: Session) -> None:
        self.db = db

    # --- detección ---

    def audit(
        self,
        *,
        employee_id: uuid.UUID | None = None,
        date_from: date | None = None,
        date_to: date | None = None,
    ) -> dict:
        actions: list[dict] = []
        closed: list[dict] = []
        # Una corrección versionada deja la regla anterior activa pero
        # sombreada por la de mayor versión en la misma fecha.  Sólo la regla
        # efectiva (mayor versión por empleado/fecha) se audita.
        active_rules = self.db.scalars(select(EmployeeWeeklyRestRule).where(
            EmployeeWeeklyRestRule.effective_to.is_(None)
        )).all()
        effective_rules: dict[tuple[uuid.UUID, date], EmployeeWeeklyRestRule] = {}
        for rule in active_rules:
            key = (rule.employee_id, rule.effective_from)
            current = effective_rules.get(key)
            if current is None or rule.version > current.version:
                effective_rules[key] = rule
        for rule in effective_rules.values():
            if employee_id is not None and rule.employee_id != employee_id:
                continue
            # Una regla vigente (``effective_to`` nulo) con vigencia anterior a
            # ``date_from`` sigue gobernando los días del intervalo, por lo que
            # NO se descarta por el borde inferior: sólo se excluye cuando su
            # vigencia empieza después del rango consultado.
            if date_to is not None and rule.effective_from > date_to:
                continue
            journey = ScheduleService(self.db).ordinary_journey_minutes(rule.employee_id, rule.effective_from)
            if journey <= 0 or journey == rule.reference_daily_minutes:
                continue
            actions.append({
                "action": "CORRECT_WEEKLY_REST_RULE",
                "employee_id": str(rule.employee_id),
                "rule_id": str(rule.id),
                "effective_from": rule.effective_from.isoformat(),
                "rule_version": rule.version,
                "weekly_rest_weekday": rule.weekly_rest_weekday,
                "current_reference_minutes": rule.reference_daily_minutes,
                "expected_reference_minutes": journey,
            })

        overtime_rows = self.db.scalars(select(HourAdjustment).where(
            HourAdjustment.adjustment_type == "OVERTIME",
            HourAdjustment.status == ADJUSTMENT_APPROVED,
            HourAdjustment.voided_at.is_(None),
        )).all()
        for adjustment in overtime_rows:
            if employee_id is not None and adjustment.employee_id != employee_id:
                continue
            if date_from is not None and adjustment.adjustment_date < date_from:
                continue
            if date_to is not None and adjustment.adjustment_date > date_to:
                continue
            plan = AttendanceService(self.db).daily_break_plan(
                adjustment.employee_id, adjustment.adjustment_date,
                additional_minutes=adjustment.minutes,
            )
            snapshot = adjustment.approval_snapshot_data or {}
            valuation = snapshot.get("valuation") or {}
            current_break = int(valuation.get("break_minutes") or 0)
            if snapshot and current_break == int(plan["break_minutes"]):
                continue
            actions.append({
                "action": "REVISE_APPROVED_OVERTIME",
                "employee_id": str(adjustment.employee_id),
                "adjustment_id": str(adjustment.id),
                "adjustment_date": adjustment.adjustment_date.isoformat(),
                "version": adjustment.version,
                "requested_minutes": adjustment.minutes,
                "current_break_minutes": current_break,
                "expected_break_minutes": int(plan["break_minutes"]),
                "expected_payable_minutes": int(plan["payable_minutes"]),
                "had_snapshot": bool(snapshot),
            })

        manual_rows = self.db.scalars(select(ManualAttendanceDay).where(
            ManualAttendanceDay.payment_status == "APPROVED",
            ManualAttendanceDay.additional_minutes > 0,
            ManualAttendanceDay.voided_at.is_(None),
        )).all()
        for item in manual_rows:
            if employee_id is not None and item.employee_id != employee_id:
                continue
            if date_from is not None and item.work_date < date_from:
                continue
            if date_to is not None and item.work_date > date_to:
                continue
            plan = AttendanceService(self.db).daily_break_plan(
                item.employee_id, item.work_date,
                additional_minutes=item.additional_minutes,
                ordinary_minutes=item.normal_minutes,
                ordinary_known_break_minutes=item.known_break_minutes,
            )
            snapshot = item.payment_snapshot or {}
            current_break = int(snapshot.get("break_minutes") or 0)
            if current_break == int(plan["break_minutes"]):
                continue
            actions.append({
                "action": "REVISE_APPROVED_MANUAL_PAYMENT",
                "employee_id": str(item.employee_id),
                "manual_day_id": str(item.id),
                "work_date": item.work_date.isoformat(),
                "version": item.version,
                "requested_minutes": item.additional_minutes,
                "current_break_minutes": current_break,
                "expected_break_minutes": int(plan["break_minutes"]),
                "expected_payable_minutes": int(plan["payable_minutes"]),
            })

        special_rows = self.db.scalars(select(SpecialDayValuation).where(
            SpecialDayValuation.status == VALUATION_APPROVED,
            SpecialDayValuation.voided_at.is_(None),
        )).all()
        for valuation in special_rows:
            if employee_id is not None and valuation.employee_id != employee_id:
                continue
            if date_from is not None and valuation.work_date < date_from:
                continue
            if date_to is not None and valuation.work_date > date_to:
                continue
            context = WorkCalendarService(self.db).resolve_employee_day(valuation.employee_id, valuation.work_date)
            if context["reference_daily_minutes"] == valuation.reference_daily_minutes:
                continue
            actions.append({
                "action": "REVIEW_SPECIAL_DAY_VALUATION",
                "employee_id": str(valuation.employee_id),
                "valuation_id": str(valuation.id),
                "work_date": valuation.work_date.isoformat(),
                "current_reference_minutes": valuation.reference_daily_minutes,
                "expected_reference_minutes": context["reference_daily_minutes"],
            })

        closed = self._closed_periods(employee_id=employee_id, date_from=date_from, date_to=date_to)
        return {
            "dry_run": True,
            "actions": actions,
            "closed_periods_requiring_rectification": closed,
            "summary": {
                "correct_weekly_rest_rule": sum(1 for a in actions if a["action"] == "CORRECT_WEEKLY_REST_RULE"),
                "revise_approved_overtime": sum(1 for a in actions if a["action"] == "REVISE_APPROVED_OVERTIME"),
                "revise_approved_manual_payment": sum(1 for a in actions if a["action"] == "REVISE_APPROVED_MANUAL_PAYMENT"),
                "review_special_day_valuation": sum(1 for a in actions if a["action"] == "REVIEW_SPECIAL_DAY_VALUATION"),
                "closed_periods": len(closed),
            },
        }

    # --- aplicación ---

    def apply(
        self,
        *,
        actor_user_id: uuid.UUID,
        reason: str,
        employee_id: uuid.UUID | None = None,
        date_from: date | None = None,
        date_to: date | None = None,
    ) -> dict:
        if actor_user_id is None or not reason or not reason.strip():
            raise ValueError("--apply exige actor_user_id y un motivo")
        audit = self.audit(employee_id=employee_id, date_from=date_from, date_to=date_to)
        applied: list[dict] = []
        skipped: list[dict] = []
        calendar = WorkCalendarService(self.db)
        adjustments = AdjustmentService(self.db)
        for action in audit["actions"]:
            try:
                if action["action"] == "CORRECT_WEEKLY_REST_RULE":
                    calendar.correct_weekly_rest_rule(
                        WeeklyRestRuleCorrect(
                            employee_id=uuid.UUID(action["employee_id"]),
                            weekly_rest_weekday=int(action["weekly_rest_weekday"]),
                            reference_daily_minutes=int(action["expected_reference_minutes"]),
                            source="Reparación de referencia de descanso",
                            reason=reason.strip(),
                            effective_from=date.fromisoformat(action["effective_from"]),
                            expected_version=int(action["rule_version"]),
                            idempotency_key=f"repair-rule-{action['rule_id']}-{action['rule_version']}",
                        ),
                        actor_user_id,
                    )
                    applied.append({**action, "result": "corrected"})
                elif action["action"] == "REVISE_APPROVED_OVERTIME":
                    adjustments.update_versioned(
                        uuid.UUID(action["adjustment_id"]),
                        adjustment_date=date.fromisoformat(action["adjustment_date"]),
                        minutes=action["requested_minutes"],
                        adjustment_type="OVERTIME",
                        reason=reason.strip(),
                        expected_version=action["version"],
                        idempotency_key=f"repair-overtime-{action['adjustment_id']}-{action['version']}",
                        actor_id=actor_user_id,
                    )
                    applied.append({**action, "result": "reversion_pending"})
                elif action["action"] == "REVISE_APPROVED_MANUAL_PAYMENT":
                    self._revise_manual_payment(uuid.UUID(action["manual_day_id"]), actor_user_id, reason)
                    applied.append({**action, "result": "reversion_pending"})
                elif action["action"] == "REVIEW_SPECIAL_DAY_VALUATION":
                    # La corrección de la regla ya la volvió PENDING; se informa.
                    applied.append({**action, "result": "pending_review"})
            except Exception as exc:  # noqa: BLE001 - el informe debe seguir
                self.db.rollback()
                skipped.append({**action, "error": str(exc)})
        for period in audit["closed_periods_requiring_rectification"]:
            skipped.append({
                "action": "PAYROLL_RECTIFICATION_REQUIRED",
                "period_id": period["period_id"],
                **period,
            })
        return {"dry_run": False, "audit": audit, "applied": applied, "skipped": skipped}

    def _revise_manual_payment(self, item_id: uuid.UUID, actor_user_id: uuid.UUID, reason: str) -> None:
        current = self.db.scalar(
            select(ManualAttendanceDay)
            .where(ManualAttendanceDay.id == item_id)
            .with_for_update()
        )
        if current is None or current.voided_at is not None:
            return
        # Un periodo CLOSED es inmutable: su última versión sólo cambia por una
        # rectificación.  Se aborta antes de anular/versionar la fila para no
        # mutar un snapshot cerrado en silencio; ``apply`` lo reporta como
        # omitido y ``audit`` lo lista en closed_periods_requiring_rectification.
        ManualAttendanceService(self.db)._assert_not_closed(current.work_date)
        estimate = ManualAttendanceService(self.db).estimate_payment(
            current.employee_id, current.work_date, current.additional_minutes,
            ordinary_minutes=current.normal_minutes,
            ordinary_known_break_minutes=current.known_break_minutes,
        )
        now = lima_now()
        current.voided_at = now
        current.voided_by_user_id = actor_user_id
        current.void_reason = reason.strip()
        self.db.flush()
        replacement = ManualAttendanceDay(
            employee_id=current.employee_id, work_date=current.work_date,
            worked_minutes_net=current.worked_minutes_net, normal_minutes=current.normal_minutes,
            additional_minutes=current.additional_minutes, recovery_minutes=current.recovery_minutes,
            day_context=current.day_context, source_reference=current.source_reference,
            known_check_in_at=current.known_check_in_at, known_check_out_at=current.known_check_out_at,
            known_break_minutes=current.known_break_minutes, reason=current.reason,
            payment_status="PENDING" if current.additional_minutes else "NOT_APPLICABLE",
            payment_method=current.payment_method, payment_concept=current.payment_concept,
            payment_snapshot={**estimate, "status": "PENDING" if current.additional_minutes else "NOT_APPLICABLE"},
            version=current.version + 1, supersedes_id=current.id, created_by_user_id=actor_user_id,
        )
        self.db.add(replacement)
        self.db.flush()
        AuditRepository(self.db).create(
            entity_type="manual_attendance_day", entity_id=replacement.id,
            action="repair_reversion_pending",
            old_values={"version": current.version, "payment_status": "APPROVED"},
            new_values={"version": replacement.version, "payment_status": replacement.payment_status,
                        "requested_minutes": current.additional_minutes,
                        "break_minutes": int(estimate.get("break_minutes", 0)),
                        "payable_minutes": int(estimate.get("minutes", current.additional_minutes))},
            reason=reason.strip(), performed_by=actor_user_id, commit=False,
        )
        ManualAttendanceService(self.db)._invalidate_calculated_periods(current.work_date)
        ManualAttendanceService(self.db)._recompute_special_days({(current.employee_id, current.work_date)})
        self.db.commit()

    def _closed_periods(
        self, *, employee_id: uuid.UUID | None, date_from: date | None, date_to: date | None
    ) -> list[dict]:
        query = select(PayrollPeriod).where(PayrollPeriod.status == PERIOD_CLOSED)
        if date_from is not None:
            query = query.where(PayrollPeriod.end_date >= date_from)
        if date_to is not None:
            query = query.where(PayrollPeriod.start_date <= date_to)
        periods = list(self.db.scalars(query.order_by(PayrollPeriod.start_date)))
        return [
            {
                "period_id": str(period.id), "name": period.name,
                "start_date": period.start_date.isoformat(), "end_date": period.end_date.isoformat(),
                "version": period.version, "status": period.status,
                "reason": "PAYROLL_CLOSED_RECTIFICATION_REQUIRED",
            }
            for period in periods
        ]


__all__ = ["PayrollRepairService"]
