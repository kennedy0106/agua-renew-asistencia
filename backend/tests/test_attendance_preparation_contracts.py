"""Inactive B3 preparation contracts; no public preparation writes yet."""

from io import StringIO
from pathlib import Path
import re

from alembic import command
from alembic.config import Config
from pydantic import ValidationError
import pytest

from app.modules.attendance import models, schemas


LOCATION = {
    "latitude": -12.0464,
    "longitude": -77.0428,
    "accuracy_m": 12.5,
    "age_ms": 0,
}
BASE_REVISION = "t6b7c8d9e0f1"
PREPARATION_REVISION = "u7c8d9e0f1a2"


def _contract(name):
    contract = getattr(schemas, name, None)
    assert contract is not None, f"Missing B3 public DTO: {name}"
    return contract


def _offline_config(output):
    config = Config(output_buffer=output)
    config.set_main_option(
        "script_location", str(Path(__file__).resolve().parents[1] / "alembic")
    )
    return config


@pytest.mark.parametrize(
    "overrides",
    [
        {},
        {"latitude": -90, "longitude": -180, "accuracy_m": 50, "age_ms": 60000},
        {"latitude": 90, "longitude": 180, "accuracy_m": 0.001, "age_ms": 0},
    ],
)
def test_location_contract_accepts_named_boundaries(overrides):
    values = {**LOCATION, **overrides}
    assert _contract("LocationInput")(**values).model_dump() == values


@pytest.mark.parametrize(
    "field,value",
    [
        ("latitude", -90.0001),
        ("latitude", 90.0001),
        ("longitude", -180.0001),
        ("longitude", 180.0001),
        ("accuracy_m", 0),
        ("accuracy_m", 50.0001),
        ("age_ms", -1),
        ("age_ms", 60001),
    ],
)
def test_location_contract_rejects_outside_named_boundaries(field, value):
    contract = _contract("LocationInput")
    with pytest.raises(ValidationError) as error:
        contract(**{**LOCATION, field: value})
    assert [item["loc"] for item in error.value.errors()] == [(field,)]


def test_location_schema_rechaza_valores_no_finitos():
    """El contrato exige números finitos (NaN/Inf no son JSON estándar)."""
    from pydantic import ValidationError

    from app.modules.attendance.schemas import LocationInput

    for case in (
        {"latitude": float("nan")},
        {"latitude": float("inf")},
        {"longitude": float("-inf")},
        {"accuracy_m": float("inf")},
    ):
        with pytest.raises(ValidationError):
            LocationInput(**{**LOCATION, **case})


def test_preparation_request_and_snapshot_wire_contract():
    request = _contract("AttemptPrepareRequest")(
        marking_token="synthetic-marking-token", location=LOCATION
    )
    assert request.model_dump() == {
        "marking_token": "synthetic-marking-token", "location": LOCATION
    }
    snapshot = {
        "marked_at": "2026-10-16T12:00:00Z",
        "expires_at": "2026-10-16T12:05:00Z",
        "location": {
            "latitude": LOCATION["latitude"],
            "longitude": LOCATION["longitude"],
            "accuracy_m": LOCATION["accuracy_m"],
            "observed_at": "2026-10-16T11:59:59Z",
            "address": None,
        },
    }
    assert _contract("PreparationSnapshot")(**snapshot).model_dump(mode="json") == snapshot
    response = {**snapshot, "marking_token": "synthetic-marking-token"}
    assert _contract("AttemptPrepareResponse")(**response).model_dump(mode="json") == response


def test_preparation_model_declares_only_the_new_snapshot_table():
    preparation = getattr(models, "AttendancePreparation", None)
    assert preparation is not None, "Missing B3 preparation model"
    table = preparation.__table__
    assert table.name == "attendance_preparations"
    assert list(table.primary_key.columns.keys()) == ["nonce"]
    assert set(table.columns.keys()) == {
        "nonce", "employee_id", "device_id", "action", "attendance_record_id",
        "marked_at", "expires_at", "latitude", "longitude", "accuracy_m",
        "age_ms", "observed_at", "address", "employee_name", "employee_code", "created_at",
    }
    assert {key.target_fullname for key in table.foreign_keys} == {
        "employees.id", "attendance_devices.id", "attendance_records.id"
    }
    assert {column.name for column in table.columns if column.nullable} == {
        "device_id", "attendance_record_id", "address", "employee_code"
    }
    assert {index.name for index in table.indexes} == {
        "ix_attendance_preparations_employee_id", "ix_attendance_preparations_device_id",
        "ix_attendance_preparations_attendance_record_id", "ix_attendance_preparations_marked_at",
    }
    for name in ("marked_at", "expires_at", "observed_at", "created_at"):
        assert table.columns[name].type.timezone is True
    assert "ck_attendance_preparation_action" in {item.name for item in table.constraints}


def test_public_alembic_offline_upgrade_is_additive_without_backfill():
    output = StringIO()
    command.upgrade(
        _offline_config(output), f"{BASE_REVISION}:{PREPARATION_REVISION}", sql=True
    )
    sql = output.getvalue()
    assert re.findall(r"CREATE TABLE (\w+)", sql) == ["attendance_preparations"]
    assert set(re.findall(r"CREATE INDEX (\w+)", sql)) == {
        "ix_attendance_preparations_employee_id", "ix_attendance_preparations_device_id",
        "ix_attendance_preparations_attendance_record_id", "ix_attendance_preparations_marked_at",
    }
    assert PREPARATION_REVISION in sql and BASE_REVISION in sql
    assert re.findall(r"(?im)^\s*UPDATE\s+(\w+)", sql) == ["alembic_version"]
    assert not re.search(r"(?i)\b(ALTER TABLE|DROP TABLE|DROP INDEX|INSERT INTO|DELETE FROM)\b", sql)


def test_public_alembic_offline_downgrade_refuses_audit_deletion():
    output = StringIO()
    with pytest.raises(
        RuntimeError,
        match="La preparación de ubicación es evidencia auditable y no se revierte automáticamente",
    ):
        command.downgrade(
            _offline_config(output), f"{PREPARATION_REVISION}:{BASE_REVISION}", sql=True
        )
    assert not re.search(r"(?i)\b(DROP|DELETE|ALTER)\b", output.getvalue())


def test_existing_status_shape_does_not_activate_preparation_before_b4():
    assert schemas.AttemptStatusResponse(state="PENDING").model_dump() == {
        "state": "PENDING", "record": None, "evidence_ready": False,
        "write_token_valid": False, "can_restart": False, "nonce": None,
        "resolution_id": None, "reason": None,
    }
