import { expect, test, type APIRequestContext } from "@playwright/test";

const API = process.env.E2E_API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8000";

if (process.env.E2E_INTEGRATION !== "1") {
  throw new Error("E2E_INTEGRATION=1 es obligatorio para la aceptación HST-01 real.");
}

function digits() { return String(10_000_000 + Math.floor(Math.random() * 89_999_999)); }

async function login(api: APIRequestContext) {
  const response = await api.post(`${API}/api/v1/auth/login`, { data: { username: "admin", password: "Admin123!" } });
  expect(response.ok(), await response.text()).toBeTruthy();
}

async function role(api: APIRequestContext) {
  const listed = await api.get(`${API}/api/v1/job-roles`);
  expect(listed.ok(), await listed.text()).toBeTruthy();
  const roles = await listed.json() as Array<{ id: string; name: string }>;
  if (roles[0]) return roles[0].id;
  const created = await api.post(`${API}/api/v1/job-roles`, { data: { name: "Operario HST", description: "E2E" } });
  expect(created.status(), await created.text()).toBe(201);
  return (await created.json() as { id: string }).id;
}

async function employee(api: APIRequestContext, index: number) {
  const dni = digits();
  const response = await api.post(`${API}/api/v1/employees`, { data: { dni, employee_code: `HST-E2E-${dni}`, first_name: `Hist${index}`, last_name: "Prueba", job_role_id: await role(api), hire_date: "2026-01-01" } });
  expect(response.status(), await response.text()).toBe(201);
  return (await response.json() as { id: string }).id;
}

test("HST-01 real: compromiso y lote N/P/R/mixto no crean marcaciones", async ({ request }) => {
  await login(request);
  const [normal, additional, recovery, mixed] = await Promise.all([0, 1, 2, 3].map((index) => employee(request, index)));
  const commitment = await request.post(`${API}/api/v1/attendance/recovery-commitments`, { data: { employee_id: recovery, permission_date: "2026-09-01", agreed_minutes: 240, covered_before: false, reference: "Permiso histórico E2E" } });
  expect(commitment.status(), await commitment.text()).toBe(200);
  const commitmentId = (await commitment.json() as { id: string }).id;
  const secondCommitment = await request.post(`${API}/api/v1/attendance/recovery-commitments`, { data: { employee_id: mixed, permission_date: "2026-09-01", agreed_minutes: 120, covered_before: true, reference: "Permiso mixto E2E" } });
  expect(secondCommitment.status(), await secondCommitment.text()).toBe(200);
  const secondCommitmentId = (await secondCommitment.json() as { id: string }).id;
  const rows = [
    { employee_id: normal, worked_minutes_net: 480, normal_minutes: 480, additional_minutes: 0, recovery_minutes: 0, reason: "Normal histórica E2E", recovery_allocations: [] },
    { employee_id: additional, worked_minutes_net: 120, normal_minutes: 0, additional_minutes: 120, recovery_minutes: 0, reason: "Adicional histórica E2E", payment_method: "OVERTIME", recovery_allocations: [] },
    { employee_id: recovery, worked_minutes_net: 120, normal_minutes: 0, additional_minutes: 0, recovery_minutes: 120, reason: "Recuperación histórica E2E", recovery_allocations: [{ commitment_id: commitmentId, minutes: 120 }] },
    { employee_id: mixed, worked_minutes_net: 480, normal_minutes: 240, additional_minutes: 120, recovery_minutes: 120, reason: "Mixta histórica E2E", payment_method: "OVERTIME", recovery_allocations: [{ commitment_id: secondCommitmentId, minutes: 120 }] },
  ];
  const preview = await request.post(`${API}/api/v1/attendance/manual-days/preview`, { data: { work_date: "2026-09-02", rows, idempotency_key: `hst-preview-${crypto.randomUUID()}` } });
  expect(preview.status(), await preview.text()).toBe(200);
  expect((await preview.json() as { rows: unknown[] }).rows).toHaveLength(4);
  const saved = await request.post(`${API}/api/v1/attendance/manual-days/batch`, { data: { work_date: "2026-09-02", rows, idempotency_key: `hst-batch-${crypto.randomUUID()}` } });
  expect(saved.status(), await saved.text()).toBe(200);
  expect((await saved.json() as { created: string[] }).created).toHaveLength(4);
  const listed = await request.get(`${API}/api/v1/attendance/manual-days?date_from=2026-09-02&date_to=2026-09-02`);
  expect(listed.status(), await listed.text()).toBe(200);
  const savedRows = await listed.json() as Array<{ employee_id: string; normal_minutes: number; additional_minutes: number; recovery_minutes: number }>;
  expect(savedRows.filter((row) => [normal, additional, recovery, mixed].includes(row.employee_id))).toEqual(expect.arrayContaining([
    expect.objectContaining({ employee_id: normal, normal_minutes: 480, additional_minutes: 0, recovery_minutes: 0 }),
    expect.objectContaining({ employee_id: additional, normal_minutes: 0, additional_minutes: 120, recovery_minutes: 0 }),
    expect.objectContaining({ employee_id: recovery, normal_minutes: 0, additional_minutes: 0, recovery_minutes: 120 }),
    expect.objectContaining({ employee_id: mixed, normal_minutes: 240, additional_minutes: 120, recovery_minutes: 120 }),
  ]));
  for (const employeeId of [normal, additional, recovery, mixed]) {
    const attendance = await request.get(`${API}/api/v1/attendance?employee_id=${employeeId}`);
    expect(attendance.status(), await attendance.text()).toBe(200);
    expect(await attendance.json()).toEqual([]);
  }
});

