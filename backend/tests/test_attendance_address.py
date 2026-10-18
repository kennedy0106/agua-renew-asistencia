"""B5 optional enrichment through public marking HTTP; no real provider traffic."""

from datetime import datetime, timedelta
import urllib.error
import urllib.parse

import pytest

from app.core.config import get_settings
from app.modules.attendance import evidence_media
from tests.test_attendance_hardening import _employee, _login
from tests.test_attendance_location import (
    LOCATION,
    _evidence,
    _identify,
    _prepare_ok,
    _records,
    _summary,
)
from tests.test_evidence_media import FakeClock, FakeOpener, FakeResponse, json_payload

ADDRESS = "Referencia sintética de Lima"
API_KEY = "synthetic-b5-key-not-secret"


@pytest.fixture
def address_transport(monkeypatch):
    """Own only the pure helper's synthetic state and fake transport."""
    evidence_media._reset_state()
    clock = FakeClock()
    sleeps = []

    def fake_sleep(seconds):
        sleeps.append(seconds)
        clock.value += seconds

    opener = FakeOpener()
    monkeypatch.setattr(evidence_media, "_OPENER", opener)
    monkeypatch.setattr(evidence_media, "_monotonic", clock)
    monkeypatch.setattr(evidence_media, "_sleep", fake_sleep)
    monkeypatch.setattr(get_settings(), "geoapify_api_key", "")
    yield opener, sleeps
    evidence_media._reset_state()


def _mark_and_read_snapshot(client, action, expected_status, expected_address, opener):
    prior_requests = len(opener.requests)
    token = _identify(client)
    reserved = _prepare_ok(client, token)
    assert reserved["location"]["address"] is None
    assert len(opener.requests) == prior_requests
    assert datetime.fromisoformat(reserved["expires_at"]) - datetime.fromisoformat(
        reserved["marked_at"]
    ) == timedelta(minutes=5)
    prepared_token = reserved["marking_token"]
    photo = _evidence(
        client,
        prepared_token,
        color=(10, 20, 30) if action == "check-in" else (30, 20, 10),
    )
    assert photo.status_code == 201, photo.text
    assert len(opener.requests) == prior_requests
    response = client.post(
        f"/api/v1/attendance/{action}", json={"marking_token": prepared_token}
    )
    assert response.status_code == expected_status, response.text
    record = response.json()
    time_field = "check_in_at" if action == "check-in" else "check_out_at"
    assert datetime.fromisoformat(record[time_field]) == datetime.fromisoformat(
        reserved["marked_at"]
    )

    # Observe persistence through the existing owned-nonce HTTP snapshot, not SQL.
    before_records = _records(client)
    before_summary = _summary(client)
    stored = _prepare_ok(client, prepared_token)
    assert stored["marked_at"] == reserved["marked_at"]
    assert stored["expires_at"] == reserved["expires_at"]
    assert stored["location"]["address"] == expected_address
    assert {k: v for k, v in stored["location"].items() if k != "address"} == {
        k: v for k, v in reserved["location"].items() if k != "address"
    }
    assert _records(client) == before_records
    assert _summary(client) == before_summary
    return reserved, record


def _complete_shift(client, db_session, expected_address, opener):
    _login(client)
    _employee(client, db_session)
    assert _records(client) == []
    entry, opened = _mark_and_read_snapshot(
        client, "check-in", 201, expected_address, opener
    )
    assert opened["status"] == "OPEN"
    assert len(_records(client)) == 1
    leave, closed = _mark_and_read_snapshot(
        client, "check-out", 200, expected_address, opener
    )
    assert closed["id"] == opened["id"]
    assert closed["status"] == "COMPLETE"
    expected_minutes = int(
        (
            datetime.fromisoformat(leave["marked_at"])
            - datetime.fromisoformat(entry["marked_at"])
        ).total_seconds()
    ) // 60
    assert closed["worked_minutes"] == expected_minutes
    records = _records(client)
    assert len(records) == 1
    assert records[0]["id"] == closed["id"]
    assert records[0]["status"] == "COMPLETE"
    assert records[0]["worked_minutes"] == expected_minutes


def _assert_fake_requests(opener, expected_count):
    assert len(opener.requests) == expected_count
    assert opener.timeouts == [4.0] * expected_count
    for request in opener.requests:
        url = urllib.parse.urlsplit(request.full_url)
        assert (url.scheme, url.netloc, url.path) == (
            "https", "api.geoapify.com", "/v1/geocode/reverse"
        )
        query = urllib.parse.parse_qs(url.query)
        assert float(query["lat"][0]) == LOCATION["latitude"]
        assert float(query["lon"][0]) == LOCATION["longitude"]
        assert query["apiKey"] == [API_KEY]


def test_sin_clave_conserva_entrada_salida_y_no_consulta(
    client, db_session, address_transport
):
    opener, sleeps = address_transport
    _complete_shift(client, db_session, None, opener)
    _assert_fake_requests(opener, 0)
    assert sleeps == []


def test_direccion_opcional_se_persiste_sin_mover_hora_gps_o_plazo(
    client, db_session, monkeypatch, address_transport
):
    monkeypatch.setattr(get_settings(), "geoapify_api_key", API_KEY)
    opener = FakeOpener(FakeResponse(json_payload(ADDRESS)))
    monkeypatch.setattr(evidence_media, "_OPENER", opener)
    _complete_shift(client, db_session, ADDRESS, opener)
    # Both confirmations enrich; the second uses the unchanged coordinate cache.
    _assert_fake_requests(opener, 1)
    assert address_transport[1] == []


@pytest.mark.parametrize("failure", ["timeout", "quota429"])
def test_error_o_cuota_no_impiden_entrada_salida(
    client, db_session, monkeypatch, address_transport, failure
):
    monkeypatch.setattr(get_settings(), "geoapify_api_key", API_KEY)
    error = (
        TimeoutError("synthetic timeout")
        if failure == "timeout"
        else urllib.error.HTTPError(
            "https://api.geoapify.com/v1/geocode/reverse", 429,
            "Synthetic quota exhausted", {}, None,
        )
    )
    opener = FakeOpener(error=error)
    monkeypatch.setattr(evidence_media, "_OPENER", opener)
    _complete_shift(client, db_session, None, opener)
    # Failure must actually be exercised, not silently bypassed by the old no-op.
    _assert_fake_requests(opener, 2)
    assert all(0 < wait <= 0.25 for wait in address_transport[1])


def test_settings_tiene_geoapify_opcional_vacio():
    settings = get_settings()
    assert hasattr(settings, "geoapify_api_key")
    assert settings.geoapify_api_key == ""
