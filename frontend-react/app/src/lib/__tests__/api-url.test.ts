import { describe, expect, it } from "vitest";
import { resolveApiUrl } from "@/lib/api";

/**
 * Contrato de configuración del API (migración Next -> Vite en Vercel).
 *
 * El objetivo es que el bundle de producción jamás use `http://localhost:8000`
 * de forma silenciosa, sin romper el desarrollo local ni las pruebas E2E.
 */
describe("resolveApiUrl", () => {
  it("conserva el fallback local en desarrollo/E2E", () => {
    expect(resolveApiUrl(undefined, false)).toBe("http://localhost:8000");
    expect(resolveApiUrl(null, false)).toBe("http://localhost:8000");
    expect(resolveApiUrl("", false)).toBe("http://localhost:8000");
    expect(resolveApiUrl("   ", false)).toBe("http://localhost:8000");
  });

  it("acepta una URL pública en producción", () => {
    expect(resolveApiUrl("https://backend.up.railway.app", true)).toBe(
      "https://backend.up.railway.app",
    );
  });

  it("normaliza la barra final", () => {
    expect(resolveApiUrl("https://backend.up.railway.app/", true)).toBe(
      "https://backend.up.railway.app",
    );
    expect(resolveApiUrl("http://127.0.0.1:8000/", false)).toBe(
      "http://127.0.0.1:8000",
    );
  });

  it("falla claro si producción no define VITE_API_URL", () => {
    expect(() => resolveApiUrl(undefined, true)).toThrow(/falta VITE_API_URL/i);
    expect(() => resolveApiUrl("", true)).toThrow(/falta VITE_API_URL/i);
  });

  it("rechaza loopback en producción (no hay fallback silencioso)", () => {
    expect(() => resolveApiUrl("http://localhost:8000", true)).toThrow(
      /loopback/i,
    );
    expect(() => resolveApiUrl("http://127.0.0.1:8000", true)).toThrow(
      /loopback/i,
    );
    expect(() => resolveApiUrl("http://[::1]:8000", true)).toThrow(/loopback/i);
    expect(() => resolveApiUrl("https://localhost:8000", true)).toThrow(
      /loopback/i,
    );
  });

  it("exige https en producción (evita mixed content)", () => {
    expect(() => resolveApiUrl("http://backend.example.com", true)).toThrow(
      /https|mixed content/i,
    );
  });

  it("permite http local en desarrollo", () => {
    expect(resolveApiUrl("http://127.0.0.1:8000", false)).toBe(
      "http://127.0.0.1:8000",
    );
    expect(resolveApiUrl("http://localhost:8000", false)).toBe(
      "http://localhost:8000",
    );
  });

  it("rechaza valores que no son URL absoluta o no son http(s)", () => {
    expect(() => resolveApiUrl("no es una url", false)).toThrow(
      /URL absoluta/i,
    );
    expect(() => resolveApiUrl("ftp://example.com", false)).toThrow(
      /http o https/i,
    );
    expect(() => resolveApiUrl("localhost:8000", false)).toThrow(
      /http o https/i,
    );
  });
});
