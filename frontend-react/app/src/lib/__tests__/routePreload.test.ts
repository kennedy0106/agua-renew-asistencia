import { afterEach, describe, expect, it, vi } from "vitest";
import {
  preloadRoute,
  resolveRouteLoader,
  routeLoaders,
  type RouteLoader,
} from "@/lib/routePreload";

// Vista mutable del registro para inyectar loaders de prueba sin tocar la red.
const loaders = routeLoaders as unknown as Record<string, RouteLoader>;

function setLoader(key: keyof typeof routeLoaders, loader: RouteLoader) {
  loaders[key] = loader;
}

describe("routePreload — precarga de chunks", () => {
  it("resuelve cada ruta interna contra su loader y comparte identidad", () => {
    expect(resolveRouteLoader("/admin/dashboard")).toBe(routeLoaders["/admin/dashboard"]);
    expect(resolveRouteLoader("/admin/dashboard?tab=hoy")).toBe(routeLoaders["/admin/dashboard"]);
    expect(resolveRouteLoader("/admin/attendance/history")).toBe(
      routeLoaders["/admin/attendance/history"],
    );
    expect(resolveRouteLoader("/admin/employees/emp-42")).toBe(routeLoaders["/admin/employees/:id"]);
    expect(resolveRouteLoader("/ruta-desconocida")).toBeNull();
  });

  it("no repite el import al precargar dos veces la misma ruta", async () => {
    const original = routeLoaders["/admin/dashboard"];
    const loader = vi.fn(() => Promise.resolve({ default: () => null }));
    setLoader("/admin/dashboard", loader);
    try {
      const first = preloadRoute("/admin/dashboard");
      const second = preloadRoute("/admin/dashboard");
      expect(second).toBe(first);
      await first;
      expect(loader).toHaveBeenCalledTimes(1);
    } finally {
      loaders["/admin/dashboard"] = original;
    }
  });

  it("reutiliza un solo import para todos los ids de empleado", async () => {
    const original = routeLoaders["/admin/employees/:id"];
    const loader = vi.fn(() => Promise.resolve({ default: () => null }));
    setLoader("/admin/employees/:id", loader);
    try {
      await Promise.all([
        preloadRoute("/admin/employees/1"),
        preloadRoute("/admin/employees/2"),
      ]);
      expect(loader).toHaveBeenCalledTimes(1);
    } finally {
      loaders["/admin/employees/:id"] = original;
    }
  });

  it("no rechaza si la precarga falla (React.lazy reintenta al navegar)", async () => {
    const original = routeLoaders["/admin/roles"];
    const loader = vi.fn(() => Promise.reject(new Error("offline")));
    setLoader("/admin/roles", loader);
    try {
      await expect(preloadRoute("/admin/roles")).resolves.toBeNull();
    } finally {
      loaders["/admin/roles"] = original;
    }
  });

  afterEach(() => {
    vi.useRealTimers();
  });
});
