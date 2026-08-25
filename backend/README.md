# Backend — MVP Asistencia Agua ReNew

API FastAPI del MVP de asistencia y cálculo interno de remuneraciones.

## Requisitos

- Python ≥ 3.11
- [uv](https://docs.astral.sh/uv/) (gestor de proyectos)

## Instalación y ejecución local

```bash
uv sync                 # instala dependencias (crea .venv)
cp .env.example .env    # completar DATABASE_URL (Neon o Postgres local)
uv run uvicorn app.main:app --reload
```

- Health check: `GET http://localhost:8000/health` → `{"status": "ok"}`
- Estado BD: `GET http://localhost:8000/health/db`

## Tests

```bash
uv run pytest
```

## Migraciones (Alembic)

```bash
uv run alembic upgrade head
```

## Estructura

```text
app/
├── main.py          # FastAPI + CORS + health checks
├── core/            # config (env), timezone (America/Lima)
└── db/              # base declarativa + sesión
tests/               # pytest
alembic/             # migraciones (Fase 0: inicializado, sin modelos)
```
