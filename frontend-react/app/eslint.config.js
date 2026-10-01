import { defineConfig, globalIgnores } from "eslint/config";
import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

// ESLint plano, sin eslint-config-next (la app ya no usa Next.js).
export default defineConfig([
  globalIgnores(["dist", "coverage", "node_modules", "playwright-report", "test-results"]),
  {
    files: ["**/*.{ts,tsx}"],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommended,
      reactHooks.configs.flat["recommended-latest"],
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.browser,
      },
    },
  },
  {
    // `react-hooks` v7 ("recommended-latest") activa `set-state-in-effect`, que
    // `eslint-config-next` NO aplicaba en el frontend Next. Las páginas portadas
    // replican 1:1 sus efectos (cargas, resets de paginación, guardas de fase) y
    // refactorizarlas alteraría el comportamiento. Se desactiva esta única regla
    // para conservar la paridad del baseline; el resto de reglas sigue activo.
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      "react-hooks/set-state-in-effect": "off",
    },
  },
  {
    // Playwright (configs y specs) se ejecuta en Node: necesita `process` y el
    // resto de globals de Node, además de los del navegador para los callbacks
    // que corren dentro de `page.evaluate`.
    files: ["e2e/**/*.ts", "playwright*.config.ts"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
  },
  {
    // Estos módulos portados exponen a propósito un componente junto a hooks y
    // contexto (o helpers de sesión); el fast-refresh tiene que aceptarlo tal
    // cual se comportaba el archivo original.
    files: [
      "src/components/AdminSession.tsx",
      "src/components/Notifications.tsx",
      "src/components/Pagination.tsx",
    ],
    rules: {
      "react-refresh/only-export-components": "off",
    },
  },
]);
