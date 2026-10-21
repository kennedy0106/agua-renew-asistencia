import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * Encabezado de Asistencia (solo la parte de arriba).
 *
 * Verifica la agrupación de acciones y filtros, el período compacto con sus
 * mismos DateField, las acciones de gestión para ADMIN/BOSS (ausentes para
 * SUPERVISOR), la exportación CSV con los filtros vigentes y el Limpiar que
 * vacía también las fechas. La tabla, la evidencia y los diálogos de corrección
 * no se tocan: su cobertura vive en el resto de la suite. Toda la API se
 * responde con rutas simuladas; no se descarga ningún archivo real.
 */

const ADMIN = {
  id: "attendance-admin",
  username: "demo.administrador",
  role: "ADMIN",
  active: true,
  must_change_password: false,
  last_login_at: null,
  created_at: "2026-01-01T00:00:00Z",
};

const SUPERVISOR = {
  ...ADMIN,
  id: "attendance-supervisor",
  username: "demo.supervisor",
  role: "SUPERVISOR",
};

const EMPLOYEE = {
  id: "emp-1",
  dni: "71112233",
  employee_code: "E2E-71112233",
  first_name: "Ana",
  last_name: "Prueba",
  job_role_id: "role-1",
  job_role_name: "Operario",
  hire_date: null,
  termination_date: null,
  active: true,
  qr_token: "qr-1",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const RECORD = {
  id: "rec-1",
  employee_id: "emp-1",
  employee_name: "Ana Prueba",
  job_role_name: "Operario",
  work_date: "2026-10-16",
  check_in_at: "2026-10-16T17:00:05+00:00",
  check_out_at: null,
  worked_minutes: null,
  expected_minutes: 480,
  difference_minutes: null,
  status: "OPEN",
  notes: null,
};

const DAILY = {
  employee_id: "emp-1",
  employee_name: "Ana Prueba",
  work_date: "2026-10-16",
  session_count: 1,
  gross_minutes: 0,
  break_minutes: 0,
  break_source: "SCHEDULE",
  override_requested_minutes: null,
  override_limited: false,
  worked_minutes: 0,
  expected_minutes: 480,
  difference_minutes: -480,
  has_open_entry: true,
  incident_codes: [],
};

/** Rango del mes operativo vigente en America/Lima (misma regla que la página). */
function limaMonthRange(): { from: string; to: string } {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Lima",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const [year, month] = today.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    from: `${year}-${String(month).padStart(2, "0")}-01`,
    to: `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`,
  };
}

async function mockApi(page: Page, user: typeof ADMIN) {
  await page.route("**/api/v1/**", (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const origin = request.headers()["origin"];
    const headers = origin
      ? {
          "access-control-allow-origin": origin,
          "access-control-allow-credentials": "true",
          "access-control-allow-headers": "content-type",
          "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
        }
      : {};
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    const json = (body: unknown) => route.fulfill({ json: body, headers });
    if (path.endsWith("/auth/me")) return json(user);
    if (path === "/api/v1/employees") return json([EMPLOYEE]);
    if (path === "/api/v1/attendance/daily") return json([DAILY]);
    if (path === "/api/v1/attendance") return json([RECORD]);
    return json([]);
  });
}

async function openAttendance(page: Page, user: typeof ADMIN = ADMIN) {
  await mockApi(page, user);
  await page.goto("/admin/attendance");
  await expect(page.getByRole("heading", { name: "Filtros", exact: true })).toBeVisible();
  await page.evaluate(async () => { await document.fonts.ready; });
}

function header(page: Page) {
  return page.getByRole("region", { name: "Filtros", exact: true });
}

async function box(locator: Locator) {
  const bounds = await locator.boundingBox();
  expect(bounds).not.toBeNull();
  return bounds!;
}

/** Diferencia entre el control más alto y el más bajo de un grupo. */
function heightSpread(boxes: Array<{ height: number }>) {
  return Math.max(...boxes.map((bounds) => bounds.height)) - Math.min(...boxes.map((bounds) => bounds.height));
}

function periodTrigger(page: Page) {
  return header(page).getByRole("button", { name: /^período/i });
}

/**
 * Captura solo el encabezado. En móvil el chrome de la app es sticky (barra y
 * cabecera de página) y tapa la fila de acciones cuando Playwright desplaza el
 * elemento hasta el borde superior; se captura con la página arriba del todo y
 * un viewport real más alto (390×844), restaurando después el de la prueba.
 * Las condiciones se comprueban en la propia prueba: sin scroll y sin chrome
 * encima de las esquinas superiores del encabezado.
 */
