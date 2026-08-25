"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ApiError, authApi, jobRolesApi, JobRole, UserOut } from "@/lib/api";

const ROLES_MANAGE = "ADMIN"; // crear/editar/desactivar cargos: solo ADMIN

export default function AdminRolesPage() {
  const router = useRouter();
  const [user, setUser] = useState<UserOut | null>(null);
  const [roles, setRoles] = useState<JobRole[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Formulario de creación
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [creating, setCreating] = useState(false);

  // Edición en línea
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");

  const canManage = user?.role === ROLES_MANAGE;

  const load = useCallback(async () => {
    try {
      const [me, list] = await Promise.all([authApi.me(), jobRolesApi.list()]);
      setUser(me);
      setRoles(list);
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

  async function handleCreate(event: React.FormEvent) {
    event.preventDefault();
    setCreating(true);
    setError(null);
    try {
      const created = await jobRolesApi.create(newName, newDescription || null);
      setRoles((prev) => [...prev, created]);
      setNewName("");
      setNewDescription("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo crear el cargo");
    } finally {
      setCreating(false);
    }
  }

  async function handleToggleActive(role: JobRole) {
    setError(null);
    try {
      const updated = await jobRolesApi.update(role.id, { active: !role.active });
      setRoles((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo actualizar el cargo");
    }
  }

  function startEdit(role: JobRole) {
    setEditingId(role.id);
    setEditName(role.name);
    setEditDescription(role.description ?? "");
  }

  async function handleSaveEdit(roleId: string) {
    setError(null);
    try {
      const updated = await jobRolesApi.update(roleId, {
        name: editName,
        description: editDescription || null,
      });
      setRoles((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
      setEditingId(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo guardar el cargo");
    }
  }

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center bg-zinc-50 text-zinc-500">
        Cargando…
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
          <span className="text-sm text-zinc-500">· Cargos laborales</span>
        </div>
        <button
          onClick={() => router.push("/admin/dashboard")}
          className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm text-zinc-600 transition-colors hover:bg-zinc-100"
        >
          ← Dashboard
        </button>
      </header>

      <main className="mx-auto w-full max-w-4xl flex-1 p-6">
        <h1 className="text-2xl font-semibold text-zinc-900">Cargos laborales</h1>
        <p className="mb-6 text-sm text-zinc-500">
          Puestos de trabajo (Operario, Chofer, Almacén…). No confundir con roles de acceso.
        </p>

        {error && (
          <p className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
        )}

        {canManage && (
          <form
            onSubmit={handleCreate}
            className="mb-6 flex flex-col gap-3 rounded-2xl border border-zinc-200 bg-white p-4 sm:flex-row sm:items-end"
          >
            <label className="flex flex-1 flex-col gap-1 text-sm font-medium text-zinc-700">
              Nuevo cargo
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                required
                placeholder="Ej. Operario"
                className="rounded-lg border border-zinc-300 px-3 py-2 text-zinc-900 outline-none focus:border-sky-500"
              />
            </label>
            <label className="flex flex-1 flex-col gap-1 text-sm font-medium text-zinc-700">
              Descripción
              <input
                type="text"
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
                placeholder="Opcional"
                className="rounded-lg border border-zinc-300 px-3 py-2 text-zinc-900 outline-none focus:border-sky-500"
              />
            </label>
            <button
              type="submit"
              disabled={creating}
              className="rounded-lg bg-sky-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-sky-700 disabled:opacity-50"
            >
              {creating ? "Creando…" : "Crear"}
            </button>
          </form>
        )}

        <div className="overflow-hidden rounded-2xl border border-zinc-200 bg-white">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-zinc-200 bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="px-4 py-3">Nombre</th>
                <th className="px-4 py-3">Descripción</th>
                <th className="px-4 py-3">Estado</th>
                {canManage && <th className="px-4 py-3 text-right">Acciones</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {roles.length === 0 && (
                <tr>
                  <td colSpan={canManage ? 4 : 3} className="px-4 py-6 text-center text-zinc-400">
                    Sin cargos registrados.
                  </td>
                </tr>
              )}
              {roles.map((role) => (
                <tr key={role.id} className={role.active ? "" : "bg-zinc-50/60 text-zinc-400"}>
                  <td className="px-4 py-3 font-medium text-zinc-900">
                    {editingId === role.id ? (
                      <input
                        type="text"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        className="rounded-lg border border-zinc-300 px-2 py-1 text-zinc-900 outline-none focus:border-sky-500"
                      />
                    ) : (
                      role.name
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {editingId === role.id ? (
                      <input
                        type="text"
                        value={editDescription}
                        onChange={(e) => setEditDescription(e.target.value)}
                        className="w-full rounded-lg border border-zinc-300 px-2 py-1 text-zinc-900 outline-none focus:border-sky-500"
                      />
                    ) : (
                      role.description ?? <span className="text-zinc-300">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={
                        role.active
                          ? "rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-700"
                          : "rounded-full bg-zinc-100 px-2.5 py-0.5 text-xs font-medium text-zinc-500"
                      }
                    >
                      {role.active ? "Activo" : "Inactivo"}
                    </span>
                  </td>
                  {canManage && (
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-2">
                        {editingId === role.id ? (
                          <>
                            <button
                              onClick={() => handleSaveEdit(role.id)}
                              className="rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-sky-700"
                            >
                              Guardar
                            </button>
                            <button
                              onClick={() => setEditingId(null)}
                              className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs text-zinc-600 hover:bg-zinc-100"
                            >
                              Cancelar
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              onClick={() => startEdit(role)}
                              className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs text-zinc-600 hover:bg-zinc-100"
                            >
                              Editar
                            </button>
                            <button
                              onClick={() => handleToggleActive(role)}
                              className={`rounded-lg px-3 py-1.5 text-xs font-medium ${
                                role.active
                                  ? "border border-red-200 text-red-600 hover:bg-red-50"
                                  : "border border-emerald-200 text-emerald-600 hover:bg-emerald-50"
                              }`}
                            >
                              {role.active ? "Desactivar" : "Activar"}
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </main>
    </div>
  );
}
