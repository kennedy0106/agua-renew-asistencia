"use client";

import { useCallback, useEffect, useState } from "react";
import AdminShell from "@/components/AdminShell";
import { useAdminUser } from "@/components/AdminSession";
import { Alert, Pencil, Plus, Search, Users, X } from "@/components/Icons";
import { TableSkeleton } from "@/components/Loading";
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
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"" | "active" | "inactive">("");

  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [creating, setCreating] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [edit, setEdit] = useState<Employee | null>(null);

  const canManage = user ? MANAGE_ROLES.includes(user.role) : false;

  const load = useCallback(async () => {
    try {
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
      setError(err instanceof ApiError ? err.message : "Error de conexión con el servidor");
    } finally {
      setLoading(false);
    }
  }, [search, statusFilter]);

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
        <select
          className="select"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as "" | "active" | "inactive")}
          style={{ maxWidth: 160 }}
        >
          <option value="">Todos los estados</option>
          <option value="active">Activos</option>
          <option value="inactive">Inactivos</option>
        </select>
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
              <select className="select" value={form.job_role_id} onChange={(e) => setForm({ ...form, job_role_id: e.target.value })} required>
                <option value="">Seleccionar…</option>
                {jobRoles
                  .filter((r) => r.active)
                  .map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
              </select>
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
              <input type="date" className="input" value={form.hire_date} onChange={(e) => setForm({ ...form, hire_date: e.target.value })} />
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
                  Sin empleados registrados.
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
                      <select className="select" style={{ padding: "0.3rem 0.5rem" }} value={edit.job_role_id} onChange={(e) => setEdit({ ...edit, job_role_id: e.target.value })}>
                        {jobRoles.map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.name}
                          </option>
                        ))}
                      </select>
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
                      <a href={`/admin/employees/${employee.id}`} style={{ fontWeight: 600 }}>
                        {employee.first_name} {employee.last_name}
                      </a>
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
