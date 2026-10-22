import { expect, type Page, type Route } from "@playwright/test";
import { test } from "@playwright/test";
import { deferred, installKioskCameraHarness } from "./kiosk-harness";

/**
 * Regresión de layout del kiosco público `/asistencia`.
 *
 * El objetivo de la pantalla es no generar scroll visible ni interno en las
 * fases de marcación sobre viewports comunes. La causa histórica fue doble:
 * los orbes decorativos `::before`/`::after` del `.kiosk` (con offsets
 * negativos) inflaban scrollHeight/scrollWidth del contenedor, y la tarjeta
 * sin compactar superaba la altura en laptops de 1366x768. Este test fija
 * ambos invariantes, que todo quede dentro del viewport y el tamaño táctil
 * mínimo de los controles, para identificación, cámara, QR, enviando,
 * confirmación e incidencia.
 */

const GEOLOCATION = { latitude: -12.0464, longitude: -77.0428, accuracy: 10 };

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

const identifyBody = {
  employee: {
    id: "11111111-1111-1111-1111-111111111111",
    first_name: "María",
    last_name: "López",
    job_role_name: "Operario",
    active: true,
  },
  state: { has_open_entry: false, open_check_in_at: null, last_record: null },
  server_time: "2026-10-02T13:00:00Z",
  server_time_label: "ahora",
  marking_token: "tok-maria",
  marking_action: "CHECK_IN",
};

/** Mock de UI de la comprobación previa a cámara: devuelve el mismo token. */
async function fulfillTerminalVerify(route: Route) {
  const body = route.request().postDataJSON() as { marking_token?: string };
  return fulfillApi(route, 200, {
    verified: true,
    employee_id: identifyBody.employee.id,
    employee_name: "María López",
    action: "CHECK_IN",
    device_id: "22222222-2222-2222-2222-222222222222",
    expires_at: "2026-10-02T13:05:00Z",
    server_time: "2026-10-02T13:00:01Z",
    marking_token: String(body.marking_token ?? ""),
  });
}

const confirmedBody = {
  id: "rec-1",
  employee_id: "11111111-1111-1111-1111-111111111111",
  work_date: "2026-10-02",
  check_in_at: "2026-10-02T13:00:00+00:00",
  check_out_at: null,
  worked_minutes: null,
  status: "OPEN",
  notes: null,
  created_at: "2026-10-02T13:00:00+00:00",
  updated_at: "2026-10-02T13:00:00+00:00",
  event_type: "CHECK_IN",
};

const VIEWPORTS = [
  { width: 375, height: 667 },
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1024, height: 600 },
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
];

type Snapshot = {
  documentScrollHeight: number;
  documentClientHeight: number;
  documentScrollWidth: number;
  documentClientWidth: number;
  kioskScrollHeight: number;
  kioskClientHeight: number;
  kioskScrollWidth: number;
  kioskClientWidth: number;
  kioskScrollTop: number;
  outOfViewport: string[];
  smallTargets: string[];
};

async function snapshot(page: Page): Promise<Snapshot> {
  return page.evaluate(() => {
    const doc = document.scrollingElement as HTMLElement;
    const kiosk = document.querySelector(".kiosk") as HTMLElement;
    const outOfViewport: string[] = [];
    const smallTargets: string[] = [];
    const label = (el: HTMLElement) =>
      el.getAttribute("data-testid") || el.getAttribute("aria-label") || (el.textContent ?? "").trim().slice(0, 24) || el.tagName.toLowerCase();
    const inViewport = (r: DOMRect) =>
      r.top >= -0.5 && r.bottom <= window.innerHeight + 0.5 && r.left >= -0.5 && r.right <= window.innerWidth + 0.5;

    document.querySelectorAll<HTMLElement>(".kiosk-brand, .kiosk-card").forEach((el) => {
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") return;
      if (!inViewport(el.getBoundingClientRect())) outOfViewport.push(label(el));
    });

    document.querySelectorAll<HTMLElement>("button, input, a[href], video").forEach((el) => {
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") return;
      const r = el.getBoundingClientRect();
      if (!inViewport(r)) outOfViewport.push(label(el));
      // Tolerancia de medio píxel: los tokens de 44px pueden renderizar 43.99.
      if (el.tagName !== "VIDEO" && r.height > 0 && r.height < 43.5) smallTargets.push(`${label(el)}=${r.height.toFixed(1)}`);
    });

    return {
      documentScrollHeight: doc.scrollHeight,
      documentClientHeight: doc.clientHeight,
      documentScrollWidth: doc.scrollWidth,
      documentClientWidth: doc.clientWidth,
      kioskScrollHeight: kiosk.scrollHeight,
      kioskClientHeight: kiosk.clientHeight,
      kioskScrollWidth: kiosk.scrollWidth,
      kioskClientWidth: kiosk.clientWidth,
      kioskScrollTop: kiosk.scrollTop,
      outOfViewport,
      smallTargets,
    };
  });
}

