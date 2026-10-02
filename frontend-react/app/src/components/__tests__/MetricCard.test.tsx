import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import MetricCard from "@/components/MetricCard";

function renderCard(ui: Parameters<typeof render>[0]) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

describe("MetricCard — superficie de métrica compartida", () => {
  it("renderiza un enlace interno cuando recibe href y expone nombre accesible", () => {
    renderCard(<MetricCard href="#metricas" tone="blue" label="Empleados activos" value={12} unit="asignados" chip="100%" />);

    const link = screen.getByRole("link", { name: /Empleados activos: 12/i });
    expect(link).toHaveClass("metric-card", "metric-card--blue", "metric-card--lg", "is-interactive");
    expect(link).toHaveAttribute("data-interactive", "true");
    expect(link.getAttribute("href")).toContain("#metricas");
    // El enlace interactivo muestra la flecha de affordance.
    expect(link.querySelector(".metric-card-arrow")).not.toBeNull();
  });

  it("renderiza un botón cuando solo hay onClick", () => {
    const onClick = vi.fn();
    renderCard(<MetricCard tone="red" label="Sin entrada hoy" value={3} unit="ausentes" onClick={onClick} />);

    const button = screen.getByRole("button", { name: /Sin entrada hoy: 3/i });
    expect(button).toHaveClass("metric-card", "metric-card--red");
    expect(button).toHaveAttribute("type", "button");
  });

  it("no fabrica enlace ni botón para una métrica informativa", () => {
    const { container } = renderCard(<MetricCard tone="neutral" label="Sueldo base" value="S/ 1,200.00" />);

    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    const card = container.querySelector(".metric-card");
    expect(card).not.toBeNull();
    expect(card).toHaveAttribute("data-interactive", "false");
    // Sin interacción no hay flecha ni affordance de navegación.
    expect(card?.querySelector(".metric-card-arrow")).toBeNull();
  });

  it("invoca onClick al activar un enlace que además navega", async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    renderCard(<MetricCard href="#incidencias" label="Entradas abiertas" value={2} onClick={onClick} />);

    await user.click(screen.getByRole("link", { name: /Entradas abiertas: 2/i }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("soporta todos los tonos con su clase de acento", () => {
    const tones = ["blue", "green", "red", "neutral", "amber"] as const;
    renderCard(
      <>
        {tones.map((tone) => (
          <MetricCard key={tone} tone={tone} label={`Métrica ${tone}`} value={1} data-testid={`card-${tone}`} />
        ))}
      </>,
    );

    for (const tone of tones) {
      const card = screen.getByTestId(`card-${tone}`);
      expect(card).toHaveClass(`metric-card--${tone}`);
      expect(card.querySelector(`.metric-card-accent`)).not.toBeNull();
    }
  });

  it("distingue chip (estado) de texto de apoyo sin chip", () => {
    const { rerender } = renderCard(<MetricCard label="Con chip" value={1} chip="Crítico · atención" />);
    const chip = document.querySelector(".metric-card-chip");
    expect(chip).not.toBeNull();
    expect(chip).toHaveTextContent("Crítico · atención");

    rerender(
      <MemoryRouter>
        <MetricCard label="Con apoyo" value={1} supportingText="Vigente desde 2026-01-01" />
      </MemoryRouter>,
    );
    expect(document.querySelector(".metric-card-chip")).toBeNull();
    expect(document.querySelector(".metric-card-support")).toHaveTextContent("Vigente desde 2026-01-01");
  });

  it("oculta el pie cuando no hay chip ni texto de apoyo", () => {
    const { container } = renderCard(<MetricCard label="Solo valor" value={9} />);
    expect(container.querySelector(".metric-card-foot")).toBeNull();
  });
});
