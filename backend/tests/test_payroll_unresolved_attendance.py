"""Bloqueo de cierre por jornadas pasadas sin resolución administrativa.

Reglas cubiertas (UNRESOLVED_ATTENDANCE_DAY):

- Una fecha anterior al día de reporte (Lima), dentro de la relación laboral y
  con jornada esperada > 0, sin asistencia, carga histórica activa, permiso ni
  recuperación registrados, bloquea readiness y el cierre (confirm).
- Se considera resuelta con asistencia OPEN/COMPLETE, carga histórica activa,
  permiso o recuperación aprobados, o un compromiso de recuperación registrado.
- Descanso (jornada esperada 0) y fechas de hoy/futuro no bloquean.
- El bloqueo expone la fecha (``work_date``) y la incluye en el mensaje.

No se clasifica la ausencia como falta, no se descuenta dinero y no se altera
la base salarial: solo se exige registrar la resolución antes de cerrar.
"""

import uuid
from datetime import date, datetime, timezone
from decimal import Decimal

from sqlalchemy import select

import app.modules.payroll.service as payroll_service
from app.modules.adjustments.models import HourAdjustment
from app.modules.attendance.manual_models import ManualAttendanceDay, RecoveryCommitment
from app.modules.attendance.models import AttendanceRecord
from app.modules.users.models import User

REPORT_TODAY = date(2026, 8, 5)
MONDAY = "2026-08-03"
TUESDAY = "2026-08-04"


def _login(client) -> None:
    response = client.post("/api/v1/auth/login", json={"username": "admin", "password": "Admin123!"})
    assert response.status_code == 200, response.text


def _admin_id(db_session) -> uuid.UUID:
    admin_id = db_session.scalar(select(User.id).where(User.username == "admin"))
    assert admin_id is not None
    return admin_id


def _create_employee(client, job_role_id: str) -> str:
    response = client.post(
        "/api/v1/employees",
        json={
            "dni": "72845632",
            "employee_code": "EMP-UNRES",
            "first_name": "Juan",
            "last_name": "Pérez",
            "job_role_id": job_role_id,
        },
    )
    assert response.status_code == 201, response.text
    return response.json()["id"]


def _set_salary(client, employee_id: str) -> None:
    assert client.post(
        f"/api/v1/employees/{employee_id}/salary-settings",
        json={"effective_from": "2026-08-01", "monthly_salary": "1500.00", "overtime_enabled": True},
    ).status_code == 201
    assert client.post(
        f"/api/v1/employees/{employee_id}/schedule",
        json={
            "effective_from": "2026-08-01",
            "monday_minutes": 480,
            "tuesday_minutes": 480,
            "wednesday_minutes": 480,
            "thursday_minutes": 480,
            "friday_minutes": 480,
            "break_minutes": 60,
            "break_applies_after_minutes": 360,
        },
    ).status_code == 201


def _create_period(client) -> dict:
    response = client.post("/api/v1/payroll/periods", json={"year": 2026, "month": 8})
    assert response.status_code == 201, response.text
    return response.json()


def _calculate(client, period_id: str) -> None:
    response = client.post(f"/api/v1/payroll/periods/{period_id}/calculate")
    assert response.status_code == 200, response.text


def _readiness(client, period_id: str) -> dict:
    response = client.get(f"/api/v1/payroll/periods/{period_id}/readiness")
    assert response.status_code == 200, response.text
    return response.json()


def _unresolved_dates(readiness: dict) -> list[str]:
    return sorted(
        issue["work_date"]
        for issue in readiness["blockers"]
        if issue["code"] == "UNRESOLVED_ATTENDANCE_DAY"
    )


def _add_complete_attendance(db_session, employee_id: str, work_date: str) -> None:
    day = date.fromisoformat(work_date)
    db_session.add(
        AttendanceRecord(
            employee_id=uuid.UUID(employee_id),
            work_date=day,
            check_in_at=datetime(day.year, day.month, day.day, 13, tzinfo=timezone.utc),
            check_out_at=datetime(day.year, day.month, day.day, 21, tzinfo=timezone.utc),
            worked_minutes=480,
            status="COMPLETE",
        )
    )
    db_session.commit()


def _add_manual_load(db_session, employee_id: str, work_date: str) -> None:
    db_session.add(
        ManualAttendanceDay(
            employee_id=uuid.UUID(employee_id),
            work_date=date.fromisoformat(work_date),
            worked_minutes_net=480,
            normal_minutes=480,
            additional_minutes=0,
            recovery_minutes=0,
            reason="Carga histórica de la jornada",
            payment_status="NOT_APPLICABLE",
            version=1,
            created_by_user_id=_admin_id(db_session),
        )
    )
    db_session.commit()


