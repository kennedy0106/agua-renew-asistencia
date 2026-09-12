import { createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { test } from "@playwright/test";
import { installKioskCameraHarness } from "./kiosk-harness";

const API = process.env.E2E_API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8000";
const SECRET = process.env.SECRET_KEY ?? "change-me";
const BACKEND_DIR = path.resolve(__dirname, "../../backend");

if (process.env.E2E_INTEGRATION !== "1") {
  throw new Error("E2E_INTEGRATION=1 es obligatorio para la suite de aceptación real.");
}

function expireAttendanceToken(token: string, secret: string): string {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("token de marcación inválido");
  const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
  payload.exp = Math.floor(Date.now() / 1000) - 180;
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const data = `${parts[0]}.${body}`;
  const signature = createHmac("sha256", secret).update(data).digest("base64url");
  return `${data}.${signature}`;
}

function uniqueDigits(): string {
  return String(10_000_000 + Math.floor(Math.random() * 89_999_999)).slice(0, 8);
}

async function adminApi(request: APIRequestContext): Promise<APIRequestContext> {
  const login = await request.post(`${API}/api/v1/auth/login`, {
    data: { username: "admin", password: "Admin123!" },
  });
  expect(login.ok(), await login.text()).toBeTruthy();
  return request;
}

async function jobRoleId(api: APIRequestContext): Promise<string> {
  const listed = await api.get(`${API}/api/v1/job-roles`);
  expect(listed.ok(), await listed.text()).toBeTruthy();
  const roles = (await listed.json()) as Array<{ id: string; name: string }>;
  const existing = roles.find((role) => role.name === "Operario") ?? roles[0];
  if (existing) return existing.id;
  const created = await api.post(`${API}/api/v1/job-roles`, { data: { name: "Operario", description: null } });
  expect(created.status()).toBe(201);
  return ((await created.json()) as { id: string }).id;
}

async function createEmployee(api: APIRequestContext, firstName: string) {
  const dni = uniqueDigits();
  const created = await api.post(`${API}/api/v1/employees`, {
    data: {
      dni,
      employee_code: `E2E-${dni}`,
      first_name: firstName,
      last_name: "Prueba",
      job_role_id: await jobRoleId(api),
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  const body = (await created.json()) as { id: string; employee_code: string; first_name: string };
  return body;
}

async function createDevice(api: APIRequestContext, name: string) {
  const created = await api.post(`${API}/api/v1/devices`, { data: { name } });
  expect(created.status(), await created.text()).toBe(201);
  return (await created.json()) as { id: string; pairing_code: string; name: string };
}

async function pairKiosk(page: Page, pairingCode: string) {
  const result = await page.evaluate(
    async ({ api, code }) => {
      const response = await fetch(`${api}/api/v1/attendance/terminal/pair`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pairing_code: code }),
      });
      return { status: response.status, body: await response.json().catch(() => null) };
    },
    { api: API, code: pairingCode },
  );
  expect(result.status, JSON.stringify(result.body)).toBe(200);
}

async function fetchJson(page: Page, pathName: string, body: unknown) {
  return page.evaluate(
    async ({ api, pathName: urlPath, body: payload }) => {
      const response = await fetch(`${api}${urlPath}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      return { status: response.status, body: await response.json().catch(() => null) };
    },
    { api: API, pathName, body },
  );
}

async function identifyAndCaptureToken(page: Page, code: string): Promise<string> {
  let markingToken = "";
  const once = page.waitForResponse((response) => response.url().includes("/attendance/identify") && response.request().method() === "POST");
  await page.getByTestId("kiosk-identifier").fill(code);
  await page.getByTestId("kiosk-identify").click();
  const identify = await once;
  const payload = (await identify.json()) as { marking_token: string };
  markingToken = payload.marking_token;
  expect(markingToken).toBeTruthy();
  return markingToken;
}

async function waitConfirmed(page: Page, title: RegExp) {
  await expect(page.getByTestId("kiosk-confirmed-title")).toHaveText(title, { timeout: 45_000 });
}

test.describe("kiosco integración Next+FastAPI+Postgres", () => {
  test.beforeEach(async ({ page }) => {
    await installKioskCameraHarness(page);
  });

  test("entrada y salida con fotografía persistida", async ({ page, request }) => {
    const api = await adminApi(request);
    const employee = await createEmployee(api, "Ana");
    const device = await createDevice(api, `Kiosco ${employee.employee_code}`);
    await page.goto("/asistencia");
    await pairKiosk(page, device.pairing_code);
    await identifyAndCaptureToken(page, employee.employee_code);
    await waitConfirmed(page, /Entrada registrada/);
    const listed = await api.get(`${API}/api/v1/attendance?employee_id=${employee.id}`);
    expect(listed.ok()).toBeTruthy();
    const records = (await listed.json()) as Array<{ status: string; check_in_at: string | null }>;
    expect(records.some((row) => row.status === "OPEN" && row.check_in_at)).toBeTruthy();

    await page.getByTestId("kiosk-new-marking").click();
    await identifyAndCaptureToken(page, employee.employee_code);
    await waitConfirmed(page, /Salida registrada/);
    const afterOut = await api.get(`${API}/api/v1/attendance?employee_id=${employee.id}`);
    const completed = (await afterOut.json()) as Array<{ status: string; check_out_at: string | null }>;
    expect(completed.some((row) => row.status === "COMPLETE" && row.check_out_at)).toBeTruthy();
  });

  test("recupera entrada y salida con token corto vencido; escrituras vencidas 401", async ({ page, request }) => {
    const api = await adminApi(request);
    const employee = await createEmployee(api, "Luis");
    const device = await createDevice(api, `Kiosco ${employee.employee_code}`);
    await page.goto("/asistencia");
    await pairKiosk(page, device.pairing_code);
    const inToken = await identifyAndCaptureToken(page, employee.employee_code);
    await waitConfirmed(page, /Entrada registrada/);
    const expiredIn = expireAttendanceToken(inToken, SECRET);
    const recoveredIn = await fetchJson(page, "/api/v1/attendance/attempt/status", { marking_token: expiredIn });
    expect(recoveredIn.status).toBe(200);
    expect(recoveredIn.body.state).toBe("CONFIRMED");
    expect(recoveredIn.body.record.event_type).toBe("CHECK_IN");
    expect((await fetchJson(page, "/api/v1/attendance/check-in", { marking_token: expiredIn })).status).toBe(401);
    expect(
      (await fetchJson(page, "/api/v1/attendance/evidence", {
        marking_token: expiredIn,
        image_base64: "AAAAAAAA",
        content_type: "image/jpeg",
      })).status,
    ).toBe(401);

    await page.getByTestId("kiosk-new-marking").click();
    const outToken = await identifyAndCaptureToken(page, employee.employee_code);
    await waitConfirmed(page, /Salida registrada/);
    const expiredOut = expireAttendanceToken(outToken, SECRET);
    const recoveredOut = await fetchJson(page, "/api/v1/attendance/attempt/status", { marking_token: expiredOut });
    expect(recoveredOut.status).toBe(200);
    expect(recoveredOut.body.record.event_type).toBe("CHECK_OUT");
    expect((await fetchJson(page, "/api/v1/attendance/check-out", { marking_token: expiredOut })).status).toBe(401);
  });

  test("rechaza otro terminal, revocado, ausente y pertenencia nula", async ({ page, request, browser }) => {
    const api = await adminApi(request);
    const employee = await createEmployee(api, "Nora");
    const deviceA = await createDevice(api, `Kiosco A ${employee.employee_code}`);
    const deviceB = await createDevice(api, `Kiosco B ${employee.employee_code}`);
    await page.goto("/asistencia");
    await pairKiosk(page, deviceA.pairing_code);
    const token = await identifyAndCaptureToken(page, employee.employee_code);
    await waitConfirmed(page, /Entrada registrada/);

    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();
    await installKioskCameraHarness(pageB);
    await pageB.goto("/asistencia");
    await pairKiosk(pageB, deviceB.pairing_code);
    const fromB = await fetchJson(pageB, "/api/v1/attendance/attempt/status", { marking_token: token });
    expect(fromB.status).toBe(401);
    await contextB.close();

    const absent = await browser.newContext();
    const pageAbsent = await absent.newPage();
    await pageAbsent.goto("/asistencia");
    const fromAbsent = await fetchJson(pageAbsent, "/api/v1/attendance/attempt/status", { marking_token: token });
    expect(fromAbsent.status).toBe(401);
    await absent.close();

    const revoked = await api.post(`${API}/api/v1/devices/${deviceA.id}/revoke`);
    expect(revoked.ok()).toBeTruthy();
    const fromRevoked = await fetchJson(page, "/api/v1/attendance/attempt/status", { marking_token: token });
    expect(fromRevoked.status).toBe(401);

    const deviceC = await createDevice(api, `Kiosco C ${employee.employee_code}`);
    const contextC = await browser.newContext();
    const pageC = await contextC.newPage();
    await installKioskCameraHarness(pageC);
    await pageC.goto("/asistencia");
    await pairKiosk(pageC, deviceC.pairing_code);
    const other = await createEmployee(api, "Paz");
    const otherToken = await identifyAndCaptureToken(pageC, other.employee_code);
    await waitConfirmed(pageC, /Entrada registrada/);
    execFileSync("uv", ["run", "python", "-m", "scripts.e2e_null_nonce_device"], {
      cwd: BACKEND_DIR,
      env: process.env,
      stdio: "pipe",
    });
    const nullOwned = await fetchJson(pageC, "/api/v1/attendance/attempt/status", { marking_token: otherToken });
    expect(nullOwned.status).toBe(401);
    await contextC.close();
  });

  test("respuesta perdida tras commit y consulta fallida no crea la acción contraria", async ({ page, request }) => {
    const api = await adminApi(request);
    const employee = await createEmployee(api, "Rita");
    const device = await createDevice(api, `Kiosco ${employee.employee_code}`);
    let checkInStored = false;
    let statusFailures = 1;

    await page.route("**/api/v1/attendance/check-in", async (route) => {
      if (route.request().method() === "OPTIONS") {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      checkInStored = response.status() === 201;
      await route.abort("failed");
    });
    await page.route("**/api/v1/attendance/attempt/status", async (route) => {
      if (route.request().method() === "OPTIONS") {
        await route.continue();
        return;
      }
      if (statusFailures > 0) {
        statusFailures -= 1;
        await route.abort("failed");
        return;
      }
      await route.continue();
    });

    await page.goto("/asistencia");
    await pairKiosk(page, device.pairing_code);
    await identifyAndCaptureToken(page, employee.employee_code);
    await expect(page.locator("[data-phase='incidencia']")).toBeVisible({ timeout: 45_000 });
    expect(checkInStored).toBe(true);
    await expect(page.getByTestId("kiosk-review-hint")).toBeVisible();
    await expect(page.locator("[data-phase='identificando']")).toHaveCount(0);

    await page.getByTestId("kiosk-consult-attempt").click();
    await waitConfirmed(page, /Entrada registrada/);
    await expect(page.locator("[data-phase='identificando']")).toHaveCount(0);

    const listed = await api.get(`${API}/api/v1/attendance?employee_id=${employee.id}`);
    const records = (await listed.json()) as Array<{ status: string; event_type?: string }>;
    expect(records.filter((row) => row.status === "OPEN")).toHaveLength(1);
    expect(records.some((row) => row.status === "COMPLETE")).toBeFalsy();
  });
});