function assertNoScroll(s: Snapshot, context: string) {
  expect(s.documentScrollHeight, `${context}: scroll vertical del documento`).toBe(s.documentClientHeight);
  expect(s.documentScrollWidth, `${context}: scroll horizontal del documento`).toBe(s.documentClientWidth);
  expect(s.kioskScrollHeight, `${context}: scroll vertical del contenedor kiosco`).toBe(s.kioskClientHeight);
  expect(s.kioskScrollWidth, `${context}: scroll horizontal del contenedor kiosco`).toBe(s.kioskClientWidth);
  expect(s.kioskScrollTop, `${context}: desplazamiento interno del kiosco`).toBe(0);
  expect(s.outOfViewport, `${context}: elementos fuera del viewport`).toEqual([]);
  expect(s.smallTargets, `${context}: objetivos táctiles < 44px`).toEqual([]);
}

/** Contrato de preparación previo a la foto, sin backend ni GPS reales. */
async function routePreparation(page: Page) {
  await page.route("**/api/v1/attendance/attempt/prepare", async (route) => {
    if (route.request().method() === "OPTIONS") return fulfillApi(route, 204, {});
    const body = route.request().postDataJSON() as {
      marking_token: string;
      location: { latitude: number; longitude: number; accuracy_m: number; age_ms: number };
    };
    expect(body.marking_token).toBe(identifyBody.marking_token);
    expect(body.location).toMatchObject({
      latitude: GEOLOCATION.latitude,
      longitude: GEOLOCATION.longitude,
      accuracy_m: GEOLOCATION.accuracy,
    });
    expect(body.location.age_ms).toBeGreaterThanOrEqual(0);
    expect(body.location.age_ms).toBeLessThanOrEqual(60_000);
    return fulfillApi(route, 200, {
      marking_token: body.marking_token,
      marked_at: confirmedBody.check_in_at,
      expires_at: new Date(Date.parse(confirmedBody.check_in_at) + 5 * 60_000).toISOString(),
      location: {
        latitude: GEOLOCATION.latitude,
        longitude: GEOLOCATION.longitude,
        accuracy_m: GEOLOCATION.accuracy,
        observed_at: identifyBody.server_time,
        address: null,
      },
    });
  });
}

async function freshGoto(page: Page) {
  // Se instala después de cada ruta genérica y se repone tras unrouteAll.
  await routePreparation(page);
  await page.evaluate(() => sessionStorage.clear()).catch(() => undefined);
  await page.goto("/asistencia");
}

async function identifyAndCapture(page: Page) {
  await page.getByTestId("kiosk-identifier").fill("EMP-001");
  await page.getByTestId("kiosk-identify").click();
  await expect(page.getByTestId("kiosk-capture-now")).toBeVisible({ timeout: 10_000 });
  await page.getByTestId("kiosk-capture-now").click();
}

