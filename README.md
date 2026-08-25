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

## Estado — Fase 12 (pantalla de sueldos)

- [x] `GET /api/v1/payroll/periods/{id}/summary`: totales del periodo calculados por el backend (base, HE, manual, total, empleados)
- [x] Frontend `/admin/salaries`: selector de periodo, tarjetas de totales, tabla con detalle de liquidación expandible (trabajado/esperado/HE/ajustes/notas)
- [x] Acceso ADMIN/BOSS (403 supervisor); 404 periodo inexistente
- [x] Tests: 162 en verde (3 nuevos del resumen con 2 empleados y 2 métodos de HE)
- [x] Smoke test real contra Neon: resumen del periodo cerrado = 1500 + 9.01 + 50 = 1559.01

## Estado — Fase 11 (motor de payroll)

- [x] Modelos `payroll_periods` (OPEN/CALCULATED/CLOSED) y `payroll_records` (snapshot completo) + migración `92df4e589f79` en Neon
- [x] Flujo: crear periodo (sin solapes, 409) → calcular → ajuste manual con motivo (auditado) → confirmar/cerrar (inmutable)
- [x] Cálculo por empleado ACTIVO con sueldo vigente: total = sueldo base + horas extra aprobadas (método del salary_settings) + ajuste manual; sin sueldo → no incluido
- [x] Ajustes de horas NO cambian el monto automáticamente (nada automático en dinero); quedan como referencia en adjustment_minutes
- [x] Recalcular permitido pre-cierre (reemplaza preview); tras CLOSED → 409; confirmar sin calcular → 409
- [x] Frontend `/admin/payroll`: periodos, calcular/recalcular, tabla con ajuste manual inline, confirmar y cerrar
- [x] Tests: 159 en verde (15 nuevos de payroll)
- [x] Smoke test real contra Neon: María → 1500 + HE 9.01 = 1509.01 → +50 viáticos = 1559.01 → CLOSED → recalcular 409

## Estado — Fase 10 (horas extra)

- [x] Tipo `OVERTIME` en hour_adjustments (minutos deben ser positivos, 422 si no)
- [x] `GET /employees/{id}/overtime/detect`: días con sobretiempo (trabajado > esperado) — solo informativo, ADMIN/BOSS
- [x] `GET /employees/{id}/overtime/value`: valor SOLO de ajustes OVERTIME APROBADOS según método del salary_settings vigente (PERCENTAGE/FIXED_RATE/MANUAL); overtime_enabled=false → 0; pendientes excluidos
- [x] Tarifa por hora DERIVADA: sueldo mensual / minutos esperados del mes (jornada real); fallback documentado 240 h
- [x] Dinero en Decimal con redondeo a céntimos
- [x] Frontend: bloque "Horas extra" en detalle del empleado (detectar → registrar como HE → aprobar) + valor con método/tarifa
- [x] Tests: 144 en verde (11 nuevos: detección, 4 métodos/estados, pendiente excluido, permisos, 422)
- [x] Smoke test real contra Neon: detect 0 días (correcto), HE +60 aprobada → PERCENTAGE tarifa 7.2115 → S/ 9.01

## Estado — Fase 9 (permisos, recuperación de horas y saldo)

- [x] Modelo `hour_adjustments` (tipo PERMISO/RECUPERACION/OTRO, ±minutos, PENDING/APPROVED/REJECTED) + migración `27ebe1b0b42a` en Neon
- [x] Crear ajustes: ADMIN/BOSS (decisión documentada: el SUPERVISOR registra incidencias de marcación, no ajustes); listar y ver saldo: cualquier autenticado
- [x] Aprobar/rechazar: ADMIN/BOSS, solo PENDING (409 si ya resuelto), rechazo con motivo, ambos con auditoría
- [x] **Saldo = trabajado − esperado + ajustes APROBADOS**; nada automático: la diferencia negativa queda como saldo a recuperar
- [x] Frontend: sección "Ajustes y saldo" en detalle de empleado (4 tarjetas de balance + lista con aprobar/rechazar)
- [x] Tests: 133 en verde (18 nuevos: permisos, aprobación/rechazo, saldo con pendientes excluidos, rango inválido)
- [x] Smoke test real contra Neon: +120 RECUPERACION aprobado → balance 480−12480+120

## Estado — Fase 8 (correcciones y auditoría)

- [x] Modelo `audit_logs` (old/new en JSONB, reason, performed_by) + migración `0201cd2b1d1e` en Neon
- [x] `PATCH /api/v1/attendance/{id}` (ADMIN+BOSS) con **motivo obligatorio**; el backend recalcula work_date, worked_minutes y status
- [x] Corrección sin cambios → 409; limpiar salida (null) vuelve el registro a OPEN
- [x] `GET /api/v1/audit-logs` — **solo ADMIN** (SUPERVISOR y BOSS → 403), filtros entity_type/entity_id
- [x] Frontend: botón "Corregir" en `/admin/attendance` (formulario con motivo) + página `/admin/audit` con old→new
- [x] Tests: 115 en verde (13 nuevos: motivo obligatorio, permisos, recálculo con refrigerio, cruce de medianoche, old/new en bitácora)
- [x] Smoke test real contra Neon: corrección 08:00→17:00 Lima = 480 min; bitácora con admin y motivo

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
