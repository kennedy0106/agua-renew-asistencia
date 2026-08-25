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

## Estado — Fase 7 (panel de asistencia para jefes)

- [x] `GET /api/v1/attendance` (autenticado) con filtros: employee_id, date_from, date_to, status
- [x] Cada fila incluye minutos trabajados, **esperados (jornada vigente en la fecha)** y **diferencia**
- [x] `GET /api/v1/attendance/summary`: empleados activos, presentes hoy, sin entrada, entradas abiertas, con salida hoy
- [x] Frontend `/admin/attendance`: tabla con filtros (empleado/fechas/estado), esperado/diferencia coloreada
- [x] Dashboard con "Resumen de hoy" (5 indicadores) + tarjeta de acceso a Asistencia
- [x] Tests: 102 en verde (6 nuevos del panel: permisos, filtros, esperado/diferencia, summary)
- [x] Smoke test real contra Neon: lista con esperado 480 y diferencia, summary correcto

## Estado — Fase 6 (marcación de asistencia)

- [x] Modelo `attendance_records` (check_in/out UTC, work_date en America/Lima, worked_minutes, status) + migración `143700847e10` en Neon
- [x] Endpoints públicos (sin auth): `POST /attendance/identify` (DNI o código), `POST /check-in`, `POST /check-out`
- [x] Reglas: hora SIEMPRE del servidor (nunca navegador); doble entrada → 409; salida sin entrada → 409; empleado inactivo → 403 (identify incluido); mensaje genérico si no existe
- [x] `worked_minutes` = duración − refrigerio de la jornada vigente en la fecha, nunca negativo
- [x] Frontend público `/asistencia`: identificar → marcar entrada/salida → confirmación; hora del servidor en Lima; home enlaza a marcación y panel
- [x] Tests: 96 en verde (14 nuevos; detectaron y corrigieron 2 bugs: identify no bloqueaba inactivos y tzinfo naive en SQLite)
- [x] Smoke test real contra Neon: identify (10:42 Lima) → check-in 201 → check-out COMPLETE con worked_minutes clamp correcto

## Estado — Fase 5 (configuración salarial)

- [x] Modelo `salary_settings` (sueldo NUMERIC(12,2) + horas extra + vigencia) + migración `c22981aa3b4f` en Neon
- [x] **Privacidad salarial: TODO el router exige ADMIN/BOSS** — SUPERVISOR recibe 403 incluso para leer (MVP §6)
- [x] Métodos de horas extra: PERCENTAGE | FIXED_RATE | MANUAL con validación cruzada (422 si falta porcentaje/tarifa)
- [x] Vigencia histórica: S/1300 → S/1500 crea nueva configuración y cierra la anterior; consulta por `?date=`
- [x] Dinero en Decimal/NUMERIC (nunca float); >2 decimales rechazado
- [x] Frontend: sección Sueldo en detalle de empleado (solo ADMIN/BOSS): formulario con método condicional + historial
- [x] Tests: 82 en verde (14 nuevos: privacidad supervisor, vigencia, Decimal, 422, 409)
- [x] Smoke test real contra Neon: sueldo S/1500.00 + HE 25% creado y leído con precisión

## Estado — Fase 4 (jornadas laborales)

- [x] Modelo `work_schedules` (minutos por día + `break_minutes` + vigencia) + migración `a41fb691bf12` en Neon; check constraint de minutos ≥ 0
- [x] Endpoints: `GET /employees/{id}/schedule` (con `?date=` opcional), `GET /schedule/history`, `POST /employees/{id}/schedule` (ADMIN y BOSS)
- [x] `ScheduleService.expected_minutes(employee, date)`: jornada vigente en la fecha; 0 si no hay jornada o día no laborable
- [x] Vigencia histórica: cambiar jornada cierra la anterior (`effective_to` = día anterior); solapamiento → 409
- [x] Frontend: detalle `/admin/employees/[id]` con jornada actual, historial y formulario en horas (backend guarda minutos)
- [x] Tests: 68 en verde (12 nuevos de jornadas: días, cambio histórico, 409, permisos, sin jornada, 422)
- [x] Smoke test real contra Neon: crear empleado → jornada L-S 480/D 0 → consulta por fecha (lunes 480)

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
