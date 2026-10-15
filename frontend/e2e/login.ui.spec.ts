import { expect, test, type Page } from "@playwright/test";

const viewports = [
  { name: "375×667", width: 375, height: 667 },
  { name: "412×800", width: 412, height: 800 },
  { name: "844×390", width: 844, height: 390 },
];

async function settleLogin(page: Page) {
  await page.goto("/admin/login");
  await page.evaluate(async () => {
    await document.fonts.ready;
    const finiteAnimations = document.getAnimations().filter((animation) =>
      Number.isFinite(animation.effect?.getComputedTiming().endTime),
    );
    await Promise.all(finiteAnimations.map((animation) => animation.finished.catch(() => undefined)));
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
}

async function metrics(page: Page) {
  return page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    height: document.documentElement.clientHeight,
    scrollHeight: document.documentElement.scrollHeight,
  }));
}

for (const dpr of [1, 2]) {
  test(`login cabe sin scroll normal en DPR ${dpr}`, async ({ browser }) => {
    for (const viewport of viewports) {
      const context = await browser.newContext({ viewport, deviceScaleFactor: dpr });
      const page = await context.newPage();
      await settleLogin(page);
      const size = await metrics(page);
      expect(size.scrollWidth, viewport.name).toBeLessThanOrEqual(size.width + 1);
      expect(size.scrollHeight, viewport.name).toBeLessThanOrEqual(size.height + 1);
      const toggle = await page.getByRole("button", { name: /mostrar contraseña|ocultar contraseña/i }).boundingBox();
      expect(toggle?.width, viewport.name).toBeGreaterThanOrEqual(44);
      expect(toggle?.height, viewport.name).toBeGreaterThanOrEqual(44);
      await context.close();
    }
  });
}

const loginPanels = [".login-wrap--adaptive", ".login-hero--adaptive", ".login-card--adaptive"];

/**
 * Returns, per login panel, the overflow that actually produces a scrollbar.
 * Decorative pseudo-elements (the card halo, the hero orbs) sit on panels whose
 * base `overflow` is `hidden`/`visible`, so they must not be counted: only a
 * computed `overflow: auto|scroll` axis can render a scrollbar.
 */
async function scrollableOverflow(page: Page) {
  return page.evaluate((selectors) => {
    return selectors.map((selector) => {
      const el = document.querySelector(selector) as HTMLElement | null;
      if (!el) return { selector, found: false, vertical: 0, horizontal: 0, overflowX: "", overflowY: "" };
      const cs = getComputedStyle(el);
      const scrollableX = cs.overflowX === "auto" || cs.overflowX === "scroll";
      const scrollableY = cs.overflowY === "auto" || cs.overflowY === "scroll";
      return {
        selector,
        found: true,
        vertical: scrollableY ? el.scrollHeight - el.clientHeight : 0,
        horizontal: scrollableX ? el.scrollWidth - el.clientWidth : 0,
        overflowX: cs.overflowX,
        overflowY: cs.overflowY,
      };
    });
  }, loginPanels);
}

for (const viewport of [
  { name: "1400×928", width: 1400, height: 928 },
  { name: "1440×900", width: 1440, height: 900 },
]) {
  test(`login de escritorio ${viewport.name} no muestra scroll interno en ningún panel`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await settleLogin(page);

    for (const panel of await scrollableOverflow(page)) {
      expect(panel.found, panel.selector).toBe(true);
      expect(panel.vertical, `${panel.selector} scroll vertical (${panel.overflowY})`).toBeLessThanOrEqual(1);
      expect(panel.horizontal, `${panel.selector} scroll horizontal (${panel.overflowX})`).toBeLessThanOrEqual(1);
    }

    const size = await metrics(page);
    expect(size.scrollWidth).toBeLessThanOrEqual(size.width + 1);
    expect(size.scrollHeight).toBeLessThanOrEqual(size.height + 1);

    // El CTA y el pie permanecen dentro de la tarjeta, sin recorte.
    const card = await page.locator(".login-card--adaptive").boundingBox();
    const submit = page.getByRole("button", { name: /ingresar al sistema/i });
    const security = page.locator(".login-security");
    await expect(submit).toBeVisible();
    await expect(security).toBeVisible();
    const submitBox = (await submit.boundingBox())!;
    const securityBox = (await security.boundingBox())!;
    expect(submitBox.y + submitBox.height).toBeLessThanOrEqual(card!.y + card!.height + 1);
    expect(securityBox.y + securityBox.height).toBeLessThanOrEqual(card!.y + card!.height + 1);
  });
}

test("login en pantalla baja 976×494 mantiene el CTA alcanzable sin scroll interno", async ({ page }) => {
  await page.setViewportSize({ width: 976, height: 494 });
  await settleLogin(page);

  for (const panel of await scrollableOverflow(page)) {
    expect(panel.found, panel.selector).toBe(true);
    expect(panel.vertical, `${panel.selector} scroll vertical (${panel.overflowY})`).toBeLessThanOrEqual(1);
    expect(panel.horizontal, `${panel.selector} scroll horizontal (${panel.overflowX})`).toBeLessThanOrEqual(1);
  }

  const submit = page.getByRole("button", { name: /ingresar al sistema/i });
  await submit.scrollIntoViewIfNeeded();
  await expect(submit).toBeVisible();
  await expect(submit).toBeEnabled();
});

test("login móvil 390×844 no crea scroll interno en las tarjetas", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await settleLogin(page);

  for (const panel of await scrollableOverflow(page)) {
    expect(panel.vertical, `${panel.selector} scroll vertical (${panel.overflowY})`).toBeLessThanOrEqual(1);
    expect(panel.horizontal, `${panel.selector} scroll horizontal (${panel.overflowX})`).toBeLessThanOrEqual(1);
  }

  const size = await metrics(page);
  expect(size.scrollWidth).toBeLessThanOrEqual(size.width + 1);
  await expect(page.getByRole("button", { name: /ingresar al sistema/i })).toBeVisible();
});

test("a 200% de texto no hay desborde horizontal y el CTA sigue alcanzable", async ({ page }) => {
  await page.setViewportSize({ width: 412, height: 800 });
  await settleLogin(page);
  await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const size = await metrics(page);
  expect(size.scrollWidth).toBeLessThanOrEqual(size.width + 1);
  expect(size.scrollHeight).toBeGreaterThanOrEqual(size.height);
  const submit = page.getByRole("button", { name: /ingresar al sistema/i });
  await submit.scrollIntoViewIfNeeded();
  await expect(submit).toBeVisible();
  await expect(submit).toBeEnabled();
});
