"""Valor día legal (sueldo ÷ 30) constante en meses de 28, 29, 30 y 31 días.

Base legal:
- D.S. 012-92-TR, art. 2 (reglamento del D.L. 713): la remuneración del mes o de
  la quincena se divide entre 30 o 15 días. "El resultado es el valor día."
- D.S. 007-2002-TR, art. 12: valor hora = remuneración de un día ÷ horas de la
  jornada del respectivo trabajador.
- D.L. 713, art. 3: quien trabaja su día de descanso sin sustituirlo en la misma
  semana percibe la labor más una sobretasa del 100%.
"""

import uuid
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, ROUND_HALF_UP

import app.modules.payroll.service as payroll_service
from app.core.legal import daily_value, days_value, double_days_value, hourly_value
from app.modules.attendance.models import AttendanceRecord
from app.modules.attendance.service import AttendanceService
from app.modules.overtime.service import OvertimeService
from app.modules.payroll.service import PayrollService

_RATE = Decimal("0.0001")


def _login(client) -> None:
    response = client.post("/api/v1/auth/login", json={"username": "admin", "password": "Admin123!"})
    assert response.status_code == 200, response.text


def _employee(client, job_role_id, *, monthly_salary: str = "650.00") -> str:
    """Empleado con jornada de 5 h de lunes a sábado (30 h semanales)."""
    response = client.post("/api/v1/employees", json={
        "dni": "72845632", "employee_code": "LEG-001", "first_name": "Legal", "last_name": "Treinta",
        "job_role_id": str(job_role_id),
    })
    assert response.status_code == 201, response.text
    employee_id = response.json()["id"]
    salary = client.post(f"/api/v1/employees/{employee_id}/salary-settings", json={
        "effective_from": "2026-01-01", "monthly_salary": monthly_salary, "overtime_enabled": True,
    })
    assert salary.status_code == 201, salary.text
    schedule = client.post(f"/api/v1/employees/{employee_id}/schedule", json={
        "effective_from": "2026-01-01", "monday_minutes": 300, "tuesday_minutes": 300,
        "wednesday_minutes": 300, "thursday_minutes": 300, "friday_minutes": 300,
        "saturday_minutes": 300,
    })
    assert schedule.status_code == 201, schedule.text
    return employee_id


def test_valor_dia_legal_es_30_avos_en_cualquier_mes(client, db_session):
    """Febrero (28 y 29 días), setiembre (30) y agosto (31) dan el mismo valor día."""
    _login(client)
    _employee(client, db_session._test_job_roles["Operario"])
    for year, month in ((2026, 2), (2028, 2), (2026, 9), (2026, 8)):
        period = client.post("/api/v1/payroll/periods", json={"year": year, "month": month})
        assert period.status_code == 201, period.text
        period_id = period.json()["id"]
        calculated = client.post(f"/api/v1/payroll/periods/{period_id}/calculate")
        assert calculated.status_code == 200, calculated.text
        record = calculated.json()[0]
        # El mes completo paga el sueldo pactado: ni 31/30 ni 28/30.
        assert Decimal(str(record["base_salary"])) == Decimal("650.00")
        report = client.get(f"/api/v1/payroll/periods/{period_id}/daily-report")
        assert report.status_code == 200, report.text
        payload = report.json()
        assert Decimal(str(payload["employees"][0]["legal_daily_value"])) == Decimal("21.6667")
        assert payload["daily"], "el desglose diario no puede quedar vacío con jornada programada"
        assert all(
            Decimal(str(item["legal_daily_value"])) == Decimal("21.6667") for item in payload["daily"]
        )


def test_periodo_parcial_usa_treintavos_del_valor_dia(client, db_session):
    """Una fila que no cubre el mes paga sueldo ÷ 30 por día activo, no ÷ 28."""
    _login(client)
    _employee(client, db_session._test_job_roles["Operario"])
    # Fila histórica: create_period ya no acepta meses parciales, así que se
    # inserta por repositorio para cubrir datos previos a esa validación.
    period = PayrollService(db_session).repo.create_period(
        name="Febrero parcial 2026", start_date=date(2026, 2, 1), end_date=date(2026, 2, 15),
    )
    db_session.commit()
    calculated = client.post(f"/api/v1/payroll/periods/{period.id}/calculate")
    assert calculated.status_code == 200, calculated.text
    # 15 días × 650/30 = 325.00. Con el divisor del calendario (÷28) eran 348.21.
    assert Decimal(str(calculated.json()[0]["base_salary"])) == Decimal("325.00")


