import { expect, test } from "@playwright/test";

const user = {
  id: "admin-1", username: "admin", role: "ADMIN", active: true,
  must_change_password: false, last_login_at: null, created_at: "2026-01-01T00:00:00Z",
};
const employee = {
  id: "employee-1", dni: "74033256", employee_code: "EMP-004",
  first_name: "DANIEL GUILLERMO", last_name: "ROSALES VILLAFUERTE",
  job_role_id: "role-1", job_role_name: "Operario", hire_date: "2026-01-01",
  termination_date: null, active: true, qr_token: "qr", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
};

test("perfil selecciona fechas, previsualiza y guarda un adicional con un único envío", async ({ page }) => {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const initialReads = new Map<string, number>();
  await page.addInitScript((sessionUser) => sessionStorage.setItem(
    "agua-renew-admin-session-hint",
    JSON.stringify({ version: 1, storedAt: Date.now(), user: sessionUser }),
  ), user);

  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const body = request.postData() ? request.postDataJSON() as Record<string, unknown> : {};
    if (request.method() === "GET") initialReads.set(path, (initialReads.get(path) ?? 0) + 1);
    if (path.endsWith("/auth/me")) return route.fulfill({ json: user });
    if (path.endsWith("/employees/employee-1")) return route.fulfill({ json: employee });
    if (path.endsWith("/employees/employee-1/qr")) return route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" />' });
    if (path.includes("/attendance-agenda")) {
      const days = Array.from({ length: 30 }, (_, index) => {
        const work_date = `2026-09-${String(index + 1).padStart(2, "0")}`;
        return {
          work_date, expected_minutes: index % 7 === 6 ? 0 : 480,
          statuses: index % 7 === 6 ? ["REST"] : ["NO_RECORD"], attendance: [], manual_day: null,
          adjustments: index === 1 ? [{ id: "adjustment-1", version: 1, adjustment_date: work_date, minutes: 60, adjustment_type: "OTRO", status: "APPROVED", reason: "Apoyo", voided_at: null, approval_invalidated: false }] : [],
          recovery_commitments: [],
        };
      });
      return route.fulfill({ json: { employee_id: employee.id, date_from: "2026-09-01", date_to: "2026-09-30", days } });
    }
    if (path.includes("/payroll-accrual")) return route.fulfill({ json: {
      employee_id: employee.id, date_from: "2026-09-16", date_to: "2026-09-30", cutoff_date: "2026-09-17",
      base_amount: "566.67", approved_additional_amount: "31.50", pending_additional_amount: "0.00",
      manual_adjustment_amount: "0.00", estimated_total: "598.17", official_total_snapshot: null,
      closed_period: null, daily: [],
    } });
    if (path.endsWith("/recovery-commitments")) return route.fulfill({ json: [] });
    if (path.endsWith("/manual-days/multi/preview")) {
      calls.push({ path, body });
      const dates = body.work_dates as string[];
      await new Promise((resolve) => setTimeout(resolve, 180));
      return route.fulfill({ json: { preview_token: "p".repeat(64), expires_at: "2026-09-17T20:00:00Z", items: dates.map((work_date) => ({ work_date, status: "READY", effective_row: { ...(body.template as object), employee_id: employee.id }, payment_preview: { status: "PENDING", amount: "31.50" } })) } });
    }
    if (path.endsWith("/manual-days/multi")) {
      calls.push({ path, body });
      const dates = body.work_dates as string[];
      return route.fulfill({ json: { operation_id: "operation-1", idempotency_key: body.idempotency_key, status: "CONFIRMED", items: dates.map((work_date, index) => ({ work_date, manual_day_id: `manual-${index}`, version: 1 })) } });
    }
    if (path.endsWith("/schedule/history") || path.endsWith("/salary-settings/history") || path.endsWith("/adjustments")) return route.fulfill({ json: [] });
    if (path.endsWith("/schedule") || path.endsWith("/salary-settings")) return route.fulfill({ status: 404, json: { detail: "No configurado" } });
    if (path.endsWith("/balance")) return route.fulfill({ json: { date_from: "2026-09-01", date_to: "2026-09-17", worked_minutes: 0, expected_minutes: 0, adjustment_minutes: 0, overtime_minutes: 0, recovery_credit_minutes: 0, balance_minutes: 0 } });
    if (path.includes("/overtime/")) return route.fulfill({ json: path.endsWith("/value") ? { overtime_minutes: 0, value: "0.00" } : [] });
    return route.fulfill({ json: [] });
  });

  await page.goto("/admin/employees/employee-1");
  await expect(page.getByRole("heading", { name: "Asistencia, horas y acumulado" })).toBeVisible();
  await expect(page.getByText("S/ 598.17", { exact: true })).toBeVisible();
  await page.getByLabel("Periodo acumulado").click();
  await expect(page.getByRole("option", { name: "Mes completo" })).toBeVisible();
  await page.getByLabel("Periodo acumulado").press("Escape");
  await page.getByLabel("Mes", { exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Seleccionar mes" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByLabel("Mes", { exact: true })).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("dialog", { name: "Seleccionar mes" })).toBeHidden();
  expect(initialReads.get("/api/v1/employees/employee-1")).toBe(1);
  expect(initialReads.get("/api/v1/employees/employee-1/attendance-agenda")).toBe(1);
  expect(initialReads.get("/api/v1/employees/employee-1/payroll-accrual")).toBe(1);

  await page.getByRole("gridcell").filter({ hasText: /^2Sin registro/ }).click();
  await expect(page.getByRole("button", { name: "Registrar 1 fecha" })).toBeVisible();
  await page.getByRole("gridcell").filter({ hasText: /^3Sin registro/ }).click();
  await page.getByRole("button", { name: "Registrar 2 fechas" }).click();
  await expect(page.getByRole("dialog", { name: "Registrar en las fechas seleccionadas" })).toBeVisible();
  await page.getByLabel("Tratamiento").click();
  await page.getByRole("option", { name: "Adicional pagado" }).click();
  await page.getByLabel("Actividad realizada en las horas adicionales").fill("Mantenimiento y cierre de ruta");
  await page.getByRole("button", { name: "Previsualizar lote" }).click();
  await expect(page.getByRole("button", { name: "Comprobando fechas…" })).toBeDisabled();
  await expect(page.getByText("Resultado de la previsualización")).toBeVisible();
  await page.getByRole("button", { name: "Guardar 2 fechas" }).click();
  await expect(page.getByText("2 fechas guardadas. La agenda y el acumulado ya están actualizados.")).toBeVisible();

  expect(calls).toHaveLength(2);
  expect(calls[0].body.work_dates).toEqual(["2026-09-02", "2026-09-03"]);
  expect(calls[1].body.idempotency_key).toBe(calls[0].body.idempotency_key);
  expect(calls[1].body.preview_token).toBe("p".repeat(64));
});

