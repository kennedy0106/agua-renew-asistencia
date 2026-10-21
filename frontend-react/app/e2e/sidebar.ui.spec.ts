import { expect, test, type Locator, type Page } from "@playwright/test";

const ADMIN = {
  id: "sidebar-admin", username: "demo.administrador", role: "ADMIN", active: true,
  must_change_password: false, last_login_at: null, created_at: "2026-01-01T00:00:00Z",
};

test.use({ launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } });

async function openSidebar(page: Page, mobile: boolean) {
  await page.route("**/api/v1/**", (route) => route.fulfill({
    json: new URL(route.request().url()).pathname.endsWith("/auth/me") ? ADMIN : [],
  }));
  await page.goto("/admin/roles");
  if (mobile) {
    await page.getByRole("button", { name: "Abrir menú" }).click();
    await expect(page.locator("#admin-sidebar")).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 0)");
  }
  await expect(page.getByRole("navigation", { name: "Principal", exact: true })).toBeVisible();
}

async function scrollbarAppearance(nav: Locator) {
  return nav.evaluate((element) => {
    const context = document.createElement("canvas").getContext("2d")!;
    const rgb = (color: string) => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      return Array.from(context.getImageData(0, 0, 1, 1).data);
    };
    const color = getComputedStyle(element, "::-webkit-scrollbar-thumb").backgroundColor;
    const thumb = rgb(color);
    const surface = rgb(getComputedStyle(element.closest(".sidebar")!).backgroundColor);
    const primary = rgb(getComputedStyle(element).getPropertyValue("--st-primary"));
    const distance = (other: number[]) => Math.hypot(...thumb.slice(0, 3).map((value, index) => value - other[index]));
    return { color, alpha: thumb[3], surfaceDistance: distance(surface), primaryDistance: distance(primary) };
  });
}

async function scrollSidebar(nav: Locator, bottom: boolean) {
  await nav.evaluate((element, toBottom) => new Promise<void>((resolve) => {
    element.addEventListener("scroll", () => resolve(), { once: true });
    element.scrollTop = toBottom ? element.scrollHeight : 0;
  }), bottom);
}

