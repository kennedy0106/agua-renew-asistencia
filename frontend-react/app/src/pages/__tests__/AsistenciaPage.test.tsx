import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AsistenciaPage from "@/pages/AsistenciaPage";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Unexpected network request")));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("kiosk identifier keyboard", () => {
  it("suppresses the native keyboard hint while using the DNI keypad", () => {
    render(<AsistenciaPage />);
    const input = screen.getByTestId("kiosk-identifier");
    const keypad = screen.getByRole("group", { name: "Teclado numérico" });

    expect(input).toHaveFocus();
    expect(input).toHaveAttribute("inputmode", "none");
    fireEvent.click(within(keypad).getByRole("button", { name: "1" }));
    expect(input).toHaveValue("1");
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute("inputmode", "none");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("preserves keypad editing, the eight-digit limit and physical keyboard input", async () => {
    const user = userEvent.setup();
    render(<AsistenciaPage />);
    const input = screen.getByTestId("kiosk-identifier");
    const keypad = screen.getByRole("group", { name: "Teclado numérico" });

    for (const digit of "12345678") {
      await user.click(within(keypad).getByRole("button", { name: digit }));
    }
    expect(input).toHaveValue("12345678");
    await user.click(within(keypad).getByRole("button", { name: "9" }));
    expect(input).toHaveValue("12345678");
    await user.click(screen.getByRole("button", { name: "Borrar último dígito" }));
    expect(input).toHaveValue("1234567");
    await user.click(within(keypad).getByRole("button", { name: "0" }));
    expect(input).toHaveValue("12345670");
    await user.click(screen.getByRole("button", { name: "Limpiar DNI" }));
    expect(input).toHaveValue("");
    expect(input).toHaveFocus();
    expect(input).toHaveProperty("readOnly", false);
    await user.keyboard("87654321");
    expect(input).toHaveValue("87654321");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps the native text keyboard for worker codes and restores DNI mode", async () => {
    const user = userEvent.setup();
    render(<AsistenciaPage />);
    const input = screen.getByTestId("kiosk-identifier");

    await user.click(screen.getByRole("tab", { name: "Código / AR: (texto)" }));
    expect(input).toHaveAttribute("inputmode", "text");
    expect(screen.queryByRole("group", { name: "Teclado numérico" })).not.toBeInTheDocument();
    await user.type(input, "EMP-002");
    expect(input).toHaveValue("EMP-002");
    await user.click(screen.getByRole("tab", { name: "DNI (números)" }));
    expect(input).toHaveAttribute("inputmode", "none");
    expect(screen.getByRole("group", { name: "Teclado numérico" })).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("kiosk sin autorización de dispositivos", () => {
  it("no muestra ningún control de emparejamiento en la identificación", () => {
    render(<AsistenciaPage />);

    expect(document.querySelector("[data-phase='identificando']")).not.toBeNull();
    expect(screen.queryByLabelText("Código de emparejamiento")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /emparejar/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/emparejamiento/i)).not.toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("un 401 al identificar entra en incidencia y no pide código de emparejamiento", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ detail: { code: "DEVICE_NOT_ENROLLED", message: "Equipo no habilitado" } }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<AsistenciaPage />);

    await user.type(screen.getByTestId("kiosk-identifier"), "71112233");
    await user.click(screen.getByTestId("kiosk-identify"));

    expect(await screen.findByTestId("kiosk-incident-message")).toBeInTheDocument();
    expect(document.querySelector("[data-phase='incidencia']")).not.toBeNull();
    expect(screen.queryByLabelText("Código de emparejamiento")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /emparejar/i })).not.toBeInTheDocument();
    const paths = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(paths).toHaveLength(1);
    expect(paths[0]).toContain("/api/v1/attendance/identify");
    expect(paths.some((path) => path.includes("pair"))).toBe(false);
  });
});
