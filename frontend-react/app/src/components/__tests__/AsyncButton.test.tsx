import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AsyncButton } from "@/components/AsyncButton";

describe("AsyncButton — crossfade estable normal/busy", () => {
  it("muestra el contenido normal y mantiene oculta la capa busy", () => {
    render(<AsyncButton>Registrar terminal</AsyncButton>);

    const button = screen.getByRole("button", { name: "Registrar terminal" });
    expect(button).not.toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "false");

    const layers = button.querySelectorAll(".async-button__layer");
    expect(layers).toHaveLength(2);
    expect(layers[0]).toHaveAttribute("aria-hidden", "false");
    expect(layers[1]).toHaveAttribute("aria-hidden", "true");
  });

  it("con busy expone busyLabel, deshabilita y conserva ambas capas montadas", () => {
    render(
      <AsyncButton busy busyLabel="Registrando…">
        Registrar terminal
      </AsyncButton>,
    );

    const button = screen.getByRole("button", { name: "Registrando…" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");

    const layers = button.querySelectorAll(".async-button__layer");
    // Ambas capas permanecen en el mismo grid cell: sin cambio de ancho ni layout.
    expect(layers).toHaveLength(2);
    expect(layers[0]).toHaveAttribute("aria-hidden", "true");
    expect(layers[1]).toHaveAttribute("aria-hidden", "false");
  });
});
