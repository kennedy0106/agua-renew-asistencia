import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import type { AttendanceDailyItem, AttendanceListItem, Employee, UserOut } from "../src/lib/api";

// Datos ficticios. Todas las peticiones de API se interceptan; nunca se guardan
// correcciones, fotos ni ajustes en un servidor real.
const LONG_NAME = "ALEJANDRA MARÍA DE LOS ÁNGELES PRUEBA COMPUESTA";
const ADMIN: UserOut = { id: "qa-admin", username: "qa.operador", role: "ADMIN", active: true, must_change_password: false, last_login_at: null, created_at: "2026-01-01T00:00:00Z" };
const names = [LONG_NAME, "Bruno Ejemplo", "Carla Muestra", "Diego Ensayo"];
const employees: Employee[] = names.map((name, index) => ({
  id: `emp-${index}`, dni: `7111223${index}`, employee_code: `QA-${index}`,
  first_name: name, last_name: "", job_role_id: "role-1", job_role_name: "Operario",
  hire_date: null, termination_date: null, active: true, qr_token: `qa-${index}`,
  created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
}));
const dayBase: AttendanceDailyItem = {
  employee_id: "emp-0", employee_name: LONG_NAME, work_date: "2026-10-02",
  session_count: 1, gross_minutes: 3984, break_minutes: 60, break_source: "SCHEDULE",
  override_requested_minutes: null, override_limited: false, worked_minutes: 3924,
  expected_minutes: 480, difference_minutes: 3444, has_open_entry: false,
  incident_codes: ["LONG_ATTENDANCE", "LATE_ENTRY"],
};
const days: AttendanceDailyItem[] = [
  dayBase,
  { ...dayBase, employee_id: "emp-1", employee_name: names[1], work_date: "2026-10-16", gross_minutes: 1, break_minutes: 0, worked_minutes: 1, expected_minutes: 300, difference_minutes: -299, incident_codes: [] },
  { ...dayBase, employee_id: "emp-2", employee_name: names[2], work_date: "2026-10-16", session_count: 3, gross_minutes: 45, break_minutes: 45, break_source: "OVERRIDE", override_requested_minutes: 60, override_limited: true, worked_minutes: 0, expected_minutes: 300, difference_minutes: -300, incident_codes: [] },
  { ...dayBase, employee_id: "emp-3", employee_name: names[3], work_date: "2026-10-16", gross_minutes: 0, break_minutes: 0, worked_minutes: 0, expected_minutes: 480, difference_minutes: -480, has_open_entry: true, incident_codes: ["OPEN_ATTENDANCE"] },
];
const recordBase: AttendanceListItem = {
  id: "rec-a", employee_id: "emp-0", employee_name: LONG_NAME, job_role_name: "Operario",
  work_date: "2026-10-02", check_in_at: "2026-10-02T19:03:00Z", check_out_at: "2026-10-05T13:27:00Z",
  worked_minutes: 3984, expected_minutes: 480, difference_minutes: 3504, status: "COMPLETE", notes: null,
};
const records: AttendanceListItem[] = [
  recordBase,
  { ...recordBase, id: "rec-b", employee_id: "emp-1", employee_name: names[1], work_date: "2026-10-16", check_in_at: "2026-10-16T17:00:00Z", check_out_at: "2026-10-16T17:01:00Z", worked_minutes: 1, expected_minutes: 300, difference_minutes: -299 },
  ...[0, 1, 2].map((offset) => ({ ...recordBase, id: `rec-c-${offset}`, employee_id: "emp-2", employee_name: names[2], work_date: "2026-10-16", check_in_at: `2026-10-16T${12 + offset}:00:00Z`, check_out_at: `2026-10-16T${12 + offset}:15:00Z`, worked_minutes: 15, expected_minutes: 300, difference_minutes: -285 })),
  { ...recordBase, id: "rec-open", employee_id: "emp-3", employee_name: names[3], work_date: "2026-10-16", check_in_at: "2026-10-16T12:00:00Z", check_out_at: null, worked_minutes: null, difference_minutes: null, status: "OPEN" },
];
const DAILY = "Resumen diario del equipo";
const RECORDS = "Detalle de marcaciones";

