import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { Collapse } from "@/components/Collapse";

function Harness({ initialOpen = false }: { initialOpen?: boolean }) {
  const [open, setOpen] = useState(initialOpen);
  return (
    <>
      <button type="button" onClick={() => setOpen((value) => !value)}>
        alternar
      </button>
      <Collapse open={open} id="panel">
        <p>Contenido del desglose</p>
        <button type="button">Acción interna</button>
      </Collapse>
    </>
  );
}

function panel(): HTMLElement | null {
  return document.getElementById("panel");
}

describe("Collapse", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("mantiene el DOM durante el cierre, lo marca inerte y lo retira al terminar", () => {
    render(<Harness initialOpen />);

    expect(panel()).not.toBeNull();
    expect(panel()).not.toHaveAttribute("aria-hidden");
    expect(screen.getByText("Contenido del desglose")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "alternar" }));

    // La salida conserva el DOM para poder medirla, pero ya no es accesible ni
    // enfocable.
    expect(panel()).not.toBeNull();
    expect(panel()).toHaveAttribute("aria-hidden", "true");
    expect(panel()).toHaveAttribute("inert");
    expect(screen.queryByRole("button", { name: "Acción interna" })).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(400);
    });

    expect(panel()).toBeNull();
  });

  it("abre desde cero, fija la altura medida y termina en altura natural", () => {
    const scrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get: () => 120,
    });

    try {
      render(<Harness />);
      expect(panel()).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "alternar" }));

      expect(panel()).not.toBeNull();
      expect(panel()?.style.height).toBe("120px");
      expect(screen.getByText("Contenido del desglose")).toBeInTheDocument();

      act(() => {
        vi.advanceTimersByTime(400);
      });

      expect(panel()?.style.height).toBe("auto");
      expect(panel()).not.toHaveAttribute("aria-hidden");
    } finally {
      if (scrollHeight) Object.defineProperty(HTMLElement.prototype, "scrollHeight", scrollHeight);
    }
  });

  it("con movimiento reducido abre y cierra sin animación de altura", () => {
    vi.spyOn(window, "matchMedia").mockImplementation(
      (query: string) =>
        ({
          matches: query.includes("prefers-reduced-motion"),
          media: query,
          onchange: null,
          addListener: () => {},
          removeListener: () => {},
          addEventListener: () => {},
          removeEventListener: () => {},
          dispatchEvent: () => false,
        }) as unknown as MediaQueryList,
    );

    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "alternar" }));

    expect(panel()?.style.height).toBe("auto");
    expect(panel()?.style.transition).toBe("none");

    fireEvent.click(screen.getByRole("button", { name: "alternar" }));
    expect(panel()).toBeNull();
  });

  it("reabre desde el cierre sin perder el contenido ni el estado de la fila", () => {
    render(<Harness initialOpen />);
    const toggle = screen.getByRole("button", { name: "alternar" });

    fireEvent.click(toggle);
    expect(panel()).toHaveAttribute("inert");

    fireEvent.click(toggle);
    expect(panel()).not.toBeNull();
    expect(panel()).not.toHaveAttribute("aria-hidden");
    expect(panel()).not.toHaveAttribute("inert");
    expect(screen.getByText("Contenido del desglose")).toBeInTheDocument();
  });
});
