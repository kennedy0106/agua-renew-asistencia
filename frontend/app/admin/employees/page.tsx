"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import AdminShell from "@/components/AdminShell";
import { useAdminUser } from "@/components/AdminSession";
import DateField from "@/components/DateField";
import { Alert, Pencil, Plus, Search, Users, X } from "@/components/Icons";
import { Spinner, TableSkeleton } from "@/components/Loading";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ApiError, employeesApi, Employee, jobRolesApi, JobRole } from "@/lib/api";

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
  const user = useAdminUser();
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [jobRoles, setJobRoles] = useState<JobRole[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"" | "active" | "inactive">("");

  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [creating, setCreating] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [edit, setEdit] = useState<Employee | null>(null);

  const canManage = user ? MANAGE_ROLES.includes(user.role) : false;

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 280);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    jobRolesApi.list().then(setJobRoles).catch(() => undefined);
  }, []);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const list = await employeesApi.list({
        active: statusFilter === "" ? undefined : statusFilter === "active",
        search: debouncedSearch || undefined,
      });
      setEmployees(list);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Error de conexión con el servidor");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [debouncedSearch, statusFilter]);

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

  return (
    <AdminShell
      title="Empleados"
      subtitle={`${employees.length} registro(s) · un cesado no se elimina, se desactiva`}
    >
      <div className="toolbar">
        <div style={{ position: "relative", maxWidth: 280, width: "100%" }}>
          <Search size={15} style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--muted)" }} />
          <input
            type="text"
            className="input"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por nombre, DNI o código…"
            style={{ paddingLeft: "2.1rem" }}
          />
        </div>
        <Select
          value={statusFilter || "__all"}
          onValueChange={(v) => setStatusFilter(v === "__all" ? "" : v as "active" | "inactive")}
        >
          <SelectTrigger aria-label="Estado" style={{ maxWidth: 160 }}>
            <SelectValue placeholder="Todos los estados" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all">Todos los estados</SelectItem>
            <SelectItem value="active">Activos</SelectItem>
            <SelectItem value="inactive">Inactivos</SelectItem>
          </SelectContent>
        </Select>
        {(search || statusFilter) && (
          <button className="btn btn-ghost btn-sm" type="button" onClick={() => { setSearch(""); setStatusFilter(""); }}>
            <X size={14} /> Limpiar filtros
          </button>
        )}
        {refreshing && !loading && <span className="toolbar-status" role="status"><Spinner /> Actualizando…</span>}
        <span className="spacer" />
        {canManage && (
          <button className="btn btn-primary" onClick={() => setShowCreate((v) => !v)}>
            {showCreate ? (
              <>
                <X size={15} /> Cancelar
              </>
            ) : (
              <>
                <Plus size={15} /> Nuevo empleado
              </>
            )}
          </button>
        )}
      </div>

      {error && (
        <p className="alert alert-error" role="alert">
          <Alert size={15} style={{ marginTop: 2, flexShrink: 0 }} />
          {error}
        </p>
      )}

      {canManage && showCreate && (
        <form onSubmit={handleCreate} className="card card-pad" style={{ marginBottom: "1.1rem" }}>
          <div style={{ display: "grid", gap: "0.8rem", gridTemplateColumns: "repeat(auto-fit,minmax(170px,1fr))" }}>
            <div>
              <label className="label">DNI (8 dígitos)</label>
              <input type="text" className="input" value={form.dni} onChange={(e) => setForm({ ...form, dni: e.target.value })} required pattern="\d{8}" title="8 dígitos" />
            </div>
            <div>
              <label className="label">Código interno</label>
              <input type="text" className="input" value={form.employee_code} onChange={(e) => setForm({ ...form, employee_code: e.target.value })} required placeholder="EMP-001" />
            </div>
            <div>
              <label className="label">Cargo laboral</label>
              <Select value={form.job_role_id} onValueChange={(v) => setForm({ ...form, job_role_id: v })}>
                <SelectTrigger aria-label="Cargo laboral">
                  <SelectValue placeholder="Seleccionar…" />
                </SelectTrigger>
                <SelectContent>
                  {jobRoles
                    .filter((r) => r.active)
                    .map((r) => (
                      <SelectItem key={r.id} value={r.id}>
                        {r.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="label">Nombres</label>
              <input type="text" className="input" value={form.first_name} onChange={(e) => setForm({ ...form, first_name: e.target.value })} required />
            </div>
            <div>
              <label className="label">Apellidos</label>
              <input type="text" className="input" value={form.last_name} onChange={(e) => setForm({ ...form, last_name: e.target.value })} required />
            </div>
            <div>
              <label className="label">Fecha de ingreso</label>
              <DateField value={form.hire_date} onChange={(v) => setForm({ ...form, hire_date: v })} placeholder="Sin fecha" />
            </div>
          </div>
          <button type="submit" className="btn btn-primary" style={{ marginTop: "0.8rem" }} disabled={creating}>
            <Plus size={15} />
            {creating ? "Creando…" : "Crear empleado"}
          </button>
        </form>
      )}

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Empleado</th>
              <th>DNI</th>
              <th>Código</th>
              <th>Cargo</th>
              <th>Estado</th>
              {canManage && <th style={{ textAlign: "right" }}>Acciones</th>}
            </tr>
          </thead>
          <tbody>
            {loading && <TableSkeleton rows={5} cols={canManage ? 6 : 5} />}
            {!loading && employees.length === 0 && (
              <tr>
                <td colSpan={canManage ? 6 : 5} className="empty">
                  <Users size={26} />
                  <div>{search || statusFilter ? "No hay empleados con esos filtros." : "Sin empleados registrados."}</div>
                  {search || statusFilter ? (
                    <button className="btn btn-outline btn-sm" type="button" onClick={() => { setSearch(""); setStatusFilter(""); }}>
                      <X size={14} /> Limpiar filtros
                    </button>
                  ) : canManage ? (
                    <button className="btn btn-primary btn-sm" type="button" onClick={() => setShowCreate(true)}>
                      <Plus size={14} /> Crear empleado
                    </button>
                  ) : null}
                </td>
              </tr>
            )}
            {employees.map((employee) => (
              <tr key={employee.id} style={employee.active ? undefined : { opacity: 0.62 }}>
                {editingId === employee.id && edit ? (
                  <>
                    <td>
                      <div style={{ display: "grid", gap: "0.3rem" }}>
                        <input type="text" className="input" style={{ padding: "0.3rem 0.5rem" }} value={edit.first_name} onChange={(e) => setEdit({ ...edit, first_name: e.target.value })} />
                        <input type="text" className="input" style={{ padding: "0.3rem 0.5rem" }} value={edit.last_name} onChange={(e) => setEdit({ ...edit, last_name: e.target.value })} />
                      </div>
                    </td>
                    <td>
                      <input type="text" className="input" style={{ width: 90, padding: "0.3rem 0.5rem" }} value={edit.dni} onChange={(e) => setEdit({ ...edit, dni: e.target.value })} />
                    </td>
                    <td>
                      <input type="text" className="input" style={{ width: 110, padding: "0.3rem 0.5rem" }} value={edit.employee_code} onChange={(e) => setEdit({ ...edit, employee_code: e.target.value })} />
                    </td>
                    <td>
                      <Select value={edit.job_role_id} onValueChange={(v) => setEdit({ ...edit, job_role_id: v })}>
                        <SelectTrigger aria-label="Cargo" style={{ padding: "0.3rem 0.5rem", height: "2rem" }}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {jobRoles.map((r) => (
                            <SelectItem key={r.id} value={r.id}>
                              {r.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </td>
                    <td>
                      <span className="badge badge-neutral">{employee.active ? "Activo" : "Inactivo"}</span>
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <div style={{ display: "flex", gap: "0.4rem", justifyContent: "flex-end" }}>
                        <button className="btn btn-green btn-sm" onClick={handleSaveEdit}>
                          Guardar
                        </button>
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={() => {
                            setEditingId(null);
                            setEdit(null);
                          }}
                        >
                          Cancelar
                        </button>
                      </div>
                    </td>
                  </>
                ) : (
                  <>
                    <td>
                      <Link href={`/admin/employees/${employee.id}`} style={{ fontWeight: 600 }}>
                        {employee.first_name} {employee.last_name}
                      </Link>
                    </td>
                    <td className="num">{employee.dni}</td>
                    <td className="num">{employee.employee_code}</td>
                    <td>{employee.job_role_name ?? "—"}</td>
                    <td>
                      {employee.active ? (
                        <span className="badge badge-green">Activo</span>
                      ) : (
                        <span className="badge badge-neutral">Inactivo</span>
                      )}
                    </td>
                    {canManage && (
                      <td style={{ textAlign: "right" }}>
                        <div style={{ display: "flex", gap: "0.4rem", justifyContent: "flex-end" }}>
                          <button className="btn btn-ghost btn-sm" onClick={() => startEdit(employee)}>
                            <Pencil size={13} />
                            Editar
                          </button>
                          <button
                            className={`btn btn-sm ${employee.active ? "btn-danger" : "btn-green"}`}
                            onClick={() => handleToggleActive(employee)}
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
    </AdminShell>
  );
}
