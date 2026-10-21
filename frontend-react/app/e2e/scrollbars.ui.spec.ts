import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * Barras de desplazamiento nativas en toda la aplicación.
 *
 * Comprueba el sistema global de `styles/globals.css` más el marcado de
 * actividad de `lib/scrollbar-activity` sobre: la raíz de la página (desktop y
 * móvil), paneles internos verticales y horizontales montados después de la
 * carga, y un diálogo real en portal (fuera de `#root`). Auth y datos se
 * mockean en la ruta: no toca backend, preview ni datos reales.
 */

const ADMIN = {
  id: "scrollbar-admin",
  username: "demo.administrador",
  role: "ADMIN",
  active: true,
  must_change_password: false,
  last_login_at: null,
  created_at: "2026-01-01T00:00:00Z",
};

const ACTIVE_ATTRIBUTE = "data-scrollbar-active";

test.use({ launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } });

async function openRoles(page: Page) {
  await page.route("**/api/v1/**", (route) =>
    route.fulfill({
      json: new URL(route.request().url()).pathname.endsWith("/auth/me") ? ADMIN : [],
    }),
  );
  await page.goto("/admin/roles");
  await expect(page.getByRole("navigation", { name: "Principal", exact: true })).toBeVisible();
}

/** Contenido largo dentro del área de la página: la raíz pasa a tener scroll. */
async function forceDocumentOverflow(page: Page) {
  await page.evaluate(() => {
    if (document.querySelector("#scroll-probe-tall")) return;
    const tall = document.createElement("div");
    tall.id = "scroll-probe-tall";
    tall.style.height = "2400px";
    tall.setAttribute("aria-hidden", "true");
    document.querySelector("main.page")!.append(tall);
  });
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollHeight > document.documentElement.clientHeight,
      ),
    )
    .toBe(true);
}

/** Panel con desborde en ambos ejes, montado después de instalar el sistema. */
async function mountProbe(
  page: Page,
  id: string,
  { parent = "body", right = 0 }: { parent?: string; right?: number } = {},
) {
  await page.evaluate(
    ({ id: probeId, parentSelector, rightOffset }) => {
      const host = document.createElement("div");
      host.id = probeId;
      host.style.cssText = [
        "position:fixed",
        `right:${rightOffset}px`,
        "bottom:0",
        "width:140px",
        "height:90px",
        "overflow:auto",
        "background:#ffffff",
        "z-index:5",
      ].join(";");
      const content = document.createElement("div");
      content.style.cssText = "width:640px;height:640px";
      host.append(content);
      document.querySelector(parentSelector)!.append(host);
    },
    { id, parentSelector: parent, rightOffset: right },
  );
  const probe = page.locator(`#${id}`);
  await expect(probe).toBeVisible();
  return probe;
}

type Rgba = { r: number; g: number; b: number; a: number };

/** Parsea `rgb()/rgba()/color(srgb …)` — no asume una serialización concreta. */
function parseColor(input: string): Rgba {
  const value = input.trim();
  const srgb = value.match(
    /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)$/i,
  );
  if (srgb) {
    const channel = (raw: string) => Math.round(Number.parseFloat(raw) * 255);
    return {
      r: channel(srgb[1]),
      g: channel(srgb[2]),
      b: channel(srgb[3]),
      a: srgb[4] === undefined ? 1 : Number.parseFloat(srgb[4]),
    };
  }
  const rgb = value.match(/^rgba?\(([^)]+)\)$/i);
  if (!rgb) throw new Error(`Color no reconocido por el test: "${value}"`);
  const parts = rgb[1].split(/[,/\s]+/).filter(Boolean);
  const channel = (raw: string) =>
    raw.endsWith("%") ? Math.round(Number.parseFloat(raw) * 2.55) : Number.parseFloat(raw);
  return {
    r: channel(parts[0]),
    g: channel(parts[1]),
    b: channel(parts[2]),
    a: parts[3] === undefined ? 1 : Number.parseFloat(parts[3]),
  };
}

function distance(left: Rgba, right: Rgba) {
  return Math.hypot(left.r - right.r, left.g - right.g, left.b - right.b);
}

/** Estilos reales de las partes de la barra, más el color de marca resuelto. */
async function scrollbarStyles(target: Locator | Page) {
  const evaluateOn = (element: Element | null) => {
    const node = element ?? document.documentElement;
    const probe = document.createElement("div");
    probe.style.color = "var(--scrollbar-thumb-active)";
    document.body.append(probe);
    const activeColor = getComputedStyle(probe).color;
    probe.remove();
    const scrollbar = getComputedStyle(node, "::-webkit-scrollbar");
    const thumb = getComputedStyle(node, "::-webkit-scrollbar-thumb");
    return {
      width: scrollbar.width,
      height: scrollbar.height,
      track: getComputedStyle(node, "::-webkit-scrollbar-track").backgroundColor,
      buttons: getComputedStyle(node, "::-webkit-scrollbar-button").display,
      thumbColor: thumb.backgroundColor,
      thumbRadius: thumb.borderRadius,
      activeColor,
      hasActivityMarker: node.hasAttribute("data-scrollbar-active"),
    };
  };
  if ("evaluate" in target && "locator" in target) {
    return (target as Page).evaluate(evaluateOn, null);
  }
  return (target as Locator).evaluate(evaluateOn);
}

