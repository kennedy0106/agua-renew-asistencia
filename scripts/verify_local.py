"""Reproduce locally the checks in .github/workflows/ci.yml.

Exit code is preserved even when output is also written to a log.
Does not talk to Neon or production object storage.
"""

from __future__ import annotations

import os
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
FRONTEND = ROOT / "frontend"


class LoggedError(SystemExit):
    """Non-zero exit that already printed the failing step."""


def _emit(text: str, log) -> None:
    log.write(text)
    log.flush()
    try:
        sys.stdout.write(text)
    except UnicodeEncodeError:
        encoding = sys.stdout.encoding or "cp1252"
        sys.stdout.write(text.encode(encoding, errors="replace").decode(encoding, errors="replace"))
    sys.stdout.flush()


def _port_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.3)
        return sock.connect_ex(("127.0.0.1", port)) != 0


def _pick_api_port() -> int:
    for port in (8000, 8001, 8010):
        if _port_free(port):
            return port
    raise LoggedError("No hay puerto libre para FastAPI (8000/8001/8010 ocupados)")


def _require_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise LoggedError(f"Falta {name}. La verificación local no omite destinos de prueba.")
    return value


def _http_ok(url: str, timeout: float = 2.0) -> bool:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            return 200 <= response.status < 300
    except (urllib.error.URLError, TimeoutError, OSError):
        return False


def _resolve_cmd(name: str) -> str:
    found = shutil.which(name)
    if found:
        return found
    if os.name == "nt":
        for ext in (".cmd", ".exe", ".bat"):
            found = shutil.which(f"{name}{ext}")
            if found:
                return found
    return name


