# Build con uv (imagen oficial de astral) — Railway usa Dockerfile automáticamente.
FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim

WORKDIR /app

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    PYTHONUNBUFFERED=1

COPY pyproject.toml uv.lock alembic.ini ./
COPY alembic ./alembic
COPY app ./app
COPY scripts ./scripts

# Instala dependencias + el proyecto (editable). Sin dev.
RUN uv sync --frozen --no-dev

EXPOSE 8000

# Migraciones idempotentes al arrancar (conexión directa, ver alembic/env.py),
# luego el servidor en el puerto que Railway asigne ($PORT).
CMD ["sh", "-c", "uv run alembic upgrade head && uv run uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
