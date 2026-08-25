"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ApiError,
  authApi,
  employeesApi,
  Employee,
  jobRolesApi,
  JobRole,
  UserOut,
} from "@/lib/api";

const MANAGE_ROLES = ["ADMIN", "BOSS"]; // crear/editar/desactivar: ADMIN y JEFE

const EMPTY_FORM = {
  dni: "",
  employee_code: "",
  first_name: "",
  last_name: "",
  job_role_id: "",
  hire_date: "",
};

export default function AdminEmployeesPage() {
  const router = useRouter();
  const [user, setUser] = useState<UserOut | null>(null);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [jobRoles, setJobRoles] = useState<JobRole[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filtros
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"" | "active" | "inactive">("");

  // Formulario de creación
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [creating, setCreating] = useState(false);

  // Edición en línea
  const [editingId, setEditingId] = useState<string | null>(null);
  const [edit, setEdit] = useState<Employee | null>(null);

  const canManage = user ? MANAGE_ROLES.includes(user.role) : false;

  const load = useCallback(async () => {
    try {
      const me = await authApi.me();
      setUser(me);
      const [list, roles] = await Promise.all([
        employeesApi.list({
          active: statusFilter === "" ? undefined : statusFilter === "active",
          search: search || undefined,
        }),
        jobRolesApi.list(),
      ]);
      setEmployees(list);
      setJobRoles(roles);
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
  }, [router, search, statusFilter]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleCreate(event: React.FormEvent) {
    event.preventDefault();
    setCreating(true);
    setError(null);
    try {
      await employeesApi.create({
        dni: form.dni,
        employee_code: form.employee_code,
        first_name: form.first_name,
        last_name: form.last_name,
        job_role_id: form.job_role_id,
        hire_date: form.hire_date || null,
      });
      setForm(EMPTY_FORM);
      setShowCreate(false);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo crear el empleado");
    } finally {
      setCreating(false);
    }
  }

  function startEdit(employee: Employee) {
    setEditingId(employee.id);
    setEdit({ ...employee });
  }

  async function handleSaveEdit() {
    if (!edit) return;
    setError(null);
    try {
      await employeesApi.update(edit.id, {
        dni: edit.dni,
        employee_code: edit.employee_code,
        first_name: edit.first_name,
        last_name: edit.last_name,
        job_role_id: edit.job_role_id,
        hire_date: edit.hire_date || null,
      });
      setEditingId(null);
      setEdit(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo guardar el empleado");
    }
  }

  async function handleToggleActive(employee: Employee) {
    setError(null);
    try {
      if (employee.active) {
        await employeesApi.deactivate(employee.id);
      } else {
        await employeesApi.update(employee.id, { termination_date: null });
      }
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo actualizar el empleado");
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
          <span className="text-sm text-zinc-500">· Empleados</span>
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
            <h1 className="text-2xl font-semibold text-zinc-900">Empleados</h1>
            <p className="text-sm text-zinc-500">
              {employees.length} registro(s). Un empleado cesado no se elimina: se desactiva.
            </p>
          </div>
          {canManage && (
            <button
              onClick={() => setShowCreate((v) => !v)}
              className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-sky-700"
            >
              {showCreate ? "Cancelar" : "+ Nuevo empleado"}
            </button>
          )}
        </div>

        {error && (
          <p className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
        )}

        {canManage && showCreate && (
          <form
            onSubmit={handleCreate}
            className="mb-6 grid gap-3 rounded-2xl border border-zinc-200 bg-white p-4 sm:grid-cols-2 lg:grid-cols-3"
          >
            <label className="flex flex-col gap-1 text-sm font-medium text-zinc-700">
              DNI (8 dígitos)
              <input
                type="text"
                value={form.dni}
                onChange={(e) => setForm({ ...form, dni: e.target.value })}
                required
                pattern="\d{8}"
                title="8 dígitos"
                className="rounded-lg border border-zinc-300 px-3 py-2 text-zinc-900 outline-none focus:border-sky-500"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm font-medium text-zinc-700">
              Código interno
              <input
                type="text"
                value={form.employee_code}
                onChange={(e) => setForm({ ...form, employee_code: e.target.value })}
                required
                placeholder="EMP-001"
                className="rounded-lg border border-zinc-300 px-3 py-2 text-zinc-900 outline-none focus:border-sky-500"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm font-medium text-zinc-700">
              Cargo laboral
              <select
                value={form.job_role_id}
                onChange={(e) => setForm({ ...form, job_role_id: e.target.value })}
                required
                className="rounded-lg border border-zinc-300 px-3 py-2 text-zinc-900 outline-none focus:border-sky-500"
              >
                <option value="">Seleccionar…</option>
                {jobRoles
                  .filter((r) => r.active)
                  .map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm font-medium text-zinc-700">
              Nombres
              <input
                type="text"
                value={form.first_name}
                onChange={(e) => setForm({ ...form, first_name: e.target.value })}
                required
                className="rounded-lg border border-zinc-300 px-3 py-2 text-zinc-900 outline-none focus:border-sky-500"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm font-medium text-zinc-700">
              Apellidos
              <input
                type="text"
                value={form.last_name}
                onChange={(e) => setForm({ ...form, last_name: e.target.value })}
                required
                className="rounded-lg border border-zinc-300 px-3 py-2 text-zinc-900 outline-none focus:border-sky-500"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm font-medium text-zinc-700">
              Fecha de ingreso
              <input
                type="date"
                value={form.hire_date}
                onChange={(e) => setForm({ ...form, hire_date: e.target.value })}
                className="rounded-lg border border-zinc-300 px-3 py-2 text-zinc-900 outline-none focus:border-sky-500"
              />
            </label>
            <div className="sm:col-span-2 lg:col-span-3">
              <button
                type="submit"
                disabled={creating}
                className="rounded-lg bg-sky-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-sky-700 disabled:opacity-50"
              >
                {creating ? "Creando…" : "Crear empleado"}
              </button>
            </div>
          </form>
        )}

        <div className="mb-4 flex flex-wrap gap-3">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por nombre, DNI o código…"
            className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-sky-500"
          />
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as "" | "active" | "inactive")}
            className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-sky-500"
          >
            <option value="">Todos los estados</option>
            <option value="active">Activos</option>
            <option value="inactive">Inactivos</option>
          </select>
        </div>

        <div className="overflow-hidden rounded-2xl border border-zinc-200 bg-white">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-zinc-200 bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="px-4 py-3">Empleado</th>
                <th className="px-4 py-3">DNI</th>
                <th className="px-4 py-3">Código</th>
                <th className="px-4 py-3">Cargo</th>
                <th className="px-4 py-3">Estado</th>
                {canManage && <th className="px-4 py-3 text-right">Acciones</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {employees.length === 0 && (
                <tr>
                  <td colSpan={canManage ? 6 : 5} className="px-4 py-6 text-center text-zinc-400">
                    Sin empleados registrados.
                  </td>
                </tr>
              )}
              {employees.map((employee) => (
                <tr key={employee.id} className={employee.active ? "" : "bg-zinc-50/60 text-zinc-400"}>
                  {editingId === employee.id && edit ? (
                    <>
                      <td className="px-4 py-3">
                        <div className="flex flex-col gap-1">
                          <input
                            type="text"
                            value={edit.first_name}
                            onChange={(e) => setEdit({ ...edit, first_name: e.target.value })}
                            className="rounded border border-zinc-300 px-2 py-1 text-zinc-900"
                          />
                          <input
                            type="text"
                            value={edit.last_name}
                            onChange={(e) => setEdit({ ...edit, last_name: e.target.value })}
                            className="rounded border border-zinc-300 px-2 py-1 text-zinc-900"
                          />
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <input
                          type="text"
                          value={edit.dni}
                          onChange={(e) => setEdit({ ...edit, dni: e.target.value })}
                          className="w-24 rounded border border-zinc-300 px-2 py-1 text-zinc-900"
                        />
                      </td>
                      <td className="px-4 py-3">
                        <input
                          type="text"
                          value={edit.employee_code}
                          onChange={(e) => setEdit({ ...edit, employee_code: e.target.value })}
                          className="w-28 rounded border border-zinc-300 px-2 py-1 text-zinc-900"
                        />
                      </td>
                      <td className="px-4 py-3">
                        <select
                          value={edit.job_role_id}
                          onChange={(e) => setEdit({ ...edit, job_role_id: e.target.value })}
                          className="rounded border border-zinc-300 px-2 py-1 text-zinc-900"
                        >
                          {jobRoles.map((r) => (
                            <option key={r.id} value={r.id}>
                              {r.name}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="px-4 py-3">
                        <span className="rounded-full bg-zinc-100 px-2.5 py-0.5 text-xs font-medium text-zinc-500">
                          {employee.active ? "Activo" : "Inactivo"}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex justify-end gap-2">
                          <button
                            onClick={handleSaveEdit}
                            className="rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-sky-700"
                          >
                            Guardar
                          </button>
                          <button
                            onClick={() => {
                              setEditingId(null);
                              setEdit(null);
                            }}
                            className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs text-zinc-600 hover:bg-zinc-100"
                          >
                            Cancelar
                          </button>
                        </div>
                      </td>
                    </>
                  ) : (
                    <>
                      <td className="px-4 py-3">
                        <a
                          href={`/admin/employees/${employee.id}`}
                          className="font-medium text-zinc-900 hover:text-sky-700 hover:underline"
                        >
                          {employee.first_name} {employee.last_name}
                        </a>
                      </td>
                      <td className="px-4 py-3">{employee.dni}</td>
                      <td className="px-4 py-3">{employee.employee_code}</td>
                      <td className="px-4 py-3">{employee.job_role_name ?? "—"}</td>
                      <td className="px-4 py-3">
                        <span
                          className={
                            employee.active
                              ? "rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-700"
                              : "rounded-full bg-zinc-100 px-2.5 py-0.5 text-xs font-medium text-zinc-500"
                          }
                        >
                          {employee.active ? "Activo" : "Inactivo"}
                        </span>
                      </td>
                      {canManage && (
                        <td className="px-4 py-3">
                          <div className="flex justify-end gap-2">
                            <button
                              onClick={() => startEdit(employee)}
                              className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs text-zinc-600 hover:bg-zinc-100"
                            >
                              Editar
                            </button>
                            <button
                              onClick={() => handleToggleActive(employee)}
                              className={`rounded-lg px-3 py-1.5 text-xs font-medium ${
                                employee.active
                                  ? "border border-red-200 text-red-600 hover:bg-red-50"
                                  : "border border-emerald-200 text-emerald-600 hover:bg-emerald-50"
                              }`}
                            >
                              {employee.active ? "Desactivar" : "Activar"}
                            </button>
                          </div>
                        </td>
                      )}
                    </>
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
