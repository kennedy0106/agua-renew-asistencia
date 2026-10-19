import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
 * Presentación de las dos tablas de asistencia (resumen diario y detalle de
 * marcaciones).
 *
 * Contrato fijado aquí, siempre sobre la interfaz pública (roles accesibles,
 * textos y URLs), nunca sobre estado interno, nombres de clase ni el origen de
 * los datos:
 *
 * - Dos vistas con columnas base acotadas; los campos secundarios siguen
 *   accesibles mediante un desglose en línea asociado, también para
 *   SUPERVISOR (la información de solo lectura no vive detrás del permiso de
 *   gestión).
 * - Duraciones y saldos en formato h:mm; el saldo -299 min se lee "-04:59" y
 *   nunca "-5 h -59". El saldo pendiente (null) conserva "—".
 * - La salida muestra su fecha cuando el día calendaro de Lima cambia respecto
 *   a la entrada; el estado cerrado se rotula "Cerrada".
 * - Las acciones conservan SVG, etiquetas visibles y los nombres accesibles
 *   descriptivos que ya usaban las pruebas anteriores, con los mismos
 *   diálogos y callbacks.
 *
 * jsdom no aplica CSS (css:false), así que las tarjetas responsivas duplican
 * el contenido de la tabla: todas las consultas se acotan a la tabla real.
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
  ...adminUser,
  id: "user-supervisor",
  username: "supervisor",
  role: "SUPERVISOR",
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

const dailyTemplate: AttendanceDailyItem = {
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
  difference_minutes: 0,
  has_open_entry: false,
  incident_codes: [],
};

