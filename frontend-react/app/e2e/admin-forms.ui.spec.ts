import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";

// Todas las respuestas, incluidos los POST, son simuladas. Ninguna cuenta,
// política, periodo ni sesión real se crea o modifica durante estas pruebas.
const stamp = "2026-10-01T12:00:00Z";
const admin = { id: "qa-admin", username: "qa.admin", role: "ADMIN", active: true, must_change_password: false, last_login_at: null, created_at: stamp };
const roles = [{ id: "qa-role-admin", name: "ADMIN", description: null }, { id: "qa-role-boss", name: "BOSS", description: null }];
const employee = { id: "qa-employee", first_name: "ALEJANDRA MARÍA PRUEBA", last_name: "DE LOS ÁNGELES", dni: "71112233", employee_code: "QA-001", active: true, job_role_id: null, job_role_name: "Operario", hire_date: null, termination_date: null, qr_token: "qa", created_at: stamp, updated_at: stamp };
const users = [{ ...admin, system_role_id: roles[0].id, employee_id: null, employee_name: null }];
const periods = ["OPEN", "CALCULATED", "CLOSED"].map((status, index) => ({ id: `qa-period-${index}`, name: ["Octubre 2026", "Septiembre 2026", "Agosto 2026"][index], status, start_date: `2026-${String(10 - index).padStart(2, "0")}-01`, end_date: `2026-${String(10 - index).padStart(2, "0")}-28`, payroll_month_id: null, period_kind: "MONTHLY", root_period_id: `qa-period-${index}`, version: 1, supersedes_period_id: null, rectification_reason: null, created_at: stamp, updated_at: stamp }));
const policy = { id: "qa-policy", effective_from: "2026-10-01", effective_to: null, first_two_hours_rate: "25.00", additional_hours_rate: "35.00", reason: "Configuración de prueba", created_at: stamp, updated_at: stamp };
const devices = [true, false].map((active, index) => ({ id: `qa-device-${index}`, name: active ? "Tablet de prueba" : "Sesión revocada de prueba", device_code: `QA-DEVICE-${index}`, active, last_sync_at: stamp, created_at: stamp, updated_at: stamp }));
const audit = ["attendance", "payroll_period"].map((entity_type, index) => ({ id: `qa-log-${index}`, entity_type, entity_id: `qa-entity-${index}`, action: "create", reason: `Evento ficticio ${index}`, old_values: null, new_values: { status: "OPEN" }, performed_by: `qa-actor-${index}`, performed_by_username: `qa.actor.${index}`, created_at: `2026-10-${20 - index}T12:00:00Z` }));

async function mockApi(page: Page) {
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  const forbidden: string[] = [];
  const errors: string[] = [];
  let rejectWrites = false;
  let waitForWrite: Promise<void> | null = null;
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const origin = request.headers()["origin"];
    const headers = origin ? { "access-control-allow-origin": origin, "access-control-allow-credentials": "true", "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET,POST,OPTIONS" } : {};
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    if (request.method() !== "GET") {
      if (request.method() !== "POST" || !["/api/v1/payroll/periods", "/api/v1/overtime-policy", "/api/v1/users"].includes(path)) {
        forbidden.push(`${request.method()} ${path}`);
        return route.abort();
      }
      const body = request.postDataJSON() as Record<string, unknown>;
      writes.push({ path, body });
      if (waitForWrite) await waitForWrite;
      if (rejectWrites) return route.fulfill({ status: 422, headers, json: { detail: { code: "QA_REJECTED", message: "No se pudo guardar el ejemplo de prueba." } } });
      const json = path.endsWith("/users") ? { ...users[0], id: "qa-created-user", ...body, temporary_password: "QA-FICTIONAL-TEMP-ONLY" } : path.endsWith("/overtime-policy") ? { ...policy, ...body } : { ...periods[0], ...body };
      return route.fulfill({ headers, json });
    }
    const data: Record<string, unknown> = { "/api/v1/auth/me": admin, "/api/v1/employees": [employee], "/api/v1/system-roles": roles, "/api/v1/users": users, "/api/v1/payroll/periods": periods, "/api/v1/overtime-policy": policy, "/api/v1/overtime-policy/history": [policy], "/api/v1/devices": devices, "/api/v1/audit-logs": audit };
    return route.fulfill({ headers, json: data[path] ?? [] });
  });
  return { writes, forbidden, errors, reject(value: boolean) { rejectWrites = value; }, hold(promise: Promise<void> | null) { waitForWrite = promise; } };
}

async function noOverflow(page: Page, dialog?: Locator) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  if (dialog) {
    expect(await dialog.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  }
}