async function captureHeader(
  page: Page,
  toolbar: Locator,
  path: string,
  viewport: { width: number; height: number },
  mobile: boolean,
) {
  const captureViewport = mobile ? { width: viewport.width, height: 844 } : viewport;
  if (mobile) await page.setViewportSize(captureViewport);
  await toolbar.evaluate((element) => {
    if (document.scrollingElement) document.scrollingElement.scrollTop = 0;
    for (let node = element.parentElement; node; node = node.parentElement) node.scrollTop = 0;
    window.scrollTo(0, 0);
  });
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

  const bounds = await box(toolbar);
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(captureViewport.height + 0.5);
  const covered = await toolbar.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return [
      [rect.left + 8, rect.top + 8],
      [rect.right - 8, rect.top + 8],
    ].filter(([x, y]) => {
      const hit = document.elementFromPoint(x, y);
      return !hit || !element.contains(hit);
    }).length;
  });
  expect(covered).toBe(0);

  await toolbar.screenshot({ path });
  if (mobile) await page.setViewportSize(viewport);
}

for (const [name, viewport, mobile] of [
  ["desktop", { width: 1280, height: 720 }, false],
  ["mobile", { width: 390, height: 640 }, true],
] as const) {
  test.describe(`asistencia · encabezado ${name}`, () => {
    test.use({ viewport, hasTouch: mobile, isMobile: mobile });

    test("agrupa acciones y filtros etiquetados sin desbordar el encabezado", async ({ page }, testInfo) => {
      await openAttendance(page);
      const toolbar = header(page);
      const help = toolbar.getByRole("button", { name: /^ayuda$/i });
      const exportButton = toolbar.getByRole("button", { name: /^exportar csv$/i });
      const moreButton = toolbar.getByRole("button", { name: /^más acciones$/i });
      const employee = toolbar.getByRole("combobox", { name: "Empleado", exact: true });
      const status = toolbar.getByRole("combobox", { name: "Estado", exact: true });
      const clear = toolbar.getByRole("button", { name: /^limpiar/i });
      const period = periodTrigger(page);

      await expect(help).toBeVisible();
      await expect(exportButton).toBeVisible();
      await expect(moreButton).toBeVisible();
      await expect(toolbar.getByText("Empleado", { exact: true })).toBeVisible();
      await expect(toolbar.getByText("Período", { exact: true })).toBeVisible();
      await expect(toolbar.getByText("Estado", { exact: true })).toBeVisible();
      await expect(employee).toBeVisible();
      await expect(status).toBeVisible();
      await expect(clear).toBeVisible();
      await expect(period).toBeVisible();

      // El período arranca cerrado: los dos campos de fecha no ocupan la fila.
      await expect(page.getByRole("button", { name: "Fecha desde" })).toBeHidden();
      await expect(page.getByRole("button", { name: "Fecha hasta" })).toBeHidden();

      // Acciones y filtros comparten altura utilizable (≈44 px) sin saltos.
      const actionBoxes = await Promise.all([help, exportButton, moreButton].map(box));
      const filterBoxes = await Promise.all([employee, period, status, clear].map(box));
      expect(Math.min(...actionBoxes.map((bounds) => bounds.height))).toBeGreaterThanOrEqual(43);
      expect(heightSpread(actionBoxes)).toBeLessThanOrEqual(1);
      expect(Math.min(...filterBoxes.map((bounds) => bounds.height))).toBeGreaterThanOrEqual(43);
      expect(heightSpread(filterBoxes)).toBeLessThanOrEqual(1);

      // Dos niveles: las acciones arriba y alineadas a la derecha, filtros abajo.
      const toolbarBox = await box(toolbar);
      const actionsTop = Math.min(...actionBoxes.map((bounds) => bounds.y));
      const actionsRight = Math.max(...actionBoxes.map((bounds) => bounds.x + bounds.width));
      const filtersTop = Math.min(...filterBoxes.map((bounds) => bounds.y));
      expect(actionsTop).toBeLessThan(filtersTop);
      expect(filterBoxes[0].x - toolbarBox.x).toBeLessThanOrEqual(24);
      expect(actionsRight).toBeLessThanOrEqual(toolbarBox.x + toolbarBox.width + 0.5);

      // Nada se sale del encabezado ni del viewport.
      const overflow = await toolbar.evaluate((element) => ({
        horizontal: element.scrollWidth - element.clientWidth,
        right: element.getBoundingClientRect().right,
      }));
      expect(overflow.horizontal).toBeLessThanOrEqual(1);
      expect(overflow.right).toBeLessThanOrEqual(viewport.width + 0.5);

      await captureHeader(page, toolbar, testInfo.outputPath(`attendance-header-${name}-closed.png`), viewport, mobile);
    });

    test("muestra el rango vigente y cierra solo el calendario anidado con Escape", async ({ page }, testInfo) => {
      await openAttendance(page);
      const toolbar = header(page);
      const period = periodTrigger(page);
      const { from, to } = limaMonthRange();

      // Rango reconocible (dos fechas), no un disparador vacío ni una fila de campos.
      await expect(period).toHaveText(/\d{1,2}\D+\d{4}\s*[–-]\s*\d{1,2}\D+\d{4}/);
      await expect(period).toContainText(from.slice(0, 4));
      const periodBox = await period.boundingBox();
      expect(periodBox).not.toBeNull();
      expect(periodBox!.width).toBeLessThanOrEqual((await box(toolbar)).width);

      await period.click();
      await expect(period).toHaveAttribute("aria-expanded", "true");
      const dateFrom = page.getByRole("button", { name: "Fecha desde" });
      const dateTo = page.getByRole("button", { name: "Fecha hasta" });
      await expect(dateFrom).toBeVisible();
      await expect(dateTo).toBeVisible();
      await expect(dateFrom).toHaveText(new RegExp(`^${from.slice(8)}`));
      await expect(dateTo).toHaveText(new RegExp(`^${to.slice(8)}`));
      // Abrir el editor no filtra ni confirma: todo sigue siendo automático.
      await expect(page.getByRole("button", { name: /aplicar/i })).toHaveCount(0);

      await captureHeader(page, toolbar, testInfo.outputPath(`attendance-header-${name}-open.png`), viewport, mobile);

      await dateFrom.click();
      const calendar = page.getByRole("dialog", { name: "Calendario: Fecha desde" });
      await expect(calendar).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(calendar).toBeHidden();
      // Escape cerró el calendario, no el editor de período.
      await expect(period).toHaveAttribute("aria-expanded", "true");
      await expect(dateTo).toBeVisible();

      // La ayuda de columnas aparece solo cuando se pide.
      await expect(toolbar.getByText(/desde la primera entrada hasta la última salida/i)).toBeHidden();
      await toolbar.getByRole("button", { name: /^ayuda$/i }).click();
      await expect(toolbar.getByText(/desde la primera entrada hasta la última salida/i)).toBeVisible();
    });

    test("exporta el CSV con los filtros vigentes sin descargar archivos reales", async ({ page }) => {
      await openAttendance(page);
      const toolbar = header(page);
      const exported: string[] = [];
      await page.context().route("**/api/v1/exports/attendance.csv*", (route) => {
        exported.push(route.request().url());
        return route.fulfill({ status: 200, contentType: "text/csv", body: "empleado,fecha\n" });
      });

      await toolbar.getByRole("combobox", { name: "Empleado", exact: true }).click();
      await page.getByRole("option", { name: "Ana Prueba" }).click();
      await toolbar.getByRole("combobox", { name: "Estado", exact: true }).click();
      await page.getByRole("option", { name: "Sin salida registrada" }).click();
      await expect(toolbar.getByRole("combobox", { name: "Empleado", exact: true })).toContainText("Ana Prueba");

      // Chrome trata text/csv como descarga: la ventana abierta queda sin URL
      // legible, así que la prueba se ancla a la petición real interceptada
      // (mismo MIME CSV) y comprueba que sale exactamente una.
      await Promise.all([
        page.waitForEvent("popup"),
        toolbar.getByRole("button", { name: /^exportar csv$/i }).click(),
      ]);
      await expect.poll(() => exported.length).toBe(1);
      const { from, to } = limaMonthRange();
      const url = new URL(exported[0]);
      expect(url.pathname).toBe("/api/v1/exports/attendance.csv");
      expect(url.searchParams.get("employee_id")).toBe("emp-1");
      expect(url.searchParams.get("date_from")).toBe(from);
      expect(url.searchParams.get("date_to")).toBe(to);
      expect(url.searchParams.get("status")).toBe("OPEN");
      expect(exported).toHaveLength(1);
    });

    test("Limpiar vacía también las fechas y no hay botón Aplicar", async ({ page }) => {
      await openAttendance(page);
      const toolbar = header(page);
      const period = periodTrigger(page);
      const { from } = limaMonthRange();

      await period.click();
      await expect(page.getByRole("button", { name: "Fecha desde" })).toHaveText(new RegExp(`^${from.slice(8)}`));
      await period.click();
      await expect(period).toHaveAttribute("aria-expanded", "false");

      await toolbar.getByRole("button", { name: /^limpiar/i }).click();

      await expect(period).toHaveText(/sin fechas/i);
      await expect(period).not.toContainText(from.slice(0, 4));
      await period.click();
      await expect(page.getByRole("button", { name: "Fecha desde" })).toHaveText(/^desde$/i);
      await expect(page.getByRole("button", { name: "Fecha hasta" })).toHaveText(/^hasta$/i);
      await expect(page.getByRole("button", { name: /aplicar/i })).toHaveCount(0);
      // Sin filtros no queda nada que limpiar.
      await expect(toolbar.getByRole("button", { name: /^limpiar/i })).toHaveCount(0);
      await expect(toolbar.getByRole("combobox", { name: "Empleado", exact: true })).toContainText(
        "Todos los empleados",
      );
    });

    test("las acciones de gestión viven en Más acciones y la recuperación se abre aparte", async ({ page }) => {
      await openAttendance(page);
      const toolbar = header(page);
      const more = toolbar.getByRole("button", { name: /^más acciones$/i });

      await expect(page.getByRole("link", { name: /horas anteriores/i })).toBeHidden();
      await expect(page.getByLabel("Motivo")).toBeHidden();

      await more.click();
      await expect(more).toHaveAttribute("aria-expanded", "true");
      const history = page.getByRole("link", { name: /horas anteriores/i });
      await expect(history).toBeVisible();
      await expect(history).toHaveAttribute("href", "/admin/attendance/history");
      const recovery = page.getByRole("button", { name: /recuperar un intento de la tablet/i });
      await expect(recovery).toBeVisible();
      // El listado de acciones no trae el formulario: se abre al elegirlo.
      await expect(page.getByLabel("Motivo")).toBeHidden();

      await recovery.click();
      await expect(page.getByLabel("Código de incidente de la tablet")).toBeVisible();
      await expect(page.getByLabel("Motivo")).toHaveAttribute("maxlength", "500");
      await expect(page.getByLabel("Motivo")).toHaveAttribute("minlength", "3");

      await page.getByRole("button", { name: "Cerrar recuperación de tablet" }).click();
      await expect(page.getByLabel("Motivo")).toBeHidden();
      await expect(more).toBeFocused();
    });
  });
}

