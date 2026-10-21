import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminSessionContext } from "@/components/AdminSession";
import { AdminViewStateProvider } from "@/components/AdminViewState";
import { Notifications } from "@/components/Notifications";
import { employeesApi, jobRolesApi, type UserOut } from "@/lib/api";
import AdminEmployeesPage from "@/pages/AdminEmployeesPage";
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

function shell(children: ReactNode) {
  return (
    <MemoryRouter initialEntries={["/admin/employees"]}>
      <AdminSessionContext.Provider value={{ user: adminUser, ready: true }}>
        <AdminViewStateProvider>
          <Notifications>{children}</Notifications>
        </AdminViewStateProvider>
      </AdminSessionContext.Provider>
    </MemoryRouter>
  );
}

function page() {
  return shell(<AdminEmployeesPage />);
}

function lastListCall() {
  const calls = vi.mocked(employeesApi.list).mock.calls;
  return calls[calls.length - 1]?.[0];
}

let restorePointerStubs: () => void;

beforeAll(() => {
  restorePointerStubs = installPointerStubs();
});

afterAll(() => {
  restorePointerStubs();
});

beforeEach(() => {
  vi.spyOn(employeesApi, "list").mockResolvedValue([]);
  vi.spyOn(jobRolesApi, "list").mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Admin · empleados: filtros de vista", () => {
  it("restaura búsqueda y estado, y la primera consulta ya lleva el filtro", async () => {
    const user = userEvent.setup();
    const view = render(page());
    await waitFor(() => expect(employeesApi.list).toHaveBeenCalledTimes(1));

    await user.type(screen.getByRole("textbox", { name: /buscar por nombre, dni o código/i }), "ana");
    await user.click(screen.getByRole("combobox", { name: "Estado" }));
    await user.click(await screen.findByRole("option", { name: "Activos" }));

    await waitFor(() =>
      expect(lastListCall()).toEqual({ active: true, search: "ana" }),
    );
    const callsBeforeReturn = vi.mocked(employeesApi.list).mock.calls.length;

    // Salir y volver sin desmontar el provider del shell.
    view.rerender(shell(<div>otra pantalla</div>));
    view.rerender(page());

    expect(await screen.findByRole("textbox", { name: /buscar por nombre, dni o código/i })).toHaveValue("ana");
    expect(screen.getByRole("combobox", { name: "Estado" })).toHaveTextContent("Activos");

    // La carga inicial del regreso usa búsqueda y estado recuperados; no hace
    // una primera consulta sin filtro.
    await waitFor(() =>
      expect(employeesApi.list).toHaveBeenCalledTimes(callsBeforeReturn + 1),
    );
    expect(lastListCall()).toEqual({ active: true, search: "ana" });
  });
});
