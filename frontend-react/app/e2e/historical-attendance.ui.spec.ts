import { expect, test, type Page } from "@playwright/test";
import { ApiError, apiFetch } from "../src/lib/api";
import { classifyHistoricalOperationResult } from "../src/lib/historicalAttendanceOperation";

const user = {
  id: "test-admin",
  username: "admin",
  role: "ADMIN",
  active: true,
  must_change_password: false,
  last_login_at: null,
  created_at: "2026-01-01T00:00:00Z",
};

const employees = [
  ["employee-normal", "Nora", "Normal", "HST-N"],
  ["employee-additional", "Adela", "Adicional", "HST-P"],
  ["employee-recovery", "Rita", "Recuperación", "HST-R"],
  ["employee-mixed", "Mauro", "Mixto", "HST-M"],
].map(([id, first_name, last_name, employee_code]) => ({
  id,
  first_name,
  last_name,
  employee_code,
  active: true,
}));

const MONTHS_ES = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];

/**
 * DateField (no es un <input type="date">): pulsa el trigger por su etiqueta,
 * navega los meses usando el encabezado español y elige el día dentro del
 * role=dialog del calendario portaleado. Robusto para días de otro mes/año.
 */
async function selectDateField(page: Page, label: string, iso: string) {
  const [year, month, day] = iso.split("-").map(Number);
  const targetIndex = year * 12 + (month - 1);

  await page.getByLabel(label, { exact: true }).click();
  const calendar = page.getByRole("dialog", { name: `Calendario: ${label}` });
  await expect(calendar).toBeVisible();
  const header = calendar.locator(".datefield-month");

  for (let guard = 0; guard < 48; guard += 1) {
    const text = (await header.textContent())?.trim() ?? "";
    const match = text.match(/^([A-Za-zÁÉÍÓÚÜÑáéíóúüñ]+)\s+(\d{4})$/);
    if (!match) throw new Error(`Encabezado de calendario inesperado: "${text}"`);
    const currentIndex = Number(match[2]) * 12 + MONTHS_ES.indexOf(match[1]);
    if (currentIndex === targetIndex) break;
    await calendar
      .getByRole("button", { name: currentIndex < targetIndex ? "Mes siguiente" : "Mes anterior" })
      .click();
    if (guard === 47) throw new Error(`No se pudo navegar el calendario hacia ${iso}`);
  }

  await calendar.getByRole("button", { name: String(day), exact: true }).click();
  await expect(calendar).toBeHidden();
}


test("HST-01 previsualiza, guarda y consulta normal, adicional, recuperación y mixto", async ({ page }) => {
  const history: Array<Record<string, unknown>> = [];
  const savedPayloads: Array<{ rows: Array<Record<string, unknown>>; approve_additional: boolean }> = [];

  await page.addInitScript((sessionUser) => {
    sessionStorage.setItem("agua-renew-admin-session-hint", JSON.stringify({
      version: 1,
      storedAt: Date.now(),
      user: sessionUser,
    }));
  }, user);

  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const body = request.postDataJSON() as { rows?: Array<Record<string, unknown>>; approve_additional?: boolean } | null;
    if (path.endsWith("/auth/me")) return route.fulfill({ json: user });
    if (path.endsWith("/employees")) return route.fulfill({ json: employees });
    if (path.endsWith("/manual-days") && request.method() === "GET") return route.fulfill({ json: history });
    if (path.endsWith("/recovery-commitments")) {
      return route.fulfill({ json: [{ id: "commitment-1", employee_id: "employee-recovery", pending_minutes: 120, reference: "Permiso 120" }] });
    }
    if (path.endsWith("/manual-days/preview")) return route.fulfill({ json: { preview_token: "a".repeat(64), rows: (body?.rows ?? []).map((row) => ({
      ...row,
      payment: Number(row.additional_minutes) > 0 ? {
        status: "PENDING",
        amount: row.payment_method === "REVIEWED" ? row.reviewed_additional_amount : "31.50",
        method: row.payment_method ?? "OVERTIME",
        concept: row.payment_concept,
        reference: row.source_reference,
      } : { status: "NOT_APPLICABLE", amount: "0.00" },
    })) } });
    if (path.endsWith("/manual-days/batch")) {
      const rows = body?.rows ?? [];
      savedPayloads.push({ rows, approve_additional: Boolean(body?.approve_additional) });
      for (const row of rows) {
        history.push({
          id: `history-${history.length + 1}`,
          work_date: "2026-09-10",
          worked_minutes_net: row.worked_minutes_net,
          payment_status: body?.approve_additional && row.additional_minutes ? "APPROVED" : "NOT_APPLICABLE",
          version: 1,
          reason: row.reason,
          payment_snapshot: null,
        });
      }
      return route.fulfill({ json: { created: rows.map((_, index) => `history-${history.length + index + 1}`) } });
    }
    return route.fulfill({ json: [] });
  });

  await page.goto("/admin/attendance/history");
  await expect(page.getByRole("heading", { name: "Cargar horas anteriores" })).toBeVisible();
  await selectDateField(page, "Fecha trabajada", "2026-09-10");

  const save = async (rowIndex: number, treatment: "NORMAL" | "ADDITIONAL" | "RECOVERY" | "MIXED", hours: string, minutes: string, approve = false) => {
    const row = page.locator("tbody tr").nth(rowIndex);
    await row.getByRole("checkbox").check();
    await row.getByLabel("Horas").fill(hours);
    await row.getByLabel("Minutos").fill(minutes);
    await row.locator("select").first().selectOption(treatment);
    if (treatment === "RECOVERY") {
      await expect(row.getByLabel("Compromiso")).toBeVisible();
      await row.getByLabel("Compromiso").selectOption("commitment-1");
    }
    if (treatment === "MIXED") {
      await row.getByLabel("Normal").fill("240");
      await row.getByLabel("Adicional").fill("120");
      await row.getByLabel("Recuperación").fill("120");
    }
    if (treatment === "ADDITIONAL" || treatment === "MIXED") {
      await row.getByLabel("Método de pago adicional").selectOption("OVERTIME");
    }
    await page.getByRole("button", { name: "Previsualizar" }).click();
    await expect(page.getByRole("heading", { name: "Previsualización" })).toBeVisible();
    await (approve
      ? page.getByRole("button", { name: "Guardar y aprobar adicionales" })
      : page.getByRole("button", { name: "Guardar horas" }))
      .click();
    await expect(page.getByText("1 carga(s) registrada(s).", { exact: true })).toBeVisible();
  };

  await save(0, "NORMAL", "8", "0");
  await save(1, "ADDITIONAL", "2", "0", true);
  await save(2, "RECOVERY", "2", "0");
  await save(3, "MIXED", "8", "0", true);

  expect(savedPayloads.map(({ rows }) => rows[0])).toMatchObject([
    { worked_minutes_net: 480, normal_minutes: 480, additional_minutes: 0, recovery_minutes: 0 },
    { worked_minutes_net: 120, normal_minutes: 0, additional_minutes: 120, recovery_minutes: 0 },
    { worked_minutes_net: 120, normal_minutes: 0, additional_minutes: 0, recovery_minutes: 120, recovery_allocations: [{ commitment_id: "commitment-1", minutes: 120 }] },
    { worked_minutes_net: 480, normal_minutes: 240, additional_minutes: 120, recovery_minutes: 120 },
  ]);
  expect(savedPayloads.map(({ approve_additional }) => approve_additional)).toEqual([false, true, false, true]);
  await expect(page.getByRole("heading", { name: "Historial de cargas" })).toBeVisible();
  const historyPanel = page.getByRole("heading", { name: "Historial de cargas" }).locator("..");
  await expect(historyPanel.getByText("8 h 00", { exact: true })).toHaveCount(2);
  await expect(historyPanel.getByText("2 h 00", { exact: true })).toHaveCount(2);
});

