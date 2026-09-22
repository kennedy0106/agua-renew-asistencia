"""Reglas históricas para descansos, feriados y su valoración monetaria."""
from __future__ import annotations

import hashlib
import json
import secrets
import uuid
from datetime import date, datetime, timedelta
from decimal import Decimal, ROUND_HALF_UP

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.core.legal import daily_value, double_days_value
from app.core.timezone import lima_now, lima_tz
from app.modules.attendance.models import AttendanceRecord
from app.modules.attendance.manual_models import ManualAttendanceDay
from app.modules.attendance.totals import worked_minutes
from app.modules.audit.repository import AuditRepository
from app.modules.salary.service import SalaryService
from app.modules.schedules.service import ScheduleService
from app.modules.payroll.models import PERIOD_CALCULATED, PERIOD_CLOSED, PERIOD_OPEN, PayrollPeriod
from app.modules.work_calendar.models import (
    EmployeeWeeklyRestRule, HolidayCalendarDay, RestSubstitution,
    SpecialDayValuation, SpecialDayValuationComponent, WorkCalendarOperationReceipt,
    SUBSTITUTION_APPROVED, SUBSTITUTION_CANCELLED, SUBSTITUTION_ENJOYED,
    SUBSTITUTION_INVALIDATED, SUBSTITUTION_PROPOSED, VALUATION_APPROVED,
    VALUATION_PENDING, VALUATION_REVIEW_REQUIRED, VALUATION_VOIDED,
)

_CENTS = Decimal("0.01")


