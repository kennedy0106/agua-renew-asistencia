import { expect, test, type Locator, type Page } from "@playwright/test";

// All APIs are synthetic. These tests measure the space occupied by the UI,
// not just the opacity of its text (which missed the original abrupt jump).
const employee = {
  id: "qa-motion", dni: "71112233", employee_code: "QA-001", first_name: "Persona",
  last_name: "Prueba", job_role_id: "qa-role", job_role_name: "Operario", active: true,
  hire_date: null, termination_date: null, qr_token: "qa-motion", created_at: "", updated_at: "",
};
const fixtures: Record<string, unknown> = {
  "/api/v1/auth/me": { id: "qa-admin", username: "qa.motion", role: "ADMIN", active: true,
    must_change_password: false, last_login_at: null, created_at: "" },
  "/api/v1/employees": [employee],
  "/api/v1/attendance/daily": [{ employee_id: employee.id, employee_name: "Persona Prueba",
    work_date: "2026-10-20", session_count: 1, gross_minutes: 540, break_minutes: 60,
    break_source: "SCHEDULE", override_requested_minutes: null, override_limited: false,
    worked_minutes: 480, expected_minutes: 480, difference_minutes: 0, has_open_entry: false,
    incident_codes: [] }],
  "/api/v1/attendance": [{ id: "qa-record", employee_id: employee.id,
    employee_name: "Persona Prueba", job_role_name: "Operario", work_date: "2026-10-20",
    check_in_at: "2026-10-20T13:00:00Z", check_out_at: "2026-10-20T22:00:00Z",
    worked_minutes: 480, expected_minutes: 480, difference_minutes: 0, status: "COMPLETE", notes: null }],
};

type Frame = { ms: number; height: number };
declare global {
  interface Window { __motionGeometry: Frame[] }
}

async function sampleOnClick(probe: Locator, trigger: Locator) {
  await trigger.scrollIntoViewIfNeeded();
  const before = await probe.evaluate((el) => el.getBoundingClientRect().height);
  await probe.evaluate((el) => {
    document.addEventListener("click", () => {
      const start = performance.now();
      window.__motionGeometry = [{ ms: 0, height: el.getBoundingClientRect().height }];
      const sample = () => {
        window.__motionGeometry.push({ ms: performance.now() - start, height: el.getBoundingClientRect().height });
        if (performance.now() - start < 400) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    }, { capture: true, once: true });
  });
  await trigger.click();
  await expect.poll(() => probe.page().evaluate(() => window.__motionGeometry.at(-1)?.ms ?? 0)).toBeGreaterThan(400);
  const frames = await probe.page().evaluate(() => window.__motionGeometry);
  return { before, after: frames.at(-1)!.height, frames };
}

function expectSpatialTransition(result: Awaited<ReturnType<typeof sampleOnClick>>) {
  const low = Math.min(result.before, result.after);
  const high = Math.max(result.before, result.after);
  expect(high - low).toBeGreaterThan(30);
  const intermediate = result.frames.filter((f) => f.height > low + 1 && f.height < high - 1);
  expect(intermediate.length, JSON.stringify(result.frames)).toBeGreaterThanOrEqual(2);
  // Text fading inside a full-height container must not satisfy the contract.
  expect(new Set(intermediate.map((f) => Math.round(f.height))).size).toBeGreaterThanOrEqual(2);
}

async function detailView(page: Page, title: string, mobile: boolean) {
  return page.getByRole(mobile ? "region" : "table", { name: title, exact: true });
}

test.beforeEach(async ({ page }) => {
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const origin = request.headers()["origin"] ?? "http://127.0.0.1:3000";
    const headers = { "access-control-allow-origin": origin, "access-control-allow-credentials": "true",
      "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET,OPTIONS" };
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    if (request.method() !== "GET") throw new Error(`Unexpected write: ${request.method()} ${request.url()}`);
    return route.fulfill({ headers, json: fixtures[new URL(request.url()).pathname] ?? [] });
  });
});

