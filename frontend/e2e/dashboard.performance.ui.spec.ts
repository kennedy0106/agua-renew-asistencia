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

test("el dashboard no precarga las rutas de la barra lateral al abrirse", async ({ page }) => {
  await page.addInitScript((sessionUser) => {
    sessionStorage.setItem("agua-renew-admin-session-hint", JSON.stringify({
      version: 1,
      storedAt: Date.now(),
      user: {
        id: sessionUser.id,
        username: sessionUser.username,
        role: sessionUser.role,
        active: sessionUser.active,
        must_change_password: sessionUser.must_change_password,
      },
    }));
  }, user);

  await page.route("**/api/v1/**", async (route) => {
    const url = route.request().url();
    const body = url.includes("/auth/me")
      ? user
      : url.includes("/attendance/summary")
        ? { employees_active: 1, present_today: 0, no_entry_today: 1, open_entries: 0, checked_out_today: 0 }
        : [];
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
  });

  const prefetchedRoutes: string[] = [];
  page.on("request", (request) => {
    const url = request.url();
    if (url.includes("_rsc=") && /\/admin\/(attendance|employees|payroll|audit|users|devices|salaries|roles|overtime-policy)/.test(url)) {
      prefetchedRoutes.push(url);
    }
  });

  await page.goto("/admin/dashboard");
  await expect(page.getByRole("heading", { name: "El equipo, de un vistazo." })).toBeVisible();
  await page.waitForTimeout(750);

  expect(prefetchedRoutes).toEqual([]);
});