for (const width of [414, 960]) {
  test.describe(`asistencia · contención responsive ${width}`, () => {
    test.use({ viewport: { width, height: 800 }, hasTouch: width < 780, isMobile: width < 780 });

    test("los filtros y Más acciones permanecen dentro del viewport", async ({ page }) => {
      await openAttendance(page);
      const toolbar = header(page);
      expect(await toolbar.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
      await toolbar.getByRole("button", { name: /^más acciones$/i }).click();
      const recovery = page.getByRole("button", { name: /recuperar un intento de la tablet/i });
      await expect(recovery).toBeVisible();
      const recoveryBox = await box(recovery);
      expect(recoveryBox.x).toBeGreaterThanOrEqual(0);
      expect(recoveryBox.x + recoveryBox.width).toBeLessThanOrEqual(width + 0.5);
      expect(await toolbar.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    });
  });
}

test.describe("asistencia · encabezado sin rol de gestión", () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  test("SUPERVISOR conserva los filtros pero no ve acciones de gestión", async ({ page }) => {
    await openAttendance(page, SUPERVISOR);
    const toolbar = header(page);

    await expect(toolbar.getByRole("combobox", { name: "Empleado", exact: true })).toBeVisible();
    await expect(periodTrigger(page)).toBeVisible();
    await expect(toolbar.getByRole("button", { name: /^exportar csv$/i })).toBeVisible();
    await expect(toolbar.getByRole("button", { name: /^más acciones$/i })).toHaveCount(0);
    await expect(page.getByRole("link", { name: /horas anteriores/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /recuperar un intento de la tablet/i })).toHaveCount(0);
  });
});
