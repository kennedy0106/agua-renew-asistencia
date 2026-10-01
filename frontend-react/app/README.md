# Asistencia — frontend React + Vite

Migración del frontend Next.js (`agua-renew-erp/frontend`) a una app
**React 19 + Vite 8 + TypeScript** con React Router. Conserva la paridad
funcional con las pantallas originales y aplica el sistema visual definido en
las muestras de Stitch de Agua ReNew.

## Diseño Stitch y marca

- `src/styles/stitch.css` concentra los tokens, superficies, controles,
  navegación y breakpoints derivados de las muestras de Stitch.
- `src/components/AdminShell.tsx` aplica la navegación lateral y la barra
  superior común; el dashboard y el kiosco reproducen además la composición de
  sus pantallas de referencia.
- La tipografía se sirve localmente con **Plus Jakarta Sans** para títulos y
  métricas, e **Inter** para interfaz y tablas; no depende de una CDN.
- Los logotipos oficiales se reutilizan desde `public/brand/`: el logo a color
  aparece en login, navegación y kiosco, y la gota se usa en estados compactos.
- Las 17 rutas comparten el mismo lenguaje visual responsive y mantienen los
  contratos, permisos y datos reales de la aplicación.

## Estado: React desplegado en producción

El cutover se ejecutó el **2026-10-01**. El dominio operativo
[`agua-renew-asistencia.vercel.app`](https://agua-renew-asistencia.vercel.app)
sirve React + Vite mediante el deployment productivo
`dpl_8MrtDwd9aXgimyhCU3j5uZ8qNPym`, promovido desde el preview validado
`dpl_F8XePJTYNfgt4UAfcL5niKfL7j91`. El deployment Next anterior
`dpl_C1WZbpGSi2zciCEvoZeRSHdYtTM8` se conserva como rollback. La evidencia y
el procedimiento están en [`CUTOVER.md`](./CUTOVER.md).

Las **17 rutas** del frontend Next están migradas. Ninguna ruta productiva cae
en un catch-all de "migración pendiente": el único catch-all es el **404 real**
(`NotFoundPage`), y está blindado por pruebas unitarias
(`src/__tests__/routing.test.tsx`).

| Ruta | Página (componente) |
| --- | --- |
| `/` | `HomePage` |
| `/asistencia` | `AsistenciaPage` |
| `/admin/login` | `AdminLoginPage` |
| `/admin/change-password` | `AdminChangePasswordPage` |
| `/admin/dashboard` | `AdminDashboardPage` |
| `/admin/account` | `AdminAccountPage` |
| `/admin/attendance` | `AdminAttendancePage` |
| `/admin/attendance/history` | `AdminAttendanceHistoryPage` |
| `/admin/audit` | `AdminAuditPage` |
| `/admin/devices` | `AdminDevicesPage` |
| `/admin/employees` | `AdminEmployeesPage` |
| `/admin/employees/:id` | `AdminEmployeeDetailPage` |
| `/admin/overtime-policy` | `AdminOvertimePolicyPage` |
| `/admin/payroll` | `AdminPayrollPage` |
| `/admin/roles` | `AdminRolesPage` |
| `/admin/salaries` | `AdminSalariesPage` |
| `/admin/users` | `AdminUsersPage` |
| *(cualquier otra)* | `NotFoundPage` (404 real) |

### Guardas de `/admin`

`src/layouts/AdminLayout.tsx` envuelve a todas las rutas `/admin/*` y resuelve
la sesión **una sola vez** (`/auth/me`), exponiéndola por contexto
(`AdminSessionContext`) y renderizando la pantalla hija con `<Outlet />`:

- `/admin/login` limpia cualquier hint de sesión previo y muestra el formulario.
- Sin sesión válida (`401`) borra el hint y redirige a `/admin/login`.
- Con `must_change_password` fuerza `/admin/change-password`; sin él, ese
  destino redirige de vuelta a `/admin/dashboard`.
- Mientras la sesión no está resuelta, se bloquea el contenido privado con una
  pantalla de guarda (nunca se pinta información privada).

Cada página privada provee su propio `AdminShell` (salvo login y cambio de
contraseña, que tampoco lo usaban en Next).

## Comandos

```bash
npm ci                 # instalación reproducible desde package-lock.json
npm run dev            # Vite en http://localhost:3000 (strictPort)
npm run preview        # sirve el build en http://localhost:3000 (strictPort)
npm run build          # tsc --noEmit && vite build
npm run lint           # ESLint acotado a src/ + vite.config.ts
npm test               # Vitest + Testing Library (incluye preflight)
npm run test:watch     # Vitest en modo watch
npm run preflight      # valida vercel.json + VITE_API_URL (desarrollo, permisivo)
npm run preflight:prod # mismo contrato estricto que Vercel preview/production
npm run test:e2e       # Playwright (UI): e2e/*.ui.spec.ts
npm run test:e2e:integration  # Playwright (integración), requiere backend
```

`npm run build` **no** ejecuta el preflight; Vercel sí lo hace porque su
`buildCommand` es `npm run preflight && npm run build` (ver `vercel.json` y
[`CUTOVER.md`](./CUTOVER.md) §3.1).

## Entorno

`VITE_API_URL` es la **única** variable que consume el frontend. Es pública
(termina en el bundle del navegador): **nunca** pongas secretos en variables
`VITE_*`. Copia `.env.example` a `.env` solo para desarrollo local.

```bash
VITE_API_URL=http://localhost:8000
```

En Vercel la variable se define **por entorno** (Development / Preview /
Production), no en un `.env` versionado. Se inyecta en tiempo de **build**, así
que cambiarla exige re-desplegar:

| Entorno | `VITE_API_URL` |
| --- | --- |
| Development | `http://localhost:8000` |
| Preview | URL HTTPS del backend de preview/staging |
| Production | URL del backend productivo (Railway) |

El `preflight` es **estricto en Vercel preview y production**: el build falla si
la variable no está definida o apunta a loopback (`localhost`, `127.0.0.1`,
`[::1]`), y también si no usa HTTPS. Configurarla en Vercel es un **gate
humano** previo al preview→promote.

El API se consume con `fetch` y `credentials: "include"`; el hint de sesión se
guarda solo para presentación en `sessionStorage`
(`agua-renew-admin-session-hint`) y **siempre** se revalida contra
`/api/v1/auth/me`.

Mantener `localhost:3000` (host/puerto del dev server y del preview) preserva el
origen que espera el backend para que la cookie `SameSite=Lax` no se trate como
cookie entre sitios **en desarrollo local**. En producción Vercel↔Railway son
**cross-site** y exigen `SameSite=None; Secure` más `FRONTEND_URL` en el
backend; ver [`CUTOVER.md`](./CUTOVER.md) §4.

## SPA: deep-link fallback / rewrites

La app usa `BrowserRouter`, así que **cualquier** ruta (por ejemplo
`/admin/employees/123`) debe servir `index.html` y dejar que React Router
resuelva en el cliente. Reglas:

- **Vite dev y `vite preview`**: ya sirven `index.html` como fallback; los
  deep-links funcionan sin configuración extra.
- **Servidor estático (nginx)**:

  ```nginx
  location / {
    try_files $uri $uri/ /index.html;
  }
  ```

- **Vercel (producción)**: `vercel.json` ya declara el rewrite
  `/(.*) → /index.html`, y `preflight` lo valida. Falta únicamente verificarlo
  en el preview real (una ruta profunda debe devolver `200` de la SPA).
- **CDN / otros**: configurar un rewrite de `404` hacia `/index.html`
  (o `/* -> /index.html`) respetando los archivos reales de `dist/`
  (`assets/`, `brand/`, `fonts/`, `favicon.ico`).
- **Base path**: si la app no se sirve en la raíz del dominio, ajustar
  `base` en `vite.config.ts` y el `basename` de `BrowserRouter`.

La suite de UI verifica el fallback: `e2e/login.ui.spec.ts` navega directo a
`/admin/login` y a una ruta desconocida esperando **HTTP 200** servido por la
SPA (no un 404 del servidor).

## Pruebas

### Unitarias (Vitest + Testing Library)

```bash
npm test
```

Cobertura relevante:

- `src/__tests__/routing.test.tsx`: las 17 rutas resuelven a su página y nunca
  al catch-all; una ruta desconocida llega al 404 real.
- `src/layouts/__tests__/AdminLayout.test.tsx`: guardas de sesión (`/me`, hint,
  `401`, `must_change_password`).
- `src/pages/__tests__/*`: login y portada.

> Las pruebas de rutas sustituyen las páginas por marcadores deterministas y el
> `AdminLayout` por un `<Outlet />`, de modo que valgan la sesión y la red.

### UI (Playwright)

```bash
npm run test:e2e
```

`npm run test:e2e` es autocontenido: el `webServer` construye la app
(`npm run build`) y la sirve con `vite preview` en `http://127.0.0.1:3000`, de
modo que la suite corre contra el bundle de producción (sin los dobles efectos
de `React.StrictMode` en desarrollo) y conserva `permissions: ["camera"]` y los
flags de cámara simulada. El spec `e2e/login.ui.spec.ts` es un smoke **sin
backend**: formulario de login, toggle de contraseña, navegación SPA, deep-link
fallback y 404 de la SPA.

Instalación del navegador (una vez por máquina):

```bash
npx playwright install chromium
```

### Integración (Playwright, requiere backend)

```bash
E2E_INTEGRATION=1 npm run test:e2e:integration
```

Usa `playwright.integration.config.ts` (gated por `E2E_INTEGRATION=1`) y
`e2e/*.integration.spec.ts`. Necesita el backend de Asistencia escuchando en
`VITE_API_URL` (por defecto `http://localhost:8000`) con datos de prueba y la
cookie de sesión disponible. Si el navegador o el servidor no están disponibles,
la configuración queda lista y el comando reporta el bloqueo exacto.

## Estructura

```
app/
  index.html                 # metadata/viewport portados
  vite.config.ts             # alias "@", server/preview localhost:3000, Vitest
  eslint.config.js           # flat config (sin Next)
  playwright.config.ts       # Playwright UI (*.ui.spec.ts)
  playwright.integration.config.ts  # Playwright integración (*.integration.spec.ts)
  e2e/                       # specs de Playwright
  src/
    main.tsx                 # BrowserRouter + estilos
    App.tsx                  # mapa de las 17 rutas
    layouts/AdminLayout.tsx  # guardas de sesión + <Outlet />
    styles/                  # globals.css, fonts.css, utilities.css
    lib/api.ts               # ApiError + clientes de API
    components/              # AdminShell, AdminSession, Icons, Loading, ...
    pages/                   # una por ruta
    test/setup.ts            # setup de Vitest
  public/                    # brand/, fonts/geist/
```

## Sustituciones de Next.js

| Antes (Next) | Ahora (Vite + React Router) |
| --- | --- |
| `next/link` | `react-router-dom` `Link` con `to` |
| `next/image` | `<img>` (los SVG no se optimizaban) |
| `useRouter().replace` | `useNavigate(..., { replace: true })` |
| `next/font/google` (Geist) | `@font-face` local sobre `public/fonts/geist` |
| `metadata` / `viewport` de layout | `<meta>` en `index.html` |
| `NEXT_PUBLIC_API_URL` | `import.meta.env.VITE_API_URL` |
| App Router (`app/**`) | `react-router-dom` `<Routes>` |
| `app/admin/layout.tsx` | `src/layouts/AdminLayout.tsx` (`<Outlet />`) |

`globals.css` se reutiliza completo para máxima paridad. Las utilidades de
Tailwind que usaba el layout original (`h-full`, `min-h-full`, `flex`,
`flex-col`, `antialiased`) se reproducen como CSS plano en `utilities.css`;
estas pantallas no usan Tailwind.

## Cutover (pasar de Next a React)

El procedimiento completo, ejecutable y con gates está en
[`CUTOVER.md`](./CUTOVER.md). **La preparación repo-side ya está hecha**
(`vercel.json`, `preflight`, tests, gates de CI); lo que queda son gates
humanos. Resumen de la arquitectura real:

- **No es same-site.** El frontend React se sirve como estático en **Vercel**
  y el API en **Railway**: orígenes distintos → **cross-site**. El backend debe
  tener `FRONTEND_URL` con el origen exacto del frontend y la cookie de sesión
  en `SameSite=None; Secure` (producción). El cutover *same-site* en
  `localhost:3000` solo aplica al desarrollo local.
- **Gate humano 1 — proyecto Vercel.** La producción operativa verificada es
  `agua-renew-asistencia.vercel.app`, coincide con
  `frontend/.vercel/project.json` y consume la API Railway vigente. El proyecto
  `agua-renew-erp-frontend` es legacy y apunta a una API retirada; no debe
  tratarse como rollback sano sin reconfigurarlo. Confirmar explícitamente el
  objetivo antes de promover.
- **Gate humano 2 — entornos.** Definir `VITE_API_URL` en Development, Preview
  y Production; el `preflight` es estricto en Vercel preview y production, así
  que el build falla si falta, es loopback o no usa HTTPS.
- **Config lista:** `vercel.json` fija framework Vite, `npm ci`,
  `npm run preflight && npm run build`, output `dist` y el rewrite
  `/(.*) → /index.html` para deep-links.
- **CI:** el job `frontend-react` exige que `frontend-react/app` esté
  versionado en el commit y corre `npm ci → lint → test → preflight:prod
  → build → Playwright UI`, verifica que `dist/` no contenga
  `__E2E_KIOSK` y publica `frontend-react-dist-candidate`. No despliega.

Validación local/CI previa (bloqueante): `npm ci && npm run lint && npm test &&
npm run build && npm run preflight:prod && npm run test:e2e`, más la
integración (`E2E_INTEGRATION=1 npm run test:e2e:integration`).

## Rollback (volver al frontend Next)

Ver [`CUTOVER.md`](./CUTOVER.md) §8. En alto nivel:

1. Re-apuntar el alias de producción con `vercel rollback` o
   `vercel promote <deployment-producción-anterior>` (guardar ese ID/URL antes
   de promover). El frontend Next (`frontend/`) y su proyecto Vercel se
   conservan intactos durante la ventana.
2. Revertir en el backend cualquier cambio de `FRONTEND_URL`/cookie a la
   configuración que servía al frontend Next.
3. Verificar el rollback con `/`, `/admin/login`, `/auth/me` y una ruta
   profunda, no solo con el alias.

No se requiere migración de datos: ambos frontends consumen el mismo API.
