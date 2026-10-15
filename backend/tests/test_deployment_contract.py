"""Contrato del Dockerfile de producción: el runtime no modifica la base."""

from __future__ import annotations

import json
import re
from pathlib import Path

DOCKERFILE = Path(__file__).resolve().parents[1] / "Dockerfile"
VERIFIED_BASE_IMAGE = "ghcr.io/astral-sh/uv:python3.12-bookworm-slim"
VERIFIED_BASE_DIGEST = "sha256:e5b65587bce7de595f299855d7385fe7fca39b8a74baa261ba1b7147afa78e58"


def _text() -> str:
    return DOCKERFILE.read_text(encoding="utf-8")


def _run_commands(text: str) -> list[str]:
    return re.findall(r"^\s*RUN\s+(.*)$", re.sub(r"\\\s*\n", " ", text), re.MULTILINE)


def _cmd_script(text: str) -> str:
    match = re.search(r"^\s*CMD\s+(\[.*\])\s*$", text, re.MULTILINE)
    assert match is not None, "Dockerfile must declare an exec-form JSON CMD"
    command = json.loads(match.group(1))
    assert command[:2] == ["sh", "-c"] and len(command) == 3
    return command[2]


def test_base_image_is_pinned_to_verified_digest() -> None:
    images = re.findall(r"^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)", _text(), re.MULTILINE)
    assert images == [f"{VERIFIED_BASE_IMAGE}@{VERIFIED_BASE_DIGEST}"]


def test_build_uses_frozen_runtime_dependencies_without_database_work() -> None:
    runs = _run_commands(_text())
    assert any("uv sync" in run and "--frozen" in run and "--no-dev" in run for run in runs)
    assert not any(re.search(r"\b(alembic|stamp|create_all|psql)\b", run, re.IGNORECASE) for run in runs)


def test_runtime_execs_uvicorn_without_migrations_or_uv() -> None:
    script = _cmd_script(_text())
    assert script.lstrip().startswith("exec /app/.venv/bin/uvicorn app.main:app")
    assert "--host 0.0.0.0" in script and "${PORT:-8000}" in script
    assert not re.search(r"\b(uv|alembic|upgrade|stamp|create_all)\b|&&", script, re.IGNORECASE)
