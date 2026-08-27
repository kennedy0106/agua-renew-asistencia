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
    // La página de login no necesita sesión previa.
    if (pathname === "/admin/login") {
      setUser(null);
      setReady(true);
      return;
    }
    authApi
      .me()
      .then((u) => setUser(u))
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) {
          router.replace("/admin/login");
        }
        setUser(null);
      })
      .finally(() => setReady(true));
  }, [pathname, router]);

  return (
    <AdminSessionContext.Provider value={{ user, ready }}>
      {children}
    </AdminSessionContext.Provider>
  );
}
