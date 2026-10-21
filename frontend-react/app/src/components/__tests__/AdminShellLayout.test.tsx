import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Link, MemoryRouter, Outlet, Route, Routes } from "react-router-dom";
import { beforeAll, describe, expect, it, vi } from "vitest";
import AdminShell, { AdminShellLayout } from "@/components/AdminShell";
import { AdminSessionContext } from "@/components/AdminSession";
import type { UserOut } from "@/lib/api";

const USER: UserOut = {
  id: "u-1",
  username: "ana.torres",
  role: "ADMIN",
  active: true,
  must_change_password: false,
  last_login_at: null,
  created_at: "2026-01-01T00:00:00Z",
};

beforeAll(() => {
  // jsdom no implementa scrollTo; el foco/scroll del host no debe romper.
  window.scrollTo = vi.fn() as typeof window.scrollTo;
});

function renderAdminShell(initialPath = "/admin/dashboard") {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <AdminSessionContext.Provider value={{ user: USER, ready: true }}>
        <Routes>
          <Route
            path="/admin"
            element={
              <AdminShellLayout>
                <Outlet />
              </AdminShellLayout>
            }
          >
            <Route
              path="dashboard"
              element={
                <AdminShell title="Hoy personalizado" subtitle="Resumen del día">
                  <p>Contenido de hoy</p>
                  <Link to="/admin/plain">Ir a una ruta sin registro</Link>
                </AdminShell>
              }
            />
            <Route
              path="attendance"
              element={
                <AdminShell title="Asistencia personalizada">
                  <p>Contenido de asistencia</p>
                </AdminShell>
              }
            />
            <Route path="plain" element={<p>Contenido sin shell propio</p>} />
          </Route>
        </Routes>
      </AdminSessionContext.Provider>
    </MemoryRouter>,
  );
}

describe("AdminShellLayout — host persistente", () => {
  it("conserva sidebar, topbar y main entre rutas y actualiza el título", async () => {
    const user = userEvent.setup();
    const { container } = renderAdminShell();

    expect(screen.getByRole("heading", { name: "Hoy personalizado" })).toBeInTheDocument();

    const sidebar = container.querySelector("#admin-sidebar");
    const topbar = container.querySelector(".topbar");
    const main = container.querySelector("main.page");
    const nav = container.querySelector(".sidebar-nav") as HTMLElement;
    expect(sidebar).not.toBeNull();
    expect(topbar).not.toBeNull();
    expect(main).not.toBeNull();

    // El scroll del menú no se reinicia al navegar (misma identidad DOM).
    let navScrollTop = 168;
    Object.defineProperty(nav, "scrollTop", {
      configurable: true,
      get: () => navScrollTop,
      set: (value: number) => {
        navScrollTop = value;
      },
    });

    await user.click(within(sidebar as HTMLElement).getByRole("link", { name: "Asistencia" }));

    expect(await screen.findByText("Contenido de asistencia")).toBeInTheDocument();
    expect(container.querySelector("#admin-sidebar")).toBe(sidebar);
    expect(container.querySelector(".topbar")).toBe(topbar);
    expect(container.querySelector("main.page")).toBe(main);
    expect(container.querySelectorAll(".app-shell")).toHaveLength(1);
    expect(screen.getByRole("heading", { name: "Asistencia personalizada" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Hoy personalizado" })).not.toBeInTheDocument();
    expect(nav.scrollTop).toBe(168);

    // El foco aterriza en el encabezado de la sección confirmada.
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Asistencia personalizada" })).toHaveFocus(),
    );
  });

  it("no deja el título anterior mientras la ruta nueva no registra metadatos", async () => {
    const user = userEvent.setup();
    renderAdminShell();

    await user.click(screen.getByRole("link", { name: "Ir a una ruta sin registro" }));

    expect(await screen.findByText("Contenido sin shell propio")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Hoy personalizado" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Panel" })).toBeInTheDocument();
  });
});

describe("AdminShellLayout — drawer móvil", () => {
  it("abre con foco sin desplazar, cierra con Escape y devuelve el foco al botón", async () => {
    const user = userEvent.setup();
    const focusSpy = vi.spyOn(HTMLElement.prototype, "focus");
    const { container } = renderAdminShell();

    const menuButton = screen.getByRole("button", { name: "Abrir menú" });
    await user.click(menuButton);

    const sidebar = container.querySelector("#admin-sidebar") as HTMLElement;
    expect(sidebar).toHaveClass("is-open");
    const firstDrawerLink = sidebar.querySelector(".sidebar-brand a") as HTMLElement;
    await waitFor(() => expect(firstDrawerLink).toHaveFocus());
    expect(
      focusSpy.mock.calls.some(
        ([options]) => (options as FocusOptions | undefined)?.preventScroll === true,
      ),
    ).toBe(true);

    await user.keyboard("{Escape}");

    expect(sidebar).not.toHaveClass("is-open");
    await waitFor(() => expect(menuButton).toHaveFocus());
    await waitFor(() => expect(document.body.style.overflow).toBe(""));
    focusSpy.mockRestore();
  });

  it("cierra el drawer al elegir una ruta y preserva el scroll al reabrirlo", async () => {
    const user = userEvent.setup();
    const { container } = renderAdminShell();

    const sidebar = container.querySelector("#admin-sidebar") as HTMLElement;
    const nav = container.querySelector(".sidebar-nav") as HTMLElement;
    let navScrollTop = 184;
    Object.defineProperty(nav, "scrollTop", {
      configurable: true,
      get: () => navScrollTop,
      set: (value: number) => {
        navScrollTop = value;
      },
    });

    await user.click(screen.getByRole("button", { name: "Abrir menú" }));
    expect(sidebar).toHaveClass("is-open");

    await user.click(within(sidebar).getByRole("link", { name: "Asistencia" }));

    expect(await screen.findByText("Contenido de asistencia")).toBeInTheDocument();
    expect(sidebar).not.toHaveClass("is-open");
    expect(document.body.style.overflow).toBe("");
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Asistencia personalizada" })).toHaveFocus(),
    );

    await user.click(screen.getByRole("button", { name: "Abrir menú" }));
    expect(sidebar).toHaveClass("is-open");
    expect(nav.scrollTop).toBe(184);
  });
});
