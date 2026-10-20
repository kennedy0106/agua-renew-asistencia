import { act, render, screen } from "@testing-library/react";
import { useInsertionEffect } from "react";
import userEvent from "@testing-library/user-event";
import {
  Link,
  MemoryRouter,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useNavigationType,
} from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAdminScrollContinuity } from "@/lib/adminScrollContinuity";

let scrollTop = 0;
let scrollHeight = 700;
let scrollToMock: ReturnType<typeof vi.fn>;

/**
 * Simula el clamp que aplica el navegador al montar una página corta: ocurre
 * después de la mutación del DOM y antes de los layout effects del shell, así
 * que el host no puede leer `scrollY` para saber dónde estaba la página previa.
 */
function ShortDestination() {
  useInsertionEffect(() => {
    scrollTop = 0;
    scrollHeight = 200;
  }, []);
  return <p>Ruta B</p>;
}

function ContinuityHarness() {
  const location = useLocation();
  const navigationType = useNavigationType();
  const navigate = useNavigate();

  useAdminScrollContinuity({ locationKey: location.key, navigationType });

  return (
    <>
      <Link to="/a">Ir A</Link>
      <Link to="/b">Ir B</Link>
      <Link to="/c">Ir C</Link>
      <button type="button" onClick={() => navigate(-1)}>
        Atrás
      </button>
      <button type="button" onClick={() => navigate(1)}>
        Adelante
      </button>
      <p data-testid="path">{location.pathname}</p>
      <Routes>
        <Route path="/a" element={<p>Ruta A</p>} />
        <Route path="/b" element={<ShortDestination />} />
        <Route path="/c" element={<p>Ruta C</p>} />
      </Routes>
    </>
  );
}

function renderHarness(initialPath = "/a") {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <ContinuityHarness />
    </MemoryRouter>,
  );
}

async function settle(ms = 20) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

beforeEach(() => {
  scrollTop = 0;
  scrollHeight = 700;
  Object.defineProperty(window, "scrollY", {
    configurable: true,
    get: () => scrollTop,
  });
  Object.defineProperty(window, "innerHeight", {
    configurable: true,
    value: 700,
  });
  Object.defineProperty(document.documentElement, "scrollHeight", {
    configurable: true,
    get: () => scrollHeight,
  });
  scrollToMock = vi.fn((options: ScrollToOptions | number, y?: number) => {
    const next = typeof options === "number" ? y ?? 0 : options.top ?? 0;
    scrollTop = next;
  });
  vi.spyOn(window, "scrollTo").mockImplementation(scrollToMock as typeof window.scrollTo);
});

