// Layout del área /admin: resuelve la sesión UNA vez y la provee a todas
// las páginas (incluido el detalle de empleado), evitando llamadas /me
// duplicadas y garantizando que el rol esté disponible al renderizar.
"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { ApiError, authApi, UserOut } from "@/lib/api";
import { AdminSessionContext } from "@/components/AdminSession";

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [user, setUser] = useState<UserOut | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    // Login no consulta una sesión previa. La pantalla de cambio sí puede
    // resolver /me porque es el único destino permitido con clave temporal.
    if (pathname === "/admin/login") {
      setUser(null);
      setReady(true);
      return;
    }
    authApi
      .me()
      .then((u) => {
        setUser(u);
        if (u.must_change_password && pathname !== "/admin/change-password") {
          router.replace("/admin/change-password");
        } else if (!u.must_change_password && pathname === "/admin/change-password") {
          router.replace("/admin/dashboard");
        }
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) {
          router.replace("/admin/login");
        }
        setUser(null);
      })
      .finally(() => setReady(true));
  }, [pathname, router]);

  const awaitingSession = pathname !== "/admin/login" && (!ready || user === null);
  const passwordChangeRequired = ready && user?.must_change_password && pathname !== "/admin/change-password";
  const passwordChangeNoLongerRequired = ready && user && !user.must_change_password && pathname === "/admin/change-password";
  const blockPrivateContent = awaitingSession || passwordChangeRequired || passwordChangeNoLongerRequired;

  return (
    <AdminSessionContext.Provider value={{ user, ready }}>
      {blockPrivateContent ? <div className="admin-route-guard" role="status">{passwordChangeNoLongerRequired ? "Redirigiendo al panel…" : passwordChangeRequired ? "Redirigiendo al cambio de contraseña…" : "Comprobando sesión…"}</div> : children}
    </AdminSessionContext.Provider>
  );
}
