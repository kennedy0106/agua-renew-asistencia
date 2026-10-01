import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import MonthField from "@/components/MonthField";

describe("MonthField — salida del popover", () => {
  it("abre, selecciona un mes y conserva el nodo durante la salida antes de desmontarlo", async () => {
    const onChange = vi.fn();
    render(<MonthField value="2026-03" onChange={onChange} aria-label="Mes" />);

    fireEvent.click(screen.getByRole("button", { name: "Mes" }));
    expect(screen.getByRole("dialog", { name: "Seleccionar mes" })).toHaveAttribute(
      "data-state",
      "open",
    );

    fireEvent.click(screen.getByRole("button", { name: "Abr" }));
    expect(onChange).toHaveBeenCalledWith("2026-04");

    // El nodo se conserva un instante para que la salida sea visible.
    expect(screen.getByRole("dialog", { name: "Seleccionar mes" })).toHaveAttribute(
      "data-state",
      "closing",
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Seleccionar mes" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("devuelve el foco al trigger tras cerrar con Escape", async () => {
    render(<MonthField value="2026-03" onChange={() => {}} aria-label="Mes" />);
    const trigger = screen.getByRole("button", { name: "Mes" });

    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "Seleccionar mes" })).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(trigger).toHaveFocus());
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Seleccionar mes" }),
      ).not.toBeInTheDocument(),
    );
  });
});
