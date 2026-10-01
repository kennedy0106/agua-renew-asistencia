#!/usr/bin/env node
/**
 * Preflight de la configuración productiva del frontend React + Vite.
 *
 * No despliega, no enlaza proyectos y no lee secretos: solo valida que el
 * repositorio tenga una configuración apta para Vercel y que la base del API
 * no caiga silenciosamente a `localhost`.
 *
 * Uso:
 *   node scripts/preflight.mjs               # modo desarrollo (permisivo)
 *   node scripts/preflight.mjs --production  # exige VITE_API_URL pública
 *
 * Variables leídas: VITE_API_URL, VERCEL, VERCEL_ENV, PREFLIGHT_ENV.
 * En el build de Vercel (preview y production) `VERCEL_ENV` activa el modo
 * estricto, así que el build desplegado falla si falta `VITE_API_URL`. El build
 * local documentado (`npm run build`) no se ve afectado.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Raíz de la app (`frontend-react/app`), un nivel arriba de `scripts/`. */
export const APP_ROOT = resolve(HERE, "..");

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function isLoopbackHost(hostname) {
  return LOOPBACK_HOSTS.has(String(hostname ?? "").toLowerCase());
}

/**
 * Valida el contrato de `VITE_API_URL`.
 * @returns {{ ok: boolean, errors: string[], warnings: string[] }}
 */
export function validateApiUrl(raw, { production }) {
  const errors = [];
  const warnings = [];
  const value = typeof raw === "string" ? raw.trim() : "";

  if (value === "") {
    if (production) {
      errors.push(
        "falta VITE_API_URL: el bundle de producción no puede caer a localhost. " +
          "Define la URL pública del API en Vercel (Production y Preview).",
      );
    } else {
      warnings.push(
        "VITE_API_URL no definida: desarrollo usará http://localhost:8000.",
      );
    }
    return { ok: errors.length === 0, errors, warnings };
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    errors.push(`VITE_API_URL no es una URL absoluta válida ("${value}").`);
    return { ok: false, errors, warnings };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    errors.push(
      `VITE_API_URL debe usar http o https (recibido "${parsed.protocol}").`,
    );
  }
  if (production && isLoopbackHost(parsed.hostname)) {
    errors.push(
      `VITE_API_URL apunta a loopback ("${value}") y se publicaría en producción.`,
    );
  }
  if (production && parsed.protocol === "http:") {
    errors.push(
      `VITE_API_URL usa http en producción ("${value}"): la app en Vercel es HTTPS y el navegador bloquearía la API por mixed content. Usa https.`,
    );
  }
  return { ok: errors.length === 0, errors, warnings };
}

/**
 * Valida la forma de `vercel.json` para una SPA de Vite.
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateVercelConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return { ok: false, errors: ["vercel.json no contiene un objeto JSON."] };
  }

  const errors = [];
  if (config.outputDirectory !== "dist") {
    errors.push('vercel.json: outputDirectory debe ser "dist".');
  }
  if (
    typeof config.buildCommand !== "string" ||
    !config.buildCommand.includes("build")
  ) {
    errors.push("vercel.json: buildCommand debe construir la app (npm run build).");
  }

  const rewrites = Array.isArray(config.rewrites) ? config.rewrites : [];
  const hasSpaFallback = rewrites.some(
    (rule) =>
      rule &&
      typeof rule.source === "string" &&
      rule.destination === "/index.html",
  );
  if (!hasSpaFallback) {
    errors.push(
      'vercel.json: falta el rewrite SPA hacia "/index.html" para deep-links.',
    );
  }

  return { ok: errors.length === 0, errors };
}

/** Entornos de Vercel que deben llevar una `VITE_API_URL` pública. */
const STRICT_VERCEL_ENVS = new Set(["production", "preview"]);

/**
 * Decide si aplica el contrato estricto: el build desplegado por Vercel
 * (preview **y** production). El build local documentado NO se ve afectado
 * porque no define `VERCEL_ENV`/`PREFLIGHT_ENV` estrictos.
 */
export function detectProduction({
  argv = process.argv.slice(2),
  env = process.env,
} = {}) {
  if (argv.includes("--production") || argv.includes("--prod")) return true;
  if (STRICT_VERCEL_ENVS.has(env.PREFLIGHT_ENV)) return true;
  if (STRICT_VERCEL_ENVS.has(env.VERCEL_ENV)) return true;
  // `vercel build`/CI de Vercel definen `VERCEL=1`. `vercel dev` define además
  // `VERCEL_ENV=development`, que se excluye para no exigir URL pública en local.
  if (env.VERCEL && !env.VERCEL_ENV) return true;
  return false;
}

/**
 * Ejecuta el preflight completo.
 * @returns {number} código de salida (0 = OK, 1 = configuración inválida)
 */
export function runPreflight({
  appRoot = APP_ROOT,
  env = process.env,
  argv = process.argv.slice(2),
  log = console.log,
  error = console.error,
} = {}) {
  const production = detectProduction({ argv, env });
  const errors = [];
  const warnings = [];

  const vercelPath = join(appRoot, "vercel.json");
  if (!existsSync(vercelPath)) {
    errors.push("No existe vercel.json en la raíz de la app.");
  } else {
    try {
      const config = JSON.parse(readFileSync(vercelPath, "utf8"));
      errors.push(...validateVercelConfig(config).errors);
    } catch (err) {
      errors.push(`vercel.json no es JSON válido: ${err.message}`);
    }
  }

  const urlResult = validateApiUrl(env.VITE_API_URL, { production });
  errors.push(...urlResult.errors);
  warnings.push(...urlResult.warnings);

  log(`[preflight] modo: ${production ? "producción" : "desarrollo"}`);
  log(`[preflight] dir:  ${appRoot}`);
  for (const warning of warnings) log(`[preflight] aviso: ${warning}`);

  if (errors.length > 0) {
    for (const message of errors) error(`[preflight] ERROR: ${message}`);
    error(
      "[preflight] Configuración productiva inválida: no publiques este bundle.",
    );
    return 1;
  }

  log("[preflight] OK: vercel.json y VITE_API_URL cumplen el contrato.");
  return 0;
}

const invokedDirectly =
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  process.exitCode = runPreflight();
}
