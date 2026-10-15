# Cutover Next → React (Vercel) — runbook ejecutable

> **Estado de este documento:** cutover **ejecutado y verificado el
> 2026-10-01**. React + Vite sirve el dominio productivo. Este archivo conserva
> tanto la evidencia real como el procedimiento de rollback; no contiene
> tokens ni secretos.

## 0. Objetivo y límites

- **Objetivo:** cambiar el frontend servido en producción de
  `frontend/` (Next.js, rollback) a `frontend-react/app/` (React 19 + Vite,
  objetivo), sin tocar datos ni el backend.
- **Límites:**
  - El backend FastAPI/Neon/Railway **no cambia de contrato**.
  - El frontend Next (`dpl_C1WZbpGSi2zciCEvoZeRSHdYtTM8`) se conserva Ready
    como rollback hasta cerrar la ventana.
  - Este documento **no** contiene tokens ni secretos.

## 1. Verdad operativa actual (no asumir)

| Hecho | Evidencia | Implicación |
| --- | --- | --- |
| Producción operativa = `https://agua-renew-asistencia.vercel.app` | React/Vite `dpl_8MrtDwd9aXgimyhCU3j5uZ8qNPym`, Ready y con alias productivo el 2026-10-01 | El cutover está activo. |
| Preview promovido | `dpl_F8XePJTYNfgt4UAfcL5niKfL7j91`; mismo ETag `d6159c695824aa51f163ebde918505a2` que producción | La promoción reutilizó el artefacto validado, sin recompilar código. |
| Proyecto Vercel objetivo | `agua-renew-asistencia`, ID `prj_fBwdfyiWW6t6ilK2I3BG3n1UeDxy`, org `team_ma8d6RYsMlXGwt1VcPZfqjYb` | Preset Vite, Node 22.x, `npm ci`, preflight+build y `dist` alineados después del corte. |
| `agua-renew-erp-frontend` (ID `prj_RSSiT1RRVkCqzMgKp9s62lRHsBnG`) sigue publicado como legacy | Vercel `dpl_EogVEvVfT6APpFDAGK6n1pUWQ7ib` + bundle verificado | Apunta a la URL Railway retirada `...-fe69...` y el backend vigente rechaza su origen CORS; **no** es rollback sano sin reconfiguración. |
| API productiva vigente = `https://backend-api-production-3eb3.up.railway.app` | `railway status`, `/health` y `/health/db` = 200 | CORS admite `https://agua-renew-asistencia.vercel.app` con credenciales. |
| Rollback Next | `dpl_C1WZbpGSi2zciCEvoZeRSHdYtTM8`, Ready | Se conserva dentro del mismo proyecto y puede recuperarse con `vercel rollback`/`promote`. |
| `vercel.json` presente: framework Vite, `installCommand: npm ci`, `buildCommand: npm run preflight && npm run build`, `outputDirectory: dist`, rewrite SPA | `frontend-react/app/vercel.json` | SPA y fallback de deep-links ya resueltos (Gate C). |
| `preflight` valida `VITE_API_URL` y `vercel.json`; es **estricto** en Vercel preview y production | `frontend-react/app/scripts/preflight.mjs` + `preflight.test.mjs` | El build de Vercel falla si falta `VITE_API_URL`, apunta a loopback o no usa HTTPS. |
| CI exige que `frontend-react/app` esté versionado en el commit construido | job `frontend-react` ("Gate de reemplazo") en `.github/workflows/ci.yml` | El commit a construir debe incluir el directorio. |

> **Resultado del corte:** el alias productivo sirve React. El bundle apunta a
> `backend-api-production-3eb3.up.railway.app`, no contiene la URL retirada
> `...-fe69...` ni el marcador `__E2E_KIOSK`, y las rutas profundas reciben el
> fallback de la SPA.

## 2. Checklist de gates (bloqueantes vs. opcionales)

Leyenda: **[B]** = bloqueante para promover a producción · **[O]** = opcional/mejora.
Los gates **A**, **D** y **E** quedaron resueltos para el origen productivo.

### Gate A — Elegir y verificar el proyecto Vercel objetivo **[B] [HUMANO]**

La evidencia operativa identificó `agua-renew-asistencia` como producción
actual y se reutilizó el mismo proyecto para conservar el dominio:

