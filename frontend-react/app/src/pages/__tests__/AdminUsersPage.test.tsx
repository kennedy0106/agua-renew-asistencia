import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminSessionContext } from "@/components/AdminSession";
import { AdminViewStateProvider } from "@/components/AdminViewState";
import { Notifications } from "@/components/Notifications";
import { employeesApi, systemRolesApi, usersApi, type SystemRole, type UserOut } from "@/lib/api";
import AdminUsersPage from "@/pages/AdminUsersPage";
import { installPointerStubs } from "@/test/pointerStubs";

const adminUser: UserOut = {
  id: "user-admin",
  username: "admin",
  role: "ADMIN",
  active: true,
  must_change_password: false,
  last_login_at: null,
  created_at: "",
};

const roles: SystemRole[] = [
  { id: "role-admin", name: "Administrador", description: null },
  { id: "role-boss", name: "Jefe", description: null },
];

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/admin/users"]}>
      <AdminSessionContext.Provider value={{ user: adminUser, ready: true }}>
        <AdminViewStateProvider>
          <Notifications>
            <AdminUsersPage />
          </Notifications>
        </AdminViewStateProvider>
      </AdminSessionContext.Provider>
    </MemoryRouter>,
  );
}

let restorePointerStubs: () => void;

beforeAll(() => {
  restorePointerStubs = installPointerStubs();
});

afterAll(() => {
  restorePointerStubs();
});

beforeEach(() => {
  vi.spyOn(usersApi, "list").mockResolvedValue([]);
  vi.spyOn(systemRolesApi, "list").mockResolvedValue(roles);
  vi.spyOn(employeesApi, "list").mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function expectSingleInitialLoad() {
  await waitFor(() => {
    expect(usersApi.list).toHaveBeenCalledTimes(1);
    expect(systemRolesApi.list).toHaveBeenCalledTimes(1);
    expect(employeesApi.list).toHaveBeenCalledTimes(1);
  });
}

describe("Admin · usuarios: carga de listados y formulario", () => {
  it("una entrada pide usuarios, roles y empleados una sola vez", async () => {
    renderPage();

    await expectSingleInitialLoad();
    expect(await screen.findByText(/0 de 0 usuarios/)).toBeInTheDocument();
  });

  it("inicializa el rol del formulario y cambiarlo no repite listados", async () => {
    const user = userEvent.setup();
    renderPage();
    await expectSingleInitialLoad();

    await user.click(screen.getByRole("button", { name: "Nuevo usuario" }));
    const dialog = await screen.findByRole("dialog", { name: /crear acceso de sistema/i });

    // El primer rol válido quedó preseleccionado tras la carga inicial.
    const roleSelect = screen.getByRole("combobox", { name: "Rol del sistema" });
    expect(roleSelect).toHaveTextContent("Administrador");

    await user.click(roleSelect);
    await user.click(await screen.findByRole("option", { name: "Jefe" }));

    expect(roleSelect).toHaveTextContent("Jefe");
    // Cambiar el rol del borrador no dispara ninguna consulta adicional.
    expect(usersApi.list).toHaveBeenCalledTimes(1);
    expect(systemRolesApi.list).toHaveBeenCalledTimes(1);
    expect(employeesApi.list).toHaveBeenCalledTimes(1);
    expect(dialog).toBeVisible();
  });
});
