import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import AttendanceRecoveryPanel from "@/components/AttendanceRecoveryPanel";
import {
  ApiError,
  attendanceRecoveryAdminApi,
  type RecoveryRequestAdminDetail,
  type RecoveryRequestAdminItem,
} from "@/lib/api";

const employee = {
  id: "emp-1",
  dni: "71112233",
  employee_code: "EMP-002",
  first_name: "Ana",
  last_name: "Prueba",
  active: true,
};

const request: RecoveryRequestAdminItem = {
  id: "req-1",
  nonce: "nonce-a",
  employee_id: "emp-1",
  employee_name: "Ana Prueba",
  employee_dni: "71112233",
  action: "CHECK_IN",
  status: "PENDING",
  requested_at: "2026-10-16T12:01:00+00:00",
  resolved_at: null,
  resolved_by_username: null,
  reason: null,
  original_device_id: "dev-original",
  requester_device_id: "dev-requester",
};

const location = {
  latitude: -12.0464,
  longitude: -77.0428,
  accuracy_m: 12.5,
  observed_at: "2026-10-16T12:00:00+00:00",
  address: "Av. Siempre Viva 742, Lima",
};

const confirmation = {
  id: "rec-1",
  employee_id: "emp-1",
  work_date: "2026-10-16",
  check_in_at: "2026-10-16T12:00:05+00:00",
  check_out_at: null,
  worked_minutes: null,
  status: "OPEN",
  event_type: "CHECK_IN",
};

function detail(overrides: Partial<RecoveryRequestAdminDetail["attempt"]> = {}): RecoveryRequestAdminDetail {
  return {
    request,
    employee,
    original_device: { id: "dev-original", name: "Tablet recepción" },
    requester_device: { id: "dev-requester", name: "Navegador del trabajador" },
    attempt: {
      state: "PREPARED",
      inconsistent: false,
      browser_unverifiable: false,
      can_authorize: true,
      token_expired: false,
      preparation: {
        marked_at: "2026-10-16T12:00:05+00:00",
        expires_at: "2026-10-16T12:05:05+00:00",
        location,
      },
      evidence: {
        ready: true,
        evidence_id: "ev-1",
        captured_at: "2026-10-16T12:00:06+00:00",
        content_type: "image/jpeg",
        record_id: null,
      },
      consumed: {
        present: true,
        confirmed: false,
        record_id: null,
        record: null,
        created_at: "2026-10-16T12:00:07+00:00",
        device_id: "dev-original",
      },
      resolution: {
        present: true,
        resolution: "PENDING_REVIEW",
        reason: "En revisión",
        resolved_by_user_id: null,
        resolved_at: null,
        record_id: null,
      },
      record: confirmation,
      available_actions: ["AUTHORIZE_REIDENTIFY", "REJECT"],
      ...overrides,
    },
  };
}

function employeesFixture() {
  return [
    {
      id: "emp-1",
      dni: "71112233",
      employee_code: "EMP-002",
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
    },
  ];
}