def _add_approved_adjustment(db_session, employee_id: str, work_date: str, adjustment_type: str, minutes: int) -> None:
    db_session.add(
        HourAdjustment(
            employee_id=uuid.UUID(employee_id),
            adjustment_date=date.fromisoformat(work_date),
            minutes=minutes,
            adjustment_type=adjustment_type,
            reason=f"{adjustment_type} aprobado",
            status="APPROVED",
            version=1,
        )
    )
    db_session.commit()


def _add_recovery_commitment(db_session, employee_id: str, permission_date: str) -> None:
    db_session.add(
        RecoveryCommitment(
            employee_id=uuid.UUID(employee_id),
            permission_date=date.fromisoformat(permission_date),
            agreed_minutes=480,
            covered_before=False,
            reference="Permiso registrado en acta",
            status="ACTIVE",
            created_by_user_id=_admin_id(db_session),
        )
    )
    db_session.commit()


def _setup(client, db_session, monkeypatch, today: date = REPORT_TODAY) -> tuple[str, dict]:
    monkeypatch.setattr(payroll_service, "_report_today", lambda: today)
    _login(client)
    employee_id = _create_employee(client, str(db_session._test_job_roles["Operario"]))
    _set_salary(client, employee_id)
    period = _create_period(client)
    return employee_id, period


# --- Bloqueo por ausencia sin resolución ---

def test_ausencia_pasada_sin_resolucion_bloquea_readiness_y_cierre(client, db_session, monkeypatch):
    _, period = _setup(client, db_session, monkeypatch)
    _calculate(client, period["id"])

    readiness = _readiness(client, period["id"])
    assert readiness["ready"] is False
    assert _unresolved_dates(readiness) == [MONDAY, TUESDAY]

    rejected = client.post(f"/api/v1/payroll/periods/{period['id']}/confirm")
    assert rejected.status_code == 409
    detail = rejected.json()["detail"]
    assert detail["ready"] is False
    assert [issue["code"] for issue in detail["blockers"]] == ["UNRESOLVED_ATTENDANCE_DAY"] * 2
    assert {issue["work_date"] for issue in detail["blockers"]} == {MONDAY, TUESDAY}


def test_bloqueo_expone_fecha_en_json_y_en_el_mensaje(client, db_session, monkeypatch):
    _, period = _setup(client, db_session, monkeypatch)
    _calculate(client, period["id"])

    issues = [
        issue
        for issue in _readiness(client, period["id"])["blockers"]
        if issue["code"] == "UNRESOLVED_ATTENDANCE_DAY"
    ]
    assert issues
    for issue in issues:
        # El schema declara work_date: no se descarta al serializar.
        assert issue["work_date"] in {MONDAY, TUESDAY}
        # Visible incluso para clientes que no leen work_date.
        assert issue["work_date"] in issue["message"]
        assert issue["employee_id"]


def test_confirmar_con_ausencia_pasada_no_altera_snapshot(client, db_session, monkeypatch):
    """El bloqueo no descuenta dinero ni cambia la base salarial."""
    _, period = _setup(client, db_session, monkeypatch)
    _calculate(client, period["id"])
    before = client.get(f"/api/v1/payroll/periods/{period['id']}/records").json()[0]

    assert client.post(f"/api/v1/payroll/periods/{period['id']}/confirm").status_code == 409

    after = client.get(f"/api/v1/payroll/periods/{period['id']}/records").json()[0]
    assert after["base_salary"] == before["base_salary"] == "1500.00"
    assert after["total"] == before["total"] == "1500.00"
    assert after["payable"] is True


# --- Resoluciones ---

def test_asistencia_completa_resuelve_y_permite_confirmar(client, db_session, monkeypatch):
    employee_id, period = _setup(client, db_session, monkeypatch)
    _add_complete_attendance(db_session, employee_id, MONDAY)
    _add_complete_attendance(db_session, employee_id, TUESDAY)
    _calculate(client, period["id"])

    assert _unresolved_dates(_readiness(client, period["id"])) == []
    assert client.post(f"/api/v1/payroll/periods/{period['id']}/confirm").status_code == 200


