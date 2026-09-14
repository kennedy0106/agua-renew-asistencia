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
