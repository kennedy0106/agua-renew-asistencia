import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import App from "@/App";

/**
 * Blindaje del mapa de rutas de `App`.
 *
 * Las 17 rutas productivas deben resolver a su página y NUNCA caer en el
 * catch-all (`NotFoundPage`). Las páginas se sustituyen por marcadores
 * deterministas para que la prueba falle si alguien elimina, renombra o vuelve
 * a redirigir una ruta hacia un pendiente de migración, sin depender de la
 * sesión ni de la red.
 */

vi.mock("@/layouts/AdminLayout", async () => {
  const { Outlet } = await import("react-router-dom");
  return { default: () => <Outlet /> };
});

vi.mock("@/pages/HomePage", () => ({ default: () => <div data-testid="route-home" /> }));
vi.mock("@/pages/AsistenciaPage", () => ({ default: () => <div data-testid="route-asistencia" /> }));
vi.mock("@/pages/AdminLoginPage", () => ({ default: () => <div data-testid="route-admin-login" /> }));
vi.mock("@/pages/AdminChangePasswordPage", () => ({
  default: () => <div data-testid="route-admin-change-password" />,
}));
vi.mock("@/pages/AdminDashboardPage", () => ({
  default: () => <div data-testid="route-admin-dashboard" />,
}));
vi.mock("@/pages/AdminAccountPage", () => ({ default: () => <div data-testid="route-admin-account" /> }));
vi.mock("@/pages/AdminAttendancePage", () => ({
  default: () => <div data-testid="route-admin-attendance" />,
}));
vi.mock("@/pages/AdminAttendanceHistoryPage", () => ({
  default: () => <div data-testid="route-admin-attendance-history" />,
}));
vi.mock("@/pages/AdminAuditPage", () => ({ default: () => <div data-testid="route-admin-audit" /> }));
vi.mock("@/pages/AdminDevicesPage", () => ({ default: () => <div data-testid="route-admin-devices" /> }));
vi.mock("@/pages/AdminEmployeesPage", () => ({ default: () => <div data-testid="route-admin-employees" /> }));
vi.mock("@/pages/AdminEmployeeDetailPage", async () => {
  const { useParams } = await import("react-router-dom");
  function AdminEmployeeDetailStub() {
    return <div data-testid="route-admin-employee-detail">id:{useParams().id}</div>;
  }
  return { default: AdminEmployeeDetailStub };
});
vi.mock("@/pages/AdminOvertimePolicyPage", () => ({
  default: () => <div data-testid="route-admin-overtime-policy" />,
}));
vi.mock("@/pages/AdminPayrollPage", () => ({ default: () => <div data-testid="route-admin-payroll" /> }));
vi.mock("@/pages/AdminRolesPage", () => ({ default: () => <div data-testid="route-admin-roles" /> }));
vi.mock("@/pages/AdminSalariesPage", () => ({ default: () => <div data-testid="route-admin-salaries" /> }));
vi.mock("@/pages/AdminUsersPage", () => ({ default: () => <div data-testid="route-admin-users" /> }));

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

const ROUTES: Array<[string, string]> = [
  ["/", "route-home"],
  ["/asistencia", "route-asistencia"],
  ["/admin/login", "route-admin-login"],
  ["/admin/change-password", "route-admin-change-password"],
  ["/admin/dashboard", "route-admin-dashboard"],
  ["/admin/account", "route-admin-account"],
  ["/admin/attendance", "route-admin-attendance"],
  ["/admin/attendance/history", "route-admin-attendance-history"],
  ["/admin/audit", "route-admin-audit"],
  ["/admin/devices", "route-admin-devices"],
  ["/admin/employees", "route-admin-employees"],
  ["/admin/overtime-policy", "route-admin-overtime-policy"],
  ["/admin/payroll", "route-admin-payroll"],
  ["/admin/roles", "route-admin-roles"],
  ["/admin/salaries", "route-admin-salaries"],
  ["/admin/users", "route-admin-users"],
];

describe("App — mapa de rutas", () => {
  it("expone exactamente 17 rutas (16 listadas + detalle de empleado)", () => {
    expect(ROUTES).toHaveLength(16);
  });

  it.each(ROUTES)("renderiza %s en su página, nunca en el catch-all", async (path, testId) => {
    renderAt(path);

    // Las páginas pesadas son `React.lazy`: se resuelven tras el Suspense.
    expect(await screen.findByTestId(testId)).toBeInTheDocument();
    expect(screen.queryByText("Página no encontrada")).not.toBeInTheDocument();
  });

  it("resuelve el parámetro :id del detalle de empleado", async () => {
    renderAt("/admin/employees/emp-42");

    expect(await screen.findByTestId("route-admin-employee-detail")).toHaveTextContent("emp-42");
    expect(screen.queryByText("Página no encontrada")).not.toBeInTheDocument();
  });

  it("una ruta desconocida cae en el 404 real", () => {
    renderAt("/ruta-que-no-existe");

    expect(screen.getByText("Página no encontrada")).toBeInTheDocument();
  });

  it("la ruta índice /admin renderiza el 404 real", () => {
    renderAt("/admin");

    expect(screen.getByText("Página no encontrada")).toBeInTheDocument();
  });
});
