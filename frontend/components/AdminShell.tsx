// Shell del panel administrativo — sidebar con la marca + navegación por rol.
// La sesión la provee app/admin/layout.tsx (AdminSessionContext); este shell
// solo la consume, así el rol está disponible desde el primer render.
"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { clearAdminSessionHint, useAdminSession } from "./AdminSession";
import IntentLink from "./IntentLink";
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
  Zap,
} from "./Icons";

// La navegación se agrupa por el trabajo que hace la persona, no por módulos
// internos: primero la jornada diaria, luego el ciclo de pagos (en el orden en
// que se usa) y al final la configuración que se toca de vez en cuando.
type NavItem = {
  href: string;
  label: string;
  icon: React.ComponentType<{ size?: number }>;
  roles: string[] | null;
  help: string;
};
type NavGroup = { id: string; label: string; hint?: string; items: NavItem[] };

const NAV_GROUPS: NavGroup[] = [
  {
    id: "operacion",
    label: "Operación diaria",
    items: [
      { href: "/admin/dashboard", label: "Hoy", icon: Home, roles: null, help: "Lo que pasó hoy y lo que necesita tu atención." },
      { href: "/admin/attendance", label: "Asistencia", icon: ClipboardCheck, roles: null, help: "Revisa y corrige las marcaciones. Compara lo trabajado con la jornada pactada." },
      { href: "/admin/employees", label: "Empleados", icon: Users, roles: null, help: "Datos de cada persona. Un cesado se desactiva, no se elimina." },
      { href: "/admin/roles", label: "Cargos", icon: Briefcase, roles: null, help: "Puestos de trabajo. No son permisos de acceso." },
    ],
  },
  {
    id: "pagos",
    label: "Pagos y planilla",
    hint: "Preparar → Revisar → Cerrar → Consultar",
    items: [
      { href: "/admin/payroll", label: "Planilla", icon: Receipt, roles: ["ADMIN", "BOSS"], help: "Prepara el periodo, revísalo y ciérralo. Al cerrar, queda bloqueado." },
      { href: "/admin/salaries", label: "Sueldos", icon: Coins, roles: ["ADMIN", "BOSS"], help: "Consulta cuánto corresponde a cada persona en un periodo." },
      { href: "/admin/overtime-policy", label: "Reglas de horas extra", icon: Zap, roles: ["ADMIN", "BOSS"], help: "Cómo se calcula el recargo de horas extra en la empresa." },
    ],
  },
  {
    id: "configuracion",
    label: "Configuración",
    items: [
      { href: "/admin/users", label: "Usuarios", icon: Key, roles: ["ADMIN"], help: "Accesos al sistema. Un empleado no necesita usuario." },
      { href: "/admin/devices", label: "Tablets y terminales", icon: Key, roles: ["ADMIN"], help: "Tablets autorizadas para marcar asistencia." },
      { href: "/admin/audit", label: "Auditoría", icon: Shield, roles: ["ADMIN"], help: "Quién cambió qué y por qué." },
    ],
  },
];