async function openPage(page: Page, supervisor = false) {
  const evidence: string[] = [];
  const mutations: string[] = [];
  await page.route("**/api/v1/**", (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const origin = request.headers()["origin"];
    const headers = origin ? { "access-control-allow-origin": origin, "access-control-allow-credentials": "true", "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET,OPTIONS" } : {};
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    if (request.method() !== "GET") {
      mutations.push(path);
      return route.fulfill({ status: 403, json: { detail: "Vista de prueba de solo lectura" }, headers });
    }
    const json = (body: unknown) => route.fulfill({ json: body, headers });
    if (path.endsWith("/auth/me")) return json({ ...ADMIN, role: supervisor ? "SUPERVISOR" : "ADMIN" });
    if (path === "/api/v1/employees") return json(employees);
    if (path === "/api/v1/attendance/daily") return json(days);
    if (path === "/api/v1/attendance") return json(records);
    if (path.includes("evidence")) {
      evidence.push(path);
      return json({ record_id: "rec-a", check_in: null, check_out: null });
    }
    return json([]);
  });
  await page.goto("/admin/attendance");
  await expect(page.getByRole("heading", { name: DAILY, exact: true })).toBeVisible();
  await page.evaluate(async () => { await document.fonts.ready; });
  return { evidence, mutations };
}

function entity(page: Page, view: string, name: string, mobile: boolean) {
  return mobile
    ? page.getByRole("region", { name: view, exact: true }).getByRole("article").filter({ hasText: name }).first()
    : page.getByRole("table", { name: view, exact: true }).getByRole("row").filter({ hasText: name }).first();
}
async function details(page: Page, item: Locator) {
  const trigger = item.getByRole("button", { name: /desglose/i });
  await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  const id = await trigger.getAttribute("aria-controls");
  expect(id).toBeTruthy();
  const panel = page.locator(`[id=${JSON.stringify(id)}]`);
  await expect(panel).toBeVisible();
  return panel;
}
async function noPageOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
}

/** Captura real, sin ocultar el chrome ni desplazar la región debajo de él. */
async function capture(page: Page, target: Locator, testInfo: TestInfo, filename: string, mobile: boolean) {
  const original = page.viewportSize()!;
  await page.setViewportSize({ width: original.width, height: mobile ? 844 : 1000 });
  await target.evaluate((element) => {
    const stickyBottom = Math.max(0, ...Array.from(document.querySelectorAll("header, .mobile-header, .topbar"))
      .filter((node) => ["sticky", "fixed"].includes(getComputedStyle(node).position))
      .map((node) => node.getBoundingClientRect().bottom));
    window.scrollTo({ top: Math.max(0, window.scrollY + element.getBoundingClientRect().top - stickyBottom - 16), behavior: "instant" });
  });
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  const bounds = await target.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual((mobile ? 844 : 1000) + 1);
  expect(await target.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return [rect.left + 8, rect.right - 8].every((x) => {
      const hit = document.elementFromPoint(x, rect.top + 8);
      return Boolean(hit && element.contains(hit));
    });
  })).toBe(true);
  await target.evaluate(async (element) => {
    const finite = element.getAnimations({ subtree: true }).filter((animation) => {
      const end = animation.effect?.getComputedTiming().endTime;
      return typeof end === "number" && Number.isFinite(end);
    });
    await Promise.allSettled(finite.map((animation) => animation.finished));
  });
  await target.screenshot({ path: testInfo.outputPath(filename) });
  await page.setViewportSize(original);
}

