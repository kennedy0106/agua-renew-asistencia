import { expect, type Page, type Route } from "@playwright/test";
import { test } from "@playwright/test";
import { deferred, installKioskCameraHarness } from "./kiosk-harness";

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

async function identifyUntilIncident(page: Page) {
  await page.goto("/asistencia");
  await expect(page.getByTestId("kiosk-identify")).toBeVisible();
  await page.getByTestId("kiosk-identifier").fill("EMP-001");
  await page.getByTestId("kiosk-identify").click();
  await expect(page.locator("[data-phase='incidencia']")).toBeVisible({ timeout: 20_000 });
}

test.describe("kiosco UI con API simulada", () => {
  test.beforeEach(async ({ page }) => {
    await installKioskCameraHarness(page);
  });

  test("a) cancelar durante consulta de reintento no sube evidencia vieja", async ({ page }) => {
    let evidenceCalls = 0;
    const secondStatus = deferred();
    let statusCalls = 0;
    let statusReleased = false;

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
      if (url.includes("/attempt/resolve")) {
        await fulfillApi(route, 200, { state: "CANCELLED", record: null, can_restart: true });
        return;
      }
      if (url.includes("/attempt/status")) {
        statusCalls += 1;
        if (statusCalls === 1) {
          await fulfillApi(route, 200, { state: "PENDING", record: null });
          return;
        }
        await secondStatus.promise;
        statusReleased = true;
        await fulfillApi(route, 200, { state: "PENDING", record: null });
        return;
      }
      await fulfillApi(route, 404, {});
    });

    await identifyUntilIncident(page);
    const evidenceBeforeResend = evidenceCalls;
    await page.getByTestId("kiosk-resend").click();
    await expect.poll(() => statusCalls).toBe(2);
    await page.getByTestId("kiosk-take-another").click();
    await expect(page.getByTestId("kiosk-restart-resolved")).toBeVisible();
    await expect(page.locator("[data-phase='identificando']")).toHaveCount(0);
    secondStatus.resolve();
    await expect.poll(() => statusReleased).toBe(true);
    expect(evidenceCalls).toBe(evidenceBeforeResend);
    await expect(page.locator("[data-phase='enviando']")).toHaveCount(0);
  });

  test("b) finally de A no desbloquea identificación B", async ({ page }) => {
    const gateA = deferred();
    const gateB = deferred();
    const identified: string[] = [];
    let aReleased = false;

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
          aReleased = true;
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
    await expect.poll(() => aReleased).toBe(true);
    await expect(page.getByTestId("kiosk-identify")).toBeDisabled();
    await expect(page.getByTestId("kiosk-employee-name")).toHaveCount(0);
    gateB.resolve();
    await expect(page.getByTestId("kiosk-employee-name")).toContainText("Luis", { timeout: 10_000 });
  });

  test("c) detect QR pendiente se resuelve después de cancelar y no identifica", async ({ page }) => {
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
    await page.evaluate(() => (window as unknown as { __armHangingDetect: () => void }).__armHangingDetect());
    await page.getByTestId("kiosk-scan-qr").click();
    await expect(page.locator("[data-phase='escaneando_qr']")).toBeVisible();
    await expect
      .poll(async () => page.evaluate(() => (window as unknown as { __detectEnteredCount: number }).__detectEnteredCount))
      .toBeGreaterThan(0);
    await page.getByTestId("kiosk-cancel-qr").click();
    await expect(page.locator("[data-phase='identificando']")).toBeVisible();
    await page.evaluate(() =>
      (window as unknown as { __resolveHangingDetect: (value: string | null) => void }).__resolveHangingDetect("AR:AAA"),
    );
    await expect.poll(() => identifyCalls).toBe(0);
  });

  test("d) respuesta antigua de A no cambia al trabajador B ya activo", async ({ page }) => {
    const gateA = deferred();
    const gateB = deferred();
    const identified: string[] = [];
    let aReleased = false;

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
      identified.push(String(body.identifier));
      if (String(body.identifier).includes("AAA")) {
        await gateA.promise;
        aReleased = true;
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
    await expect.poll(() => identified.length).toBe(1);
    await page.getByTestId("kiosk-cancel-qr").click();
    await page.getByTestId("kiosk-identifier").fill("EMP-B");
    await page.getByTestId("kiosk-identify").click();
    await expect.poll(() => identified.length).toBe(2);
    await expect(page.getByTestId("kiosk-identify")).toBeDisabled();
    gateA.resolve();
    await expect.poll(() => aReleased).toBe(true);
    await expect(page.getByTestId("kiosk-employee-name")).toHaveCount(0);
    gateB.resolve();
    await expect(page.getByTestId("kiosk-employee-name")).toHaveText(/Luis/);
  });

  test("e) reenviar varias veces no dispara dos evidencias extra", async ({ page }) => {
    let evidenceCalls = 0;
    const statusGate = deferred();
    let statusCalls = 0;
    let statusReleased = false;

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
        statusReleased = true;
        await fulfillApi(route, 200, { state: "PENDING", record: null });
        return;
      }
      await fulfillApi(route, 404, {});
    });

    await identifyUntilIncident(page);
    const afterFirst = evidenceCalls;
    await page.getByTestId("kiosk-resend").click();
    await page.getByTestId("kiosk-resend").click();
    await page.getByTestId("kiosk-resend").click();
    await expect.poll(() => statusCalls).toBe(2);
    statusGate.resolve();
    await expect.poll(() => statusReleased).toBe(true);
    await expect.poll(() => evidenceCalls).toBeLessThanOrEqual(afterFirst + 1);
  });

  test("f) consultar no necesita foto y no llama escrituras", async ({ page }) => {
    let evidenceCalls = 0;
    let checkInCalls = 0;
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
      if (url.includes("/check-in") || url.includes("/check-out")) {
        checkInCalls += 1;
        await fulfillApi(route, 500, { detail: "no" });
        return;
      }
      if (url.includes("/attempt/status")) {
        statusCalls += 1;
        await fulfillApi(route, 200, { state: "PENDING", record: null, evidence_ready: false, write_token_valid: true });
        return;
      }
      await fulfillApi(route, 404, {});
    });

    await identifyUntilIncident(page);
    await page.reload();
    await expect(page.getByTestId("kiosk-consult-attempt")).toBeVisible();
    await expect(page.getByTestId("kiosk-resend")).toHaveCount(0);
    const evidenceBefore = evidenceCalls;
    const writesBefore = checkInCalls;
    const statusBefore = statusCalls;
    await page.evaluate(() => {
      (window as unknown as { __gumCount: number }).__gumCount = 0;
      const orig = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async (constraints) => {
        (window as unknown as { __gumCount: number }).__gumCount += 1;
        return orig(constraints);
      };
    });
    await page.getByTestId("kiosk-consult-attempt").click();
    await expect.poll(() => statusCalls).toBe(statusBefore + 1);
    expect(evidenceCalls).toBe(evidenceBefore);
    expect(checkInCalls).toBe(writesBefore);
    expect(await page.evaluate(() => (window as unknown as { __gumCount: number }).__gumCount)).toBe(0);
    await expect(page.locator("[data-phase='incidencia']")).toBeVisible();
  });

  test("g) cancelar durante consulta ignora respuesta tardía", async ({ page }) => {
    const statusGate = deferred();
    let statusReleased = false;
    let evidenceCalls = 0;
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
      if (url.includes("/attempt/resolve")) {
        await fulfillApi(route, 200, { state: "CANCELLED", record: null, can_restart: true });
        return;
      }
      if (url.includes("/attempt/status")) {
        statusCalls += 1;
        if (statusCalls === 1) {
          await fulfillApi(route, 200, { state: "PENDING", record: null });
          return;
        }
        await statusGate.promise;
        statusReleased = true;
        await fulfillApi(route, 200, {
          state: "CONFIRMED",
          record: {
            id: "rec-1",
            employee_id: "11111111-1111-1111-1111-111111111111",
            work_date: "2026-09-11",
            check_in_at: "2026-09-11T13:00:00+00:00",
            check_out_at: null,
            worked_minutes: null,
            status: "OPEN",
            notes: null,
            created_at: "2026-09-11T13:00:00+00:00",
            updated_at: "2026-09-11T13:00:00+00:00",
            event_type: "CHECK_IN",
          },
        });
        return;
      }
      await fulfillApi(route, 404, {});
    });

    await identifyUntilIncident(page);
    await page.getByTestId("kiosk-consult-attempt").click();
    await page.getByTestId("kiosk-take-another").click();
    statusGate.resolve();
    await expect.poll(() => statusReleased).toBe(true);
    await expect(page.getByTestId("kiosk-confirmed-title")).toHaveCount(0);
    expect(evidenceCalls).toBeGreaterThan(0);
  });

  test("h) fallo de sessionStorage no envía a ciegas ni bloquea", async ({ page }) => {
    let evidenceCalls = 0;
    await page.addInitScript(() => {
      const quota = () => {
        throw new DOMException("quota", "QuotaExceededError");
      };
      const shim = {
        getItem: () => null,
        setItem: quota,
        removeItem: () => undefined,
        clear: () => undefined,
        key: () => null,
        length: 0,
      };
      Object.defineProperty(window, "sessionStorage", { configurable: true, value: shim });
    });
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
        await fulfillApi(route, 201, { id: "ev-1", content_type: "image/jpeg" });
        return;
      }
      await fulfillApi(route, 404, {});
    });

    await page.goto("/asistencia");
    await page.getByTestId("kiosk-identifier").fill("EMP-001");
    await page.getByTestId("kiosk-identify").click();
    await expect(page.locator("[data-phase='incidencia']")).toBeVisible({ timeout: 20_000 });
    expect(evidenceCalls).toBe(0);
    await expect(page.getByTestId("kiosk-consult-attempt")).toBeVisible();
    await expect(page.locator("[data-phase='enviando']")).toHaveCount(0);
  });

  test("i) estado de API desconocido conserva incertidumbre", async ({ page }) => {
    let checkInCalls = 0;
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
        await fulfillApi(route, 500, { detail: "red" });
        return;
      }
      if (url.includes("/attempt/status")) {
        await fulfillApi(route, 200, { state: "SOMETHING_NEW", record: null });
        return;
      }
      if (url.includes("/check-in")) {
        checkInCalls += 1;
        await fulfillApi(route, 201, {});
        return;
      }
      await fulfillApi(route, 404, {});
    });

    await identifyUntilIncident(page);
    await page.getByTestId("kiosk-consult-attempt").click();
    await expect(page.locator("[data-phase='incidencia']")).toBeVisible();
    await expect(page.getByTestId("kiosk-confirmed-title")).toHaveCount(0);
    expect(checkInCalls).toBe(0);
  });
});