test("HST-01 envía una valoración REVIEWED y no previsualiza S/0 ni campos incompletos", async ({ page }) => {
  let previewRequests = 0;
  let previewPayload: Record<string, unknown> | undefined;
  await page.addInitScript((sessionUser) => sessionStorage.setItem("agua-renew-admin-session-hint", JSON.stringify({ version: 1, storedAt: Date.now(), user: sessionUser })), user);
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request(); const path = new URL(request.url()).pathname;
    const body = request.postDataJSON() as (Record<string, unknown> & { rows?: Array<Record<string, unknown>> }) | null;
    if (path.endsWith("/auth/me")) return route.fulfill({ json: user });
    if (path.endsWith("/employees")) return route.fulfill({ json: employees });
    if (path.endsWith("/manual-days") && request.method() === "GET") return route.fulfill({ json: [] });
    if (path.endsWith("/manual-days/preview")) { previewRequests += 1; previewPayload = body?.rows?.[0]; return route.fulfill({ json: { preview_token: "b".repeat(64), rows: [{ ...previewPayload, payment: { status: "PENDING", amount: "125.50", method: "REVIEWED", concept: "Feriado trabajado", reference: "Acta RRHH 001" } }] } }); }
    return route.fulfill({ json: [] });
  });
  await page.goto("/admin/attendance/history");
  await selectDateField(page, "Fecha trabajada", "2026-09-10");
  const row = page.locator("tbody tr").first();
  await row.getByRole("checkbox").check();
  await row.getByLabel("Horas").fill("2");
  await row.getByLabel("Minutos").fill("0");
  await row.locator("select").first().selectOption("ADDITIONAL");
  await page.getByRole("button", { name: "Previsualizar" }).click();
  await expect(page.getByText("Seleccione el tratamiento de pago para cada adicional.", { exact: true })).toBeVisible();
  await expect.poll(() => previewRequests).toBe(0);
  await row.getByLabel("Método de pago adicional").selectOption("REVIEWED");
  await row.getByLabel("Importe revisado", { exact: true }).fill("0");
  await page.getByRole("button", { name: "Previsualizar" }).click();
  await expect(page.getByText("El importe revisado debe ser mayor que S/ 0.00.", { exact: true })).toBeVisible();
  await row.getByLabel("Importe revisado", { exact: true }).fill("125.50");
  await page.getByRole("button", { name: "Previsualizar" }).click();
  await expect(page.getByText("El concepto del importe revisado es obligatorio.", { exact: true })).toBeVisible();
  await row.getByLabel("Concepto de importe revisado").fill("Feriado trabajado");
  await page.getByRole("button", { name: "Previsualizar" }).click();
  await expect(page.getByText("La referencia del importe revisado es obligatoria.", { exact: true })).toBeVisible();
  await row.getByLabel("Referencia de importe revisado").fill("Acta RRHH 001");
  await page.getByRole("button", { name: "Previsualizar" }).click();
  await expect(page.getByText("Importe acordado · S/ 125.50 · Pendiente de aprobación")).toBeVisible();
  await expect(page.getByText("Feriado trabajado · Acta RRHH 001")).toBeVisible();
  await expect(page.getByRole("button", { name: "Guardar y aprobar adicionales" })).toBeEnabled();
  expect(previewPayload).toMatchObject({ payment_method: "REVIEWED", payment_concept: "Feriado trabajado", source_reference: "Acta RRHH 001", reviewed_additional_amount: "125.50" });
});