for (const [name, width, mobile] of [["desktop", 1600, false], ["laptop", 1280, false], ["mobile", 390, true]] as const) {
  test.describe(`asistencia · tablas ${name}`, () => {
    test.use({ viewport: { width, height: mobile ? 640 : 900 }, isMobile: mobile, hasTouch: mobile });

    test("columnas legibles y acciones rotuladas", async ({ page }, testInfo) => {
      await openPage(page);
      if (!mobile) {
        await expect(page.getByRole("table", { name: DAILY }).getByRole("columnheader")).toHaveText(["Empleado", "Fecha", "Efectivo", "Esperado", "Saldo", "Incidencias", "Acciones"]);
        await expect(page.getByRole("table", { name: RECORDS }).getByRole("columnheader")).toHaveText(["Empleado", "Fecha", "Entrada", "Salida", "Trabajado", "Estado", "Acciones"]);
        for (const view of [DAILY, RECORDS]) {
          const clipped = await page.getByRole("table", { name: view }).getByRole("columnheader").evaluateAll((cells) => cells.filter((cell) => cell.scrollWidth > cell.clientWidth + 1).length);
          expect(clipped).toBe(0);
        }
      }
      const daily = entity(page, DAILY, LONG_NAME, mobile);
      const record = entity(page, RECORDS, LONG_NAME, mobile);
      await expect(daily).toContainText("Jornada larga");
      await expect(record).toContainText("Cerrada");
      await expect(record).toContainText("05/10/2026");
      await expect(record).toContainText("66:24");
      await expect(entity(page, DAILY, names[1], mobile)).toContainText("-04:59");
      const photos = record.getByRole("button", { name: /^ver fotos/i });
      const correct = record.getByRole("button", { name: /^corregir registro/i });
      const meal = daily.getByRole("button", { name: /^editar refrigerio/i });
      for (const [button, label] of [[photos, "Fotos"], [correct, "Corregir"], [meal, "Refrigerio"]] as const) {
        await expect(button).toHaveText(label);
        const box = await button.boundingBox();
        expect(box!.height).toBeGreaterThanOrEqual(43);
        expect(box!.height).toBeLessThanOrEqual(45);
      }
      await noPageOverflow(page);
      if (name !== "laptop") {
        const dailyTarget = mobile ? daily : page.getByRole("table", { name: DAILY });
        const recordTarget = mobile ? record : page.getByRole("table", { name: RECORDS });
        await capture(page, dailyTarget, testInfo, `attendance-daily-${name}.png`, mobile);
        await capture(page, recordTarget, testInfo, `attendance-records-${name}.png`, mobile);
      }
    });

    test("desgloses conservan valores y los pendientes no inventan datos", async ({ page }, testInfo) => {
      await openPage(page);
      const adjusted = entity(page, DAILY, names[2], mobile);
      const dayDetails = await details(page, adjusted);
      await expect(dayDetails).toContainText(/Sesiones\s*3/);
      await expect(dayDetails).toContainText("00:45");
      await expect(dayDetails).toContainText("01:00");
      await expect(dayDetails).toContainText("Ajuste manual");
      await expect(dayDetails).toContainText(/limitado/i);
      const record = entity(page, RECORDS, LONG_NAME, mobile);
      const recordDetails = await details(page, record);
      await expect(recordDetails).toContainText("08:00");
      await expect(recordDetails).toContainText("+58:24");
      await expect(recordDetails).toContainText("Operario");
      const pending = entity(page, RECORDS, names[3], mobile);
      await expect(pending).toContainText("Sin salida");
      await expect(pending).toContainText("—");
      const blocked = entity(page, DAILY, names[3], mobile).getByRole("button", { name: /^editar refrigerio/i });
      await expect(blocked).toBeDisabled();
      await expect(blocked).toHaveAttribute("title", /Cierre todas las marcaciones/);
      await noPageOverflow(page);
      if (mobile) {
        await capture(page, adjusted, testInfo, "attendance-daily-mobile-expanded.png", true);
        await capture(page, record, testInfo, "attendance-records-mobile-expanded.png", true);
      }
    });
  });
}

