"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import AdminShell from "@/components/AdminShell";
import { useAdminUser } from "@/components/AdminSession";
import { Alert, Check, Key, Plus, Refresh, X } from "@/components/Icons";
import { TableSkeleton } from "@/components/Loading";
import { TablePagination, useTablePagination } from "@/components/Pagination";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AdminUser,
  ApiError,
  employeesApi,
  Employee,
  SystemRole,
  systemRolesApi,
  usersApi,
} from "@/lib/api";

export default function AdminUsersPage() {
  const user = useAdminUser();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [roles, setRoles] = useState<SystemRole[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    username: "",
    system_role_id: "",
    employee_id: "",
  });
  const [createdCredential, setCreatedCredential] = useState<{ username: string; password: string } | null>(null);
  const [credentialNotice, setCredentialNotice] = useState<string | null>(null);
  const credentialCloseRef = useRef<HTMLButtonElement>(null);
  const newUserButtonRef = useRef<HTMLButtonElement>(null);
  const credentialDialogRef = useRef<HTMLElement>(null);

  const [resettingId, setResettingId] = useState<string | null>(null);
  const [resetPassword, setResetPassword] = useState("");

  const isAdmin = user?.role === "ADMIN";
  const pagination = useTablePagination(users, users.length);

  const load = useCallback(async () => {
    try {
      if (user?.role !== "ADMIN") return;
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
      setError(err instanceof ApiError ? err.message : "Error de conexión con el servidor");
    } finally {
      setLoading(false);
    }
  }, [user, form.system_role_id]);

  useEffect(() => {
    load();
  }, [load]);

  function closeCredential() {
    setCreatedCredential(null);
    setCredentialNotice(null);
    window.requestAnimationFrame(() => newUserButtonRef.current?.focus());
  }

  useEffect(() => {
    if (!createdCredential) return;
    credentialCloseRef.current?.focus();

    const keepFocusInDialog = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // Es una credencial de una sola visualización: Escape no la descarta
        // accidentalmente. La acción explícita vuelve el foco al disparador.
        event.preventDefault();
        setCredentialNotice("Guarda la credencial antes de cerrar esta ventana con «Entendido».");
        credentialCloseRef.current?.focus();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(credentialDialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? []);
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
    window.addEventListener("keydown", keepFocusInDialog);
    return () => window.removeEventListener("keydown", keepFocusInDialog);
  }, [createdCredential]);


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
      const created = await usersApi.create({
        username: form.username,
        system_role_id: form.system_role_id,
        employee_id: form.employee_id || null,
      });
      setShowForm(false);
      setForm({ username: "", system_role_id: form.system_role_id, employee_id: "" });
      setCredentialNotice(null);
      setCreatedCredential({ username: created.username, password: created.temporary_password });
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

  const roleName = (id: string) => roles.find((r) => r.id === id)?.name ?? "—";

  return (
    <AdminShell
      title="Usuarios del sistema"
      subtitle="Gestión exclusiva de administradores · un empleado no necesita usuario"
    >
      {!isAdmin && (
        <p className="alert alert-error" role="alert">
          <Alert size={15} style={{ marginTop: 2, flexShrink: 0 }} />
          Solo los administradores gestionan usuarios.
        </p>
      )}

      {error && (
        <p className="alert alert-error" role="alert">
          <Alert size={15} style={{ marginTop: 2, flexShrink: 0 }} />
          {error}
        </p>
      )}

      {isAdmin && (
        <div className="toolbar">
          <span className="spacer" />
          <button ref={newUserButtonRef} className="btn btn-primary" onClick={() => setShowForm((v) => !v)}>
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
        </div>
      )}

      {isAdmin && showForm && (
        <form onSubmit={handleCreate} className="card card-pad" style={{ marginBottom: "1.1rem" }}>
          <div style={{ display: "grid", gap: "0.8rem", gridTemplateColumns: "repeat(auto-fit,minmax(170px,1fr))" }}>
            <div>
              <label className="label">Usuario</label>
              <input type="text" className="input" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} required minLength={3} />
            </div>
            <div>
              <label className="label">Rol</label>
              <Select value={form.system_role_id} onValueChange={(v) => setForm({ ...form, system_role_id: v })}>
                <SelectTrigger aria-label="Rol">
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
            <div>
              <label className="label">Empleado (opcional)</label>
              <Select value={form.employee_id || "__none"} onValueChange={(v) => setForm({ ...form, employee_id: v === "__none" ? "" : v })}>
                <SelectTrigger aria-label="Empleado">
                  <SelectValue placeholder="— Sin vincular —" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none">— Sin vincular —</SelectItem>
                  {employees.map((emp) => (
                    <SelectItem key={emp.id} value={emp.id}>
                      {emp.first_name} {emp.last_name} ({emp.dni})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div style={{ display: "flex", alignItems: "flex-end" }}>
              <button type="submit" className="btn btn-primary" disabled={busy}>
                <Plus size={15} />
                Crear
              </button>
            </div>
          </div>
        </form>
      )}

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Usuario</th>
              <th>Rol</th>
              <th>Empleado</th>
              <th>Estado</th>
              <th>Último acceso</th>
              <th style={{ textAlign: "right" }}>Acciones</th>
            </tr>
          </thead>
          <tbody>
            {loading && <TableSkeleton rows={5} cols={6} />}
            {!loading && isAdmin && users.length === 0 && (
              <tr>
                <td colSpan={6} className="empty">
                  <Key size={26} />
                  Sin usuarios registrados.
                </td>
              </tr>
            )}
            {pagination.pageItems.map((item) => (
              <tr key={item.id} style={item.active ? undefined : { opacity: 0.62 }}>
                <td style={{ fontWeight: 600 }}>
                  {item.username}
                  {item.id === user?.id && (
                    <span className="badge badge-blue" style={{ marginLeft: "0.4rem" }}>
                      tú
                    </span>
                  )}
                </td>
                <td>
                  {isAdmin ? (
                    <Select value={item.system_role_id} onValueChange={(v) => handleRoleChange(item, v)}>
                      <SelectTrigger aria-label="Rol" style={{ padding: "0.3rem 0.5rem", height: "2rem" }}>
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
                <td>
                  {isAdmin ? (
                    <Select value={item.employee_id ?? "__none"} onValueChange={(v) => handleEmployeeLink(item, v === "__none" ? "" : v)}>
                      <SelectTrigger aria-label="Empleado" style={{ padding: "0.3rem 0.5rem", height: "2rem" }}>
                        <SelectValue placeholder="— Sin vincular —" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none">— Sin vincular —</SelectItem>
                        {employees.map((emp) => (
                          <SelectItem key={emp.id} value={emp.id}>
                            {emp.first_name} {emp.last_name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    item.employee_name ?? "—"
                  )}
                </td>
                <td>
                  {item.active ? (
                    <span className="badge badge-green">Activo</span>
                  ) : (
                    <span className="badge badge-neutral">Inactivo</span>
                  )}
                  {item.must_change_password && <span className="badge badge-amber" style={{ marginLeft: "0.35rem" }}>Clave temporal</span>}
                </td>
                <td className="num" style={{ color: "var(--muted)" }}>
                  {item.last_login_at
                    ? new Date(item.last_login_at).toLocaleString("es-PE", {
                        timeZone: "America/Lima",
                        day: "2-digit",
                        month: "2-digit",
                        hour: "2-digit",
                        minute: "2-digit",
                      })
                    : "nunca"}
                </td>
                <td style={{ textAlign: "right" }}>
                  <div style={{ display: "flex", gap: "0.4rem", justifyContent: "flex-end", alignItems: "center" }}>
                    {item.id !== user?.id && (
                      <button
                        className={`btn btn-sm ${item.active ? "btn-danger" : "btn-green"}`}
                        onClick={() => handleToggleActive(item)}
                      >
                        {item.active ? "Desactivar" : "Activar"}
                      </button>
                    )}
                    {resettingId === item.id ? (
                      <span style={{ display: "flex", gap: "0.3rem", alignItems: "center" }}>
                        <input
                          type="password"
                          className="input"
                          style={{ width: 150, padding: "0.35rem 0.5rem" }}
                          value={resetPassword}
                          onChange={(e) => setResetPassword(e.target.value)}
                          placeholder="nueva clave (mín 8)"
                          minLength={8}
                        />
                        <button className="btn btn-amber btn-sm" onClick={() => handleResetPassword(item.id)} disabled={resetPassword.length < 8 || busy}>
                          OK
                        </button>
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={() => {
                            setResettingId(null);
                            setResetPassword("");
                          }}
                          aria-label="Cancelar"
                        >
                          <X size={13} />
                        </button>
                      </span>
                    ) : (
                      <button
                        className="btn btn-amber btn-sm"
                        onClick={() => {
                          setResettingId(item.id);
                          setResetPassword("");
                        }}
                      >
                        <Refresh size={13} />
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
      <TablePagination {...pagination} />
      {createdCredential && (
        <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setCredentialNotice("Guarda la credencial antes de cerrar esta ventana con «Entendido».");
        }}>
          <section ref={credentialDialogRef} className="app-dialog credential-dialog" role="dialog" aria-modal="true" aria-labelledby="credential-title" aria-describedby="credential-description">
            <div className="credential-dialog-icon" aria-hidden><Key size={21} /></div>
            <h2 id="credential-title">Credencial temporal creada</h2>
            <p id="credential-description">Entrega esta contraseña al usuario por un canal seguro. Se muestra una sola vez y deberá cambiarla al ingresar.</p>
            <div className="credential-dialog-value">
              <span>Usuario</span><strong>{createdCredential.username}</strong>
              <span>Contraseña temporal</span><code>{createdCredential.password}</code>
            </div>
            <div className="app-dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={async () => {
                try {
                  await navigator.clipboard.writeText(`Usuario: ${createdCredential.username}\nContraseña temporal: ${createdCredential.password}`);
                  setCredentialNotice("Credencial copiada. Compártela únicamente por un canal seguro.");
                } catch {
                  setCredentialNotice("No se pudo copiar. Selecciona la credencial y guárdala de forma segura.");
                }
              }}>Copiar credencial</button>
              <button ref={credentialCloseRef} type="button" className="btn btn-primary" onClick={closeCredential}><Check size={15} /> Entendido</button>
            </div>
            <p className="credential-dialog-notice" role="status" aria-live="polite">{credentialNotice}</p>
          </section>
        </div>
      )}
    </AdminShell>
  );
}
