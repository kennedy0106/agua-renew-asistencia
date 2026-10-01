import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { routeLoaders } from "@/lib/routePreload";

// Vitest corre desde la raíz de la app (`frontend-react/app`).
const globalsCss = readFileSync(resolve("src/styles/globals.css"), "utf8");
const appSource = readFileSync(resolve("src/App.tsx"), "utf8");
const preloadSource = readFileSync(resolve("src/lib/routePreload.ts"), "utf8");

describe("globals.css — movimiento de navegación", () => {
  it("no conserva la barra superior tipo navegador", () => {
    expect(globalsCss).not.toContain("topbar-progress");
    expect(appSource).not.toContain("topbar-progress");
  });

  it("rota el spinner con transform y reserva un pulso gentil a movimiento reducido", () => {
    expect(globalsCss).toMatch(/@keyframes\s+spin-rotate\s*{[^}]*rotate\(360deg\)/);
    // El wrapper `.spin` es quien rota; el SVG interior queda estático.
    expect(globalsCss).toMatch(/\.spin\s*{[^}]*display:\s*inline-flex[^}]*animation:\s*spin-rotate[^}]*linear/);
    expect(globalsCss).toMatch(/\.spin\s*>\s*svg\s*{/);
    expect(globalsCss).toMatch(/\.spin\s*{[^}]*fade-pulse/);
  });

  it("define el indicador circular y el fallback de marca por clases CSS", () => {
    expect(globalsCss).toMatch(/\.route-loading\s*{/);
    expect(globalsCss).toMatch(/\.route-loading\.is-active\s*{/);
    expect(globalsCss).toMatch(/\.route-fallback\s*{/);
    expect(globalsCss).toMatch(/@keyframes\s+page-enter\s*{/);
  });
});

describe("routePreload — un único import por página", () => {
  it("declara exactamente un import dinámico por loader y App los reutiliza", () => {
    const pageImports = preloadSource.match(/import\("@\/pages\//g) ?? [];
    const lazyCalls = appSource.match(/lazy\(routeLoaders\[/g) ?? [];

    expect(pageImports).toHaveLength(Object.keys(routeLoaders).length);
    expect(lazyCalls).toHaveLength(Object.keys(routeLoaders).length);
    // App no vuelve a importar páginas por su cuenta: sólo usa el registro.
    expect(appSource).not.toMatch(/import\("@\/pages\//);
  });
});
