# agua-renew-erp

**MVP de Asistencia y Cálculo Interno de Remuneraciones — Agua ReNew**

Primer módulo (Personal) del futuro ERP de Agua ReNew. Alcance actual:
asistencia, horas, saldo, horas extra y cálculo interno de sueldo por
periodo. **No** incluye planilla legal (AFP/ONP/CTS/SUNAT/boletas).

## Stack

| Capa | Tecnología | Hosting |
|---|---|---|
| Frontend | Next.js + TypeScript + Tailwind | Vercel |
| Backend | FastAPI + SQLAlchemy 2 + Alembic + pytest | Railway |
| Base de datos | PostgreSQL | Neon |

## Estructura

```text
agua-renew-erp/
├── frontend/   # Next.js (App Router, TS, Tailwind)
├── backend/    # FastAPI + SQLAlchemy + Alembic + pytest
├── docs/       # Especificaciones (fuente de verdad)
└── README.md
```

## Documentos fuente (fuente de verdad)

- `docs/agua_renew_mvp_asistencia_hermes.md` — alcance funcional y técnico del MVP.
- `docs/agua_renew_plan_desarrollo_modulos_fases.md` — orden de fases, dependencias y Definition of Done.

## Estado — Fase 3 (gestión de empleados)

- [x] Modelo `employees` + migración `004a0c1cd919` aplicada a Neon (incluye FK de `users.employee_id` → employees, deuda de Fase 1 cerrada)
- [x] Endpoints: `GET /api/v1/employees` (lista con filtros active/search, autenticado), `GET /{id}`, `POST`, `PATCH /{id}`, `POST /{id}/deactivate`
- [x] **Permisos (decisión de negocio): crear/editar/desactivar = ADMIN y JEFE (BOSS)**; SUPERVISOR solo consulta
- [x] Reglas: DNI 8 dígitos (422), DNI y código únicos (409), cargo debe existir, cesado = INACTIVO (nunca se borra)
- [x] Frontend `/admin/employees`: lista + filtros (estado/búsqueda), crear, editar en línea, desactivar/activar
- [x] Tests: 56 en verde (18 nuevos de empleados: permisos ADMIN/BOSS/SUPERVISOR, DNI inválido/duplicado, código duplicado, 404, filtros, desactivación)
- [x] Smoke test real contra Neon: login → crear (UTF-8) → búsqueda → desactivar → historial visible

## Estado — Fase 2 (cargos laborales)

- [x] Modelo `job_roles` + migración `8a415d406af1` aplicada a Neon
- [x] Endpoints: `GET /api/v1/job-roles` (autenticado), `POST` y `PATCH /{id}` (solo ADMIN)
- [x] Reglas: nombre obligatorio (post-strip), sin duplicados activos (409), desactivar en vez de borrar, nombre reutilizable tras desactivar
- [x] Frontend `/admin/roles`: tabla, crear, editar en línea, activar/desactivar (UI de gestión solo para ADMIN)
- [x] Tests: 38 en verde (incluye 13 nuevos de cargos: permisos, 409, 422, 404, reutilización de nombre)
- [x] Smoke test real contra Neon: login → crear (UTF-8) → listar

## Estado — Fase 1 (autenticación y permisos)

- [x] Modelos `system_roles` (ADMIN/BOSS/SUPERVISOR) y `users` — migración `41113f50ab64` aplicada a Neon
- [x] Contraseñas con **Argon2** (nunca texto plano, nunca hash débil)
- [x] Sesión = **JWT en cookie HttpOnly + SameSite** (Secure en producción); el frontend nunca toca el token
- [x] Dependencias de permisos: `require_any_role("ADMIN", ...)`, verificadas en backend
- [x] Endpoints: `POST /api/v1/auth/login`, `POST /api/v1/auth/logout`, `GET /api/v1/auth/me`
- [x] Seed idempotente de roles + script seguro de primer ADMIN (clave por flag/prompt, nunca en el repo)
- [x] Tests: 25 en verde (login ok/incorrecto/inactivo, sin auth, roles, logout, seed, Argon2, JWT)
- [x] Frontend: `/admin/login` + `/admin/dashboard` (sesión verificada contra el backend)
- [ ] Pendiente de decisión: SameSite=None+Secure cuando frontend (Vercel) y backend (Railway) sean cross-site (Fase 16)

### Operación de Fase 1

```bash
cd backend
uv run python -m scripts.seed_roles                       # idempotente, siembra los 3 roles
uv run python -m scripts.create_admin --username admin    # pide la contraseña por prompt
uv run alembic upgrade head                               # aplicar migraciones
```

## Estado — Fase 0 (base del proyecto)

- [x] Monorepo creado
- [x] Backend FastAPI con `GET /health` (verificado: `{"status":"ok"}`)
- [x] SQLAlchemy + Alembic inicializados (sin modelos aún)
- [x] pytest con tests de health (2/2 en verde)
- [x] Frontend Next.js mínimo (pantalla temporal)
- [x] Variables de entorno documentadas (`.env.example`)
- [x] Conexión real a PostgreSQL — proyecto Neon **agua-renew-asistencia**
      (org Kennedy, aws-us-east-2). Verificado: `GET /health/db` →
      `{"status":"ok","database":"connected"}`; `SELECT 1` OK en conexión
      pooled y directa.

### Neon (infraestructura)

- Proyecto: `agua-renew-asistencia` (`bitter-darkness-86548080`), rama `main`.
- `backend/.env` (gitignored) tiene `DATABASE_URL` (pooled, para la app) y
  `DATABASE_URL_UNPOOLED` (directa, para Alembic) — generado con
  `neon env pull --file backend/.env`.
- Las migraciones usan SIEMPRE la conexión directa (ver `alembic/env.py`).
- CLI de Neon v4.3.1; MCP server instalado global (configurado para Codex);
  skills de Neon en `.agents/skills/` (proyecto) y enlazadas a Hermes Agent.
- Contexto: `.neon` (orgId/projectId, seguro de commitear).

## Arranque local

### Backend

```bash
cd backend
uv sync
cp .env.example .env   # completar DATABASE_URL
uv run uvicorn app.main:app --reload   # http://localhost:8000
uv run pytest
```

### Frontend

```bash
cd frontend
npm install
npm run dev            # http://localhost:3000
```

## Reglas que este repositorio respeta (no negociables)

1. El backend es la única fuente de verdad: el frontend nunca calcula
   horas, saldos ni montos.
2. Dinero en `Decimal`/`NUMERIC` (nunca `float`); duraciones en minutos.
3. Empleados ≠ usuarios del sistema; cargos laborales ≠ roles del sistema.
4. No se borran empleados con historial (cesado = `INACTIVO`).
5. Horas extra y saldo negativo nunca se aplican automáticamente:
   el jefe clasifica.
6. Sueldo y jornada son históricos (`effective_from`/`effective_to`);
   periodos cerrados quedan inmutables (snapshot).
7. Toda corrección sensible pide motivo y genera auditoría.
8. Payroll se construye después de asistencia.
9. Si una regla de negocio no está definida: configurable o pendiente de
   decisión del jefe — nunca inventar políticas irreversibles.