test.describe("kiosco /asistencia — layout sin scroll", () => {
  test.beforeEach(async ({ page, context }) => {
    await installKioskCameraHarness(page);
    await context.grantPermissions(["geolocation"], { origin: "http://127.0.0.1:3000" });
    await context.setGeolocation(GEOLOCATION);
  });

  for (const viewport of VIEWPORTS) {
    const vp = `${viewport.width}x${viewport.height}`;

    test(`todas las fases caben en ${vp}`, async ({ page }) => {
      test.setTimeout(120_000);
      await page.setViewportSize(viewport);

      // Identificación
      await page.route("**/api/v1/attendance/**", (route) => {
        const url = route.request().url();
        if (url.includes("/terminal/verify")) return fulfillTerminalVerify(route);
        return url.includes("/identify") ? fulfillApi(route, 200, identifyBody) : fulfillApi(route, 404, {});
      });
      await freshGoto(page);
      await expect(page.getByTestId("kiosk-identify")).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      assertNoScroll(await snapshot(page), `${vp} identificación`);

      // Cámara (video_listo / cuenta regresiva)
      await page.getByTestId("kiosk-identifier").fill("EMP-001");
      await page.getByTestId("kiosk-identify").click();
      await expect(page.getByTestId("kiosk-capture-now")).toBeVisible({ timeout: 10_000 });
      assertNoScroll(await snapshot(page), `${vp} cámara`);

      // Enviando (la evidencia queda pendiente para sostener la fase)
      const hang = deferred();
      await page.unrouteAll({ behavior: "ignoreErrors" });
      await page.route("**/api/v1/attendance/**", async (route) => {
        const url = route.request().url();
        if (url.includes("/terminal/verify")) return fulfillTerminalVerify(route);
        if (url.includes("/identify")) return fulfillApi(route, 200, identifyBody);
        if (url.includes("/evidence")) {
          await hang.promise;
          return fulfillApi(route, 201, { id: "ev-1", content_type: "image/jpeg" });
        }
        return fulfillApi(route, 404, {});
      });
      await freshGoto(page);
      await identifyAndCapture(page);
      await expect(page.locator("[data-phase='enviando']")).toBeVisible();
      assertNoScroll(await snapshot(page), `${vp} enviando`);
      hang.resolve();

      // QR
      await page.unrouteAll({ behavior: "ignoreErrors" });
      await page.route("**/api/v1/attendance/**", (route) => fulfillApi(route, 404, {}));
      await freshGoto(page);
      await expect(page.getByTestId("kiosk-scan-qr")).toBeVisible();
      await page.getByTestId("kiosk-scan-qr").click();
      await expect(page.getByTestId("kiosk-cancel-qr")).toBeVisible();
      assertNoScroll(await snapshot(page), `${vp} QR`);

      // Confirmación
      await page.unrouteAll({ behavior: "ignoreErrors" });
      await page.route("**/api/v1/attendance/**", async (route) => {
        const url = route.request().url();
        if (url.includes("/terminal/verify")) return fulfillTerminalVerify(route);
        if (url.includes("/identify")) return fulfillApi(route, 200, identifyBody);
        if (url.includes("/evidence")) return fulfillApi(route, 201, { id: "ev-1", content_type: "image/jpeg" });
        if (url.includes("/check-in")) return fulfillApi(route, 201, confirmedBody);
        return fulfillApi(route, 404, {});
      });
      await freshGoto(page);
      await identifyAndCapture(page);
      await expect(page.getByTestId("kiosk-confirmed-title")).toBeVisible({ timeout: 15_000 });
      assertNoScroll(await snapshot(page), `${vp} confirmación`);

      // Incidencia (evidencia y consulta fallan → outcome de error)
      await page.unrouteAll({ behavior: "ignoreErrors" });
      await page.route("**/api/v1/attendance/**", async (route) => {
        const url = route.request().url();
        if (url.includes("/terminal/verify")) return fulfillTerminalVerify(route);
        if (url.includes("/identify")) return fulfillApi(route, 200, identifyBody);
        if (url.includes("/evidence")) return fulfillApi(route, 500, { detail: "red" });
        if (url.includes("/attempt/status")) return fulfillApi(route, 500, { detail: "red" });
        return fulfillApi(route, 404, {});
      });
      await freshGoto(page);
      await identifyAndCapture(page);
      await expect(page.locator("[data-phase='incidencia']")).toBeVisible({ timeout: 15_000 });
      assertNoScroll(await snapshot(page), `${vp} incidencia`);
    });
  }
});
