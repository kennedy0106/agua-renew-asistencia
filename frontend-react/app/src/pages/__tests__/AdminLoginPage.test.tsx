import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import AdminLoginPage from "@/pages/AdminLoginPage";

const HINT_KEY = "agua-renew-admin-session-hint";
const LOGIN_URL = "http://localhost:8000/api/v1/auth/login";

const USER = {
  id: "u-1",
  username: "ana.torres",
  role: "ADMIN",
  active: true,
  must_change_password: false,
  last_login_at: null,
  created_at: "2026-01-01T00:00:00Z",
};

function renderLogin() {
  return render(
    <MemoryRouter initialEntries={["/admin/login"]}>
      <Routes>
        <Route path="/admin/login" element={<AdminLoginPage />} />
        <Route path="/admin/dashboard" element={<div>Destino panel</div>} />
        <Route path="/admin/change-password" element={<div>Destino cambio</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

function mockJson(status: number, body: unknown) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function fillAndSubmit(username = "ana.torres", password = "secreta-123") {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Usuario"), username);
  await user.type(screen.getByLabelText("Contraseña"), password);
  await user.click(screen.getByRole("button", { name: /Ingresar al sistema/i }));
}

describe("AdminLoginPage", () => {
  it("alterna la visibilidad de la contraseña", async () => {
    const user = userEvent.setup();
    renderLogin();

    expect(screen.getByLabelText("Contraseña")).toHaveAttribute("type", "password");

    await user.click(screen.getByRole("button", { name: "Mostrar contraseña" }));
    expect(screen.getByLabelText("Contraseña")).toHaveAttribute("type", "text");

    await user.click(screen.getByRole("button", { name: "Ocultar contraseña" }));
    expect(screen.getByLabelText("Contraseña")).toHaveAttribute("type", "password");
  });

  it("borra un hint de sesión obsoleto al montar (paridad con admin/layout)", () => {
    // Hint vigente de una sesión anterior: la pantalla de login debe descartarlo,
    // como hace app/admin/layout.tsx cuando `isLogin` es true.
    window.sessionStorage.setItem(
      HINT_KEY,
      JSON.stringify({
        version: 1,
        storedAt: Date.now(),
        user: {
          id: "u-obsoleto",
          username: "sesion.anterior",
          role: "ADMIN",
          active: true,
          must_change_password: false,
        },
      }),
    );
    expect(window.sessionStorage.getItem(HINT_KEY)).not.toBeNull();

    renderLogin();

    expect(window.sessionStorage.getItem(HINT_KEY)).toBeNull();
  });

  it("maneja un error del API sin guardar sesión ni navegar", async () => {
    const fetchMock = mockJson(401, {
      detail: { code: "INVALID_CREDENTIALS", message: "Credenciales inválidas" },
    });
    renderLogin();

    await fillAndSubmit();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Credenciales inválidas");
    expect(screen.queryByText("Destino panel")).not.toBeInTheDocument();
    expect(window.sessionStorage.getItem(HINT_KEY)).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(
      LOGIN_URL,
      expect.objectContaining({ method: "POST", credentials: "include" }),
    );
  });

  it("maneja la caída de red con el mensaje genérico", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", fetchMock);
    renderLogin();

    await fillAndSubmit();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "No se pudo conectar con el servidor. Verifica tu conexión.",
    );
    expect(window.sessionStorage.getItem(HINT_KEY)).toBeNull();
  });

  it("en éxito guarda el hint y navega al dashboard", async () => {
    const fetchMock = mockJson(200, USER);
    renderLogin();

    await fillAndSubmit();

    expect(await screen.findByText("Destino panel")).toBeInTheDocument();

    const raw = window.sessionStorage.getItem(HINT_KEY);
    expect(raw).not.toBeNull();
    const hint = JSON.parse(raw as string);
    expect(hint.version).toBe(1);
    expect(hint.user).toMatchObject({
      id: "u-1",
      username: "ana.torres",
      role: "ADMIN",
      active: true,
      must_change_password: false,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      LOGIN_URL,
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        body: JSON.stringify({ username: "ana.torres", password: "secreta-123" }),
      }),
    );
  });

  it("redirige a cambio de contraseña cuando must_change_password es true", async () => {
    mockJson(200, { ...USER, must_change_password: true });
    renderLogin();

    await fillAndSubmit();

    expect(await screen.findByText("Destino cambio")).toBeInTheDocument();
    expect(screen.queryByText("Destino panel")).not.toBeInTheDocument();
  });
});
