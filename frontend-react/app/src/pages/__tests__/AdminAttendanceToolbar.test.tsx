import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AdminSessionContext } from "@/components/AdminSession";
import { Notifications } from "@/components/Notifications";
import {
  attendanceAdminApi,
  employeesApi,
  type AttendanceDailyItem,
  type AttendanceListItem,
  type Employee,
  type UserOut,
} from "@/lib/api";
import AdminAttendancePage from "@/pages/AdminAttendancePage";

/**
 * Barra superior de asistencia (filtros, ayuda y acciones de gestión).
 *
 * Cubre solo la parte de arriba de la página: agrupación de filtros, ayuda de
 * columnas bajo demanda, editor de período, exportación CSV y acciones de
 * gestión (histórico y recuperación de tablet). La tabla, la evidencia y los
 * diálogos de corrección no se tocan aquí; su comportamiento ya está cubierto
 * por AdminAttendancePage.test.tsx.
 *
 * Todas las aserciones se hacen sobre la interfaz pública (roles accesibles y
 * URLs HTTP observadas), nunca sobre estado interno ni nombres de clase.
 */

const adminUser: UserOut = {
  id: "user-admin",
  username: "admin",
  role: "ADMIN",
  active: true,
  must_change_password: false,
  last_login_at: null,
  created_at: "",
};

const supervisorUser: UserOut = {
  id: "user-supervisor",
  username: "supervisor",
  role: "SUPERVISOR",
  active: true,
  must_change_password: false,
  last_login_at: null,
  created_at: "",
};

const employee: Employee = {
  id: "emp-1",
  dni: "71112233",
  employee_code: "E2E-71112233",
  first_name: "Ana",
  last_name: "Prueba",
  job_role_id: "role-1",
  job_role_name: "Operario",
  hire_date: null,
  termination_date: null,
  active: true,
  qr_token: "qr-1",
  created_at: "",
  updated_at: "",
};

const record: AttendanceListItem = {
  id: "rec-1",
  employee_id: "emp-1",
  employee_name: "Ana Prueba",
  job_role_name: "Operario",
  work_date: "2026-10-16",
  check_in_at: "2026-10-16T17:00:05+00:00",
  check_out_at: null,
  worked_minutes: null,
  expected_minutes: 480,
  difference_minutes: null,
  status: "OPEN",
  notes: null,
};

const daily: AttendanceDailyItem = {
  employee_id: "emp-1",
  employee_name: "Ana Prueba",
  work_date: "2026-10-16",
  session_count: 1,
  gross_minutes: 0,
  break_minutes: 0,
  break_source: "SCHEDULE",
  override_requested_minutes: null,
  override_limited: false,
  worked_minutes: 0,
  expected_minutes: 480,
  difference_minutes: -480,
  has_open_entry: true,
  incident_codes: [],
};

const EXPORT_PATH = "/api/v1/exports/attendance.csv";

/** Rango del mes operativo actual en America/Lima, derivado igual que el negocio. */
function limaMonthRange(): { from: string; to: string } {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Lima",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const [year, month] = today.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    from: `${year}-${String(month).padStart(2, "0")}-01`,
    to: `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`,
  };
}

/**
 * jsdom no implementa captura de puntero ni scrollIntoView, que el Select de
 * Radix usa al abrir el menú. Se limitan a este archivo.
 */
const pointerStubs = () => {
  const element = Element.prototype as unknown as Record<string, unknown>;
  const saved = {
    hasPointerCapture: element.hasPointerCapture,
    setPointerCapture: element.setPointerCapture,
    releasePointerCapture: element.releasePointerCapture,
    scrollIntoView: element.scrollIntoView,
  };
  element.hasPointerCapture = () => false;
  element.setPointerCapture = () => {};
  element.releasePointerCapture = () => {};
  element.scrollIntoView = () => {};
  return saved;
};

let savedPointerImpls: ReturnType<typeof pointerStubs>;

beforeAll(() => {
  savedPointerImpls = pointerStubs();
});