test("HST-01 edita una carga normal como distribución y avisa si su versión queda obsoleta", async ({ page }) => {
  let patchCalls = 0;
  let latest: Record<string, unknown> = {
    id: "history-1", employee_id: "employee-normal", work_date: "2026-09-10",
    worked_minutes_net: 480, normal_minutes: 480, additional_minutes: 0, recovery_minutes: 0,
    known_check_in_at: null, known_check_out_at: null, known_break_minutes: null,
    reason: "Carga inicial", payment_status: "NOT_APPLICABLE", payment_method: null,
    payment_concept: null, source_reference: null, reviewed_additional_amount: null,
    payment_snapshot: null, recovery_allocations: [], version: 1, created_at: "2026-09-11T12:00:00Z",
  };
  let updatePayload: Record<string, unknown> | undefined;
  await page.addInitScript((sessionUser) => sessionStorage.setItem("agua-renew-admin-session-hint", JSON.stringify({ version: 1, storedAt: Date.now(), user: sessionUser })), user);
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request(); const path = new URL(request.url()).pathname;
    const body = request.postDataJSON() as { rows?: Array<Record<string, unknown>> } | null;
    if (path.endsWith("/auth/me")) return route.fulfill({ json: user });
    if (path.endsWith("/employees")) return route.fulfill({ json: employees });
    if (path.endsWith("/manual-days") && request.method() === "GET") return route.fulfill({ json: [latest] });
    if (path.endsWith("/recovery-commitments")) return route.fulfill({ json: [] });
    if (path.endsWith("/manual-days/preview")) return route.fulfill({ json: { preview_token: "c".repeat(64), rows: [{ ...body?.rows?.[0], payment: { status: "PENDING", amount: "31.50", method: "OVERTIME" } }] } });
    if (path.endsWith("/manual-days/history-1") && request.method() === "GET") return route.fulfill({ json: latest });
    if (path.endsWith("/manual-days/history-1") && request.method() === "PATCH") {
      patchCalls += 1; updatePayload = body ?? undefined;
      if (patchCalls === 1) {
        latest = { ...latest, id: "history-2", normal_minutes: 360, additional_minutes: 120, payment_status: "PENDING", payment_method: "OVERTIME", payment_snapshot: { status: "PENDING", amount: "31.50", method: "OVERTIME" }, version: 2 };
        return route.fulfill({ json: latest });
      }
      return route.fulfill({ status: 409, json: { detail: { code: "STALE_VERSION", message: "La carga fue modificada por otra persona" } } });
    }
    if (path.endsWith("/manual-days/history-2") && request.method() === "GET") return route.fulfill({ json: latest });
    if (path.endsWith("/manual-days/history-2") && request.method() === "PATCH") return route.fulfill({ status: 409, json: { detail: { code: "STALE_VERSION", message: "La carga fue modificada por otra persona" } } });
    return route.fulfill({ json: [] });
  });

  await page.goto("/admin/attendance/history");
  await expect(page.getByText("Carga histórica administrativa")).toBeVisible();
  await expect(page.getByText("Entrada: Sin dato")).toBeVisible();
  await expect(page.getByText("Salida: Sin dato")).toBeVisible();
  await page.getByRole("button", { name: "Editar" }).click();
  await expect(page.getByRole("heading", { name: "Editar carga histórica" })).toBeVisible();
  await expect(page.getByLabel("Fecha inmutable")).toHaveValue("2026-09-10");
  await page.getByLabel("Cómo registrar estas horas").selectOption("MIXED");
  await page.getByLabel("Normal editado").fill("360");
  await page.getByLabel("Adicional editado").fill("120");
  await page.getByLabel("Método de pago adicional editado").selectOption("OVERTIME");
  await page.getByRole("button", { name: "Previsualizar cambios" }).click();
  await expect(page.getByText("Resultado: 8 h 00 trabajadas · 6 h 00 regulares · 2 h 00 adicionales · 0 h 00 recuperadas · Cálculo automático de horas extra · S/ 31.50 · Pendiente de aprobación")).toBeVisible();
  await page.getByRole("button", { name: "Guardar corrección" }).click();
  await expect(page.getByText("Corrección versionada guardada. El historial se actualizó.")).toBeVisible();
  expect(updatePayload).toMatchObject({ employee_id: "employee-normal", worked_minutes_net: 480, normal_minutes: 360, additional_minutes: 120, recovery_minutes: 0, expected_version: 1 });
  await expect(page.getByText("Versión 2")).toBeVisible();
  await page.getByRole("button", { name: "Editar" }).click();
  await page.getByRole("button", { name: "Previsualizar cambios" }).click();
  await page.getByRole("button", { name: "Guardar corrección" }).click();
  await expect(page.getByText("Esta carga cambió en otra sesión. Recargue el historial y vuelva a editar la versión vigente.")).toBeVisible();
});

