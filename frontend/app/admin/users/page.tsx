"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AdminUser,
  ApiError,
  authApi,
  employeesApi,
  Employee,
  SystemRole,
  systemRolesApi,
  usersApi,
  UserOut,
} from "@/lib/api";

export default function AdminUsersPage() {
  const router = useRouter();
  const [user, setUser] = useState<UserOut | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [roles, setRoles] = useState<SystemRole[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Crear
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    username: "",
    password: "",
    system_role_id: "",
    employee_id: "",
  });

  // Reset de contraseña
  const [resettingId, setResettingId] = useState<string | null>(null);
  const [resetPassword, setResetPassword] = useState("");

  const load = useCallback(async () => {
    try {
      const me = await authApi.me();
      setUser(me);
      if (me.role !== "ADMIN") {
        setError("Solo los administradores gestionan usuarios.");
        return;
      }
      const [list, roleList, empList] = await Promise.all([
        usersApi.list(),
        systemRolesApi.list(),
        employeesApi.list(),
      ]);
      setUsers(list);
      setRoles(roleList);
      setEmployees(empList);
      if (roleList.length > 0 && !form.system_role_id) {
        setForm((f) => ({ ...f, system_role_id: roleList[0].id }));
      }
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        router.replace("/admin/login");
      } else {
        setError(err instanceof ApiError ? err.message : "Error de conexión con el servidor");
      }
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    load();
  }, [load]);

  async function reload() {
    const [list, roleList, empList] = await Promise.all([
      usersApi.list(),
      systemRolesApi.list(),
      employeesApi.list(),
    ]);
    setUsers(list);
    setRoles(roleList);
    setEmployees(empList);
  }

  async function handleCreate(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await usersApi.create({
        username: form.username,
        password: form.password,
        system_role_id: form.system_role_id,
        employee_id: form.employee_id || null,
      });
      setShowForm(false);
      setForm({ username: "", password: "", system_role_id: form.system_role_id, employee_id: "" });
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo crear el usuario");
    } finally {
      setBusy(false);
    }
  }

  async function handleToggleActive(target: AdminUser) {
    setError(null);
    try {
      await usersApi.update(target.id, { active: !target.active });
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo actualizar el estado");
    }
  }

  async function handleRoleChange(target: AdminUser, roleId: string) {
    setError(null);
    try {
      await usersApi.update(target.id, { system_role_id: roleId });
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo cambiar el rol");
    }
  }

  async function handleEmployeeLink(target: AdminUser, employeeId: string) {
    setError(null);
    try {
      await usersApi.update(target.id, { employee_id: employeeId || null });
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo vincular el empleado");
    }
  }

  async function handleResetPassword(userId: string) {
    if (resetPassword.length < 8) return;
    setBusy(true);
    setError(null);
    try {
      await usersApi.resetPassword(userId, resetPassword);
      setResettingId(null);
      setResetPassword("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo restablecer la contraseña");
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center bg-zinc-50 text-zinc-500">
        Cargando…
      </div>
    );
  }

  const roleName = (id: string) => roles.find((r) => r.id === id)?.name ?? "—";

  return (
    <div className="flex flex-1 flex-col bg-zinc-50">
      <header className="flex items-center justify-between border-b border-zinc-200 bg-white px-6 py-4">
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-sky-600 text-lg">
            💧
          </span>
          <span className="font-semibold text-zinc-900">Agua ReNew</span>
          <span className="text-sm text-zinc-500">· Usuarios</span>
        </div>
        <button
          onClick={() => router.push("/admin/dashboard")}
          className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm text-zinc-600 transition-colors hover:bg-zinc-100"
        >
          ← Dashboard
        </button>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 p-6">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold text-zinc-900">Usuarios del sistema</h1>
            <p className="text-sm text-zinc-500">
              Gestión exclusiva de administradores. Un empleado no necesita usuario.
            </p>
          </div>
          {user?.role === "ADMIN" && (
            <button
              onClick={() => setShowForm((v) => !v)}
              className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-sky-700"
            >
              {showForm ? "Cancelar" : "+ Nuevo usuario"}
            </button>
          )}
        </div>

        {error && (
          <p className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
        )}

        {user?.role === "ADMIN" && showForm && (
          <form
            onSubmit={handleCreate}
            className="mb-6 grid gap-3 rounded-2xl border border-zinc-200 bg-white p-4 sm:grid-cols-2 lg:grid-cols-5"
          >
            <label className="flex flex-col gap-1 text-sm font-medium text-zinc-700">
              Usuario
              <input
                type="text"
                value={form.username}
                onChange={(e) => setForm({ ...form, username: e.target.value })}
                required
                minLength={3}
                className="rounded-lg border border-zinc-300 px-3 py-2 text-zinc-900 outline-none focus:border-sky-500"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm font-medium text-zinc-700">
              Contraseña
              <input
                type="password"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                required
                minLength={8}
                className="rounded-lg border border-zinc-300 px-3 py-2 text-zinc-900 outline-none focus:border-sky-500"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm font-medium text-zinc-700">
              Rol
              <select
                value={form.system_role_id}
                onChange={(e) => setForm({ ...form, system_role_id: e.target.value })}
                required
                className="rounded-lg border border-zinc-300 px-3 py-2 text-zinc-900 outline-none focus:border-sky-500"
              >
                {roles.map((role) => (
                  <option key={role.id} value={role.id}>
                    {role.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm font-medium text-zinc-700">
              Empleado (opcional)
              <select
                value={form.employee_id}
                onChange={(e) => setForm({ ...form, employee_id: e.target.value })}
                className="rounded-lg border border-zinc-300 px-3 py-2 text-zinc-900 outline-none focus:border-sky-500"
              >
                <option value="">— Sin vincular —</option>
                {employees.map((emp) => (
                  <option key={emp.id} value={emp.id}>
                    {emp.first_name} {emp.last_name} ({emp.dni})
                  </option>
                ))}
              </select>
            </label>
            <div className="flex items-end">
              <button
                type="submit"
                disabled={busy}
                className="w-full rounded-lg bg-sky-600 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-700 disabled:opacity-50"
              >
                Crear
              </button>
            </div>
          </form>
        )}

        <div className="overflow-x-auto rounded-2xl border border-zinc-200 bg-white">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-zinc-200 bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="px-4 py-3">Usuario</th>
                <th className="px-4 py-3">Rol</th>
                <th className="px-4 py-3">Empleado</th>
                <th className="px-4 py-3">Estado</th>
                <th className="px-4 py-3">Último acceso</th>
                <th className="px-4 py-3 text-right">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {users.map((item) => (
                <tr key={item.id} className={item.active ? "" : "opacity-60"}>
                  <td className="px-4 py-3 font-medium text-zinc-900">
                    {item.username}
                    {item.id === user?.id && (
                      <span className="ml-2 rounded-full bg-sky-50 px-2 py-0.5 text-xs text-sky-600">
                        tú
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {user?.role === "ADMIN" ? (
                      <select
                        value={item.system_role_id}
                        onChange={(e) => handleRoleChange(item, e.target.value)}
                        className="rounded-lg border border-zinc-200 px-2 py-1 text-sm text-zinc-900 outline-none focus:border-sky-500"
                      >
                        {roles.map((role) => (
                          <option key={role.id} value={role.id}>
                            {role.name}
                          </option>
                        ))}
                      </select>
                    ) : (
                      roleName(item.system_role_id)
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {user?.role === "ADMIN" ? (
                      <select
                        value={item.employee_id ?? ""}
                        onChange={(e) => handleEmployeeLink(item, e.target.value)}
                        className="rounded-lg border border-zinc-200 px-2 py-1 text-sm text-zinc-900 outline-none focus:border-sky-500"
                      >
                        <option value="">— Sin vincular —</option>
                        {employees.map((emp) => (
                          <option key={emp.id} value={emp.id}>
                            {emp.first_name} {emp.last_name}
                          </option>
                        ))}
                      </select>
                    ) : (
                      item.employee_name ?? "—"
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                        item.active
                          ? "bg-emerald-50 text-emerald-700"
                          : "bg-zinc-100 text-zinc-500"
                      }`}
                    >
                      {item.active ? "Activo" : "Inactivo"}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-zinc-500">
                    {item.last_login_at
                      ? new Date(item.last_login_at).toLocaleString("es-PE", {
                          day: "2-digit",
                          month: "2-digit",
                          hour: "2-digit",
                          minute: "2-digit",
                        })
                      : "nunca"}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-2">
                      {item.id !== user?.id && (
                        <button
                          onClick={() => handleToggleActive(item)}
                          className={`rounded-lg border px-3 py-1.5 text-xs font-medium ${
                            item.active
                              ? "border-zinc-300 text-zinc-600 hover:bg-zinc-100"
                              : "border-emerald-300 text-emerald-700 hover:bg-emerald-50"
                          }`}
                        >
                          {item.active ? "Desactivar" : "Activar"}
                        </button>
                      )}
                      {resettingId === item.id ? (
                        <span className="flex items-center gap-1">
                          <input
                            type="password"
                            value={resetPassword}
                            onChange={(e) => setResetPassword(e.target.value)}
                            placeholder="nueva contraseña (mín 8)"
                            minLength={8}
                            className="w-40 rounded-lg border border-zinc-300 px-2 py-1.5 text-xs text-zinc-900 outline-none focus:border-sky-500"
                          />
                          <button
                            onClick={() => handleResetPassword(item.id)}
                            disabled={resetPassword.length < 8 || busy}
                            className="rounded-lg bg-amber-600 px-2 py-1.5 text-xs font-semibold text-white hover:bg-amber-700 disabled:opacity-50"
                          >
                            OK
                          </button>
                          <button
                            onClick={() => {
                              setResettingId(null);
                              setResetPassword("");
                            }}
                            className="text-xs text-zinc-400"
                          >
                            ✕
                          </button>
                        </span>
                      ) : (
                        <button
                          onClick={() => {
                            setResettingId(item.id);
                            setResetPassword("");
                          }}
                          className="rounded-lg border border-amber-200 px-3 py-1.5 text-xs font-medium text-amber-700 hover:bg-amber-50"
                        >
                          Reset clave
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </main>
    </div>
  );
}
