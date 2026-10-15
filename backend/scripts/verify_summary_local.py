"""Run summary regressions in an isolated source-only copy, without production config.

Usage (from backend): .venv/Scripts/python.exe -I -B scripts/verify_summary_local.py
No installation, Git operations, deployment, network service or production DB is needed.
Scratch evidence is retained under the explicitly authorized Windows temp subtree.
"""
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


# This exact external subtree was authorized for summary verification.
SCRATCH_ROOT = Path("C:/Users/USER/AppData/Local/Temp/agua-summary-verify")
TESTS = [
    "tests/test_attendance_summary_performance.py",
    "tests/test_attendance_summary_timing.py",
    "tests/test_attendance_admin.py",
    "tests/test_summary_local_runner.py",
]


def source_files(source):
    for name in ("app", "tests", "scripts"):
        yield from sorted((source / name).rglob("*.py"))
    yield source / "pyproject.toml"


def fingerprints(source):
    return {
        str(path.relative_to(source)): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in source_files(source)
    }


def copy_sources(source, target):
    for path in source_files(source):
        destination = target / path.relative_to(source)
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, destination)


def isolated_environment(runtime, inherited):
    environment = {
        key: value for key, value in inherited.items()
        if key.upper() in {"SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT"}
    }
    environment.update({
        "HOME": str(runtime), "USERPROFILE": str(runtime),
        "TEMP": str(runtime), "TMP": str(runtime),
        "APPDATA": str(runtime), "LOCALAPPDATA": str(runtime),
        "ENVIRONMENT": "development", "DATABASE_URL": "",
        "DATABASE_URL_UNPOOLED": "", "PYTHONDONTWRITEBYTECODE": "1",
        "AWS_EC2_METADATA_DISABLED": "true", "AWS_DEFAULT_REGION": "us-east-1",
    })
    return environment


BOOTSTRAP = """
import sys
from pathlib import Path
sys.path.insert(0, str(Path.cwd()))
sys.path.insert(0, str(Path.cwd() / 'tests'))
from app.core.config import Settings
Settings.model_config['env_file'] = None
from app.db.session import engine
assert engine is None, 'Refusing verification with a configured application engine'
import pytest
raise SystemExit(pytest.main(sys.argv[1:]))
"""


def main():
    source = Path(__file__).resolve().parents[1]
    before = fingerprints(source)
    SCRATCH_ROOT.mkdir(parents=True, exist_ok=True)
    # Use native Python paths: do not pass Windows absolute paths to nested Bash/mktemp.
    scratch = Path(tempfile.mkdtemp(prefix="summary-", dir=SCRATCH_ROOT))
    target, runtime = scratch / "backend", scratch / "runtime"
    runtime.mkdir()
    copy_sources(source, target)
    if fingerprints(target) != before:
        raise RuntimeError("Isolated source copy does not match the candidate")
    environment = isolated_environment(runtime, os.environ)
    print(f"ISOLATED_COPY={scratch}", flush=True)
    print("SOURCE_COPY_MATCH=1; DOTENV_DISABLED=1; DATABASE_URL_EMPTY=1", flush=True)
    result = subprocess.run(
        [sys.executable, "-I", "-B", "-c", BOOTSTRAP, "-q", "-p", "no:cacheprovider",
         "--basetemp", str(runtime / "pytest"), "-m", "not integration and not live_s3", *TESTS],
        cwd=target, env=environment, check=False,
    )
    unchanged = fingerprints(source) == before
    print(f"SOURCE_UNCHANGED={int(unchanged)}", flush=True)
    print(f"FOCUSED_EXIT={result.returncode}", flush=True)
    return result.returncode if unchanged else 1


if __name__ == "__main__":
    raise SystemExit(main())