test("A09/A14: descarta un preview tardío y el estado efectivo aprobado manda sobre el snapshot", async ({ page }) => {
  let releasePreview: (() => Promise<void>) | undefined;
  await page.addInitScript((sessionUser) => sessionStorage.setItem("agua-renew-admin-session-hint", JSON.stringify({ version: 1, storedAt: Date.now(), user: sessionUser })), user);
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/auth/me")) return route.fulfill({ json: user });
    if (path.endsWith("/employees")) return route.fulfill({ json: employees });
    if (path.endsWith("/manual-days") && request.method() === "GET") return route.fulfill({ json: [{
      id: "approved-but-old-snapshot", employee_id: "employee-additional", work_date: "2026-09-10",
      worked_minutes_net: 120, normal_minutes: 0, additional_minutes: 120, recovery_minutes: 0,
      reason: "A14", payment_status: "APPROVED", payment_snapshot: { status: "PENDING", amount: "31.50", method: "OVERTIME" }, version: 2,
    }] });
    if (path.endsWith("/manual-days/preview")) {
      const body = request.postDataJSON() as { rows?: unknown[] } | null;
      releasePreview = () => route.fulfill({ json: { preview_token: "d".repeat(64), rows: (body?.rows ?? []).map((row) => ({ ...(row as object), payment: { status: "PENDING", amount: "31.50", method: "OVERTIME" } })) } });
      return;
    }
    return route.fulfill({ json: [] });
  });
  await page.goto("/admin/attendance/history");
  await expect(page.getByText("Cálculo automático de horas extra · S/ 31.50 · Aprobado")).toBeVisible();
  await selectDateField(page, "Fecha trabajada", "2026-09-10");
  const row = page.locator("tbody tr").first();
  await row.getByRole("checkbox").check();
  await row.getByLabel("Horas").fill("2");
  await row.locator("select").first().selectOption("ADDITIONAL");
  await row.getByLabel("Método de pago adicional").selectOption("OVERTIME");
  await page.getByRole("button", { name: "Previsualizar" }).click();
  await expect.poll(() => Boolean(releasePreview)).toBe(true);
  await row.getByLabel("Horas").fill("3");
  await releasePreview?.();
  await expect(page.getByRole("heading", { name: "Previsualización" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Guardar y aprobar adicionales" })).toHaveCount(0);
});

test("A39/A40: cada empleado conserva su compromiso y R se reasigna al cambiar el total", async ({ page }) => {
  let saved: Record<string, unknown> | undefined;
  await page.addInitScript((sessionUser) => sessionStorage.setItem("agua-renew-admin-session-hint", JSON.stringify({ version: 1, storedAt: Date.now(), user: sessionUser })), user);
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.endsWith("/auth/me")) return route.fulfill({ json: user });
    if (url.pathname.endsWith("/employees")) return route.fulfill({ json: employees });
    if (url.pathname.endsWith("/manual-days") && request.method() === "GET") return route.fulfill({ json: [] });
    if (url.pathname.endsWith("/recovery-commitments")) {
      const employeeId = url.searchParams.get("employee_id");
      return route.fulfill({ json: employeeId === "employee-normal"
        ? [{ id: "commitment-n", employee_id: employeeId, pending_minutes: 240, reference: "Permiso Nora" }]
        : [{ id: "commitment-a", employee_id: employeeId, pending_minutes: 240, reference: "Permiso Adela" }] });
    }
    if (url.pathname.endsWith("/manual-days/preview")) {
      const body = request.postDataJSON() as { rows: Array<Record<string, unknown>> };
      return route.fulfill({ json: { preview_token: "e".repeat(64), rows: body.rows.map((row) => ({ ...row, payment: { status: "NOT_APPLICABLE", amount: "0.00" } })) } });
    }
    if (url.pathname.endsWith("/manual-days/batch")) {
      saved = request.postDataJSON() as Record<string, unknown>;
      return route.fulfill({ json: { created: ["a", "b"] } });
    }
    return route.fulfill({ json: [] });
  });
  await page.goto("/admin/attendance/history");
  await selectDateField(page, "Fecha trabajada", "2026-09-10");
  const nora = page.locator("tbody tr").first();
  const adela = page.locator("tbody tr").nth(1);
  await nora.getByRole("checkbox").check();
  await nora.getByLabel("Horas").fill("2");
  await nora.locator("select").first().selectOption("RECOVERY");
  await expect(nora.getByLabel("Compromiso").getByRole("option", { name: /Permiso Nora/ })).toHaveCount(1);
  await adela.getByRole("checkbox").check();
  await adela.getByLabel("Horas").fill("2");
  await adela.locator("select").first().selectOption("RECOVERY");
  await expect(adela.getByLabel("Compromiso").getByRole("option", { name: /Permiso Adela/ })).toHaveCount(1);
  await expect(nora.getByLabel("Compromiso").getByRole("option", { name: /Permiso Nora/ })).toHaveCount(1);
  await nora.getByLabel("Compromiso").selectOption("commitment-n");
  await adela.getByLabel("Compromiso").selectOption("commitment-a");
  await nora.getByLabel("Horas").fill("3");
  await page.getByRole("button", { name: "Previsualizar" }).click();
  await page.getByRole("button", { name: "Guardar horas" }).click();
  expect(saved?.rows).toMatchObject([
    { employee_id: "employee-normal", recovery_minutes: 180, recovery_allocations: [{ commitment_id: "commitment-n", minutes: 180 }] },
    { employee_id: "employee-additional", recovery_minutes: 120, recovery_allocations: [{ commitment_id: "commitment-a", minutes: 120 }] },
  ]);
});

