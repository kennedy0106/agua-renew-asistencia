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

test("la navegación privada conserva la sesión y asistencia acota la carga al mes de Lima", async ({ page }) => {
  await page.addInitScript((sessionUser) => {
    sessionStorage.setItem("agua-renew-admin-session-hint", JSON.stringify({
      version: 1,
      storedAt: Date.now(),
      user: sessionUser,
    }));
  }, user);

  let sessionRequests = 0;
  const attendanceRequests: URL[] = [];
  const getContentTypes: Array<string | undefined> = [];
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET") getContentTypes.push(request.headers()["content-type"]);
    if (url.pathname.endsWith("/auth/me")) sessionRequests += 1;
    if (url.pathname === "/api/v1/attendance" || url.pathname === "/api/v1/attendance/daily") {
      attendanceRequests.push(url);
    }
    const body = url.pathname.endsWith("/auth/me")
      ? user
      : url.pathname.includes("/attendance/summary")
        ? { employees_active: 1, present_today: 0, no_entry_today: 1, open_entries: 0, checked_out_today: 0 }
        : [];
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
  });

  await page.goto("/admin/dashboard");
  await expect(page.getByRole("heading", { name: "El equipo, de un vistazo." })).toBeVisible();
  attendanceRequests.length = 0;
  await page.getByRole("link", { name: "Asistencia" }).click();
  await expect(page.getByRole("heading", { name: "Asistencia", exact: true })).toBeVisible();
  await expect.poll(() => attendanceRequests.length).toBe(2);
  expect(attendanceRequests.map((url) => `${url.pathname}${url.search}`)).toHaveLength(2);

  expect(sessionRequests).toBe(1);
  expect(getContentTypes.every((value) => value === undefined)).toBe(true);
  for (const url of attendanceRequests) {
    const from = url.searchParams.get("date_from");
    const to = url.searchParams.get("date_to");
    expect(from).toMatch(/^\d{4}-\d{2}-01$/);
    expect(to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(to?.slice(0, 7)).toBe(from?.slice(0, 7));
  }
});
