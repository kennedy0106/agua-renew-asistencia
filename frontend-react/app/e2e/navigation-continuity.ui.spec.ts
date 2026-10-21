import { expect, test, type Page } from "@playwright/test";

// Recorre la interfaz real con API completamente interceptada. Ninguna cuenta,
// periodo, cargo o sesión real se crea, modifica o cierra durante estas pruebas.
const stamp = "2026-10-01T12:00:00Z";
const admin = { id: "nav-admin", username: "qa.navigation", role: "ADMIN", active: true, must_change_password: false, last_login_at: null, created_at: stamp };
const roles = [{ id: "nav-role-admin", name: "ADMIN" }, { id: "nav-role-boss", name: "BOSS" }];
const employees = Array.from({ length: 24 }, (_, index) => ({ id: `nav-employee-${index}`, first_name: `PERSONA DE PRUEBA ${index}`, last_name: "EJEMPLO", dni: String(71112200 + index), employee_code: `QA-${index}`, active: true, job_role_id: "nav-job", job_role_name: "Operario", hire_date: null, termination_date: null, qr_token: "qa", created_at: stamp, updated_at: stamp }));
const periods = ["OPEN", "CALCULATED", "CLOSED"].map((status, index) => ({ id: `nav-period-${index}`, name: ["Octubre 2026", "Septiembre 2026", "Agosto 2026"][index], status, start_date: `2026-${String(10 - index).padStart(2, "0")}-01`, end_date: `2026-${String(10 - index).padStart(2, "0")}-28`, payroll_month_id: null, period_kind: "MONTHLY", root_period_id: `nav-period-${index}`, version: 1, supersedes_period_id: null, rectification_reason: null, created_at: stamp, updated_at: stamp }));
const policy = { id: "nav-policy", effective_from: "2026-10-01", effective_to: null, first_two_hours_rate: "25.00", additional_hours_rate: "35.00", reason: "Política de prueba", created_at: stamp, updated_at: stamp };
const sections = [
  ["dashboard", "Resumen de asistencia"], ["attendance", "Asistencia"], ["employees", "Empleados"], ["roles", "Cargos laborales"], ["payroll", "Planilla del periodo"], ["salaries", "Sueldos por periodo"], ["overtime-policy", "Reglas de horas extra"], ["users", "Usuarios del sistema"], ["devices", "Sesiones de marcación"], ["audit", "Auditoría"], ["account", "Mi cuenta"],
] as const;

async function mockApi(page: Page) {
  let currentUser = admin;
  let employeeReads = 0;
  let delayEmployeeReturn = false;
  let rejectCargo = false;
  let availablePeriods = periods;
  let cargoHold: Promise<void> | null = null;
  let cargoPosts = 0;
  const reads: string[] = [], writes: string[] = [], errors: string[] = [], documents: string[] = [];
  const jobRoles = [{ id: "nav-job", name: "Operario", description: "Puesto ficticio", active: true, created_at: stamp, updated_at: stamp }];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => { if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documents.push(request.url()); });
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const origin = request.headers().origin;
    const headers = origin ? { "access-control-allow-origin": origin, "access-control-allow-credentials": "true", "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "content-type" } : {};
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    if (request.method() !== "GET") {
      if (request.method() === "POST" && path === "/api/v1/auth/logout") {
        currentUser = { ...admin, id: "nav-admin-second", username: "qa.second" };
        return route.fulfill({ status: 204, headers });
      }
      if (request.method() === "POST" && path === "/api/v1/job-roles") {
        cargoPosts++;
        if (cargoHold) await cargoHold;
        if (rejectCargo) return route.fulfill({ status: 422, headers, json: { detail: { code: "QA_REJECTED", message: "El ejemplo no pudo guardarse" } } });
        const created = { ...jobRoles[0], id: "nav-created-job", ...request.postDataJSON() };
        jobRoles.push(created);
        return route.fulfill({ status: 201, headers, json: created });
      }
      writes.push(`${request.method()} ${path}`);
      return route.abort();
    }
    reads.push(path);
    if (path === "/api/v1/employees") {
      employeeReads++;
      if (delayEmployeeReturn && employeeReads > 1) await new Promise((resolve) => setTimeout(resolve, 650));
    }
    const periodMatch = path.match(/\/payroll\/periods\/([^/]+)\/(summary|records|daily-report)$/);
    if (periodMatch) {
      const period = periods.find((item) => item.id === periodMatch[1])!;
      const json = periodMatch[2] === "records" ? [] : periodMatch[2] === "daily-report" ? { period_id: period.id, start_date: period.start_date, end_date: period.end_date, daily: [], employees: [] } : { period_id: period.id, name: period.name, start_date: period.start_date, end_date: period.end_date, status: period.status, employee_count: 0, total_base: "0", total_overtime: "0", total_manual: "0", total: "0" };
      return route.fulfill({ headers, json });
    }
    const data: Record<string, unknown> = {
      "/api/v1/auth/me": currentUser, "/api/v1/employees": employees, "/api/v1/job-roles": jobRoles, "/api/v1/system-roles": roles,
      "/api/v1/users": [{ ...currentUser, system_role_id: roles[0].id, employee_id: null, employee_name: null }], "/api/v1/payroll/periods": availablePeriods,
      "/api/v1/overtime-policy": policy, "/api/v1/overtime-policy/history": [policy],
      "/api/v1/devices": [{ id: "nav-device", name: "Tablet ficticia", device_code: "QA-DEVICE", active: true, last_sync_at: stamp, created_at: stamp, updated_at: stamp }],
      "/api/v1/audit-logs": [{ id: "nav-log", entity_type: "payroll_period", entity_id: "nav-period-0", action: "create", reason: "Evento ficticio", old_values: null, new_values: {}, performed_by: currentUser.id, performed_by_username: currentUser.username, created_at: stamp }],
      "/api/v1/attendance/summary": { employees_active: employees.length, present_today: 0, no_entry_today: employees.length, open_entries: 0, checked_out_today: 0 },
    };
    return route.fulfill({ headers, json: data[path] ?? [] });
  });
  return { reads, writes, errors, documents, rejectCargo(value: boolean) { rejectCargo = value; }, delayEmployees() { delayEmployeeReturn = true; }, removePeriod(id: string) { availablePeriods = availablePeriods.filter((item) => item.id !== id); }, holdCargo(promise: Promise<void>) { cargoHold = promise; }, get cargoPosts() { return cargoPosts; } };
}