test("HST-01 real: REVIEWED conserva importe aprobado y rechaza S/0, concepto o referencia ausentes", async ({ request }) => {
  await login(request);
  const reviewed = await employee(request, 4);
  const valid = {
    employee_id: reviewed,
    worked_minutes_net: 90,
    normal_minutes: 0,
    additional_minutes: 90,
    recovery_minutes: 0,
    reason: "Feriado histórico revisado",
    payment_method: "REVIEWED",
    payment_concept: "Feriado trabajado",
    source_reference: "Acta RRHH E2E 001",
    reviewed_additional_amount: "125.50",
    recovery_allocations: [],
  };
  const preview = await request.post(`${API}/api/v1/attendance/manual-days/preview`, { data: { work_date: "2026-09-03", rows: [valid], idempotency_key: `hst-reviewed-preview-${crypto.randomUUID()}` } });
  expect(preview.status(), await preview.text()).toBe(200);
  const previewBody = await preview.json() as { preview_token: string; rows: Array<{ payment: { method: string; amount: string; concept: string; reference: string } }> };
  expect(previewBody.rows[0].payment).toMatchObject({ method: "REVIEWED", amount: "125.50", concept: "Feriado trabajado", reference: "Acta RRHH E2E 001" });
  const saved = await request.post(`${API}/api/v1/attendance/manual-days/batch`, { data: { work_date: "2026-09-03", rows: [valid], approve_additional: true, preview_token: previewBody.preview_token, idempotency_key: `hst-reviewed-batch-${crypto.randomUUID()}` } });
  expect(saved.status(), await saved.text()).toBe(200);
  const item = await request.get(`${API}/api/v1/attendance/manual-days/${(await saved.json() as { created: string[] }).created[0]}`);
  expect(item.status(), await item.text()).toBe(200);
  expect(await item.json()).toMatchObject({ payment_status: "APPROVED", payment_method: "REVIEWED", payment_concept: "Feriado trabajado", approved_additional_amount: "125.50" });
  for (const [field, value] of [["reviewed_additional_amount", "0"], ["payment_concept", ""], ["source_reference", ""]] as const) {
    const invalid = { ...valid, [field]: value };
    const rejected = await request.post(`${API}/api/v1/attendance/manual-days/preview`, { data: { work_date: "2026-09-04", rows: [invalid], idempotency_key: `hst-reviewed-invalid-${field}-${crypto.randomUUID()}` } });
    expect(rejected.status(), await rejected.text()).toBe(422);
  }
});

