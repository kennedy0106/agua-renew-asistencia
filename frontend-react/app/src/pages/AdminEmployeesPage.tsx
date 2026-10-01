
import { Link } from "react-router-dom";
import { useCallback, useEffect, useRef, useState } from "react";
import AdminShell from "@/components/AdminShell";
import AppDialog, { AppDialogCloseButton } from "@/components/AppDialog";
import { useAdminUser } from "@/components/AdminSession";
import { useNotifications } from "@/components/Notifications";
import DateField from "@/components/DateField";
import { Alert, Pencil, Plus, Search, Users, X } from "@/components/Icons";
import { Spinner, TableSkeleton } from "@/components/Loading";
import { useRowHighlight } from "@/components/RowHighlight";
import { TablePagination, useTablePagination } from "@/components/Pagination";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ApiError, employeesApi, Employee, jobRolesApi, JobRole } from "@/lib/api";

const MANAGE_ROLES = ["ADMIN", "BOSS"]; // crear/editar/desactivar: ADMIN y JEFE

const EMPTY_FORM = {
  dni: "",
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
  const [lookingUpDni, setLookingUpDni] = useState(false);
  const [dniLookupFeedback, setDniLookupFeedback] = useState<string | null>(null);
  const currentCreateDni = useRef(EMPTY_FORM.dni);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [edit, setEdit] = useState<Employee | null>(null);
  const [confirmDeactivate, setConfirmDeactivate] = useState<Employee | null>(null);

  const canManage = user ? MANAGE_ROLES.includes(user.role) : false;
  const { success } = useNotifications();
  const { markSaved, isHighlighted } = useRowHighlight();
  const pagination = useTablePagination(employees, `${debouncedSearch}:${statusFilter}:${employees.length}`);

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
      const created = await employeesApi.create({
        dni: form.dni,
        first_name: form.first_name,
        last_name: form.last_name,
        job_role_id: form.job_role_id,
        hire_date: form.hire_date || null,
      });
      setForm(EMPTY_FORM);
      setShowCreate(false);
      markSaved(created.id);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo crear el empleado");
    } finally {
      setCreating(false);
    }
  }

  function updateCreateDni(dni: string) {
    currentCreateDni.current = dni;
    setForm((current) => ({ ...current, dni }));
    setDniLookupFeedback(null);
  }

  async function handleDniLookup() {
    const dni = form.dni;
    if (!/^\d{8}$/.test(dni) || lookingUpDni) return;
    setLookingUpDni(true);
    setDniLookupFeedback(null);
    setError(null);
    try {
      const identity = await employeesApi.lookupDni(dni);
      const stillCurrent = currentCreateDni.current === dni;
      if (stillCurrent) setForm((current) => {
        // Si el operador modificó el DNI mientras respondía la consulta, no
        // vinculamos visualmente datos de otra persona al formulario actual.
        if (current.dni !== dni) return current;
        const lastName = [identity.first_last_name, identity.second_last_name].filter(Boolean).join(" ");
        return { ...current, first_name: identity.first_name, last_name: lastName };
      });
      if (stillCurrent) {
        setDniLookupFeedback("Nombres y apellidos completados. Puedes corregirlos antes de crear.");
        success("Datos del DNI completados");
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo consultar el DNI");
    } finally {
      setLookingUpDni(false);
    }
  }

  function startEdit(employee: Employee) {
    setEditingId(employee.id);
    setEdit({ ...employee });
  }

  async function handleSaveEdit() {
    if (!edit) return;
    const savedId = edit.id;
    setError(null);
    try {
      await employeesApi.update(edit.id, {
        dni: edit.dni,
        first_name: edit.first_name,
        last_name: edit.last_name,
        job_role_id: edit.job_role_id,
        hire_date: edit.hire_date || null,
      });
      setEditingId(null);
      setEdit(null);
      markSaved(savedId);
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
      markSaved(employee.id);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo actualizar el empleado");
    }
  }

  async function confirmDeactivation() {
    if (!confirmDeactivate) return;
    const target = confirmDeactivate;
    setConfirmDeactivate(null);
    await handleToggleActive(target);
  }

  const isCreateDirty = Boolean(
    form.dni || form.first_name || form.last_name || form.hire_date || form.job_role_id
  );

  function handleCancelCreate() {
    if (isCreateDirty) {
      if (!window.confirm("Hay datos ingresados para el nuevo empleado. ¿Deseas cancelar y descartarlos?")) {
        return;
      }
    }
    setForm(EMPTY_FORM);
    setShowCreate(false);
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
            id="employee-search"
            type="text"
            className="input"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por nombre, DNI o código…"
            aria-label="Buscar por nombre, DNI o código"
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
          <button className="btn btn-primary" onClick={() => (showCreate ? handleCancelCreate() : setShowCreate(true))}>
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
        <form onSubmit={handleCreate} className="card card-pad employee-create-form">
          <div className="employee-create-identity-row">
            <div className="employee-dni-field">
              <label className="label" htmlFor="create-employee-dni">DNI (8 dígitos)</label>
              <div className="employee-dni-controls">
                <input
                  id="create-employee-dni"
                  type="text"
                  inputMode="numeric"
                  className="input"
                  value={form.dni}
                  onChange={(event) => updateCreateDni(event.target.value.replace(/\D/g, "").slice(0, 8))}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      handleDniLookup();
                    }
                  }}
                  required
                  pattern="\d{8}"
                  title="8 dígitos"
                  aria-describedby="dni-lookup-feedback"
                />
                <button type="button" className="btn btn-outline employee-dni-lookup" onClick={handleDniLookup} disabled={!/^\d{8}$/.test(form.dni) || lookingUpDni}>
                  {lookingUpDni ? <Spinner /> : <Search size={15} />}
                  {lookingUpDni ? "Consultando DNI…" : "Consultar DNI"}
                </button>
              </div>
              <p id="dni-lookup-feedback" className="field-help" aria-live="polite">
                {dniLookupFeedback ?? "Consulta solo este DNI para completar nombres y apellidos."}
              </p>
            </div>
            <div>
              <label className="label" htmlFor="create-employee-code">Código interno</label>
              <input id="create-employee-code" type="text" className="input" value="Se asignará automáticamente" readOnly aria-readonly="true" />
            </div>
            <div>
              <label className="label" id="create-employee-job-role-label" htmlFor="create-employee-job-role">Cargo laboral</label>
              <Select value={form.job_role_id} onValueChange={(v) => setForm({ ...form, job_role_id: v })}>
                <SelectTrigger id="create-employee-job-role" aria-labelledby="create-employee-job-role-label" aria-label="Cargo laboral">
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
              <label className="label" id="create-employee-hire-date-label">Fecha de ingreso</label>
              <DateField aria-label="Fecha de ingreso" value={form.hire_date} onChange={(v) => setForm({ ...form, hire_date: v })} placeholder="Sin fecha" />
            </div>
          </div>
          <div className="employee-create-names-row">
            <div>
              <label className="label" htmlFor="create-employee-firstname">Nombres</label>
              <input id="create-employee-firstname" type="text" className="input" value={form.first_name} onChange={(e) => setForm({ ...form, first_name: e.target.value })} required />
            </div>
            <div>
              <label className="label" htmlFor="create-employee-lastname">Apellidos</label>
              <input id="create-employee-lastname" type="text" className="input" value={form.last_name} onChange={(e) => setForm({ ...form, last_name: e.target.value })} required />
            </div>
          </div>
          <div className="employee-create-actions">
            <button type="submit" className="btn btn-primary" disabled={creating}>
              {creating ? <Spinner /> : <Plus size={15} />}
              {creating ? "Creando empleado…" : "Crear empleado"}
            </button>
            <button type="button" className="btn btn-ghost" onClick={handleCancelCreate} disabled={creating}>
              Cancelar
            </button>
          </div>
        </form>
      )}

      <div className="table-wrap employee-stack-wrap">
        <table className="table employee-stack-table">
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
            {pagination.pageItems.map((employee) => (
              <tr
                key={employee.id}
                className={isHighlighted(employee.id) ? "row-saved" : undefined}
                style={employee.active ? undefined : { opacity: 0.62 }}
              >
                {editingId === employee.id && edit ? (
                  <>
                    <td data-label="Nombre">
                      <div style={{ display: "grid", gap: "0.3rem" }}>
                        <input
                          type="text"
                          className="input employee-edit-input"
                          aria-label="Nombres del empleado"
                          value={edit.first_name}
                          onChange={(e) => setEdit({ ...edit, first_name: e.target.value })}
                        />
                        <input
                          type="text"
                          className="input employee-edit-input"
                          aria-label="Apellidos del empleado"
                          value={edit.last_name}
                          onChange={(e) => setEdit({ ...edit, last_name: e.target.value })}
                        />
                      </div>
                    </td>
                    <td data-label="DNI">
                      <input
                        type="text"
                        className="input employee-edit-dni"
                        aria-label="DNI"
                        value={edit.dni}
                        onChange={(e) => setEdit({ ...edit, dni: e.target.value })}
                      />
                    </td>
                    <td className="num" data-label="Código">{employee.employee_code}</td>
                    <td data-label="Cargo">
                      <Select value={edit.job_role_id} onValueChange={(v) => setEdit({ ...edit, job_role_id: v })}>
                        <SelectTrigger aria-label="Cargo" className="employee-edit-trigger">
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
                    <td data-label="Estado">
                      <span className="badge badge-neutral">{employee.active ? "Activo" : "Inactivo"}</span>
                    </td>
                    <td data-label="Acciones" style={{ textAlign: "right" }}>
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
                    <td data-label="Empleado">
                      <Link to={`/admin/employees/${employee.id}`} style={{ fontWeight: 600 }}>
                        {employee.first_name} {employee.last_name}
                      </Link>
                    </td>
                    <td className="num" data-label="DNI">{employee.dni}</td>
                    <td className="num" data-label="Código">{employee.employee_code}</td>
                    <td data-label="Cargo">{employee.job_role_name ?? "—"}</td>
                    <td data-label="Estado">
                      {employee.active ? (
                        <span className="badge badge-green">Activo</span>
                      ) : (
                        <span className="badge badge-neutral">Inactivo</span>
                      )}
                    </td>
                    {canManage && (
                      <td data-label="Acciones" style={{ textAlign: "right" }}>
                        <div style={{ display: "flex", gap: "0.4rem", justifyContent: "flex-end" }}>
                          <button className="btn btn-ghost btn-sm" onClick={() => startEdit(employee)}>
                            <Pencil size={13} />
                            Editar
                          </button>
                          {employee.active ? (
                            <button className="btn btn-ghost btn-sm" onClick={() => setConfirmDeactivate(employee)}>
                              Desactivar
                            </button>
                          ) : (
                            <button className="btn btn-green btn-sm" onClick={() => handleToggleActive(employee)}>
                              Activar
                            </button>
                          )}
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
      <TablePagination {...pagination} />

      {confirmDeactivate && (
        <AppDialog labelledBy="deactivate-employee-title" onClose={() => setConfirmDeactivate(null)}>
          <h2 id="deactivate-employee-title" className="card-title">
            ¿Desactivar a {confirmDeactivate.first_name} {confirmDeactivate.last_name}?
          </h2>
          <p className="card-sub">
            Deja de contar como empleado activo, pero su historial de asistencia y sueldos se conserva. Puedes
            reactivarlo cuando quieras.
          </p>
          <div className="app-dialog-actions employee-dialog-sticky-actions">
            <AppDialogCloseButton className="btn btn-outline">Cancelar</AppDialogCloseButton>
            <button className="btn btn-danger" type="button" onClick={() => void confirmDeactivation()}>
              Sí, desactivar
            </button>
          </div>
        </AppDialog>
      )}

    </AdminShell>
  );
}
