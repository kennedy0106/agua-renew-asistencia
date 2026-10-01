import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Notifications, useNotifications } from "@/components/Notifications";

// Constantes del componente (no exportadas): se reflejan aquí para que la
// prueba sea explícita sobre los tiempos que verifica.
const AUTO_DISMISS_MS = 5000;
const EXIT_MS = 220;

function NoticeTriggers() {
  const { success, error } = useNotifications();
  return (
    <div>
      <button type="button" onClick={() => success("Guardado")}>éxito</button>
      <button type="button" onClick={() => error("Falló")}>error</button>
    </div>
  );
}

function renderNotifications() {
  return render(
    <Notifications>
      <NoticeTriggers />
    </Notifications>,
  );
}

function noticeNodeFor(message: string): HTMLElement {
  const messageEl = screen.getByText(message);
  const node = messageEl.closest(".notification");
  if (!node) throw new Error(`No se encontró el nodo .notification para "${message}"`);
  return node as HTMLElement;
}

function triggerSuccess() {
  fireEvent.click(screen.getByRole("button", { name: "éxito" }));
}

// Cola manual de frames: controla exactamente cuándo corre el rAF del
// lifecycle, sin depender de la implementación de rAF de jsdom/sinon.
let frames: FrameRequestCallback[] = [];
let frameId = 0;

async function flushFrame() {
  const pending = frames;
  frames = [];
  await act(async () => {
    pending.forEach((callback) => callback(0));
  });
}

beforeEach(() => {
  frames = [];
  frameId = 0;
  // Solo se falsean los timers que usa el componente (auto-dismiss + exit);
  // rAF queda real y se reemplaza por la cola manual de arriba.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frameId += 1;
    frames.push(callback);
    return frameId;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Notifications — lifecycle de entrada/salida", () => {
  it("entra en 'enter' y pasa a 'open' tras el requestAnimationFrame", async () => {
    renderNotifications();

    triggerSuccess();
    const node = noticeNodeFor("Guardado");
    expect(node).toHaveAttribute("data-state", "enter");

    await flushFrame();
    expect(node).toHaveAttribute("data-state", "open");
  });

  it("auto-dismiss marca 'exit' conservando el nodo y lo desmonta tras EXIT_MS", async () => {
    renderNotifications();
    triggerSuccess();
    await flushFrame();
    const node = noticeNodeFor("Guardado");

    // Un milisegundo antes del auto-dismiss sigue visible y en 'open'.
    await act(async () => {
      vi.advanceTimersByTime(AUTO_DISMISS_MS - 1);
    });
    expect(node).toHaveAttribute("data-state", "open");

    // Al cumplirse el auto-dismiss pasa a 'exit' pero sigue montado.
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(node).toHaveAttribute("data-state", "exit");
    expect(screen.getByText("Guardado")).toBeInTheDocument();

    // Justo antes de EXIT_MS permanece; al completarlo se desmonta.
    await act(async () => {
      vi.advanceTimersByTime(EXIT_MS - 1);
    });
    expect(screen.getByText("Guardado")).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByText("Guardado")).not.toBeInTheDocument();
  });

  it("cierre manual marca 'exit', conserva el nodo y lo desmonta tras EXIT_MS", async () => {
    renderNotifications();
    triggerSuccess();
    await flushFrame();
    const node = noticeNodeFor("Guardado");

    fireEvent.click(screen.getByRole("button", { name: "Cerrar notificación" }));
    expect(node).toHaveAttribute("data-state", "exit");
    expect(screen.getByText("Guardado")).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(EXIT_MS - 1);
    });
    expect(screen.getByText("Guardado")).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByText("Guardado")).not.toBeInTheDocument();
  });

  it("un cierre repetido no duplica efectos ni emite warnings", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    renderNotifications();
    triggerSuccess();
    await flushFrame();
    const node = noticeNodeFor("Guardado");

    const close = screen.getByRole("button", { name: "Cerrar notificación" });
    fireEvent.click(close);
    fireEvent.click(close);
    fireEvent.click(close);

    // Sigue habiendo un único aviso en 'exit' (no se duplica ni se desmonta aún).
    expect(document.querySelectorAll(".notification")).toHaveLength(1);
    expect(node).toHaveAttribute("data-state", "exit");

    // Un único barrido de EXIT_MS lo desmonta una sola vez.
    await act(async () => {
      vi.advanceTimersByTime(EXIT_MS);
    });
    expect(document.querySelectorAll(".notification")).toHaveLength(0);
    expect(screen.queryByText("Guardado")).not.toBeInTheDocument();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("limita los avisos activos a tres y retira el más antiguo con 'exit'", async () => {
    renderNotifications();

    for (let index = 0; index < 4; index += 1) {
      triggerSuccess();
      await flushFrame();
    }

    const nodes = Array.from(document.querySelectorAll(".notification"));
    const active = nodes.filter((node) => node.getAttribute("data-state") !== "exit");
    expect(active).toHaveLength(3);
  });
});
