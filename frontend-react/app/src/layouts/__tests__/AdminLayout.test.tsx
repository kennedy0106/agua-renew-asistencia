import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import AdminLayout from "@/layouts/AdminLayout";
import { API_URL } from "@/lib/api";

const HINT_KEY = "agua-renew-admin-session-hint";
const ME_URL = `${API_URL}/api/v1/auth/me`;

const USER = {
  id: "u-1",
  username: "ana.torres",
  role: "ADMIN",
  active: true,
  must_change_password: false,
  last_login_at: null,
  created_at: "2026-01-01T00:00:00Z",
};

function renderAdmin(initialPath: string) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/admin" element={<AdminLayout />}>
          <Route path="login" element={<div>Ruta login</div>} />
          <Route path="change-password" element={<div>Ruta cambio</div>} />
          <Route
            path="dashboard"
            element={
              <>
                <div>Ruta panel</div>
                <Link to="/admin/attendance">Ir a asistencia</Link>
              </>
            }
          />
          <Route path="attendance" element={<div>Ruta asistencia</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

function stubMe(status: number, body: unknown) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function seedHint() {
  window.sessionStorage.setItem(
    HINT_KEY,
    JSON.stringify({
      version: 1,
      storedAt: Date.now(),
      user: {
        id: "u-viejo",
        username: "sesion.anterior",
        role: "ADMIN",
        active: true,
        must_change_password: false,
      },
    }),
  );
}

describe("AdminLayout — guardas de sesión", () => {
  it("resuelve /me, muestra el contenido privado y deja el hint", async () => {
    const fetchMock = stubMe(200, USER);
    const { container } = renderAdmin("/admin/dashboard");

    expect(await screen.findByText("Ruta panel")).toBeInTheDocument();
    expect(container.querySelectorAll(".app-shell")).toHaveLength(1);
    await waitFor(() => expect(window.sessionStorage.getItem(HINT_KEY)).not.toBeNull());
    expect(fetchMock).toHaveBeenCalledWith(ME_URL, expect.objectContaining({ credentials: "include" }));
  });

  it("un 401 limpia el hint y redirige a /admin/login", async () => {
    stubMe(401, { detail: { code: "UNAUTHENTICATED", message: "Sesión expirada" } });
    const { container } = renderAdmin("/admin/dashboard");

    expect(await screen.findByText("Ruta login")).toBeInTheDocument();
    expect(screen.queryByText("Ruta panel")).not.toBeInTheDocument();
    expect(container.querySelector(".app-shell")).toBeNull();
    expect(window.sessionStorage.getItem(HINT_KEY)).toBeNull();
  });

  it("must_change_password fuerza el cambio de contraseña fuera del shell", async () => {
    stubMe(200, { ...USER, must_change_password: true });
    const { container } = renderAdmin("/admin/dashboard");

    expect(await screen.findByText("Ruta cambio")).toBeInTheDocument();
    expect(screen.queryByText("Ruta panel")).not.toBeInTheDocument();
    expect(container.querySelector(".app-shell")).toBeNull();
  });

  it("sin cambio pendiente, /admin/change-password vuelve al panel", async () => {
    stubMe(200, USER);
    renderAdmin("/admin/change-password");

    expect(await screen.findByText("Ruta panel")).toBeInTheDocument();
    expect(screen.queryByText("Ruta cambio")).not.toBeInTheDocument();
  });

  it("en /admin/login descarta el hint sin consultar /me y sin shell", async () => {
    const fetchMock = stubMe(200, USER);
    seedHint();
    const { container } = renderAdmin("/admin/login");

    expect(await screen.findByText("Ruta login")).toBeInTheDocument();
    expect(container.querySelector(".app-shell")).toBeNull();
    await waitFor(() => expect(window.sessionStorage.getItem(HINT_KEY)).toBeNull());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("navegar entre dos rutas privadas no repite /auth/me (regresión navigateRef/Suspense)", async () => {
    const fetchMock = stubMe(200, USER);
    const user = userEvent.setup();
    renderAdmin("/admin/dashboard");

    expect(await screen.findByText("Ruta panel")).toBeInTheDocument();

    await user.click(screen.getByRole("link", { name: "Ir a asistencia" }));
    expect(await screen.findByText("Ruta asistencia")).toBeInTheDocument();

    const meCalls = fetchMock.mock.calls.filter(([input]) => input === ME_URL);
    expect(meCalls).toHaveLength(1);
  });
});
