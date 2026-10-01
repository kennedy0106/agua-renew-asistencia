import { expect, test } from "@playwright/test";

/**
 * Smoke de login (UI) para el frontend React + Vite.
 *
 * No requiere backend: valida que Vite sirva la SPA, que `/admin/login`
 * renderice el formulario y que el fallback de deep-link entregue `index.html`
 * (por eso una ruta desconocida llega al 404 de la SPA y no a un 404 del
 * servidor). Los flujos que sí tocan el API se cubren en la suite de
 * integración (`*.integration.spec.ts`, ver README).
 */

test("smoke: /admin/login renderiza el formulario", async ({ page }) => {
  await page.goto("/admin/login");

  // El logo aparece dos veces (hero y placa de marca): basta validar el primero.
  await expect(page.getByAltText("Agua ReNew").first()).toBeVisible();
  await expect(page.getByLabel("Usuario")).toBeVisible();
  await expect(page.getByLabel("Contraseña", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Ingresar al sistema/i })).toBeVisible();
});

test("smoke: alterna la visibilidad de la contraseña", async ({ page }) => {
  await page.goto("/admin/login");

  // `exact` evita que el toggle (aria-label "Mostrar contraseña") entre en el match.
  const password = page.getByLabel("Contraseña", { exact: true });
  await expect(password).toHaveAttribute("type", "password");

  await page.getByRole("button", { name: "Mostrar contraseña" }).click();
  await expect(password).toHaveAttribute("type", "text");

  await page.getByRole("button", { name: "Ocultar contraseña" }).click();
  await expect(password).toHaveAttribute("type", "password");
});

test("smoke: navegación SPA desde la portada hacia el login", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("link", { name: /Panel administrativo/i }).click();

  await expect(page).toHaveURL(/\/admin\/login$/);
  await expect(page.getByRole("button", { name: /Ingresar al sistema/i })).toBeVisible();
});

test("smoke: deep-link directo sirve la SPA, no un 404 del servidor", async ({ page }) => {
  const response = await page.goto("/admin/login");

  expect(response?.status()).toBe(200);
  await expect(page.locator("#root")).not.toBeEmpty();
});

test("smoke: una ruta desconocida muestra el 404 de la SPA", async ({ page }) => {
  const response = await page.goto("/ruta-que-no-existe");

  expect(response?.status()).toBe(200);
  await expect(page.getByText("Página no encontrada")).toBeVisible();
});
