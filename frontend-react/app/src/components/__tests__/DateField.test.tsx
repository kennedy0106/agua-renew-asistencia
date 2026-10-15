import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import DateField from "@/components/DateField";

describe("DateField — salida del popover", () => {
  it("abre el calendario y con Escape lo cierra con salida visible devolviendo el foco", async () => {
    const onChange = vi.fn();
    render(
      <DateField value="" onChange={onChange} placeholder="Seleccionar fecha" aria-label="Fecha" />,
    );

    const trigger = screen.getByRole("button", { name: "Fecha" });
    fireEvent.click(trigger);

    const dialog = await screen.findByRole("dialog", { name: "Calendario: Fecha" });
    expect(dialog).toHaveAttribute("data-state", "open");
    // Origen horizontal exacto en px, con top/bottom como segundo componente.
    expect(dialog.style.transformOrigin).toMatch(/^\d+px (top|bottom)$/);

    fireEvent.keyDown(document, { key: "Escape" });

    // El nodo portaleado se conserva mientras corre la transición de salida.
    expect(screen.getByRole("dialog", { name: "Calendario: Fecha" })).toHaveAttribute(
      "data-state",
      "closing",
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Calendario: Fecha" }),
      ).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("al elegir un día notifica la ISO y cierra el calendario", async () => {
    const onChange = vi.fn();
    render(
      <DateField value="2026-03-10" onChange={onChange} placeholder="Seleccionar fecha" aria-label="Fecha" />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Fecha" }));
    const dialog = await screen.findByRole("dialog", { name: "Calendario: Fecha" });
    // El día 15 es un botón dentro del panel con el número visible.
    const day = Array.from(dialog.querySelectorAll<HTMLButtonElement>(".datefield-day")).find(
      (button) => button.textContent === "15",
    );
    expect(day).toBeTruthy();
    fireEvent.click(day!);

    expect(onChange).toHaveBeenCalledWith("2026-03-15");
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Calendario: Fecha" }),
      ).not.toBeInTheDocument(),
    );
  });
});
