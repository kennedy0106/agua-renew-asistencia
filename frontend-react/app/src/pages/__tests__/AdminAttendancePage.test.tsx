import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminSessionContext } from "@/components/AdminSession";
import { Notifications } from "@/components/Notifications";
import {
  attendanceAdminApi,
  attendanceRecoveryAdminApi,
  employeesApi,
  ApiError,
  type AttendanceDailyItem,
  type AttendanceListItem,
  type Employee,
  type UserOut,
} from "@/lib/api";
import AdminAttendancePage from "@/pages/AdminAttendancePage";

/**
 * Visor privado de evidencia con sello.
 *
 * El panel es el único visor autorizado (ADMIN/BOSS): muestra tiempo oficial,
 * coordenadas y enlace solo-texto a Google Maps para la evidencia nueva con
 * sello, y conserva la foto original. La evidencia histórica se muestra como
 * original sin inventar ubicación (L4/L6).
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

const MARKED_AT = "2026-10-16T12:00:05+00:00";
const LOCATION = {
  latitude: -12.0464,
  longitude: -77.0428,
  accuracy_m: 12.5,
  observed_at: "2026-10-16T12:00:00+00:00",
  address: "Av. Siempre Viva 742, Lima",
};

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

async function openViewer() {
  const user = userEvent.setup();
  const buttons = await screen.findAllByRole("button", { name: /ver fotos de ana prueba/i });
  await user.click(buttons[0]);
  return screen.findByRole("dialog");
}

beforeEach(() => {
  URL.createObjectURL = vi.fn((value: Blob) => `blob:${String((value as unknown as { size?: number }).size ?? "x")}`);
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(attendanceAdminApi, "list").mockResolvedValue([record]);
  vi.spyOn(attendanceAdminApi, "daily").mockResolvedValue([daily]);
  vi.spyOn(attendanceRecoveryAdminApi, "list").mockResolvedValue([]);
  vi.spyOn(employeesApi, "list").mockResolvedValue([employee]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Admin — visor privado de evidencia", () => {
  it("muestra el sello, la hora oficial y la ubicación con enlace solo-texto a Google Maps", async () => {
    vi.spyOn(attendanceAdminApi, "evidenceMeta").mockResolvedValue({
      record_id: "rec-1",
      check_in: {
        id: "ev-in",
        captured_at: MARKED_AT,
        content_type: "image/jpeg",
        available: true,
        marked_at: MARKED_AT,
        location: LOCATION,
        stamped_available: true,
      },
      check_out: null,
    });
    vi.spyOn(attendanceAdminApi, "evidenceImage").mockResolvedValue("blob:original-in");
    const stampedSpy = vi
      .spyOn(attendanceAdminApi, "evidenceStampedImage")
      .mockResolvedValue("blob:stamped-in");

    renderPage();
    const dialog = await openViewer();

    await waitFor(() => expect(stampedSpy).toHaveBeenCalledWith("ev-in"));
    expect(within(dialog).getByTestId("evidence-subject")).toHaveTextContent(/Ana Prueba/);
    expect(within(dialog).getByTestId("evidence-subject")).toHaveTextContent(/16\/10\/2026/);
    expect(within(dialog).getByText(/integra los datos del registro/i)).toBeInTheDocument();

    const stamped = await within(dialog).findByTestId("evidence-image-check_in");
    expect(stamped).toHaveAttribute("src", "blob:stamped-in");
    expect(stamped).toHaveAttribute("alt", expect.stringMatching(/sello/i));
    expect(within(dialog).getByTestId("evidence-version-check_in")).toHaveTextContent(/con sello/i);
    const stampedDownload = within(dialog).getByTestId("evidence-stamped-download-check_in");
    expect(stampedDownload).toHaveAttribute("href", "blob:stamped-in");
    expect(stampedDownload).toHaveAttribute("download");
    expect(stampedDownload).toHaveClass("btn-primary");
    expect(stampedDownload.querySelector("svg")).not.toBeNull();
    expect(within(dialog).getByTestId("evidence-original-check_in")).toHaveClass("btn-outline");
    expect(within(dialog).queryByTestId("evidence-stamp-warning-check_in")).toBeNull();

    const view = within(dialog).getByRole("group", { name: /vista de la foto de entrada/i });
    expect(within(view).getByRole("button", { name: /^con sello$/i })).toHaveAttribute("aria-pressed", "true");
    expect(within(view).getByRole("button", { name: /^original$/i })).toHaveAttribute("aria-pressed", "false");

    expect(within(dialog).getByTestId("evidence-official-time-check_in")).toHaveTextContent(/\d{2}:\d{2}/);
    const location = within(dialog).getByTestId("evidence-location-check_in");
    expect(location).toHaveTextContent("-12.0464");
    expect(location).toHaveTextContent("-77.0428");
    expect(location).toHaveTextContent("Precisión ±12.5 m");
    expect(location).toHaveTextContent("Av. Siempre Viva 742");

    const link = within(dialog).getByTestId("evidence-maps-check_in");
    expect(link).toHaveAttribute(
      "href",
      "https://www.google.com/maps/search/?api=1&query=-12.0464%2C-77.0428",
    );
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(link.getAttribute("href")).not.toMatch(/ana|prueba|71112233|ev-in|token/i);
  });

  it("permite ver y descargar el original sin reemplazar el sello", async () => {
    vi.spyOn(attendanceAdminApi, "evidenceMeta").mockResolvedValue({
      record_id: "rec-1",
      check_in: {
        id: "ev-in",
        captured_at: MARKED_AT,
        content_type: "image/jpeg",
        available: true,
        marked_at: MARKED_AT,
        location: LOCATION,
        stamped_available: true,
      },
      check_out: null,
    });
    vi.spyOn(attendanceAdminApi, "evidenceImage").mockResolvedValue("blob:original-in");
    vi.spyOn(attendanceAdminApi, "evidenceStampedImage").mockResolvedValue("blob:stamped-in");

    renderPage();
    const dialog = await openViewer();
    await within(dialog).findByTestId("evidence-image-check_in");

    const download = within(dialog).getByTestId("evidence-original-check_in");
    expect(download).toHaveAttribute("href", "blob:original-in");
    expect(download).toHaveAttribute("download");

    const view = within(dialog).getByRole("group", { name: /vista de la foto de entrada/i });
    const originalView = within(view).getByRole("button", { name: /^original$/i });
    const user = userEvent.setup();
    await user.click(originalView);
    expect(originalView).toHaveAttribute("aria-pressed", "true");
    expect(within(view).getByRole("button", { name: /^con sello$/i })).toHaveAttribute("aria-pressed", "false");
    expect(within(dialog).getByTestId("evidence-image-check_in")).toHaveAttribute("src", "blob:original-in");
    expect(within(dialog).getByTestId("evidence-version-check_in")).toHaveTextContent(/^original$/i);
    expect(within(dialog).getByTestId("evidence-original-check_in")).toHaveAttribute("href", "blob:original-in");
  });

  it("muestra la evidencia histórica como original sin ubicación ni enlace inventado", async () => {
    vi.spyOn(attendanceAdminApi, "evidenceMeta").mockResolvedValue({
      record_id: "rec-1",
      check_in: {
        id: "ev-old",
        captured_at: MARKED_AT,
        content_type: "image/jpeg",
        available: true,
      },
      check_out: null,
    });
    vi.spyOn(attendanceAdminApi, "evidenceImage").mockResolvedValue("blob:original-old");
    const stampedSpy = vi.spyOn(attendanceAdminApi, "evidenceStampedImage");

    renderPage();
    const dialog = await openViewer();

    await within(dialog).findByTestId("evidence-image-check_in");
    expect(within(dialog).getByTestId("evidence-image-check_in")).toHaveAttribute("src", "blob:original-old");
    expect(within(dialog).getByTestId("evidence-location-missing-check_in")).toHaveTextContent(/ubicación no disponible/i);
    expect(within(dialog).queryByTestId("evidence-maps-check_in")).toBeNull();
    // Sin sello anunciado no hay error ni aviso: se etiqueta como original.
    expect(within(dialog).getByTestId("evidence-version-check_in")).toHaveTextContent(/original/i);
    expect(within(dialog).getByTestId("evidence-original-check_in")).toHaveAttribute("href", "blob:original-old");
    expect(within(dialog).queryByTestId("evidence-stamp-warning-check_in")).toBeNull();
    expect(within(dialog).queryByTestId("evidence-stamped-download-check_in")).toBeNull();
    expect(within(dialog).queryByTestId("evidence-toggle-check_in")).toBeNull();
    expect(within(dialog).queryByRole("button", { name: /^original$/i })).toBeNull();
    expect(stampedSpy).not.toHaveBeenCalled();
  });

  it("advierte cuando el sello anunciado no carga y nunca lo hace pasar por sellado", async () => {
    vi.spyOn(attendanceAdminApi, "evidenceMeta").mockResolvedValue({
      record_id: "rec-1",
      check_in: {
        id: "ev-in",
        captured_at: MARKED_AT,
        content_type: "image/jpeg",
        available: true,
        marked_at: MARKED_AT,
        location: LOCATION,
        stamped_available: true,
      },
      check_out: null,
    });
    vi.spyOn(attendanceAdminApi, "evidenceImage").mockResolvedValue("blob:original-in");
    const stampedSpy = vi
      .spyOn(attendanceAdminApi, "evidenceStampedImage")
      .mockRejectedValue(new ApiError(503, "sin sello"));

    renderPage();
    const dialog = await openViewer();

    await waitFor(() => expect(stampedSpy).toHaveBeenCalledWith("ev-in"));
    const warning = await within(dialog).findByTestId("evidence-stamp-warning-check_in");
    expect(warning).toHaveTextContent(/sello/i);
    expect(within(dialog).getByTestId("evidence-image-check_in")).toHaveAttribute("src", "blob:original-in");
    expect(within(dialog).getByTestId("evidence-version-check_in")).toHaveTextContent(/original/i);
    expect(within(dialog).getByTestId("evidence-original-check_in")).toHaveAttribute("href", "blob:original-in");
    expect(within(dialog).queryByTestId("evidence-stamped-download-check_in")).toBeNull();
    expect(within(dialog).queryByTestId("evidence-toggle-check_in")).toBeNull();
  });

  it("redondea la precisión a un decimal y conserva las coordenadas completas en el enlace", async () => {
    vi.spyOn(attendanceAdminApi, "evidenceMeta").mockResolvedValue({
      record_id: "rec-1",
      check_in: {
        id: "ev-in",
        captured_at: MARKED_AT,
        content_type: "image/jpeg",
        available: true,
        marked_at: MARKED_AT,
        location: { ...LOCATION, latitude: -12.04644, longitude: -77.04283, accuracy_m: 12.46 },
      },
      check_out: null,
    });
    vi.spyOn(attendanceAdminApi, "evidenceImage").mockResolvedValue("blob:original-in");

    renderPage();
    const dialog = await openViewer();
    await within(dialog).findByTestId("evidence-image-check_in");

    const location = within(dialog).getByTestId("evidence-location-check_in");
    expect(location.querySelector(".evidence-meta__accuracy")).toHaveTextContent("Precisión ±12.5 m");
    expect(location.querySelector(".evidence-meta__coords")).toHaveTextContent("-12.04644, -77.04283");
    expect(within(dialog).getByTestId("evidence-maps-check_in")).toHaveAttribute(
      "href",
      "https://www.google.com/maps/search/?api=1&query=-12.04644%2C-77.04283",
    );
  });

  it("no ofrece cambiar a original si esa versión no está disponible", async () => {
    vi.spyOn(attendanceAdminApi, "evidenceMeta").mockResolvedValue({
      record_id: "rec-1",
      check_in: {
        id: "ev-in",
        captured_at: MARKED_AT,
        content_type: "image/jpeg",
        available: true,
        marked_at: MARKED_AT,
        location: LOCATION,
        stamped_available: true,
      },
      check_out: null,
    });
    vi.spyOn(attendanceAdminApi, "evidenceImage").mockResolvedValue(null as unknown as string);
    vi.spyOn(attendanceAdminApi, "evidenceStampedImage").mockResolvedValue("blob:stamped-in");

    renderPage();
    const dialog = await openViewer();
    const image = await within(dialog).findByTestId("evidence-image-check_in");

    expect(image).toHaveAttribute("src", "blob:stamped-in");
    expect(within(dialog).getByTestId("evidence-version-check_in")).toHaveTextContent(/con sello/i);
    expect(within(dialog).queryByTestId("evidence-toggle-check_in")).toBeNull();
    expect(within(dialog).queryByRole("button", { name: /^original$/i })).toBeNull();
    expect(within(dialog).queryByTestId("evidence-original-check_in")).toBeNull();
    expect(within(dialog).getByTestId("evidence-stamped-download-check_in")).toBeInTheDocument();
  });

  it("muestra un solo vacío honesto cuando el registro no tiene fotos", async () => {
    vi.spyOn(attendanceAdminApi, "evidenceMeta").mockResolvedValue({
      record_id: "rec-1",
      check_in: null,
      check_out: null,
    });
    const imageSpy = vi.spyOn(attendanceAdminApi, "evidenceImage");

    renderPage();
    const dialog = await openViewer();

    expect(await within(dialog).findByText(/anterior a la evidencia/i)).toBeInTheDocument();
    expect(within(dialog).queryByTestId("evidence-figure-check_in")).toBeNull();
    expect(within(dialog).queryByTestId("evidence-version-check_in")).toBeNull();
    expect(within(dialog).queryByText(/descargar/i)).toBeNull();
    expect(imageSpy).not.toHaveBeenCalled();
  });

  it("un jefe (BOSS) conserva el mismo visor privado", async () => {
    const metaSpy = vi.spyOn(attendanceAdminApi, "evidenceMeta").mockResolvedValue({
      record_id: "rec-1",
      check_in: {
        id: "ev-in",
        captured_at: MARKED_AT,
        content_type: "image/jpeg",
        available: true,
        marked_at: MARKED_AT,
        location: LOCATION,
        stamped_available: true,
      },
      check_out: null,
    });
    vi.spyOn(attendanceAdminApi, "evidenceImage").mockResolvedValue("blob:original-in");
    vi.spyOn(attendanceAdminApi, "evidenceStampedImage").mockResolvedValue("blob:stamped-in");

    renderPage({ ...adminUser, role: "BOSS" });
    const dialog = await openViewer();

    await waitFor(() => expect(metaSpy).toHaveBeenCalledWith("rec-1"));
    expect(within(dialog).getByTestId("evidence-maps-check_in")).toBeInTheDocument();
  });

  it("respeta el contexto de autorización: sin rol de gestión no hay visor ni llamadas de evidencia", async () => {
    const metaSpy = vi.spyOn(attendanceAdminApi, "evidenceMeta");
    renderPage({ ...adminUser, role: "EMPLOYEE" });

    await screen.findAllByText("Ana Prueba");
    expect(screen.queryAllByRole("button", { name: /ver fotos de ana prueba/i })).toHaveLength(0);

    expect(metaSpy).not.toHaveBeenCalled();
  });
});