async function expectPaintedViewportIdle(page: Page, activeColor: string) {
  const sample = await page.evaluate(() => {
    const root = document.scrollingElement!;
    const height = root.clientHeight;
    const thumbHeight = Math.max(40, height * height / root.scrollHeight);
    const top = (height - thumbHeight) * root.scrollTop / (root.scrollHeight - height);
    return { x: innerWidth - 4, backgroundX: innerWidth - 9, y: Math.floor(top + thumbHeight / 2) };
  });
  const png = await page.screenshot({ scale: "css" });
  const pixels = await page.evaluate(async ({ image, position }) => {
    const bitmap = new Image();
    bitmap.src = `data:image/png;base64,${image}`;
    await bitmap.decode();
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d")!;
    context.drawImage(bitmap, 0, 0);
    const read = (x: number) => {
      const [r, g, b, a] = context.getImageData(x, position.y, 1, 1).data;
      return { r, g, b, a: a / 255 };
    };
    return { thumb: read(position.x), background: read(position.backgroundX) };
  }, { image: png.toString("base64"), position: sample });
  // Verify the visible thumb, not the host-hover style of a native pseudo-element.
  expect(distance(pixels.thumb, pixels.background)).toBeGreaterThan(10);
  expect(distance(pixels.thumb, pixels.background)).toBeLessThan(
    distance(pixels.thumb, parseColor(activeColor)),
  );
}

function expectSubtleIdle(thumbColor: string, activeColor: string) {
  // Reposo = mismo azul de marca pero translúcido (se sutiliza por opacidad).
  const idle = parseColor(thumbColor);
  expect(idle.a).toBeGreaterThan(0.1);
  expect(idle.a).toBeLessThan(1);
  expect(thumbColor).not.toBe(activeColor);
}

function expectActive(thumbColor: string, activeColor: string) {
  const active = parseColor(thumbColor);
  expect(active.a).toBe(1);
  expect(distance(active, parseColor(activeColor))).toBe(0);
}

async function scrollDocument(page: Page, top: number) {
  await page.evaluate((targetTop) => new Promise<void>((resolve) => {
    document.addEventListener("scroll", () => resolve(), { once: true });
    window.scrollTo({ top: targetTop, behavior: "instant" });
  }), top);
  expect(await page.evaluate(() => window.scrollY)).toBe(top);
}

async function installClock(page: Page) {
  await page.clock.install({ time: new Date("2026-10-19T12:00:00Z") });
  await page.clock.pauseAt(new Date("2026-10-19T12:00:01Z"));
}

