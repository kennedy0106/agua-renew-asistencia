
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import AdminShell from "@/components/AdminShell";
import AppDialog, { AppDialogCloseButton } from "@/components/AppDialog";
import { useAdminUser } from "@/components/AdminSession";
import { useNotifications } from "@/components/Notifications";
import { Alert, Check, Eye, EyeOff, Key, Plus, Refresh, Search, Shield, User as UserIcon, X } from "@/components/Icons";
import { InlineLoading, Spinner, TableSkeleton } from "@/components/Loading";
import { useRowHighlight } from "@/components/RowHighlight";
import { TablePagination, useTablePagination } from "@/components/Pagination";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AdminUser, ApiError, employeesApi, Employee, SystemRole, systemRolesApi, usersApi } from "@/lib/api";

function formatLastLogin(value: string | null) {
  if (!value) return "Sin acceso registrado";
  return new Date(value).toLocaleString("es-PE", {
    timeZone: "America/Lima",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function generateSecurePassword(): string {
  const charset = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!#$";
  let extra = "";
  for (let i = 0; i < 6; i++) {
    extra += charset.charAt(Math.floor(Math.random() * charset.length));
  }
  return `Renew#${extra}`;
}

export default function AdminUsersPage() {
  const user = useAdminUser();
  const { success } = useNotifications();

  const [users, setUsers] = useState<AdminUser[]>([]);
  const [roles, setRoles] = useState<SystemRole[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { markSaved, isHighlighted } = useRowHighlight();

  // Search & in-memory filters
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<"" | "active" | "inactive" | "pending_password">("");

  // Creation form
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ username: "", system_role_id: "", employee_id: "" });
  const [createdCredential, setCreatedCredential] = useState<{ username: string; password: string } | null>(null);
  const [credentialNotice, setCredentialNotice] = useState<string | null>(null);
  const [hasCopiedCredential, setHasCopiedCredential] = useState(false);

  // References
  const credentialCopyRef = useRef<HTMLButtonElement>(null);
  const newUserButtonRef = useRef<HTMLButtonElement>(null);
  const credentialDialogRef = useRef<HTMLElement>(null);
  const escapeAttemptRef = useRef(0);

  // Reset password modal
  const [resetUser, setResetUser] = useState<AdminUser | null>(null);
  const [resetPassword, setResetPassword] = useState("");
  const [showResetPassword, setShowResetPassword] = useState(false);
  const [resetCopied, setResetCopied] = useState(false);

  // Confirmation dialogs before sensitive mutations
  const [confirmRoleChange, setConfirmRoleChange] = useState<{
    user: AdminUser;
    targetRoleId: string;
    currentRoleName: string;
    targetRoleName: string;
  } | null>(null);

  const [confirmToggleActive, setConfirmToggleActive] = useState<AdminUser | null>(null);

  const [confirmEmployeeLink, setConfirmEmployeeLink] = useState<{
    user: AdminUser;
    targetEmployeeId: string | null;
    employeeLabel: string;
  } | null>(null);

  const [rowAction, setRowAction] = useState<string | null>(null);

  const searchInputId = useId();
  const createUsernameId = useId();
  const resetPasswordInputId = useId();

  const isAdmin = user?.role === "ADMIN";

  // Debounce search
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 240);
    return () => window.clearTimeout(timer);
  }, [search]);

  // Load data
  const load = useCallback(async () => {
    try {
      if (user?.role !== "ADMIN") return;
      setError(null);
      const [list, roleList, empList] = await Promise.all([
        usersApi.list(),
        systemRolesApi.list(),
        employeesApi.list(),
      ]);
      setUsers(list);
      setRoles(roleList);
      setEmployees(empList);
      if (roleList.length > 0 && !form.system_role_id) {
        setForm((current) => ({ ...current, system_role_id: roleList[0].id }));
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Error de conexión con el servidor");
    } finally {
      setLoading(false);
    }
  }, [user, form.system_role_id]);

  useEffect(() => {
    load();
  }, [load]);

  const reload = useCallback(async () => {
    const [list, roleList, empList] = await Promise.all([
      usersApi.list(),
      systemRolesApi.list(),
      employeesApi.list(),
    ]);
    setUsers(list);
    setRoles(roleList);
    setEmployees(empList);
  }, []);

  // Filtered users (in-memory only over loaded dataset)
  const filteredUsers = useMemo(() => {
    return users.filter((item) => {
      if (debouncedSearch) {
        const query = debouncedSearch.toLowerCase();
        const matchUser = item.username.toLowerCase().includes(query);
        const matchEmp = (item.employee_name || "").toLowerCase().includes(query);
        if (!matchUser && !matchEmp) return false;
      }
      if (roleFilter && item.system_role_id !== roleFilter) return false;
      if (statusFilter === "active" && !item.active) return false;
      if (statusFilter === "inactive" && item.active) return false;
      if (statusFilter === "pending_password" && !item.must_change_password) return false;
      return true;
    });
  }, [users, debouncedSearch, roleFilter, statusFilter]);

  const pagination = useTablePagination(
    filteredUsers,
    `${debouncedSearch}:${roleFilter}:${statusFilter}:${filteredUsers.length}`,
  );

  const activeUsers = useMemo(() => users.filter((item) => item.active).length, [users]);
  const pendingCredentials = useMemo(() => users.filter((item) => item.must_change_password).length, [users]);
  const linkedUsers = useMemo(() => users.filter((item) => item.employee_id).length, [users]);

  const roleName = useCallback((id: string) => roles.find((role) => role.id === id)?.name ?? "—", [roles]);

  function closeCredential() {
    setCreatedCredential(null);
    setCredentialNotice(null);
    setHasCopiedCredential(false);
    escapeAttemptRef.current = 0;
    window.requestAnimationFrame(() => newUserButtonRef.current?.focus());
  }

  // Keyboard navigation & safe escape for credential modal
  useEffect(() => {
    if (!createdCredential) return;
    credentialCopyRef.current?.focus();
    escapeAttemptRef.current = 0;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (hasCopiedCredential || escapeAttemptRef.current >= 1) {
          closeCredential();
          return;
        }
        event.preventDefault();
        escapeAttemptRef.current += 1;
        setCredentialNotice("Copia la credencial antes de cerrar, o presiona Escape nuevamente para confirmar cierre.");
        credentialCopyRef.current?.focus();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        credentialDialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [createdCredential, hasCopiedCredential]);

  // Create user
  async function handleCreate(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const created = await usersApi.create({
        username: form.username,
        system_role_id: form.system_role_id,
        employee_id: form.employee_id || null,
      });
      setShowForm(false);
      setForm({ username: "", system_role_id: form.system_role_id, employee_id: "" });
      setCredentialNotice(null);
      setHasCopiedCredential(false);
      setCreatedCredential({ username: created.username, password: created.temporary_password });
      success(`Usuario "${created.username}" creado con éxito.`);
      markSaved(created.id);
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo crear el usuario");
    } finally {
      setBusy(false);
    }
  }

  // Sensitive action: Role change initiation
  function initiateRoleChange(target: AdminUser, newRoleId: string) {
    if (target.system_role_id === newRoleId) return;
    const currentName = roleName(target.system_role_id);
    const targetName = roleName(newRoleId);
    setConfirmRoleChange({
      user: target,
      targetRoleId: newRoleId,
      currentRoleName: currentName,
      targetRoleName: targetName,
    });
  }

  async function executeRoleChange() {
    if (!confirmRoleChange) return;
    const { user: target, targetRoleId, targetRoleName } = confirmRoleChange;
    setBusy(true);
    setRowAction(`role:${target.id}`);
    setError(null);
    try {
      await usersApi.update(target.id, { system_role_id: targetRoleId });
      success(`Rol de "${target.username}" cambiado a ${targetRoleName}.`);
      markSaved(target.id);
      setConfirmRoleChange(null);
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo cambiar el rol");
    } finally {
      setBusy(false);
      setRowAction(null);
    }
  }

  // Sensitive action: Toggle active status
  function initiateToggleActive(target: AdminUser) {
    setConfirmToggleActive(target);
  }

  async function executeToggleActive() {
    if (!confirmToggleActive) return;
    const target = confirmToggleActive;
    setBusy(true);
    setRowAction(`active:${target.id}`);
    setError(null);
    try {
      await usersApi.update(target.id, { active: !target.active });
      success(
        target.active
          ? `Acceso de "${target.username}" desactivado correctamente.`
          : `Acceso de "${target.username}" reactivado correctamente.`,
      );
      markSaved(target.id);
      setConfirmToggleActive(null);
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo actualizar el estado del usuario");
    } finally {
      setBusy(false);
      setRowAction(null);
    }
  }

  // Sensitive action: Employee link
  function initiateEmployeeLink(target: AdminUser, newEmpId: string) {
    const effectiveNewId = newEmpId || null;
    if (target.employee_id === effectiveNewId) return;
    const emp = employees.find((e) => e.id === newEmpId);
    const label = emp ? `${emp.first_name} ${emp.last_name} (${emp.dni})` : "Sin vincular";
    setConfirmEmployeeLink({
      user: target,
      targetEmployeeId: effectiveNewId,
      employeeLabel: label,
    });
  }

  async function executeEmployeeLink() {
    if (!confirmEmployeeLink) return;
    const { user: target, targetEmployeeId, employeeLabel } = confirmEmployeeLink;
    setBusy(true);
    setRowAction(`employee:${target.id}`);
    setError(null);
    try {
      await usersApi.update(target.id, { employee_id: targetEmployeeId });
      success(
        targetEmployeeId
          ? `Cuenta de "${target.username}" vinculada a ${employeeLabel}.`
          : `Cuenta de "${target.username}" desvinculada de empleado.`,
      );
      markSaved(target.id);
      setConfirmEmployeeLink(null);
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo vincular el empleado");
    } finally {
      setBusy(false);
      setRowAction(null);
    }
  }

  // Password reset modal trigger
  function openResetModal(target: AdminUser) {
    setResetUser(target);
    setResetPassword(generateSecurePassword());
    setShowResetPassword(true);
    setResetCopied(false);
  }

  async function executePasswordReset() {
    if (!resetUser || resetPassword.length < 8) return;
    setBusy(true);
    setError(null);
    try {
      await usersApi.resetPassword(resetUser.id, resetPassword);
      success(`Contraseña restablecida exitosamente para "${resetUser.username}".`);
      markSaved(resetUser.id);
      setResetUser(null);
      setResetPassword("");
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo restablecer la contraseña");
    } finally {
      setBusy(false);
    }
  }

  const hasActiveFilters = Boolean(search || roleFilter || statusFilter);

  function clearFilters() {
    setSearch("");
    setDebouncedSearch("");
    setRoleFilter("");
    setStatusFilter("");
  }

  return (
    <AdminShell
      title="Usuarios del sistema"
      subtitle="Gestión de cuentas y perfiles de acceso administrativo · no confundir con cargos laborales"
    >
      {!isAdmin && (
        <p className="alert alert-error" role="alert">
          <Alert size={15} className="alert-icon" />
          Solo los administradores del sistema gestionan cuentas de usuario.
        </p>
      )}

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

      {isAdmin && (
        <section className="users-commandbar" aria-label="Resumen y acciones de usuarios">
          <div className="users-commandbar-copy">
            <p className="users-commandbar-summary">
              {loading ? (
                <InlineLoading label="Cargando accesos…" />
              ) : (
                `${filteredUsers.length} de ${users.length} usuarios · ${activeUsers} activos · ${linkedUsers} vinculados`
              )}
            </p>
            {!loading && pendingCredentials > 0 && (
              <p className="users-commandbar-note">{pendingCredentials} con cambio de clave pendiente</p>
            )}
          </div>
          <button
            ref={newUserButtonRef}
            type="button"
            className={showForm ? "btn btn-outline" : "btn btn-primary"}
            aria-expanded={showForm}
            aria-controls="users-create-form"
            onClick={() => setShowForm((value) => !value)}
          >
            {showForm ? (
              <>
                <X size={15} /> Cancelar
              </>
            ) : (
              <>
                <Plus size={15} /> Nuevo usuario
              </>
            )}
          </button>
        </section>
      )}

      {isAdmin && (
        <div className="toolbar users-filters-toolbar" role="search" aria-label="Búsqueda y filtros de usuarios">
          <div className="users-search-field">
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
              placeholder="Buscar por usuario o empleado…"
              aria-label="Buscar por usuario o empleado vinculado"
              style={{ paddingLeft: "2.1rem" }}
            />
          </div>

          <Select value={roleFilter || "__all"} onValueChange={(val) => setRoleFilter(val === "__all" ? "" : val)}>
            <SelectTrigger aria-label="Filtrar por rol del sistema" style={{ minWidth: 170, maxWidth: 220 }}>
              <SelectValue placeholder="Todos los roles" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all">Todos los roles</SelectItem>
              {roles.map((r) => (
                <SelectItem key={r.id} value={r.id}>
                  {r.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select
            value={statusFilter || "__all"}
            onValueChange={(val) =>
              setStatusFilter(val === "__all" ? "" : (val as "active" | "inactive" | "pending_password"))
            }
          >
            <SelectTrigger aria-label="Filtrar por estado del usuario" style={{ minWidth: 160, maxWidth: 200 }}>
              <SelectValue placeholder="Todos los estados" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all">Todos los estados</SelectItem>
              <SelectItem value="active">Solo activos</SelectItem>
              <SelectItem value="inactive">Solo inactivos</SelectItem>
              <SelectItem value="pending_password">Clave temporal</SelectItem>
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
        </div>
      )}

      {isAdmin && showForm && (
        <form id="users-create-form" onSubmit={handleCreate} className="users-create-form">
          <div className="users-create-heading">
            <div>
              <h2>Crear acceso de sistema</h2>
              <p>
                Asigna nombre de usuario, rol y opcionalmente el empleado asociado. La contraseña temporal se generará y
                mostrará una sola vez.
              </p>
            </div>
          </div>
          <div className="users-create-fields">
            <div className="users-field">
              <label className="label" htmlFor={createUsernameId}>
                Nombre de usuario
              </label>
              <input
                id={createUsernameId}
                type="text"
                className="input"
                value={form.username}
                onChange={(event) => setForm({ ...form, username: event.target.value })}
                required
                minLength={3}
                placeholder="Ej. c.rodriguez"
                autoComplete="username"
              />
            </div>

            <div className="users-field">
              <span className="label" id="create-user-role-label">
                Rol del sistema
              </span>
              <Select
                value={form.system_role_id}
                onValueChange={(value) => setForm({ ...form, system_role_id: value })}
              >
                <SelectTrigger id="create-user-role" aria-labelledby="create-user-role-label" aria-label="Rol del sistema">
                  <SelectValue placeholder="Seleccionar rol" />
                </SelectTrigger>
                <SelectContent>
                  {roles.map((role) => (
                    <SelectItem key={role.id} value={role.id}>
                      {role.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="users-field users-field-wide">
              <span className="label" id="create-user-employee-label">
                Empleado vinculado <em>(opcional)</em>
              </span>
              <Select
                value={form.employee_id || "__none"}
                onValueChange={(value) => setForm({ ...form, employee_id: value === "__none" ? "" : value })}
              >
                <SelectTrigger
                  id="create-user-employee"
                  aria-labelledby="create-user-employee-label"
                  aria-label="Empleado vinculado"
                >
                  <SelectValue placeholder="— Sin vincular —" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none">— Sin vincular —</SelectItem>
                  {employees.map((employee) => (
                    <SelectItem key={employee.id} value={employee.id}>
                      {employee.first_name} {employee.last_name} ({employee.dni})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="users-field-help">
                Asocia esta cuenta de acceso con el expediente en nómina para auditoría y firmas.
              </p>
            </div>

            <div className="users-create-actions">
              <button type="submit" className="btn btn-primary" disabled={busy} aria-busy={busy}>
                {busy ? <Spinner /> : <Plus size={15} />} {busy ? "Creando usuario…" : "Crear usuario"}
              </button>
            </div>
          </div>
        </form>
      )}

      <div className="table-wrap users-table-wrap">
        <table className="table users-table">
          <thead>
            <tr>
              <th>Usuario</th>
              <th>Rol de acceso</th>
              <th>Empleado vinculado</th>
              <th>Estado</th>
              <th>Último acceso</th>
              <th className="users-actions-head">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {loading && <TableSkeleton rows={5} cols={6} />}
            {!loading && isAdmin && filteredUsers.length === 0 && (
              <tr>
                <td colSpan={6} className="empty">
                  <Key size={26} />
                  <div>
                    {hasActiveFilters
                      ? "No se encontraron usuarios con los filtros aplicados."
                      : "Sin usuarios registrados en el sistema."}
                  </div>
                  {hasActiveFilters && (
                    <button type="button" className="btn btn-outline btn-sm" onClick={clearFilters}>
                      <X size={14} /> Limpiar filtros
                    </button>
                  )}
                </td>
              </tr>
            )}
            {pagination.pageItems.map((item) => (
              <tr
                key={item.id}
                className={
                  [
                    item.active ? "" : "users-row-inactive",
                    isHighlighted(item.id) ? "row-saved" : "",
                  ]
                    .filter(Boolean)
                    .join(" ") || undefined
                }
              >
                <td data-label="Usuario">
                  <div className="users-identity">
                    <strong>{item.username}</strong>
                    {item.id === user?.id && <span className="badge badge-blue">Tú</span>}
                  </div>
                </td>
                <td data-label="Rol de acceso">
                  {isAdmin ? (
                    <Select
                      value={item.system_role_id}
                      disabled={rowAction !== null}
                      onValueChange={(value) => initiateRoleChange(item, value)}
                    >
                      <SelectTrigger
                        className="users-row-select"
                        aria-label={`Rol de ${item.username}, actualmente ${roleName(item.system_role_id)}`}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {roles.map((role) => (
                          <SelectItem key={role.id} value={role.id}>
                            {role.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    roleName(item.system_role_id)
                  )}
                </td>
                <td data-label="Empleado vinculado">
                  {isAdmin ? (
                    <Select
                      value={item.employee_id ?? "__none"}
                      disabled={rowAction !== null}
                      onValueChange={(value) => initiateEmployeeLink(item, value === "__none" ? "" : value)}
                    >
                      <SelectTrigger
                        className="users-row-select"
                        aria-label={`Empleado vinculado a ${item.username}, actualmente ${item.employee_name ?? "ninguno"}`}
                      >
                        <SelectValue placeholder="— Sin vincular —" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none">— Sin vincular —</SelectItem>
                        {employees.map((employee) => (
                          <SelectItem key={employee.id} value={employee.id}>
                            {employee.first_name} {employee.last_name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    item.employee_name ?? "—"
                  )}
                </td>
                <td data-label="Estado">
                  <div className="users-statuses">
                    <span className={`badge ${item.active ? "badge-green" : "badge-neutral"}`}>
                      {item.active ? "Activo" : "Inactivo"}
                    </span>
                    {item.must_change_password && <span className="badge badge-amber">Clave temporal</span>}
                  </div>
                </td>
                <td data-label="Último acceso" className="users-last-login">
                  {formatLastLogin(item.last_login_at)}
                </td>
                <td data-label="Acciones" className="users-actions-cell">
                  <div className="users-row-actions">
                    {(rowAction === `role:${item.id}` || rowAction === `employee:${item.id}`) && (
                      <InlineLoading label="Guardando…" />
                    )}
                    {item.id !== user?.id && (
                      <button
                        type="button"
                        className={`btn btn-sm ${item.active ? "btn-danger" : "btn-green"}`}
                        disabled={rowAction !== null}
                        aria-busy={rowAction === `active:${item.id}`}
                        aria-label={`${item.active ? "Desactivar" : "Activar"} acceso de ${item.username}`}
                        onClick={() => initiateToggleActive(item)}
                      >
                        {rowAction === `active:${item.id}` && <Spinner />}
                        {rowAction === `active:${item.id}`
                          ? "Actualizando…"
                          : item.active
                            ? "Desactivar"
                            : "Activar"}
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn btn-amber btn-sm"
                      onClick={() => openResetModal(item)}
                      aria-label={`Restablecer contraseña de ${item.username}`}
                    >
                      <Refresh size={13} /> Reset clave
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <TablePagination {...pagination} />

      {/* Modal: Confirm Role Change */}
      {confirmRoleChange && (
        <AppDialog
          labelledBy="role-confirm-title"
          describedBy="role-confirm-desc"
          onClose={() => setConfirmRoleChange(null)}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", marginBottom: "0.4rem" }}>
            <div
              style={{
                width: "2.4rem",
                height: "2.4rem",
                borderRadius: "var(--radius-control, 0.35rem)",
                background: "rgba(0, 102, 204, 0.12)",
                color: "var(--brand-ink, #154399)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Shield size={20} />
            </div>
            <h2 id="role-confirm-title" className="card-title" style={{ margin: 0 }}>
              ¿Cambiar rol de acceso a {confirmRoleChange.user.username}?
            </h2>
          </div>
          <p id="role-confirm-desc" className="card-sub" style={{ marginTop: "0.4rem" }}>
            El usuario pasará del rol <strong>{confirmRoleChange.currentRoleName}</strong> al rol{" "}
            <strong>{confirmRoleChange.targetRoleName}</strong>. Esta acción modificará sus facultades y permisos en el
            sistema en su próxima solicitud o inicio de sesión.
          </p>
          <div
            className="app-dialog-actions"
            style={{ marginTop: "1.4rem", display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}
          >
            <AppDialogCloseButton className="btn btn-outline" disabled={busy}>
              Cancelar
            </AppDialogCloseButton>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={() => void executeRoleChange()}
            >
              {busy ? <Spinner /> : <Shield size={14} />}
              {busy ? "Guardando…" : "Confirmar cambio de rol"}
            </button>
          </div>
        </AppDialog>
      )}

      {/* Modal: Confirm Toggle Active */}
      {confirmToggleActive && (
        <AppDialog
          labelledBy="active-confirm-title"
          describedBy="active-confirm-desc"
          onClose={() => setConfirmToggleActive(null)}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", marginBottom: "0.4rem" }}>
            <div
              style={{
                width: "2.4rem",
                height: "2.4rem",
                borderRadius: "var(--radius-control, 0.35rem)",
                background: confirmToggleActive.active ? "rgba(180, 35, 24, 0.12)" : "rgba(0, 200, 83, 0.12)",
                color: confirmToggleActive.active ? "var(--incident, #b42318)" : "var(--brand-green, #00a047)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              {confirmToggleActive.active ? <Alert size={20} /> : <Check size={20} />}
            </div>
            <h2 id="active-confirm-title" className="card-title" style={{ margin: 0 }}>
              {confirmToggleActive.active
                ? `¿Desactivar acceso a ${confirmToggleActive.username}?`
                : `¿Reactivar acceso a ${confirmToggleActive.username}?`}
            </h2>
          </div>
          <p id="active-confirm-desc" className="card-sub" style={{ marginTop: "0.4rem" }}>
            {confirmToggleActive.active
              ? "Al desactivar esta cuenta, la persona no podrá iniciar sesión en el panel administrativo. Su historial de auditoría y registros se conserva y podrás reactivarla cuando sea necesario."
              : "Al reactivar esta cuenta, la persona podrá volver a iniciar sesión en el sistema inmediatamente con sus credenciales autorizadas."}
          </p>
          <div
            className="app-dialog-actions"
            style={{ marginTop: "1.4rem", display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}
          >
            <AppDialogCloseButton className="btn btn-outline" disabled={busy}>
              Cancelar
            </AppDialogCloseButton>
            <button
              type="button"
              className={`btn ${confirmToggleActive.active ? "btn-danger" : "btn-green"}`}
              disabled={busy}
              onClick={() => void executeToggleActive()}
            >
              {busy ? <Spinner /> : null}
              {busy
                ? "Actualizando…"
                : confirmToggleActive.active
                  ? "Sí, desactivar usuario"
                  : "Sí, reactivar usuario"}
            </button>
          </div>
        </AppDialog>
      )}

      {/* Modal: Confirm Employee Link */}
      {confirmEmployeeLink && (
        <AppDialog
          labelledBy="link-confirm-title"
          describedBy="link-confirm-desc"
          onClose={() => setConfirmEmployeeLink(null)}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", marginBottom: "0.4rem" }}>
            <div
              style={{
                width: "2.4rem",
                height: "2.4rem",
                borderRadius: "var(--radius-control, 0.35rem)",
                background: "rgba(0, 102, 204, 0.12)",
                color: "var(--brand-ink, #154399)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <UserIcon size={20} />
            </div>
            <h2 id="link-confirm-title" className="card-title" style={{ margin: 0 }}>
              ¿Modificar vinculación de empleado para {confirmEmployeeLink.user.username}?
            </h2>
          </div>
          <p id="link-confirm-desc" className="card-sub" style={{ marginTop: "0.4rem" }}>
            {confirmEmployeeLink.targetEmployeeId
              ? `Esta cuenta de acceso se vinculará con la ficha del colaborador ${confirmEmployeeLink.employeeLabel}. Esto asocia sus asistencias, firmas digitales y reportes en el panel.`
              : "Se desvinculará esta cuenta de cualquier ficha de personal en nómina. El usuario seguirá teniendo acceso según su rol."}
          </p>
          <div
            className="app-dialog-actions"
            style={{ marginTop: "1.4rem", display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}
          >
            <AppDialogCloseButton className="btn btn-outline" disabled={busy}>
              Cancelar
            </AppDialogCloseButton>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={() => void executeEmployeeLink()}
            >
              {busy ? <Spinner /> : null}
              {busy ? "Guardando…" : "Confirmar vinculación"}
            </button>
          </div>
        </AppDialog>
      )}

      {/* Modal: Password Reset */}
      {resetUser && (
        <AppDialog
          labelledBy="reset-pwd-title"
          describedBy="reset-pwd-desc"
          onClose={() => setResetUser(null)}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", marginBottom: "0.4rem" }}>
            <div
              style={{
                width: "2.4rem",
                height: "2.4rem",
                borderRadius: "var(--radius-control, 0.35rem)",
                background: "rgba(217, 119, 6, 0.12)",
                color: "#b45309",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Key size={20} />
            </div>
            <h2 id="reset-pwd-title" className="card-title" style={{ margin: 0 }}>
              Restablecer contraseña de {resetUser.username}
            </h2>
          </div>
          <p id="reset-pwd-desc" className="card-sub" style={{ marginTop: "0.4rem" }}>
            Asigna una nueva clave temporal de acceso. La persona deberá definir su contraseña definitiva en su próximo
            inicio de sesión.
          </p>

          <div style={{ marginTop: "1.1rem", display: "grid", gap: "0.8rem" }}>
            <div>
              <label className="label" htmlFor={resetPasswordInputId}>
                Nueva contraseña (mínimo 8 caracteres)
              </label>
              <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
                <input
                  id={resetPasswordInputId}
                  type={showResetPassword ? "text" : "password"}
                  className="input"
                  value={resetPassword}
                  onChange={(e) => setResetPassword(e.target.value)}
                  placeholder="Ej. Renew#2026-Xk8"
                  minLength={8}
                  autoComplete="new-password"
                  style={{ paddingRight: "3rem", width: "100%" }}
                  autoFocus
                />
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  style={{ position: "absolute", right: 4 }}
                  onClick={() => setShowResetPassword((prev) => !prev)}
                  aria-label={showResetPassword ? "Ocultar contraseña" : "Ver contraseña"}
                  title={showResetPassword ? "Ocultar contraseña" : "Ver contraseña"}
                >
                  {showResetPassword ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
              {resetPassword.length > 0 && resetPassword.length < 8 && (
                <p style={{ color: "var(--incident, #b42318)", fontSize: "0.75rem", marginTop: "0.25rem" }}>
                  La contraseña debe tener al menos 8 caracteres ({resetPassword.length}/8).
                </p>
              )}
            </div>

            <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "center" }}>
              <button
                type="button"
                className="btn btn-outline btn-sm"
                onClick={() => {
                  const generated = generateSecurePassword();
                  setResetPassword(generated);
                  setShowResetPassword(true);
                }}
              >
                <Key size={13} /> Generar contraseña segura
              </button>
              {resetPassword.length >= 8 && (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(resetPassword);
                      setResetCopied(true);
                      setTimeout(() => setResetCopied(false), 2500);
                    } catch {
                      // ignore clipboard write failure
                    }
                  }}
                >
                  {resetCopied ? <Check size={13} style={{ color: "var(--brand-green, #00c853)" }} /> : null}
                  {resetCopied ? "¡Copiada al portapapeles!" : "Copiar clave"}
                </button>
              )}
            </div>
          </div>

          <div
            className="app-dialog-actions"
            style={{ marginTop: "1.4rem", display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}
          >
            <AppDialogCloseButton className="btn btn-outline" disabled={busy}>
              Cancelar
            </AppDialogCloseButton>
            <button
              type="button"
              className="btn btn-amber"
              disabled={resetPassword.length < 8 || busy}
              onClick={() => void executePasswordReset()}
            >
              {busy ? <Spinner /> : <Refresh size={14} />}
              {busy ? "Guardando…" : "Guardar nueva clave"}
            </button>
          </div>
        </AppDialog>
      )}

      {/* Modal: Created Credential */}
      {createdCredential && (
        <div
          className="dialog-backdrop credential-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setCredentialNotice("Copia la credencial antes de cerrar con «Entendido».");
            }
          }}
        >
          <section
            ref={credentialDialogRef}
            className="app-dialog credential-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="credential-title"
            aria-describedby="credential-description"
          >
            <div className="credential-dialog-header">
              <div className="credential-dialog-icon" aria-hidden>
                <Key size={21} />
              </div>
              <span className="credential-dialog-once">Visible una sola vez</span>
            </div>
            <div className="credential-dialog-copy">
              <h2 id="credential-title">Credencial temporal creada</h2>
              <p id="credential-description">
                Compártela solo por un canal seguro. Al ingresar, la persona deberá definir una nueva contraseña.
              </p>
            </div>
            <div className="credential-dialog-value">
              <div className="credential-value-row">
                <span>Usuario</span>
                <strong>{createdCredential.username}</strong>
              </div>
              <div className="credential-value-row">
                <span>Contraseña temporal</span>
                <code>{createdCredential.password}</code>
              </div>
            </div>
            <p className="credential-dialog-reminder">
              <Key size={15} /> Guárdala ahora: esta contraseña no volverá a mostrarse en el panel.
            </p>
            <div className="app-dialog-actions credential-dialog-actions">
              <button
                ref={credentialCopyRef}
                type="button"
                className="btn btn-primary"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(
                      `Usuario: ${createdCredential.username}\nContraseña temporal: ${createdCredential.password}`,
                    );
                    setHasCopiedCredential(true);
                    setCredentialNotice("Credencial copiada. Compártela únicamente por un canal seguro.");
                  } catch {
                    setCredentialNotice("No se pudo copiar automáticamente. Selecciónala manualmente.");
                  }
                }}
              >
                Copiar credencial
              </button>
              <button type="button" className="btn btn-secondary" onClick={closeCredential}>
                <Check size={15} /> Entendido
              </button>
            </div>
            <p className="credential-dialog-notice" role="status" aria-live="polite">
              {credentialNotice}
            </p>
          </section>
        </div>
      )}

    </AdminShell>
  );
}
