"""Opt-in timing preserves the three public employee read contracts."""
import math
import re

import pytest
from sqlalchemy import event

from test_attendance_summary_timing import (
    _login,
    _timing_client,
    created_collectors,
    cursor_counter,
    parse_server_timing,
    real_db,
    step_clock,
    timing_flag,
)


_ROUTES = (
    "/api/v1/employees/{employee_id}/adjustments",
    "/api/v1/employees/{employee_id}/balance?date_from=2026-10-15&date_to=2026-10-15",
    "/api/v1/work-calendar/employees/{employee_id}/days?date_from=2026-10-15&date_to=2026-10-15",
)
_UUID = "00000000-0000-0000-0000-000000000000"
_METRICS = {"api_req", "api_dbconn", "api_dbsql"}


@pytest.fixture()
def employee_client(real_db):
    with _timing_client() as client:
        _login(client)
        role = client.post("/api/v1/job-roles", json={"name": "Timing fixture"})
        assert role.status_code == 201, role.text
        employee = client.post("/api/v1/employees", json={
            "dni": "90000001", "employee_code": "TIMING-001",
            "first_name": "Timing", "last_name": "Fixture",
            "job_role_id": role.json()["id"],
        })
        assert employee.status_code == 201, employee.text
        yield client, employee.json()["id"]


@pytest.mark.parametrize("route", _ROUTES)
def test_opt_in_reads_preserve_body_and_emit_isolated_numeric_timing(
    route, employee_client, real_db, timing_flag, step_clock,
    created_collectors, cursor_counter,
):
    client, employee_id = employee_client
    path = route.format(employee_id=employee_id)
    statements = []

    def record_sql(_conn, _cursor, statement, *_args):
        statements.append(statement)

    event.listen(real_db[1], "before_cursor_execute", record_sql)
    try:
        timing_flag(False)
        baseline = client.get(path)
        assert baseline.status_code == 200, baseline.text
        assert "server-timing" not in baseline.headers
        assert created_collectors == []
        timing_flag(True)
        observed = []
        for _ in range(2):
            cursor_counter.count = 0
            response = client.get(path)
            assert response.status_code == baseline.status_code
            assert response.json() == baseline.json()
            header = response.headers["server-timing"]
            metrics = parse_server_timing(header)
            assert set(metrics) == _METRICS
            assert all(math.isfinite(value) and value >= 0 for value in metrics.values())
            assert metrics["api_dbconn"] == step_clock.step * 1000
            assert metrics["api_dbsql"] == cursor_counter.count * step_clock.step * 1000
            assert metrics["api_req"] >= metrics["api_dbconn"] + metrics["api_dbsql"]
            assert re.fullmatch(
                r"api_req;dur=\d+\.\d{3}, api_dbconn;dur=\d+\.\d{3}, api_dbsql;dur=\d+\.\d{3}", header
            )
            assert employee_id not in header
            assert not created_collectors[-1].has_active_listeners()
            observed.append(metrics)
        assert observed[0]["api_dbsql"] == observed[1]["api_dbsql"]
    finally:
        event.remove(real_db[1], "before_cursor_execute", record_sql)
    assert not any(re.match(r"\s*(INSERT|UPDATE|DELETE)\b", sql, re.I) for sql in statements)


@pytest.mark.parametrize("route", _ROUTES)
def test_unauthenticated_reads_preserve_401_and_numeric_only_header(
    route, real_db, timing_flag, step_clock, created_collectors,
):
    timing_flag(True)
    with _timing_client() as client:
        response = client.get(route.format(employee_id=_UUID))
    assert response.status_code == 401
    assert response.json() == {"detail": "No autenticado"}
    metrics = parse_server_timing(response.headers["server-timing"])
    assert set(metrics) == _METRICS
    assert metrics["api_dbsql"] == 0
    assert metrics["api_dbconn"] == step_clock.step * 1000
    assert not created_collectors[-1].has_active_listeners()


@pytest.mark.parametrize("method,path,status", [
    ("PUT", "/api/v1/employees/{employee_id}/adjustments", 405),
    ("POST", "/api/v1/employees/{employee_id}/balance", 405),
    ("GET", "/api/v1/employees/{employee_id}/adjustments/history", 404),
    ("GET", "/api/v1/employees/{employee_id}/salary-settings/history", 200),
    ("GET", "/api/v1/work-calendar/employees/not-a-uuid/days?date_from=2026-10-15&date_to=2026-10-15", 422),
])
def test_other_methods_and_paths_remain_uninstrumented(
    method, path, status, employee_client, timing_flag, created_collectors,
):
    client, employee_id = employee_client
    timing_flag(True)
    response = client.request(method, path.format(employee_id=employee_id))
    assert response.status_code == status, response.text
    assert "server-timing" not in response.headers
    assert created_collectors == []