test("las acciones secundarias del perfil se abren en diálogos y Escape las cierra", async ({ page }) => {
  await page.addInitScript((sessionUser) => sessionStorage.setItem("agua-renew-admin-session-hint", JSON.stringify({ version: 1, storedAt: Date.now(), user: sessionUser })), user);
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/auth/me")) return route.fulfill({ json: user });
    if (path.endsWith("/employees/employee-1")) return route.fulfill({ json: employee });
    if (path.includes("/attendance-agenda")) return route.fulfill({ json: { employee_id: employee.id, date_from: "2026-09-01", date_to: "2026-09-30", days: [] } });
    if (path.includes("/payroll-accrual")) return route.fulfill({ json: { employee_id: employee.id, date_from: "2026-09-16", date_to: "2026-09-30", cutoff_date: "2026-09-17", base_amount: "0.00", approved_additional_amount: "0.00", pending_additional_amount: "0.00", manual_adjustment_amount: "0.00", estimated_total: "0.00", official_total_snapshot: null, closed_period: null, daily: [] } });
    if (path.endsWith("/recovery-commitments") || path.endsWith("/schedule/history") || path.endsWith("/salary-settings/history") || path.endsWith("/adjustments")) return route.fulfill({ json: [] });
    if (path.endsWith("/schedule") || path.endsWith("/salary-settings")) return route.fulfill({ status: 404, json: { detail: "No configurado" } });
    if (path.endsWith("/balance")) return route.fulfill({ json: { date_from: "2026-09-01", date_to: "2026-09-17", worked_minutes: 0, expected_minutes: 0, adjustment_minutes: 0, overtime_minutes: 0, recovery_credit_minutes: 0, balance_minutes: 0 } });
    if (path.includes("/overtime/")) return route.fulfill({ json: [] });
    return route.fulfill({ json: [] });
  });
  await page.goto("/admin/employees/employee-1");
  for (const [button, dialog] of [["Nueva jornada", "Nueva jornada laboral"], ["Configurar sueldo", "Configurar sueldo"], ["Nuevo ajuste", "Nuevo ajuste"], ["Gestionar descansos y feriados", "Descansos y feriados"]] as const) {
    await page.getByRole("button", { name: button }).click();
    const modal = page.getByRole("dialog", { name: dialog });
    await expect(modal).toBeVisible();
    await expect(modal.locator("..")).toHaveAttribute("data-motion-state", "open");
    await page.keyboard.press("Escape");
    await expect(modal.locator("..")).toHaveAttribute("data-motion-state", "exiting");
    await expect(modal).toBeHidden();
  }

  await page.getByRole("button", { name: "Nuevo ajuste" }).click();
  const adjustmentDialog = page.getByRole("dialog", { name: "Nuevo ajuste" });
  await adjustmentDialog.getByRole("button", { name: "Cancelar" }).click();
  await expect(adjustmentDialog.locator("..")).toHaveAttribute("data-motion-state", "exiting");
  await expect(adjustmentDialog).toBeHidden();

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "Nuevo ajuste" }).click();
  const reducedDialog = page.getByRole("dialog", { name: "Nuevo ajuste" });
  await expect(reducedDialog).toBeVisible();
  await expect.poll(() => reducedDialog.evaluate((element) => getComputedStyle(element).transform)).toBe("none");
  await page.keyboard.press("Escape");
  await expect(reducedDialog).toBeHidden();
});

