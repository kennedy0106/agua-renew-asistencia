import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import AdminShell from "@/components/AdminShell";
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

function renderShell() {
  return render(
    <MemoryRouter initialEntries={["/admin/dashboard"]}>
      <AdminSessionContext.Provider value={{ user: USER, ready: true }}>
        <AdminShell title="Hoy">Contenido de la página</AdminShell>
      </AdminSessionContext.Provider>
    </MemoryRouter>,
  );
}

describe("AdminShell — indicador de navegación", () => {
  it("elimina la barra superior tipo navegador", () => {
    const { container } = renderShell();

    expect(container.querySelector(".topbar-progress")).toBeNull();
  });

  it("mantiene un indicador circular accesible dentro de la interfaz", () => {
    const { container } = renderShell();

    const indicator = container.querySelector(".route-loading");
    expect(indicator).not.toBeNull();
    expect(indicator).toHaveAttribute("role", "status");
    expect(indicator).toHaveAttribute("aria-busy", "false");
    expect(screen.getByText("Contenido de la página")).toBeInTheDocument();
  });
});
