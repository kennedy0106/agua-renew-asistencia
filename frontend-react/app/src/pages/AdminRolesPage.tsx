
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import AdminShell from "@/components/AdminShell";
import AppDialog, { AppDialogCloseButton } from "@/components/AppDialog";
import { useAdminViewState } from "@/components/AdminViewState";
import { useAdminUser } from "@/components/AdminSession";
import { useNotifications } from "@/components/Notifications";
import { Alert, Briefcase, Check, Pencil, Plus, Refresh, Search, X } from "@/components/Icons";
import { Spinner, TableSkeleton } from "@/components/Loading";
import { useRowHighlight } from "@/components/RowHighlight";
import { TablePagination, useTablePagination } from "@/components/Pagination";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ApiError, jobRolesApi, JobRole } from "@/lib/api";

const ROLES_MANAGE = "ADMIN"; // crear/editar/desactivar cargos: solo ADMIN

type RoleCreateDraft = { name: string; description: string };

const EMPTY_CREATE_DRAFT: RoleCreateDraft = { name: "", description: "" };

export default function AdminRolesPage() {
  const user = useAdminUser();
  const { success } = useNotifications();
  const { markSaved, isHighlighted } = useRowHighlight();

  const [roles, setRoles] = useState<JobRole[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Borrador del alta de cargo: un único objeto en memoria de sesión. Cada
  // edición crea un objeto nuevo, de modo que el éxito de un POST tardío solo
  // limpia el borrador exacto que se envió y nunca uno escrito después.
  const [createDraft, setCreateDraft] = useAdminViewState<RoleCreateDraft>(
    "jobRoles.createDraft",
    EMPTY_CREATE_DRAFT,
  );
  const [creating, setCreating] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Inline editing state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editError, setEditError] = useState<string | null>(null);
  const [actionKey, setActionKey] = useState<string | null>(null);

  // Search & in-memory filters
  const [search, setSearch] = useAdminViewState("jobRoles.search", "");
  const [debouncedSearch, setDebouncedSearch] = useState(() => search.trim());
  const [statusFilter, setStatusFilter] = useAdminViewState<"" | "active" | "inactive">(
    "jobRoles.statusFilter",
    "",
  );

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

  function openCreateDialog() {
    setCreateError(null);
    setShowCreate(true);
  }

  async function handleCreate(event: React.FormEvent) {
    event.preventDefault();
    if (creating) return;
    const submittedDraft = createDraft;
    const name = submittedDraft.name.trim();
    if (!name) return;
    setCreating(true);
    setCreateError(null);
    try {
      const created = await jobRolesApi.create(name, submittedDraft.description.trim() || null);
      setRoles((prev) => [...prev, created]);
      // Limpia únicamente el borrador enviado. Si mientras el POST estaba en
      // vuelo se editó el nombre o la descripción (incluso tras salir y
      // volver), el objeto actual es otro y el borrador nuevo se conserva.
      setCreateDraft((current) => (current === submittedDraft ? { ...EMPTY_CREATE_DRAFT } : current));
      setShowCreate(false);
      markSaved(created.id);
      success(`Cargo "${created.name}" creado con éxito.`);
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : "No se pudo crear el cargo");
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

      {/* Toolbar with Search, Status Filter and Summary */}
      <div className="toolbar roles-filters-toolbar" role="search" aria-label="Búsqueda y filtros de cargos laborales">
        <div className="roles-search-field">
          <Search size={15} className="roles-search-icon" />
          <input
            id={searchInputId}
            type="text"
            className="input roles-search-input"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por cargo o descripción…"
            aria-label="Buscar cargo laboral por nombre o descripción"
          />
        </div>

        <Select
          value={statusFilter || "__all"}
          onValueChange={(val) => setStatusFilter(val === "__all" ? "" : (val as "active" | "inactive"))}
        >
          <SelectTrigger aria-label="Filtrar por estado del cargo" className="roles-filter">
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
            className="btn btn-ghost btn-sm roles-clear-filter"
            onClick={clearFilters}
            aria-label="Limpiar filtros de búsqueda"
          >
            <X size={14} /> Limpiar filtros
          </button>
        )}

        <span className="spacer" />
        <span className="roles-count">
          {filteredRoles.length} de {roles.length} cargos · {activeRolesCount} activos
        </span>
        {canManage && (
          <button
            type="button"
            className="btn btn-primary roles-create"
            onClick={openCreateDialog}
            disabled={editingId !== null}
            title={editingId !== null ? "Termina la edición en línea antes de crear un cargo" : undefined}
            aria-haspopup="dialog"
            aria-expanded={showCreate}
          >
            <Plus size={15} /> Nuevo cargo
          </button>
        )}
      </div>

      <div className="table-wrap roles-table-wrap employee-stack-wrap">
        <table className="table roles-table employee-stack-table">
          <thead>
            <tr>
              <th className="roles-col-name">Nombre</th>
              <th className="roles-col-description">Descripción</th>
              <th className="roles-col-status">Estado</th>
              {canManage && <th className="roles-col-actions" style={{ textAlign: "right" }}>Acciones</th>}
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
                <td data-label="Nombre" className="roles-name-cell">
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
                    <span className="role-name">{role.name}</span>
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
                  <td data-label="Acciones" className="roles-actions-cell">
                    <div className="roles-actions-group">
                      {editingId === role.id ? (
                        <>
                          <button
                            type="button"
                            className="btn btn-green btn-sm role-action role-action--save"
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
                            className="btn btn-outline btn-sm role-action role-action--cancel"
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
                            className="btn btn-outline btn-sm role-action role-action--edit"
                            onClick={() => startEdit(role)}
                            aria-label={`Editar cargo ${role.name}`}
                          >
                            <Pencil size={13} /> Editar
                          </button>
                          <button
                            type="button"
                            className={`btn btn-outline btn-sm role-action ${role.active ? "role-action--danger" : "role-action--activate"}`}
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

      {canManage && showCreate && (
        <AppDialog
          className="admin-form-dialog roles-create-dialog"
          labelledBy="roles-create-title"
          describedBy="roles-create-desc"
          dismissible={!creating}
          onClose={() => setShowCreate(false)}
        >
          <div className="admin-form-heading">
            <div>
              <h2 id="roles-create-title">Nuevo cargo laboral</h2>
              <p id="roles-create-desc">
                Define el puesto operativo que podrás asignar a los empleados. No es un rol de acceso al sistema.
              </p>
            </div>
            <AppDialogCloseButton
              className="btn btn-ghost btn-sm app-dialog-close"
              aria-label="Cerrar creación de cargo"
              disabled={creating}
            >
              <X size={16} />
            </AppDialogCloseButton>
          </div>

          <form onSubmit={handleCreate} className="admin-form roles-create-form">
            {createError && (
              <p className="alert alert-error" role="alert">
                <Alert size={15} style={{ marginTop: 2, flexShrink: 0 }} />
                {createError}
              </p>
            )}
            <div className="admin-form-grid roles-create-fields">
              <div className="admin-field admin-field--full">
                <label className="label" htmlFor={newNameId}>
                  Nuevo cargo laboral
                </label>
                <input
                  id={newNameId}
                  type="text"
                  className="input"
                  value={createDraft.name}
                  onChange={(e) =>
                    setCreateDraft((current) => ({ ...current, name: e.target.value }))
                  }
                  required
                  placeholder="Ej. Operario de envasado"
                  autoComplete="off"
                  disabled={creating}
                  data-autofocus
                />
              </div>
              <div className="admin-field admin-field--full">
                <label className="label" htmlFor={newDescId}>
                  Descripción del puesto <em>(opcional)</em>
                </label>
                <input
                  id={newDescId}
                  type="text"
                  className="input"
                  value={createDraft.description}
                  onChange={(e) =>
                    setCreateDraft((current) => ({ ...current, description: e.target.value }))
                  }
                  placeholder="Ej. Planta de tratamiento y llenado"
                  autoComplete="off"
                  disabled={creating}
                />
              </div>
            </div>
            <div className="admin-form-actions roles-create-actions">
              <AppDialogCloseButton className="btn btn-outline" disabled={creating}>
                Cancelar
              </AppDialogCloseButton>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={creating || !createDraft.name.trim()}
                aria-busy={creating}
              >
                {creating ? <Spinner /> : <Plus size={15} />}
                {creating ? "Creando cargo…" : "Crear cargo"}
              </button>
            </div>
          </form>
        </AppDialog>
      )}

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
