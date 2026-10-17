"""UTC marking DTO compatibility; prepared HTTP flows are added with preparation."""
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest

from app.modules.attendance.schemas import AttendanceRecordOut


def _utc_response(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    assert parsed.tzinfo is not None, f"marking response has no timezone: {value}"
    assert parsed.utcoffset() == timedelta(0)
    return parsed


def _dto(start, end):
    metadata_time = datetime(2030, 1, 2, 3, 4, 5, 123456)
    return AttendanceRecordOut(
        id=uuid4(), employee_id=uuid4(), work_date=start.date(),
        check_in_at=start, check_out_at=end, worked_minutes=None,
        status="OPEN" if end is None else "COMPLETE", notes="unchanged",
        created_at=metadata_time, updated_at=metadata_time,
    )


@pytest.mark.parametrize("tz", [None, timezone(timedelta(hours=3))], ids=["sqlite-naive", "aware-offset"])
def test_json_normalizes_marking_dates_without_mutating_python_values_or_metadata(tz):
    start = datetime(2030, 1, 2, 12, 34, 56, 123456, tzinfo=tz)
    end = start + timedelta(hours=8)
    dto = _dto(start, end)
    before = dto.model_dump(mode="python")
    payload = dto.model_dump(mode="json")
    expected_start = start.replace(tzinfo=timezone.utc) if tz is None else start.astimezone(timezone.utc)
    expected_end = end.replace(tzinfo=timezone.utc) if tz is None else end.astimezone(timezone.utc)
    assert _utc_response(payload["check_in_at"]) == expected_start
    assert _utc_response(payload["check_out_at"]) == expected_end
    assert dto.model_dump(mode="python") == before
    assert dto.check_in_at is start
    assert dto.check_out_at is end
    assert payload["created_at"] == before["created_at"].isoformat()
    assert payload["updated_at"] == before["updated_at"].isoformat()
    assert payload["notes"] == before["notes"]
    assert payload["status"] == before["status"]


@pytest.mark.parametrize("closed", [False, True], ids=["nullable-checkout", "aware-checkout"])
def test_existing_aware_utc_json_and_nullable_checkout_are_preserved(closed):
    start = datetime(2030, 1, 2, 12, 34, 56, tzinfo=timezone.utc)
    end = start + timedelta(hours=8) if closed else None
    dto = _dto(start, end)
    payload = dto.model_dump(mode="json")
    assert payload["check_in_at"] == "2030-01-02T12:34:56Z"
    assert payload["check_out_at"] == ("2030-01-02T20:34:56Z" if closed else None)
    assert dto.model_dump(mode="python")["check_in_at"] == start
    assert dto.model_dump(mode="python")["check_out_at"] == end


def test_marking_schema_preserves_requiredness_and_nullability(client):
    def assert_contract(schema):
        assert {"check_in_at", "check_out_at"} <= set(schema["required"])
        entry = dict(schema["properties"]["check_in_at"])
        entry.pop("title", None)
        assert entry == {"type": "string", "format": "date-time"}
        checkout = dict(schema["properties"]["check_out_at"])
        checkout.pop("title", None)
        assert checkout == {
            "anyOf": [
                {"type": "string", "format": "date-time"},
                {"type": "null"},
            ]
        }

    for mode in ("validation", "serialization"):
        assert_contract(AttendanceRecordOut.model_json_schema(mode=mode))

    response = client.get("/openapi.json")
    assert response.status_code == 200, response.text
    document = response.json()
    for route, code in (("check-in", "201"), ("check-out", "200")):
        response_schema = document["paths"][f"/api/v1/attendance/{route}"]["post"]["responses"][code]["content"]["application/json"]["schema"]
        name = response_schema["$ref"].rsplit("/", 1)[1]
        assert_contract(document["components"]["schemas"][name])