test("U01: una respuesta perdida conserva DTO y clave, bloquea otra mutación y reintenta una sola vez", async ({ page }) => {
  const attempts: Array<Record<string, unknown>> = [];
  let effects = 0;
  await page.addInitScript((sessionUser) => sessionStorage.setItem("agua-renew-admin-session-hint", JSON.stringify({ version: 1, storedAt: Date.now(), user: sessionUser })), user);
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request(); const path = new URL(request.url()).pathname;
    if (path.endsWith("/auth/me")) return route.fulfill({ json: user });
    if (path.endsWith("/employees")) return route.fulfill({ json: employees });
    if (path.endsWith("/manual-days") && request.method() === "GET") return route.fulfill({ json: [] });
    if (path.endsWith("/manual-days/preview")) {
      const body = request.postDataJSON() as { rows: Array<Record<string, unknown>> };
      return route.fulfill({ json: { preview_token: "f".repeat(64), rows: body.rows.map((row) => ({ ...row, payment: { status: "NOT_APPLICABLE", amount: "0.00" } })) } });
    }
    if (path.endsWith("/manual-days/batch")) {
      const body = request.postDataJSON() as Record<string, unknown>;
      attempts.push(body);
      if (effects === 0) effects += 1;
      if (attempts.length === 1) return route.abort("connectionreset");
      return route.fulfill({ json: { created: ["created-once"] } });
    }
    if (path.includes("/manual-operations/")) return route.fulfill({ status: 404, json: { detail: { code: "OPERATION_NOT_CONFIRMED", message: "Pendiente" } } });
    return route.fulfill({ json: [] });
  });
  await page.goto("/admin/attendance/history");
  await selectDateField(page, "Fecha trabajada", "2026-09-10");
  const row = page.locator("tbody tr").first();
  await row.getByRole("checkbox").check();
  await row.getByLabel("Horas").fill("8");
  await page.getByRole("button", { name: "Previsualizar" }).click();
  await page.getByRole("button", { name: "Guardar horas" }).click();
  await expect(page.getByText("Resultado no confirmado: puede reintentar el mismo envío.")).toBeVisible();
  await page.getByRole("button", { name: "Guardar horas" }).click();
  await expect(page.getByText(/Hay una operación pendiente/)).toBeVisible();
  expect(attempts).toHaveLength(1);
  await page.getByRole("button", { name: "Reintentar operación pendiente" }).click();
  await expect(page.getByText("Operación recuperada sin duplicar la carga.")).toBeVisible();
  expect(attempts).toHaveLength(2);
  expect(attempts[1]).toEqual(attempts[0]);
  expect(effects).toBe(1);
});

test("E01 reproducción: un rechazo MANUAL_DAY_EXISTS libera sólo ese envío y deja corregir la fecha", async ({ page }) => {
  const attempts: Array<Record<string, unknown>> = [];
  await page.addInitScript((sessionUser) => sessionStorage.setItem("agua-renew-admin-session-hint", JSON.stringify({ version: 1, storedAt: Date.now(), user: sessionUser })), user);
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request(); const path = new URL(request.url()).pathname;
    const body = request.postDataJSON() as { rows?: Array<Record<string, unknown>> } | null;
    if (path.endsWith("/auth/me")) return route.fulfill({ json: user });
    if (path.endsWith("/employees")) return route.fulfill({ json: employees });
    if (path.endsWith("/manual-days") && request.method() === "GET") return route.fulfill({ json: [] });
    if (path.endsWith("/manual-days/preview")) return route.fulfill({ json: { preview_token: "e".repeat(64), rows: (body?.rows ?? []).map((row) => ({ ...row, payment: { status: "NOT_APPLICABLE", amount: "0.00" } })) } });
    if (path.endsWith("/manual-days/batch")) {
      attempts.push(request.postDataJSON() as Record<string, unknown>);
      if (attempts.length === 1) return route.fulfill({ status: 409, json: { detail: { code: "MANUAL_DAY_EXISTS", message: "Ya existe una carga manual vigente" } } });
      return route.fulfill({ json: { created: ["valid-next-date"] } });
    }
    if (path.includes("/manual-operations/")) return route.fulfill({ status: 404, json: { detail: { code: "OPERATION_NOT_CONFIRMED", message: "Sin recibo" } } });
    return route.fulfill({ json: [] });
  });
  await page.goto("/admin/attendance/history");
  const row = page.locator("tbody tr").first();
  await selectDateField(page, "Fecha trabajada", "2026-09-10");
  await row.getByRole("checkbox").check();
  await row.getByLabel("Horas").fill("2");
  await page.getByRole("button", { name: "Previsualizar" }).click();
  await page.getByRole("button", { name: "Guardar horas" }).click();
  await expect(page.getByText("Ya existe una carga manual vigente")).toBeVisible();
  await selectDateField(page, "Fecha trabajada", "2026-09-11");
  await page.getByRole("button", { name: "Previsualizar" }).click();
  await page.getByRole("button", { name: "Guardar horas" }).click();
  await expect(page.getByText("1 carga(s) registrada(s).", { exact: true })).toBeVisible();
  expect(attempts).toHaveLength(2);
});

