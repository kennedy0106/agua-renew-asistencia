"""Aplicación FastAPI — Fase 0 (base del proyecto).

Endpoints de esta fase:
- GET /health     → contrato de salud básico: {"status": "ok"}
- GET /health/db  → verifica conexión real a PostgreSQL (DATABASE_URL)
"""

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text

from app.core.config import get_settings
from app.core.object_store import ObjectStoreError, get_object_store
from app.db.session import engine
from app.modules.adjustments.router import router as adjustments_router
from app.modules.attendance.router import router as attendance_router
from app.modules.attendance.manual_router import router as manual_attendance_router
from app.modules.attendance.agenda_router import router as attendance_agenda_router
from app.modules.audit.router import router as audit_router
from app.modules.auth.router import router as auth_router
from app.modules.devices.router import router as devices_router
from app.modules.employees.router import router as employees_router
from app.modules.exports.router import router as exports_router
from app.modules.job_roles.router import router as job_roles_router
from app.modules.overtime.router import router as overtime_router
from app.modules.overtime_policy.router import router as overtime_policy_router
from app.modules.payroll.router import router as payroll_router
from app.modules.salary.router import router as salary_router
from app.modules.schedules.router import router as schedules_router
from app.modules.system_roles.router import router as system_roles_router
from app.modules.users.router import router as users_router
from app.modules.work_calendar.router import router as work_calendar_router

settings = get_settings()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    try:
        get_object_store()
    except ObjectStoreError as exc:
        raise RuntimeError(f"Almacén de evidencias no disponible: {exc}") from exc
    yield


app = FastAPI(title=settings.app_name, version="0.1.0", lifespan=lifespan)

# CORS: solo orígenes conocidos (nunca "*" en producción con cookies).
if settings.environment == "production":
    origins = [settings.frontend_url]
else:
    origins = ["http://localhost:3000", "http://127.0.0.1:3000"]
    extra = (settings.frontend_url or "").strip()
    if extra and extra not in origins:
        origins.append(extra)

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
app.include_router(employees_router)
app.include_router(schedules_router)
app.include_router(salary_router)
app.include_router(attendance_router)
app.include_router(manual_attendance_router)
app.include_router(attendance_agenda_router)
app.include_router(devices_router)
app.include_router(audit_router)
app.include_router(adjustments_router)
app.include_router(overtime_router)
app.include_router(overtime_policy_router)
app.include_router(payroll_router)
app.include_router(users_router)
app.include_router(system_roles_router)
app.include_router(exports_router)
app.include_router(work_calendar_router)
