// Layout del área /admin: resuelve la sesión UNA vez y la provee a todas
// las páginas (incluido el detalle de empleado), evitando llamadas /me
// duplicadas y garantizando que el rol esté disponible al renderizar.
"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { ApiError, authApi, UserOut } from "@/lib/api";
import {
  AdminSessionContext,
  clearAdminSessionHint,
  readAdminSessionHint,
  writeAdminSessionHint,
} from "@/components/AdminSession";

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const isLogin = pathname === "/admin/login";
  const [user, setUser] = useState<UserOut | null>(null);
  const [ready, setReady] = useState(false);
  const mustChangePassword = user?.must_change_password;

  useEffect(() => {
    // Login no consulta una sesión previa. La pantalla de cambio sí puede
    // resolver /me porque es el único destino permitido con clave temporal.
    if (isLogin) {
      clearAdminSessionHint();
      setUser(null);
      setReady(true);
      return;
    }
    // El hint permite pintar el shell conocido mientras /me valida la cookie.
    // No autoriza nada por sí mismo: un 401 borra el hint y vuelve al login.
    const hint = readAdminSessionHint();
    if (hint) {
      setUser(hint);
      setReady(true);
    } else {
      setReady(false);
    }
    authApi
      .me()
      .then((u) => {
        setUser(u);
        writeAdminSessionHint(u);
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) {
          clearAdminSessionHint();
          router.replace("/admin/login");
        }
        setUser(null);
      })
      .finally(() => setReady(true));
  }, [isLogin, router]);

  useEffect(() => {
    if (!ready || mustChangePassword === undefined || isLogin) return;
    if (mustChangePassword && pathname !== "/admin/change-password") {
      router.replace("/admin/change-password");
    } else if (!mustChangePassword && pathname === "/admin/change-password") {
      router.replace("/admin/dashboard");
    }
  }, [isLogin, mustChangePassword, pathname, ready, router]);

  const awaitingSession = !isLogin && (!ready || user === null);
  const passwordChangeRequired = ready && user?.must_change_password && pathname !== "/admin/change-password";
  const passwordChangeNoLongerRequired = ready && user && !user.must_change_password && pathname === "/admin/change-password";
  const blockPrivateContent = awaitingSession || passwordChangeRequired || passwordChangeNoLongerRequired;

  return (
    <AdminSessionContext.Provider value={{ user, ready }}>
      {blockPrivateContent ? <SessionGuard status={passwordChangeNoLongerRequired ? "Redirigiendo al panel…" : passwordChangeRequired ? "Redirigiendo al cambio de contraseña…" : "Comprobando sesión…"} /> : children}
    </AdminSessionContext.Provider>
  );
}

function SessionGuard({ status }: { status: string }) {
  return (
    <div className="admin-route-guard" role="status" aria-live="polite">
      <div className="admin-route-guard-shell" aria-hidden>
        <span className="admin-route-guard-logo" />
        <span className="admin-route-guard-line admin-route-guard-line--short" />
        <span className="admin-route-guard-line" />
        <span className="admin-route-guard-line" />
        <span className="admin-route-guard-line" />
      </div>
      <main className="admin-route-guard-content">
        <span className="admin-route-guard-title" />
        <div className="admin-route-guard-cards"><i /><i /><i /></div>
      </main>
      <span className="sr-only">{status}</span>
    </div>
  );
}