test("E03/E07: un 422 contractual libera sólo su clave y un error tardío no borra otra", async ({ page }) => {
  let release: (() => Promise<void>) | undefined;
  const replacement = { key: "replacement-pending-key", userId: user.id, kind: "BATCH", payload: { work_date: "2026-09-11", rows: [], approve_additional: false, idempotency_key: "replacement-pending-key" } };
  await page.addInitScript((sessionUser) => sessionStorage.setItem("agua-renew-admin-session-hint", JSON.stringify({ version: 1, storedAt: Date.now(), user: sessionUser })), user);
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request(); const path = new URL(request.url()).pathname;
    const body = request.postDataJSON() as { rows?: Array<Record<string, unknown>> } | null;
    if (path.endsWith("/auth/me")) return route.fulfill({ json: user });
    if (path.endsWith("/employees")) return route.fulfill({ json: employees });
    if (path.endsWith("/manual-days") && request.method() === "GET") return route.fulfill({ json: [] });
    if (path.endsWith("/manual-days/preview")) return route.fulfill({ json: { preview_token: "g".repeat(64), rows: (body?.rows ?? []).map((row) => ({ ...row, payment: { status: "NOT_APPLICABLE", amount: "0.00" } })) } });
    if (path.endsWith("/manual-days/batch")) {
      await new Promise<void>((resolve) => { release = async () => { await route.fulfill({ status: 422, json: { detail: { code: "NORMAL_EXCEEDS_EXPECTED", message: "La parte normal supera la jornada pactada" } } }); resolve(); }; });
      return;
    }
    return route.fulfill({ json: [] });
  });
  await page.goto("/admin/attendance/history");
  await selectDateField(page, "Fecha trabajada", "2026-09-10");
  const row = page.locator("tbody tr").first();
  await row.getByRole("checkbox").check(); await row.getByLabel("Horas").fill("2");
  await page.getByRole("button", { name: "Previsualizar" }).click();
  await page.getByRole("button", { name: "Guardar horas" }).click();
  await expect.poll(() => Boolean(release)).toBe(true);
  await page.evaluate((operation) => sessionStorage.setItem(`hst01.pending-operation.v2.${operation.userId}`, JSON.stringify(operation)), replacement);
  await release?.();
  await expect(page.getByText("La parte normal supera la jornada pactada")).toBeVisible();
  await expect.poll(() => page.evaluate((userId) => sessionStorage.getItem(`hst01.pending-operation.v2.${userId}`), user.id)).toBe(JSON.stringify(replacement));
});

test("U06/U07: al recargar consulta el recibo del usuario y recupera sin reenviar", async ({ page }) => {
  const key = "pending-operation-key-123";
  let mutations = 0;
  await page.addInitScript(({ sessionUser, operationKey }) => {
    sessionStorage.setItem("agua-renew-admin-session-hint", JSON.stringify({ version: 1, storedAt: Date.now(), user: sessionUser }));
    sessionStorage.setItem(`hst01.pending-operation.v2.${sessionUser.id}`, JSON.stringify({
      key: operationKey, userId: sessionUser.id, kind: "BATCH",
      payload: { work_date: "2026-09-10", rows: [], approve_additional: false, idempotency_key: operationKey },
    }));
  }, { sessionUser: user, operationKey: key });
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request(); const path = new URL(request.url()).pathname;
    if (path.endsWith("/auth/me")) return route.fulfill({ json: user });
    if (path.endsWith("/employees")) return route.fulfill({ json: employees });
    if (path.endsWith(`/manual-operations/${key}`)) return route.fulfill({ json: { state: "CONFIRMED", idempotency_key: key, operation_type: "BATCH", target_manual_day_id: null, http_status: 200, result: { created: ["one"] } } });
    if (path.endsWith("/manual-days") && request.method() === "GET") return route.fulfill({ json: [] });
    if (request.method() !== "GET") mutations += 1;
    return route.fulfill({ json: [] });
  });
  await page.goto("/admin/attendance/history");
  await expect(page.getByText("Se recuperó la carga de horas. El historial está actualizado.")).toBeVisible();
  expect(mutations).toBe(0);
  expect(await page.evaluate((userId) => sessionStorage.getItem(`hst01.pending-operation.v2.${userId}`), user.id)).toBeNull();
});

