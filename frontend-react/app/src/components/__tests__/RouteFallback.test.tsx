import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import RouteFallback from "@/components/RouteFallback";

describe("RouteFallback", () => {
  it("anuncia el estado de carga con un fallback de marca", () => {
    const { container } = render(<RouteFallback />);

    const status = screen.getByRole("status");
    expect(status).toHaveClass("route-fallback");
    expect(status).toHaveAttribute("aria-busy", "true");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(screen.getByText("Cargando…")).toBeInTheDocument();
    expect(container.querySelector(".route-fallback-badge")).not.toBeNull();
    expect(container.querySelector(".route-fallback-badge img")).not.toBeNull();
    expect(container.querySelector(".spin")).not.toBeNull();
  });

  it("no usa estilos inline", () => {
    const { container } = render(<RouteFallback />);

    expect(container.querySelector("[style]")).toBeNull();
  });
});