- [x] **A1 [B]** Proyecto objetivo elegido: reutilizar
      `agua-renew-asistencia` para conservar el dominio operativo.
- [x] **A2 [B]** Reconfirmar con `vercel inspect
      https://agua-renew-asistencia.vercel.app` que el proyecto sigue sirviendo
      producción y confirmar el ID elegido.
- [x] **A3 [B]** Registrar en el ticket: nombre de proyecto, ID de proyecto,
      ID de organización y qué dominio/alias se moverá. Sin tokens en el
      documento.
- [x] **A4 [B]** Confirmar que el proyecto Next de producción y su último
      deployment quedan registrados como punto de rollback (URL + ID), antes de
      cualquier cambio de alias.
- [ ] **A5 [O]** El CI ya expone el gate manual `vercel-target-gate`
      (`workflow_dispatch` → input `vercel_project` con
      `none | agua-renew-erp-frontend | agua-renew-asistencia`). Sirve para
      **dejar constancia** de la elección; no despliega ni elige por sí mismo.
      Si se crea un tercer proyecto nuevo, ese input deberá actualizarse (fuera
      de este encargo).

### Gate B — App React versionada (condición de CI, ya integrada)

- [ ] **B1 [B]** Asegurar que el commit/PR que se construirá incluye
      `frontend-react/app/` (el workflow falla con "frontend-react/app no está
      versionado" si `frontend-react/app/package.json` no está en el commit).
- [x] **B2 [B]** Confirmar que **no** se versionan `node_modules/`, `dist/`,
      `test-results/`, `playwright-report/`, `.env*` (salvo `.env.example`).
- [ ] **B3 [B]** Confirmar que el job `frontend-react` pasa en esa rama
      (`npm ci → lint → test → preflight:prod → build → Playwright UI`),
      valida que `dist/` no incluya `__E2E_KIOSK` y publica el único artifact
      promovible: `frontend-react-dist-candidate`.

### Gate C — Fallback SPA en Vercel ✅ (implementado)

- [x] **C1** `vercel.json` declara `rewrites: [{ source: "/(.*)", destination:
      "/index.html" }]`; `preflight.mjs` lo valida. **No requiere acción.**
- [x] **C2 [B]** Verificación en preview (no en repo): `/admin/employees/<id>` y
      una ruta desconocida responden **HTTP 200 servido por la SPA** (no 404 del
      servidor), igual que cubre `e2e/login.ui.spec.ts`.

### Gate D — Entorno y configuración Vercel **[B] [HUMANO]**

Ver sección 3. `VITE_API_URL` quedó definida en Preview y Production;
Development sigue siendo opcional para el flujo local.

### Gate E — CORS/cookies del backend **[B] [HUMANO]**

Ver sección 4. `FRONTEND_URL`, CORS y la cookie `SameSite=None; Secure` ya
estaban alineados con el dominio productivo y se revalidó el preflight CORS.

## 3. Configuración Vercel del proyecto React

| Ajuste | Valor | Estado |
| --- | --- | --- |
| Framework preset | Vite (`"framework": "vite"`) | En `vercel.json`. |
| **Directorio desplegado** | `frontend-react/app` | El proyecto no tiene integración Git; el CLI se ejecuta desde esta carpeta. |
| Install Command | `npm ci` | En `vercel.json`. |
| Build Command | `npm run preflight && npm run build` | En `vercel.json`; `build` = `tsc --noEmit && vite build`. |
| **Output Directory** | `dist` | En `vercel.json`. |
| Node.js | 22.x | Alinear con CI. |
| Rewrite SPA | `/(.*) → /index.html` | En `vercel.json` (Gate C ✅). |

### 3.1 Preflight (repo-side, sin secretos)

`frontend-react/app/scripts/preflight.mjs` valida, sin desplegar ni leer
secretos:

- `vercel.json`: `outputDirectory === "dist"`, `buildCommand` que construya la
  app y rewrite SPA hacia `/index.html`.
- `VITE_API_URL`: ausente → **error** si el modo es estricto; URL absoluta
  `http(s)`; y en estricto exige **HTTPS** y rechaza loopback (`localhost`,
  `127.0.0.1`, `[::1]`). Esto evita publicar un bundle bloqueado por mixed
  content desde Vercel.

El modo estricto se activa con `--production`/`--prod`, con
`PREFLIGHT_ENV=preview|production`, con `VERCEL_ENV=preview|production`, o con
`VERCEL=1` sin `VERCEL_ENV`. **El build local `npm run build` no se ve
afectado**; en Vercel preview **y** production el build falla si la variable
falta, es loopback o no usa HTTPS.

Comandos: `npm run preflight` (desarrollo, permisivo) y
`npm run preflight:prod` (estricto). Sus pruebas (`scripts/preflight.test.mjs`)
corren en `npm test` (el `include` de Vitest cubre `scripts/**/*.test.mjs`).

### 3.2 Variables de entorno (`VITE_API_URL`) — gate humano

Se definen **en Vercel por entorno** (no en `.env` versionado). Se inyectan en
tiempo de **build**: cambiarlas exige **re-desplegar**.

| Entorno Vercel | `VITE_API_URL` | Uso |
| --- | --- | --- |
| Development | `http://localhost:8000` | `vercel dev` / `vercel env pull` local. |
| Preview | URL HTTPS del backend de preview/staging | Para PRs y validación previa (**estricto**). |
| Production | `https://backend-api-production-3eb3.up.railway.app` (**verificar de nuevo antes de promover**) | API productiva en Railway (**estricto**); `/health` y `/health/db` verificados en 200 el 2026-10-01. |

Reglas:
- [ ] **D1 [B]** `VITE_API_URL` es la **única** variable pública del frontend.
- [ ] **D2 [B]** Nunca poner secretos en variables `VITE_*`: quedan en el bundle
      del navegador.
- [ ] **D3 [B]** Si no existe backend de preview, decidir explícitamente si
      Preview apunta al backend productivo (riesgo de datos reales) o se levanta
      uno de staging. Documentar la decisión. **Recuerda:** Preview también es
      estricto, así que la variable debe existir igualmente.
- [ ] **D4 [O]** Fijar la versión del CLI de Vercel en CI cuando se agregue un
      job de deploy (`vercel@<versión>`).

## 4. CORS y cookies (backend)

Topología de producción: **frontend en Vercel** ↔ **API en Railway**, dominios
distintos → **cross-site**.

Comprobación de solo lectura del 2026-10-01: la API vigente responde 200 en
`/health` y `/health/db`, y su preflight CORS acepta
`Origin: https://agua-renew-asistencia.vercel.app` con
`Access-Control-Allow-Credentials: true`. Por tanto, si el cutover conserva ese
dominio, `FRONTEND_URL` ya coincide; aun así debe reconfirmarse durante el
smoke. El origen legacy `agua-renew-erp-frontend.vercel.app` es rechazado.

- [ ] **E1 [B]** Confirmar que en Railway `FRONTEND_URL` = origen exacto que
      servirá el frontend React (`https://agua-renew-asistencia.vercel.app` si
      se conserva la producción actual). En
      `ENVIRONMENT=production`, `backend/app/main.py` usa **solo**
      `settings.frontend_url` como origen CORS con `allow_credentials=True`.
- [ ] **E2 [B]** Si el dominio de preview difiere del de producción, decidir cómo
      se permite ese origen (variable por entorno o backend de preview). No
      ampliar a `*`.
- [ ] **E3 [B]** Cookie de sesión en producción cross-site:
      `SESSION_COOKIE_SECURE=true` y `SESSION_COOKIE_SAMESITE=none`.
      `lax` solo es válido en desarrollo local (mismo origen).
- [ ] **E4 [B]** `VITE_API_URL` (frontend) y `FRONTEND_URL` (backend) deben
      apuntarse mutuamente; un desajuste produce CORS/`/auth/me` fallido aunque
      el login devuelva 200.
- [ ] **E5 [B]** Verificar en preview con el `Origin` real del deployment:
      login `200` + `Set-Cookie` con `HttpOnly; Secure; SameSite=None`, luego
      `GET /api/v1/auth/me` `200`, y preflight `OPTIONS` correcto.

> El `README.md` de la app describió en su momento un cutover *same-site* en
> `localhost:3000`. Eso **no** aplica a Vercel↔Railway; la fuente correcta es
> esta sección.

## 5. Validación previa (local y CI) **[B]**

Ejecutar en `frontend-react/app`:

```bash
npm ci
npm run lint
npm test          # incluye las pruebas de preflight
npm run preflight:prod   # contrato estricto (mismo que Vercel)
npm run build
npx playwright install chromium
npm run test:e2e
```

- [ ] **V1 [B]** Los comandos terminan en verde.
- [ ] **V2 [B]** Integración con backend real:
      `E2E_INTEGRATION=1 npm run test:e2e:integration` (requiere API y datos de
      prueba).
- [ ] **V3 [B]** Verificar que el bundle `dist/` **no** contiene el bypass de
      cámara sintético (`__E2E_KIOSK`). El job React de CI lo comprueba
      explícitamente sobre `dist/`.
- [ ] **V4 [O]** Repetir `npm ci` desde cero para confirmar reproducibilidad del
      lockfile.
- [ ] **V5 [B]** El job `frontend-react` de CI publica
      `frontend-react-dist-candidate` como único artifact promovible; usar ese
      mismo `dist/` probado si se despliega con `--prebuilt`.

## 6. Preview → promote

Orden ejecutado. En Vercel, el build remoto ejecutó el
`buildCommand` de `vercel.json`, por lo que **el preflight estricto corre
automáticamente** con el `VERCEL_ENV` del entorno:

```bash
# 1) Enlazar/confirmar el proyecto objetivo y traer el entorno de preview.
vercel pull --yes --environment=preview
# 2) Crear el preview con build remoto; ejecuta preflight + build.
vercel deploy --yes --logs
# 3) Inspeccionar y validar dpl_F8XePJTYNfgt4UAfcL5niKfL7j91.
# 4) Promover el deployment validado.
vercel promote dpl_F8XePJTYNfgt4UAfcL5niKfL7j91 --yes
```

El intento de `vercel build` local en Windows terminó en `spawn cmd.exe
ENOENT` después de `npm ci`. Se usó el build remoto estándar de Vercel, donde
el preflight y Vite finalizaron correctamente. La promoción produjo
`dpl_8MrtDwd9aXgimyhCU3j5uZ8qNPym`; su ETag coincide con el preview.

Notas:
- [x] **P1 [B]** Se usó `promote` en lugar de `deploy --prod`.
- [x] **P2 [B]** Guardar el ID/URL del deployment de producción **anterior**
      antes de promover (insumo del rollback).
- [x] **P3 [B]** Confirmar que el `VITE_API_URL` del build promovido corresponde
      al entorno correcto (se fija en build; un promote no lo cambia).
- [ ] **P4 [B]** Si el build de preview/producción falla en preflight, revisar
      `VITE_API_URL`: debe existir, no ser loopback y usar HTTPS. Corregir la
      variable antes de reintentar; no omitir el gate.

## 7. Smoke post-promoción (por roles / kiosco / CSV / deep-links)

Ejecutar contra la URL promovida. Registrar evidencia (captura/HTTP) por fila.

### 7.1 Deep-links SPA **[B]**

| Ruta | Esperado |
| --- | --- |
| `/` | Portada; `200` de la SPA |
| `/asistencia` | Kiosco |
| `/admin/login` | Formulario |
| `/admin/dashboard` | Panel (con sesión) |
| `/admin/employees` y `/admin/employees/<id>` | Lista / detalle |
| `/admin/attendance` y `/admin/attendance/history` | Panel e histórico |
| `/admin/audit` | Auditoría |
| `/admin/devices` | Dispositivos |
| `/admin/overtime-policy` | Política HE |
| `/admin/payroll` | Cálculo |
| `/admin/roles` | Cargos |
| `/admin/salaries` | Sueldos |
| `/admin/users` | Usuarios |
| ruta inexistente | `200` de la SPA + 404 interno (`NotFoundPage`) |

### 7.2 Roles **[B]**

| Rol | Esperado |
| --- | --- |
| Sin sesión | `/admin/*` redirige a `/admin/login`; no se pinta información privada |
| `must_change_password` | Fuerza `/admin/change-password` |
| ADMIN | Acceso completo, incluida auditoría y usuarios |
| BOSS (jefe) | Gestión de empleados/asistencia/payroll; sin auditoría ni usuarios |
| SUPERVISOR | Consulta; `403` en salarios/auditoría (privacidad) |
| Cualquiera | Cambio de contraseña propio y cierre de sesión |

### 7.3 Kiosco `/asistencia` **[B]**

- [ ] Identificación por DNI/código y por QR.
- [ ] Entrada y salida con captura de evidencia (cámara); token efímero.
- [ ] Hora mostrada = hora del **servidor** (America/Lima), nunca del navegador.
- [ ] Recuperación ante respuesta perdida / token vencido (no duplica marcación).
- [ ] Empleado inactivo → mensaje genérico/bloqueo según backend.

### 7.4 CSV **[B]**

- [ ] `GET /api/v1/exports/attendance.csv` (autenticado) descarga con **BOM
      UTF-8** y respeta filtros del panel.
- [ ] `GET /api/v1/exports/salaries.csv?period_id=<id>` (ADMIN/BOSS) con total.
- [ ] `GET /api/v1/exports/salaries-month.csv?year=&month=` (ADMIN/BOSS).
- [ ] Abrir en Excel y verificar acentos y columnas.

### 7.5 Backend/sesión **[B]**

- [x] `/health` y `/health/db` `200`.
- [ ] Login `200` con cookie correcta y `/auth/me` `200` desde el origen real.
- [x] Logs de producción sin errores (`vercel logs <url> --level error`).

## 8. Rollback verificable

Disparador sugerido: smoke fallido, errores en logs o CORS/cookie rota.

Punto de retorno conservado: `dpl_C1WZbpGSi2zciCEvoZeRSHdYtTM8`. Comando
preferido: `vercel rollback dpl_C1WZbpGSi2zciCEvoZeRSHdYtTM8 --yes`.

- [ ] **R1 [B]** Vercel: `vercel rollback` (si el proyecto es el del dominio) o
      `vercel promote <deployment-producción-anterior>` para re-apuntar el alias
      al artefacto anterior.
- [ ] **R2 [B]** Backend: si se cambió `FRONTEND_URL` o la cookie, revertir a la
      configuración que servía al frontend Next y reiniciar el servicio.
- [ ] **R3 [B]** El frontend Next (`frontend/`) **no se borra** durante la
      ventana; su proyecto Vercel y su último deployment se conservan.
- [ ] **R4 [B]** Verificar el rollback, no solo el alias: `/`, `/admin/login`,
      `/auth/me` y una ruta profunda responden con el frontend Next.
- [ ] **R5 [O]** Cerrar la ventana de rollback solo tras N días sin incidencias y
      con decisión explícita del owner; entonces sí retirar el servicio Next.

## 9. Responsabilidades (RACI breve)

| Área | Responsable | Entregable |
| --- | --- | --- |
| Proyecto Vercel / alias / promote / rollback | Owner de infraestructura | Gate A + secciones 6 y 8 |
| Variables Vercel (`VITE_API_URL`) y dominio | Owner de infraestructura | Sección 3.2 |
| `FRONTEND_URL` + cookies (Railway) | Owner backend | Sección 4 |
| Commit versionado y verde de CI | Owner frontend | Gate B + sección 5 |
| Smoke por roles/kiosco/CSV/deep-links | QA / operación | Sección 7 |
| `vercel.json` + preflight (repo-side) | **Ya hecho** | Secciones 1 y 3.1 |
| Este runbook | Documentación | Sin despliegue |

## 10. Pendientes externos (fuera de este repo)

1. **Gate humano:** elegir/verificar el **proyecto Vercel objetivo** (Gate A) y
   crear el proyecto React si la decisión es "nuevo".
2. **Gate humano:** definir y verificar `VITE_API_URL` en Development/Preview/
   Production (sección 3.2) antes del preview→promote.
3. **Gate humano:** `FRONTEND_URL` + `SESSION_COOKIE_SECURE/SAMESITE` en el
   backend (sección 4) y su verificación cross-site.
4. Job de despliegue en CI, si se quiere automatizar preview→promote
   (opcional; hoy CI **valida y no despliega**).
5. Backend de preview/staging o decisión explícita de apuntar Preview a
   producción (Gate D3).
6. Si se crea un proyecto Vercel nuevo, ampliar las opciones del input
   `vercel_project` del workflow (fuera de este encargo).

> La preparación repo-side (`vercel.json`, `preflight`, tests, gates de CI,
> documentación) **ya está hecha**; lo anterior son acciones humanas de
> infraestructura, no cambios de código pendientes.
