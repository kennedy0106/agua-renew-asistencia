import { afterEach, describe, expect, it, vi } from "vitest";
import { prefersReducedMotion } from "@/lib/motion";
import { scrollIntoViewRespectingMotion } from "@/lib/scroll";

function mockReducedMotion(matches: boolean) {
  return vi.spyOn(window, "matchMedia").mockImplementation(
    (query: string) =>
      ({
        matches,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("prefersReducedMotion", () => {
  it("refleja la preferencia del sistema", () => {
    mockReducedMotion(true);
    expect(prefersReducedMotion()).toBe(true);
    mockReducedMotion(false);
    expect(prefersReducedMotion()).toBe(false);
  });
});

describe("scrollIntoViewRespectingMotion", () => {
  function fakeElement() {
    return { scrollIntoView: vi.fn() } as unknown as Element;
  }

  it("hace desplazamiento suave cuando no hay preferencia de movimiento reducido", () => {
    mockReducedMotion(false);
    const element = fakeElement();
    scrollIntoViewRespectingMotion(element, { block: "nearest" });
    expect(element.scrollIntoView).toHaveBeenCalledWith({
      block: "nearest",
      behavior: "smooth",
    });
  });

  it("salta de inmediato cuando el usuario pide movimiento reducido", () => {
    mockReducedMotion(true);
    const element = fakeElement();
    scrollIntoViewRespectingMotion(element, { block: "nearest" });
    expect(element.scrollIntoView).toHaveBeenCalledWith({
      block: "nearest",
      behavior: "auto",
    });
  });

  it("ignora elementos nulos", () => {
    expect(() => scrollIntoViewRespectingMotion(null)).not.toThrow();
  });
});
