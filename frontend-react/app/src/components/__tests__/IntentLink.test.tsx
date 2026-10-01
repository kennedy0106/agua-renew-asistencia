import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import IntentLink from "@/components/IntentLink";

function renderLink(onNavigate: () => void, onClick?: (event: React.MouseEvent<HTMLAnchorElement>) => void) {
  return render(
    <MemoryRouter>
      <IntentLink href="/admin/dashboard" onNavigate={onNavigate} onClick={onClick}>
        Panel
      </IntentLink>
    </MemoryRouter>,
  );
}

describe("IntentLink — intención de navegación", () => {
  it("notifica onNavigate en un clic primario sin modificadores", () => {
    const onNavigate = vi.fn();
    renderLink(onNavigate);

    fireEvent.click(screen.getByRole("link", { name: "Panel" }), { button: 0 });

    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["ctrl", { ctrlKey: true }],
    ["meta", { metaKey: true }],
    ["shift", { shiftKey: true }],
    ["alt", { altKey: true }],
  ])("no notifica onNavigate en clic con %s", (_name, modifiers) => {
    const onNavigate = vi.fn();
    renderLink(onNavigate);

    fireEvent.click(screen.getByRole("link", { name: "Panel" }), { button: 0, ...modifiers });

    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("no notifica onNavigate en un botón no primario", () => {
    const onNavigate = vi.fn();
    renderLink(onNavigate);

    fireEvent.click(screen.getByRole("link", { name: "Panel" }), { button: 1 });

    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("no notifica onNavigate si el onClick del consumidor previene el default", () => {
    const onNavigate = vi.fn();
    renderLink(onNavigate, (event) => event.preventDefault());

    fireEvent.click(screen.getByRole("link", { name: "Panel" }), { button: 0 });

    expect(onNavigate).not.toHaveBeenCalled();
  });
});