test("B08/U08: aprobación individual muestra y envía la valoración vigente confirmada", async ({ page }) => {
  const pending = {
    id: "pending-payment", employee_id: "employee-additional", work_date: "2026-09-10",
    worked_minutes_net: 120, normal_minutes: 0, additional_minutes: 120, recovery_minutes: 0,
    known_check_in_at: null, known_check_out_at: null, known_break_minutes: null,
    reason: "Adicional", day_context: "ORDINARY", source_reference: null, payment_method: "OVERTIME",
    payment_concept: null, reviewed_additional_amount: null, recovery_allocations: [],
    payment_status: "PENDING", payment_snapshot: { status: "PENDING", amount: "31.50" }, version: 1, created_at: "2026-09-11T00:00:00Z",
  };
  let approved: Record<string, unknown> | undefined;
  await page.addInitScript((sessionUser) => sessionStorage.setItem("agua-renew-admin-session-hint", JSON.stringify({ version: 1, storedAt: Date.now(), user: sessionUser })), user);
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request(); const path = new URL(request.url()).pathname;
    if (path.endsWith("/auth/me")) return route.fulfill({ json: user });
    if (path.endsWith("/employees")) return route.fulfill({ json: employees });
    if (path.endsWith("/manual-days") && request.method() === "GET") return route.fulfill({ json: [pending] });
    if (path.endsWith("/manual-days/preview")) return route.fulfill({ json: { preview_token: "1".repeat(64), rows: [{ ...pending, payment: { status: "PENDING", amount: "55.00", valuation_inputs: { salary_id: "salary-current" } } }] } });
    if (path.endsWith("/manual-days/pending-payment/payment/approve")) { approved = request.postDataJSON() as Record<string, unknown>; return route.fulfill({ json: { ...pending, payment_status: "APPROVED", version: 2 } }); }
    return route.fulfill({ json: [] });
  });
  page.once("dialog", async (dialog) => { expect(dialog.message()).toContain("S/ 55.00"); await dialog.accept(); });
  await page.goto("/admin/attendance/history");
  await page.getByRole("button", { name: "Aprobar" }).click();
  await expect(page.getByText("Adicional aprobado.")).toBeVisible();
  expect(approved?.expected_snapshot).toEqual({ status: "PENDING", amount: "55.00", valuation_inputs: { salary_id: "salary-current" } });
});

test("T422-01: un 422 Pydantic reconocido libera su clave, conserva el borrador y permite guardar corregido", async ({ page }) => {
  const attempts: Array<Record<string, unknown>> = [];
  await page.addInitScript((sessionUser) => sessionStorage.setItem("agua-renew-admin-session-hint", JSON.stringify({ version: 1, storedAt: Date.now(), user: sessionUser })), user);
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request(); const path = new URL(request.url()).pathname;
    const body = request.postDataJSON() as { rows?: Array<Record<string, unknown>> } | null;
    if (path.endsWith("/auth/me")) return route.fulfill({ json: user });
    if (path.endsWith("/employees")) return route.fulfill({ json: employees });
    if (path.endsWith("/manual-days") && request.method() === "GET") return route.fulfill({ json: [] });
    if (path.endsWith("/manual-days/preview")) return route.fulfill({ json: { preview_token: "v".repeat(64), rows: (body?.rows ?? []).map((row) => ({ ...row, payment: { status: "NOT_APPLICABLE", amount: "0.00" } })) } });
    if (path.endsWith("/manual-days/batch")) {
      attempts.push(request.postDataJSON() as Record<string, unknown>);
      if (attempts.length === 1) return route.fulfill({ status: 422, json: { detail: [{ loc: ["body", "rows", 0, "reason"], msg: "El motivo no es válido", type: "value_error" }] } });
      return route.fulfill({ json: { created: ["corrected"] } });
    }
    return route.fulfill({ json: [] });
  });
  await page.goto("/admin/attendance/history");
  await selectDateField(page, "Fecha trabajada", "2026-09-10");
  const row = page.locator("tbody tr").first();
  await row.getByRole("checkbox").check(); await row.getByLabel("Horas").fill("2");
  await page.getByRole("button", { name: "Previsualizar" }).click();
  await page.getByRole("button", { name: "Guardar horas" }).click();
  await expect(page.getByText("Solicitud inválida: El motivo no es válido")).toBeVisible();
  await expect.poll(() => page.evaluate((userId) => sessionStorage.getItem(`hst01.pending-operation.v2.${userId}`), user.id)).toBeNull();
  await expect(row.getByLabel("Horas")).toHaveValue("2");
  await page.getByRole("button", { name: "Previsualizar" }).click();
  await page.getByRole("button", { name: "Guardar horas" }).click();
  await expect(page.getByText("1 carga(s) registrada(s).", { exact: true })).toBeVisible();
  expect(attempts).toHaveLength(2);
});

test("T422-02/T422-04: HTML y JSON 422 no contractuales son inciertos y conservan el mismo contexto", async () => {
  const originalFetch = globalThis.fetch;
  const cases = [
    { body: async () => { throw new SyntaxError("HTML"); }, kind: "UNREADABLE" as const },
    { body: async () => ({ other: "unexpected" }), kind: "OTHER_JSON" as const },
  ];
  try {
    for (const current of cases) {
      globalThis.fetch = (async () => ({ ok: false, status: 422, json: current.body }) as Response) as typeof fetch;
      await expect(apiFetch("/test-422")).rejects.toMatchObject({ status: 422, responseKind: current.kind });
      try { await apiFetch("/test-422"); } catch (error) {
        expect(classifyHistoricalOperationResult(error)).toBe("UNKNOWN_OR_IN_PROGRESS");
      }
    }
  } finally { globalThis.fetch = originalFetch; }
});

