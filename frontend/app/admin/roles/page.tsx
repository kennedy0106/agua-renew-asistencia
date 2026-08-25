"use client";

import { useCallback, useEffect, useState } from "react";
import AdminShell, { useAdminUser } from "@/components/AdminShell";
import { Alert, Briefcase, Pencil, Plus, X } from "@/components/Icons";
import { TableSkeleton } from "@/components/Loading";
import { ApiError, jobRolesApi, JobRole } from "@/lib/api";

const ROLES_MANAGE = "ADMIN"; // crear/editar/desactivar cargos: solo ADMIN

export default function AdminRolesPage() {
  const user = useAdminUser();
  const [roles, setRoles] = useState<JobRole[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [creating, setCreating] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");

  const canManage = user?.role === ROLES_MANAGE;

  const load = useCallback(async () => {
    try {
      setRoles(await jobRolesApi.list());
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Error de conexión con el servidor");
    } finally {
      setLoading(false);
    }
  }, []);

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

  return (
    <AdminShell
      title="Cargos laborales"
      subtitle="Puestos de trabajo (Operario, Chofer, Almacén…) — no confundir con roles de acceso"
    >
      {error && (
        <p className="alert alert-error" role="alert">
          <Alert size={15} style={{ marginTop: 2, flexShrink: 0 }} />
          {error}
        </p>
      )}

      {canManage && (
        <form onSubmit={handleCreate} className="card card-pad" style={{ marginBottom: "1.1rem" }}>
          <div style={{ display: "grid", gap: "0.8rem", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))" }}>
            <div>
              <label className="label">Nuevo cargo</label>
              <input type="text" className="input" value={newName} onChange={(e) => setNewName(e.target.value)} required placeholder="Ej. Operario" />
            </div>
            <div>
              <label className="label">Descripción</label>
              <input type="text" className="input" value={newDescription} onChange={(e) => setNewDescription(e.target.value)} placeholder="Opcional" />
            </div>
            <div style={{ display: "flex", alignItems: "flex-end" }}>
              <button type="submit" className="btn btn-primary" disabled={creating}>
                <Plus size={15} />
                {creating ? "Creando…" : "Crear"}
              </button>
            </div>
          </div>
        </form>
      )}

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Nombre</th>
              <th>Descripción</th>
              <th>Estado</th>
              {canManage && <th style={{ textAlign: "right" }}>Acciones</th>}
            </tr>
          </thead>
          <tbody>
            {loading && <TableSkeleton rows={4} cols={canManage ? 4 : 3} />}
            {!loading && roles.length === 0 && (
              <tr>
                <td colSpan={canManage ? 4 : 3} className="empty">
                  <Briefcase size={26} />
                  Sin cargos registrados.
                </td>
              </tr>
            )}
            {roles.map((role) => (
              <tr key={role.id} style={role.active ? undefined : { opacity: 0.62 }}>
                <td style={{ fontWeight: 600 }}>
                  {editingId === role.id ? (
                    <input type="text" className="input" style={{ padding: "0.3rem 0.5rem" }} value={editName} onChange={(e) => setEditName(e.target.value)} />
                  ) : (
                    role.name
                  )}
                </td>
                <td>
                  {editingId === role.id ? (
                    <input type="text" className="input" style={{ padding: "0.3rem 0.5rem" }} value={editDescription} onChange={(e) => setEditDescription(e.target.value)} />
                  ) : (
                    role.description ?? <span className="muted">—</span>
                  )}
                </td>
                <td>
                  {role.active ? (
                    <span className="badge badge-green">Activo</span>
                  ) : (
                    <span className="badge badge-neutral">Inactivo</span>
                  )}
                </td>
                {canManage && (
                  <td style={{ textAlign: "right" }}>
                    <div style={{ display: "flex", gap: "0.4rem", justifyContent: "flex-end" }}>
                      {editingId === role.id ? (
                        <>
                          <button className="btn btn-green btn-sm" onClick={() => handleSaveEdit(role.id)}>
                            Guardar
                          </button>
                          <button className="btn btn-ghost btn-sm" onClick={() => setEditingId(null)}>
                            Cancelar
                          </button>
                        </>
                      ) : (
                        <>
                          <button className="btn btn-ghost btn-sm" onClick={() => startEdit(role)}>
                            <Pencil size={13} />
                            Editar
                          </button>
                          <button
                            className={`btn btn-sm ${role.active ? "btn-danger" : "btn-green"}`}
                            onClick={() => handleToggleActive(role)}
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
    </AdminShell>
  );
}
