import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Spinner, StatSkeleton } from "@/components/Loading";

describe("Spinner — wrapper animado", () => {
  it("rota el wrapper y deja el SVG interior estático", () => {
    const { container } = render(<Spinner />);

    const wrapper = container.querySelector<HTMLElement>(".spin");
    const svg = wrapper?.querySelector("svg") ?? null;

    expect(wrapper).not.toBeNull();
    expect(wrapper).toHaveAttribute("aria-hidden");
    expect(svg).not.toBeNull();
    // El SVG no lleva la clase animada: la rotación vive en el wrapper.
    expect(svg).not.toHaveClass("spin");
    expect(wrapper).toContainElement(svg);
  });

  it("conserva el tamaño solicitado en el SVG", () => {
    const { container } = render(<Spinner size={24} />);
    const svg = container.querySelector("svg");

    expect(svg).toHaveAttribute("width", "24");
    expect(svg).toHaveAttribute("height", "24");
  });
});

describe("StatSkeleton — coherente con MetricCard", () => {
  it("usa la rejilla y el material del patrón de métrica compartido", () => {
    const { container } = render(<StatSkeleton count={3} />);

    expect(container.querySelector(".metric-grid.metric-skeleton")).not.toBeNull();
    expect(container.querySelectorAll(".metric-card")).toHaveLength(3);
    // El esqueleto es decorativo: no compite con el árbol accesible.
    expect(container.firstElementChild).toHaveAttribute("aria-hidden", "true");
  });
});