test.describe("asistencia · permisos y diálogos", () => {
  test("SUPERVISOR conserva información, sin acciones de gestión", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 640 });
    const { mutations } = await openPage(page, true);
    await expect(page.getByRole("button", { name: /^ver fotos|^corregir registro|^editar refrigerio/i })).toHaveCount(0);
    const panel = await details(page, entity(page, DAILY, names[2], true));
    await expect(panel).toContainText(/Sesiones\s*3/);
    await expect(panel).toContainText("01:00");
    await details(page, entity(page, RECORDS, LONG_NAME, true));
    expect(mutations).toEqual([]);
  });

  test("Fotos, Corregir y Refrigerio abren sus diálogos originales", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const { evidence, mutations } = await openPage(page);
    const record = entity(page, RECORDS, LONG_NAME, false);
    await record.getByRole("button", { name: /^ver fotos/i }).click();
    const photos = page.getByRole("dialog", { name: /evidencia fotográfica/i });
    await expect(photos).toBeVisible();
    await expect.poll(() => evidence.length).toBe(1);
    expect(evidence[0]).toContain("rec-a");
    await photos.getByRole("button", { name: /cerrar evidencia/i }).click();
    await record.getByRole("button", { name: /^corregir registro/i }).click();
    const correction = page.getByRole("dialog", { name: /corregir registro/i });
    await expect(correction).toBeVisible();
    await correction.getByRole("button", { name: /cerrar corrección/i }).click();
    await entity(page, DAILY, names[2], false).getByRole("button", { name: /^editar refrigerio/i }).click();
    const meal = page.getByRole("dialog", { name: /editar refrigerio/i });
    await expect(meal).toBeVisible();
    await expect(meal.getByLabel("Refrigerio real (minutos)")).toHaveAttribute("max", "45");
    await meal.getByRole("button", { name: "Cancelar", exact: true }).click();
    expect(mutations).toEqual([]);
  });
});

type ObservedMotion = { part: "panel" | "indicator"; property: string; durationMs: number };
let motionObserver = 0;

/** Observa eventos nativos antes del gesto; no congela ni simula animaciones. */
async function observeMotion(page: Page, trigger: Locator) {
  const events: ObservedMotion[] = [];
  const receiver = `__attendanceMotion${++motionObserver}`;
  await page.exposeFunction(receiver, (event: ObservedMotion) => { events.push(event); });
  await trigger.evaluate((button, callback) => {
    document.addEventListener("transitionrun", (event) => {
      const transition = event as TransitionEvent;
      const target = transition.target;
      if (!(target instanceof Element)) return;
      const id = button.getAttribute("aria-controls");
      const panel = id ? document.getElementById(id) : null;
      const part = transition.propertyName === "opacity" && panel?.contains(target)
        ? "panel"
        : transition.propertyName === "transform" && button.contains(target) && target.tagName.toLowerCase() === "svg"
          ? "indicator"
          : null;
      if (!part) return;
      const style = getComputedStyle(target);
      const properties = style.transitionProperty.split(",").map((value) => value.trim());
      const index = Math.max(0, properties.indexOf(transition.propertyName));
      const durations = style.transitionDuration.split(",");
      const duration = (durations[index] ?? durations[0]).trim();
      const durationMs = parseFloat(duration) * (duration.endsWith("ms") ? 1 : 1000);
      const receive = (window as unknown as Record<string, (value: ObservedMotion) => void>)[callback];
      receive({ part, property: transition.propertyName, durationMs });
    }, true);
  }, receiver);
  return events;
}

