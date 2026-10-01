// Shell del panel administrativo — sidebar con la marca + navegación por rol.
// La sesión la provee app/admin/layout.tsx (AdminSessionContext); este shell
// solo la consume, así el rol está disponible desde el primer render.

import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { clearAdminSessionHint, useAdminSession } from "./AdminSession";
import AppDialog, { AppDialogCloseButton } from "./AppDialog";
import IntentLink from "./IntentLink";
import { Spinner } from "./Loading";
import {
  Briefcase,
  Chart,
  ClipboardCheck,
  Clock,
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

// Fecha de contexto del topbar en hora de Lima (no inventa sede ni sucursal:
// usa la fecha real de la jornada).
function limaTodayLabel(): string {
  return new Intl.DateTimeFormat("es-PE", {
    timeZone: "America/Lima",
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(new Date());
}

export default function AdminShell({
  children,
  title,
  subtitle,
}: {
  children: React.ReactNode;
  title?: string;
  subtitle?: string;
}) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { user, ready } = useAdminSession();
  const [menuOpen, setMenuOpen] = useState(false);
  const [navigating, setNavigating] = useState(false);
  const [confirmLogoutOpen, setConfirmLogoutOpen] = useState(false);
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
    navigate("/admin/login", { replace: true });
  }

  if (!ready) {
    return (
      <div className="app-shell">
        <div className="main" style={{ alignItems: "center", justifyContent: "center" }}>
          <div className="drop-loader">
            <img
              className="drop"
              src="/brand/logo_gotita.svg"
              alt=""
              width={754}
              height={1065}
              aria-hidden
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
  const todayLabel = limaTodayLabel();

  return (
    <div className="app-shell">
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
          <img src="/brand/logo_color.svg" alt="Agua ReNew" width={700} height={190} />
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
            <img src="/brand/logo_color.svg" alt="Agua ReNew" width={700} height={190} />
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
              onClick={() => setConfirmLogoutOpen(true)}
              className="btn btn-danger sidebar-logout"
              aria-label="Cerrar sesión"
            >
              <Logout size={16} />
              <span>Salir</span>
            </button>
          </div>
        )}
      </aside>

      {confirmLogoutOpen && (
        <AppDialog
          labelledBy="logout-dialog-title"
          describedBy="logout-dialog-desc"
          onClose={() => setConfirmLogoutOpen(false)}
        >
          <div className="app-dialog-heading">
            <h2 id="logout-dialog-title" className="card-title">
              ¿Cerrar sesión?
            </h2>
            <p id="logout-dialog-desc" className="card-sub">
              Se cerrará la sesión de <strong>{user?.username}</strong>. Si tienes cambios sin guardar en pantalla, se descartarán.
            </p>
          </div>
          <div className="app-dialog-actions" style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
            <AppDialogCloseButton className="btn btn-outline" onClick={() => setConfirmLogoutOpen(false)}>
              Cancelar
            </AppDialogCloseButton>
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => {
                setConfirmLogoutOpen(false);
                void handleLogout();
              }}
            >
              <Logout size={16} />
              <span>Sí, salir</span>
            </button>
          </div>
        </AppDialog>
      )}

      <div className={`main${navigating ? " is-navigating" : ""}`} aria-busy={navigating}>
        <header className="topbar">
          <div className="topbar-copy">
            <div>
              <h1 className="topbar-title">{sectionTitle}</h1>
              {sectionSub && <div className="topbar-sub">{sectionSub}</div>}
            </div>
          </div>
          <div className="topbar-actions">
            <span
              className={`route-loading${navigating ? " is-active" : ""}`}
              role="status"
              aria-live="polite"
              aria-busy={navigating}
            >
              <Spinner size={16} />
              <span className="sr-only">{navigating ? "Cargando sección…" : ""}</span>
            </span>
            <span className="topbar-date">
              <Clock size={15} />
              <span>{todayLabel}</span>
            </span>
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
            {user && (
              <span className="topbar-avatar" aria-hidden>
                {user.username.charAt(0).toUpperCase()}
              </span>
            )}
          </div>
        </header>
        <main className="page">{children}</main>
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
      {item.href === "/admin/dashboard" && <span className="nav-badge">EN VIVO</span>}
    </IntentLink>
  );
}