async function capture(page: Page, testInfo: TestInfo, name: string) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    window.scrollTo({ top: 0, behavior: "instant" });
    const finite = document.getAnimations().filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity);
    await Promise.allSettled(finite.map((animation) => animation.finished));
  });
  await page.screenshot({ path: testInfo.outputPath(name), fullPage: true });
}

async function dateToday(page: Page, trigger: Locator) {
  await trigger.click();
  const calendar = page.locator(".datefield-panel");
  await expect(calendar).toBeVisible();
  await calendar.getByRole("button", { name: "Hoy", exact: true }).click();
  await expect(calendar).toHaveCount(0);
}

for (const width of [320, 390, 1280]) {
  test.describe(`formularios administrativos ${width}`, () => {
    test.use({ viewport: { width, height: 900 } });

    test("periodo: diálogo, calendarios, quincenas y payload conservado", async ({ page }, testInfo) => {
      const api = await mockApi(page);
      await page.goto("/admin/payroll");
      await expect(page.getByText("Octubre 2026", { exact: true })).toBeVisible();
      await capture(page, testInfo, "periodos.png");
      const trigger = page.getByRole("button", { name: "Nuevo periodo", exact: true });
      await trigger.click();
      const dialog = page.getByRole("dialog", { name: /nuevo periodo|crear periodo/i });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByLabel("Nombre", { exact: true })).toBeFocused();
      await dialog.getByLabel("Nombre", { exact: true }).fill("Periodo de prueba");
      const kind = dialog.getByRole("combobox", { name: "Tipo de liquidación" });
      await kind.click();
      await expect(page.getByRole("listbox")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("listbox")).toHaveCount(0);
      await expect(dialog).toBeVisible();
      const start = dialog.getByRole("button", { name: "Fecha de inicio", exact: true });
      await start.click();
      await page.keyboard.press("Escape");
      await expect(page.locator(".datefield-panel")).toHaveCount(0);
      await expect(dialog).toBeVisible();
      await dateToday(page, start);
      await dateToday(page, dialog.getByRole("button", { name: "Fecha final", exact: true }));
      await noOverflow(page, dialog);
      await capture(page, testInfo, "nuevo-periodo.png");
      api.reject(true);
      await dialog.getByRole("button", { name: "Crear periodo", exact: true }).click();
      await expect(dialog.getByRole("alert")).toContainText("No se pudo guardar el ejemplo");
      expect(api.writes[0].body).toMatchObject({ name: "Periodo de prueba", period_kind: "MONTHLY", start_date: expect.any(String), end_date: expect.any(String) });
      expect(api.writes[0].body.start_date).toBe(api.writes[0].body.end_date);
      api.reject(false);
      await kind.click();
      await page.getByRole("option", { name: "Primera quincena" }).click();
      const month = dialog.getByRole("button", { name: "Mes de liquidación" });
      await month.click();
      await page.keyboard.press("Escape");
      await expect(page.locator(".monthfield-panel")).toHaveCount(0);
      await expect(dialog).toBeVisible();
      await month.click();
      await page.locator(".monthfield-panel").getByRole("button", { name: "Este mes" }).click();
      await expect(page.locator(".monthfield-panel")).toHaveCount(0);
      await dialog.getByRole("button", { name: "Crear periodo", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      expect(api.writes).toHaveLength(2);
      expect(api.writes[1].body).toMatchObject({ name: "Periodo de prueba", period_kind: "FIRST_HALF" });
      expect(api.writes[1].body.year).toEqual(expect.any(Number));
      expect(api.writes[1].body.month).toEqual(expect.any(Number));
      expect(api.writes[1].body).not.toHaveProperty("start_date");
      expect(api.errors).toEqual([]);
      expect(api.forbidden).toEqual([]);
    });

    test("política: validación, error visible y cierre bloqueado al guardar", async ({ page }, testInfo) => {
      const api = await mockApi(page);
      await page.goto("/admin/overtime-policy");
      const trigger = page.getByRole("button", { name: "Nueva política", exact: true });
      await trigger.click();
      const dialog = page.getByRole("dialog", { name: /nueva política/i });
      await expect(dialog).toBeVisible();
      await dialog.getByLabel(/Motivo del cambio/).fill("Prueba de política");
      await dialog.getByLabel(/Primeras 2 h/).fill("24");
      await expect(dialog.getByRole("button", { name: "Guardar política" })).toBeDisabled();
      await dialog.getByLabel(/Primeras 2 h/).fill("25.00");
      await noOverflow(page, dialog);
      await capture(page, testInfo, "nueva-politica.png");
      api.reject(true);
      let release!: () => void;
      api.hold(new Promise<void>((resolve) => { release = resolve; }));
      try {
        await dialog.getByRole("button", { name: "Guardar política" }).click();
        await expect.poll(() => api.writes.length).toBe(1);
        await expect(dialog.getByRole("button", { name: "Cancelar", exact: true })).toBeDisabled();
        await page.keyboard.press("Escape");
        await expect(dialog).toBeVisible();
      } finally { release(); api.hold(null); }
      await expect(dialog.getByRole("alert")).toContainText("No se pudo guardar el ejemplo");
      await dialog.getByRole("button", { name: "Cancelar", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(trigger).toBeFocused();
      expect(api.writes[0].body).toMatchObject({ first_two_hours_rate: "25.00", additional_hours_rate: "35.00", reason: "Prueba de política" });
      expect(api.errors).toEqual([]);
      expect(api.forbidden).toEqual([]);
    });

    test("usuario: selector anidado, foco y credencial tras crear", async ({ page }, testInfo) => {
      const api = await mockApi(page);
      await page.goto("/admin/users");
      const trigger = page.getByRole("button", { name: "Nuevo usuario", exact: true });
      await trigger.click();
      const dialog = page.getByRole("dialog", { name: /nuevo usuario|crear acceso/i });
      await expect(dialog).toBeVisible();
      const username = dialog.getByLabel("Nombre de usuario", { exact: true });
      await expect(username).toBeFocused();
      await username.fill("qa.nuevo");
      await dialog.getByRole("combobox", { name: "Rol del sistema" }).click();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("listbox")).toHaveCount(0);
      await expect(dialog).toBeVisible();
      await noOverflow(page, dialog);
      await capture(page, testInfo, "nuevo-usuario.png");
      await dialog.getByRole("button", { name: "Cancelar", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(trigger).toBeFocused();
      await trigger.click();
      await expect(username).toHaveValue("qa.nuevo");
      api.reject(true);
      await dialog.getByRole("button", { name: "Crear usuario", exact: true }).click();
      await expect(dialog.getByRole("alert")).toContainText("No se pudo guardar el ejemplo");
      await expect(username).toHaveValue("qa.nuevo");
      api.reject(false);
      await dialog.getByRole("button", { name: "Crear usuario", exact: true }).click();
      await expect(page.getByRole("dialog", { name: "Credencial temporal creada" })).toBeVisible();
      expect(api.writes).toHaveLength(2);
      expect(api.writes[1].body).toEqual({ username: "qa.nuevo", system_role_id: roles[0].id, employee_id: null });
      expect(api.errors).toEqual([]);
      expect(api.forbidden).toEqual([]);
    });

    test("sesiones y auditoría: filtros y calendarios del sistema", async ({ page }, testInfo) => {
      const api = await mockApi(page);
      await page.goto("/admin/devices");
      await page.getByRole("combobox", { name: "Filtrar por estado", exact: true }).click();
      await expect(page.getByRole("listbox")).toHaveClass(/glass-select-content/);
      await page.getByRole("option", { name: /Solo revocadas/ }).click();
      await expect(page.getByText("Sesión revocada de prueba", { exact: true })).toBeVisible();
      await expect(page.getByText("Tablet de prueba", { exact: true })).toHaveCount(0);
      await noOverflow(page);
      await capture(page, testInfo, "sesiones.png");
      await page.goto("/admin/audit");
      await page.getByRole("combobox", { name: "Filtrar por categoría" }).click();
      await page.getByRole("option", { name: "Planilla y Pagos" }).click();
      await expect(page.getByText("Evento ficticio 1", { exact: false })).toBeVisible();
      await expect(page.getByText("Evento ficticio 0", { exact: false })).toHaveCount(0);
      await page.getByRole("button", { name: "Fecha inicial de auditoría", exact: true }).click();
      await expect(page.locator(".datefield-panel")).toBeVisible();
      await page.locator(".datefield-panel").getByRole("button", { name: "Hoy", exact: true }).click();
      await expect(page.locator(".datefield-panel")).toHaveCount(0);
      await page.getByRole("button", { name: /Limpiar filtros/ }).click();
      await expect(page.getByText("Evento ficticio 0", { exact: false })).toBeVisible();
      await expect(page.getByText("Evento ficticio 1", { exact: false })).toBeVisible();
      await noOverflow(page);
      await capture(page, testInfo, "auditoria.png");
      expect(api.writes).toEqual([]);
      expect(api.errors).toEqual([]);
      expect(api.forbidden).toEqual([]);
    });
  });
}