def test_descanso_trabajado_paga_doble_valor_dia_en_cualquier_mes(client, db_session):
    """El pago doble del descanso trabajado no cambia entre febrero y agosto."""
    _login(client)
    employee_id = _employee(client, db_session._test_job_roles["Operario"])
    rule = client.post("/api/v1/work-calendar/weekly-rest-rules", json={
        "employee_id": employee_id, "weekly_rest_weekday": 6, "reference_daily_minutes": 300,
        "source": "Contrato", "reason": "Descanso semanal acordado", "effective_from": "2026-01-01",
    })
    assert rule.status_code == 201, rule.text
    # 1 de febrero de 2026 y 2 de agosto de 2026 son domingos.
    for work_date in (date(2026, 2, 1), date(2026, 8, 2)):
        db_session.add(AttendanceRecord(
            employee_id=uuid.UUID(employee_id), work_date=work_date,
            check_in_at=datetime(work_date.year, work_date.month, work_date.day, 8, tzinfo=timezone.utc),
            check_out_at=datetime(work_date.year, work_date.month, work_date.day, 13, tzinfo=timezone.utc),
            worked_minutes=300, status="COMPLETE",
        ))
        db_session.commit()
        preview = client.post("/api/v1/work-calendar/valuations/preview", json={
            "employee_id": employee_id, "work_date": work_date.isoformat(), "source_kind": "WEEKLY_REST",
        })
        assert preview.status_code == 200, preview.text
        # 2 × (650/30) = 43.33 en un mes de 28 días y en uno de 31.
        assert Decimal(str(preview.json()["amount"])) == Decimal("43.33")


def test_daily_report_valora_reconocido_y_revision_a_valor_dia_legal(client, db_session):
    """El reconocido/revisión por asistencia usa sueldo/30, no una cuota del tramo.

    Con sueldo 650 y agosto (31 fechas), la base atribuida por calendario es
    31 × 650/30 = 671.77 y el reconocido de una jornada completa vale
    650/30 = 21.67. La diferencia por descansos/fin de mes se expone como saldo
    no atribuido, no inflando la jornada.
    """
    _login(client)
    employee_id = _employee(client, db_session._test_job_roles["Operario"])
    db_session.add(AttendanceRecord(
        employee_id=uuid.UUID(employee_id), work_date=date(2026, 8, 3),
        check_in_at=datetime(2026, 8, 3, 8, tzinfo=timezone.utc),
        check_out_at=datetime(2026, 8, 3, 13, tzinfo=timezone.utc),
        worked_minutes=300, status="COMPLETE",
    ))
    db_session.commit()
    period = client.post("/api/v1/payroll/periods", json={"year": 2026, "month": 8})
    assert period.status_code == 201, period.text
    period_id = period.json()["id"]
    assert client.post(f"/api/v1/payroll/periods/{period_id}/calculate").status_code == 200
    payload = client.get(f"/api/v1/payroll/periods/{period_id}/daily-report").json()
    by_date = {item["work_date"]: item for item in payload["daily"]}

    attended = by_date["2026-08-03"]
    # Agosto tiene 31 fechas: la base diaria es el treintavo 650/30 = 21.67,
    # nunca la cuota 650/26 = 25.00 del reparto entre jornadas.
    assert Decimal(str(attended["base_amount"])) == Decimal("21.67")
    assert Decimal(str(attended["recognized_base_amount"])) == Decimal("21.67")
    assert Decimal(str(attended["review_difference_amount"])) == Decimal("0.00")

    missing = by_date["2026-08-04"]
    assert Decimal(str(missing["recognized_base_amount"])) == Decimal("0.00")
    assert Decimal(str(missing["review_difference_amount"])) == Decimal("21.67")

    summary = payload["employees"][0]
    assert Decimal(str(summary["programmed_base_amount"])) == Decimal("650.00")
    assert Decimal(str(summary["recognized_base_amount"])) == Decimal("21.67")
    # 650.00 - 21.67: base oficial que la asistencia no explica (descansos,
    # feriados y el desfase de fin de mes). No es un descuento.
    assert Decimal(str(summary["unattributed_base_amount"])) == Decimal("628.33")


