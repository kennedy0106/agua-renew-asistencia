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