for (const [name, viewport, mobile] of [
  ["desktop", { width: 1280, height: 720 }, false],
  ["mobile drawer", { width: 390, height: 640 }, true],
] as const) {
  test.describe(name, () => {
    test.use({ viewport, hasTouch: mobile, isMobile: mobile });

    test("centers the sidebar logo and product label", async ({ page }, testInfo) => {
      await openSidebar(page, mobile);
      const sidebar = page.locator("#admin-sidebar");
      const centered = async (selector: string) => sidebar.evaluate((element, childSelector) => {
        const parent = element.getBoundingClientRect();
        const child = element.querySelector(childSelector)!.getBoundingClientRect();
        return Math.abs(child.x + child.width / 2 - (parent.x + parent.width / 2));
      }, selector);
      await expect.poll(() => centered(".sidebar-brand img")).toBeLessThan(1);
      await expect.poll(() => centered(".sidebar-product")).toBeLessThan(1);
      await expect(sidebar.getByRole("link", { name: "Ir al dashboard", exact: true })).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath("sidebar.png") });
    });

    test("keeps the idle scrollbar visible but closer to the sidebar surface than the action blue", async ({ page }) => {
      await openSidebar(page, mobile);
      const appearance = await scrollbarAppearance(page.locator(".sidebar-nav"));
      expect(appearance.alpha).toBe(255);
      expect(appearance.surfaceDistance).toBeGreaterThan(0);
      expect(appearance.surfaceDistance).toBeLessThan(appearance.primaryDistance);
    });

    if (!mobile) {
      test("highlights the scrollbar on hover and restores its idle color after leaving", async ({ page }) => {
        await openSidebar(page, mobile);
        const nav = page.locator(".sidebar-nav");
        const idle = await scrollbarAppearance(nav);
        await nav.hover();
        await expect.poll(async () => (await scrollbarAppearance(nav)).primaryDistance).toBe(0);
        await page.mouse.move(viewport.width - 5, viewport.height - 5);
        await expect.poll(async () => (await scrollbarAppearance(nav)).color).toBe(idle.color);
      });
    }

    test("highlights while scrolling and returns to idle after scrolling stops", async ({ page }) => {
      await openSidebar(page, mobile);
      await page.mouse.move(viewport.width - 5, viewport.height - 5);
      const nav = page.locator(".sidebar-nav");
      const idle = await scrollbarAppearance(nav);
      await page.clock.install({ time: new Date("2026-10-19T12:00:00Z") });
      await page.clock.pauseAt(new Date("2026-10-19T12:00:01Z"));
      await scrollSidebar(nav, true);
      await expect.poll(async () => (await scrollbarAppearance(nav)).primaryDistance).toBe(0);
      await page.clock.runFor(600);
      await scrollSidebar(nav, false);
      await page.clock.runFor(600);
      expect((await scrollbarAppearance(nav)).primaryDistance).toBe(0);
      await page.clock.runFor(600);
      await expect.poll(async () => (await scrollbarAppearance(nav)).color).toBe(idle.color);
    });

    test("needs no scrollbar when every menu item fits", async ({ page }, testInfo) => {
      await page.setViewportSize({ width: viewport.width, height: 1200 });
      await openSidebar(page, mobile);
      const nav = page.locator(".sidebar-nav");
      const geometry = await nav.evaluate((element) => {
        element.scrollTop = 100;
        return {
          fits: element.scrollHeight <= element.clientHeight,
          scrollTop: element.scrollTop,
          overflow: getComputedStyle(element).overflowY,
        };
      });
      expect(geometry).toEqual({ fits: true, scrollTop: 0, overflow: "auto" });
      await expect(nav.getByRole("link", { name: "Auditoría", exact: true })).toBeInViewport();
      await page.screenshot({ path: testInfo.outputPath("sidebar-fits.png") });
    });

    test("themes the scrollbar and keeps every navigation item reachable", async ({ page }) => {
      await openSidebar(page, mobile);
      const nav = page.getByRole("navigation", { name: "Principal", exact: true });
      const styles = await nav.evaluate((element) => {
        const style = getComputedStyle(element);
        const thumb = getComputedStyle(element, "::-webkit-scrollbar-thumb");
        return {
          gutter: style.scrollbarGutter,
          width: getComputedStyle(element, "::-webkit-scrollbar").width,
          buttons: getComputedStyle(element, "::-webkit-scrollbar-button").display,
          thumbColor: thumb.backgroundColor,
          thumbRadius: thumb.borderRadius,
          trackColor: getComputedStyle(element, "::-webkit-scrollbar-track").backgroundColor,
          overflow: element.scrollHeight > element.clientHeight,
        };
      });
      expect(styles.gutter).toBe("stable");
      expect(styles.width).toBe("8px");
      expect(styles.buttons).toBe("none");
      expect(styles.thumbColor).not.toBe("rgba(21, 67, 153, 0.25)");
      expect(styles.thumbColor).not.toBe("rgba(0, 0, 0, 0)");
      expect(styles.thumbRadius).toBe("999px");
      expect(styles.trackColor).toBe("rgba(0, 0, 0, 0)");
      expect(styles.overflow).toBe(true);

      const audit = nav.getByRole("link", { name: "Auditoría", exact: true });
      await audit.scrollIntoViewIfNeeded();
      await expect(audit).toBeInViewport();
      expect(await nav.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
      await expect(page.locator(".sidebar-user")).toBeInViewport();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (mobile) {
        await page.keyboard.press("Escape");
        await expect(page.getByRole("button", { name: "Abrir menú" })).toBeFocused();
        await expect(page.locator("#admin-sidebar")).not.toHaveClass(/is-open/);
      }
    });
  });
}