async function styleFrames(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

test.describe("fluidez Asistencia", () => {
  test.use({ viewport: { width: 1600, height: 900 }, reducedMotion: "no-preference" });

  for (const mobile of [false, true]) {
    test.describe(mobile ? "puntero táctil" : "puntero escritorio", () => {
      test.use({ viewport: { width: mobile ? 390 : 1600, height: mobile ? 640 : 900 }, hasTouch: mobile, isMobile: mobile });
      test("el desglose entra suavemente y el indicador acompaña sin retener el cierre", async ({ page }) => {
        await openPage(page);
        const item = entity(page, DAILY, names[2], mobile);
        const trigger = item.getByRole("button", { name: /desglose/i });
        const events = await observeMotion(page, trigger);
        if (mobile) await trigger.tap(); else await trigger.click();
        await expect(trigger).toHaveAttribute("aria-expanded", "true");
        await expect.poll(() => events.some((event) => event.part === "panel")).toBe(true);
        await expect.poll(() => events.some((event) => event.part === "indicator")).toBe(true);
        for (const event of events) {
          expect(event.durationMs).toBeGreaterThanOrEqual(100);
          expect(event.durationMs).toBeLessThanOrEqual(200);
        }
        const id = await trigger.getAttribute("aria-controls");
        if (mobile) await trigger.tap(); else await trigger.click();
        await expect(trigger).toHaveAttribute("aria-expanded", "false");
        await expect(page.locator(`[id=${JSON.stringify(id)}]`)).toHaveCount(0);
        if (mobile) await trigger.tap(); else await trigger.click();
        await expect(trigger).toHaveAttribute("aria-expanded", "true");
        await expect(page.locator(`[id=${JSON.stringify(id)}]`)).toContainText("01:00");
      });
    });
  }

  test("ayuda, período y más acciones reciben entrada discreta con puntero", async ({ page }) => {
    await openPage(page);
    const toolbar = page.getByRole("region", { name: "Filtros", exact: true });
    for (const name of [/^Ayuda$/, /^Período:/, /^Más acciones$/]) {
      const trigger = toolbar.getByRole("button", { name });
      const events = await observeMotion(page, trigger);
      await trigger.click();
      await expect.poll(() => events.some((event) => event.part === "panel")).toBe(true);
      expect(events.filter((event) => event.part === "panel").every((event) => event.durationMs <= 200)).toBe(true);
      await trigger.click();
      await expect(trigger).toHaveAttribute("aria-expanded", "false");
    }
  });

  test("el teclado mantiene el desglose y su indicador inmediatos", async ({ page }) => {
    await openPage(page);
    const trigger = entity(page, DAILY, names[2], false).getByRole("button", { name: /desglose/i });
    const events = await observeMotion(page, trigger);
    await trigger.focus();
    await trigger.press("Enter");
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await styleFrames(page);
    expect(events).toEqual([]);
    await trigger.press("Enter");
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    const toolbar = page.getByRole("region", { name: "Filtros", exact: true });
    for (const name of [/^Ayuda$/, /^Período:/, /^Más acciones$/]) {
      const headerTrigger = toolbar.getByRole("button", { name });
      const headerEvents = await observeMotion(page, headerTrigger);
      await headerTrigger.focus();
      await headerTrigger.press("Enter");
      await expect(headerTrigger).toHaveAttribute("aria-expanded", "true");
      await styleFrames(page);
      expect(headerEvents).toEqual([]);
      await headerTrigger.press("Enter");
      await expect(headerTrigger).toHaveAttribute("aria-expanded", "false");
    }
  });

  test.describe("movimiento reducido", () => {
    test.use({ reducedMotion: "reduce" });
    test("no añade movimiento al desplegar con puntero", async ({ page }) => {
      await openPage(page);
      const trigger = entity(page, DAILY, names[2], false).getByRole("button", { name: /desglose/i });
      const events = await observeMotion(page, trigger);
      await trigger.click();
      await expect(trigger).toHaveAttribute("aria-expanded", "true");
      await styleFrames(page);
      expect(events).toEqual([]);
      await trigger.click();
      await expect(trigger).toHaveAttribute("aria-expanded", "false");
      const toolbar = page.getByRole("region", { name: "Filtros", exact: true });
      for (const name of [/^Ayuda$/, /^Período:/, /^Más acciones$/]) {
        const headerTrigger = toolbar.getByRole("button", { name });
        const headerEvents = await observeMotion(page, headerTrigger);
        await headerTrigger.click();
        await expect(headerTrigger).toHaveAttribute("aria-expanded", "true");
        await styleFrames(page);
        expect(headerEvents).toEqual([]);
        await headerTrigger.click();
        await expect(headerTrigger).toHaveAttribute("aria-expanded", "false");
      }
    });
  });
});