class WorkCalendarService:
    def __init__(self, db: Session):
        self.db = db

    @staticmethod
    def _hash(payload: dict) -> str:
        return hashlib.sha256(json.dumps(payload, sort_keys=True, default=str).encode()).hexdigest()

    @staticmethod
    def _payload(payload) -> dict:
        return payload.model_dump(mode="json") if hasattr(payload, "model_dump") else payload

    @staticmethod
    def _immutable(result: dict) -> dict:
        """JSON receipts are the response contract of an idempotent mutation."""
        return json.loads(json.dumps(result, default=str))

    def _receipt(self, key: str, payload, operation: str, actor: uuid.UUID | None,
                 target: uuid.UUID | None = None):
        payload = self._payload(payload)
        receipt = self.db.get(WorkCalendarOperationReceipt, key)
        digest = self._hash(payload)
        if receipt:
            if (receipt.payload_hash != digest or receipt.operation_type != operation
                    or receipt.actor_user_id != actor or receipt.target_entity_id != target):
                raise HTTPException(status_code=409, detail="La clave de idempotencia ya corresponde a otra operación")
            return receipt.result
        return None

    def _save_receipt(self, key: str, payload, operation: str, actor: uuid.UUID | None,
                      result: dict, target: uuid.UUID | None = None):
        payload = self._payload(payload)
        self.db.add(WorkCalendarOperationReceipt(
            idempotency_key=key, payload_hash=self._hash(payload), operation_type=operation,
            actor_user_id=actor, target_entity_id=target, result=self._immutable(result),
        ))

    @staticmethod
    def substitution_out(item: RestSubstitution) -> dict:
        return {
            "id": str(item.id), "employee_id": str(item.employee_id),
            "original_date": item.original_date.isoformat(), "origin_kind": item.origin_kind,
            "substitute_start": item.substitute_start.isoformat(), "substitute_end": item.substitute_end.isoformat(),
            "reference": item.reference, "reason": item.reason, "status": item.status,
            "version": item.version, "evidence": item.evidence,
        }

    def _commit(self):
        try:
            self.db.commit()
        except Exception:
            self.db.rollback()
            raise

    def _rule(self, employee_id: uuid.UUID, day: date) -> EmployeeWeeklyRestRule | None:
        return self.db.scalar(select(EmployeeWeeklyRestRule).where(
            EmployeeWeeklyRestRule.employee_id == employee_id,
            EmployeeWeeklyRestRule.effective_from <= day,
            (EmployeeWeeklyRestRule.effective_to.is_(None)) | (EmployeeWeeklyRestRule.effective_to >= day),
        ).order_by(EmployeeWeeklyRestRule.effective_from.desc(), EmployeeWeeklyRestRule.version.desc()))

    def _holiday(self, day: date) -> HolidayCalendarDay | None:
        return self.db.scalar(select(HolidayCalendarDay).where(
            HolidayCalendarDay.holiday_date == day,
            HolidayCalendarDay.effective_from <= day,
            (HolidayCalendarDay.effective_to.is_(None)) | (HolidayCalendarDay.effective_to >= day),
        ).order_by(HolidayCalendarDay.version.desc()))

    def set_weekly_rest_rule(self, payload, actor: uuid.UUID) -> EmployeeWeeklyRestRule:
        # Vigencias no se solapan: cerrar la regla anterior preserva su historia.
        prior = self._rule(payload.employee_id, payload.effective_from)
        if prior and prior.effective_from == payload.effective_from:
            raise HTTPException(status_code=409, detail="Ya existe una regla de descanso con esta vigencia")
        self.invalidate_dependent_valuations(payload.employee_id, payload.effective_from)
        if prior and prior.effective_to is None:
            prior.effective_to = payload.effective_from - timedelta(days=1)
        version = (prior.version + 1) if prior else 1
        rule = EmployeeWeeklyRestRule(
            employee_id=payload.employee_id, weekly_rest_weekday=payload.weekly_rest_weekday,
            reference_daily_minutes=payload.reference_daily_minutes, source=payload.source.strip(),
            reason=payload.reason.strip(), effective_from=payload.effective_from, version=version,
            created_by_user_id=actor,
        )
        self.db.add(rule)
        self.db.flush()
        AuditRepository(self.db).create(entity_type="employee_weekly_rest_rule", entity_id=rule.id,
            action="created", old_values=None,
            new_values={"weekly_rest_weekday": rule.weekly_rest_weekday,
                        "reference_daily_minutes": rule.reference_daily_minutes,
                        "effective_from": str(rule.effective_from)},
            reason=rule.reason, performed_by=actor, commit=False)
        self._commit(); self.db.refresh(rule)
        return rule

    def invalidate_dependent_valuations(self, employee_id: uuid.UUID, effective_from: date) -> int:
        """Una configuración nueva nunca repricia evidencia cerrada en silencio.

        Las valoraciones aprobadas fuera de un cierre vuelven a PENDING y el
        cálculo abierto pierde su fingerprint; las de un periodo cerrado se
        preservan y su rectificación sigue siendo el único camino de cambio.
        """
        periods = list(self.db.scalars(select(PayrollPeriod).where(PayrollPeriod.end_date >= effective_from).with_for_update()))
        self._assert_periods_mutable(periods)
        rows = list(self.db.scalars(select(SpecialDayValuation).where(
            SpecialDayValuation.employee_id == employee_id,
            SpecialDayValuation.work_date >= effective_from,
            SpecialDayValuation.voided_at.is_(None),
            SpecialDayValuation.status == VALUATION_APPROVED,
        ).with_for_update()))
        changed = 0
        for row in rows:
            row.status = VALUATION_PENDING; row.preview_token = None; row.version += 1; changed += 1
        for period in periods:
            if period.status == PERIOD_CALCULATED:
                period.status = PERIOD_OPEN; period.inputs_fingerprint = None
        return changed

    @staticmethod
    def _assert_periods_mutable(periods: list[PayrollPeriod]) -> None:
        """A closed latest version is immutable; a rectification is the only path."""
        current_by_root: dict[uuid.UUID, PayrollPeriod] = {}
        for period in periods:
            current = current_by_root.get(period.root_period_id)
            if current is None or period.version > current.version:
                current_by_root[period.root_period_id] = period
        if any(period.status == PERIOD_CLOSED for period in current_by_root.values()):
            raise HTTPException(status_code=409, detail="PAYROLL_CLOSED_RECTIFICATION_REQUIRED")

    def _invalidate_dates(self, dates: list[date], employee_id: uuid.UUID | None = None) -> int:
        if not dates:
            return 0
        start, end = min(dates), max(dates)
        periods = list(self.db.scalars(select(PayrollPeriod).where(
            PayrollPeriod.start_date <= end, PayrollPeriod.end_date >= start,
        ).with_for_update()))
        self._assert_periods_mutable(periods)
        query = select(SpecialDayValuation).where(
            SpecialDayValuation.work_date.in_(dates), SpecialDayValuation.voided_at.is_(None),
        )
        if employee_id is not None:
            query = query.where(SpecialDayValuation.employee_id == employee_id)
        rows = list(self.db.scalars(query.with_for_update()))
        changed = 0
        for row in rows:
            if row.status == VALUATION_APPROVED:
                row.status = VALUATION_PENDING; row.preview_token = None; row.version += 1; changed += 1
        for period in periods:
            if period.status == PERIOD_CALCULATED:
                period.status = PERIOD_OPEN; period.inputs_fingerprint = None
        return changed

    def create_holiday(self, payload, actor: uuid.UUID) -> HolidayCalendarDay:
        current = self._holiday(payload.holiday_date)
        if current and current.scope == payload.scope:
            raise HTTPException(status_code=409, detail="El feriado ya está registrado para este ámbito")
        self._invalidate_dates([payload.holiday_date])
        holiday = HolidayCalendarDay(
            holiday_date=payload.holiday_date, name=payload.name.strip(), scope=payload.scope,
            day_kind=payload.day_kind, source=payload.source.strip(), effective_from=payload.holiday_date,
        )
        self.db.add(holiday); self.db.flush()
        AuditRepository(self.db).create(entity_type="holiday_calendar_day", entity_id=holiday.id, action="created",
            old_values=None, new_values={"holiday_date": str(holiday.holiday_date), "name": holiday.name,
            "scope": holiday.scope, "day_kind": holiday.day_kind}, reason=holiday.source,
            performed_by=actor, commit=False)
        self._commit(); self.db.refresh(holiday)
        return holiday

    def ensure_2026_national_holidays(self) -> int:
        """Carga local e idempotente del catálogo nacional peruano 2026."""
        holidays = [
            (date(2026, 1, 1), "Año Nuevo", "HOLIDAY"), (date(2026, 4, 2), "Jueves Santo", "HOLIDAY"),
            (date(2026, 4, 3), "Viernes Santo", "HOLIDAY"), (date(2026, 5, 1), "Día del Trabajo", "MAY_DAY"),
            (date(2026, 6, 7), "Día de la Bandera", "HOLIDAY"),
            (date(2026, 6, 29), "San Pedro y San Pablo", "HOLIDAY"), (date(2026, 7, 23), "Día de la Fuerza Aérea del Perú", "HOLIDAY"),
            (date(2026, 7, 28), "Fiestas Patrias", "HOLIDAY"), (date(2026, 7, 29), "Fiestas Patrias", "HOLIDAY"),
            (date(2026, 8, 6), "Batalla de Junín", "HOLIDAY"), (date(2026, 8, 30), "Santa Rosa de Lima", "HOLIDAY"),
            (date(2026, 10, 8), "Combate de Angamos", "HOLIDAY"), (date(2026, 11, 1), "Todos los Santos", "HOLIDAY"),
            (date(2026, 12, 8), "Inmaculada Concepción", "HOLIDAY"), (date(2026, 12, 9), "Batalla de Ayacucho", "HOLIDAY"),
            (date(2026, 12, 25), "Navidad", "HOLIDAY"),
        ]
        count = 0
        for holiday_date, name, kind in holidays:
            exists = self.db.scalar(select(HolidayCalendarDay.id).where(
                HolidayCalendarDay.holiday_date == holiday_date, HolidayCalendarDay.scope == "NATIONAL",
                HolidayCalendarDay.effective_to.is_(None),
            ))
            if not exists:
                self.db.add(HolidayCalendarDay(holiday_date=holiday_date, name=name, scope="NATIONAL", day_kind=kind, source="Calendario nacional Perú 2026", effective_from=holiday_date))
                count += 1
        if count: self.db.commit()
        return count

    def _same_week(self, original: date, value: datetime) -> bool:
        local = value.astimezone(lima_tz()).date() if value.tzinfo else value.date()
        return original - timedelta(days=original.weekday()) <= local <= original + timedelta(days=6-original.weekday())

    def propose_substitution(self, payload, actor: uuid.UUID):
        cached = self._receipt(payload.idempotency_key, payload, "propose_substitution", actor, payload.employee_id)
        if cached:
            return cached
        if payload.substitute_start.tzinfo is None or payload.substitute_end.tzinfo is None:
            raise HTTPException(status_code=422, detail="La sustitución debe incluir zona horaria de Lima")
        if payload.substitute_end - payload.substitute_start < timedelta(hours=24):
            raise HTTPException(status_code=422, detail="El descanso sustitutorio debe durar al menos 24 horas consecutivas")
        context = self.resolve_employee_day(payload.employee_id, payload.original_date)
        if payload.origin_kind == "WEEKLY_REST" and not context["weekly_rest"]:
            raise HTTPException(status_code=422, detail="La fecha origen no es un descanso semanal aplicable")
        if payload.origin_kind == "HOLIDAY" and not context["holiday"]:
            raise HTTPException(status_code=422, detail="La fecha origen no es un feriado aplicable")
        if payload.origin_kind == "WEEKLY_REST" and not self._same_week(payload.original_date, payload.substitute_start):
            raise HTTPException(status_code=422, detail="El descanso semanal sustitutorio debe disfrutarse en la misma semana lunes-domingo")
        item = RestSubstitution(employee_id=payload.employee_id, original_date=payload.original_date,
            origin_kind=payload.origin_kind,
            substitute_start=payload.substitute_start, substitute_end=payload.substitute_end,
            reference=payload.reference.strip(), reason=payload.reason.strip(), created_by_user_id=actor)
        self.db.add(item); self.db.flush()
        result = self.substitution_out(item)
        self._save_receipt(payload.idempotency_key, payload, "propose_substitution", actor, result, payload.employee_id)
        self._commit(); return result

    def _substitution(self, item_id: uuid.UUID, expected: int) -> RestSubstitution:
        item = self.db.scalar(select(RestSubstitution).where(RestSubstitution.id == item_id).with_for_update())
        if not item: raise HTTPException(status_code=404, detail="Sustitución no encontrada")
        if item.version != expected: raise HTTPException(status_code=409, detail="La sustitución fue modificada; actualice antes de continuar")
        return item

    def _substitution_dates(self, item: RestSubstitution) -> list[date]:
        start = item.substitute_start.astimezone(lima_tz()).date()
        end = item.substitute_end.astimezone(lima_tz()).date()
        return [item.original_date, *[start + timedelta(days=index) for index in range((end - start).days + 1)]]

    def _substitution_action(self, item_id: uuid.UUID, payload, actor: uuid.UUID, action: str):
        cached = self._receipt(payload.idempotency_key, payload, action, actor, item_id)
        if cached:
            return cached
        item = self._substitution(item_id, payload.expected_version)
        old_status = item.status
        if action == "approve_substitution":
            if item.status != SUBSTITUTION_PROPOSED: raise HTTPException(status_code=409, detail="Solo se pueden aprobar propuestas vigentes")
            self._invalidate_dates(self._substitution_dates(item), item.employee_id)
            item.status = SUBSTITUTION_APPROVED; item.approved_by_user_id = actor; item.approved_at = lima_now()
        elif action == "verify_substitution":
            if item.status != SUBSTITUTION_APPROVED: raise HTTPException(status_code=409, detail="Solo se puede verificar una sustitución aprobada")
            start_day = item.substitute_start.astimezone(lima_tz()).date(); end_day = item.substitute_end.astimezone(lima_tz()).date()
            attendance = self.db.scalar(select(AttendanceRecord.id).where(
                AttendanceRecord.employee_id == item.employee_id, AttendanceRecord.work_date >= start_day,
                AttendanceRecord.work_date <= end_day, AttendanceRecord.status.in_(("OPEN", "COMPLETE")),
            ))
            if attendance: raise HTTPException(status_code=409, detail="Hay trabajo incompatible dentro del descanso sustitutorio")
            manual_work = self.db.scalar(select(ManualAttendanceDay.id).where(
                ManualAttendanceDay.employee_id == item.employee_id,
                ManualAttendanceDay.work_date >= start_day, ManualAttendanceDay.work_date <= end_day,
                ManualAttendanceDay.voided_at.is_(None), ManualAttendanceDay.worked_minutes_net > 0,
            ))
            if manual_work:
                raise HTTPException(status_code=409, detail="Hay carga administrativa incompatible dentro del descanso sustitutorio")
            if not payload.evidence: raise HTTPException(status_code=422, detail="La verificación requiere evidencia administrativa")
            self._invalidate_dates(self._substitution_dates(item), item.employee_id)
            item.status = SUBSTITUTION_ENJOYED; item.evidence = payload.evidence
        elif action == "cancel_substitution":
            if item.status in (SUBSTITUTION_CANCELLED, SUBSTITUTION_INVALIDATED): raise HTTPException(status_code=409, detail="La sustitución ya no está vigente")
            self._invalidate_dates(self._substitution_dates(item), item.employee_id)
            item.status = SUBSTITUTION_CANCELLED; item.cancelled_at = lima_now()
        else:  # pragma: no cover - internal guard
            raise RuntimeError(f"Acción desconocida: {action}")
        item.version += 1
        AuditRepository(self.db).create(entity_type="rest_substitution", entity_id=item.id, action=action,
            old_values={"status": old_status}, new_values={"status": item.status, "version": item.version},
            reason=payload.reason, performed_by=actor, commit=False)
        result = self.substitution_out(item)
        self._save_receipt(payload.idempotency_key, payload, action, actor, result, item.id)
        self._commit()
        return result

    def approve_substitution(self, item_id: uuid.UUID, payload, actor: uuid.UUID):
        return self._substitution_action(item_id, payload, actor, "approve_substitution")

    def verify_substitution(self, item_id: uuid.UUID, payload, actor: uuid.UUID):
        return self._substitution_action(item_id, payload, actor, "verify_substitution")

    def cancel_substitution(self, item_id: uuid.UUID, payload, actor: uuid.UUID):
        return self._substitution_action(item_id, payload, actor, "cancel_substitution")

    def resolve_employee_day(self, employee_id: uuid.UUID, day: date) -> dict:
        return self.resolve_employee_range(employee_id, day, day)[0]

    def resolve_employee_range(self, employee_id: uuid.UUID, date_from: date, date_to: date) -> list[dict]:
        if date_to < date_from or (date_to-date_from).days > 366:
            raise HTTPException(status_code=422, detail="Rango de calendario inválido")
        days = [date_from + timedelta(days=i) for i in range((date_to-date_from).days + 1)]
        # Resolver en lote evita N consultas por día desde agenda, saldo y
        # reportes. La selección histórica se conserva en memoria.
        rules = list(self.db.scalars(select(EmployeeWeeklyRestRule).where(
            EmployeeWeeklyRestRule.employee_id == employee_id,
            EmployeeWeeklyRestRule.effective_from <= date_to,
            (EmployeeWeeklyRestRule.effective_to.is_(None)) | (EmployeeWeeklyRestRule.effective_to >= date_from),
        ).order_by(EmployeeWeeklyRestRule.effective_from.desc(), EmployeeWeeklyRestRule.version.desc())))
        holidays = list(self.db.scalars(select(HolidayCalendarDay).where(
            HolidayCalendarDay.holiday_date >= date_from, HolidayCalendarDay.holiday_date <= date_to,
            HolidayCalendarDay.effective_from <= date_to,
            (HolidayCalendarDay.effective_to.is_(None)) | (HolidayCalendarDay.effective_to >= date_from),
        ).order_by(HolidayCalendarDay.holiday_date, HolidayCalendarDay.version.desc())))
        holiday_by_day: dict[date, HolidayCalendarDay] = {}
        for holiday in holidays:
            if holiday.holiday_date not in holiday_by_day and holiday.effective_from <= holiday.holiday_date and (holiday.effective_to is None or holiday.effective_to >= holiday.holiday_date):
                holiday_by_day[holiday.holiday_date] = holiday
        expected = ScheduleService(self.db).expected_minutes_for_days({employee_id: days})
        result = []
        for day in days:
            rule = next((item for item in rules if item.effective_from <= day and (item.effective_to is None or item.effective_to >= day)), None)
            holiday = holiday_by_day.get(day)
            scheduled = expected[(employee_id, day)]
            weekly_rest = bool(rule and rule.weekly_rest_weekday == day.weekday())
            is_holiday = holiday is not None and holiday.day_kind != "COMPENSABLE"
            # A special-day price cannot be derived from an invented one-minute
            # day.  Normal schedule consumers may still see zero scheduled time.
            reference = rule.reference_daily_minutes if rule else (scheduled if scheduled > 0 else None)
            result.append({"employee_id": str(employee_id), "work_date": day, "scheduled_minutes": scheduled,
                "attendance_obligation_minutes": 0 if weekly_rest or is_holiday else scheduled,
                "reference_daily_minutes": reference, "weekly_rest": weekly_rest,
                "holiday": self._holiday_out(holiday), "holiday_unverified": day.year > 2026 and holiday is None})
        return result

    @staticmethod
    def _holiday_out(item: HolidayCalendarDay | None) -> dict | None:
        if not item: return None
        return {"id": str(item.id), "name": item.name, "scope": item.scope, "day_kind": item.day_kind, "source": item.source, "version": item.version}


