import { expect, test } from "@playwright/test";

const user = {
  id: "admin-1", username: "admin", role: "ADMIN", active: true,
  must_change_password: false, last_login_at: null, created_at: "2026-01-01T00:00:00Z",
};

const period = {
  id: "period-1", name: "Primera quincena 09/2026", start_date: "2026-09-01", end_date: "2026-09-15",
  payroll_month_id: "month-1", period_kind: "FIRST_HALF", status: "CALCULATED",
  root_period_id: "period-1", version: 1, supersedes_period_id: null, rectification_reason: null,
  created_at: "2026-09-15T00:00:00Z", updated_at: "2026-09-15T00:00:00Z",
};

const record = {
  id: "record-1", payroll_period_id: period.id, employee_id: "employee-1", employee_name: "LEGAL TREINTA",
  monthly_salary: "650.00", worked_minutes: 3900, expected_minutes: 3900, overtime_minutes: 0,
  overtime_amount: "0.00", adjustment_minutes: 0, adjustment_amount: "0.00", base_salary: "325.00",
  manual_adjustment: "0.00", missing_salary_days: 0, total: "325.00", status: "PREVIEW", payable: true,
  notes: null, created_at: "2026-09-15T00:00:00Z", updated_at: "2026-09-15T00:00:00Z",
};

// Setiembre 2026 (1–15): 13 jornadas Lun–Sáb + 2 domingos de descanso. Cada
// fecha aporta su treintavo (650/30 = 21.67). La base del tramo concilia 325.00
// con una regularización visible de -0.05; ninguna fecha vale 25.00.
const daily = Array.from({ length: 15 }, (_, index) => {
  const day = index + 1;
  const workDate = `2026-09-${String(day).padStart(2, "0")}`;
  const isSunday = new Date(`${workDate}T00:00:00Z`).getUTCDay() === 0;
  return {
    employee_id: "employee-1", employee_name: "LEGAL TREINTA", work_date: workDate,
    worked_minutes: isSunday ? 0 : 300, expected_minutes: isSunday ? 0 : 300,
    recognized_minutes: isSunday ? 0 : 300, status: isSunday ? "NO_SCHEDULE" : "RECOGNIZED",
    base_amount: "21.67", legal_daily_value: "21.6667", legal_base_amount: isSunday ? "0.00" : "21.67",
    regularization_amount: day === 15 ? "-0.05" : "0.00",
    recognized_base_amount: isSunday ? "0.00" : "21.67",
    overtime_minutes: 0, overtime_amount: "0.00", recognized_overtime_amount: "0.00",
    special_day_amount: "0.00", recognized_special_day_amount: "0.00",
    approved_adjustment_minutes: 0, approved_adjustment_amount: "0.00",
    recognized_total_amount: isSunday ? "0.00" : "21.67", review_difference_amount: "0.00",
  };
});

const dailyReport = {
  period_id: period.id, start_date: period.start_date, end_date: period.end_date,
  daily,
  employees: [{
    employee_id: "employee-1", employee_name: "LEGAL TREINTA", worked_minutes: 3900, ordinary_minutes: 3900,
    expected_minutes: 3900, programmed_base_amount: "325.00", calendar_base_amount: "325.05",
    regularization_amount: "-0.05", legal_daily_value: "21.6667", recognized_base_amount: "281.71",
    unattributed_base_amount: "43.29", overtime_minutes: 0, recognized_overtime_amount: "0.00",
    special_day_amount: "0.00", recognized_special_day_amount: "0.00", approved_adjustment_minutes: 0,
    approved_adjustment_amount: "0.00", recognized_total_amount: "281.71", future_pending_base_amount: "0.00",
    review_difference_amount: "0.00", manual_adjustment: "0.00", official_total_snapshot: "325.00",
  }],
};

test("salarios muestra base por calendario y regularización, nunca cuota de distribución", async ({ page }) => {
  await page.addInitScript((sessionUser) => sessionStorage.setItem(
    "agua-renew-admin-session-hint",
    JSON.stringify({ version: 1, storedAt: Date.now(), user: sessionUser }),
  ), user);

  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path.endsWith("/auth/me")) return route.fulfill({ json: user });
    if (path === "/api/v1/payroll/periods") return route.fulfill({ json: [period] });
    if (path === `/api/v1/payroll/periods/${period.id}/summary`) return route.fulfill({ json: {
      period_id: period.id, name: period.name, start_date: period.start_date, end_date: period.end_date,
      status: period.status, employee_count: 1, total_base: "325.00", total_overtime: "0.00",
      total_special_day: "0.00", total_manual: "0.00", total: "325.00",
    } });
    if (path === `/api/v1/payroll/periods/${period.id}/records`) return route.fulfill({ json: [record] });
    if (path === `/api/v1/payroll/periods/${period.id}/daily-report`) return route.fulfill({ json: dailyReport });
    return route.fulfill({ json: [] });
  });

  await page.goto("/admin/salaries");
  await expect(page.getByRole("heading", { name: "Sueldos por periodo" })).toBeVisible();
  await page.getByRole("button", { name: "Ver detalle" }).click();

  // El resumen distingue valor día, base por calendario, regularización y base del tramo.
  await expect(page.getByText("Valor día legal (sueldo ÷ 30)", { exact: true })).toBeVisible();
  await expect(page.getByText("Base por calendario (treintavos)", { exact: true })).toBeVisible();
  await expect(page.getByText("Regularización de cierre", { exact: true })).toBeVisible();
  await expect(page.getByText("Base del tramo (calendario + regularización)", { exact: true })).toBeVisible();
  await expect(page.getByText("S/ 325.05")).toBeVisible();
  await expect(page.getByText("S/ -0.05").first()).toBeVisible();

  // Las columnas diarias son calendario + regularización; ya no hay cuota de reparto.
  const card = page.locator(".responsive-table-card").first();
  await expect(card.getByText("Base por calendario", { exact: true })).toBeVisible();
  await expect(card.getByText("Regularización", { exact: true })).toBeVisible();
  await expect(page.getByText("Cuota de distribución")).toHaveCount(0);

  // 15 fechas calendario (1–15), sin ningún 25.00 derivado de 325/13.
  await expect(page.locator(".responsive-table-cards").getByText("1–10 de 15")).toBeVisible();
  await expect(card.getByText("S/ 21.67").first()).toBeVisible();
  await expect(page.getByText("S/ 25.00")).toHaveCount(0);
});
