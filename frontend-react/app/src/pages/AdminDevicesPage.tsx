
import { useCallback, useEffect, useMemo, useState } from "react";
import AdminShell from "@/components/AdminShell";
import { useAdminUser } from "@/components/AdminSession";
import { Alert, Check, Key, Refresh, Search, X } from "@/components/Icons";
import { TableSkeleton } from "@/components/Loading";
import { AsyncButton } from "@/components/AsyncButton";
import { useRowHighlight } from "@/components/RowHighlight";
import { TablePagination, useTablePagination } from "@/components/Pagination";
import { ApiError, devicesApi, AttendanceDevice, AttendanceDeviceCreated } from "@/lib/api";


function formatLastSync(iso: string | null | undefined): { text: string; isOnline: boolean } {
  if (!iso) return { text: "Sin sincronizar aún", isOnline: false };
  const date = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);

  const formatted = date.toLocaleString("es-PE", {
    timeZone: "America/Lima",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  if (diffMins < 0 || diffMins < 10) {
    return { text: `En línea (hace ${Math.max(1, diffMins)} min)`, isOnline: true };
  } else if (diffMins < 60) {
    return { text: `Hace ${diffMins} min (${formatted})`, isOnline: false };
  }
  return { text: formatted, isOnline: false };
}

function formatExpiration(iso: string | null | undefined): string {
  if (!iso) return "15 minutos";
  const date = new Date(iso);
  const formatted = date.toLocaleTimeString("es-PE", {
    timeZone: "America/Lima",
    hour: "2-digit",
    minute: "2-digit",
  });
  const now = new Date();
  const diffMs = date.getTime() - now.getTime();
  const diffMins = Math.max(0, Math.round(diffMs / 60000));
  if (diffMins > 0) {
    return `las ${formatted} (aprox. ${diffMins} min)`;
  }
  return `las ${formatted}`;
}

type ConfirmAction = {
  type: "rotate" | "revoke";
  device: AttendanceDevice;
};

export default function AdminDevicesPage() {
  const user = useAdminUser();
  const [devices, setDevices] = useState<AttendanceDevice[]>([]);
  const [name, setName] = useState("Tablet planta");
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<AttendanceDeviceCreated | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionKey, setActionKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyNotice, setCopyNotice] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "revoked">("all");
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);
  const { markSaved, isHighlighted } = useRowHighlight();

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setDevices(await devicesApi.list());
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudieron listar los terminales");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (user?.role === "ADMIN") void load();
  }, [user?.role, load]);

  useEffect(() => {
    if (!confirmAction) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setConfirmAction(null);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [confirmAction]);

  const filteredDevices = useMemo(() => {
    return devices.filter((d) => {
      const q = searchTerm.toLowerCase().trim();
      const matchesSearch =
        !q ||
        d.name.toLowerCase().includes(q) ||
        d.device_code.toLowerCase().includes(q);
      const matchesStatus =
        statusFilter === "all" ||
        (statusFilter === "active" && d.active) ||
        (statusFilter === "revoked" && !d.active);
      return matchesSearch && matchesStatus;
    });
  }, [devices, searchTerm, statusFilter]);

  const pagination = useTablePagination(filteredDevices, filteredDevices.length);

  async function copyToClipboard(code: string) {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setCopyNotice("Código copiado al portapapeles");
      setTimeout(() => {
        setCopied(false);
        setCopyNotice(null);
      }, 3000);
    } catch {
      setCopyNotice("Selecciona y copia el código manualmente");
    }
  }

  if (user && user.role !== "ADMIN") {
    return (
      <AdminShell title="Tablets y terminales">
        <p className="alert alert-error">Solo un administrador puede autorizar tablets.</p>
      </AdminShell>
    );
  }

  async function createDevice(event: React.FormEvent) {
    event.preventDefault();
    if (actionKey) return;
    setActionKey("create");
    setError(null);
    try {
      const created = await devicesApi.create(name.trim());
      setIssued(created);
      markSaved(created.id);
      setName("Tablet planta");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo crear el terminal");
    } finally {
      setActionKey(null);
    }
  }

  async function rotateDevice(id: string) {
    if (actionKey) return;
    setActionKey(`rotate:${id}`);
    setError(null);
    try {
      const rotated = await devicesApi.rotate(id);
      setIssued(rotated);
      markSaved(id);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo generar el nuevo código");
    } finally {
      setActionKey(null);
    }
  }

  async function revokeDevice(id: string) {
    if (actionKey) return;
    setActionKey(`revoke:${id}`);
    setError(null);
    try {
      await devicesApi.revoke(id);
      markSaved(id);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo revocar el terminal");
    } finally {
      setActionKey(null);
    }
  }

  return (
    <AdminShell
      title="Tablets y terminales"
      subtitle="Autorización física y control de sincronización de quioscos de marcación en planta y portería."
    >
      {error && (
        <div
          className="alert alert-error"
          role="alert"
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: "1rem",
            flexWrap: "wrap",
            marginBottom: "1rem",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <Alert size={16} style={{ flexShrink: 0 }} />
            <span>{error}</span>
          </div>
          <button
            type="button"
            className="btn btn-outline btn-sm"
            onClick={() => void load()}
            style={{ minHeight: "2.1rem" }}
          >
            <Refresh size={14} /> Reintentar
          </button>
        </div>
      )}

      <form
        className="card card-pad"
        onSubmit={createDevice}
        style={{ marginBottom: "1rem", display: "grid", gap: "0.6rem", maxWidth: 420 }}
      >
        <label className="label" htmlFor="device-name-input">Nombre del equipo</label>
        <input
          id="device-name-input"
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Ej: Tablet Portería Norte"
          required
        />
        <AsyncButton
          type="submit"
          busy={actionKey === "create"}
          busyLabel="Registrando terminal…"
          style={{ minHeight: "2.5rem" }}
        >
          Registrar terminal
        </AsyncButton>
      </form>

      {issued && (
        <section
          className="card card-pad issued-code-card"
          role="status"
          aria-labelledby="issued-code-title"
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "flex-start",
              gap: "1rem",
              flexWrap: "wrap",
            }}
          >
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                <Key size={18} style={{ color: "var(--brand-blue)" }} />
                <h3
                  id="issued-code-title"
                  style={{ margin: 0, fontSize: "1rem", fontWeight: 700, color: "var(--brand-ink)" }}
                >
                  Código de vinculación generado
                </h3>
              </div>
              <p style={{ margin: "0.25rem 0 0", fontSize: "0.82rem", color: "var(--muted)" }}>
                Para <strong>{issued.name}</strong> · Código de terminal:{" "}
                <code className="device-code-badge">{issued.device_code}</code>
              </p>
            </div>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setIssued(null)}
              aria-label="Cerrar aviso de código"
            >
              <X size={15} /> Cerrar
            </button>
          </div>

          <div className="issued-code-display">
            <div className="issued-code-box">
              <span className="issued-code-label">Código temporal de un solo uso</span>
              <strong className="issued-code-value">{issued.pairing_code}</strong>
              {issued.pairing_expires_at && (
                <span className="issued-code-expiry">
                  Válido hasta {formatExpiration(issued.pairing_expires_at)}
                </span>
              )}
            </div>

            <div className="issued-code-actions">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void copyToClipboard(issued.pairing_code)}
                style={{ minHeight: "2.5rem" }}
              >
                {copied ? (
                  <>
                    <Check size={16} /> ¡Copiado!
                  </>
                ) : (
                  "Copiar código"
                )}
              </button>
              {copyNotice && (
                <span className="issued-copy-notice" role="status" aria-live="polite">
                  {copyNotice}
                </span>
              )}
            </div>
          </div>

          <p className="issued-code-instruction">
            Ingresa este código en la pantalla de marcación de la tablet (<code>/asistencia</code>) para completar la vinculación física.
          </p>
        </section>
      )}

      <div className="devices-toolbar">
        <div className="devices-search">
          <Search size={16} aria-hidden />
          <input
            type="search"
            className="input"
            placeholder="Buscar por nombre o código…"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            aria-label="Buscar terminales"
          />
          {searchTerm && (
            <button
              type="button"
              className="devices-search-clear"
              onClick={() => setSearchTerm("")}
              aria-label="Limpiar búsqueda"
            >
              <X size={14} />
            </button>
          )}
        </div>

        <div className="devices-filter-group">
          <label htmlFor="device-status-filter" className="sr-only">Filtrar por estado</label>
          <select
            id="device-status-filter"
            className="input select"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as "all" | "active" | "revoked")}
            aria-label="Filtrar por estado"
            style={{ minHeight: "2.5rem" }}
          >
            <option value="all">Todos los estados ({devices.length})</option>
            <option value="active">Solo activos ({devices.filter((d) => d.active).length})</option>
            <option value="revoked">Solo revocados ({devices.filter((d) => !d.active).length})</option>
          </select>

          {(searchTerm || statusFilter !== "all") && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                setSearchTerm("");
                setStatusFilter("all");
              }}
            >
              Limpiar filtros
            </button>
          )}
        </div>
      </div>

      <p className="devices-count-meta">
        Mostrando {filteredDevices.length} de {devices.length} {devices.length === 1 ? "terminal" : "terminales"}
      </p>

      <div className="table-wrap devices-table-wrap">
        <table className="table devices-stack-table">
          <thead>
            <tr>
              <th scope="col">Nombre</th>
              <th scope="col">Código</th>
              <th scope="col">Estado</th>
              <th scope="col">Última sincronización</th>
              <th scope="col" style={{ textAlign: "right" }}>
                <span className="sr-only">Acciones</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {loading && <TableSkeleton rows={5} cols={5} />}
            {!loading && devices.length === 0 && (
              <tr>
                <td colSpan={5} className="empty">
                  No hay terminales registrados en el sistema.
                </td>
              </tr>
            )}
            {!loading && devices.length > 0 && filteredDevices.length === 0 && (
              <tr>
                <td colSpan={5} className="empty">
                  <div style={{ padding: "1.5rem 1rem", textAlign: "center" }}>
                    <p style={{ margin: "0 0 0.5rem", fontWeight: 600 }}>
                      Ningún terminal coincide con la búsqueda o filtro aplicado.
                    </p>
                    <button
                      type="button"
                      className="btn btn-outline btn-sm"
                      onClick={() => {
                        setSearchTerm("");
                        setStatusFilter("all");
                      }}
                    >
                      Restablecer filtros
                    </button>
                  </div>
                </td>
              </tr>
            )}
            {!loading &&
              pagination.pageItems.map((device) => {
                const syncInfo = formatLastSync(device.last_sync_at);
                return (
                  <tr key={device.id} className={isHighlighted(device.id) ? "row-saved" : undefined}>
                    <td data-label="Nombre">
                      <strong>{device.name}</strong>
                    </td>
                    <td data-label="Código">
                      <code className="device-code-badge">{device.device_code}</code>
                    </td>
                    <td data-label="Estado">
                      <span className={`badge ${device.active ? "badge-green" : "badge-neutral"}`}>
                        {device.active ? "Activo" : "Revocado"}
                      </span>
                    </td>
                    <td data-label="Última sincronización">
                      <span className={syncInfo.isOnline ? "device-sync-online" : "device-sync-offline"}>
                        {syncInfo.text}
                      </span>
                    </td>
                    <td data-label="Acciones" style={{ textAlign: "right" }}>
                      {device.active && (
                        <div className="device-row-actions">
                          <AsyncButton
                            className="btn btn-ghost btn-sm"
                            type="button"
                            busy={actionKey === `rotate:${device.id}`}
                            busyLabel="Generando…"
                            disabled={actionKey !== null}
                            onClick={() => setConfirmAction({ type: "rotate", device })}
                            aria-label={`Generar nuevo código para ${device.name}`}
                          >
                            Nuevo código
                          </AsyncButton>
                          <AsyncButton
                            className="btn btn-ghost btn-sm btn-danger-ghost"
                            type="button"
                            busy={actionKey === `revoke:${device.id}`}
                            busyLabel="Revocando…"
                            disabled={actionKey !== null}
                            onClick={() => setConfirmAction({ type: "revoke", device })}
                            aria-label={`Revocar autorización de ${device.name}`}
                          >
                            Revocar
                          </AsyncButton>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </div>
      <TablePagination {...pagination} />

      {confirmAction && (
        <div
          className="dialog-portal"
          role="presentation"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && actionKey === null) setConfirmAction(null);
          }}
        >
          <section
            className="app-dialog card card-pad"
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirm-dialog-title"
            aria-describedby="confirm-dialog-desc"
            style={{ maxWidth: "30rem", display: "grid", gap: "1rem" }}
          >
            <div style={{ display: "flex", alignItems: "flex-start", gap: "0.85rem" }}>
              <div
                style={{
                  display: "grid",
                  placeItems: "center",
                  width: "2.6rem",
                  height: "2.6rem",
                  borderRadius: "50%",
                  background:
                    confirmAction.type === "revoke"
                      ? "rgba(180, 35, 24, 0.12)"
                      : "rgba(0, 102, 204, 0.12)",
                  color:
                    confirmAction.type === "revoke" ? "var(--expense-red)" : "var(--brand-blue)",
                  flexShrink: 0,
                }}
                aria-hidden
              >
                {confirmAction.type === "revoke" ? <Alert size={20} /> : <Refresh size={20} />}
              </div>
              <div>
                <h2
                  id="confirm-dialog-title"
                  style={{ margin: 0, fontSize: "1.15rem", fontWeight: 700, color: "var(--brand-ink)" }}
                >
                  {confirmAction.type === "revoke"
                    ? `¿Revocar autorización de «${confirmAction.device.name}»?`
                    : `¿Generar nuevo código para «${confirmAction.device.name}»?`}
                </h2>
                <p
                  id="confirm-dialog-desc"
                  style={{ margin: "0.45rem 0 0", fontSize: "0.84rem", color: "var(--muted)", lineHeight: 1.5 }}
                >
                  {confirmAction.type === "revoke" ? (
                    <>
                      El terminal <strong>{confirmAction.device.name}</strong> (código{" "}
                      <code>{confirmAction.device.device_code}</code>) quedará inmediatamente revocado y no
                      podrá registrar marcaciones de asistencia en portería ni planta. Esta acción no se
                      puede deshacer.
                    </>
                  ) : (
                    <>
                      El código previo de vinculación para <strong>{confirmAction.device.name}</strong> quedará
                      sin validez. Deberás ingresar el nuevo código temporal en la tablet antes de que expire.
                    </>
                  )}
                </p>
              </div>
            </div>

            <div
              className="app-dialog-actions"
              style={{
                display: "flex",
                justifyContent: "flex-end",
                gap: "0.6rem",
                flexWrap: "wrap",
                marginTop: "0.5rem",
              }}
            >
              <button
                type="button"
                className="btn btn-secondary"
                disabled={actionKey !== null}
                onClick={() => setConfirmAction(null)}
                style={{ minHeight: "2.5rem" }}
              >
                Cancelar
              </button>
              {confirmAction.type === "revoke" ? (
                <AsyncButton
                  type="button"
                  className="btn btn-danger"
                  busy={actionKey === `revoke:${confirmAction.device.id}`}
                  busyLabel="Revocando…"
                  disabled={actionKey !== null}
                  onClick={async () => {
                    await revokeDevice(confirmAction.device.id);
                    setConfirmAction(null);
                  }}
                  style={{ minHeight: "2.5rem" }}
                >
                  Sí, revocar terminal
                </AsyncButton>
              ) : (
                <AsyncButton
                  type="button"
                  className="btn btn-primary"
                  busy={actionKey === `rotate:${confirmAction.device.id}`}
                  busyLabel="Generando…"
                  disabled={actionKey !== null}
                  onClick={async () => {
                    await rotateDevice(confirmAction.device.id);
                    setConfirmAction(null);
                  }}
                  style={{ minHeight: "2.5rem" }}
                >
                  Generar nuevo código
                </AsyncButton>
              )}
            </div>
          </section>
        </div>
      )}

    </AdminShell>
  );
}