def _tcp_ok(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(1)
        return sock.connect_ex((host, port)) == 0


def _run(cmd: list[str], *, cwd: Path, env: dict[str, str], log) -> None:
    resolved = [_resolve_cmd(cmd[0]), *cmd[1:]]
    printable = " ".join(cmd)
    header = f"\n>>> {printable}\n    cwd={cwd}\n"
    _emit(header, log)
    proc = subprocess.Popen(
        resolved,
        cwd=str(cwd),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    assert proc.stdout is not None
    for line in proc.stdout:
        _emit(line, log)
    proc.wait()
    if proc.returncode:
        _emit(f"\nERROR: comando falló con código {proc.returncode}: {printable}\n", log)
        raise LoggedError(proc.returncode)


def _versions(env: dict[str, str], log) -> None:
    _run(["uv", "run", "python", "--version"], cwd=BACKEND, env=env, log=log)
    _run(["node", "--version"], cwd=FRONTEND, env=env, log=log)
    docker = subprocess.run(
        ["docker", "ps", "--format", "{{.Names}} {{.Status}} {{.Ports}}"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    block = docker.stdout or docker.stderr or ""
    _emit(block, log)


def _require_reachable(url: str, what: str) -> None:
    parsed = urlparse(url.replace("postgresql+psycopg", "postgresql", 1))
    host = parsed.hostname or "127.0.0.1"
    port = parsed.port or (5432 if parsed.scheme.startswith("postgresql") else 80)
    if not _tcp_ok(host, port):
        raise LoggedError(f"{what} no responde en {host}:{port}. No se omiten destinos de prueba.")


def _copy_playwright(out_dir: Path, label: str) -> None:
    for name in ("playwright-report", "test-results"):
        src = FRONTEND / name
        if not src.exists():
            continue
        dest = out_dir / f"{label}-{name}"
        if dest.exists():
            shutil.rmtree(dest)
        shutil.copytree(src, dest)


def _require_no_skipped_required(junit_path: Path) -> None:
    tree = ET.parse(junit_path)
    skipped: list[str] = []
    needles = (
        "TEST_DATABASE_URL",
        "ALLOW_TEST_DB_RESET",
        "OBJECT_STORE",
        "esquema",
    )
    for case in tree.iter("testcase"):
        node = case.find("skipped")
        if node is None:
            continue
        reason = node.get("message") or (node.text or "").strip() or "skipped"
        if not any(needle.lower() in reason.lower() for needle in needles):
            continue
        file_name = case.get("file") or case.get("classname") or ""
        skipped.append(f"{file_name}::{case.get('name')}: {reason}")
    if skipped:
        raise LoggedError("Se omitieron pruebas obligatorias de Postgres o S3:\n" + "\n".join(skipped))


def main() -> None:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out_dir = ROOT / ".local-verify" / stamp
    out_dir.mkdir(parents=True, exist_ok=True)
    log_path = out_dir / "verify.log"
    env = os.environ.copy()
    env["VERIFY_LOCAL"] = "1"
    env["ALLOW_TEST_DB_RESET"] = env.get("ALLOW_TEST_DB_RESET") or "1"
    env["TEST_DATABASE_URL"] = _require_env("TEST_DATABASE_URL")
    env["DATABASE_URL"] = env.get("DATABASE_URL") or env["TEST_DATABASE_URL"]
    env["DATABASE_URL_UNPOOLED"] = env.get("DATABASE_URL_UNPOOLED") or env["TEST_DATABASE_URL"]
    env["OBJECT_STORE_ENDPOINT"] = _require_env("OBJECT_STORE_ENDPOINT")
    env["OBJECT_STORE_ACCESS_KEY"] = _require_env("OBJECT_STORE_ACCESS_KEY")
    env["OBJECT_STORE_SECRET_KEY"] = _require_env("OBJECT_STORE_SECRET_KEY")
    env["OBJECT_STORE_BUCKET"] = env.get("OBJECT_STORE_BUCKET", "").strip() or "asistencia-evidence"
    env["OBJECT_STORE_REGION"] = env.get("OBJECT_STORE_REGION", "").strip() or "us-east-1"
    env["SECRET_KEY"] = env.get("SECRET_KEY") or "e2e-asistencia-secret-key-32chars!!"
    env["ENVIRONMENT"] = "development"
    env["E2E_INTEGRATION"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUTF8"] = "1"

    if env["ALLOW_TEST_DB_RESET"] != "1":
        raise LoggedError("ALLOW_TEST_DB_RESET=1 es obligatorio")

    _require_reachable(env["TEST_DATABASE_URL"], "PostgreSQL de prueba")
    _require_reachable(env["OBJECT_STORE_ENDPOINT"], "Almacén S3 de prueba")
    if not _port_free(3000):
        raise LoggedError(
            "El puerto 3000 está ocupado. Playwright con CI=true no reutiliza Next y no puede arrancar."
        )

    with log_path.open("w", encoding="utf-8") as log:
        log.write(f"verify_local {stamp}\n")
        try:
            _versions(env, log)
            _run(["uv", "sync", "--group", "dev"], cwd=BACKEND, env=env, log=log)
            _run(
                [
                    "uv",
                    "run",
                    "pytest",
                    "-q",
                    f"--junitxml={out_dir / 'pytest-junit.xml'}",
                ],
                cwd=BACKEND,
                env=env,
                log=log,
            )
            _require_no_skipped_required(out_dir / "pytest-junit.xml")
            _run(["npm", "ci"], cwd=FRONTEND, env=env, log=log)
            _run(["npm", "run", "lint"], cwd=FRONTEND, env=env, log=log)
            api_port = _pick_api_port()
            api_url = f"http://127.0.0.1:{api_port}"
            env["NEXT_PUBLIC_API_URL"] = api_url
            env["E2E_API_URL"] = api_url
            _run(["npm", "run", "build"], cwd=FRONTEND, env=env, log=log)
            for root in (FRONTEND / ".next" / "static", FRONTEND / ".next" / "server"):
                if not root.exists():
                    continue
                for path in root.rglob("*"):
                    if not path.is_file() or "dev" in path.parts:
                        continue
                    text = path.read_bytes()
                    if b"__E2E_KIOSK" in text:
                        raise LoggedError(f"El bundle contiene el bypass de cámara sintético: {path}")
            _run(["npx", "playwright", "install", "chromium"], cwd=FRONTEND, env=env, log=log)
            ui_env = env.copy()
            ui_env["CI"] = "true"
            _run(["npm", "run", "test:e2e"], cwd=FRONTEND, env=ui_env, log=log)
            _copy_playwright(out_dir, "e2e-ui")

            _run(["uv", "run", "alembic", "upgrade", "head"], cwd=BACKEND, env=env, log=log)
            _run(["uv", "run", "python", "-m", "scripts.seed_e2e_kiosk"], cwd=BACKEND, env=env, log=log)
            api_log = out_dir / "fastapi.log"
            api_proc = subprocess.Popen(
                [
                    "uv",
                    "run",
                    "uvicorn",
                    "app.main:app",
                    "--host",
                    "127.0.0.1",
                    "--port",
                    str(api_port),
                ],
                cwd=str(BACKEND),
                env=env,
                stdout=api_log.open("w", encoding="utf-8"),
                stderr=subprocess.STDOUT,
            )
            try:
                ready = False
                for _ in range(40):
                    if _http_ok(f"{api_url}/health"):
                        ready = True
                        break
                    time.sleep(1)
                if not ready:
                    raise LoggedError(f"FastAPI no respondió en {api_url}/health")
                integ_env = env.copy()
                integ_env["CI"] = "true"
                _run(["npm", "run", "test:e2e:integration"], cwd=FRONTEND, env=integ_env, log=log)
                _copy_playwright(out_dir, "e2e-integration")
            finally:
                api_proc.terminate()
                try:
                    api_proc.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    api_proc.kill()

            _run(["git", "diff", "--check"], cwd=ROOT, env=env, log=log)
        except LoggedError as exc:
            log.write(f"\nFAILED {exc.code if isinstance(exc.code, int) else exc}\n")
            raise
        log.write("\nOK\n")
        summary = out_dir / "SUMMARY.txt"
        summary.write_text(
            f"OK {stamp}\nlog={log_path}\npytest={out_dir / 'pytest-junit.xml'}\n"
            f"playwright_ui={out_dir / 'e2e-ui-playwright-report'}\n"
            f"playwright_integration={out_dir / 'e2e-integration-playwright-report'}\n",
            encoding="utf-8",
        )
        sys.stdout.write(f"\nVerificación local OK. Reportes en {out_dir}\n")


if __name__ == "__main__":
    try:
        main()
    except LoggedError as exc:
        code = exc.code if isinstance(exc.code, int) else 1
        sys.exit(code)
