// Shell del panel administrativo — sidebar con la marca + navegación por rol.
"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { ApiError, authApi, UserOut } from "@/lib/api";
import {
  Briefcase,
  Chart,
  ClipboardCheck,
  Coins,
  Home,
  Key,
  Logout,
  Receipt,
  Shield,
  Users,
} from "./Icons";

export const AdminUserContext = createContext<UserOut | null>(null);

/** Rol del usuario autenticado dentro del shell (null si no cargó). */
export function useAdminUser(): UserOut | null {
  return useContext(AdminUserContext);
}

const NAV = [
  { href: "/admin/dashboard", label: "Dashboard", icon: Home, roles: null },
  { href: "/admin/attendance", label: "Asistencia", icon: ClipboardCheck, roles: null },
  { href: "/admin/employees", label: "Empleados", icon: Users, roles: null },
  { href: "/admin/roles", label: "Cargos", icon: Briefcase, roles: null },
  { href: "/admin/payroll", label: "Planilla", icon: Receipt, roles: ["ADMIN", "BOSS"] },
  { href: "/admin/salaries", label: "Sueldos", icon: Coins, roles: ["ADMIN", "BOSS"] },
  { href: "/admin/users", label: "Usuarios", icon: Key, roles: ["ADMIN"] },
  { href: "/admin/audit", label: "Auditoría", icon: Shield, roles: ["ADMIN"] },
];

export default function AdminShell({
  children,
  title,
  subtitle,
}: {
  children: React.ReactNode;
  title?: string;
  subtitle?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [user, setUser] = useState<UserOut | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const me = await authApi.me();
      setUser(me);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        router.replace("/admin/login");
        return;
      }
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleLogout() {
    try {
      await authApi.logout();
    } catch {
      /* la cookie se limpia igualmente */
    }
    router.replace("/admin/login");
  }

  if (loading) {
    return (
      <div className="app-shell">
        <div className="sidebar" />
        <div className="main">
          <div className="page muted" style={{ paddingTop: "3rem" }}>
            Cargando…
          </div>
        </div>
      </div>
    );
  }

  const visibleNav = NAV.filter((item) => !item.roles || (user && item.roles.includes(user.role)));
  const current = visibleNav.find((item) =>
    item.href === "/admin/dashboard" ? pathname === item.href : pathname.startsWith(item.href),
  );
  const sectionTitle = title ?? current?.label ?? "Panel";
  const sectionSub = subtitle ?? (user ? `Sesión de ${user.username}` : "");

  return (
    <AdminUserContext.Provider value={user}>
      <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <img src="/brand/logo_color.webp" alt="Agua ReNew" />
        </div>
        <nav className="sidebar-nav">
          <p className="nav-label">Operación</p>
          {visibleNav.slice(0, 4).map((item) => (
            <NavLink key={item.href} item={item} active={pathname.startsWith(item.href)} />
          ))}
          {visibleNav.length > 4 && <p className="nav-label">Remuneraciones</p>}
          {visibleNav.slice(4).map((item) => (
            <NavLink key={item.href} item={item} active={pathname.startsWith(item.href)} />
          ))}
        </nav>
        {user && (
          <div className="sidebar-user">
            <div className="avatar">{user.username.charAt(0).toUpperCase()}</div>
            <div className="meta">
              <div className="name">{user.username}</div>
              <div className="role">{user.role}</div>
            </div>
            <button
              onClick={handleLogout}
              title="Cerrar sesión"
              className="btn btn-ghost btn-sm"
              aria-label="Cerrar sesión"
            >
              <Logout size={16} />
            </button>
          </div>
        )}
      </aside>

      <div className="main">
        <header className="topbar">
          <div>
            <div className="topbar-title">{sectionTitle}</div>
            {sectionSub && <div className="topbar-sub">{sectionSub}</div>}
          </div>
          {user && (
            <a
              href="/asistencia"
              target="_blank"
              rel="noreferrer"
              className="btn btn-outline btn-sm"
            >
              <Chart size={15} /> Marcación pública
            </a>
          )}
        </header>
        <main className="page">{children}</main>
      </div>
      </div>
    </AdminUserContext.Provider>
  );
}

function NavLink({
  item,
  active,
}: {
  item: { href: string; label: string; icon: React.ComponentType<{ size?: number }> };
  active: boolean;
}) {
  const Icon = item.icon;
  return (
    <a href={item.href} className={`nav-link${active ? " active" : ""}`}>
      <Icon size={17} />
      <span>{item.label}</span>
    </a>
  );
}