const ROLE_LABELS: Record<string, string> = {
  ADMIN: "Administrador",
  BOSS: "Jefe",
  SUPERVISOR: "Supervisor",
};

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
  const [topbarCompact, setTopbarCompact] = useState(false);
  const [navigating, setNavigating] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const navigationTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function beginNavigation(isCurrent: boolean) {
    if (isCurrent) return;
    if (navigationTimeoutRef.current) clearTimeout(navigationTimeoutRef.current);
    setNavigating(true);
    // Evita dejar aria-busy visible si una navegación es cancelada o falla.
    navigationTimeoutRef.current = setTimeout(() => setNavigating(false), 5000);
  }

  function closeMenu({ returnFocus = true }: { returnFocus?: boolean } = {}) {
    const wasOpen = menuOpen;
    setMenuOpen(false);
    if (returnFocus && wasOpen) window.requestAnimationFrame(() => menuButtonRef.current?.focus());
  }

  useEffect(() => {
    setMenuOpen(false);
    setNavigating(false);
    if (navigationTimeoutRef.current) clearTimeout(navigationTimeoutRef.current);
  }, [pathname]);

  useEffect(() => () => {
    if (navigationTimeoutRef.current) clearTimeout(navigationTimeoutRef.current);
  }, []);

  useEffect(() => {
    const syncTopbar = () => setTopbarCompact(window.scrollY > 8);
    syncTopbar();
    window.addEventListener("scroll", syncTopbar, { passive: true });
    return () => window.removeEventListener("scroll", syncTopbar);
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusFirstItem = window.requestAnimationFrame(() => {
      const focusable = sidebarRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      focusable?.[0]?.focus();
    });
    const keepFocusInDrawer = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setMenuOpen(false);
        window.requestAnimationFrame(() => menuButtonRef.current?.focus());
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(sidebarRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? []);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", keepFocusInDrawer);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.cancelAnimationFrame(focusFirstItem);
      window.removeEventListener("keydown", keepFocusInDrawer);
    };
  }, [menuOpen]);

  async function handleLogout() {
    try {
      const { authApi } = await import("@/lib/api");
      await authApi.logout();
    } catch {
      /* la cookie se limpia igualmente */
    }
    clearAdminSessionHint();
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

  const isVisible = (item: NavItem) => !item.roles || Boolean(user && item.roles.includes(user.role));
  const visibleGroups = NAV_GROUPS
    .map((group) => ({ ...group, items: group.items.filter(isVisible) }))
    .filter((group) => group.items.length > 0);
  const visibleNav = visibleGroups.flatMap((group) => group.items);
  const current = visibleNav.find((item) =>
    item.href === "/admin/dashboard" ? pathname === item.href : pathname.startsWith(item.href),
  );
  const sectionTitle = title ?? current?.label ?? "Panel";
  const sectionSub = subtitle ?? current?.help ?? (user ? `Sesión de ${user.username}` : "");

  return (
    <div className="app-shell">
      <div className="water-orbs" aria-hidden>
        <span className="water-orb water-orb--blue" />
        <span className="water-orb water-orb--green" />
        <span className="water-orb water-orb--cyan" />
      </div>
      <header className="mobile-header">
        <button
          ref={menuButtonRef}
          type="button"
          className="mobile-menu-button"
          onClick={() => setMenuOpen(true)}
          aria-label="Abrir menú"
          aria-expanded={menuOpen}
          aria-controls="admin-sidebar"
        >
          <Menu size={19} />
        </button>
        <IntentLink href="/admin/dashboard" className="mobile-brand" aria-label="Ir al dashboard" onNavigate={() => beginNavigation(pathname === "/admin/dashboard")}>
          <Image src="/brand/logo_color.svg" alt="Agua ReNew" width={700} height={190} priority />
        </IntentLink>
        <span className="mobile-product">Asistencia</span>
      </header>

      <button
        type="button"
        className={`sidebar-scrim${menuOpen ? " is-open" : ""}`}
        onClick={() => closeMenu()}
        aria-label="Cerrar menú"
        tabIndex={menuOpen ? 0 : -1}
      />

      <aside ref={sidebarRef} id="admin-sidebar" className={`sidebar sidebar-material${menuOpen ? " is-open" : ""}`} aria-label="Navegación del sistema">
        <div className="sidebar-brand">
          <IntentLink href="/admin/dashboard" aria-label="Ir al dashboard" onNavigate={() => beginNavigation(pathname === "/admin/dashboard")}>
            <Image src="/brand/logo_color.svg" alt="Agua ReNew" width={700} height={190} priority />
            <span className="sidebar-product">OPERACIÓN · ASISTENCIA</span>
          </IntentLink>
        </div>
        <nav className="sidebar-nav" aria-label="Principal">
          {visibleGroups.map((group) => (
            <div className="nav-group" key={group.id}>
              <p className="nav-label">{group.label}</p>
              {group.hint && <p className="nav-hint">{group.hint}</p>}
              {group.items.map((item) => (
                <NavLink key={item.href} item={item} active={item.href === "/admin/dashboard" ? pathname === item.href : pathname.startsWith(item.href)} onNavigate={(isCurrent) => { beginNavigation(isCurrent); closeMenu(); }} />
              ))}
            </div>
          ))}
        </nav>
        {user && (
          <div className="sidebar-user">
            <IntentLink href="/admin/account" className="sidebar-account" aria-label="Abrir mi cuenta" onNavigate={() => { beginNavigation(pathname === "/admin/account"); closeMenu(); }}>
              <div className="avatar">{user.username.charAt(0).toUpperCase()}</div>
              <div className="meta">
                <div className="name">{user.username}</div>
                <div className="role">{ROLE_LABELS[user.role] ?? user.role}</div>
              </div>
            </IntentLink>
            <button
              onClick={handleLogout}
              className="btn btn-danger sidebar-logout"
              aria-label="Cerrar sesión"
            >
              <Logout size={16} />
              <span>Salir</span>
            </button>
          </div>
        )}
      </aside>

      <div className={`main${navigating ? " is-navigating" : ""}`} aria-busy={navigating}>
        <header className={`topbar${topbarCompact ? " is-compact" : ""}`}>
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
            <IntentLink
              href="/asistencia"
              target="_blank"
              rel="noreferrer"
              className="btn btn-outline btn-sm topbar-action topbar-action--secondary"
              title="Abre el marcador público para la tablet de entrada"
            >
              <Chart size={15} /> <span>Marcación pública</span>
            </IntentLink>
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
  onNavigate,
}: {
  item: NavItem;
  active: boolean;
  onNavigate: (isCurrent: boolean) => void;
}) {
  const Icon = item.icon;
  return (
    <IntentLink
      href={item.href}
      className={`nav-link${active ? " active" : ""}`}
      aria-current={active ? "page" : undefined}
      onNavigate={() => onNavigate(active)}
    >
      <Icon size={17} />
      <span>{item.label}</span>
    </IntentLink>
  );
}
