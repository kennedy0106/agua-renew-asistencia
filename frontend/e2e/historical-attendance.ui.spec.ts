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
  const historyPanel = page.getByRole("heading", { name: "Historial de cargas" }).locator("..");
  await expect(historyPanel.getByText("480 min", { exact: true })).toHaveCount(2);
  await expect(historyPanel.getByText("120 min", { exact: true })).toHaveCount(2);
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
  await page.getByLabel("Tratamiento de edición").selectOption("MIXED");
  await page.getByLabel("Normal editado").fill("360");
  await page.getByLabel("Adicional editado").fill("120");
  await page.getByLabel("Método de pago adicional editado").selectOption("OVERTIME");
  await page.getByRole("button", { name: "Previsualizar cambios" }).click();
  await expect(page.getByText("Previsualización: W 480 min · N 360 min · P 120 min · R 0 min")).toBeVisible();
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
  await expect(page.getByText("Sobretiempo ordinario · S/ 31.50 · Aprobado")).toBeVisible();
  await page.getByLabel("Fecha trabajada").fill("2026-09-10");
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
  await page.getByLabel("Fecha trabajada").fill("2026-09-10");
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
