// Precarga de chunks por intención de navegación.
//
// El `import()` dinámico de cada página se declara UNA sola vez aquí. `App.tsx`
// construye sus `React.lazy` a partir de estos loaders y `IntentLink` los
// precarga al detectar intención (hover/focus/pointerdown/click). Como ambos
// caminos usan la misma expresión de import, el módulo ya resuelto se reutiliza
// y la precarga nunca descarga el chunk dos veces.

import type { ComponentType } from "react";

export type RouteModule = { default: ComponentType };
export type RouteLoader = () => Promise<RouteModule>;

/**
 * Loaders por ruta canónica. El kiosco público (`/asistencia`) NO está aquí:
 * se importa eager en `App.tsx` porque su chunk es pequeño (~24 KB) y es un
 * destino de entrada directa en tablets, donde la precarga por intención no
 * puede ayudar.
 */
export const routeLoaders = {
  "/admin/dashboard": () => import("@/pages/AdminDashboardPage"),
  "/admin/account": () => import("@/pages/AdminAccountPage"),
  "/admin/attendance": () => import("@/pages/AdminAttendancePage"),
  "/admin/attendance/history": () => import("@/pages/AdminAttendanceHistoryPage"),
  "/admin/audit": () => import("@/pages/AdminAuditPage"),
  "/admin/devices": () => import("@/pages/AdminDevicesPage"),
  "/admin/employees": () => import("@/pages/AdminEmployeesPage"),
  "/admin/employees/:id": () => import("@/pages/AdminEmployeeDetailPage"),
  "/admin/overtime-policy": () => import("@/pages/AdminOvertimePolicyPage"),
  "/admin/payroll": () => import("@/pages/AdminPayrollPage"),
  "/admin/roles": () => import("@/pages/AdminRolesPage"),
  "/admin/salaries": () => import("@/pages/AdminSalariesPage"),
  "/admin/users": () => import("@/pages/AdminUsersPage"),
} satisfies Record<string, RouteLoader>;

const pendingByLoader = new WeakMap<RouteLoader, Promise<RouteModule | null>>();

/** Descarta query/hash para resolver la ruta contra el registro de loaders. */
function normalizePath(to: string): string {
  const end = to.search(/[?#]/);
  return end === -1 ? to : to.slice(0, end);
}

/** Loader de una ruta interna; `null` si no hay chunk que precargar. */
export function resolveRouteLoader(to: string): RouteLoader | null {
  const path = normalizePath(to);
  const exact = routeLoaders[path as keyof typeof routeLoaders];
  if (exact) return exact;
  if (path.startsWith("/admin/employees/")) return routeLoaders["/admin/employees/:id"];
  return null;
}

/**
 * Dispara la descarga del chunk de una ruta. Devuelve la MISMA promesa si se
 * llama varias veces para el mismo loader, de modo que no se repite el import.
 * Nunca rechaza: un fallo de precarga se ignora y `React.lazy` reintenta al
 * navegar de verdad.
 */
export function preloadRoute(to: string): Promise<RouteModule | null> | null {
  const loader = resolveRouteLoader(to);
  if (!loader) return null;
  const cached = pendingByLoader.get(loader);
  if (cached) return cached;
  const pending = loader().catch((error: unknown) => {
    pendingByLoader.delete(loader);
    if (import.meta.env.DEV) {
      console.warn("[routePreload] No se pudo precargar", to, error);
    }
    return null;
  });
  pendingByLoader.set(loader, pending);
  return pending;
}

/**
 * Precarga diferida: espera a que el hilo principal esté libre para no competir
 * con el primer pintado de la pantalla actual.
 */
export function preloadRouteWhenIdle(to: string): void {
  if (typeof window === "undefined") return;
  const idleWindow = window as Window & {
    requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
  };
  if (typeof idleWindow.requestIdleCallback === "function") {
    idleWindow.requestIdleCallback(() => void preloadRoute(to), { timeout: 1200 });
  } else {
    window.setTimeout(() => void preloadRoute(to), 200);
  }
}
