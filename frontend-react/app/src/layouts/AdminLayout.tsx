// Layout del área /admin: resuelve la sesión UNA vez y la provee a todas las
// páginas (incluido el detalle de empleado), evitando llamadas /me duplicadas y
// garantizando que el rol esté disponible al renderizar.
//
// Portado de app/admin/layout.tsx (Next) a un layout de React Router basado en
// <Outlet />; se preservan /auth/me, el hint de sesión, el 401, el guard de
// must_change_password y el bloqueo de contenido privado.

import { Suspense, useEffect, useRef, useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { ApiError, authApi, type UserOut } from "@/lib/api";
import RouteFallback from "@/components/RouteFallback";
import {
  AdminSessionContext,
  clearAdminSessionHint,
  readAdminSessionHint,
  writeAdminSessionHint,
} from "@/components/AdminSession";

export default function AdminLayout() {
  const navigate = useNavigate();
  // `useNavigate` cambia de identidad en cada navegación (React Router v7). Se
  // guarda en un ref para que el efecto de sesión dependa solo de `isLogin` y no
  // vuelva a llamar /me al movernos entre pantallas de /admin.
  const navigateRef = useRef(navigate);
  useEffect(() => {
    navigateRef.current = navigate;
  }, [navigate]);
  const { pathname } = useLocation();
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
          navigateRef.current("/admin/login", { replace: true });
        }
        setUser(null);
      })
      .finally(() => setReady(true));
  }, [isLogin]);

  useEffect(() => {
    if (!ready || mustChangePassword === undefined || isLogin) return;
    if (mustChangePassword && pathname !== "/admin/change-password") {
      navigateRef.current("/admin/change-password", { replace: true });
    } else if (!mustChangePassword && pathname === "/admin/change-password") {
      navigateRef.current("/admin/dashboard", { replace: true });
    }
  }, [isLogin, mustChangePassword, pathname, ready]);

  const awaitingSession = !isLogin && (!ready || user === null);
  const passwordChangeRequired = ready && user?.must_change_password && pathname !== "/admin/change-password";
  const passwordChangeNoLongerRequired = ready && user && !user.must_change_password && pathname === "/admin/change-password";
  const blockPrivateContent = awaitingSession || passwordChangeRequired || passwordChangeNoLongerRequired;

  return (
    <AdminSessionContext.Provider value={{ user, ready }}>
      {blockPrivateContent ? (
        <SessionGuard
          status={
            passwordChangeNoLongerRequired
              ? "Redirigiendo al panel…"
              : passwordChangeRequired
                ? "Redirigiendo al cambio de contraseña…"
                : "Comprobando sesión…"
          }
        />
      ) : (
        // El límite de Suspense vive DENTRO del layout para que la descarga del
        // chunk de una página hija no desmonte `AdminLayout` (ni repita /me).
        <Suspense fallback={<RouteFallback />}>
          <Outlet />
        </Suspense>
      )}
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
