import { defineConfig, devices } from "@playwright/test";

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
  },
  webServer: {
    command: "npm run start -- --hostname 127.0.0.1 --port 3000",
    url: "http://127.0.0.1:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [{ name: "chromium-integration", use: { ...devices["Desktop Chrome"] } }],
});
