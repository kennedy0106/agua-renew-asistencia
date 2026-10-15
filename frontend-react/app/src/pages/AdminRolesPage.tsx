
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import AdminShell from "@/components/AdminShell";
import AppDialog, { AppDialogCloseButton } from "@/components/AppDialog";
import { useAdminUser } from "@/components/AdminSession";
import { useNotifications } from "@/components/Notifications";
import { Alert, Briefcase, Check, Pencil, Plus, Refresh, Search, X } from "@/components/Icons";
import { Spinner, TableSkeleton } from "@/components/Loading";
import { useRowHighlight } from "@/components/RowHighlight";
import { TablePagination, useTablePagination } from "@/components/Pagination";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ApiError, jobRolesApi, JobRole } from "@/lib/api";

const ROLES_MANAGE = "ADMIN"; // crear/editar/desactivar cargos: solo ADMIN

export default function AdminRolesPage() {
  const user = useAdminUser();
  const { success } = useNotifications();
  const { markSaved, isHighlighted } = useRowHighlight();

  const [roles, setRoles] = useState<JobRole[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // New role creation state
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [creating, setCreating] = useState(false);

  // Inline editing state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editError, setEditError] = useState<string | null>(null);
  const [actionKey, setActionKey] = useState<string | null>(null);

  // Search & in-memory filters
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"" | "active" | "inactive">("");

  // Sensitive confirmation modal for active status toggle
  const [confirmToggleRole, setConfirmToggleRole] = useState<JobRole | null>(null);

  const searchInputId = useId();
  const newNameId = useId();
  const newDescId = useId();

  const canManage = user?.role === ROLES_MANAGE;

  // Debounce search
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 240);
    return () => window.clearTimeout(timer);
  }, [search]);

  const load = useCallback(async () => {
    try {
      setError(null);
      const data = await jobRolesApi.list();
      setRoles(data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Error de conexión con el servidor");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // In-memory filtered roles
  const filteredRoles = useMemo(() => {
    return roles.filter((role) => {
      if (debouncedSearch) {
        const query = debouncedSearch.toLowerCase();
        const matchName = role.name.toLowerCase().includes(query);
        const matchDesc = (role.description || "").toLowerCase().includes(query);
        if (!matchName && !matchDesc) return false;
      }
      if (statusFilter === "active" && !role.active) return false;
      if (statusFilter === "inactive" && role.active) return false;
      return true;
    });
  }, [roles, debouncedSearch, statusFilter]);

  const pagination = useTablePagination(
    filteredRoles,
    `${debouncedSearch}:${statusFilter}:${filteredRoles.length}`,
  );

  const activeRolesCount = useMemo(() => roles.filter((r) => r.active).length, [roles]);

  async function handleCreate(event: React.FormEvent) {
    event.preventDefault();
    if (!newName.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const created = await jobRolesApi.create(newName.trim(), newDescription.trim() || null);
      setRoles((prev) => [...prev, created]);
      setNewName("");
      setNewDescription("");
      markSaved(created.id);
      success(`Cargo "${created.name}" creado con éxito.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo crear el cargo");
    } finally {
      setCreating(false);
    }
  }

  function startEdit(role: JobRole) {
    setEditingId(role.id);
    setEditName(role.name);
    setEditDescription(role.description ?? "");
    setEditError(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditName("");
    setEditDescription("");
    setEditError(null);
  }

  async function handleSaveEdit(roleId: string) {
    if (actionKey) return;
    if (!editName.trim()) {
      setEditError("El nombre del cargo no puede estar vacío");
      return;
    }
    setActionKey(`save:${roleId}`);
    setError(null);
    setEditError(null);
    try {
      const updated = await jobRolesApi.update(roleId, {
        name: editName.trim(),
        description: editDescription.trim() || null,
      });
      setRoles((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
      setEditingId(null);
      markSaved(updated.id);
      success(`Cargo "${updated.name}" actualizado correctamente.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo guardar el cargo");
    } finally {
      setActionKey(null);
    }
  }

  async function executeToggleActive() {
    if (!confirmToggleRole || actionKey) return;
    const target = confirmToggleRole;
    setActionKey(`toggle:${target.id}`);
    setError(null);
    try {
      const updated = await jobRolesApi.update(target.id, { active: !target.active });
      setRoles((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
      markSaved(updated.id);
      success(
        target.active
          ? `Cargo "${target.name}" desactivado.`
          : `Cargo "${target.name}" reactivado correctamente.`,
      );
      setConfirmToggleRole(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo actualizar el estado del cargo");
    } finally {
      setActionKey(null);
    }
  }

  const hasActiveFilters = Boolean(search || statusFilter);

  function clearFilters() {
    setSearch("");
    setDebouncedSearch("");
    setStatusFilter("");
  }

  return (
    <AdminShell
      title="Cargos laborales"
      subtitle="Puestos de trabajo operativos (Operario, Chofer, Almacén…) — no confundir con roles de acceso al sistema"
    >
      {error && (
        <div
          className="alert alert-error"
          role="alert"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "0.8rem",
            flexWrap: "wrap",
            marginBottom: "1rem",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <Alert size={15} className="alert-icon" style={{ flexShrink: 0 }} />
            <span>{error}</span>
          </div>
          <button
            type="button"
            className="btn btn-sm btn-outline"
            onClick={() => {
              setLoading(true);
              void load();
            }}
          >
            <Refresh size={13} /> Reintentar
          </button>
        </div>
      )}

      {canManage && (
        <form onSubmit={handleCreate} className="card card-pad" style={{ marginBottom: "1.1rem" }}>
          <div style={{ display: "grid", gap: "0.8rem", gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))" }}>
            <div>
              <label className="label" htmlFor={newNameId}>
                Nuevo cargo laboral
              </label>
              <input
                id={newNameId}
                type="text"
                className="input"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                required
                placeholder="Ej. Operario de envasado"
                autoComplete="off"
              />
            </div>
            <div>
              <label className="label" htmlFor={newDescId}>
                Descripción del puesto <em>(opcional)</em>
              </label>
              <input
                id={newDescId}
                type="text"
                className="input"
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
                placeholder="Ej. Planta de tratamiento y llenado"
                autoComplete="off"
              />
            </div>
            <div style={{ display: "flex", alignItems: "flex-end" }}>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={creating || !newName.trim()}
                aria-busy={creating}
                style={{ minHeight: "2.75rem", whiteSpace: "nowrap" }}
              >
                {creating ? <Spinner /> : <Plus size={15} />}
                {creating ? "Creando cargo…" : "Crear cargo"}
              </button>
            </div>
          </div>
        </form>
      )}

      {/* Toolbar with Search, Status Filter and Summary */}
      <div className="toolbar roles-filters-toolbar" role="search" aria-label="Búsqueda y filtros de cargos laborales">
        <div className="roles-search-field">
          <Search
            size={15}
            style={{
              position: "absolute",
              left: 10,
              top: "50%",
              transform: "translateY(-50%)",
              color: "var(--muted)",
              pointerEvents: "none",
            }}
          />
          <input
            id={searchInputId}
            type="text"
            className="input"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por cargo o descripción…"
            aria-label="Buscar cargo laboral por nombre o descripción"
            style={{ paddingLeft: "2.1rem" }}
          />
        </div>

        <Select
          value={statusFilter || "__all"}
          onValueChange={(val) => setStatusFilter(val === "__all" ? "" : (val as "active" | "inactive"))}
        >
          <SelectTrigger aria-label="Filtrar por estado del cargo" style={{ minWidth: 160, maxWidth: 200 }}>
            <SelectValue placeholder="Todos los estados" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all">Todos los estados</SelectItem>
            <SelectItem value="active">Solo activos</SelectItem>
            <SelectItem value="inactive">Solo inactivos</SelectItem>
          </SelectContent>
        </Select>

        {hasActiveFilters && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={clearFilters}
            aria-label="Limpiar filtros de búsqueda"
          >
            <X size={14} /> Limpiar filtros
          </button>
        )}

        <span className="spacer" />
        <span className="muted" style={{ fontSize: "0.82rem", whiteSpace: "nowrap" }}>
          {filteredRoles.length} de {roles.length} cargos · {activeRolesCount} activos
        </span>
      </div>

      <div className="table-wrap roles-table-wrap employee-stack-wrap">
        <table className="table roles-table employee-stack-table">
          <thead>
            <tr>
              <th style={{ width: "28%" }}>Nombre</th>
              <th style={{ width: "38%" }}>Descripción</th>
              <th style={{ width: "16%" }}>Estado</th>
              {canManage && <th style={{ width: "18%", textAlign: "right" }}>Acciones</th>}
            </tr>
          </thead>
          <tbody>
            {loading && <TableSkeleton rows={4} cols={canManage ? 4 : 3} />}
            {!loading && filteredRoles.length === 0 && (
              <tr>
                <td colSpan={canManage ? 4 : 3} className="empty">
                  <Briefcase size={26} />
                  <div>
                    {hasActiveFilters
                      ? "No se encontraron cargos con los filtros seleccionados."
                      : "Sin cargos laborales registrados."}
                  </div>
                  {hasActiveFilters && (
                    <button type="button" className="btn btn-outline btn-sm" onClick={clearFilters}>
                      <X size={14} /> Limpiar filtros
                    </button>
                  )}
                </td>
              </tr>
            )}
            {pagination.pageItems.map((role) => (
              <tr
                key={role.id}
                className={
                  [
                    role.active ? "" : "roles-row-inactive",
                    isHighlighted(role.id) ? "row-saved" : "",
                  ]
                    .filter(Boolean)
                    .join(" ") || undefined
                }
              >
                <td data-label="Nombre" style={{ fontWeight: 600 }}>
                  {editingId === role.id ? (
                    <div className="roles-edit-cell">
                      <input
                        type="text"
                        className="input roles-edit-input"
                        value={editName}
                        onChange={(e) => {
                          setEditName(e.target.value);
                          if (editError) setEditError(null);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            void handleSaveEdit(role.id);
                          } else if (e.key === "Escape") {
                            e.preventDefault();
                            cancelEdit();
                          }
                        }}
                        autoFocus
                        aria-label={`Nombre del cargo ${role.name}`}
                        placeholder="Nombre obligatorio"
                      />
                      {editError && <p className="roles-inline-error">{editError}</p>}
                    </div>
                  ) : (
                    role.name
                  )}
                </td>
                <td data-label="Descripción">
                  {editingId === role.id ? (
                    <input
                      type="text"
                      className="input roles-edit-input"
                      value={editDescription}
                      onChange={(e) => setEditDescription(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          void handleSaveEdit(role.id);
                        } else if (e.key === "Escape") {
                          e.preventDefault();
                          cancelEdit();
                        }
                      }}
                      aria-label={`Descripción del cargo ${role.name}`}
                      placeholder="Descripción (opcional)"
                    />
                  ) : (
                    role.description ?? <span className="muted">—</span>
                  )}
                </td>
                <td data-label="Estado">
                  {role.active ? (
                    <span className="badge badge-green">Activo</span>
                  ) : (
                    <span className="badge badge-neutral">Inactivo</span>
                  )}
                </td>
                {canManage && (
                  <td data-label="Acciones" style={{ textAlign: "right" }}>
                    <div className="roles-actions-group">
                      {editingId === role.id ? (
                        <>
                          <button
                            type="button"
                            className="btn btn-green btn-sm"
                            onClick={() => void handleSaveEdit(role.id)}
                            disabled={actionKey !== null}
                            aria-busy={actionKey === `save:${role.id}`}
                            aria-label={`Guardar cambios del cargo ${role.name}`}
                          >
                            {actionKey === `save:${role.id}` ? <Spinner /> : <Check size={13} />}
                            {actionKey === `save:${role.id}` ? "Guardando…" : "Guardar"}
                          </button>
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            onClick={cancelEdit}
                            disabled={actionKey !== null}
                            aria-label={`Cancelar edición del cargo ${role.name}`}
                          >
                            <X size={13} /> Cancelar
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            onClick={() => startEdit(role)}
                            aria-label={`Editar cargo ${role.name}`}
                          >
                            <Pencil size={13} /> Editar
                          </button>
                          <button
                            type="button"
                            className={`btn btn-sm ${role.active ? "btn-danger" : "btn-green"}`}
                            onClick={() => setConfirmToggleRole(role)}
                            disabled={actionKey !== null}
                            aria-busy={actionKey === `toggle:${role.id}`}
                            aria-label={`${role.active ? "Desactivar" : "Activar"} cargo ${role.name}`}
                          >
                            {actionKey === `toggle:${role.id}` && <Spinner />}
                            {actionKey === `toggle:${role.id}`
                              ? "Actualizando…"
                              : role.active
                                ? "Desactivar"
                                : "Activar"}
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
      <TablePagination {...pagination} />

      {/* Confirmation modal for deactivation/reactivation */}
      {confirmToggleRole && (
        <AppDialog
          labelledBy="toggle-role-title"
          describedBy="toggle-role-desc"
          onClose={() => setConfirmToggleRole(null)}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", marginBottom: "0.4rem" }}>
            <div
              style={{
                width: "2.4rem",
                height: "2.4rem",
                borderRadius: "var(--radius-control, 0.35rem)",
                background: confirmToggleRole.active ? "rgba(180, 35, 24, 0.12)" : "rgba(0, 200, 83, 0.12)",
                color: confirmToggleRole.active ? "var(--incident, #b42318)" : "var(--brand-green, #00a047)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              {confirmToggleRole.active ? <Alert size={20} /> : <Check size={20} />}
            </div>
            <h2 id="toggle-role-title" className="card-title" style={{ margin: 0 }}>
              {confirmToggleRole.active
                ? `¿Desactivar cargo laboral "${confirmToggleRole.name}"?`
                : `¿Reactivar cargo laboral "${confirmToggleRole.name}"?`}
            </h2>
          </div>
          <p id="toggle-role-desc" className="card-sub" style={{ marginTop: "0.4rem" }}>
            {confirmToggleRole.active
              ? "Los empleados que actualmente tengan asignado este puesto conservarán su historial de asistencia y sueldos. Sin embargo, el cargo ya no aparecerá disponible para asignar a nuevos empleados."
              : "El cargo volverá a estar disponible de inmediato para su asignación a empleados en el sistema."}
          </p>
          <div
            className="app-dialog-actions"
            style={{ marginTop: "1.4rem", display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}
          >
            <AppDialogCloseButton className="btn btn-outline" disabled={actionKey !== null}>
              Cancelar
            </AppDialogCloseButton>
            <button
              type="button"
              className={`btn ${confirmToggleRole.active ? "btn-danger" : "btn-green"}`}
              disabled={actionKey !== null}
              onClick={() => void executeToggleActive()}
            >
              {actionKey === `toggle:${confirmToggleRole.id}` ? <Spinner /> : null}
              {actionKey === `toggle:${confirmToggleRole.id}`
                ? "Actualizando…"
                : confirmToggleRole.active
                  ? "Sí, desactivar cargo"
                  : "Sí, reactivar cargo"}
            </button>
          </div>
        </AppDialog>
      )}

    </AdminShell>
  );
}