def test_valor_hora_es_valor_dia_entre_jornada(client, db_session):
    """El valor hora usa el divisor 30, no los días del mes."""
    _login(client)
    employee_id = _employee(client, db_session._test_job_roles["Operario"])
    overtime = OvertimeService(db_session)
    for ref in (date(2026, 2, 2), date(2026, 8, 3)):
        assert overtime.hourly_rate(uuid.UUID(employee_id), ref) == Decimal("4.3333")


def test_reglas_unitarias_de_ley():
    """Los helpers de app.core.legal fijan el divisor 30/15 y el pago doble."""
    sueldo = Decimal("650.00")
    assert daily_value(sueldo).quantize(_RATE) == Decimal("21.6667")
    assert days_value(sueldo, 15) == Decimal("325.00")
    assert days_value(sueldo, 30) == Decimal("650.00")
    # La quincena entre 15 devuelve el mismo valor día que el mes entre 30.
    assert (days_value(sueldo, 15) / Decimal(15)).quantize(_RATE) == Decimal("21.6667")
    assert double_days_value(sueldo, 300, 300) == Decimal("43.33")
    assert hourly_value(sueldo, 300).quantize(_RATE) == Decimal("4.3333")
    # Sin tope: 450 min netos sobre una referencia de 300 se valoran completos.
    assert double_days_value(sueldo, 450, 300) == Decimal("65.00")
    assert double_days_value(sueldo, 150, 300) == Decimal("21.67")  # media jornada


def test_primera_quincena_setiembre_es_calendario_sin_reparto(client, db_session, monkeypatch):
    """Caso de aceptación: setiembre 2026, sueldo 650, Q1, jornada L–S 5 h.

    15 fechas calendario; base del tramo 325.00; ninguna fecha usa 25.00 por
    dividir 325 entre 13 jornadas; valor día 21.6667. Una jornada completa
    reconoce su treintavo y las HE siguen usando valor hora 4.3333.
    """
    _login(client)
    employee_id = _employee(client, db_session._test_job_roles["Operario"])
    # Asistencia completa en las 13 jornadas programadas (setiembre 2026 tiene
    # dos domingos: 6 y 13). Las fechas de descanso también aparecen sin jornada.
    work_date = date(2026, 9, 1)
    while work_date <= date(2026, 9, 15):
        if work_date.weekday() != 6:
            db_session.add(AttendanceRecord(
                employee_id=uuid.UUID(employee_id), work_date=work_date,
                check_in_at=datetime(work_date.year, work_date.month, work_date.day, 8, tzinfo=timezone.utc),
                check_out_at=datetime(work_date.year, work_date.month, work_date.day, 13, tzinfo=timezone.utc),
                worked_minutes=300, status="COMPLETE",
            ))
        work_date += timedelta(days=1)
    db_session.commit()
    monkeypatch.setattr(payroll_service, "_report_today", lambda: date(2026, 9, 20))

    period = client.post("/api/v1/payroll/periods", json={"year": 2026, "month": 9, "period_kind": "FIRST_HALF"})
    assert period.status_code == 201, period.text
    period_id = period.json()["id"]
    calculated = client.post(f"/api/v1/payroll/periods/{period_id}/calculate")
    assert calculated.status_code == 200, calculated.text
    assert Decimal(str(calculated.json()[0]["base_salary"])) == Decimal("325.00")

    payload = client.get(f"/api/v1/payroll/periods/{period_id}/daily-report").json()
    days = [item for item in payload["daily"] if item["employee_id"] == employee_id]
    assert len(days) == 15  # 1 al 15, descansos incluidos.

    assert all(Decimal(str(item["legal_daily_value"])) == Decimal("21.6667") for item in days)
    # La base diaria es el treintavo, nunca 325/13 = 25.00.
    assert all(Decimal(str(item["base_amount"])) == Decimal("21.67") for item in days)
    assert all(Decimal(str(item["base_amount"])) != Decimal("25.00") for item in days)

    summary = payload["employees"][0]
    assert Decimal(str(summary["legal_daily_value"])) == Decimal("21.6667")
    # 15 fechas × 21.67 = 325.05; la regularización de cierre de -0.05 concilia
    # exactamente con la base del tramo (snapshot oficial 325.00).
    assert Decimal(str(summary["calendar_base_amount"])) == Decimal("325.05")
    assert Decimal(str(summary["regularization_amount"])) == Decimal("-0.05")
    assert Decimal(str(summary["programmed_base_amount"])) == Decimal("325.00")
    assert (
        Decimal(str(summary["calendar_base_amount"])) + Decimal(str(summary["regularization_amount"]))
        == Decimal("325.00")
    )

    # Una jornada completa reconoce su treintavo.
    full_day = next(item for item in days if item["work_date"] == "2026-09-01")
    assert full_day["status"] == "RECOGNIZED"
    assert Decimal(str(full_day["recognized_base_amount"])) == Decimal("21.67")
    # Descansos: ni ausencia ni reparto.
    rest_day = next(item for item in days if item["work_date"] == "2026-09-06")
    assert rest_day["status"] == "NO_SCHEDULE"
    assert rest_day["expected_minutes"] == 0
    assert Decimal(str(rest_day["base_amount"])) == Decimal("21.67")

    # HE: valor hora = valor día / jornada (650/30/5 = 4.3333), sin cambios.
    assert OvertimeService(db_session).hourly_rate(uuid.UUID(employee_id), date(2026, 9, 1)) == Decimal("4.3333")