for (const [name, viewport, mobile] of [
  ["desktop", { width: 1280, height: 720 }, false],
  ["mobile", { width: 390, height: 720 }, true],
] as const) {
  test.describe(name, () => {
    test.use({ viewport, hasTouch: mobile, isMobile: mobile });

    test("la raíz mantiene el pulgar sutil y sin flechas", async ({ page }, testInfo) => {
      await openRoles(page);
      await forceDocumentOverflow(page);
      await page.mouse.move(viewport.width / 2, viewport.height / 2);

      // Navigation can scroll the document; measure idle only after it settles.
      await expect(page.locator("html")).not.toHaveAttribute(ACTIVE_ATTRIBUTE);
      const styles = await scrollbarStyles(page);
      if (mobile) expectSubtleIdle(styles.thumbColor, styles.activeColor);
      else await expectPaintedViewportIdle(page, styles.activeColor);
      expect(styles.width).toBe("8px");
      expect(styles.height).toBe("8px");
      expect(styles.buttons).toBe("none");
      expect(styles.track).toBe("rgba(0, 0, 0, 0)");
      expect(styles.thumbRadius).toBe("999px");
      expect(styles.hasActivityMarker).toBe(false);
      // Sin desborde horizontal nativo en la raíz.
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);

      // El puntero sobre el contenido no enciende la barra del documento.
      await installClock(page);
      await page.clock.runFor(1_500);
      const afterHover = await scrollbarStyles(page);
      expect(afterHover.thumbColor).toBe(styles.thumbColor);
      expect(afterHover.hasActivityMarker).toBe(false);
      if (!mobile) await expectPaintedViewportIdle(page, afterHover.activeColor);

      await page.screenshot({ path: testInfo.outputPath(`scrollbars-${name}-viewport.png`) });
    });

    test("la raíz se enciende al desplazar y vuelve a reposo tras el último scroll", async ({
      page,
    }) => {
      await openRoles(page);
      await forceDocumentOverflow(page);
      await installClock(page);
      const root = page.locator("html");
      const styles = await scrollbarStyles(page);

      await scrollDocument(page, 600);
      await expect(root).toHaveAttribute(ACTIVE_ATTRIBUTE, "true");
      const scrolled = await scrollbarStyles(page);
      expectActive(scrolled.thumbColor, styles.activeColor);

      // Un scroll dentro del segundo de calma reinicia la cuenta atrás.
      await page.clock.runFor(600);
      await scrollDocument(page, 1200);
      await page.clock.runFor(600);
      expect((await scrollbarStyles(page)).hasActivityMarker).toBe(true);

      await page.clock.runFor(400);
      await expect(root).not.toHaveAttribute(ACTIVE_ATTRIBUTE);
      expect((await scrollbarStyles(page)).thumbColor).toBe(styles.thumbColor);
    });

    test("los paneles internos verticales y horizontales se encienden por separado", async ({
      page,
    }, testInfo) => {
      await openRoles(page);
      await installClock(page);
      const vertical = await mountProbe(page, "scroll-probe-vertical", { right: 0 });
      const horizontal = await mountProbe(page, "scroll-probe-horizontal", { right: 160 });
      const styles = await scrollbarStyles(vertical);
      expectSubtleIdle(styles.thumbColor, styles.activeColor);
      expect(styles.width).toBe("8px");
      expect(styles.buttons).toBe("none");
      expect(styles.track).toBe("rgba(0, 0, 0, 0)");
      expect(styles.thumbRadius).toBe("999px");

      await vertical.evaluate((element) => {
        element.scrollTop = 200;
      });
      await expect(vertical).toHaveAttribute(ACTIVE_ATTRIBUTE, "true");
      // Cada scroller posee su pulgar: la raíz y el vecino siguen en reposo.
      await expect(page.locator("html")).not.toHaveAttribute(ACTIVE_ATTRIBUTE);
      expect((await scrollbarStyles(horizontal)).hasActivityMarker).toBe(false);
      expectActive((await scrollbarStyles(vertical)).thumbColor, styles.activeColor);

      await horizontal.evaluate((element) => {
        element.scrollLeft = 200;
      });
      await expect(horizontal).toHaveAttribute(ACTIVE_ATTRIBUTE, "true");
      expectActive((await scrollbarStyles(horizontal)).thumbColor, styles.activeColor);
      await page.screenshot({
        path: testInfo.outputPath(`scrollbars-${name}-nested.png`),
      });

      await page.clock.runFor(1_000);
      await expect(vertical).not.toHaveAttribute(ACTIVE_ATTRIBUTE);
      await expect(horizontal).not.toHaveAttribute(ACTIVE_ATTRIBUTE);
      expect((await scrollbarStyles(vertical)).thumbColor).toBe(styles.thumbColor);
      expect((await scrollbarStyles(horizontal)).thumbColor).toBe(styles.thumbColor);
    });

    if (!mobile) {
      test("un diálogo en portal usa el mismo sistema y se marca al desplazarlo", async ({
        page,
      }) => {
        await openRoles(page);
        await page.getByRole("button", { name: "Cerrar sesión" }).click();
        const portal = page.locator(".dialog-portal");
        await expect(portal).toBeVisible();
        expect(
          await portal.evaluate((element) => !document.querySelector("#root")!.contains(element)),
        ).toBe(true);

        const dialogStyles = await scrollbarStyles(page.locator(".app-dialog"));
        expectSubtleIdle(dialogStyles.thumbColor, dialogStyles.activeColor);
        expect(dialogStyles.width).toBe("8px");
        expect(dialogStyles.buttons).toBe("none");

        await installClock(page);
        const probe = await mountProbe(page, "scroll-probe-portal", { parent: ".dialog-portal" });
        await probe.evaluate((element) => {
          element.scrollTop = 200;
        });
        await expect(probe).toHaveAttribute(ACTIVE_ATTRIBUTE, "true");
        expectActive((await scrollbarStyles(probe)).thumbColor, dialogStyles.activeColor);

        await page.clock.runFor(1_000);
        await expect(probe).not.toHaveAttribute(ACTIVE_ATTRIBUTE);
        expect((await scrollbarStyles(probe)).thumbColor).toBe(dialogStyles.thumbColor);

        await page.clock.resume();
        await page.keyboard.press("Escape");
        await expect(portal).toHaveCount(0);
      });
    }
  });
}
