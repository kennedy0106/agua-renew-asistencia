import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminSessionContext } from "@/components/AdminSession";
import { AdminViewStateProvider } from "@/components/AdminViewState";
import { Notifications } from "@/components/Notifications";
import { ApiError, employeesApi, jobRolesApi, type DniLookup, type Employee, type UserOut } from "@/lib/api";
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function openCreate(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Nuevo empleado" }));
  return screen.findByRole("dialog", { name: /nuevo empleado/i });
}

const createdEmployee: Employee = {
  id: "emp-new",
  dni: "70123456",
  employee_code: "E-70123456",
  first_name: "Ana",
  last_name: "Prueba",
  job_role_id: "",
  job_role_name: null,
  hire_date: null,
  termination_date: null,
  active: true,
  qr_token: "qr-new",
  created_at: "",
  updated_at: "",
};

describe("Admin · empleados: alta en diálogo", () => {
  it("abre el alta como diálogo con foco en el DNI y devuelve el foco al cerrar", async () => {
    const user = userEvent.setup();
    render(page());
    await waitFor(() => expect(employeesApi.list).toHaveBeenCalledTimes(1));

    await openCreate(user);
    expect(screen.getByLabelText(/dni \(8 dígitos\)/i)).toHaveFocus();
    expect(screen.getByRole("button", { name: /consultar dni/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/código interno/i)).toHaveValue("Se asignará automáticamente");

    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: /nuevo empleado/i })).toBeNull(),
    );
    expect(screen.getByRole("button", { name: "Nuevo empleado" })).toHaveFocus();
  });

  it("cancelar con borrador pregunta antes de descartar y un DNI tardío no escribe en el formulario nuevo", async () => {
    const user = userEvent.setup();
    const lookup = deferred<DniLookup>();
    vi.spyOn(employeesApi, "lookupDni").mockReturnValue(lookup.promise);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);

    render(page());
    await waitFor(() => expect(employeesApi.list).toHaveBeenCalledTimes(1));
    await openCreate(user);

    await user.type(screen.getByLabelText(/dni \(8 dígitos\)/i), "70123456");
    await user.click(screen.getByRole("button", { name: /consultar dni/i }));
    await waitFor(() => expect(employeesApi.lookupDni).toHaveBeenCalledWith("70123456"));

    await user.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(confirm).toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: /nuevo empleado/i })).toBeInTheDocument();

    confirm.mockReturnValue(true);
    await user.click(screen.getByRole("button", { name: "Cancelar" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: /nuevo empleado/i })).toBeNull(),
    );

    const reopened = await openCreate(user);
    await user.type(within(reopened).getByLabelText(/dni \(8 dígitos\)/i), "70123456");
    await act(async () =>
      lookup.resolve({
        dni: "70123456",
        first_name: "Ana",
        first_last_name: "Prueba",
        second_last_name: null,
        full_name: "Ana Prueba",
      }),
    );

    expect(within(reopened).getByLabelText(/nombres/i)).toHaveValue("");
    expect(within(reopened).getByLabelText(/apellidos/i)).toHaveValue("");
    expect(within(reopened).getByLabelText(/dni \(8 dígitos\)/i)).toHaveValue("70123456");
    expect(within(reopened).queryByText(/nombres y apellidos completados/i)).toBeNull();
  });

  it("muestra el error de la consulta DNI dentro del diálogo", async () => {
    const user = userEvent.setup();
    vi.spyOn(employeesApi, "lookupDni").mockRejectedValue(new ApiError(404, "DNI no encontrado"));

    render(page());
    await waitFor(() => expect(employeesApi.list).toHaveBeenCalledTimes(1));
    const dialog = await openCreate(user);

    await user.type(within(dialog).getByLabelText(/dni \(8 dígitos\)/i), "70123456");
    await user.click(within(dialog).getByRole("button", { name: /consultar dni/i }));

    await waitFor(() =>
      expect(within(dialog).getByRole("alert")).toHaveTextContent("DNI no encontrado"),
    );
    expect(within(dialog).getByLabelText(/dni \(8 dígitos\)/i)).toHaveValue("70123456");
  });

  it("envía el payload una sola vez y mantiene el diálogo abierto durante el envío", async () => {
    const user = userEvent.setup();
    const pending = deferred<Employee>();
    vi.spyOn(employeesApi, "create").mockReturnValue(pending.promise);

    render(page());
    await waitFor(() => expect(employeesApi.list).toHaveBeenCalledTimes(1));
    const dialog = await openCreate(user);

    await user.type(within(dialog).getByLabelText(/dni \(8 dígitos\)/i), "70123456");
    await user.type(within(dialog).getByLabelText(/nombres/i), "Ana");
    await user.type(within(dialog).getByLabelText(/apellidos/i), "Prueba");
    await user.click(within(dialog).getByRole("button", { name: "Crear empleado" }));
    await waitFor(() => expect(employeesApi.create).toHaveBeenCalledTimes(1));

    expect(employeesApi.create).toHaveBeenCalledWith({
      dni: "70123456",
      first_name: "Ana",
      last_name: "Prueba",
      job_role_id: "",
      hire_date: null,
    });
    expect(within(dialog).getByRole("button", { name: /cerrar creación de empleado/i })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Cancelar" })).toBeDisabled();

    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: /nuevo empleado/i })).toBeInTheDocument();

    await act(async () => pending.resolve(createdEmployee));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: /nuevo empleado/i })).toBeNull(),
    );
    expect(employeesApi.create).toHaveBeenCalledTimes(1);
  });
});
