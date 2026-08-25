"use client";

import { useCallback, useEffect, useState } from "react";
import AdminShell from "@/components/AdminShell";
import { StatSkeleton } from "@/components/Loading";
import {
  Alert,
  Briefcase,
  Chart,
  ClipboardCheck,
  Clock,
  Coins,
  Key,
  Receipt,
  Shield,
  Users,
  Wallet,
} from "@/components/Icons";
import { ApiError, attendanceAdminApi, AttendanceSummary, authApi, usersApi, UserOut } from "@/lib/api";

const MODULES = [
  {
    href: "/admin/attendance",
    title: "Asistencia",
    desc: "Marcaciones, esperado y diferencia por día.",
    icon: ClipboardCheck,
    roles: null,
  },
  {
    href: "/admin/employees",
    title: "Empleados",
    desc: "DNI, código, cargo y estado del personal.",
    icon: Users,
    roles: null,
  },
  {
    href: "/admin/roles",
    title: "Cargos laborales",
    desc: "Operario, chofer, almacén y más.",
    icon: Briefcase,
    roles: null,
  },
  {
    href: "/admin/payroll",
    title: "Planilla",
    desc: "Periodos, cálculo y cierre mensual.",
    icon: Receipt,
    roles: ["ADMIN", "BOSS"],
  },
  {
    href: "/admin/salaries",
    title: "Sueldos",
    desc: "Liquidaciones por periodo.",
    icon: Coins,
    roles: ["ADMIN", "BOSS"],
  },
  {
    href: "/admin/users",
    title: "Usuarios",
    desc: "Cuentas, roles y vínculo con empleados.",
    icon: Key,
    roles: ["ADMIN"],
  },
  {
    href: "/admin/audit",
    title: "Auditoría",
    desc: "Bitácora de correcciones y acciones.",
    icon: Shield,
    roles: ["ADMIN"],
  },
];

export default function AdminDashboardPage() {
  const [user, setUser] = useState<UserOut | null>(null);
  const [summary, setSummary] = useState<AttendanceSummary | null>(null);

  const load = useCallback(async () => {
    try {
      const me = await authApi.me();
      setUser(me);
      const [resumen] = await Promise.all([attendanceAdminApi.summary()]);
      setSummary(resumen);
    } catch {
      /* AdminShell redirige si la sesión expiró */
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const modules = MODULES.filter((m) => !m.roles || (user && m.roles.includes(user.role)));

  return (
    <AdminShell title="Dashboard" subtitle={user ? `Bienvenido, ${user.username}` : undefined}>
      {summary ? (
        <div className="stat-grid">
          <StatCard
            label="Empleados activos"
            value={summary.employees_active}
            icon={<Users size={15} />}
          />
          <StatCard
            label="Presentes hoy"
            value={summary.present_today}
            icon={<Clock size={15} />}
          />
          <StatCard
            label="Sin entrada hoy"
            value={summary.no_entry_today}
            icon={<Alert size={15} />}
          />
          <StatCard
            label="Entradas abiertas"
            value={summary.open_entries}
            icon={<ClipboardCheck size={15} />}
          />
          <StatCard
            label="Con salida hoy"
            value={summary.checked_out_today}
            icon={<Chart size={15} />}
          />
        </div>
      ) : (
        <StatSkeleton count={5} />
      )}

      <div className="module-grid">
        {modules.map((m) => {
          const Icon = m.icon;
          const green = m.href === "/admin/payroll" || m.href === "/admin/salaries";
          return (
            <a key={m.href} href={m.href} className="module-card">
              <div className={`icon-tile${green ? " tile-green" : ""}`}>
                <Icon size={20} />
              </div>
              <div>
                <h3>{m.title}</h3>
                <p>{m.desc}</p>
              </div>
            </a>
          );
        })}
      </div>

      <hr className="divider" />
      <PasswordChangeCard />
    </AdminShell>
  );
}

function StatCard({
  label,
  value,
  icon,
}: {
  label: string;
  value: number;
  icon: React.ReactNode;
}) {
  return (
    <div className="stat-card">
      <div className="stat-label">
        {icon}
        {label}
      </div>
      <div className="stat-value">{value}</div>
    </div>
  );
}

function PasswordChangeCard() {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setMessage(null);
    if (next !== confirm) {
      setError("La confirmación no coincide con la nueva contraseña.");
      return;
    }
    setBusy(true);
    try {
      await usersApi.changeOwnPassword(current, next);
      setMessage("Contraseña actualizada. Úsala en tu próximo inicio de sesión.");
      setCurrent("");
      setNext("");
      setConfirm("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo cambiar la contraseña");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card card-pad">
      <button onClick={() => setOpen((v) => !v)} className="link-btn" type="button">
        {open ? "▾" : "▸"} Cambiar mi contraseña
      </button>
      {open && (
        <form
          onSubmit={handleSubmit}
          style={{ display: "grid", gap: "0.9rem", marginTop: "0.9rem", maxWidth: 560 }}
        >
          <div style={{ display: "grid", gap: "0.9rem", gridTemplateColumns: "repeat(auto-fit,minmax(170px,1fr))" }}>
            <div>
              <label className="label">Contraseña actual</label>
              <input
                className="input"
                type="password"
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
                required
              />
            </div>
            <div>
              <label className="label">Nueva contraseña (mín 8)</label>
              <input
                className="input"
                type="password"
                value={next}
                onChange={(e) => setNext(e.target.value)}
                required
                minLength={8}
              />
            </div>
            <div>
              <label className="label">Confirmar nueva</label>
              <input
                className="input"
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
                minLength={8}
              />
            </div>
          </div>
          <div>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              <Wallet size={16} />
              {busy ? "Guardando…" : "Cambiar contraseña"}
            </button>
          </div>
          {message && (
            <p className="alert alert-success">
              <CheckIcon />
              {message}
            </p>
          )}
          {error && (
            <p className="alert alert-error">
              <Alert size={15} />
              {error}
            </p>
          )}
        </form>
      )}
    </div>
  );
}

function CheckIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m4.5 12.5 5 5 10-11" />
    </svg>
  );
}