test("U09 real: Normal, Adicional, Recuperación y Mixto desde pantalla llegan a saldo, diario y CSV", async ({ page }) => {
  const api = page.request;
  await login(api);
  const ids = await Promise.all([10, 11, 12, 13].map((index) => employee(api, index)));
  const [normal, additional, recovery, mixed] = ids;
  for (const id of ids) {
    expect((await api.post(`${API}/api/v1/employees/${id}/salary-settings`, { data: { effective_from: "2026-08-01", monthly_salary: "1500.00", overtime_enabled: true } })).status()).toBe(201);
    expect((await api.post(`${API}/api/v1/employees/${id}/schedule`, { data: { effective_from: "2026-08-01", monday_minutes: 480, tuesday_minutes: 480, wednesday_minutes: 480, thursday_minutes: 480, friday_minutes: 480 } })).status()).toBe(201);
  }
  const recoveryCommitment = await api.post(`${API}/api/v1/attendance/recovery-commitments`, { data: { employee_id: recovery, permission_date: "2026-09-01", agreed_minutes: 120, covered_before: false, reference: "Permiso U09" } });
  const mixedCommitment = await api.post(`${API}/api/v1/attendance/recovery-commitments`, { data: { employee_id: mixed, permission_date: "2026-09-01", agreed_minutes: 120, covered_before: true, reference: "Permiso mixto U09" } });
  expect(recoveryCommitment.status()).toBe(200); expect(mixedCommitment.status()).toBe(200);
  const recoveryCommitmentId = (await recoveryCommitment.json() as { id: string }).id;
  const mixedCommitmentId = (await mixedCommitment.json() as { id: string }).id;
  const periodResponse = await api.post(`${API}/api/v1/payroll/periods`, { data: { name: `U09-${crypto.randomUUID()}`, start_date: "2026-09-01", end_date: "2026-09-30" } });
  expect(periodResponse.status()).toBe(201);
  const periodId = (await periodResponse.json() as { id: string }).id;

  await page.goto("/admin/attendance/history");
  await page.getByLabel("Fecha trabajada").fill("2026-09-03");
  const nameById = new Map([[normal, "Hist10"], [additional, "Hist11"], [recovery, "Hist12"], [mixed, "Hist13"]]);
  const rowFor = (id: string) => page.locator("tbody tr").filter({ hasText: nameById.get(id)! });
  const configure = async (id: string, treatment: "NORMAL" | "ADDITIONAL" | "RECOVERY" | "MIXED") => {
    const row = rowFor(id);
    await row.getByRole("checkbox").check();
    await row.getByLabel("Horas").fill(treatment === "ADDITIONAL" || treatment === "RECOVERY" ? "2" : "8");
    await row.getByLabel("Minutos").fill("0");
    await row.locator("select").first().selectOption(treatment);
    if (treatment === "RECOVERY") await row.getByLabel("Compromiso").selectOption(recoveryCommitmentId);
    if (treatment === "MIXED") {
      await row.getByLabel("Normal").fill("240");
      await row.getByLabel("Adicional").fill("120");
      await row.getByLabel("Recuperación").fill("120");
      await row.getByLabel("Compromiso").selectOption(mixedCommitmentId);
    }
    if (treatment === "ADDITIONAL" || treatment === "MIXED") {
      await row.getByLabel("Método de pago adicional").selectOption("REVIEWED");
      await row.getByLabel("Importe revisado", { exact: true }).fill(treatment === "ADDITIONAL" ? "50.00" : "25.00");
      await row.getByLabel("Concepto de importe revisado").fill(`Concepto ${treatment}`);
      await row.getByLabel("Referencia de importe revisado").fill(`Acta ${treatment}`);
    }
  };
  await configure(normal, "NORMAL");
  await configure(additional, "ADDITIONAL");
  await configure(recovery, "RECOVERY");
  await configure(mixed, "MIXED");
  await page.getByRole("button", { name: "Previsualizar" }).click();
  await expect(page.getByRole("heading", { name: "Previsualización" })).toBeVisible();
  await page.getByRole("button", { name: "Guardar y aprobar adicionales" }).click();
  await expect(page.getByText("4 carga(s) registrada(s).", { exact: true })).toBeVisible();

  const listed = await api.get(`${API}/api/v1/attendance/manual-days?date_from=2026-09-03&date_to=2026-09-03`);
  const records = (await listed.json() as Array<{ employee_id: string; normal_minutes: number; additional_minutes: number; recovery_minutes: number; payment_status: string }>).filter((item) => ids.includes(item.employee_id));
  expect(records).toEqual(expect.arrayContaining([
    expect.objectContaining({ employee_id: normal, normal_minutes: 480, additional_minutes: 0, recovery_minutes: 0 }),
    expect.objectContaining({ employee_id: additional, normal_minutes: 0, additional_minutes: 120, recovery_minutes: 0, payment_status: "APPROVED" }),
    expect.objectContaining({ employee_id: recovery, normal_minutes: 0, additional_minutes: 0, recovery_minutes: 120 }),
    expect.objectContaining({ employee_id: mixed, normal_minutes: 240, additional_minutes: 120, recovery_minutes: 120, payment_status: "APPROVED" }),
  ]));
  const balance = await api.get(`${API}/api/v1/employees/${recovery}/balance?date_from=2026-09-01&date_to=2026-09-03`);
  expect(await balance.json()).toMatchObject({ worked_minutes: 0, recovery_credit_minutes: 120 });
  expect((await api.post(`${API}/api/v1/payroll/periods/${periodId}/calculate`)).status()).toBe(200);
  const daily = await api.get(`${API}/api/v1/payroll/periods/${periodId}/daily-report`);
  expect(daily.status()).toBe(200);
  expect(JSON.stringify(await daily.json())).toContain(recovery);
  const csv = await api.get(`${API}/api/v1/exports/attendance.csv?date_from=2026-09-03&date_to=2026-09-03`);
  expect(csv.status()).toBe(200);
  const csvText = await csv.text();
  expect((csvText.match(/CARGA_HISTORICA/g) ?? [])).toHaveLength(8);
  expect(csvText).toContain(",240,120,120,");
});

