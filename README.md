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
