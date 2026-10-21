import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminSessionContext } from "@/components/AdminSession";
import { AdminViewStateProvider } from "@/components/AdminViewState";
import {
  payrollApi,
  type PayrollDailyReport,
  type PayrollPeriod,
  type PayrollSummary,
  type UserOut,
} from "@/lib/api";
import AdminSalariesPage from "@/pages/AdminSalariesPage";
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

const periods: PayrollPeriod[] = [
  {
    id: "period-oct",
    name: "Octubre 2026",
    start_date: "2026-10-01",
    end_date: "2026-10-31",
    payroll_month_id: null,
    period_kind: "MONTHLY",
    status: "OPEN",
    root_period_id: "period-oct",
    version: 1,
    supersedes_period_id: null,
    rectification_reason: null,
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
  },
  {
    id: "period-aug",
    name: "Agosto 2026",
    start_date: "2026-08-01",
    end_date: "2026-08-31",
    payroll_month_id: null,
    period_kind: "MONTHLY",
    status: "CLOSED",
    root_period_id: "period-aug",
    version: 1,
    supersedes_period_id: null,
    rectification_reason: null,
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z",
  },
];

function summaryFor(periodId: string): PayrollSummary {
  const period = periods.find((item) => item.id === periodId)!;
  return {
    period_id: periodId,
    name: period.name,
    start_date: period.start_date,
    end_date: period.end_date,
    status: period.status,
    employee_count: 0,
    total_base: "0.00",
    total_overtime: "0.00",
    total_manual: "0.00",
    total: "0.00",
  };
}

function dailyReportFor(periodId: string): PayrollDailyReport {
  const period = periods.find((item) => item.id === periodId)!;
  return {
    period_id: periodId,
    start_date: period.start_date,
    end_date: period.end_date,
    daily: [],
    employees: [],
  };
}

function shell(children: ReactNode) {
  return (
    <MemoryRouter initialEntries={["/admin/salaries"]}>
      <AdminSessionContext.Provider value={{ user: adminUser, ready: true }}>
        <AdminViewStateProvider>{children}</AdminViewStateProvider>
      </AdminSessionContext.Provider>
    </MemoryRouter>
  );
}

function page() {
  return shell(<AdminSalariesPage />);
}

let restorePointerStubs: () => void;

beforeAll(() => {
  restorePointerStubs = installPointerStubs();
});

afterAll(() => {
  restorePointerStubs();
});

beforeEach(() => {
  vi.spyOn(payrollApi, "periods").mockResolvedValue(periods);
  vi.spyOn(payrollApi, "summary").mockImplementation(async (periodId: string) => summaryFor(periodId));
  vi.spyOn(payrollApi, "records").mockResolvedValue([]);
  vi.spyOn(payrollApi, "dailyReport").mockImplementation(async (periodId: string) =>
    dailyReportFor(periodId),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Admin · sueldos: periodo y búsqueda de vista", () => {
  it("restaura el periodo elegido y la búsqueda al volver", async () => {
    const user = userEvent.setup();
    const view = render(page());

    const periodSelect = await screen.findByRole("combobox", { name: "Periodo de pago" });
    await waitFor(() => expect(payrollApi.summary).toHaveBeenCalledWith("period-oct"));

    await user.click(periodSelect);
    await user.click(await screen.findByRole("option", { name: /Agosto 2026/ }));
    await waitFor(() => expect(payrollApi.summary).toHaveBeenCalledWith("period-aug"));

    const search = screen.getByRole("searchbox", { name: "Buscar empleado en el periodo" });
    await user.type(search, "ana");

    const callsBeforeReturn = vi.mocked(payrollApi.summary).mock.calls.length;
    view.rerender(shell(<div>otra pantalla</div>));
    view.rerender(page());

    // El periodo restaurado sigue existiendo: se mantiene y se vuelven a pedir
    // sus datos frescos a la API.
    expect(await screen.findByRole("combobox", { name: "Periodo de pago" })).toHaveTextContent(
      "Agosto 2026",
    );
    expect(screen.getByRole("searchbox", { name: "Buscar empleado en el periodo" })).toHaveValue("ana");
    await waitFor(() =>
      expect(vi.mocked(payrollApi.summary).mock.calls.length).toBeGreaterThan(callsBeforeReturn),
    );
    const calls = vi.mocked(payrollApi.summary).mock.calls;
    expect(calls[calls.length - 1]?.[0]).toBe("period-aug");
  });

  it("si el periodo guardado ya no existe, no consulta el obsoleto y usa el primero válido", async () => {
    const user = userEvent.setup();
    const view = render(page());

    const periodSelect = await screen.findByRole("combobox", { name: "Periodo de pago" });
    await waitFor(() => expect(payrollApi.summary).toHaveBeenCalledWith("period-oct"));
    await user.click(periodSelect);
    await user.click(await screen.findByRole("option", { name: /Agosto 2026/ }));
    await waitFor(() => expect(payrollApi.summary).toHaveBeenCalledWith("period-aug"));

    // La lista fresca ya no contiene Agosto; Octubre queda como primero válido.
    vi.mocked(payrollApi.periods).mockResolvedValue([periods[0]]);
    const callsBeforeReturn = vi.mocked(payrollApi.summary).mock.calls.length;

    view.rerender(shell(<div>otra pantalla</div>));
    view.rerender(page());

    await waitFor(() =>
      expect(vi.mocked(payrollApi.summary).mock.calls.length).toBeGreaterThan(callsBeforeReturn),
    );

    const newCalls = vi.mocked(payrollApi.summary).mock.calls.slice(callsBeforeReturn);
    // Ninguna consulta usa el id que ya no existe en la lista fresca.
    expect(newCalls.every(([periodId]) => periodId !== "period-aug")).toBe(true);
    expect(newCalls[0]?.[0]).toBe("period-oct");
    expect(await screen.findByRole("combobox", { name: "Periodo de pago" })).toHaveTextContent(
      "Octubre 2026",
    );
  });
});
