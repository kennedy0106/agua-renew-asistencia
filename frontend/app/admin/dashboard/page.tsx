"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ApiError,
  attendanceAdminApi,
  AttendanceSummary,
  authApi,
  usersApi,
  UserOut,
} from "@/lib/api";

export default function AdminDashboardPage() {
  const router = useRouter();
  const [user, setUser] = useState<UserOut | null>(null);
  const [summary, setSummary] = useState<AttendanceSummary | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    authApi
      .me()
      .then((me) => {
        if (active) setUser(me);
        return attendanceAdminApi.summary();
      })
      .then((s) => {
        if (active) setSummary(s);
      })
      .catch(() => {
        if (active) router.replace("/admin/login");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [router]);

  async function handleLogout() {
    await authApi.logout();
    router.replace("/admin/login");
  }

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center bg-zinc-50 text-zinc-500">
        Verificando sesión…
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col bg-zinc-50">
      <header className="flex items-center justify-between border-b border-zinc-200 bg-white px-6 py-4">
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-sky-600 text-lg">
            💧
          </span>
          <span className="font-semibold text-zinc-900">Agua ReNew</span>
          <span className="text-sm text-zinc-500">· Panel administrativo</span>
        </div>
        <button
          onClick={handleLogout}
          className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm text-zinc-600 transition-colors hover:bg-zinc-100"
        >
          Cerrar sesión
        </button>
      </header>

      <main className="flex-1 p-6">
        <div className="mb-6">
          <h1 className="text-2xl font-semibold text-zinc-900">Dashboard</h1>
          <p className="text-sm text-zinc-500">
            Bienvenido, <span className="font-medium text-zinc-700">{user?.username}</span>
          </p>
        </div>

        <div className="mb-6">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-400">
            Resumen de hoy
          </h2>
          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <div className="rounded-2xl border border-zinc-200 bg-white p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-zinc-400">
                Empleados activos
              </p>
              <p className="mt-1 text-2xl font-semibold text-zinc-900">
                {summary?.employees_active ?? "—"}
              </p>
            </div>
            <div className="rounded-2xl border border-zinc-200 bg-white p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-zinc-400">
                Presentes hoy
              </p>
              <p className="mt-1 text-2xl font-semibold text-emerald-600">
                {summary?.present_today ?? "—"}
              </p>
            </div>
            <div className="rounded-2xl border border-zinc-200 bg-white p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-zinc-400">
                Sin entrada
              </p>
              <p className="mt-1 text-2xl font-semibold text-amber-600">
                {summary?.no_entry_today ?? "—"}
              </p>
            </div>
            <div className="rounded-2xl border border-zinc-200 bg-white p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-zinc-400">
                Entradas abiertas
              </p>
              <p className="mt-1 text-2xl font-semibold text-sky-600">
                {summary?.open_entries ?? "—"}
              </p>
            </div>
            <div className="rounded-2xl border border-zinc-200 bg-white p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-zinc-400">
                Con salida hoy
              </p>
              <p className="mt-1 text-2xl font-semibold text-zinc-900">
                {summary?.checked_out_today ?? "—"}
              </p>
            </div>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <div className="rounded-2xl border border-zinc-200 bg-white p-5">
            <p className="text-xs font-medium uppercase tracking-wide text-zinc-400">Rol</p>
            <p className="mt-1 text-lg font-semibold text-zinc-900">{user?.role}</p>
          </div>
          <div className="rounded-2xl border border-zinc-200 bg-white p-5">
            <p className="text-xs font-medium uppercase tracking-wide text-zinc-400">Usuario</p>
            <p className="mt-1 text-lg font-semibold text-zinc-900">{user?.username}</p>
          </div>
          <div className="rounded-2xl border border-zinc-200 bg-white p-5">
            <p className="text-xs font-medium uppercase tracking-wide text-zinc-400">Estado</p>
            <p className="mt-1 text-lg font-semibold text-emerald-600">
              {user?.active ? "Activo" : "Inactivo"}
            </p>
          </div>
        </div>

        <div className="mt-6 grid gap-3 sm:grid-cols-3">
          <a
            href="/admin/roles"
            className="rounded-2xl border border-zinc-200 bg-white p-5 transition-colors hover:border-sky-300 hover:shadow-sm"
          >
            <p className="text-sm font-semibold text-zinc-900">Cargos laborales</p>
            <p className="mt-1 text-xs text-zinc-500">Operario, Chofer, Almacén…</p>
          </a>
          <a
            href="/admin/employees"
            className="rounded-2xl border border-zinc-200 bg-white p-5 transition-colors hover:border-sky-300 hover:shadow-sm"
          >
            <p className="text-sm font-semibold text-zinc-900">Empleados</p>
            <p className="mt-1 text-xs text-zinc-500">DNI, código, cargo y estado</p>
          </a>
          <a
            href="/admin/attendance"
            className="rounded-2xl border border-zinc-200 bg-white p-5 transition-colors hover:border-sky-300 hover:shadow-sm"
          >
            <p className="text-sm font-semibold text-zinc-900">Asistencia</p>
            <p className="mt-1 text-xs text-zinc-500">Marcaciones, esperado y diferencia</p>
          </a>
          {user?.role === "ADMIN" && (
            <a
              href="/admin/audit"
              className="rounded-2xl border border-zinc-200 bg-white p-5 transition-colors hover:border-sky-300 hover:shadow-sm"
            >
              <p className="text-sm font-semibold text-zinc-900">Auditoría</p>
              <p className="mt-1 text-xs text-zinc-500">Bitácora de correcciones (solo admin)</p>
            </a>
          )}
          {(user?.role === "ADMIN" || user?.role === "BOSS") && (
            <a
              href="/admin/payroll"
              className="rounded-2xl border border-zinc-200 bg-white p-5 transition-colors hover:border-sky-300 hover:shadow-sm"
            >
              <p className="text-sm font-semibold text-zinc-900">Planilla</p>
              <p className="mt-1 text-xs text-zinc-500">Periodos, cálculo y cierre</p>
            </a>
          )}
          {(user?.role === "ADMIN" || user?.role === "BOSS") && (
            <a
              href="/admin/salaries"
              className="rounded-2xl border border-zinc-200 bg-white p-5 transition-colors hover:border-sky-300 hover:shadow-sm"
            >
              <p className="text-sm font-semibold text-zinc-900">Sueldos</p>
              <p className="mt-1 text-xs text-zinc-500">Liquidaciones por periodo</p>
            </a>
          )}
          {user?.role === "ADMIN" && (
            <a
              href="/admin/users"
              className="rounded-2xl border border-zinc-200 bg-white p-5 transition-colors hover:border-sky-300 hover:shadow-sm"
            >
              <p className="text-sm font-semibold text-zinc-900">Usuarios</p>
              <p className="mt-1 text-xs text-zinc-500">Cuentas, roles y vínculo con empleados</p>
            </a>
          )}
        </div>

        <PasswordChangeCard />

        <p className="mt-6 text-sm text-zinc-400">
          Cargos, jornadas y sueldos se gestionan desde el detalle de cada empleado.
        </p>
      </main>
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
    <div className="mt-6 rounded-2xl border border-zinc-200 bg-white p-5">
      <button
        onClick={() => setOpen((v) => !v)}
        className="text-sm font-semibold text-zinc-900 hover:text-sky-700"
      >
        {open ? "▾" : "▸"} Cambiar mi contraseña
      </button>
      {open && (
        <form onSubmit={handleSubmit} className="mt-3 grid gap-3 sm:grid-cols-3">
          <label className="flex flex-col gap-1 text-sm font-medium text-zinc-700">
            Contraseña actual
            <input
              type="password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              required
              className="rounded-lg border border-zinc-300 px-3 py-2 text-zinc-900 outline-none focus:border-sky-500"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm font-medium text-zinc-700">
            Nueva contraseña (mín 8)
            <input
              type="password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              required
              minLength={8}
              className="rounded-lg border border-zinc-300 px-3 py-2 text-zinc-900 outline-none focus:border-sky-500"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm font-medium text-zinc-700">
            Confirmar nueva
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
              minLength={8}
              className="rounded-lg border border-zinc-300 px-3 py-2 text-zinc-900 outline-none focus:border-sky-500"
            />
          </label>
          <div className="sm:col-span-3">
            <button
              type="submit"
              disabled={busy}
              className="rounded-lg bg-zinc-800 px-4 py-2 text-sm font-semibold text-white hover:bg-zinc-900 disabled:opacity-50"
            >
              {busy ? "Guardando…" : "Cambiar contraseña"}
            </button>
          </div>
          {message && <p className="text-sm text-emerald-700 sm:col-span-3">{message}</p>}
          {error && <p className="text-sm text-red-600 sm:col-span-3">{error}</p>}
        </form>
      )}
    </div>
  );
}
