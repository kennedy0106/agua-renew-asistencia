import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import IntentLink from "@/components/IntentLink";
import { preloadRoute } from "@/lib/routePreload";

vi.mock("@/lib/routePreload", () => ({ preloadRoute: vi.fn() }));

function renderLink(
  onNavigate: () => void,
  onClick?: (event: React.MouseEvent<HTMLAnchorElement>) => void,
  target?: string,
) {
  return render(
    <MemoryRouter>
      <IntentLink href="/admin/dashboard" onNavigate={onNavigate} onClick={onClick} target={target}>
        Panel
      </IntentLink>
    </MemoryRouter>,
  );
}

const preloadMock = vi.mocked(preloadRoute);

beforeEach(() => {
  vi.clearAllMocks();
});

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

describe("IntentLink — precarga de chunk", () => {
  it("precarga al recibir foco (navegación con teclado)", () => {
    renderLink(vi.fn());
    const link = screen.getByRole("link", { name: "Panel" });

    fireEvent.focusIn(link);
    expect(preloadMock).toHaveBeenCalledWith("/admin/dashboard");
  });

  it("precarga en hover solo tras el retardo de intención", () => {
    vi.useFakeTimers();
    renderLink(vi.fn());
    const link = screen.getByRole("link", { name: "Panel" });

    fireEvent.mouseEnter(link);
    expect(preloadMock).not.toHaveBeenCalled();

    vi.advanceTimersByTime(80);
    expect(preloadMock).toHaveBeenCalledWith("/admin/dashboard");
    vi.useRealTimers();
  });

  it("precarga en pointerdown y en el clic primario", () => {
    renderLink(vi.fn());
    const link = screen.getByRole("link", { name: "Panel" });

    fireEvent.pointerDown(link);
    fireEvent.click(link, { button: 0 });

    expect(preloadMock).toHaveBeenCalledTimes(2);
  });

  it("no precarga pointerdown con modificadores ni con botón no primario", () => {
    renderLink(vi.fn());
    const link = screen.getByRole("link", { name: "Panel" });

    fireEvent.pointerDown(link, { button: 2 });
    fireEvent.pointerDown(link, { button: 0, ctrlKey: true });

    expect(preloadMock).not.toHaveBeenCalled();
  });

  it("no precarga un clic con modificadores", () => {
    renderLink(vi.fn());

    fireEvent.click(screen.getByRole("link", { name: "Panel" }), { button: 0, ctrlKey: true });

    expect(preloadMock).not.toHaveBeenCalled();
  });

  it("no precarga un enlace que abre en otra pestaña", () => {
    renderLink(vi.fn(), undefined, "_blank");
    const link = screen.getByRole("link", { name: "Panel" });

    fireEvent.focusIn(link);
    fireEvent.click(link, { button: 0 });

    expect(preloadMock).not.toHaveBeenCalled();
  });
});