async function ready(page: Page, slug: string) {
  await expect(page).toHaveURL(new RegExp(`/admin/${slug}(?:[?#].*)?$`));
  const title = sections.find(([key]) => key === slug)![1];
  await expect(page.locator(".topbar-title")).toHaveText(title);
}

async function openMenu(page: Page) {
  const button = page.getByRole("button", { name: "Abrir menú", exact: true });
  if (await button.isVisible() && await button.getAttribute("aria-expanded") === "false") {
    await button.click();
    await expect(page.locator("#admin-sidebar")).toHaveClass(/is-open/);
  }
}

async function navigate(page: Page, slug: string) {
  await openMenu(page);
  await page.locator(`${slug === "account" ? ".sidebar-account" : ".sidebar-nav a"}[href="/admin/${slug}"]`).click();
  await ready(page, slug);
}

for (const width of [1280, 390]) {
  test.describe(`continuidad administrativa ${width}`, () => {
    test.use({ viewport: { width, height: 720 } });

    test("las once pantallas comparten menú, encabezado y main; conservan sesión y foco", async ({ page }) => {
      const api = await mockApi(page);
      await page.goto("/admin/dashboard");
      await ready(page, "dashboard");
      await page.evaluate(() => {
        const scope = window as unknown as Record<string, unknown>;
        scope.navigationNodes = [document.querySelector("#admin-sidebar"), document.querySelector(".topbar"), document.querySelector("main")];
      });
      for (const [slug] of [...sections.slice(1), sections[0]]) {
        await navigate(page, slug);
        expect(await page.evaluate(() => {
          const saved = (window as unknown as { navigationNodes: Element[] }).navigationNodes;
          return saved.every((node, index) => node === [document.querySelector("#admin-sidebar"), document.querySelector(".topbar"), document.querySelector("main")][index]);
        })).toBe(true);
        await expect(page.locator(".app-shell")).toHaveCount(1);
        await expect(page.locator(".topbar-title")).toBeFocused();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
        if (width === 390) await expect(page.getByRole("button", { name: "Abrir menú", exact: true })).toHaveAttribute("aria-expanded", "false");
      }
      expect(api.reads.filter((path) => path === "/api/v1/auth/me")).toHaveLength(1);
      expect(api.documents).toHaveLength(1);
      expect(api.errors).toEqual([]);
      expect(api.writes).toEqual([]);
    });

    test("el scroll del menú se conserva al cambiar entre opciones inferiores y reabrir", async ({ page }, testInfo) => {
      await mockApi(page);
      await page.goto("/admin/users");
      await ready(page, "users");
      await openMenu(page);
      const nav = page.locator(".sidebar-nav");
      const position = await nav.evaluate((element) => { element.scrollTop = element.scrollHeight; return element.scrollTop; });
      expect(position).toBeGreaterThan(0);
      await navigate(page, "devices");
      await openMenu(page);
      await expect.poll(() => nav.evaluate((element) => element.scrollTop)).toBeCloseTo(position, 0);
      await navigate(page, "audit");
      await openMenu(page);
      await expect.poll(() => nav.evaluate((element) => element.scrollTop)).toBeCloseTo(position, 0);
      await page.evaluate(async () => {
        await document.fonts.ready;
        await Promise.allSettled(document.getAnimations().filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity).map((animation) => animation.finished));
      });
      await page.screenshot({ path: testInfo.outputPath("sidebar-after-navigation.png") });
      if (width === 390) {
        await page.keyboard.press("Escape");
        await expect(page.getByRole("button", { name: "Abrir menú", exact: true })).toBeFocused();
      }
    });
  });
}