def test_asistencia_abierta_tambien_resuelve_la_fecha(client, db_session, monkeypatch):
    employee_id, period = _setup(client, db_session, monkeypatch)
    # Solo puede existir una sesión abierta por empleado: la otra jornada se
    # cubre con una sesión cerrada.
    open_day = date.fromisoformat(MONDAY)
    db_session.add(
        AttendanceRecord(
            employee_id=uuid.UUID(employee_id),
            work_date=open_day,
            check_in_at=datetime(open_day.year, open_day.month, open_day.day, 13, tzinfo=timezone.utc),
            check_out_at=None,
            worked_minutes=0,
            status="OPEN",
        )
    )
    db_session.commit()
    _add_complete_attendance(db_session, employee_id, TUESDAY)
    _calculate(client, period["id"])

    readiness = _readiness(client, period["id"])
    # OPEN resuelve la jornada; su propio bloqueo de sesión abierta se preserva.
    assert _unresolved_dates(readiness) == []
    assert any(issue["code"] == "OPEN_ATTENDANCE" for issue in readiness["blockers"])
    assert client.post(f"/api/v1/payroll/periods/{period['id']}/confirm").status_code == 409


def test_carga_historica_activa_resuelve_y_permite_confirmar(client, db_session, monkeypatch):
    employee_id, period = _setup(client, db_session, monkeypatch)
    _add_manual_load(db_session, employee_id, MONDAY)
    _add_manual_load(db_session, employee_id, TUESDAY)
    _calculate(client, period["id"])

    assert _unresolved_dates(_readiness(client, period["id"])) == []
    assert client.post(f"/api/v1/payroll/periods/{period['id']}/confirm").status_code == 200


def test_permiso_aprobado_resuelve_y_permite_confirmar(client, db_session, monkeypatch):
    employee_id, period = _setup(client, db_session, monkeypatch)
    _add_approved_adjustment(db_session, employee_id, MONDAY, "PERMISO", -480)
    _add_approved_adjustment(db_session, employee_id, TUESDAY, "PERMISO", -480)
    _calculate(client, period["id"])

    assert _unresolved_dates(_readiness(client, period["id"])) == []
    assert client.post(f"/api/v1/payroll/periods/{period['id']}/confirm").status_code == 200


def test_recuperacion_aprobada_resuelve_la_fecha(client, db_session, monkeypatch):
    employee_id, period = _setup(client, db_session, monkeypatch)
    _add_approved_adjustment(db_session, employee_id, MONDAY, "RECUPERACION", 480)
    _add_approved_adjustment(db_session, employee_id, TUESDAY, "RECUPERACION", 480)
    _calculate(client, period["id"])

    assert _unresolved_dates(_readiness(client, period["id"])) == []
    assert client.post(f"/api/v1/payroll/periods/{period['id']}/confirm").status_code == 200


def test_compromiso_de_recuperacion_registrado_resuelve_la_fecha(client, db_session, monkeypatch):
    employee_id, period = _setup(client, db_session, monkeypatch)
    _add_recovery_commitment(db_session, employee_id, MONDAY)
    _add_recovery_commitment(db_session, employee_id, TUESDAY)
    _calculate(client, period["id"])

    assert _unresolved_dates(_readiness(client, period["id"])) == []
    assert client.post(f"/api/v1/payroll/periods/{period['id']}/confirm").status_code == 200


def test_permiso_pendiente_no_resuelve(client, db_session, monkeypatch):
    employee_id, period = _setup(client, db_session, monkeypatch)
    db_session.add(
        HourAdjustment(
            employee_id=uuid.UUID(employee_id),
            adjustment_date=date.fromisoformat(MONDAY),
            minutes=-480,
            adjustment_type="PERMISO",
            reason="Permiso aún sin aprobar",
            status="PENDING",
            version=1,
        )
    )
    db_session.commit()
    _calculate(client, period["id"])

    # Un permiso pendiente no es una resolución: el día sigue sin resolver.
    assert MONDAY in _unresolved_dates(_readiness(client, period["id"]))


# --- Descanso y fechas no pasadas ---

def test_descanso_no_bloquea_y_permite_confirmar(client, db_session, monkeypatch):
    # Reporte el lunes 3: solo quedan en el pasado sábado 1 y domingo 2 (jornada 0).
    _, period = _setup(client, db_session, monkeypatch, today=date(2026, 8, 3))
    _calculate(client, period["id"])

    assert _unresolved_dates(_readiness(client, period["id"])) == []
    assert client.post(f"/api/v1/payroll/periods/{period['id']}/confirm").status_code == 200


def test_hoy_y_futuro_no_bloquean(client, db_session, monkeypatch):
    # Reporte el primer día del periodo: ninguna fecha es anterior a hoy.
    _, period = _setup(client, db_session, monkeypatch, today=date(2026, 8, 1))
    _calculate(client, period["id"])

    assert _unresolved_dates(_readiness(client, period["id"])) == []
    assert client.post(f"/api/v1/payroll/periods/{period['id']}/confirm").status_code == 200