describe("useAdminScrollContinuity", () => {
  it("una ruta PUSH nueva empieza arriba", async () => {
    const user = userEvent.setup();
    renderHarness();

    scrollTop = 240;
    await user.click(screen.getByRole("link", { name: "Ir B" }));

    expect(await screen.findByText("Ruta B")).toBeInTheDocument();
    expect(scrollToMock).toHaveBeenCalledWith({ top: 0, left: 0, behavior: "auto" });
    expect(scrollTop).toBe(0);
  });

  it("no pisa la posición grabada con el clamp postcommit: PUSH arriba y POP restaura", async () => {
    const user = userEvent.setup();
    renderHarness();

    // La posición 376 llega por el evento real de scroll, no por el rerender.
    scrollTop = 376;
    window.dispatchEvent(new Event("scroll"));
    await settle(30);

    // Al montar B, el DOM nuevo ya limitó el scroll a 0 antes del efecto de
    // cambio de locationKey. La entrada A debe conservar 376.
    await user.click(screen.getByRole("link", { name: "Ir B" }));
    expect(await screen.findByText("Ruta B")).toBeInTheDocument();
    expect(scrollTop).toBe(0);
    expect(scrollToMock).toHaveBeenCalledWith({ top: 0, left: 0, behavior: "auto" });

    await user.click(screen.getByRole("button", { name: "Atrás" }));
    expect(await screen.findByText("Ruta A")).toBeInTheDocument();
    expect(scrollTop).toBe(0);

    scrollHeight = 1500;
    await settle(140);
    expect(scrollToMock).toHaveBeenCalledWith({ top: 376, left: 0, behavior: "auto" });
    expect(scrollTop).toBe(376);
  });

  it("cancelar la restauración al cambiar de ruta conserva la posición de la entrada", async () => {
    const user = userEvent.setup();
    renderHarness();

    scrollTop = 376;
    window.dispatchEvent(new Event("scroll"));
    await settle(30);

    await user.click(screen.getByRole("link", { name: "Ir B" }));
    expect(await screen.findByText("Ruta B")).toBeInTheDocument();

    // Vuelta a A con contenido corto: la restauración queda pendiente.
    await user.click(screen.getByRole("button", { name: "Atrás" }));
    expect(await screen.findByText("Ruta A")).toBeInTheDocument();

    // Nueva navegación antes de que A crezca. La cancelación no debe escribir
    // el 0 actual como posición guardada de A.
    await user.click(screen.getByRole("link", { name: "Ir B" }));
    expect(await screen.findByText("Ruta B")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Atrás" }));
    expect(await screen.findByText("Ruta A")).toBeInTheDocument();

    scrollHeight = 1500;
    await settle(140);
    expect(scrollToMock).toHaveBeenCalledWith({ top: 376, left: 0, behavior: "auto" });
    expect(scrollTop).toBe(376);
  });

  it("POP recupera la posición aunque el contenido asíncrono crezca después", async () => {
    const user = userEvent.setup();
    renderHarness();

    scrollTop = 500;
    await user.click(screen.getByRole("link", { name: "Ir B" }));
    expect(await screen.findByText("Ruta B")).toBeInTheDocument();
    scrollToMock.mockClear();

    // La tabla aún no tiene altura suficiente para 500px.
    await user.click(screen.getByRole("button", { name: "Atrás" }));
    expect(await screen.findByText("Ruta A")).toBeInTheDocument();
    expect(scrollToMock).toHaveBeenCalledWith({ top: 0, left: 0, behavior: "auto" });
    expect(scrollTop).toBe(0);

    // Los datos llegan y la página crece: el reintento alcanza el objetivo.
    scrollHeight = 1500;
    await settle(140);
    expect(scrollToMock).toHaveBeenCalledWith({ top: 500, left: 0, behavior: "auto" });
    expect(scrollTop).toBe(500);
  });

  it("un gesto manual del usuario cancela la restauración pendiente", async () => {
    const user = userEvent.setup();
    renderHarness();

    scrollTop = 500;
    await user.click(screen.getByRole("link", { name: "Ir B" }));
    expect(await screen.findByText("Ruta B")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Atrás" }));
    expect(await screen.findByText("Ruta A")).toBeInTheDocument();

    await act(async () => {
      window.dispatchEvent(new Event("wheel"));
    });
    scrollToMock.mockClear();

    scrollHeight = 1500;
    await settle(140);

    expect(scrollToMock).not.toHaveBeenCalledWith({
      top: 500,
      left: 0,
      behavior: "auto",
    });
  });

  it("cancela el reintento al cambiar de ruta y al desmontar", async () => {
    const user = userEvent.setup();
    const { unmount } = renderHarness();

    scrollTop = 500;
    await user.click(screen.getByRole("link", { name: "Ir B" }));
    expect(await screen.findByText("Ruta B")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Atrás" }));
    expect(await screen.findByText("Ruta A")).toBeInTheDocument();

    // Cambiar de ruta descarta la restauración pendiente de la entrada anterior.
    await user.click(screen.getByRole("link", { name: "Ir C" }));
    expect(await screen.findByText("Ruta C")).toBeInTheDocument();
    scrollToMock.mockClear();
    scrollHeight = 1500;
    await settle(140);
    expect(scrollToMock).not.toHaveBeenCalledWith({
      top: 500,
      left: 0,
      behavior: "auto",
    });

    unmount();
    scrollToMock.mockClear();

    // Un montaje nuevo tampoco deja timers vivos tras desmontarse.
    const second = renderHarness();
    scrollTop = 500;
    await user.click(screen.getByRole("link", { name: "Ir B" }));
    expect(await screen.findByText("Ruta B")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Atrás" }));
    expect(await screen.findByText("Ruta A")).toBeInTheDocument();
    second.unmount();
    scrollToMock.mockClear();
    scrollHeight = 1500;
    await settle(140);
    expect(scrollToMock).not.toHaveBeenCalledWith({
      top: 500,
      left: 0,
      behavior: "auto",
    });
  });
});