test("T422-03: un fallo de json() después de headers 422 queda UNREADABLE e incierto", async () => {
  const originalFetch = globalThis.fetch;
  let reads = 0;
  try {
    globalThis.fetch = (async () => ({
      ok: false,
      status: 422,
      json: async () => { reads += 1; throw new TypeError("body interrupted after headers"); },
    }) as unknown as Response) as typeof fetch;
    await expect(apiFetch("/interrupted-422")).rejects.toMatchObject({ status: 422, responseKind: "UNREADABLE" });
    expect(reads).toBe(1);
    try { await apiFetch("/interrupted-422"); } catch (error) {
      expect(classifyHistoricalOperationResult(error)).toBe("UNKNOWN_OR_IN_PROGRESS");
    }
  } finally { globalThis.fetch = originalFetch; }
});

test("T422-05: tras 422 ilegible, recarga y 404, el mismo DTO y clave recibe validación y permite corregir", async ({ page }) => {
  const attempts: Array<Record<string, unknown>> = [];
  await page.addInitScript((sessionUser) => sessionStorage.setItem("agua-renew-admin-session-hint", JSON.stringify({ version: 1, storedAt: Date.now(), user: sessionUser })), user);
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request(); const path = new URL(request.url()).pathname;
    const body = request.postDataJSON() as { rows?: Array<Record<string, unknown>> } | null;
    if (path.endsWith("/auth/me")) return route.fulfill({ json: user });
    if (path.endsWith("/employees")) return route.fulfill({ json: employees });
    if (path.endsWith("/manual-days") && request.method() === "GET") return route.fulfill({ json: [] });
    if (path.endsWith("/manual-days/preview")) return route.fulfill({ json: { preview_token: "w".repeat(64), rows: (body?.rows ?? []).map((row) => ({ ...row, payment: { status: "NOT_APPLICABLE", amount: "0.00" } })) } });
    if (path.includes("/manual-operations/")) return route.fulfill({ status: 404, json: { detail: { code: "OPERATION_NOT_CONFIRMED", message: "Sin recibo" } } });
    if (path.endsWith("/manual-days/batch")) {
      attempts.push(request.postDataJSON() as Record<string, unknown>);
      if (attempts.length === 1) return route.fulfill({ status: 422, contentType: "text/html", body: "<h1>interrumpido</h1>" });
      if (attempts.length === 2) return route.fulfill({ status: 422, json: { detail: [{ loc: ["body", "work_date"], msg: "La fecha ya no es válida", type: "value_error" }] } });
      return route.fulfill({ json: { created: ["corrected-after-retry"] } });
    }
    return route.fulfill({ json: [] });
  });
  await page.goto("/admin/attendance/history");
  await selectDateField(page, "Fecha trabajada", "2026-09-10");
  let row = page.locator("tbody tr").first();
  await row.getByRole("checkbox").check(); await row.getByLabel("Horas").fill("2");
  await page.getByRole("button", { name: "Previsualizar" }).click();
  await page.getByRole("button", { name: "Guardar horas" }).click();
  await expect(page.getByText("Resultado no confirmado: puede reintentar el mismo envío.")).toBeVisible();
  const pendingBeforeReload = await page.evaluate((userId) => sessionStorage.getItem(`hst01.pending-operation.v2.${userId}`), user.id);
  expect(pendingBeforeReload).not.toBeNull();
  await page.reload();
  await expect(page.getByText(/Hay una operación pendiente/)).toBeVisible();
  await page.getByRole("button", { name: "Reintentar operación pendiente" }).click();
  await expect(page.getByText("Solicitud inválida: La fecha ya no es válida")).toBeVisible();
  expect(attempts[1]).toEqual(attempts[0]);
  await expect.poll(() => page.evaluate((userId) => sessionStorage.getItem(`hst01.pending-operation.v2.${userId}`), user.id)).toBeNull();
  await selectDateField(page, "Fecha trabajada", "2026-09-11");
  row = page.locator("tbody tr").first();
  await row.getByRole("checkbox").check(); await row.getByLabel("Horas").fill("2");
  await page.getByRole("button", { name: "Previsualizar" }).click();
  await page.getByRole("button", { name: "Guardar horas" }).click();
  await expect(page.getByText("1 carga(s) registrada(s).", { exact: true })).toBeVisible();
  expect(attempts).toHaveLength(3);
});

test("T422-06: 409 empresarial conocido sigue siendo definitivo y 422 sin procedencia no", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => ({
      ok: false,
      status: 409,
      json: async () => ({ detail: { code: "MANUAL_DAY_EXISTS", message: "Existe" } }),
    }) as unknown as Response) as typeof fetch;
    await expect(apiFetch("/known-domain-error")).rejects.toMatchObject({
      code: "MANUAL_DAY_EXISTS",
      responseKind: "DOMAIN_ERROR",
    });
  } finally { globalThis.fetch = originalFetch; }
  expect(classifyHistoricalOperationResult(new ApiError(409, "Existe", "MANUAL_DAY_EXISTS", "DOMAIN_ERROR"))).toBe("REJECTED_BEFORE_WRITE");
  expect(classifyHistoricalOperationResult(new ApiError(422, "Sin procedencia"))).toBe("UNKNOWN_OR_IN_PROGRESS");
  expect(classifyHistoricalOperationResult(new ApiError(503, "Incierto", "OPERATION_RESULT_UNKNOWN", "DOMAIN_ERROR"))).toBe("UNKNOWN_OR_IN_PROGRESS");
});
