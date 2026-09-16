"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import AdminShell from "@/components/AdminShell";
import { useAdminUser } from "@/components/AdminSession";
import { Alert, Check, Key, Plus, Refresh, X } from "@/components/Icons";
import { TableSkeleton } from "@/components/Loading";
import { TablePagination, useTablePagination } from "@/components/Pagination";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AdminUser, ApiError, employeesApi, Employee, SystemRole, systemRolesApi, usersApi } from "@/lib/api";

function formatLastLogin(value: string | null) {
  if (!value) return "Sin acceso registrado";
  return new Date(value).toLocaleString("es-PE", { timeZone: "America/Lima", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export default function AdminUsersPage() {
  const user = useAdminUser();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [roles, setRoles] = useState<SystemRole[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ username: "", system_role_id: "", employee_id: "" });
  const [createdCredential, setCreatedCredential] = useState<{ username: string; password: string } | null>(null);
  const [credentialNotice, setCredentialNotice] = useState<string | null>(null);
  const credentialCopyRef = useRef<HTMLButtonElement>(null);
  const newUserButtonRef = useRef<HTMLButtonElement>(null);
  const credentialDialogRef = useRef<HTMLElement>(null);
  const [resettingId, setResettingId] = useState<string | null>(null);
  const [resetPassword, setResetPassword] = useState("");

  const isAdmin = user?.role === "ADMIN";
  const pagination = useTablePagination(users, users.length);
  const activeUsers = users.filter((item) => item.active).length;
  const pendingCredentials = users.filter((item) => item.must_change_password).length;
  const linkedUsers = users.filter((item) => item.employee_id).length;

  const load = useCallback(async () => {
    try {
      if (user?.role !== "ADMIN") return;
      const [list, roleList, empList] = await Promise.all([usersApi.list(), systemRolesApi.list(), employeesApi.list()]);
      setUsers(list);
      setRoles(roleList);
      setEmployees(empList);
      if (roleList.length > 0 && !form.system_role_id) setForm((current) => ({ ...current, system_role_id: roleList[0].id }));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Error de conexión con el servidor");
    } finally {
      setLoading(false);
    }
  }, [user, form.system_role_id]);

  useEffect(() => { load(); }, [load]);

  function closeCredential() {
    setCreatedCredential(null);
    setCredentialNotice(null);
    window.requestAnimationFrame(() => newUserButtonRef.current?.focus());
  }

  useEffect(() => {
    if (!createdCredential) return;
    credentialCopyRef.current?.focus();
    const keepFocusInDialog = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setCredentialNotice("Guarda la credencial antes de cerrar esta ventana con «Entendido».");
        credentialCopyRef.current?.focus();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(credentialDialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? []);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", keepFocusInDialog);
    return () => window.removeEventListener("keydown", keepFocusInDialog);
  }, [createdCredential]);

  async function reload() {
    const [list, roleList, empList] = await Promise.all([usersApi.list(), systemRolesApi.list(), employeesApi.list()]);
    setUsers(list); setRoles(roleList); setEmployees(empList);
  }

  async function handleCreate(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError(null);
    try {
      const created = await usersApi.create({ username: form.username, system_role_id: form.system_role_id, employee_id: form.employee_id || null });
      setShowForm(false);
      setForm({ username: "", system_role_id: form.system_role_id, employee_id: "" });
      setCredentialNotice(null);
      setCreatedCredential({ username: created.username, password: created.temporary_password });
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo crear el usuario");
    } finally { setBusy(false); }
  }

  async function handleToggleActive(target: AdminUser) {
    setError(null);
    try { await usersApi.update(target.id, { active: !target.active }); await reload(); }
    catch (err) { setError(err instanceof ApiError ? err.message : "No se pudo actualizar el estado"); }
  }
  async function handleRoleChange(target: AdminUser, roleId: string) {
    setError(null);
    try { await usersApi.update(target.id, { system_role_id: roleId }); await reload(); }
    catch (err) { setError(err instanceof ApiError ? err.message : "No se pudo cambiar el rol"); }
  }
  async function handleEmployeeLink(target: AdminUser, employeeId: string) {
    setError(null);
    try { await usersApi.update(target.id, { employee_id: employeeId || null }); await reload(); }
    catch (err) { setError(err instanceof ApiError ? err.message : "No se pudo vincular el empleado"); }
  }
  async function handleResetPassword(userId: string) {
    if (resetPassword.length < 8) return;
    setBusy(true); setError(null);
    try { await usersApi.resetPassword(userId, resetPassword); setResettingId(null); setResetPassword(""); }
    catch (err) { setError(err instanceof ApiError ? err.message : "No se pudo restablecer la contraseña"); }
    finally { setBusy(false); }
  }

  const roleName = (id: string) => roles.find((role) => role.id === id)?.name ?? "—";

  return (
    <AdminShell title="Usuarios del sistema" subtitle="Gestión exclusiva de administradores · un empleado no necesita usuario">
      {!isAdmin && <p className="alert alert-error" role="alert"><Alert size={15} className="alert-icon" />Solo los administradores gestionan usuarios.</p>}
      {error && <p className="alert alert-error" role="alert"><Alert size={15} className="alert-icon" />{error}</p>}

      {isAdmin && (
        <section className="users-commandbar" aria-label="Resumen y acciones de usuarios">
          <div className="users-commandbar-copy">
            <p className="users-commandbar-summary">{loading ? "Cargando accesos…" : `${users.length} usuarios · ${activeUsers} activos · ${linkedUsers} vinculados`}</p>
            {!loading && pendingCredentials > 0 && <p className="users-commandbar-note">{pendingCredentials} con cambio de clave pendiente</p>}
          </div>
          <button ref={newUserButtonRef} type="button" className={showForm ? "btn btn-outline" : "btn btn-primary"} aria-expanded={showForm} aria-controls="users-create-form" onClick={() => setShowForm((value) => !value)}>
            {showForm ? <><X size={15} /> Cancelar</> : <><Plus size={15} /> Nuevo usuario</>}
          </button>
        </section>
      )}

      {isAdmin && showForm && (
        <form id="users-create-form" onSubmit={handleCreate} className="users-create-form">
          <div className="users-create-heading"><div><h2>Crear acceso</h2><p>La contraseña temporal se mostrará una sola vez al finalizar.</p></div></div>
          <div className="users-create-fields">
            <label className="users-field"><span className="label">Usuario</span><input type="text" className="input" value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} required minLength={3} autoComplete="username" /></label>
            <div className="users-field"><span className="label">Rol</span><Select value={form.system_role_id} onValueChange={(value) => setForm({ ...form, system_role_id: value })}><SelectTrigger aria-label="Rol"><SelectValue placeholder="Seleccionar rol" /></SelectTrigger><SelectContent>{roles.map((role) => <SelectItem key={role.id} value={role.id}>{role.name}</SelectItem>)}</SelectContent></Select></div>
            <div className="users-field users-field-wide"><span className="label">Empleado vinculado <em>(opcional)</em></span><Select value={form.employee_id || "__none"} onValueChange={(value) => setForm({ ...form, employee_id: value === "__none" ? "" : value })}><SelectTrigger aria-label="Empleado vinculado"><SelectValue placeholder="— Sin vincular —" /></SelectTrigger><SelectContent><SelectItem value="__none">— Sin vincular —</SelectItem>{employees.map((employee) => <SelectItem key={employee.id} value={employee.id}>{employee.first_name} {employee.last_name} ({employee.dni})</SelectItem>)}</SelectContent></Select></div>
            <div className="users-create-actions"><button type="submit" className="btn btn-primary" disabled={busy}><Plus size={15} /> {busy ? "Creando…" : "Crear usuario"}</button></div>
          </div>
        </form>
      )}

      <div className="table-wrap users-table-wrap">
        <table className="table users-table">
          <thead><tr><th>Usuario</th><th>Rol</th><th>Empleado vinculado</th><th>Estado</th><th>Último acceso</th><th className="users-actions-head">Acciones</th></tr></thead>
          <tbody>
            {loading && <TableSkeleton rows={5} cols={6} />}
            {!loading && isAdmin && users.length === 0 && <tr><td colSpan={6} className="empty"><Key size={26} /> Sin usuarios registrados.</td></tr>}
            {pagination.pageItems.map((item) => (
              <tr key={item.id} className={item.active ? undefined : "users-row-inactive"}>
                <td data-label="Usuario"><div className="users-identity"><strong>{item.username}</strong>{item.id === user?.id && <span className="badge badge-blue">Tú</span>}</div></td>
                <td data-label="Rol">{isAdmin ? <Select value={item.system_role_id} onValueChange={(value) => handleRoleChange(item, value)}><SelectTrigger className="users-row-select" aria-label={`Rol de ${item.username}`}><SelectValue /></SelectTrigger><SelectContent>{roles.map((role) => <SelectItem key={role.id} value={role.id}>{role.name}</SelectItem>)}</SelectContent></Select> : roleName(item.system_role_id)}</td>
                <td data-label="Empleado vinculado">{isAdmin ? <Select value={item.employee_id ?? "__none"} onValueChange={(value) => handleEmployeeLink(item, value === "__none" ? "" : value)}><SelectTrigger className="users-row-select" aria-label={`Empleado vinculado a ${item.username}`}><SelectValue placeholder="— Sin vincular —" /></SelectTrigger><SelectContent><SelectItem value="__none">— Sin vincular —</SelectItem>{employees.map((employee) => <SelectItem key={employee.id} value={employee.id}>{employee.first_name} {employee.last_name}</SelectItem>)}</SelectContent></Select> : (item.employee_name ?? "—")}</td>
                <td data-label="Estado"><div className="users-statuses"><span className={`badge ${item.active ? "badge-green" : "badge-neutral"}`}>{item.active ? "Activo" : "Inactivo"}</span>{item.must_change_password && <span className="badge badge-amber">Clave temporal</span>}</div></td>
                <td data-label="Último acceso" className="users-last-login">{formatLastLogin(item.last_login_at)}</td>
                <td data-label="Acciones" className="users-actions-cell"><div className="users-row-actions">
                  {item.id !== user?.id && <button type="button" className={`btn btn-sm ${item.active ? "btn-danger" : "btn-green"}`} onClick={() => handleToggleActive(item)}>{item.active ? "Desactivar" : "Activar"}</button>}
                  {resettingId === item.id ? <div className="users-reset-inline"><input type="password" className="input users-reset-input" value={resetPassword} onChange={(event) => setResetPassword(event.target.value)} placeholder="Nueva clave (mín. 8)" minLength={8} autoComplete="new-password" /><button type="button" className="btn btn-amber btn-sm" onClick={() => handleResetPassword(item.id)} disabled={resetPassword.length < 8 || busy}>Guardar</button><button type="button" className="btn btn-ghost btn-sm" onClick={() => { setResettingId(null); setResetPassword(""); }} aria-label={`Cancelar cambio de clave de ${item.username}`}><X size={13} /></button></div> : <button type="button" className="btn btn-amber btn-sm" onClick={() => { setResettingId(item.id); setResetPassword(""); }}><Refresh size={13} /> Reset clave</button>}
                </div></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <TablePagination {...pagination} />

      {createdCredential && (
        <div className="dialog-backdrop credential-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setCredentialNotice("Guarda la credencial antes de cerrar esta ventana con «Entendido»."); }}>
          <section ref={credentialDialogRef} className="app-dialog credential-dialog" role="dialog" aria-modal="true" aria-labelledby="credential-title" aria-describedby="credential-description">
            <div className="credential-dialog-header"><div className="credential-dialog-icon" aria-hidden><Key size={21} /></div><span className="credential-dialog-once">Visible una sola vez</span></div>
            <div className="credential-dialog-copy"><h2 id="credential-title">Credencial temporal creada</h2><p id="credential-description">Compártela solo por un canal seguro. Al ingresar, la persona deberá definir una nueva contraseña.</p></div>
            <div className="credential-dialog-value"><div className="credential-value-row"><span>Usuario</span><strong>{createdCredential.username}</strong></div><div className="credential-value-row"><span>Contraseña temporal</span><code>{createdCredential.password}</code></div></div>
            <p className="credential-dialog-reminder"><Key size={15} /> Guárdala ahora: esta contraseña no volverá a mostrarse.</p>
            <div className="app-dialog-actions credential-dialog-actions"><button ref={credentialCopyRef} type="button" className="btn btn-primary" onClick={async () => { try { await navigator.clipboard.writeText(`Usuario: ${createdCredential.username}\nContraseña temporal: ${createdCredential.password}`); setCredentialNotice("Credencial copiada. Compártela únicamente por un canal seguro."); } catch { setCredentialNotice("No se pudo copiar. Selecciona la credencial y guárdala de forma segura."); } }}>Copiar credencial</button><button type="button" className="btn btn-secondary" onClick={closeCredential}><Check size={15} /> Entendido</button></div>
            <p className="credential-dialog-notice" role="status" aria-live="polite">{credentialNotice}</p>
          </section>
        </div>
      )}
    </AdminShell>
  );
}