def test_descanso_semanal_paga_todas_las_horas_netas_sobre_la_jornada(client, db_session):
    """Caso 13/09/2026: 7 h 30 netas (450 min) sobre una referencia de 300 min.

    Valor hora = (650/30)/5 = 4.3333; labor = 32.50; sobretasa 100% = 32.50;
    adicional = 65.00 y total atribuible 65.00 + 21.67 = 86.67. El pago no se
    topa en la jornada de referencia ni exige revisión por excederla.
    """
    _login(client)
    employee_id = _employee(client, db_session._test_job_roles["Operario"])
    rule = client.post("/api/v1/work-calendar/weekly-rest-rules", json={
        "employee_id": employee_id, "weekly_rest_weekday": 6, "reference_daily_minutes": 300,
        "source": "Contrato", "reason": "Descanso dominical", "effective_from": "2026-01-01",
    })
    assert rule.status_code == 201, rule.text
    # 08:00 a 16:30 son 510 min brutos; 60 min de refrigerio dejan 450 min netos.
    # worked_minutes ya es neto: la valoración no debe volver a restar el refrigerio.
    db_session.add(AttendanceRecord(
        employee_id=uuid.UUID(employee_id), work_date=date(2026, 9, 13),
        check_in_at=datetime(2026, 9, 13, 8, tzinfo=timezone.utc),
        check_out_at=datetime(2026, 9, 13, 16, 30, tzinfo=timezone.utc),
        worked_minutes=450, status="COMPLETE",
    ))
    db_session.commit()
    preview = client.post("/api/v1/work-calendar/valuations/preview", json={
        "employee_id": employee_id, "work_date": "2026-09-13", "source_kind": "WEEKLY_REST",
    })
    assert preview.status_code == 200, preview.text
    payload = preview.json()
    assert payload["worked_minutes"] == 450
    assert payload["status"] == "PENDING"  # exceder la referencia ya no exige revisión
    assert Decimal(str(payload["amount"])) == Decimal("65.00")
    assert payload["calculation"]["known_minutes"] == 450
    assert payload["calculation"]["excess_minutes"] == 150
    components = {item["component_kind"]: (item["minutes"], Decimal(item["amount"])) for item in payload["components"]}
    assert components["WEEKLY_REST_WORK"] == (450, Decimal("32.50"))
    assert components["WEEKLY_REST_SURCHARGE"] == (450, Decimal("32.50"))
    assert sum((Decimal(item["amount"]) for item in payload["components"]), Decimal("0.00")) == Decimal("65.00")
    # Total atribuible: adicional 65.00 + valor día legal 21.67 = 86.67.
    daily = daily_value(Decimal("650.00")).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    assert daily == Decimal("21.67")
    assert Decimal(str(payload["amount"])) + daily == Decimal("86.67")

    approved = client.post(f"/api/v1/work-calendar/valuations/{payload['id']}/approve", json={
        "expected_version": payload["version"], "preview_token": payload["preview_token"],
        "idempotency_key": "legal-test-approve-450", "reason": "Aprobación caso 13/09",
    })
    assert approved.status_code == 200, approved.text
    assert approved.json()["status"] == "APPROVED"

    period = client.post("/api/v1/payroll/periods", json={"year": 2026, "month": 9, "period_kind": "FIRST_HALF"})
    assert period.status_code == 201, period.text
    calculated = client.post(f"/api/v1/payroll/periods/{period.json()['id']}/calculate")
    assert calculated.status_code == 200, calculated.text
    row = calculated.json()[0]
    # El adicional aprobado entra una sola vez al periodo; no se re-paga como HE.
    assert Decimal(str(row["special_day_amount"])) == Decimal("65.00")
    assert Decimal(str(row["overtime_amount"])) == Decimal("0.00")


