import { expect, test } from "@playwright/test";

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
    if (path.endsWith("/manual-days/preview")) return route.fulfill({ json: { rows: (body?.rows ?? []).map((row) => ({
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
  await page.getByLabel("Fecha trabajada").fill("2026-09-10");

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
  await expect(page.getByText("2026-09-10: 480 min")).toHaveCount(2);
  await expect(page.getByText("2026-09-10: 120 min")).toHaveCount(2);
});

test("HST-01 envía una valoración REVIEWED y no previsualiza S/0 ni campos incompletos", async ({ page }) => {
  let previewRequests = 0;
  let previewPayload: Record<string, unknown> | undefined;
  await page.addInitScript((sessionUser) => sessionStorage.setItem("agua-renew-admin-session-hint", JSON.stringify({ version: 1, storedAt: Date.now(), user: sessionUser })), user);
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request(); const path = new URL(request.url()).pathname;
    const body = request.postDataJSON() as { rows?: Array<Record<string, unknown>> } | null;
    if (path.endsWith("/auth/me")) return route.fulfill({ json: user });
    if (path.endsWith("/employees")) return route.fulfill({ json: employees });
    if (path.endsWith("/manual-days") && request.method() === "GET") return route.fulfill({ json: [] });
    if (path.endsWith("/manual-days/preview")) { previewRequests += 1; previewPayload = body?.rows?.[0]; return route.fulfill({ json: { rows: [{ ...previewPayload, payment: { status: "PENDING", amount: "125.50", method: "REVIEWED", concept: "Feriado trabajado", reference: "Acta RRHH 001" } }] } }); }
    return route.fulfill({ json: [] });
  });
  await page.goto("/admin/attendance/history");
  await page.getByLabel("Fecha trabajada").fill("2026-09-10");
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
  await expect(page.getByText("Importe revisado · S/ 125.50 · Pendiente de aprobación")).toBeVisible();
  await expect(page.getByText("Feriado trabajado · Acta RRHH 001")).toBeVisible();
  await expect(page.getByRole("button", { name: "Guardar y aprobar adicionales" })).toBeEnabled();
  expect(previewPayload).toMatchObject({ payment_method: "REVIEWED", payment_concept: "Feriado trabajado", source_reference: "Acta RRHH 001", reviewed_additional_amount: "125.50" });
});