function renderPanel(onResolved = vi.fn()) {
  return render(<AttendanceRecoveryPanel employees={employeesFixture()} onResolved={onResolved} />);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("panel de solicitudes de recuperación", () => {
  it.each([
    ["PREPARATION_ONLY", "preparado, sin marcación confirmada"],
    ["EXPIRED_UNCONFIRMED", "preparación vencida, sin marcación confirmada"],
    ["EMPTY", "sin preparación, foto ni marcación asociadas"],
    ["UNVERIFIABLE_BROWSER", "no se pudo verificar el navegador del intento"],
  ])("explica el estado real %s sin confundirlo con una confirmación", async (state, label) => {
    vi.spyOn(attendanceRecoveryAdminApi, "list").mockResolvedValue([request]);
    vi.spyOn(attendanceRecoveryAdminApi, "detail").mockResolvedValue(detail({ state }));
    renderPanel();
    expect(screen.getByRole("combobox", { name: "Filtrar solicitudes por empleado" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Filtrar solicitudes por estado" })).toBeInTheDocument();
    await screen.findByTestId("recovery-row");
    await userEvent.setup().click(screen.getByTestId("recovery-open"));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText(label, { exact: false })).toBeInTheDocument();
    expect(within(dialog).queryByText("estado no reconocido", { exact: false })).toBeNull();
  });

  it("lista, inspecciona preparación/evidencia/consumo/resolución y resuelve con motivo", async () => {
    vi.spyOn(attendanceRecoveryAdminApi, "list").mockResolvedValue([request]);
    const detailSpy = vi.spyOn(attendanceRecoveryAdminApi, "detail").mockResolvedValue(detail());
    const resolvedDetail = detail({ can_authorize: false });
    resolvedDetail.request = {
      ...request,
      status: "AUTHORIZED",
      resolved_at: "2026-10-16T12:10:00+00:00",
      resolved_by_username: "jefe",
      reason: "Sesión vencida en el kiosco",
    };
    const resolveSpy = vi
      .spyOn(attendanceRecoveryAdminApi, "resolve")
      .mockResolvedValue(resolvedDetail);
    const onResolved = vi.fn();

    renderPanel(onResolved);
    expect(await screen.findByTestId("recovery-row")).toHaveTextContent(/Ana Prueba/);
    const user = userEvent.setup();
    await user.click(screen.getByTestId("recovery-open"));

    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(detailSpy).toHaveBeenCalledWith("req-1"));
    expect(within(dialog).getByTestId("recovery-preparation-marked-at")).toHaveTextContent("16/10/2026");
    expect(within(dialog).getByTestId("recovery-evidence-ready")).toHaveTextContent(/Foto guardada/i);
    expect(within(dialog).getByTestId("recovery-consumed-present")).toHaveTextContent("Sí");
    expect(within(dialog).getByTestId("recovery-resolution-value")).toHaveTextContent("PENDING_REVIEW");
    expect(within(dialog).getByTestId("recovery-record-date")).toHaveTextContent("16/10/2026");

    await user.type(within(dialog).getByTestId("recovery-reason"), "Sesión vencida en el kiosco");
    const submit = within(dialog).getByTestId("recovery-resolve");
    await waitFor(() => expect(submit).not.toBeDisabled());
    await user.click(submit);

    await waitFor(() =>
      expect(resolveSpy).toHaveBeenCalledWith("req-1", "AUTHORIZE_REIDENTIFY", "Sesión vencida en el kiosco"),
    );
    expect(onResolved).toHaveBeenCalledTimes(1);
    expect(await within(dialog).findByTestId("recovery-closed")).toHaveTextContent(/ya fue resuelta/i);
  });

  it("un intento inconsistente no se puede autorizar y lo explica con claridad", async () => {
    vi.spyOn(attendanceRecoveryAdminApi, "list").mockResolvedValue([
      { ...request, status: "PENDING" },
    ]);
    vi.spyOn(attendanceRecoveryAdminApi, "detail").mockResolvedValue(
      detail({
        state: "INCONSISTENT",
        inconsistent: true,
        can_authorize: false,
        evidence: { ready: true, evidence_id: "ev-1", captured_at: null, content_type: "image/jpeg", record_id: "rec-1" },
      }),
    );

    renderPanel();
    expect(await screen.findByTestId("recovery-row")).toBeInTheDocument();
    await userEvent.setup().click(screen.getByTestId("recovery-open"));

    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByTestId("recovery-inconsistent")).toHaveTextContent(
      /No se puede autorizar una nueva identificación/i,
    );
    // El formulario abre en una decisión permitida (rechazar), nunca en autorizar.
    const user = userEvent.setup();
    await user.type(within(dialog).getByTestId("recovery-reason"), "Registro inconsistente");
    await waitFor(() => expect(within(dialog).getByTestId("recovery-resolve")).not.toBeDisabled());
  });

  it("un intento no autorizable por el servidor lo informa sin inventar habilitación", async () => {
    vi.spyOn(attendanceRecoveryAdminApi, "list").mockResolvedValue([request]);
    vi.spyOn(attendanceRecoveryAdminApi, "detail").mockResolvedValue(
      detail({ state: "EVIDENCE_ONLY", can_authorize: false, token_expired: true }),
    );

    renderPanel();
    expect(await screen.findByTestId("recovery-row")).toBeInTheDocument();
    await userEvent.setup().click(screen.getByTestId("recovery-open"));

    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByTestId("recovery-not-authorizable")).toHaveTextContent(
      /no habilita autorizar/i,
    );
    expect(within(dialog).getByTestId("recovery-not-authorizable")).toHaveTextContent(/token está vencido/i);
  });

  it("una solicitud ya resuelta se muestra sin formulario de decisión", async () => {
    vi.spyOn(attendanceRecoveryAdminApi, "list").mockResolvedValue([
      { ...request, status: "REJECTED", resolved_at: "2026-10-16T12:05:00+00:00", resolved_by_username: "jefe" },
    ]);
    vi.spyOn(attendanceRecoveryAdminApi, "detail").mockResolvedValue({
      ...detail(),
      request: {
        ...request,
        status: "REJECTED",
        resolved_at: "2026-10-16T12:05:00+00:00",
        resolved_by_username: "jefe",
        reason: "No corresponde",
      },
    });

    renderPanel();
    expect(await screen.findByTestId("recovery-row")).toBeInTheDocument();
    await userEvent.setup().click(screen.getByTestId("recovery-open"));

    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByTestId("recovery-closed")).toBeInTheDocument();
    expect(within(dialog).queryByTestId("recovery-resolve")).toBeNull();
  });

  it("muestra un error legible si el listado falla y no inventa filas", async () => {
    vi.spyOn(attendanceRecoveryAdminApi, "list").mockRejectedValue(
      new ApiError(403, "No autorizado", "FORBIDDEN"),
    );
    renderPanel();
    expect(await screen.findByTestId("recovery-list-error")).toHaveTextContent(/No autorizado/);
    expect(screen.queryByTestId("recovery-row")).toBeNull();
  });
});