test("Atrás recupera búsquedas, empleado y categoría sin reiniciar sus criterios", async ({ page }) => {
  const api = await mockApi(page);
  await page.goto("/admin/employees");
  await ready(page, "employees");
  const searches = [
    ["employees", '[aria-label="Buscar por nombre, DNI o código"]'], ["roles", ".roles-search-input"], ["devices", '[aria-label="Buscar sesiones de marcación"]'],
    ["audit", '[aria-label="Buscar en bitácora de auditoría"]'], ["users", '[aria-label="Buscar por usuario o empleado vinculado"]'], ["salaries", '[aria-label="Buscar empleado en el periodo"]'],
  ];
  for (const [slug, selector] of searches) {
    if (!page.url().endsWith(`/${slug}`)) await navigate(page, slug);
    await page.locator(selector).fill("PRUEBA");
    await navigate(page, "dashboard");
    await page.goBack();
    await ready(page, slug);
    await expect(page.locator(selector)).toHaveValue("PRUEBA");
  }
  await navigate(page, "attendance");
  await page.getByRole("combobox", { name: "Empleado", exact: true }).click();
  await page.getByRole("option").nth(1).click();
  const selected = await page.getByRole("combobox", { name: "Empleado", exact: true }).innerText();
  await navigate(page, "dashboard");
  await page.goBack();
  await ready(page, "attendance");
  await expect(page.getByRole("combobox", { name: "Empleado", exact: true })).toHaveText(selected);
  await navigate(page, "audit");
  await page.locator("#audit-category-select").click();
  await page.getByRole("option", { name: "Planilla y Pagos", exact: true }).click();
  await navigate(page, "dashboard");
  await page.goBack();
  await ready(page, "audit");
  await expect(page.locator("#audit-category-select")).toHaveText("Planilla y Pagos");
  expect(api.errors).toEqual([]);
  expect(api.writes).toEqual([]);
});

test("Sueldos recupera el período elegido y consulta los datos de ese período", async ({ page }) => {
  const api = await mockApi(page);
  await page.goto("/admin/salaries");
  await ready(page, "salaries");
  await page.getByRole("combobox", { name: "Periodo de pago", exact: true }).click();
  await page.getByRole("option").filter({ hasText: "Agosto 2026" }).click();
  await expect.poll(() => api.reads.filter((path) => path === "/api/v1/payroll/periods/nav-period-2/summary").length).toBe(1);
  await navigate(page, "dashboard");
  const before = api.reads.length;
  await page.goBack();
  await ready(page, "salaries");
  await expect(page.getByRole("combobox", { name: "Periodo de pago", exact: true })).toContainText("Agosto 2026");
  await expect.poll(() => api.reads.slice(before).includes("/api/v1/payroll/periods/nav-period-2/summary")).toBe(true);
  expect(api.reads.slice(before)).not.toContain("/api/v1/payroll/periods/nav-period-0/summary");
  api.removePeriod("nav-period-2");
  await navigate(page, "dashboard");
  const invalidReturn = api.reads.length;
  await page.goBack();
  await ready(page, "salaries");
  await expect(page.getByRole("combobox", { name: "Periodo de pago", exact: true })).toContainText("Octubre 2026");
  await expect.poll(() => api.reads.slice(invalidReturn).includes("/api/v1/payroll/periods/nav-period-0/summary")).toBe(true);
  expect(api.reads.slice(invalidReturn)).not.toContain("/api/v1/payroll/periods/nav-period-2/summary");
  expect(api.errors).toEqual([]);
});

