// Sesión del usuario administrativo — contexto global del área /admin.
// Vive en un layout para que TODAS las páginas (no solo el shell) lean el rol.
"use client";

import { createContext, useContext } from "react";
import type { UserOut } from "@/lib/api";

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
