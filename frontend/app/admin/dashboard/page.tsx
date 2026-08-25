"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { authApi, UserOut } from "@/lib/api";

export default function AdminDashboardPage() {
  const router = useRouter();
  const [user, setUser] = useState<UserOut | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    authApi
      .me()
      .then((me) => {
        if (active) setUser(me);
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
          <div className="rounded-2xl border border-dashed border-zinc-200 p-5 text-zinc-300">
            <p className="text-sm font-semibold">Asistencia</p>
            <p className="mt-1 text-xs">Llega en la Fase 6</p>
          </div>
        </div>

        <p className="mt-6 text-sm text-zinc-400">
          Los módulos de sueldos y remuneraciones llegarán en fases posteriores.
        </p>
      </main>
    </div>
  );
}
