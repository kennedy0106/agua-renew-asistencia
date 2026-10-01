import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Etapa 1 de la migración Next -> React + Vite.
// El host y puerto replican el frontend anterior y coinciden con el origen
// predeterminado del backend, evitando tratar la cookie SameSite=Lax como
// una cookie entre sitios durante el desarrollo local.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    host: "localhost",
    port: 3000,
    strictPort: true,
  },
  preview: {
    host: "localhost",
    port: 3000,
    strictPort: true,
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    css: false,
    include: [
      "src/**/*.{test,spec}.{ts,tsx}",
      "scripts/**/*.test.mjs",
    ],
  },
});
