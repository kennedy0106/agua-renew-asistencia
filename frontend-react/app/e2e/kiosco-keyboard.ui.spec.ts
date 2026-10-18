import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

// This checks the browser input contract, not an actual phone's OS keyboard.
test("DNI keypad suppresses the native keyboard hint without blocking text or physical input", async ({ page }) => {
  const mutations: string[] = [];
  await page.route("**/api/v1/**", async (route) => {
    const method = route.request().method();
    if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) mutations.push(method);
    await route.fulfill({
      status: method === "OPTIONS" ? 204 : 401,
      headers: {
        "Access-Control-Allow-Origin": "http://127.0.0.1:3000",
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Allow-Headers": "content-type",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
      },
      ...(method === "OPTIONS" ? {} : { contentType: "application/json", body: '{"detail":"Not authenticated"}' }),
    });
  });

  await page.goto("/asistencia");
  const input = page.getByTestId("kiosk-identifier");
  const keypad = page.getByRole("group", { name: "Teclado numérico" });
  await expect(input).toHaveAttribute("inputmode", "none");
  await expect(input).toBeFocused();

  await keypad.getByRole("button", { name: "1", exact: true }).tap();
  await expect(input).toHaveValue("1");
  await expect(input).toBeFocused();
  await expect(input).toHaveAttribute("inputmode", "none");
  await page.getByRole("button", { name: "Borrar último dígito" }).tap();
  await expect(input).toHaveValue("");
  await input.pressSequentially("12345678");
  await expect(input).toHaveValue("12345678");
  await page.getByRole("button", { name: "Limpiar DNI" }).tap();
  await expect(input).toHaveValue("");

  await page.getByRole("tab", { name: "Código / AR: (texto)" }).tap();
  await expect(input).toHaveAttribute("inputmode", "text");
  await expect(keypad).toHaveCount(0);
  await input.pressSequentially("EMP-002");
  await expect(input).toHaveValue("EMP-002");
  await page.getByRole("tab", { name: "DNI (números)" }).tap();
  await expect(input).toHaveAttribute("inputmode", "none");
  await expect(keypad).toBeVisible();
  expect(mutations).toEqual([]);
});
