"""Regresiones de atomicidad al cambiar sueldo/jornada.

Un cambio de sueldo o de jornada crea/cierra vigencias, invalida valoraciones
dependientes y escribe auditoría.  Todo debe confirmarse en una sola
transacción: si la invalidación rechaza la operación (p. ej. un periodo de
planilla cerrado exige rectificación) o falla cualquier escritura, el estado
anterior queda intacto.
"""

import uuid
from datetime import date
from decimal import Decimal

import pytest

from app.modules.audit.models import AuditLog
from app.modules.audit.repository import AuditRepository
from app.modules.payroll.models import PERIOD_CALCULATED, PERIOD_CLOSED, PayrollPeriod
from app.modules.salary.models import SalarySetting
from app.modules.schedules.models import WorkSchedule
from app.modules.work_calendar.models import (
    VALUATION_APPROVED,
    VALUATION_PENDING,
    SpecialDayValuation,
)


def _login(client) -> None:
    response = client.post(
        "/api/v1/auth/login", json={"username": "admin", "password": "Admin123!"}
    )
    assert response.status_code == 200, response.text


def _create_employee(client, job_role_id: str) -> str:
    response = client.post(
        "/api/v1/employees",
        json={
            "dni": "72845632",
            "employee_code": "EMP-001",
            "first_name": "Juan",
            "last_name": "Pérez",
            "job_role_id": job_role_id,
        },
    )
    assert response.status_code == 201, response.text
    return response.json()["id"]


def _closed_period(db_session, start: date, end: date) -> PayrollPeriod:
    """Periodo de planilla cerrado (versión única y vigente de su raíz)."""
    period = PayrollPeriod(
        name="Periodo cerrado",
        start_date=start,
        end_date=end,
        status=PERIOD_CLOSED,
        root_period_id=uuid.uuid4(),
        version=1,
    )
    db_session.add(period)
    db_session.commit()
    return period


def _calculated_period(db_session, start: date, end: date) -> PayrollPeriod:
    period = PayrollPeriod(
        name="Periodo calculado", start_date=start, end_date=end,
        status=PERIOD_CALCULATED, inputs_fingerprint="a" * 64,
        root_period_id=uuid.uuid4(), version=1,
    )
    db_session.add(period)
    db_session.commit()
    return period


def _approved_valuation(db_session, employee_id: uuid.UUID) -> SpecialDayValuation:
    valuation = SpecialDayValuation(
        employee_id=employee_id, work_date=date(2026, 9, 15),
        source_kind="HOLIDAY", status=VALUATION_APPROVED,
        worked_minutes=300, reference_daily_minutes=300, amount=Decimal("50.00"),
        preview_token="p" * 64, version=1,
    )
    db_session.add(valuation)
    db_session.commit()
    return valuation


def _raise_late_audit_failure(*args, **kwargs):
    raise RuntimeError("audit storage unavailable")


# --- Sueldo ---


def test_set_salary_rolls_back_when_closed_period_requires_rectification(client, db_session):
    _login(client)
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))

    first = client.post(
        f"/api/v1/employees/{emp}/salary-settings",
        json={"effective_from": "2026-08-01", "monthly_salary": "1300.00"},
    )
    assert first.status_code == 201, first.text
    _closed_period(db_session, date(2026, 9, 1), date(2026, 9, 30))

    response = client.post(
        f"/api/v1/employees/{emp}/salary-settings",
        json={"effective_from": "2026-09-01", "monthly_salary": "1500.00"},
    )
    assert response.status_code == 409, response.text
    assert response.json()["detail"] == "PAYROLL_CLOSED_RECTIFICATION_REQUIRED"

    # La vigencia anterior sigue intacta: ni se creó la nueva ni se cerró la previa.
    rows = db_session.query(SalarySetting).filter(SalarySetting.employee_id == uuid.UUID(emp)).all()
    assert len(rows) == 1
    assert rows[0].monthly_salary == Decimal("1300.00")
    assert rows[0].effective_from == date(2026, 8, 1)
    assert rows[0].effective_to is None

    # Tampoco se registró auditoría de un cambio que nunca se confirmó.
    assert (
        db_session.query(AuditLog).filter(AuditLog.action == "set_salary").count() == 1
    )


def test_set_salary_success_commits_vigencia_invalidation_and_audit(client, db_session):
    _login(client)
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))
    employee_uuid = uuid.UUID(emp)

    first = client.post(
        f"/api/v1/employees/{emp}/salary-settings",
        json={"effective_from": "2026-08-01", "monthly_salary": "1300.00"},
    )
    assert first.status_code == 201, first.text

    # Valoración aprobada que el nuevo sueldo debe volver a PENDING.
    valuation = SpecialDayValuation(
        employee_id=employee_uuid,
        work_date=date(2026, 9, 15),
        source_kind="HOLIDAY",
        status=VALUATION_APPROVED,
        worked_minutes=300,
        reference_daily_minutes=300,
        amount=Decimal("50.00"),
        version=1,
    )
    db_session.add(valuation)
    db_session.commit()

    response = client.post(
        f"/api/v1/employees/{emp}/salary-settings",
        json={"effective_from": "2026-09-01", "monthly_salary": "1500.00"},
    )
    assert response.status_code == 201, response.text
    assert response.json()["monthly_salary"] == "1500.00"
    assert response.json()["effective_to"] is None

    rows = (
        db_session.query(SalarySetting)
        .filter(SalarySetting.employee_id == employee_uuid)
        .order_by(SalarySetting.effective_from)
        .all()
    )
    assert len(rows) == 2
    assert rows[0].effective_to == date(2026, 8, 31)  # anterior cerrada
    assert rows[1].effective_from == date(2026, 9, 1)
    assert rows[1].effective_to is None

    # La invalidación de la valoración aprobada quedó confirmada en el mismo commit.
    db_session.refresh(valuation)
    assert valuation.status == VALUATION_PENDING
    assert valuation.version == 2

    # La auditoría sí se registró para el cambio confirmado.
    assert (
        db_session.query(AuditLog).filter(AuditLog.action == "set_salary").count() == 2
    )


