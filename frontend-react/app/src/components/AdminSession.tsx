// Sesión del usuario administrativo — contexto global del área /admin.
// Vive en un layout para que TODAS las páginas (no solo el shell) lean el rol.
import { createContext, useContext } from "react";
import type { UserOut } from "@/lib/api";

const SESSION_HINT_KEY = "agua-renew-admin-session-hint";
const SESSION_HINT_VERSION = 1;
const SESSION_HINT_MAX_AGE_MS = 12 * 60 * 60 * 1000;

type AdminSessionHint = {
  version: typeof SESSION_HINT_VERSION;
  storedAt: number;
  user: Pick<UserOut, "id" | "username" | "role" | "active" | "must_change_password">;
};

/**
 * Guarda solo datos de presentación de la sesión actual. No contiene ni
 * credenciales ni tokens; siempre se revalida contra /auth/me al abrir /admin.
 */
export function writeAdminSessionHint(user: UserOut): void {
  if (typeof window === "undefined") return;
  const hint: AdminSessionHint = {
    version: SESSION_HINT_VERSION,
    storedAt: Date.now(),
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      active: user.active,
      must_change_password: user.must_change_password,
    },
  };
  try {
    window.sessionStorage.setItem(SESSION_HINT_KEY, JSON.stringify(hint));
  } catch {
    // El almacenamiento puede estar deshabilitado o sin cuota: la sesión
    // continúa protegida y se resolverá normalmente con /auth/me.
  }
}

export function clearAdminSessionHint(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(SESSION_HINT_KEY);
  } catch {
    // No impedir el cierre o la redirección si el storage no está disponible.
  }
}

export function readAdminSessionHint(): UserOut | null {
  if (typeof window === "undefined") return null;
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(SESSION_HINT_KEY) ?? "null") as AdminSessionHint | null;
    if (
      !parsed ||
      parsed.version !== SESSION_HINT_VERSION ||
      !Number.isFinite(parsed.storedAt) ||
      Date.now() - parsed.storedAt > SESSION_HINT_MAX_AGE_MS ||
      !parsed.user ||
      typeof parsed.user.id !== "string" ||
      typeof parsed.user.username !== "string" ||
      typeof parsed.user.role !== "string" ||
      typeof parsed.user.active !== "boolean" ||
      typeof parsed.user.must_change_password !== "boolean"
    ) {
      clearAdminSessionHint();
      return null;
    }
    // Las páginas administrativas solo consumen estos dos campos en la
    // respuesta revalidada; el hint nunca se usa para operaciones ni permisos.
    return { ...parsed.user, last_login_at: null, created_at: "" };
  } catch {
    clearAdminSessionHint();
    return null;
  }
}

export interface AdminSession {
  user: UserOut | null;
  ready: boolean; // true cuando ya se resolvió la sesión (cargada o sin sesión)
}

export const AdminSessionContext = createContext<AdminSession>({
  user: null,
  ready: false,
});

/** Sesión completa (user + ready). */
export function useAdminSession(): AdminSession {
  return useContext(AdminSessionContext);
}

/** Rol/usuario del autenticado dentro del área /admin (null si no cargó). */
export function useAdminUser(): UserOut | null {
  return useContext(AdminSessionContext).user;
}