def _daniel(client, db_session):
    """Daniel EMP-004: jornada 300, referencia de descanso obsoleta 480."""
    created = client.post("/api/v1/employees", json={
        "dni": "74033256", "employee_code": "EMP-004", "first_name": "Daniel",
        "last_name": "Ventas", "job_role_id": str(db_session._test_job_roles["Operario"]),
        "hire_date": "2026-08-01",
    })
    assert created.status_code == 201, created.text
    employee_id = created.json()["id"]
    assert client.post(f"/api/v1/employees/{employee_id}/salary-settings", json={
        "effective_from": "2026-08-01", "monthly_salary": "650.00", "overtime_enabled": True,
    }).status_code == 201
    assert client.post(f"/api/v1/employees/{employee_id}/schedule", json={
        "effective_from": "2026-08-01", "monday_minutes": 300, "tuesday_minutes": 300,
        "wednesday_minutes": 300, "thursday_minutes": 300, "friday_minutes": 300,
        "saturday_minutes": 300, "break_minutes": 60, "break_applies_after_minutes": 360,
    }).status_code == 201
    # Referencia obsoleta: la jornada real es 300, pero la regla guarda 480.
    rule = client.post("/api/v1/work-calendar/weekly-rest-rules", json={
        "employee_id": employee_id, "weekly_rest_weekday": 6, "reference_daily_minutes": 480,
        "source": "Contrato", "reason": "Descanso dominical", "effective_from": "2026-08-01",
    })
    assert rule.status_code == 201, rule.text
    return employee_id


