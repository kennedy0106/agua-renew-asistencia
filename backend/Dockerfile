# Build con uv (imagen oficial de astral) — Railway usa Dockerfile automáticamente.
# Base fijada por digest OCI inmutable, verificado en el registro público
# (multi-arch) el 2026-10-05: ghcr.io/v2/astral-sh/uv/manifests/python3.12-bookworm-slim
FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim@sha256:e5b65587bce7de595f299855d7385fe7fca39b8a74baa261ba1b7147afa78e58

WORKDIR /app

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    PYTHONUNBUFFERED=1

COPY pyproject.toml uv.lock alembic.ini ./
COPY alembic ./alembic
COPY app ./app
COPY scripts ./scripts

# Solo build: instala dependencias bloqueadas desde uv.lock (sin dev).
# No hay sincronización de dependencias en runtime.
RUN uv sync --frozen --no-dev

EXPOSE 8000

# Servidor únicamente: ejecuta el venv ya instalado, sin migraciones
# automáticas ni `uv run`. `exec` reemplaza a `sh` para reenviar señales
# (SIGTERM de Railway) y respeta el `$PORT` asignado (fallback 8000).
CMD ["sh", "-c", "exec /app/.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
