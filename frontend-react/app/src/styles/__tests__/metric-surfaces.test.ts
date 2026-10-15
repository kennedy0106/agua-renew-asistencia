import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Vitest corre desde la raíz de la app (`frontend-react/app`).
const globalsCss = readFileSync(resolve("src/styles/globals.css"), "utf8");
const stitchCss = readFileSync(resolve("src/styles/stitch.css"), "utf8");
const metricCardSource = readFileSync(resolve("src/components/MetricCard.tsx"), "utf8");
const loadingSource = readFileSync(resolve("src/components/Loading.tsx"), "utf8");

const LEGACY_STAT = /\.stat-(card|grid|label|value|hint|action)\b/;

describe("Métricas — patrón visual compartido", () => {
  it("stitch.css define el componente de métrica y su rejilla responsive", () => {
    expect(stitchCss).toMatch(/\.metric-card\s*{/);
    expect(stitchCss).toMatch(/\.metric-grid\s*{/);
    expect(stitchCss).toMatch(/\.metric-grid--auto\s*{/);
    // 4/2/1 columnas para el patrón KPI.
    expect(stitchCss).toMatch(/grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/);
    expect(stitchCss).toMatch(/@media \(max-width: 1040px\)\s*{[^}]*\.metric-grid/);
    expect(stitchCss).toMatch(/@media \(max-width: 460px\)/);
  });

  it("no quedan selectores de la familia legacy stat-* en el CSS", () => {
    expect(globalsCss).not.toMatch(LEGACY_STAT);
    expect(stitchCss).not.toMatch(LEGACY_STAT);
  });

  it("el componente compartido y el skeleton usan las clases canónicas", () => {
    expect(metricCardSource).toContain('"metric-card"');
    expect(metricCardSource).not.toMatch(/stat-(card|grid|label|value|hint)/);
    expect(loadingSource).toContain("metric-grid");
    expect(loadingSource).toContain("metric-card");
    expect(loadingSource).not.toMatch(/stat-(card|grid)/);
  });

  it("stitch.css centraliza el material de superficies no métricas", () => {
    expect(stitchCss).toContain(".surface-material,");
    expect(stitchCss).toContain(".surface-material--inset,");
    // El material compartido no usa vidrio ni blur decorativo.
    expect(stitchCss).toMatch(/\.surface-material,[\s\S]*?backdrop-filter:\s*none/);
  });
});
