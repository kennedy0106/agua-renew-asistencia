"""Aplicación FastAPI — Fase 0 (base del proyecto).

Endpoints de esta fase:
- GET /health     → contrato de salud básico: {"status": "ok"}
- GET /health/db  → verifica conexión real a PostgreSQL (DATABASE_URL)
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text

from app.core.config import get_settings
from app.db.session import engine
from app.modules.auth.router import router as auth_router
from app.modules.job_roles.router import router as job_roles_router

settings = get_settings()

app = FastAPI(title=settings.app_name, version="0.1.0")

# CORS: solo orígenes conocidos (nunca "*" en producción con cookies).
if settings.environment == "production":
    origins = [settings.frontend_url]
else:
    origins = ["http://localhost:3000", "http://127.0.0.1:3000"]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict:
    """Contrato de salud: la app responde."""
    return {"status": "ok"}


@app.get("/health/db")
def health_db() -> dict:
    """Estado de la conexión a PostgreSQL.

    Sin DATABASE_URL → not_configured (la app sigue viva).
    Con DATABASE_URL → verifica un SELECT 1 real.
    """
    if engine is None:
        return {"status": "not_configured", "detail": "DATABASE_URL no está configurado"}
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        return {"status": "ok", "database": "connected"}
    except Exception as exc:  # noqa: BLE001 — el health debe reportar, no propagar
        return {"status": "error", "detail": str(exc)}


# --- Módulos (cada fase registra sus rutas aquí) ---
app.include_router(auth_router)
app.include_router(job_roles_router)