test("agenda no genera desborde horizontal en móvil", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 760 });
  await page.addInitScript((sessionUser) => sessionStorage.setItem("agua-renew-admin-session-hint", JSON.stringify({ version: 1, storedAt: Date.now(), user: sessionUser })), user);
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/auth/me")) return route.fulfill({ json: user });
    if (path.endsWith("/employees/employee-1")) return route.fulfill({ json: employee });
    if (path.includes("/attendance-agenda")) return route.fulfill({ json: { employee_id: employee.id, date_from: "2026-09-01", date_to: "2026-09-30", days: Array.from({ length: 30 }, (_, index) => ({ work_date: `2026-09-${String(index + 1).padStart(2, "0")}`, expected_minutes: 480, statuses: ["NO_RECORD"], attendance: [], manual_day: null, adjustments: [], recovery_commitments: [] })) } });
    if (path.includes("/payroll-accrual")) return route.fulfill({ json: { employee_id: employee.id, date_from: "2026-09-16", date_to: "2026-09-30", cutoff_date: "2026-09-17", base_amount: "0.00", approved_additional_amount: "0.00", pending_additional_amount: "0.00", manual_adjustment_amount: "0.00", estimated_total: "0.00", official_total_snapshot: null, closed_period: null, daily: [] } });
    if (path.endsWith("/recovery-commitments") || path.endsWith("/schedule/history") || path.endsWith("/salary-settings/history") || path.endsWith("/adjustments")) return route.fulfill({ json: [] });
    if (path.endsWith("/schedule") || path.endsWith("/salary-settings")) return route.fulfill({ status: 404, json: { detail: "No configurado" } });
    if (path.endsWith("/balance")) return route.fulfill({ json: { date_from: "2026-09-01", date_to: "2026-09-17", worked_minutes: 0, expected_minutes: 0, adjustment_minutes: 0, overtime_minutes: 0, recovery_credit_minutes: 0, balance_minutes: 0 } });
    if (path.includes("/overtime/")) return route.fulfill({ json: [] });
    return route.fulfill({ json: [] });
  });
  await page.goto("/admin/employees/employee-1");
  await expect(page.getByRole("heading", { name: "Asistencia, horas y acumulado" })).toBeVisible();
  const width = await page.evaluate(() => ({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
  expect(width.scroll).toBeLessThanOrEqual(width.client + 1);
  await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
  const widthAt200 = await page.evaluate(() => ({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
  expect(widthAt200.scroll).toBeLessThanOrEqual(widthAt200.client + 1);
});

test("el listado abre el editor compartido y anula un ajuste vigente", async ({ page }) => {
  const mutations: Array<{ path: string; body: Record<string, unknown> }> = [];
  const adjustment = {
    id: "adjustment-1", employee_id: employee.id, version: 2, adjustment_date: "2026-09-02", minutes: 60,
    adjustment_type: "OTRO", status: "APPROVED", reason: "Apoyo", approved_by: "admin-1", approved_by_username: "admin",
    approved_at: "2026-09-03T10:00:00Z", created_at: "2026-09-02T10:00:00Z", updated_at: "2026-09-03T10:00:00Z", voided_at: null,
  };
  const adjustments = [
    adjustment,
    { ...adjustment, id: "adjustment-pending", adjustment_date: "2026-09-03", status: "PENDING" as const, reason: "Pendiente de revisión", approved_by_username: null },
    { ...adjustment, id: "adjustment-rejected", adjustment_date: "2026-09-04", status: "REJECTED" as const, reason: "Rechazado con motivo", approved_by_username: null },
  ];
  await page.addInitScript((sessionUser) => sessionStorage.setItem("agua-renew-admin-session-hint", JSON.stringify({ version: 1, storedAt: Date.now(), user: sessionUser })), user);
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const body = request.postData() ? request.postDataJSON() as Record<string, unknown> : {};
    if (path.endsWith("/auth/me")) return route.fulfill({ json: user });
    if (path.endsWith("/employees/employee-1")) return route.fulfill({ json: employee });
    if (path.includes("/attendance-agenda")) return route.fulfill({ json: { employee_id: employee.id, date_from: "2026-09-01", date_to: "2026-09-30", days: Array.from({ length: 30 }, (_, index) => ({ work_date: `2026-09-${String(index + 1).padStart(2, "0")}`, expected_minutes: 480, statuses: ["NO_RECORD"], attendance: [], manual_day: null, adjustments: index === 1 ? [adjustment] : [], recovery_commitments: [] })) } });
    if (path.includes("/payroll-accrual")) return route.fulfill({ json: { employee_id: employee.id, date_from: "2026-09-16", date_to: "2026-09-30", cutoff_date: "2026-09-17", base_amount: "0.00", approved_additional_amount: "0.00", pending_additional_amount: "0.00", manual_adjustment_amount: "0.00", estimated_total: "0.00", official_total_snapshot: null, closed_period: null, daily: [] } });
    if (path.endsWith("/adjustments/adjustment-1") && request.method() === "PATCH") { mutations.push({ path, body }); return route.fulfill({ json: { ...adjustment, id: "adjustment-2", version: 3, status: "PENDING" } }); }
    if (path.endsWith("/adjustments/adjustment-1/void")) { mutations.push({ path, body }); return route.fulfill({ json: { ...adjustment, version: 3, voided_at: "2026-09-17T18:00:00Z" } }); }
    if (path.endsWith("/recovery-commitments") || path.endsWith("/schedule/history") || path.endsWith("/salary-settings/history")) return route.fulfill({ json: [] });
    if (path.endsWith("/adjustments")) return route.fulfill({ json: adjustments });
    if (path.endsWith("/schedule") || path.endsWith("/salary-settings")) return route.fulfill({ status: 404, json: { detail: "No configurado" } });
    if (path.endsWith("/balance")) return route.fulfill({ json: { date_from: "2026-09-01", date_to: "2026-09-17", worked_minutes: 0, expected_minutes: 0, adjustment_minutes: 0, overtime_minutes: 0, recovery_credit_minutes: 0, balance_minutes: 0 } });
    if (path.includes("/overtime/")) return route.fulfill({ json: path.endsWith("/value") ? { overtime_minutes: 0, value: "0.00" } : [] });
    return route.fulfill({ json: [] });
  });

  await page.goto("/admin/employees/employee-1");
  const approvedRow = page.locator("li.card").filter({ hasText: "Aprobado por admin" });
  const pendingRow = page.locator("li.card").filter({ hasText: "Pendiente de revisión" });
  const rejectedRow = page.locator("li.card").filter({ hasText: "Rechazado con motivo" });
  await expect(approvedRow.getByRole("button", { name: "Editar" })).toBeVisible();
  await expect(approvedRow.getByRole("button", { name: "Eliminar" })).toBeVisible();
  await expect(pendingRow.getByRole("button", { name: "Editar" })).toBeVisible();
  await expect(pendingRow.getByRole("button", { name: "Eliminar" })).toBeVisible();
  await expect(pendingRow.getByRole("button", { name: "Aprobar" })).toBeVisible();
  await expect(pendingRow.getByRole("button", { name: "Rechazar" })).toBeVisible();
  await expect(rejectedRow.getByRole("button", { name: "Editar" })).toBeVisible();
  await expect(rejectedRow.getByRole("button", { name: "Eliminar" })).toBeVisible();
  await approvedRow.getByRole("button", { name: "Editar" }).click();
  await expect(page.getByRole("dialog", { name: "Editar ajuste" })).toBeVisible();
  await page.getByRole("dialog", { name: "Editar ajuste" }).getByLabel("Motivo").fill("Apoyo corregido");
  await page.getByRole("button", { name: "Guardar cambios" }).click();
  await expect(page.getByText("Ajuste actualizado. La nueva versión quedó pendiente de aprobación.")).toBeVisible();
  await approvedRow.getByRole("button", { name: "Eliminar" }).click();
  await page.getByLabel("Motivo obligatorio").fill("Registro duplicado de prueba");
  await page.getByRole("button", { name: "Eliminar ajuste" }).click();
  await expect(page.getByText("Ajuste anulado y retirado de los cálculos. El historial se conserva.")).toBeVisible();
  expect(mutations).toHaveLength(2);
  expect(mutations[0].body.expected_version).toBe(2);
  expect(mutations[1].body.reason).toBe("Registro duplicado de prueba");
});

test("perfil previsualiza una edición versionada y anula la carga conservando el motivo", async ({ page }) => {
  const mutations: Array<{ path: string; body: Record<string, unknown> }> = [];
  await page.addInitScript((sessionUser) => sessionStorage.setItem("agua-renew-admin-session-hint", JSON.stringify({ version: 1, storedAt: Date.now(), user: sessionUser })), user);
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const body = request.postData() ? request.postDataJSON() as Record<string, unknown> : {};
    if (path.endsWith("/auth/me")) return route.fulfill({ json: user });
    if (path.endsWith("/employees/employee-1")) return route.fulfill({ json: employee });
    if (path.includes("/attendance-agenda")) return route.fulfill({ json: {
      employee_id: employee.id, date_from: "2026-09-01", date_to: "2026-09-30",
      days: Array.from({ length: 30 }, (_, index) => {
        const work_date = `2026-09-${String(index + 1).padStart(2, "0")}`;
        return { work_date, expected_minutes: 480, statuses: index === 1 ? ["COMPLETE"] : ["NO_RECORD"], attendance: [],
          manual_day: index === 1 ? { id: "manual-1", version: 3, employee_id: employee.id, work_date, worked_minutes_net: 480, normal_minutes: 480, additional_minutes: 0, recovery_minutes: 0, known_check_in_at: null, known_check_out_at: null, known_break_minutes: null, day_context: "ORDINARY", source_reference: null, payment_method: null, payment_concept: null, reviewed_additional_amount: null, reason: "Carga original", recovery_allocations: [] } : null,
          adjustments: [], recovery_commitments: [] };
      }),
    } });
    if (path.includes("/payroll-accrual")) return route.fulfill({ json: { employee_id: employee.id, date_from: "2026-09-16", date_to: "2026-09-30", cutoff_date: "2026-09-17", base_amount: "0.00", approved_additional_amount: "0.00", pending_additional_amount: "0.00", manual_adjustment_amount: "0.00", estimated_total: "0.00", official_total_snapshot: null, closed_period: null, daily: [] } });
    if (path.endsWith("/manual-days/preview")) { mutations.push({ path, body }); return route.fulfill({ json: { preview_token: "e".repeat(64), expires_at: "2026-09-17T20:00:00Z", items: [] } }); }
    if (path.endsWith("/manual-days/manual-1") && request.method() === "PATCH") { mutations.push({ path, body }); return route.fulfill({ json: { id: "manual-2", version: 4 } }); }
    if (path.endsWith("/manual-days/manual-1/void")) { mutations.push({ path, body }); return route.fulfill({ json: { id: "manual-1", version: 4, voided_at: "2026-09-17T18:00:00Z" } }); }
    if (path.endsWith("/recovery-commitments") || path.endsWith("/schedule/history") || path.endsWith("/salary-settings/history") || path.endsWith("/adjustments")) return route.fulfill({ json: [] });
    if (path.endsWith("/schedule") || path.endsWith("/salary-settings")) return route.fulfill({ status: 404, json: { detail: "No configurado" } });
    if (path.endsWith("/balance")) return route.fulfill({ json: { date_from: "2026-09-01", date_to: "2026-09-17", worked_minutes: 0, expected_minutes: 0, adjustment_minutes: 0, overtime_minutes: 0, recovery_credit_minutes: 0, balance_minutes: 0 } });
    if (path.includes("/overtime/")) return route.fulfill({ json: [] });
    return route.fulfill({ json: [] });
  });

  await page.goto("/admin/employees/employee-1");
  await page.getByRole("gridcell").filter({ hasText: /^2Completa/ }).click();
  await page.getByRole("button", { name: "Editar" }).click();
  await page.getByRole("dialog", { name: /Editar carga/ }).getByLabel("Motivo", { exact: true }).fill("Corrección administrativa revisada");
  await page.getByRole("button", { name: "Previsualizar cambio" }).click();
  await page.getByRole("button", { name: "Guardar nueva versión" }).click();
  await expect(page.getByText("Carga actualizada mediante una nueva versión.")).toBeVisible();

  await page.getByRole("gridcell").filter({ hasText: /^2Completa/ }).click();
  await page.getByRole("button", { name: "Anular" }).click();
  await page.getByLabel("Motivo obligatorio").fill("Registro administrativo duplicado");
  await page.getByRole("button", { name: "Anular carga" }).click();
  await expect(page.getByText("Carga anulada y retirada de los cálculos. Su historial se conserva.")).toBeVisible();

  expect(mutations).toHaveLength(3);
  expect(mutations[1].body.expected_version).toBe(3);
  expect(mutations[1].body.preview_token).toBe("e".repeat(64));
  expect(mutations[2].body.expected_version).toBe(3);
  expect(mutations[2].body.reason).toBe("Registro administrativo duplicado");
});
