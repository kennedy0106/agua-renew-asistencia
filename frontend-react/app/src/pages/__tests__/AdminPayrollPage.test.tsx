import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminSessionContext } from "@/components/AdminSession";
import { AdminViewStateProvider } from "@/components/AdminViewState";
import { Notifications } from "@/components/Notifications";
import { payrollApi, type PayrollPeriod, type UserOut } from "@/lib/api";
import AdminPayrollPage from "@/pages/AdminPayrollPage";

const adminUser: UserOut = {
  id: "user-admin",
  username: "admin",
  role: "ADMIN",
  active: true,
  must_change_password: false,
  last_login_at: null,
  created_at: "",
};

const period: PayrollPeriod = {
  id: "period-sep",
  name: "Septiembre 2026",
  start_date: "2026-09-01",
  end_date: "2026-09-30",
  payroll_month_id: null,
  period_kind: "MONTHLY",
  status: "CALCULATED",
  root_period_id: "period-sep",
  version: 1,
  supersedes_period_id: null,
  rectification_reason: null,
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-01T00:00:00Z",
};

function shell(children: ReactNode) {
  return (
    <MemoryRouter initialEntries={["/admin/payroll"]}>
      <AdminSessionContext.Provider value={{ user: adminUser, ready: true }}>
        <AdminViewStateProvider>
          <Notifications>{children}</Notifications>
        </AdminViewStateProvider>
      </AdminSessionContext.Provider>
    </MemoryRouter>
  );
}

function page() {
  return shell(<AdminPayrollPage />);
}

beforeEach(() => {
  vi.spyOn(payrollApi, "periods").mockResolvedValue([period]);
  vi.spyOn(payrollApi, "records").mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Admin · planilla: selección de registros", () => {
  it("al volver reabre el periodo revisado y pide sus registros frescos una vez", async () => {
    const user = userEvent.setup();
    const view = render(page());

    await screen.findByText("Septiembre 2026");
    await user.click(screen.getByRole("button", { name: "Revisar registros" }));
    await waitFor(() => expect(payrollApi.records).toHaveBeenCalledWith("period-sep"));
    expect(await screen.findByText(/Registros de Septiembre 2026/)).toBeInTheDocument();

    const callsBeforeReturn = vi.mocked(payrollApi.records).mock.calls.length;
    view.rerender(shell(<div>otra pantalla</div>));
    view.rerender(page());

    expect(await screen.findByText(/Registros de Septiembre 2026/)).toBeInTheDocument();
    await waitFor(() =>
      expect(vi.mocked(payrollApi.records).mock.calls.length).toBeGreaterThan(callsBeforeReturn),
    );
    const calls = vi.mocked(payrollApi.records).mock.calls;
    expect(calls[calls.length - 1]?.[0]).toBe("period-sep");
  });
});