test("Cargos conserva el borrador al navegar y en error; lo limpia tras guardar", async ({ page }) => {
  const api = await mockApi(page);
  await page.goto("/admin/roles");
  await ready(page, "roles");
  const name = page.getByPlaceholder("Ej. Operario de envasado", { exact: true });
  const description = page.getByPlaceholder("Ej. Planta de tratamiento y llenado", { exact: true });
  await name.fill("Cargo de prueba");
  await description.fill("Borrador recuperable");
  await navigate(page, "dashboard");
  await page.goBack();
  await ready(page, "roles");
  await expect(name).toHaveValue("Cargo de prueba");
  await expect(description).toHaveValue("Borrador recuperable");
  api.rejectCargo(true);
  await page.getByRole("button", { name: "Crear cargo", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("El ejemplo no pudo guardarse");
  await expect(name).toHaveValue("Cargo de prueba");
  api.rejectCargo(false);
  await page.getByRole("button", { name: "Crear cargo", exact: true }).click();
  await expect(name).toHaveValue("");
  await expect(description).toHaveValue("");
  await navigate(page, "dashboard");
  await page.goBack();
  await ready(page, "roles");
  await expect(name).toHaveValue("");
  expect(api.writes).toEqual([]);
});

test("Usuarios carga una vez y cambiar el rol del formulario no recarga listados", async ({ page }) => {
  const api = await mockApi(page);
  await page.goto("/admin/users");
  await ready(page, "users");
  await page.getByRole("button", { name: "Nuevo usuario", exact: true }).click();
  await page.getByRole("combobox", { name: "Rol del sistema", exact: true }).click();
  await page.getByRole("option", { name: "BOSS", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Rol del sistema", exact: true })).toContainText("BOSS");
  await page.getByRole("button", { name: "Cancelar", exact: true }).click();
  for (const path of ["/api/v1/users", "/api/v1/system-roles", "/api/v1/employees"]) expect(api.reads.filter((value) => value === path)).toHaveLength(1);
  expect(api.writes).toEqual([]);
});

test("una creación de cargo que termina tarde no borra un borrador posterior", async ({ page }) => {
  const api = await mockApi(page);
  let finish!: () => void;
  api.holdCargo(new Promise<void>((resolve) => { finish = resolve; }));
  await page.goto("/admin/roles");
  await ready(page, "roles");
  const name = page.getByPlaceholder("Ej. Operario de envasado", { exact: true });
  const description = page.getByPlaceholder("Ej. Planta de tratamiento y llenado", { exact: true });
  await name.fill("Primer cargo");
  await page.getByRole("button", { name: "Crear cargo", exact: true }).click();
  await expect.poll(() => api.cargoPosts).toBe(1);
  await navigate(page, "dashboard");
  await page.goBack();
  await ready(page, "roles");
  await name.fill("Segundo cargo");
  await description.fill("Este borrador es posterior");
  finish();
  await expect(page.getByText('Cargo "Primer cargo" creado con éxito.', { exact: true })).toBeVisible();
  await expect(name).toHaveValue("Segundo cargo");
  await expect(description).toHaveValue("Este borrador es posterior");
  expect(api.writes).toEqual([]);
});

test("Atrás restaura scroll después de cargar datos y Adelante inicia arriba", async ({ page }) => {
  const api = await mockApi(page);
  api.delayEmployees();
  await page.goto("/admin/employees");
  await ready(page, "employees");
  await expect(page.locator('.employees-table a[href="/admin/employees/nav-employee-0"]')).toBeVisible();
  const original = await page.evaluate(() => { window.scrollTo(0, 450); return scrollY; });
  expect(original).toBeGreaterThan(100);
  await navigate(page, "roles");
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
  await page.goBack();
  await ready(page, "employees");
  await expect.poll(() => page.evaluate(() => scrollY), { timeout: 8000 }).toBeCloseTo(original, 0);
  await page.goForward();
  await ready(page, "roles");
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
  expect(api.errors).toEqual([]);
});

test("cerrar sesión elimina el contexto antes de entrar con otra cuenta", async ({ page }) => {
  const api = await mockApi(page);
  await page.goto("/admin/roles");
  await ready(page, "roles");
  await page.getByPlaceholder("Ej. Operario de envasado", { exact: true }).fill("Borrador privado de la sesión");
  await navigate(page, "devices");
  await page.locator(".sidebar-logout").click();
  await page.getByRole("button", { name: "Sí, salir", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/login$/);
  await expect(page.locator("#admin-sidebar")).toHaveCount(0);
  await page.goBack();
  await ready(page, "roles");
  await expect(page.locator(".sidebar-user .name")).toHaveText("qa.second");
  await expect(page.getByPlaceholder("Ej. Operario de envasado", { exact: true })).toHaveValue("");
  expect(api.writes).toEqual([]);
  expect(api.errors).toEqual([]);
});
