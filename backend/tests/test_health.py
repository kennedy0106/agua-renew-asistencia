"""Tests de Fase 0: health checks."""

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health_returns_ok() -> None:
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_health_db_reports_estado_sin_mentir() -> None:
    """Sin DATABASE_URL debe decir not_configured; con BD, ok o error real."""
    response = client.get("/health/db")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] in {"ok", "not_configured", "error"}