for (const mobile of [false, true]) {
  test.describe(mobile ? "continuidad movil" : "continuidad escritorio", () => {
    test.use({ viewport: mobile ? { width: 390, height: 844 } : { width: 1600, height: 1000 },
      hasTouch: mobile, isMobile: mobile, reducedMotion: "no-preference" });

    for (const title of ["Resumen diario del equipo", "Detalle de marcaciones"]) {
      test(`${title}: apertura y cierre mueven el espacio, sin residuos`, async ({ page }, testInfo) => {
        await page.goto("/admin/attendance");
        const view = await detailView(page, title, mobile);
        const trigger = view.locator(".attendance-row-toggle").first();
        await expect(trigger).toBeVisible();
        await page.evaluate(() => document.fonts.ready);
        const opened = await sampleOnClick(view, trigger);
        expectSpatialTransition(opened);
        await expect(trigger).toHaveAttribute("aria-expanded", "true");
        const panelId = await trigger.getAttribute("aria-controls");
        await expect(page.locator(`[id=${JSON.stringify(panelId)}]`)).toBeVisible();
        await view.screenshot({ path: testInfo.outputPath("expanded.png") });
        const closed = await sampleOnClick(view, trigger);
        expectSpatialTransition(closed);
        expect(Math.abs(closed.after - opened.before)).toBeLessThan(2);
        await expect(trigger).toHaveAttribute("aria-expanded", "false");
        await testInfo.attach("geometry.json", { body: JSON.stringify({ opened, closed }), contentType: "application/json" });
        await trigger.click();
        await expect(trigger).toHaveAttribute("aria-expanded", "true");
        await page.setViewportSize({ width: mobile ? 430 : 1400, height: 1000 });
        await expect.poll(() => view.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
      });
    }

    test("DNI y Codigo conservan valor y foco con cambio gradual de tarjeta", async ({ page }, testInfo) => {
      await page.goto("/asistencia");
      const input = page.getByTestId("kiosk-identifier");
      await input.fill("71112233");
      await page.evaluate(() => document.fonts.ready);
      const card = page.locator(".kiosk-card");
      const toCode = await sampleOnClick(card, page.getByRole("tab").nth(1));
      expectSpatialTransition(toCode);
      await expect(input).toHaveValue("71112233");
      await expect(input).toBeFocused();
      await expect(input).toHaveAttribute("inputmode", "text");
      await expect(page.getByRole("group", { name: "Teclado numérico" })).toHaveCount(0);
      await page.screenshot({ path: testInfo.outputPath("kiosk-code.png") });
      const toDni = await sampleOnClick(card, page.getByRole("tab").first());
      expectSpatialTransition(toDni);
      expect(Math.abs(toDni.after - toCode.before)).toBeLessThan(2);
      await expect(input).toHaveValue("71112233");
      await expect(input).toBeFocused();
      await expect(input).toHaveAttribute("inputmode", "none");
      await expect(page.getByRole("group", { name: "Teclado numérico" })).toBeVisible();
      await testInfo.attach("geometry.json", { body: JSON.stringify({ toCode, toDni }), contentType: "application/json" });
      await page.waitForTimeout(1100); // The live clock must not retrigger the transition.
      expect(await card.evaluate((el) => el.getAnimations({ subtree: true }).filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).length)).toBe(0);
      await page.screenshot({ path: testInfo.outputPath("kiosk-dni.png") });
      await input.fill("EMP-002");
      await expect(input).toHaveAttribute("inputmode", "text");
      await expect(input).toHaveValue("EMP-002");
      await expect(input).toBeFocused();
    });

    test("alternar durante la transicion deja el estado final correcto y utilizable", async ({ page }) => {
      await page.goto("/admin/attendance");
      for (const title of ["Resumen diario del equipo", "Detalle de marcaciones"]) {
        const view = await detailView(page, title, mobile);
        const trigger = view.locator(".attendance-row-toggle").first();
        // detail=1 represents a pointer click; dispatch avoids Playwright waiting
        // for the moving target to settle between reversals.
        for (let i = 0; i < 5; i++) {
          await trigger.dispatchEvent("click", { detail: 1 });
          await page.waitForTimeout(35);
        }
        await expect(trigger).toHaveAttribute("aria-expanded", "true");
        const id = await trigger.getAttribute("aria-controls");
        await expect(page.locator(`[id=${JSON.stringify(id)}]`)).toBeVisible();
        await page.waitForTimeout(300);
        await trigger.click();
        await expect(trigger).toHaveAttribute("aria-expanded", "false");
      }
      await page.goto("/asistencia");
      const tabs = page.getByRole("tab");
      for (const index of [1, 0, 1, 0, 1, 0]) {
        await tabs.nth(index).dispatchEvent("click", { detail: 1 });
        await page.waitForTimeout(35);
      }
      const keypad = page.getByRole("group", { name: "Teclado numérico" });
      await expect(keypad).toBeVisible();
      await keypad.getByRole("button", { name: "4", exact: true }).click();
      await expect(page.getByTestId("kiosk-identifier")).toHaveValue("4");
      await tabs.nth(1).click();
      await expect(keypad).toHaveCount(0);
    });

    for (const interaction of ["reduced", "keyboard"] as const) {
      test(`${interaction}: no hay expansion animada ni controles ocultos accesibles`, async ({ page }) => {
        if (interaction === "reduced") await page.emulateMedia({ reducedMotion: "reduce" });
        await page.goto("/admin/attendance");
        for (const title of ["Resumen diario del equipo", "Detalle de marcaciones"]) {
          const view = await detailView(page, title, mobile);
          const trigger = view.locator(".attendance-row-toggle").first();
          if (interaction === "keyboard") { await trigger.focus(); await trigger.press("Enter"); }
          else await trigger.click();
          await expect(trigger).toHaveAttribute("aria-expanded", "true");
          const running = await view.evaluate((el) => el.getAnimations({ subtree: true })
            .filter((a) => (a as CSSTransition).transitionProperty === "height").length);
          expect(running).toBe(0);
          if (interaction === "keyboard") await trigger.press("Enter"); else await trigger.click();
          await expect(trigger).toHaveAttribute("aria-expanded", "false");
        }
        await page.goto("/asistencia");
        const code = page.getByRole("tab").nth(1);
        if (interaction === "keyboard") { await code.focus(); await code.press("Enter"); }
        else await code.click();
        await expect(page.getByTestId("kiosk-identifier")).toHaveAttribute("inputmode", "text");
        expect(await page.locator(".kiosk-card").evaluate((el) => el.getAnimations({ subtree: true })
          .filter((a) => (a as CSSTransition).transitionProperty === "height").length)).toBe(0);
        await expect(page.getByRole("group", { name: "Teclado numérico" })).toHaveCount(0);
      });
    }
  });
}