def test_set_salary_rolls_back_everything_when_audit_fails_late(client, db_session, monkeypatch):
    _login(client)
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))
    employee_uuid = uuid.UUID(emp)
    assert client.post(
        f"/api/v1/employees/{emp}/salary-settings",
        json={"effective_from": "2026-08-01", "monthly_salary": "1300.00"},
    ).status_code == 201
    valuation = _approved_valuation(db_session, employee_uuid)
    period = _calculated_period(db_session, date(2026, 9, 1), date(2026, 9, 30))
    monkeypatch.setattr(AuditRepository, "create", _raise_late_audit_failure)

    with pytest.raises(RuntimeError, match="audit storage unavailable"):
        client.post(
            f"/api/v1/employees/{emp}/salary-settings",
            json={"effective_from": "2026-09-01", "monthly_salary": "1500.00"},
        )

    db_session.expire_all()
    rows = db_session.query(SalarySetting).filter(SalarySetting.employee_id == employee_uuid).all()
    assert len(rows) == 1 and rows[0].effective_to is None
    assert rows[0].monthly_salary == Decimal("1300.00")
    assert db_session.get(SpecialDayValuation, valuation.id).status == VALUATION_APPROVED
    assert db_session.get(SpecialDayValuation, valuation.id).version == 1
    restored_period = db_session.get(PayrollPeriod, period.id)
    assert restored_period.status == PERIOD_CALCULATED
    assert restored_period.inputs_fingerprint == "a" * 64
    assert db_session.query(AuditLog).filter(AuditLog.action == "set_salary").count() == 1


# --- Jornada ---


def test_set_schedule_rolls_back_when_closed_period_requires_rectification(client, db_session):
    _login(client)
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))

    first = client.post(
        f"/api/v1/employees/{emp}/schedule",
        json={"effective_from": "2026-08-01", "monday_minutes": 480},
    )
    assert first.status_code == 201, first.text
    _closed_period(db_session, date(2026, 9, 1), date(2026, 9, 30))

    response = client.post(
        f"/api/v1/employees/{emp}/schedule",
        json={"effective_from": "2026-09-01", "monday_minutes": 360},
    )
    assert response.status_code == 409, response.text
    assert response.json()["detail"] == "PAYROLL_CLOSED_RECTIFICATION_REQUIRED"

    rows = db_session.query(WorkSchedule).filter(WorkSchedule.employee_id == uuid.UUID(emp)).all()
    assert len(rows) == 1
    assert rows[0].monday_minutes == 480
    assert rows[0].effective_from == date(2026, 8, 1)
    assert rows[0].effective_to is None

    assert (
        db_session.query(AuditLog).filter(AuditLog.action == "set_schedule").count() == 1
    )


def test_set_schedule_success_is_atomic_and_audited(client, db_session):
    _login(client)
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))
    employee_uuid = uuid.UUID(emp)

    first = client.post(
        f"/api/v1/employees/{emp}/schedule",
        json={"effective_from": "2026-08-01", "monday_minutes": 480},
    )
    assert first.status_code == 201, first.text

    response = client.post(
        f"/api/v1/employees/{emp}/schedule",
        json={"effective_from": "2026-09-01", "monday_minutes": 360},
    )
    assert response.status_code == 201, response.text
    assert response.json()["effective_to"] is None

    rows = (
        db_session.query(WorkSchedule)
        .filter(WorkSchedule.employee_id == employee_uuid)
        .order_by(WorkSchedule.effective_from)
        .all()
    )
    assert len(rows) == 2
    assert rows[0].effective_to == date(2026, 8, 31)
    assert rows[1].monday_minutes == 360
    assert rows[1].effective_to is None

    assert (
        db_session.query(AuditLog).filter(AuditLog.action == "set_schedule").count() == 2
    )


def test_set_schedule_rolls_back_everything_when_audit_fails_late(client, db_session, monkeypatch):
    _login(client)
    emp = _create_employee(client, str(db_session._test_job_roles["Operario"]))
    employee_uuid = uuid.UUID(emp)
    assert client.post(
        f"/api/v1/employees/{emp}/schedule",
        json={"effective_from": "2026-08-01", "monday_minutes": 480},
    ).status_code == 201
    valuation = _approved_valuation(db_session, employee_uuid)
    period = _calculated_period(db_session, date(2026, 9, 1), date(2026, 9, 30))
    monkeypatch.setattr(AuditRepository, "create", _raise_late_audit_failure)

    with pytest.raises(RuntimeError, match="audit storage unavailable"):
        client.post(
            f"/api/v1/employees/{emp}/schedule",
            json={"effective_from": "2026-09-01", "monday_minutes": 360},
        )

    db_session.expire_all()
    rows = db_session.query(WorkSchedule).filter(WorkSchedule.employee_id == employee_uuid).all()
    assert len(rows) == 1 and rows[0].effective_to is None
    assert rows[0].monday_minutes == 480
    assert db_session.get(SpecialDayValuation, valuation.id).status == VALUATION_APPROVED
    assert db_session.get(SpecialDayValuation, valuation.id).version == 1
    restored_period = db_session.get(PayrollPeriod, period.id)
    assert restored_period.status == PERIOD_CALCULATED
    assert restored_period.inputs_fingerprint == "a" * 64
    assert db_session.query(AuditLog).filter(AuditLog.action == "set_schedule").count() == 1
