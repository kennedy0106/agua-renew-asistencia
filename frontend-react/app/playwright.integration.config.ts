import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright (integración) para el frontend React + Vite.
 *
 * Requiere un backend de Asistencia escuchando en el origen configurado por
 * `VITE_API_URL` (por defecto http://localhost:8000) y se habilita de forma
 * explícita para no ejecutarse por accidente en la suite de UI:
 *
 *   E2E_INTEGRATION=1 npm run test:e2e:integration
 */
if (process.env.E2E_INTEGRATION !== "1") {
  throw new Error("E2E_INTEGRATION=1 es obligatorio para playwright.integration.config.ts");
}

export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.integration\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  use: {
    baseURL: "http://127.0.0.1:3000",
    permissions: ["camera"],
    launchOptions: {
      args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
    },
    trace: "on-first-retry",
  },
  webServer: {
    // Igual que la suite de UI: build de producción servido por `vite preview`
    // en el mismo origen que espera el backend (cookie SameSite=Lax).
    command: "npm run build && npm run preview -- --host 127.0.0.1 --port 3000",
    url: "http://127.0.0.1:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
  projects: [{ name: "chromium-integration", use: { ...devices["Desktop Chrome"] } }],
});