class SpecialDayValuationService:
    def __init__(self, db: Session):
        self.db = db; self.calendar = WorkCalendarService(db)

    def _source_kind(self, context: dict, requested: str | None) -> str:
        holiday = context["holiday"]
        available = []
        if context["weekly_rest"]: available.append("WEEKLY_REST")
        if holiday:
            available.append("MAY_DAY_COINCIDENCE" if holiday["day_kind"] == "MAY_DAY" else "HOLIDAY")
        if requested:
            if requested not in available: raise HTTPException(status_code=422, detail="La clasificación especial no corresponde a la fecha")
            return requested
        if not available: raise HTTPException(status_code=422, detail="La fecha no tiene descanso semanal ni feriado aplicable")
        # May Day preserves its special legal treatment when it coincides.
        return "MAY_DAY_COINCIDENCE" if "MAY_DAY_COINCIDENCE" in available else available[0]

    def _enjoyed_substitution(self, employee_id: uuid.UUID, day: date) -> RestSubstitution | None:
        return self.db.scalar(select(RestSubstitution).where(RestSubstitution.employee_id == employee_id,
            RestSubstitution.original_date == day, RestSubstitution.status == SUBSTITUTION_ENJOYED).order_by(RestSubstitution.created_at.desc()))

    @staticmethod
    def _components_for(source_kind: str, known_minutes: int, reference: int, monthly_salary: Decimal,
                        daily: Decimal, substituted: RestSubstitution | None) -> tuple[Decimal, list[tuple[str, int, Decimal]]]:
        """Componentes visibles de una valoración especial.

        Fuente única de ``preview`` y de la actualización automática: toda
        valoración parte de los minutos netos ya consolidados (un solo
        refrigerio, HE valoradas aparte), de modo que un cambio de horas o de
        refrigerio nunca se descuenta ni se computa dos veces.
        """
        components: list[tuple[str, int, Decimal]] = []
        if substituted:
            amount = Decimal("0.00"); components.append(("SUBSTITUTED_REST", 0, amount))
        elif source_kind == "MAY_DAY_COINCIDENCE":
            paid = daily
            work_extra = daily * Decimal(2) * Decimal(known_minutes) / Decimal(reference)
            amount = paid + work_extra
            components = [("MAY_DAY_PAID", 0, paid), ("MAY_DAY_WORK", known_minutes, work_extra)]
        else:
            # Descanso semanal o feriado trabajado sin sustituto: la labor más
            # la sobretasa del 100% (D.L. 713, art. 3).
            labor = daily * Decimal(known_minutes) / Decimal(reference)
            amount = double_days_value(monthly_salary, known_minutes, reference)
            prefix = "HOLIDAY" if source_kind == "HOLIDAY" else "WEEKLY_REST"
            components = [(f"{prefix}_WORK", known_minutes, labor), (f"{prefix}_SURCHARGE", known_minutes, labor)]
        return amount.quantize(_CENTS, rounding=ROUND_HALF_UP), components

    @staticmethod
    def _calculation_payload(salary, daily: Decimal, known_minutes: int, worked: int, reference: int,
                             substituted: RestSubstitution | None, context: dict) -> dict:
        return {"monthly_salary": str(salary.monthly_salary),
            "daily_amount": str(daily.quantize(_CENTS, rounding=ROUND_HALF_UP)),
            "known_minutes": known_minutes, "excess_minutes": max(worked - reference, 0),
            "substitution_id": str(substituted.id) if substituted else None,
            "context": json.loads(json.dumps(context, default=str))}

    @staticmethod
    def _rounded_components(components: list[tuple[str, int, Decimal]], amount: Decimal) -> list[tuple[str, int, Decimal]]:
        # Round the total once.  The final component receives the stable
        # residual so visible components always reconcile with the total.
        rounded = [(kind, minutes, value.quantize(_CENTS, rounding=ROUND_HALF_UP)) for kind, minutes, value in components]
        if rounded:
            kind, minutes, value = rounded[-1]
            rounded[-1] = (kind, minutes, value + amount - sum(item[2] for item in rounded))
        return rounded

    def _write_components(self, row: SpecialDayValuation, components: list[tuple[str, int, Decimal]], amount: Decimal) -> None:
        for kind, minutes, value in self._rounded_components(components, amount):
            self.db.add(SpecialDayValuationComponent(valuation_id=row.id, component_kind=kind, minutes=minutes, amount=value))

    def _valuation_is_current(self, row: SpecialDayValuation, *, worked: int, reference: int, amount: Decimal,
                              calculation: dict, components: list[tuple[str, int, Decimal]]) -> bool:
        """¿La fila ya refleja exactamente estos insumos monetarios?

        Un cambio que no altera el neto (por ejemplo, solo ``notes``) no debe
        incrementar la versión, renovar el token ni invalidar una aprobación.
        """
        if (row.worked_minutes != worked or row.reference_daily_minutes != reference
                or row.amount != amount or row.calculation != calculation):
            return False
        current = sorted(((c.component_kind, c.minutes, c.amount) for c in row.components), key=lambda item: item[0])
        expected = sorted(self._rounded_components(components, amount), key=lambda item: item[0])
        return current == expected

    def recompute_for_day(self, employee_id: uuid.UUID, work_date: date) -> int:
        """Actualiza las valoraciones especiales vigentes tras cambiar los minutos.

        Los minutos netos ya vienen consolidados por asistencia, así que esta
        actualización solo reescribe las valoraciones del mismo empleado/día:
        una PENDING se recalcula, una APPROVED se invalida a PENDING con token
        nuevo si su planilla sigue abierta y, si el periodo está cerrado, la
        operación se rechaza para no tocar el pago cerrado en silencio.
        """
        rows = list(self.db.scalars(select(SpecialDayValuation).where(
            SpecialDayValuation.employee_id == employee_id,
            SpecialDayValuation.work_date == work_date,
            SpecialDayValuation.voided_at.is_(None),
        ).with_for_update()))
        if not rows:
            return 0
        context = self.calendar.resolve_employee_day(employee_id, work_date)
        reference = context["reference_daily_minutes"]
        if reference is None or reference <= 0:
            return 0
        salary = SalaryService(self.db).get_for_date(employee_id, work_date)
        if salary is None:
            return 0
        worked = worked_minutes(self.db, employee_id, work_date, work_date)
        daily = daily_value(salary.monthly_salary)
        substituted = self._enjoyed_substitution(employee_id, work_date)
        calculation = self._calculation_payload(salary, daily, worked, worked, reference, substituted, context)
        # Solo las filas cuyos insumos monetarios cambiaron se reescriben.  Un
        # cambio que no altera el neto conserva versión, token y aprobación.
        pending_updates = []
        for row in rows:
            amount, components = self._components_for(
                row.source_kind, worked, reference, salary.monthly_salary, daily, substituted
            )
            if self._valuation_is_current(
                row, worked=worked, reference=reference, amount=amount,
                calculation=calculation, components=components,
            ):
                continue
            pending_updates.append((row, amount, components))
        if not pending_updates:
            return 0
        originals = {row.id: row.status for row, _amount, _components in pending_updates}
        if any(status == VALUATION_APPROVED for status in originals.values()):
            # Reabre periodos CALCULATED o exige rectificación si están cerrados.
            self.calendar._invalidate_dates([work_date], employee_id)
        for row, amount, components in pending_updates:
            row.worked_minutes = worked
            row.reference_daily_minutes = reference
            row.amount = amount
            if originals[row.id] != VALUATION_APPROVED:
                # Una aprobada ya fue invalidada (version+1) por _invalidate_dates.
                row.version += 1
            row.status = VALUATION_PENDING
            row.approved_by_user_id = None
            row.approved_at = None
            row.preview_token = secrets.token_urlsafe(32)
            row.calculation = calculation
            for comp in list(row.components):
                self.db.delete(comp)
            self.db.flush()
            self._write_components(row, components, amount)
        self.db.flush()
        return len(pending_updates)

    def preview(self, employee_id: uuid.UUID, work_date: date, requested_kind: str | None, actor: uuid.UUID | None = None) -> SpecialDayValuation:
        context = self.calendar.resolve_employee_day(employee_id, work_date)
        source_kind = self._source_kind(context, requested_kind)
        salary = SalaryService(self.db).get_for_date(employee_id, work_date)
        if salary is None: raise HTTPException(status_code=422, detail="MISSING_SALARY")
        worked = worked_minutes(self.db, employee_id, work_date, work_date)
        reference = context["reference_daily_minutes"]
        if reference is None or reference <= 0:
            raise HTTPException(status_code=422, detail="REFERENCE_JOURNEY_REQUIRED")
        # Todas las horas netas trabajadas se valoran: la jornada de referencia
        # fija el valor hora, no topa el descanso ni el feriado (D.L. 713, art. 3).
        known_minutes = worked
        # Valor día legal = sueldo / 30 (D.S. 012-92-TR, art. 2). El divisor es
        # fijo: no cambia si el mes tiene 28, 29, 30 o 31 días.
        daily = daily_value(salary.monthly_salary)
        substituted = self._enjoyed_substitution(employee_id, work_date)
        amount, components = self._components_for(
            source_kind, known_minutes, reference, salary.monthly_salary, daily, substituted
        )
        # Pagar por encima de la jornada de referencia ya no exige revisión: son
        # horas netas efectivamente trabajadas y valoradas a sobretasa del 100%.
        status_value = VALUATION_PENDING
        old = self.db.scalar(select(SpecialDayValuation).where(SpecialDayValuation.employee_id == employee_id,
            SpecialDayValuation.work_date == work_date, SpecialDayValuation.source_kind == source_kind,
            SpecialDayValuation.voided_at.is_(None)).with_for_update())
        if old and old.status == VALUATION_APPROVED:
            # Approved evidence is immutable; a new preview needs an explicit void/review instead.
            raise HTTPException(status_code=409, detail="La valoración aprobada requiere una rectificación antes de cambiarla")
        if old is None:
            old = SpecialDayValuation(employee_id=employee_id, work_date=work_date, source_kind=source_kind,
                worked_minutes=worked, reference_daily_minutes=reference, amount=amount, status=status_value,
                calculation={}, created_by_user_id=actor)
            self.db.add(old); self.db.flush()
        else:
            old.worked_minutes = worked; old.reference_daily_minutes = reference; old.amount = amount; old.status = status_value; old.version += 1
            for comp in list(old.components): self.db.delete(comp)
            self.db.flush()
        old.preview_token = secrets.token_urlsafe(32)
        old.calculation = self._calculation_payload(salary, daily, known_minutes, worked, reference, substituted, context)
        self._write_components(old, components, amount)
        self.db.commit(); self.db.refresh(old); return old

    def get(self, valuation_id: uuid.UUID) -> SpecialDayValuation:
        item = self.db.scalar(select(SpecialDayValuation).options(selectinload(SpecialDayValuation.components)).where(SpecialDayValuation.id == valuation_id))
        if not item: raise HTTPException(status_code=404, detail="Valoración especial no encontrada")
        return item

    def approve(self, valuation_id: uuid.UUID, *, payload=None, expected_version: int | None = None,
                preview_token: str | None = None, actor: uuid.UUID, reason: str | None = None):
        if payload is not None:
            expected_version, preview_token, reason = payload.expected_version, payload.preview_token, payload.reason
            idempotency_key = payload.idempotency_key
        else:
            if expected_version is None or preview_token is None or reason is None:
                raise TypeError("approve requiere preview y motivo")
            idempotency_key = f"legacy-approve-{valuation_id}-{expected_version}"
        receipt = self.calendar._receipt(idempotency_key, payload or {
            "expected_version": expected_version, "preview_token": preview_token, "reason": reason,
        }, "approve_special_day_valuation", actor, valuation_id)
        if receipt:
            return receipt
        item = self.db.scalar(select(SpecialDayValuation).where(SpecialDayValuation.id == valuation_id).with_for_update())
        if not item: raise HTTPException(status_code=404, detail="Valoración especial no encontrada")
        if item.version != expected_version or item.preview_token != preview_token:
            raise HTTPException(status_code=409, detail="La previsualización está desactualizada")
        if item.status == VALUATION_REVIEW_REQUIRED:
            raise HTTPException(status_code=409, detail="SPECIAL_DAY_OVERTIME_REVIEW_REQUIRED")
        if item.status != VALUATION_PENDING: raise HTTPException(status_code=409, detail="La valoración no está pendiente de aprobación")
        # Approval changes the payroll input: reopen calculated descendants first,
        # while this valuation is still pending and therefore not invalidated itself.
        self.calendar._invalidate_dates([item.work_date], item.employee_id)
        item.status = VALUATION_APPROVED; item.approved_by_user_id = actor; item.approved_at = lima_now(); item.preview_token = None; item.version += 1
        AuditRepository(self.db).create(entity_type="special_day_valuation", entity_id=item.id, action="approved",
            old_values={"status": VALUATION_PENDING}, new_values={"status": VALUATION_APPROVED, "amount": str(item.amount)}, reason=reason, performed_by=actor, commit=False)
        result = self.out(item)
        self.calendar._save_receipt(idempotency_key, payload or {
            "expected_version": expected_version, "preview_token": preview_token, "reason": reason,
        }, "approve_special_day_valuation", actor, result, valuation_id)
        self.calendar._commit()
        return self.calendar._immutable(result)

    def reconcile_existing_payment(self, valuation_id: uuid.UUID, *, payload=None, expected_version: int | None = None,
                                   reference: str | None = None, actor: uuid.UUID):
        if payload is not None:
            expected_version, reference = payload.expected_version, payload.reference
            idempotency_key = payload.idempotency_key
        else:
            if expected_version is None or reference is None:
                raise TypeError("reconcile_existing_payment requiere referencia")
            idempotency_key = f"legacy-reconcile-{valuation_id}-{expected_version}"
        receipt = self.calendar._receipt(idempotency_key, payload or {
            "expected_version": expected_version, "reference": reference,
        }, "reconcile_special_day_valuation", actor, valuation_id)
        if receipt:
            return receipt
        item = self.db.scalar(select(SpecialDayValuation).options(selectinload(SpecialDayValuation.components)).where(
            SpecialDayValuation.id == valuation_id).with_for_update())
        if not item: raise HTTPException(status_code=404, detail="Valoración especial no encontrada")
        if item.version != expected_version: raise HTTPException(status_code=409, detail="La valoración fue modificada")
        # A reconciliation is auditable evidence; it never guesses that a legacy payment covered this amount.
        old_status = item.status
        self.calendar._invalidate_dates([item.work_date], item.employee_id)
        item.status = VALUATION_VOIDED; item.voided_at = lima_now(); item.void_reason = f"Conciliado: {reference}"; item.version += 1
        AuditRepository(self.db).create(entity_type="special_day_valuation", entity_id=item.id, action="reconciled",
            old_values={"status": old_status}, new_values={"status": VALUATION_VOIDED, "reference": reference},
            reason=reference, performed_by=actor, commit=False)
        result = self.out(item)
        self.calendar._save_receipt(idempotency_key, payload or {
            "expected_version": expected_version, "reference": reference,
        }, "reconcile_special_day_valuation", actor, result, valuation_id)
        self.calendar._commit()
        return self.calendar._immutable(result)

    @staticmethod
    def out(item: SpecialDayValuation) -> dict:
        return {"id": str(item.id), "employee_id": str(item.employee_id), "work_date": item.work_date.isoformat(),
            "source_kind": item.source_kind, "status": item.status, "worked_minutes": item.worked_minutes,
            "reference_daily_minutes": item.reference_daily_minutes, "amount": str(item.amount), "version": item.version,
            "preview_token": item.preview_token, "calculation": item.calculation,
            "components": [{"component_kind": c.component_kind, "minutes": c.minutes, "amount": str(c.amount), "details": c.details} for c in item.components]}
