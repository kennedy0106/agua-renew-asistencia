// Shell del panel administrativo — sidebar con la marca + navegación por rol.
// La sesión la provee app/admin/layout.tsx (AdminSessionContext); este shell
// solo la consume, así el rol está disponible desde el primer render.
"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useAdminSession } from "./AdminSession";
import {
  Briefcase,
  Chart,
  ClipboardCheck,
  Coins,
  Home,
  Key,
  Logout,
  Menu,
  Receipt,
  Shield,
  Users,
  X,
  Zap,
} from "./Icons";

const NAV = [
  { href: "/admin/dashboard", label: "Dashboard", icon: Home, roles: null },
  { href: "/admin/attendance", label: "Asistencia", icon: ClipboardCheck, roles: null },
  { href: "/admin/employees", label: "Empleados", icon: Users, roles: null },
  { href: "/admin/roles", label: "Cargos", icon: Briefcase, roles: null },
  { href: "/admin/payroll", label: "Planilla", icon: Receipt, roles: ["ADMIN", "BOSS"] },
  { href: "/admin/overtime-policy", label: "Horas extra", icon: Zap, roles: ["ADMIN", "BOSS"] },
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
  const { user, ready } = useAdminSession();
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!menuOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [menuOpen]);

  async function handleLogout() {
    try {
      const { authApi } = await import("@/lib/api");
      await authApi.logout();
    } catch {
      /* la cookie se limpia igualmente */
    }
    router.replace("/admin/login");
  }

  if (!ready) {
    return (
      <div className="app-shell">
        <div className="main" style={{ alignItems: "center", justifyContent: "center" }}>
          <div className="drop-loader">
            <Image
              className="drop"
              src="/brand/logo_gotita.svg"
              alt=""
              width={754}
              height={1065}
              aria-hidden
              priority
            />
            <span>Cargando sesión…</span>
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
    <div className="app-shell">
      <header className="mobile-header">
        <button
          type="button"
          className="mobile-menu-button"
          onClick={() => setMenuOpen(true)}
          aria-label="Abrir menú"
          aria-expanded={menuOpen}
          aria-controls="admin-sidebar"
        >
          <Menu size={19} />
        </button>
        <Link href="/admin/dashboard" className="mobile-brand" aria-label="Ir al dashboard">
          <Image src="/brand/logo_color.svg" alt="Agua ReNew" width={700} height={190} priority />
        </Link>
        <span className="mobile-product">Asistencia</span>
      </header>

      <button
        type="button"
        className={`sidebar-scrim${menuOpen ? " is-open" : ""}`}
        onClick={() => setMenuOpen(false)}
        aria-label="Cerrar menú"
        tabIndex={menuOpen ? 0 : -1}
      />

      <aside id="admin-sidebar" className={`sidebar${menuOpen ? " is-open" : ""}`} aria-label="Navegación del sistema">
        <div className="sidebar-brand">
          <Link href="/admin/dashboard" aria-label="Ir al dashboard">
            <Image src="/brand/logo_color.svg" alt="Agua ReNew" width={700} height={190} priority />
          </Link>
          <button type="button" className="sidebar-close" onClick={() => setMenuOpen(false)} aria-label="Cerrar menú">
            <X size={18} />
          </button>
        </div>
        <nav className="sidebar-nav" aria-label="Principal">
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
          <div className="topbar-copy">
            <span className="topbar-drop" aria-hidden>
              <Image src="/brand/logo_gotita.svg" alt="" width={754} height={1065} />
            </span>
            <div>
              <h1 className="topbar-title">{sectionTitle}</h1>
              {sectionSub && <div className="topbar-sub">{sectionSub}</div>}
            </div>
          </div>
          {user && (
            <Link
              href="/asistencia"
              target="_blank"
              rel="noreferrer"
              className="btn btn-outline btn-sm"
            >
              <Chart size={15} /> <span>Marcación pública</span>
            </Link>
          )}
        </header>
        <main className="page page-enter">{children}</main>
      </div>
    </div>
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
    <Link
      href={item.href}
      className={`nav-link${active ? " active" : ""}`}
      aria-current={active ? "page" : undefined}
    >
      <Icon size={17} />
      <span>{item.label}</span>
    </Link>
  );
}