const recordTemplate: AttendanceListItem = {
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

const makeDaily = (overrides: Partial<AttendanceDailyItem>): AttendanceDailyItem => ({
  ...dailyTemplate,
  ...overrides,
});

const makeRecord = (overrides: Partial<AttendanceListItem>): AttendanceListItem => ({
  ...recordTemplate,
  ...overrides,
});

const norm = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();

/** Tabla cuya cabecera incluye la columna indicada (única por vista). */
function tableWith(header: RegExp): HTMLElement {
  const matches = screen
    .getAllByRole("table")
    .filter((table) =>
      within(table)
        .queryAllByRole("columnheader")
        .some((cell) => header.test(norm(cell.textContent))),
    );
  if (matches.length !== 1) {
    throw new Error(`Se esperaba una sola tabla con la cabecera ${header}, se encontraron ${matches.length}`);
  }
  return matches[0];
}

const dailyTable = () => tableWith(/^incidencias$/i);
const recordsTable = () => tableWith(/^salida$/i);

function headersOf(table: HTMLElement): string[] {
  return within(table)
    .getAllByRole("columnheader")
    .map((cell) => norm(cell.textContent));
}

/** Fila de la persona indicada dentro de la tabla (no de las tarjetas). */
function rowFor(table: HTMLElement, name: string | RegExp): HTMLElement {
  const pattern = typeof name === "string" ? new RegExp(name, "i") : name;
  const rows = within(table)
    .getAllByRole("row")
    .filter((row) => pattern.test(norm(row.textContent)));
  if (rows.length === 0) throw new Error(`No hay fila para ${String(name)} en la tabla`);
  return rows[0];
}

function cellTexts(container: HTMLElement): string[] {
  return within(container)
    .getAllByRole("cell")
    .map((cell) => norm(cell.textContent));
}

function expectAnyCell(container: HTMLElement, pattern: RegExp) {
  const texts = cellTexts(container);
  expect(
    texts.some((text) => pattern.test(text)) || within(container).queryAllByText(pattern).length > 0,
    `Ningún valor de "${norm(container.textContent)}" cumple ${pattern}`,
  ).toBe(true);
}

/** Admite un desglose de fila o de sección, con asociación accesible. */
function disclosureTrigger(row: HTMLElement): HTMLElement | null {
  const section = row.closest("section") ?? row;
  const candidates = [
    ...within(row).queryAllByRole("button"),
    ...within(section).queryAllByRole("button"),
  ];
  const expanded = candidates.find((button) =>
    button.hasAttribute("aria-expanded") &&
    (row.contains(button) || /desglose|detalle|ver día|jornada y saldo/i.test(
      `${button.getAttribute("aria-label") ?? ""} ${norm(button.textContent)}`,
    )),
  );
  return expanded ?? row.querySelector<HTMLElement>("summary") ?? section.querySelector<HTMLElement>("summary");
}

/** Acepta contenido en la fila, un panel controlado o una fila de detalle. */
async function revealedDetails(
  user: ReturnType<typeof userEvent.setup>,
  table: HTMLElement,
  name: string,
): Promise<HTMLElement> {
  let row = rowFor(table, name);
  const trigger = disclosureTrigger(row);
  if (!trigger) throw new Error("No se ofrece un desglose accesible de la información secundaria");
  expect(norm(trigger.textContent)).not.toBe("");
  const nativeDetails = trigger.closest("details");
  if (trigger.getAttribute("aria-expanded") !== "true" && !nativeDetails?.open) await user.click(trigger);
  row = rowFor(table, name);
  const controlledId = trigger.getAttribute("aria-controls");
  const controlled = controlledId ? document.getElementById(controlledId) : null;
  if (controlled && !controlled.contains(row)) return controlled;
  if (nativeDetails) return nativeDetails;
  const next = row.nextElementSibling;
  if (next instanceof HTMLElement && next.querySelector("td[colspan]")) return next;
  return row;
}

/** La edición puede estar en la fila principal o dentro del desglose. */
async function breakActionFor(
  user: ReturnType<typeof userEvent.setup>,
  table: HTMLElement,
  name: string,
): Promise<HTMLElement> {
  const find = (scope: HTMLElement) => within(scope)
    .queryAllByRole("button", { name: /refrigerio/i })
    .find((button) => !button.hasAttribute("aria-expanded"));
  const existing = find(rowFor(table, name));
  if (existing) return existing;
  const details = await revealedDetails(user, table, name);
  const action = find(details);
  if (!action) throw new Error(`Falta la acción de refrigerio para ${name}`);
  return action;
}

/** Texto de ayuda accesible: aria-describedby, aria-description o title. */
function describedText(element: HTMLElement): string {
  const ids = (element.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean);
  const referenced = ids
    .map((id) => norm(element.ownerDocument.getElementById(id)?.textContent))
    .join(" ");
  return [element.getAttribute("aria-description"), element.getAttribute("title"), referenced]
    .filter(Boolean)
    .join(" ");
}

function renderPage(user: UserOut = adminUser) {
  return render(
    <MemoryRouter initialEntries={["/admin/attendance"]}>
      <AdminSessionContext.Provider value={{ user, ready: true }}>
        <Notifications>
          <AdminAttendancePage />
        </Notifications>
      </AdminSessionContext.Provider>
    </MemoryRouter>,
  );
}

async function renderLoaded(user: UserOut = adminUser, readyText = "Ana Prueba") {
  const view = renderPage(user);
  await screen.findAllByText(readyText);
  return view;
}

beforeEach(() => {
  vi.spyOn(attendanceAdminApi, "list").mockResolvedValue([makeRecord({})]);
  vi.spyOn(attendanceAdminApi, "daily").mockResolvedValue([makeDaily({})]);
  vi.spyOn(employeesApi, "list").mockResolvedValue([employee]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Admin — tablas de asistencia", () => {
  it("el resumen diario muestra solo las columnas base y mantiene las duraciones en h:mm", async () => {
    vi.mocked(attendanceAdminApi.daily).mockResolvedValue([
      makeDaily({ gross_minutes: 500, break_minutes: 45, worked_minutes: 455, expected_minutes: 480 }),
    ]);

    await renderLoaded();

    expect(headersOf(dailyTable())).toEqual([
      "Empleado",
      "Fecha",
      "Efectivo",
      "Esperado",
      "Saldo",
      "Incidencias",
      "Acciones",
    ]);

    const row = rowFor(dailyTable(), "Ana Prueba");
    expectAnyCell(row, /^0?7:35$/); // efectivo (455 min trabajados)
    expectAnyCell(row, /^0?8:00$/); // jornada esperada (480 min)
  });

  it("el detalle de marcaciones muestra solo las columnas base", async () => {
    await renderLoaded();

    expect(headersOf(recordsTable())).toEqual([
      "Empleado",
      "Fecha",
      "Entrada",
      "Salida",
      "Trabajado",
      "Estado",
      "Acciones",
    ]);
  });

  it("el resumen diario expone sesiones, presencia, refrigerio y su origen en un desglose en línea", async () => {
    const user = userEvent.setup();
    vi.mocked(attendanceAdminApi.daily).mockResolvedValue([
      makeDaily({
        employee_name: "Ana Prueba",
        session_count: 3,
        gross_minutes: 500,
        break_minutes: 45,
        break_source: "OVERRIDE",
        override_requested_minutes: 60,
        override_limited: true,
        worked_minutes: 455,
      }),
      makeDaily({
        employee_name: "Beto Muestra",
        employee_id: "emp-2",
        work_date: "2026-10-17",
        session_count: 1,
        gross_minutes: 480,
        break_minutes: 60,
        break_source: "SCHEDULE",
        worked_minutes: 420,
      }),
    ]);
    vi.mocked(attendanceAdminApi.list).mockResolvedValue([makeRecord({})]);

    await renderLoaded();

    const overriddenDetails = await revealedDetails(user, dailyTable(), "Ana Prueba");
    expect(overriddenDetails).toHaveTextContent(/sesion/i);
    expect(overriddenDetails).toHaveTextContent(/presencia|tiempo presente/i);
    expect(overriddenDetails).toHaveTextContent(/refrigerio/i);
    expect(overriddenDetails).toHaveTextContent(/0?8:20/); // presencia
    expect(overriddenDetails).toHaveTextContent(/0?0:45/); // refrigerio aplicado
    expect(overriddenDetails).toHaveTextContent(/limitado/i);
    expect(overriddenDetails).toHaveTextContent(/real|ajustad|manual/i); // origen del refrigerio

    const scheduled = await revealedDetails(user, dailyTable(), "Beto Muestra");
    expect(scheduled).toHaveTextContent(/sesion/i);
    expect(scheduled).toHaveTextContent(/refrigerio/i);
    expect(scheduled).toHaveTextContent(/0?1:00/);
    expect(scheduled).toHaveTextContent(/jornada|planificad|autom[áa]tic|horario/i);
    expect(scheduled).not.toHaveTextContent(/limitado/i);
  });

  it("SUPERVISOR conserva el desglose de solo lectura del resumen diario sin acciones de gestión", async () => {
    const user = userEvent.setup();
    vi.mocked(attendanceAdminApi.daily).mockResolvedValue([
      makeDaily({ session_count: 2, gross_minutes: 495, break_minutes: 45, worked_minutes: 450 }),
    ]);

    await renderLoaded(supervisorUser);

    expect(headersOf(dailyTable())).toEqual([
      "Empleado",
      "Fecha",
      "Efectivo",
      "Esperado",
      "Saldo",
      "Incidencias",
    ]);

    const row = await revealedDetails(user, dailyTable(), "Ana Prueba");
    expect(row).toHaveTextContent(/sesion/i);
    expect(row).toHaveTextContent(/presencia|tiempo presente/i);
    expect(row).toHaveTextContent(/refrigerio/i);

    const daily = dailyTable();
    expect(within(daily).queryAllByRole("button", { name: /editar refrigerio|ajustar refrigerio/i })).toHaveLength(0);
  });

  it("SUPERVISOR conserva jornada esperada, saldo y rol en el desglose del detalle de marcaciones", async () => {
    const user = userEvent.setup();
    vi.mocked(attendanceAdminApi.list).mockResolvedValue([
      makeRecord({
        worked_minutes: 181,
        expected_minutes: 480,
        difference_minutes: -299,
        status: "COMPLETE",
        check_out_at: "2026-10-16T22:01:00+00:00",
      }),
    ]);

    await renderLoaded(supervisorUser);

    expect(headersOf(recordsTable())).toEqual([
      "Empleado",
      "Fecha",
      "Entrada",
      "Salida",
      "Trabajado",
      "Estado",
    ]);

    const row = await revealedDetails(user, recordsTable(), "Ana Prueba");
    expect(row).toHaveTextContent(/jornada esperada|esperado/i);
    expect(row).toHaveTextContent(/saldo/i);
    expect(row).toHaveTextContent(/0?8:00/); // jornada esperada
    expect(row).toHaveTextContent(/[-−]0?4:59/); // saldo -299 min
    expect(`${norm(rowFor(recordsTable(), "Ana Prueba").textContent)} ${norm(row.textContent)}`).toMatch(/operario/i);

    const records = recordsTable();
    expect(within(records).queryByRole("button", { name: /ver fotos|corregir registro/i })).toBeNull();
  });

  it("los saldos límite se leen en h:mm sin envolver las 24 horas", async () => {
    const cases: Array<{ name: string; value: number; expected: RegExp }> = [
      { name: "Ana Prueba", value: -1, expected: /^[-−]0?0:01$/ },
      { name: "Beto Muestra", value: -60, expected: /^[-−]0?1:00$/ },
      { name: "Carla Ensayo", value: 0, expected: /^0?0:00$/ },
      { name: "Diego Ficticio", value: 60, expected: /^\+?0?1:00$/ },
      { name: "Elena Simulada", value: 3984, expected: /^\+66:24$/ },
    ];
    vi.mocked(attendanceAdminApi.daily).mockResolvedValue(
      cases.map((item, index) =>
        makeDaily({
          employee_id: `emp-${index}`,
          employee_name: item.name,
          work_date: "2026-10-16",
          // Valores que no colisionan con el saldo al comparar celdas.
          worked_minutes: 7,
          expected_minutes: 480,
          difference_minutes: item.value,
        }),
      ),
    );

    await renderLoaded(adminUser, "Ana Prueba");

    const table = dailyTable();
    for (const item of cases) {
      const row = rowFor(table, item.name);
      const texts = cellTexts(row);
      expectAnyCell(row, item.expected);
      // Ninguna celda vuelve al formato antiguo con unidades ("-5 h -59", "60 min").
      expect(texts.some((text) => /\d\s*h\b|\bmin\b/i.test(text))).toBe(false);
    }
  });

  it("un saldo de -299 min se lee -04:59 y nunca -5 h -59", async () => {
    vi.mocked(attendanceAdminApi.daily).mockResolvedValue([makeDaily({ difference_minutes: -299 })]);

    await renderLoaded();

    const row = rowFor(dailyTable(), "Ana Prueba");
    expect(row).toHaveTextContent(/[-−]0?4:59/);
    expect(row).not.toHaveTextContent(/-5\s*h\s*-59/);
    expect(row).not.toHaveTextContent(/\d\s*h\b/);
  });

  it("muestra la fecha de salida cuando el día de Lima cambia y rotula el estado cerrado como Cerrada", async () => {
    vi.mocked(attendanceAdminApi.list).mockResolvedValue([
      makeRecord({
        work_date: "2026-10-02",
        check_in_at: "2026-10-02T19:03:00Z", // 14:03 en Lima
        check_out_at: "2026-10-05T13:27:00Z", // 08:27 en Lima, otro día
        worked_minutes: 3984,
        status: "COMPLETE",
        difference_minutes: 3504,
      }),
    ]);

    await renderLoaded();

    const row = rowFor(recordsTable(), "Ana Prueba");
    const clock = (iso: string) => norm(new Date(iso).toLocaleTimeString("es-PE", {
      timeZone: "America/Lima", hour: "2-digit", minute: "2-digit",
    }));
    expect(row).toHaveTextContent(clock("2026-10-02T19:03:00Z"));
    expect(row).toHaveTextContent(clock("2026-10-05T13:27:00Z"));
    expect(row).toHaveTextContent("02/10/2026");
    expect(row).toHaveTextContent("05/10/2026");
    expect(row).toHaveTextContent(/cerrada/i);
    expect(row).not.toHaveTextContent(/completada/i);
  });

  it("una salida incompleta conserva — y Sin salida sin inventar fecha ni tiempo", async () => {
    const user = userEvent.setup();
    vi.mocked(attendanceAdminApi.list).mockResolvedValue([
      makeRecord({
        work_date: "2026-10-16",
        check_in_at: "2026-10-16T11:00:00Z", // 06:00 en Lima
        check_out_at: null,
        worked_minutes: null,
        difference_minutes: null,
        status: "OPEN",
      }),
    ]);

    await renderLoaded();

    const row = rowFor(recordsTable(), "Ana Prueba");
    expect(row).toHaveTextContent(norm(new Date("2026-10-16T11:00:00Z").toLocaleTimeString("es-PE", {
      timeZone: "America/Lima", hour: "2-digit", minute: "2-digit",
    })));
    expect(row).toHaveTextContent(/sin salida/i);
    expect(row).toHaveTextContent(/16\/10\/2026/);
    expect(row).not.toHaveTextContent(/17\/10\/2026/);
    expectAnyCell(row, /^—$/); // trabajado pendiente

    const detailed = await revealedDetails(user, recordsTable(), "Ana Prueba");
    expect(detailed).toHaveTextContent(/0?8:00/); // jornada esperada conservada
    expect(detailed).toHaveTextContent(/saldo(?: del día)?\s*:?\s*—/i);
  });

  it("las incidencias del día conservan sus códigos y el significado completo", async () => {
    vi.mocked(attendanceAdminApi.daily).mockResolvedValue([
      makeDaily({ incident_codes: ["LONG_ATTENDANCE", "LATE_ENTRY"] }),
    ]);

    await renderLoaded();

    const row = rowFor(dailyTable(), "Ana Prueba");
    const meaning = [norm(row.textContent), ...Array.from(
      row.querySelectorAll<HTMLElement>("[title], [aria-description], [aria-describedby]"),
      describedText,
    )].join(" ");
    expect(meaning).toMatch(/jornada excesivamente larga/i);
    expect(meaning).toMatch(/entrada tardía/i);
    expect(row).not.toHaveTextContent(/sin incidencias/i);
  });

  it.each(["ADMIN", "BOSS"] as const)("%s conserva SVG, etiquetas visibles y los diálogos existentes", async (role) => {
    const user = userEvent.setup();
    vi.mocked(attendanceAdminApi.list).mockResolvedValue([
      makeRecord({ status: "COMPLETE", check_out_at: "2026-10-16T22:01:00+00:00", worked_minutes: 400, difference_minutes: -80 }),
    ]);
    vi.mocked(attendanceAdminApi.daily).mockResolvedValue([
      makeDaily({
        employee_name: "Ana Prueba",
        has_open_entry: false,
        gross_minutes: 500,
        break_minutes: 45,
        worked_minutes: 455,
      }),
      makeDaily({ employee_id: "emp-2", employee_name: "Beto Muestra", has_open_entry: true }),
    ]);
    const metaSpy = vi.spyOn(attendanceAdminApi, "evidenceMeta").mockResolvedValue({
      record_id: "rec-1",
      check_in: null,
      check_out: null,
    });

    await renderLoaded({ ...adminUser, role });

    const recordRow = rowFor(recordsTable(), "Ana Prueba");
    const photos = within(recordRow).getByRole("button", { name: /ver fotos de ana prueba/i });
    const correction = within(recordRow).getByRole("button", { name: /corregir registro de ana prueba/i });
    for (const action of [photos, correction]) {
      expect(action.querySelector("svg")).not.toBeNull();
    }
    expect(norm(photos.textContent)).toMatch(/fotos/i);
    expect(norm(correction.textContent)).toMatch(/corregir/i);

    await user.click(photos);
    const evidenceDialog = await screen.findByRole("dialog");
    expect(within(evidenceDialog).getByRole("heading", { name: /evidencia fotográfica/i })).toBeInTheDocument();
    // Se conserva el mismo callback y el identificador del registro.
    await waitFor(() => expect(metaSpy).toHaveBeenCalledWith("rec-1"));
    await user.click(within(evidenceDialog).getByRole("button", { name: /cerrar evidencia/i }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    await user.click(within(rowFor(recordsTable(), "Ana Prueba")).getByRole("button", { name: /corregir registro de ana prueba/i }));
    const correctionDialog = await screen.findByRole("dialog");
    expect(
      within(correctionDialog).getByRole("heading", { name: /corregir registro/i }),
    ).toBeInTheDocument();
    await user.click(within(correctionDialog).getByRole("button", { name: /cerrar corrección/i }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    const breakAction = await breakActionFor(user, dailyTable(), "Ana Prueba");
    expect(breakAction.querySelector("svg")).not.toBeNull();
    expect(norm(breakAction.textContent)).toMatch(/refrigerio/i);
    await user.click(breakAction);
    const breakDialog = await screen.findByRole("dialog");
    expect(
      within(breakDialog).getByRole("heading", { name: /editar refrigerio del día/i }),
    ).toBeInTheDocument();
    // El diálogo conserva el formateador clásico ("8 h 20"); el cambio a h:mm
    // es solo de presentación de tablas.
    expect(breakDialog).toHaveTextContent(/presencia:\s*8 h 20/i);
    await user.click(within(breakDialog).getByRole("button", { name: /cancelar/i }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    const blockedBreak = await breakActionFor(user, dailyTable(), "Beto Muestra");
    expect(blockedBreak).toBeDisabled();
    expect(describedText(blockedBreak)).toMatch(/cierre todas las marcaciones/i);
  });

  it("conserva la paginación por cliente y los enlaces de empleado", async () => {
    const user = userEvent.setup();
    vi.mocked(attendanceAdminApi.list).mockResolvedValue(
      Array.from({ length: 12 }, (_, index) => {
        const suffix = String(index + 1).padStart(2, "0");
        return makeRecord({
          id: `rec-${suffix}`,
          employee_id: `emp-${suffix}`,
          employee_name: `Persona Prueba ${suffix}`,
          work_date: "2026-10-16",
          check_in_at: "2026-10-16T17:00:05+00:00",
          check_out_at: "2026-10-16T22:00:00+00:00",
          worked_minutes: 300,
          difference_minutes: -180,
          status: "COMPLETE",
        });
      }),
    );

    await renderLoaded(adminUser, "Persona Prueba 01");

    const table = recordsTable();
    expect(within(table).getByRole("link", { name: /persona prueba 01/i })).toHaveAttribute(
      "href",
      "/admin/employees/emp-01",
    );
    expect(within(table).queryByRole("link", { name: /persona prueba 11/i })).toBeNull();

    const pagination = screen.getByRole("navigation", { name: /paginación de tabla/i });
    expect(within(pagination).getByText(/\b1\s*[–-]\s*10\s*de\s*12\b/)).toBeInTheDocument();

    await user.click(within(pagination).getByRole("button", { name: /página siguiente/i }));

    expect(within(pagination).getByText(/\b11\s*[–-]\s*12\s*de\s*12\b/)).toBeInTheDocument();
    expect(within(table).getByRole("link", { name: /persona prueba 11/i })).toHaveAttribute(
      "href",
      "/admin/employees/emp-11",
    );
  });
});
