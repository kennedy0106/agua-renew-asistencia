import { describe, expect, it } from "vitest";
import {
  detectProduction,
  validateApiUrl,
  validateVercelConfig,
  runPreflight,
} from "./preflight.mjs";

const silent = () => {};

describe("validateApiUrl", () => {
  it("en desarrollo sin variable solo avisa (fallback local permitido)", () => {
    const result = validateApiUrl(undefined, { production: false });
    expect(result.ok).toBe(true);
    expect(result.warnings.join(" ")).toMatch(/localhost:8000/);
  });

  it("en producción sin variable es error claro", () => {
    const result = validateApiUrl(undefined, { production: true });
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/falta VITE_API_URL/i);
  });

  it("rechaza loopback en producción", () => {
    for (const value of [
      "http://localhost:8000",
      "http://127.0.0.1:8000",
      "http://[::1]:8000",
    ]) {
      const result = validateApiUrl(value, { production: true });
      expect(result.ok).toBe(false);
      expect(result.errors.join(" ")).toMatch(/loopback/i);
    }
  });

  it("acepta una URL pública https en producción", () => {
    const result = validateApiUrl("https://backend.up.railway.app", {
      production: true,
    });
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("exige https en producción (evita mixed content)", () => {
    const result = validateApiUrl("http://backend.example.com", {
      production: true,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/https|mixed content/i);
  });

  it("permite http local en desarrollo", () => {
    expect(
      validateApiUrl("http://127.0.0.1:8000", { production: false }).ok,
    ).toBe(true);
    expect(validateApiUrl("ftp://example.com", { production: false }).ok).toBe(
      false,
    );
  });

  it("rechaza valores no-URL y esquemas no http(s)", () => {
    expect(validateApiUrl("no es una url", { production: true }).ok).toBe(false);
    expect(
      validateApiUrl("ftp://example.com", { production: true }).errors.join(" "),
    ).toMatch(/http o https/i);
  });
});

describe("validateVercelConfig", () => {
  const valid = {
    framework: "vite",
    installCommand: "npm ci",
    buildCommand: "npm run preflight && npm run build",
    outputDirectory: "dist",
    rewrites: [{ source: "/(.*)", destination: "/index.html" }],
  };

  it("acepta la configuración SPA de Vite", () => {
    expect(validateVercelConfig(valid)).toEqual({ ok: true, errors: [] });
  });

  it("exige outputDirectory dist", () => {
    const result = validateVercelConfig({ ...valid, outputDirectory: "build" });
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/outputDirectory/);
  });

  it("exige un rewrite SPA a /index.html", () => {
    const result = validateVercelConfig({ ...valid, rewrites: [] });
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/rewrite SPA/);
  });

  it("rechaza configuraciones que no son objeto", () => {
    expect(validateVercelConfig(null).ok).toBe(false);
    expect(validateVercelConfig([]).ok).toBe(false);
  });
});

describe("detectProduction", () => {
  it("detecta el flag explícito", () => {
    expect(detectProduction({ argv: ["--production"], env: {} })).toBe(true);
    expect(detectProduction({ argv: ["--prod"], env: {} })).toBe(true);
  });

  it("es estricto en Vercel production y preview", () => {
    expect(
      detectProduction({ argv: [], env: { VERCEL_ENV: "production" } }),
    ).toBe(true);
    expect(detectProduction({ argv: [], env: { VERCEL_ENV: "preview" } })).toBe(
      true,
    );
    expect(detectProduction({ argv: [], env: { VERCEL: "1" } })).toBe(true);
  });

  it("es estricto con PREFLIGHT_ENV de Vercel", () => {
    expect(
      detectProduction({ argv: [], env: { PREFLIGHT_ENV: "production" } }),
    ).toBe(true);
    expect(
      detectProduction({ argv: [], env: { PREFLIGHT_ENV: "preview" } }),
    ).toBe(true);
  });

  it("no es estricto en build local ni en vercel dev", () => {
    expect(detectProduction({ argv: [], env: {} })).toBe(false);
    expect(
      detectProduction({ argv: [], env: { VERCEL: "1", VERCEL_ENV: "development" } }),
    ).toBe(false);
  });
});

describe("runPreflight (vercel.json real de la app)", () => {
  it("falla en producción si falta VITE_API_URL", () => {
    const exit = runPreflight({
      argv: ["--production"],
      env: {},
      log: silent,
      error: silent,
    });
    expect(exit).toBe(1);
  });

  it("pasa en producción con una URL pública", () => {
    const exit = runPreflight({
      argv: ["--production"],
      env: { VITE_API_URL: "https://backend.up.railway.app" },
      log: silent,
      error: silent,
    });
    expect(exit).toBe(0);
  });

  it("pasa en desarrollo sin variable (fallback local)", () => {
    const exit = runPreflight({
      argv: [],
      env: {},
      log: silent,
      error: silent,
    });
    expect(exit).toBe(0);
  });

  it("falla en preview de Vercel si falta VITE_API_URL", () => {
    const exit = runPreflight({
      argv: [],
      env: { VERCEL: "1", VERCEL_ENV: "preview" },
      log: silent,
      error: silent,
    });
    expect(exit).toBe(1);
  });

  it("falla en CI de Vercel (VERCEL=1) si falta VITE_API_URL", () => {
    const exit = runPreflight({
      argv: [],
      env: { VERCEL: "1" },
      log: silent,
      error: silent,
    });
    expect(exit).toBe(1);
  });
});
