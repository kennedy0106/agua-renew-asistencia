import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminSessionContext } from "@/components/AdminSession";
import { AdminViewStateProvider } from "@/components/AdminViewState";
import { Notifications } from "@/components/Notifications";
import { jobRolesApi, type JobRole, type UserOut } from "@/lib/api";
import AdminRolesPage from "@/pages/AdminRolesPage";

const adminUser: UserOut = {
  id: "user-admin",
  username: "admin",
  role: "ADMIN",
  active: true,
  must_change_password: false,
  last_login_at: null,
  created_at: "",
};

const createdRole: JobRole = {
  id: "role-new",
  name: "Operario de envasado",
  description: "Planta de llenado",
  active: true,
  created_at: "2026-10-20T00:00:00Z",
  updated_at: "2026-10-20T00:00:00Z",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function nameInput() {
  return screen.getByLabelText(/nuevo cargo laboral/i);
}

function descriptionInput() {
  return screen.getByLabelText(/descripción del puesto/i);
}

async function leaveAndReturn(view: ReturnType<typeof render>) {
  const callsBeforeReturn = vi.mocked(jobRolesApi.list).mock.calls.length;
  view.rerender(shell(<div>otra pantalla</div>));
  view.rerender(page());
  await waitFor(() =>
    expect(jobRolesApi.list).toHaveBeenCalledTimes(callsBeforeReturn + 1),
  );
}

async function startDelayedCreate() {
  const pending = deferred<JobRole>();
  vi.mocked(jobRolesApi.create).mockReturnValue(pending.promise);
  await userEvent.setup().click(screen.getByRole("button", { name: "Crear cargo" }));
  await waitFor(() => expect(jobRolesApi.create).toHaveBeenCalledTimes(1));
  return pending;
}

// El provider de estado de vista queda en la misma posición entre rerenders
// para simular que el shell no se desmonta al navegar.
function shell(children: ReactNode) {
  return (
    <MemoryRouter initialEntries={["/admin/roles"]}>
      <AdminSessionContext.Provider value={{ user: adminUser, ready: true }}>
        <AdminViewStateProvider>
          <Notifications>{children}</Notifications>
        </AdminViewStateProvider>
      </AdminSessionContext.Provider>
    </MemoryRouter>
  );
}

function page() {
  return shell(<AdminRolesPage />);
}

beforeEach(() => {
  vi.spyOn(jobRolesApi, "list").mockResolvedValue([]);
  vi.spyOn(jobRolesApi, "create").mockResolvedValue(createdRole);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Admin · cargos: borrador del alta", () => {
  it("conserva nombre y descripción al salir y volver dentro de la sesión", async () => {
    const user = userEvent.setup();
    const view = render(page());
    await waitFor(() => expect(jobRolesApi.list).toHaveBeenCalledTimes(1));

    await user.type(screen.getByLabelText(/nuevo cargo laboral/i), "Operario de envasado");
    await user.type(screen.getByLabelText(/descripción del puesto/i), "Planta de llenado");

    // Simula abandonar la pantalla y regresar conservando el provider del shell.
    view.rerender(shell(<div>otra pantalla</div>));
    expect(screen.queryByLabelText(/nuevo cargo laboral/i)).toBeNull();

    view.rerender(page());
    await waitFor(() => expect(jobRolesApi.list).toHaveBeenCalledTimes(2));

    expect(screen.getByLabelText(/nuevo cargo laboral/i)).toHaveValue("Operario de envasado");
    expect(screen.getByLabelText(/descripción del puesto/i)).toHaveValue("Planta de llenado");
  });

  it("limpia el borrador solo después de un alta exitosa", async () => {
    const user = userEvent.setup();
    render(page());
    await waitFor(() => expect(jobRolesApi.list).toHaveBeenCalledTimes(1));

    await user.type(screen.getByLabelText(/nuevo cargo laboral/i), "Operario de envasado");
    await user.type(screen.getByLabelText(/descripción del puesto/i), "Planta de llenado");
    await user.click(screen.getByRole("button", { name: "Crear cargo" }));

    await waitFor(() => expect(jobRolesApi.create).toHaveBeenCalledWith(
      "Operario de envasado",
      "Planta de llenado",
    ));
    expect(screen.getByLabelText(/nuevo cargo laboral/i)).toHaveValue("");
    expect(screen.getByLabelText(/descripción del puesto/i)).toHaveValue("");
  });

  it("un éxito tardío no borra el borrador nuevo escrito tras salir y volver", async () => {
    const user = userEvent.setup();
    const view = render(page());
    await waitFor(() => expect(jobRolesApi.list).toHaveBeenCalledTimes(1));

    await user.type(nameInput(), "Primer cargo");
    const pending = await startDelayedCreate();
    await leaveAndReturn(view);

    await user.clear(nameInput());
    await user.type(nameInput(), "Segundo cargo");
    await user.clear(descriptionInput());
    await user.type(descriptionInput(), "Descripción nueva");

    await act(async () => pending.resolve(createdRole));

    await waitFor(() => expect(nameInput()).toHaveValue("Segundo cargo"));
    expect(descriptionInput()).toHaveValue("Descripción nueva");
  });

  it("editar solo la descripción tras volver conserva nombre y descripción nuevos", async () => {
    const user = userEvent.setup();
    const view = render(page());
    await waitFor(() => expect(jobRolesApi.list).toHaveBeenCalledTimes(1));

    await user.type(nameInput(), "Primer cargo");
    await user.type(descriptionInput(), "Descripción original");
    const pending = await startDelayedCreate();
    await leaveAndReturn(view);

    await user.clear(descriptionInput());
    await user.type(descriptionInput(), "Descripción nueva");

    await act(async () => pending.resolve(createdRole));

    await waitFor(() => expect(descriptionInput()).toHaveValue("Descripción nueva"));
    expect(nameInput()).toHaveValue("Primer cargo");
  });

  it("un éxito sin ediciones tras navegar limpia el borrador enviado", async () => {
    const user = userEvent.setup();
    const view = render(page());
    await waitFor(() => expect(jobRolesApi.list).toHaveBeenCalledTimes(1));

    await user.type(nameInput(), "Primer cargo");
    await user.type(descriptionInput(), "Descripción original");
    const pending = await startDelayedCreate();
    await leaveAndReturn(view);
    expect(nameInput()).toHaveValue("Primer cargo");

    await act(async () => pending.resolve(createdRole));

    await waitFor(() => expect(nameInput()).toHaveValue(""));
    expect(descriptionInput()).toHaveValue("");
  });

  it("un error conserva el borrador sin cambios", async () => {
    const user = userEvent.setup();
    const pending = deferred<JobRole>();
    vi.mocked(jobRolesApi.create).mockReturnValue(pending.promise);
    render(page());
    await waitFor(() => expect(jobRolesApi.list).toHaveBeenCalledTimes(1));

    await user.type(nameInput(), "Primer cargo");
    await user.type(descriptionInput(), "Descripción original");
    await user.click(screen.getByRole("button", { name: "Crear cargo" }));
    await waitFor(() => expect(jobRolesApi.create).toHaveBeenCalledTimes(1));

    await act(async () => pending.reject(new Error("falló el alta")));

    await waitFor(() => expect(nameInput()).toHaveValue("Primer cargo"));
    expect(descriptionInput()).toHaveValue("Descripción original");
  });
});