def test_daniel_primera_quincena_setiembre_505_58(client, db_session, monkeypatch):
    """Aceptación EMP-004: base 325.00 + HE 115.58 + dominical 65.00 = 505.58.

    El treintavo dominical (21.67) ya está dentro de la base y no se suma otra
    vez.  La regla de descanso guarda 480 pero la referencia efectiva es la
    jornada real de 300.
    """
    _login(client)
    employee_id = _daniel(client, db_session)
    # HE netas reales de la primera quincena (minutos, valor).
    overtime_days = {
        "2026-09-02": (360, Decimal("34.23")),
        "2026-09-04": (240, Decimal("22.53")),
        "2026-09-09": (150, Decimal("13.76")),
        "2026-09-11": (240, Decimal("22.53")),
        "2026-09-12": (240, Decimal("22.53")),
    }
    for work_date, (minutes, _amount) in overtime_days.items():
        created = client.post(f"/api/v1/employees/{employee_id}/adjustments", json={
            "adjustment_date": work_date, "minutes": minutes, "adjustment_type": "OVERTIME",
            "reason": "Sobretiempo aprobado",
        })
        assert created.status_code == 201, created.text
        pending = created.json()
        approved = client.patch(f"/api/v1/adjustments/{pending['id']}/approve", json={
            "expected_version": pending["version"], "expected_snapshot": pending["approval_snapshot"],
            "idempotency_key": f"daniel-ot-{work_date}",
        })
        assert approved.status_code == 200, approved.text
    # Domingo 13/09: 510 brutos − 60 de refrigerio = 450 netos.
    db_session.add(AttendanceRecord(
        employee_id=uuid.UUID(employee_id), work_date=date(2026, 9, 13),
        check_in_at=datetime(2026, 9, 13, 8, tzinfo=timezone.utc),
        check_out_at=datetime(2026, 9, 13, 16, 30, tzinfo=timezone.utc),
        worked_minutes=0, status="COMPLETE",
    ))
    db_session.commit()
    assert AttendanceService(db_session)._recompute_day(
        uuid.UUID(employee_id), date(2026, 9, 13)
    ) == 450

    preview = client.post("/api/v1/work-calendar/valuations/preview", json={
        "employee_id": employee_id, "work_date": "2026-09-13", "source_kind": "WEEKLY_REST",
    })
    assert preview.status_code == 200, preview.text
    value = preview.json()
    # La referencia efectiva es 300 (jornada real), no el 480 almacenado.
    assert value["reference_daily_minutes"] == 300
    assert value["calculation"]["context"]["reference_diverges_from_rule"] is True
    assert Decimal(str(value["amount"])) == Decimal("65.00")
    approved = client.post(f"/api/v1/work-calendar/valuations/{value['id']}/approve", json={
        "expected_version": value["version"], "preview_token": value["preview_token"],
        "idempotency_key": "daniel-special-approve", "reason": "Descanso dominical trabajado",
    })
    assert approved.status_code == 200, approved.text

    evaluated = OvertimeService(db_session).value(uuid.UUID(employee_id), date(2026, 9, 1), date(2026, 9, 15))
    assert Decimal(str(evaluated["value"])) == Decimal("115.58")
    assert evaluated["overtime_minutes"] == sum(m for m, _ in overtime_days.values())

    monkeypatch.setattr(payroll_service, "_report_today", lambda: date(2026, 9, 20))
    period = client.post("/api/v1/payroll/periods", json={"year": 2026, "month": 9, "period_kind": "FIRST_HALF"})
    assert period.status_code == 201, period.text
    calculated = client.post(f"/api/v1/payroll/periods/{period.json()['id']}/calculate")
    assert calculated.status_code == 200, calculated.text
    row = calculated.json()[0]
    assert Decimal(str(row["base_salary"])) == Decimal("325.00")
    assert Decimal(str(row["overtime_amount"])) == Decimal("115.58")
    assert Decimal(str(row["special_day_amount"])) == Decimal("65.00")
    assert Decimal(str(row["total"])) == Decimal("505.58")

    report = client.get(f"/api/v1/payroll/periods/{period.json()['id']}/daily-report").json()
    days = {item["work_date"]: item for item in report["daily"] if item["employee_id"] == employee_id}
    assert len(days) == 15
    assert all(Decimal(str(item["base_amount"])) == Decimal("21.67") for item in days.values())
    sunday = days["2026-09-13"]
    assert sunday["status"] == "RECOGNIZED"
    assert Decimal(str(sunday["base_amount"])) == Decimal("21.67")
    assert Decimal(str(sunday["recognized_base_amount"])) == Decimal("0.00")
    assert Decimal(str(sunday["special_day_amount"])) == Decimal("65.00")
    summary = next(item for item in report["employees"] if item["employee_id"] == employee_id)
    assert Decimal(str(summary["calendar_base_amount"])) == Decimal("325.05")
    assert Decimal(str(summary["regularization_amount"])) == Decimal("-0.05")
    assert Decimal(str(summary["programmed_base_amount"])) == Decimal("325.00")

    accrual = client.get(f"/api/v1/employees/{employee_id}/payroll-accrual", params={
        "period": "FIRST_HALF", "anchor_date": "2026-09-15",
    }).json()
    assert Decimal(str(accrual["base_amount"])) == Decimal("325.00")
    assert Decimal(str(accrual["approved_additional_amount"])) == Decimal("180.58")
    assert Decimal(str(accrual["estimated_total"])) == Decimal("505.58")