test("U02/U03 real: PATCH con R y VOID pierden respuesta después del commit y se recuperan", async ({ page }) => {
  const api = page.request;
  await login(api);
  const employeeId = await employee(api, 20);
  const commitmentResponse = await api.post(`${API}/api/v1/attendance/recovery-commitments`, { data: { employee_id: employeeId, permission_date: "2026-08-20", agreed_minutes: 120, covered_before: false, reference: "Permiso U02" } });
  expect(commitmentResponse.status()).toBe(200);
  const commitmentId = (await commitmentResponse.json() as { id: string }).id;
  const sourcePayload = { work_date: "2026-09-03", rows: [{ employee_id: employeeId, worked_minutes_net: 120, normal_minutes: 120, additional_minutes: 0, recovery_minutes: 0, reason: "Origen U02", recovery_allocations: [] }], idempotency_key: `u02-source-${crypto.randomUUID()}` };
  const sourceResponse = await api.post(`${API}/api/v1/attendance/manual-days/batch`, { data: sourcePayload });
  expect(sourceResponse.status()).toBe(200);
  const sourceId = (await sourceResponse.json() as { created: string[] }).created[0];
  let lostPatch = true;
  await page.route(`**/api/v1/attendance/manual-days/${sourceId}`, async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    if (lostPatch) { lostPatch = false; return route.abort("connectionreset"); }
    return route.fulfill({ response });
  });
  await page.goto("/admin/attendance/history");
  const sourceRow = page.locator("section").filter({ has: page.getByRole("heading", { name: "Historial de cargas" }) }).locator("tbody tr").filter({ hasText: "Hist20" });
  await sourceRow.getByRole("button", { name: "Editar" }).click();
  await page.getByLabel("Tratamiento de edición").selectOption("RECOVERY");
  await page.getByLabel("Horas editadas").fill("2");
  await page.getByLabel("Minutos editados").fill("0");
  await page.getByLabel("Compromiso editado").selectOption(commitmentId);
  await page.getByRole("button", { name: "Previsualizar cambios" }).click();
  await page.getByRole("button", { name: "Guardar corrección" }).click();
  await expect(page.getByText("No se pudo guardar la corrección.")).toBeVisible();
  await page.reload();
  await expect(page.getByText("Operación recuperada: UPDATE. Historial actualizado.")).toBeVisible();
  const active = (await (await api.get(`${API}/api/v1/attendance/manual-days?employee_id=${employeeId}`)).json() as Array<{ id: string; version: number; recovery_minutes: number }>);
  expect(active).toHaveLength(1); expect(active[0]).toMatchObject({ version: 2, recovery_minutes: 120 });
  const replacementId = active[0].id;
  let lostVoid = true;
  await page.route(`**/api/v1/attendance/manual-days/${replacementId}/void`, async (route) => {
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    if (lostVoid) { lostVoid = false; return route.abort("connectionreset"); }
    return route.fulfill({ response });
  });
  const replacementRow = page.locator("section").filter({ has: page.getByRole("heading", { name: "Historial de cargas" }) }).locator("tbody tr").filter({ hasText: "Hist20" });
  await replacementRow.getByRole("button", { name: "Anular" }).click();
  await expect(page.getByText("Resultado no confirmado: reintente la misma anulación.")).toBeVisible();
  await page.getByRole("button", { name: "Reintentar operación pendiente" }).click();
  await expect(page.getByText("Operación recuperada sin duplicar la carga.")).toBeVisible();
  expect(await (await api.get(`${API}/api/v1/attendance/manual-days?employee_id=${employeeId}`)).json()).toEqual([]);
  const versions = await (await api.get(`${API}/api/v1/attendance/manual-days?employee_id=${employeeId}&include_voided=true`)).json() as Array<{ version: number }>;
  // VOID increments the replacement in place; no third lineage row appears.
  expect(versions.map((item) => item.version).sort()).toEqual([1, 3]);
  const balance = await api.get(`${API}/api/v1/employees/${employeeId}/balance?date_from=2026-08-20&date_to=2026-09-03`);
  expect((await balance.json() as { recovery_credit_minutes: number }).recovery_credit_minutes).toBe(0);
});