afterAll(() => {
  Object.assign(Element.prototype, savedPointerImpls);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Sustituye las APIs que la página consulta al montar y expone las llamadas. */
function stubApis() {
  const listSpy = vi.spyOn(attendanceAdminApi, "list").mockResolvedValue([record]);
  vi.spyOn(attendanceAdminApi, "daily").mockResolvedValue([daily]);
  vi.spyOn(employeesApi, "list").mockResolvedValue([employee]);
  return {
    listParams: () => {
      const calls = listSpy.mock.calls;
      return calls[calls.length - 1]?.[0];
    },
    listCallCount: () => listSpy.mock.calls.length,
  };
}

async function renderToolbar(user: UserOut = adminUser) {
  render(
    <MemoryRouter initialEntries={["/admin/attendance"]}>
      <AdminSessionContext.Provider value={{ user, ready: true }}>
        <Notifications>
          <AdminAttendancePage />
        </Notifications>
      </AdminSessionContext.Provider>
    </MemoryRouter>,
  );
  // Señal estable de datos cargados: la tabla ya muestra al empleado.
  await screen.findAllByText("Ana Prueba");
}

async function selectOption(
  user: ReturnType<typeof userEvent.setup>,
  filterName: RegExp,
  optionName: RegExp,
) {
  await user.click(screen.getByRole("combobox", { name: filterName }));
  await user.click(await screen.findByRole("option", { name: optionName }));
}

function expectHiddenOrAbsent(element: HTMLElement | null) {
  if (element) expect(element).not.toBeVisible();
}

function openedUrl(openSpy: { mock: { calls: unknown[][] } }): URL {
  return new URL(String(openSpy.mock.calls[0]?.[0]), "http://localhost:3000");
}

describe("Admin — barra superior de asistencia", () => {
  it("agrupa los filtros bajo un encabezado Filtros con Ayuda, Exportar CSV y Más acciones", async () => {
    stubApis();
    await renderToolbar();

    expect(screen.getByText(/^filtros$/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^ayuda/i })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: /^exportar csv/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^m[áa]s acciones/i })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("combobox", { name: /^empleado/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /per[íi]odo/i })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /^estado/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^limpiar/i })).toBeInTheDocument();
  });

  it("Ayuda revela las definiciones de columnas solo cuando se piden", async () => {
    const user = userEvent.setup();
    stubApis();
    await renderToolbar();

    expectHiddenOrAbsent(screen.queryByText(/desde la primera entrada hasta la última salida/i));

    await user.click(screen.getByRole("button", { name: /^ayuda/i }));

    expect(screen.getByRole("button", { name: /^ayuda/i })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(/desde la primera entrada hasta la última salida/i)).toBeVisible();
    expect(screen.getByText(/tiempo presente menos el refrigerio/i)).toBeVisible();
    expect(screen.getByText(/lo que la persona debía trabajar ese día/i)).toBeVisible();
    expect(screen.getByText(/tiempo efectivo menos jornada esperada/i)).toBeVisible();
    expect(screen.getByText(/situaciones a revisar, como entrada tardía/i)).toBeVisible();
  });

  it("el período muestra el rango actual y revela Desde/Hasta solo al abrirlo, sin botón Aplicar", async () => {
    const user = userEvent.setup();
    const api = stubApis();
    await renderToolbar();
    const { from, to } = limaMonthRange();

    expectHiddenOrAbsent(screen.queryByRole("button", { name: "Fecha desde" }));
    expectHiddenOrAbsent(screen.queryByRole("button", { name: "Fecha hasta" }));

    const trigger = screen.getByRole("button", { name: /per[íi]odo/i });
    const summary = (trigger.textContent ?? "").trim();
    expect(summary).not.toBe("");
    // The range stays recognizable without prescribing a date format or DOM structure.
    expect((summary.match(/\d+/g) ?? []).length).toBeGreaterThanOrEqual(2);

    const callsBeforeOpening = api.listCallCount();
    await user.click(trigger);

    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "Fecha desde" })).toHaveTextContent(from.slice(8));
    expect(screen.getByRole("button", { name: "Fecha hasta" })).toHaveTextContent(to.slice(8));
    // Abrir el editor no filtra: no hay confirmación manual ni nueva consulta.
    expect(screen.queryByRole("button", { name: /aplicar/i })).toBeNull();
    expect(api.listCallCount()).toBe(callsBeforeOpening);
  });

  it("cerrar el calendario con Escape no cierra el editor de período", async () => {
    const user = userEvent.setup();
    stubApis();
    await renderToolbar();

    const trigger = screen.getByRole("button", { name: /per[íi]odo/i });
    await user.click(trigger);
    await user.click(screen.getByRole("button", { name: "Fecha desde" }));
    await screen.findByRole("dialog", { name: "Calendario: Fecha desde" });

    // Escape se pulsa donde está el foco, como lo haría una persona.
    await user.keyboard("{Escape}");

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Calendario: Fecha desde" })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "Fecha desde" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Fecha hasta" })).toBeVisible();
    expect(trigger).toHaveAttribute("aria-expanded", "true");
  });

  it("Más acciones revela el histórico y la recuperación de tablet para ADMIN, con Escape que devuelve el foco", async () => {
    const user = userEvent.setup();
    stubApis();
    const reviewSpy = vi.spyOn(attendanceAdminApi, "reviewAttempt").mockResolvedValue(undefined);
    vi.spyOn(attendanceAdminApi, "inspectAttempt").mockResolvedValue({
      nonce: "A1B2C3",
      employee_id: "emp-1",
      employee_name: "Ana Prueba",
      action: "CHECK_IN",
      device_id: null,
      device_name: null,
      state: "CONFIRMED",
      automatable: true,
      record: null,
      evidence_ready: false,
      resolution: null,
    });
    await renderToolbar();

    expectHiddenOrAbsent(screen.queryByRole("link", { name: /horas anteriores/i }));
    expectHiddenOrAbsent(screen.queryByText(/recuperar un intento de la tablet/i));

    const moreTrigger = screen.getByRole("button", { name: /^m[áa]s acciones/i });
    await user.click(moreTrigger);

    expect(moreTrigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("link", { name: /horas anteriores/i })).toHaveAttribute(
      "href",
      "/admin/attendance/history",
    );
    expect(screen.getByRole("button", { name: /recuperar un intento de la tablet/i })).toBeVisible();
    expectHiddenOrAbsent(screen.queryByLabelText(/c[óo]digo de incidente de la tablet/i));

    await user.keyboard("{Escape}");
    await waitFor(() => expectHiddenOrAbsent(screen.queryByRole("link", { name: /horas anteriores/i })));
    expect(moreTrigger).toHaveAttribute("aria-expanded", "false");
    expect(moreTrigger).toHaveFocus();

    await user.click(moreTrigger);
    await user.click(screen.getByRole("button", { name: /recuperar un intento de la tablet/i }));

    const nonce = screen.getByLabelText(/c[óo]digo de incidente de la tablet/i);
    const reason = screen.getByLabelText(/^motivo/i);
    expect(reason).toHaveAttribute("minlength", "3");
    expect(reason).toHaveAttribute("maxlength", "500");

    const submit = screen.getByRole("button", { name: /revisar y habilitar tablet/i });
    expect(submit).toBeDisabled();
    await user.type(nonce, "A1B2C3");
    await user.type(reason, "ab");
    expect(submit).toBeDisabled();
    await user.type(reason, "c");
    expect(submit).toBeEnabled();

    await user.click(submit);
    await waitFor(() => expect(reviewSpy).toHaveBeenCalledWith("A1B2C3", "abc"));
  });

  it("BOSS conserva las acciones de gestión", async () => {
    const user = userEvent.setup();
    stubApis();
    await renderToolbar({ ...adminUser, id: "user-boss", username: "jefe", role: "BOSS" });

    await user.click(screen.getByRole("button", { name: /^m[áa]s acciones/i }));

    expect(screen.getByRole("link", { name: /horas anteriores/i })).toHaveAttribute(
      "href",
      "/admin/attendance/history",
    );
    await user.click(screen.getByRole("button", { name: /recuperar un intento de la tablet/i }));
    expect(screen.getByLabelText(/^motivo/i)).toBeVisible();
  });

  it("SUPERVISOR conserva los filtros pero no ve acciones de gestión", async () => {
    stubApis();
    await renderToolbar(supervisorUser);

    expect(screen.getByText(/^filtros$/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^exportar csv/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^m[áa]s acciones/i })).toBeNull();
    expect(screen.queryByRole("link", { name: /horas anteriores/i })).toBeNull();
    expect(screen.queryByText(/recuperar un intento de la tablet/i)).toBeNull();
    expect(screen.queryByLabelText(/c[óo]digo de incidente de la tablet/i)).toBeNull();
  });

  it("Exportar CSV conserva el endpoint y aplica el empleado, las fechas y el estado actuales", async () => {
    const user = userEvent.setup();
    const api = stubApis();
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    await renderToolbar();
    const { from, to } = limaMonthRange();

    await selectOption(user, /^empleado/i, /ana prueba/i);
    await waitFor(() => expect(api.listParams()).toMatchObject({ employee_id: "emp-1" }));
    await selectOption(user, /^estado/i, /sin salida registrada/i);
    await waitFor(() => expect(api.listParams()).toMatchObject({ status: "OPEN" }));

    const exportButton = screen.getByRole("button", { name: /^exportar csv/i });
    await user.click(exportButton);

    expect(openSpy).toHaveBeenCalledTimes(1);
    const url = openedUrl(openSpy);
    expect(url.pathname).toBe(EXPORT_PATH);
    expect(url.searchParams.get("employee_id")).toBe("emp-1");
    expect(url.searchParams.get("date_from")).toBe(from);
    expect(url.searchParams.get("date_to")).toBe(to);
    expect(url.searchParams.get("status")).toBe("OPEN");
    expect(Array.from(url.searchParams.keys()).sort()).toEqual([
      "date_from",
      "date_to",
      "employee_id",
      "status",
    ]);

    // El CSV se abre en Excel; la ayuda tiene que decirlo.
    const help =
      exportButton.getAttribute("title") ?? exportButton.getAttribute("aria-description") ?? "";
    expect(help).toMatch(/excel|hoja de c[aá]lculo/i);
  });

  it("Limpiar vacía empleado, estado y fechas, y la exportación vuelve a pedir sin parámetros", async () => {
    const user = userEvent.setup();
    const api = stubApis();
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    await renderToolbar();

    await selectOption(user, /^empleado/i, /ana prueba/i);
    await waitFor(() => expect(api.listParams()).toMatchObject({ employee_id: "emp-1" }));
    await selectOption(user, /^estado/i, /sin salida registrada/i);
    await waitFor(() => expect(api.listParams()).toMatchObject({ status: "OPEN" }));

    await user.click(screen.getByRole("button", { name: /^limpiar/i }));

    await waitFor(() => expect(api.listParams()).toEqual({}));

    await user.click(screen.getByRole("button", { name: /^exportar csv/i }));
    const url = openedUrl(openSpy);
    expect(url.pathname).toBe(EXPORT_PATH);
    expect(url.search).toBe("");
  });

  it("Limpiar deja las fechas vacías en lugar de volver al mes actual", async () => {
    const user = userEvent.setup();
    const api = stubApis();
    await renderToolbar();
    const { from } = limaMonthRange();

    const trigger = screen.getByRole("button", { name: /per[íi]odo/i });
    await user.click(trigger);
    expect(screen.getByRole("button", { name: "Fecha desde" })).toHaveTextContent(from.slice(8));
    // Se cierra con el mismo disparador antes de limpiar, sin depender de
    // ninguna forma de descarte por clic externo.
    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    await user.click(screen.getByRole("button", { name: /^limpiar/i }));

    await waitFor(() => expect(api.listParams()).toEqual({}));

    await user.click(trigger);
    expect(screen.getByRole("button", { name: "Fecha desde" })).toHaveTextContent(/^desde$/i);
    expect(screen.getByRole("button", { name: "Fecha hasta" })).toHaveTextContent(/^hasta$/i);
    // El rango vacío no se rellena solo con el mes en curso.
    expect((trigger.textContent ?? "").trim()).not.toContain(from.slice(0, 4));
  });

  it("conserva la carga inicial con el mes actual de Lima", async () => {
    const api = stubApis();
    await renderToolbar();
    const { from, to } = limaMonthRange();

    expect(api.listParams()).toMatchObject({ date_from: from, date_to: to });
  });
});
