import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright (UI) para el frontend React + Vite.
 *
 * `testMatch` cubre los specs `*.ui.spec.ts` (smoke y verificación de
 * interfaz). El smoke de login vive en `e2e/login.ui.spec.ts` y no requiere
 * backend: comprueba render, deep-link fallback y controles básicos.
 *
 * El servidor se levanta con Vite (`vite preview` sobre el build de producción)
 * en el mismo host/puerto que usa el frontend para conservar el origen del
 * backend (cookie SameSite=Lax) y evitar los dobles efectos de StrictMode en
 * desarrollo. `npm run test:e2e` es autocontenido: el `webServer` construye
 * antes de servir.
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.ui\.spec\.ts/,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  use: {
    baseURL: "http://127.0.0.1:3000",
    permissions: ["camera"],
    launchOptions: {
      args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
    },
    trace: "on-first-retry",
  },
  webServer: {
    // Se ejecuta contra el bundle de producción (`vite preview`). Así la suite
    // mide el artefacto que se despliega y evita los efectos duplicados que
    // React.StrictMode provoca solo en modo desarrollo.
    command: "npm run build && npm run preview -- --host 127.0.0.1 --port 3000",
    url: "http://127.0.0.1:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
  projects: [{ name: "chromium-ui", use: { ...devices["Desktop Chrome"] } }],
});
