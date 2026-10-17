import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminSessionContext } from "@/components/AdminSession";
import type { AttendanceDevice, UserOut } from "@/lib/api";
import { devicesApi } from "@/lib/api";
import AdminDevicesPage from "@/pages/AdminDevicesPage";

/**
 * Administración de sesiones de marcación.
 *
 * Ya no se autoriza equipamiento: la identidad del navegador se establece sola
 * en la identificación. Esta página solo conserva el historial de sesiones y la
 * revocación del contexto vigente. Estas pruebas fijan que no vuelvan a existir
 * los controles de creación o rotación de códigos de emparejamiento.
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

const activeDevice: AttendanceDevice = {
  id: "dev-1",
  name: "Tablet Portería",
  device_code: "DEV-ABC123",
  active: true,
  last_sync_at: new Date().toISOString(),
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/admin/devices"]}>
      <AdminSessionContext.Provider value={{ user: adminUser, ready: true }}>
        <AdminDevicesPage />
      </AdminSessionContext.Provider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.spyOn(devicesApi, "list").mockResolvedValue([activeDevice]);
  vi.spyOn(devicesApi, "revoke").mockResolvedValue({ ...activeDevice, active: false });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Admin — sesiones de marcación", () => {
  it("no ofrece crear ni rotar códigos de equipo", async () => {
    renderPage();
    await screen.findByText("Tablet Portería");

    expect(screen.queryByLabelText(/nombre del equipo/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /registrar terminal/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /nuevo código/i })).toBeNull();
    expect(screen.queryByText(/código de vinculación/i)).toBeNull();
    expect(screen.queryByText(/emparejamiento/i)).toBeNull();
  });

  it("presenta las sesiones como contexto automático, no como autorización de equipos", async () => {
    renderPage();

    expect(
      await screen.findByRole("heading", { level: 1, name: "Sesiones de marcación" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/establecidas automáticamente/i)).toBeInTheDocument();
  });

  it("conserva la revocación del contexto vigente y explica su alcance", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("Tablet Portería");

    await user.click(screen.getByRole("button", { name: /revocar/i }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/contexto/i)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: /sí, revocar/i }));

    await waitFor(() => expect(devicesApi.revoke).toHaveBeenCalledWith("dev-1"));
  });
});
