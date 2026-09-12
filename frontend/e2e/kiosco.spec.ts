import { expect, type Page, type Route } from "@playwright/test";
import { test } from "@playwright/test";

type IdentifyBody = {
  employee: { id: string; first_name: string; last_name: string; job_role_name: string | null; active: boolean };
  state: { has_open_entry: boolean; open_check_in_at: null; last_record: null };
  server_time: string;
  server_time_label: string;
  marking_token: string;
  marking_action: "CHECK_IN";
};

function identifyPayload(firstName: string, token: string): IdentifyBody {
  return {
    employee: {
      id: "11111111-1111-1111-1111-111111111111",
      first_name: firstName,
      last_name: "López",
      job_role_name: "Operario",
      active: true,
    },
    state: { has_open_entry: false, open_check_in_at: null, last_record: null },
    server_time: new Date().toISOString(),
    server_time_label: "ahora",
    marking_token: token,
    marking_action: "CHECK_IN",
  };
}

const CORS = {
  "Access-Control-Allow-Origin": "http://127.0.0.1:3000",
  "Access-Control-Allow-Credentials": "true",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

async function fulfillApi(route: Route, status: number, body: unknown) {
  if (route.request().method() === "OPTIONS") {
    await route.fulfill({ status: 204, headers: CORS });
    return;
  }
  await route.fulfill({
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function installKioskStubs(page: Page) {
  await page.addInitScript(() => {
    (window as unknown as { __E2E_KIOSK: boolean }).__E2E_KIOSK = true;
    navigator.mediaDevices.getUserMedia = async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 640;
      canvas.height = 480;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.fillStyle = "#224466";
        ctx.fillRect(0, 0, 640, 480);
      }
      return canvas.captureStream(8);
    };
    const queued: string[] = [];
    (window as unknown as { __pushQr: (value: string) => void }).__pushQr = (value: string) => {
      queued.push(value);
    };
    class FakeDetector {
      async detect() {
        const raw = queued.shift();
        return raw ? [{ rawValue: raw }] : [];
      }
    }
    (window as unknown as { BarcodeDetector: unknown }).BarcodeDetector = FakeDetector;
  });
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

test.describe("kiosco aislamiento de intentos", () => {
  test.beforeEach(async ({ page }) => {
    await installKioskStubs(page);
  });

  test("a) cancelar durante consulta de reintento no sube evidencia vieja", async ({ page }) => {
    let evidenceCalls = 0;
    const secondStatus = deferred();
    let statusCalls = 0;

    await page.route("**/api/v1/attendance/**", async (route: Route) => {
      if (route.request().method() === "OPTIONS") {
        await fulfillApi(route, 204, {});
        return;
      }
      const url = route.request().url();
      if (url.includes("/identify")) {
        await fulfillApi(route, 200, identifyPayload("Ana", "tok-ana"));
        return;
      }
      if (url.includes("/evidence")) {
        evidenceCalls += 1;
        await fulfillApi(route, 500, { detail: "red" });
        return;
      }
      if (url.includes("/attempt/status")) {
        statusCalls += 1;
        if (statusCalls === 1) {
          await fulfillApi(route, 200, { state: "PENDING", record: null });
          return;
        }
        await secondStatus.promise;
        await fulfillApi(route, 200, { state: "PENDING", record: null });
        return;
      }
      await fulfillApi(route, 404, {});
    });

    await page.goto("/asistencia");
    await expect(page.getByTestId("kiosk-identify")).toBeVisible();
    await page.getByTestId("kiosk-identifier").fill("EMP-001");
    await page.getByTestId("kiosk-identify").click();
    await expect(page.locator("[data-phase='incidencia']")).toBeVisible({ timeout: 20_000 });
    const evidenceBeforeResend = evidenceCalls;
    await page.getByTestId("kiosk-resend").click();
    await page.getByTestId("kiosk-take-another").click();
    await expect(page.locator("[data-phase='identificando']")).toBeVisible();
    secondStatus.resolve();
    await page.waitForTimeout(400);
    expect(evidenceCalls).toBe(evidenceBeforeResend);
    await expect(page.locator("[data-phase='enviando']")).toHaveCount(0);
  });

  test("b) finally de A no desbloquea identificación B", async ({ page }) => {
    const gateA = deferred();
    const gateB = deferred();
    const identified: string[] = [];

    await page.route("**/api/v1/attendance/**", async (route: Route) => {
      if (route.request().method() === "OPTIONS") {
        await fulfillApi(route, 204, {});
        return;
      }
      if (route.request().url().includes("/identify")) {
        const body = JSON.parse(route.request().postData() || "{}") as { identifier?: string };
        identified.push(String(body.identifier));
        if (String(body.identifier).includes("AAA")) {
          await gateA.promise;
          await fulfillApi(route, 200, identifyPayload("Ana", "tok-a"));
          return;
        }
        await gateB.promise;
        await fulfillApi(route, 200, identifyPayload("Luis", "tok-b"));
        return;
      }
      await fulfillApi(route, 404, {});
    });

    await page.goto("/asistencia");
    await page.getByTestId("kiosk-scan-qr").click();
    await expect(page.locator("[data-phase='escaneando_qr']")).toBeVisible();
    await page.evaluate(() => (window as unknown as { __pushQr: (v: string) => void }).__pushQr("AR:AAA"));
    await expect.poll(() => identified.length).toBe(1);
    await page.getByTestId("kiosk-cancel-qr").click();
    await expect(page.locator("[data-phase='identificando']")).toBeVisible();
    await page.getByTestId("kiosk-identifier").fill("EMP-B");
    await page.getByTestId("kiosk-identify").click();
    await expect.poll(() => identified.length).toBe(2);
    gateA.resolve();
    await page.waitForTimeout(300);
    await expect(page.getByTestId("kiosk-identify")).toBeDisabled();
    gateB.resolve();
    await expect(page.getByTestId("kiosk-employee-name")).toContainText("Luis", { timeout: 10_000 });
  });

  test("c) cancelar QR pendiente no identifica", async ({ page }) => {
    let identifyCalls = 0;
    await page.route("**/api/v1/attendance/**", async (route: Route) => {
      if (route.request().method() === "OPTIONS") {
        await fulfillApi(route, 204, {});
        return;
      }
      if (route.request().url().includes("/identify")) {
        identifyCalls += 1;
        await fulfillApi(route, 200, identifyPayload("Ana", "tok-a"));
        return;
      }
      await fulfillApi(route, 404, {});
    });

    await page.goto("/asistencia");
    await page.getByTestId("kiosk-scan-qr").click();
    await expect(page.locator("[data-phase='escaneando_qr']")).toBeVisible();
    await page.getByTestId("kiosk-cancel-qr").click();
    await expect(page.locator("[data-phase='identificando']")).toBeVisible();
    await page.evaluate(() => (window as unknown as { __pushQr: (v: string) => void }).__pushQr("AR:AAA"));
    await page.waitForTimeout(600);
    expect(identifyCalls).toBe(0);
  });

  test("d) respuesta antigua no cambia al trabajador actual", async ({ page }) => {
    const gateA = deferred();
    const gateB = deferred();

    await page.route("**/api/v1/attendance/**", async (route: Route) => {
      if (route.request().method() === "OPTIONS") {
        await fulfillApi(route, 204, {});
        return;
      }
      if (!route.request().url().includes("/identify")) {
        await fulfillApi(route, 404, {});
        return;
      }
      const body = JSON.parse(route.request().postData() || "{}") as { identifier?: string };
      if (String(body.identifier).includes("AAA")) {
        await gateA.promise;
        await fulfillApi(route, 200, identifyPayload("Ana", "tok-a"));
        return;
      }
      await gateB.promise;
      await fulfillApi(route, 200, identifyPayload("Luis", "tok-b"));
    });

    await page.goto("/asistencia");
    await page.getByTestId("kiosk-scan-qr").click();
    await expect(page.locator("[data-phase='escaneando_qr']")).toBeVisible();
    await page.evaluate(() => (window as unknown as { __pushQr: (v: string) => void }).__pushQr("AR:AAA"));
    await page.getByTestId("kiosk-cancel-qr").click();
    await page.getByTestId("kiosk-identifier").fill("EMP-B");
    await page.getByTestId("kiosk-identify").click();
    gateA.resolve();
    await page.waitForTimeout(300);
    await expect(page.getByTestId("kiosk-employee-name")).toHaveCount(0);
    gateB.resolve();
    await expect(page.getByTestId("kiosk-employee-name")).toHaveText(/Luis/);
  });

  test("e) reenviar varias veces no dispara dos evidencias extra", async ({ page }) => {
    let evidenceCalls = 0;
    const statusGate = deferred();
    let statusCalls = 0;

    await page.route("**/api/v1/attendance/**", async (route: Route) => {
      if (route.request().method() === "OPTIONS") {
        await fulfillApi(route, 204, {});
        return;
      }
      const url = route.request().url();
      if (url.includes("/identify")) {
        await fulfillApi(route, 200, identifyPayload("Ana", "tok-ana"));
        return;
      }
      if (url.includes("/evidence")) {
        evidenceCalls += 1;
        await fulfillApi(route, 500, { detail: "red" });
        return;
      }
      if (url.includes("/attempt/status")) {
        statusCalls += 1;
        if (statusCalls === 1) {
          await fulfillApi(route, 200, { state: "PENDING", record: null });
          return;
        }
        await statusGate.promise;
        await fulfillApi(route, 200, { state: "PENDING", record: null });
        return;
      }
      await fulfillApi(route, 404, {});
    });

    await page.goto("/asistencia");
    await expect(page.getByTestId("kiosk-identify")).toBeVisible();
    await page.getByTestId("kiosk-identifier").fill("EMP-001");
    await page.getByTestId("kiosk-identify").click();
    await expect(page.locator("[data-phase='incidencia']")).toBeVisible({ timeout: 20_000 });
    const afterFirst = evidenceCalls;
    await page.getByTestId("kiosk-resend").click();
    await page.getByTestId("kiosk-resend").click();
    await page.getByTestId("kiosk-resend").click();
    await page.waitForTimeout(300);
    expect(statusCalls).toBe(2);
    statusGate.resolve();
    await page.waitForTimeout(400);
    expect(evidenceCalls).toBeLessThanOrEqual(afterFirst + 1);
  });
});
