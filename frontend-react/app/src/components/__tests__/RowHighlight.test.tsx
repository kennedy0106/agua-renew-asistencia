import { act } from "@testing-library/react";
import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRowHighlight } from "@/components/RowHighlight";

afterEach(() => {
  vi.useRealTimers();
});

describe("useRowHighlight — feedback de fila exacta", () => {
  it("marca solo el id guardado y lo libera al vencer el tiempo", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useRowHighlight(1000));

    expect(result.current.isHighlighted("a")).toBe(false);

    act(() => result.current.markSaved("a"));
    expect(result.current.highlightedId).toBe("a");
    expect(result.current.isHighlighted("a")).toBe(true);
    // Otras filas nunca se marcan: no se anima la tabla entera.
    expect(result.current.isHighlighted("b")).toBe(false);

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current.highlightedId).toBeNull();
  });

  it("reinicia el temporizador si se guarda otra fila antes de vencer", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useRowHighlight(1000));

    act(() => result.current.markSaved("a"));
    act(() => {
      vi.advanceTimersByTime(600);
    });
    act(() => result.current.markSaved("b"));
    expect(result.current.isHighlighted("a")).toBe(false);
    expect(result.current.isHighlighted("b")).toBe(true);

    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(result.current.highlightedId).toBe("b");

    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(result.current.highlightedId).toBeNull();
  });
});
