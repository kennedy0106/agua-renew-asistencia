import { useCallback, useEffect, useMemo, useState } from "react";
import AdminShell from "@/components/AdminShell";
import { useAdminUser } from "@/components/AdminSession";
import { useAdminViewState } from "@/components/AdminViewState";
import { Alert, Refresh, Search, X } from "@/components/Icons";
import { TableSkeleton } from "@/components/Loading";
import { AsyncButton } from "@/components/AsyncButton";
import { useRowHighlight } from "@/components/RowHighlight";
import { TablePagination, useTablePagination } from "@/components/Pagination";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ApiError, devicesApi, AttendanceDevice } from "@/lib/api";


function formatLastSync(iso: string | null | undefined): { text: string; isOnline: boolean } {
  if (!iso) return { text: "Sin actividad aún", isOnline: false };
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

export default function AdminDevicesPage() {
  const user = useAdminUser();
  const [devices, setDevices] = useState<AttendanceDevice[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionKey, setActionKey] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useAdminViewState("devices.searchTerm", "");
  const [statusFilter, setStatusFilter] = useAdminViewState<"all" | "active" | "revoked">(
    "devices.statusFilter",
    "all",
  );
  const [confirmAction, setConfirmAction] = useState<AttendanceDevice | null>(null);
  const { markSaved, isHighlighted } = useRowHighlight();

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setDevices(await devicesApi.list());
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudieron listar las sesiones de marcación");
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

  if (user && user.role !== "ADMIN") {
    return (
      <AdminShell title="Sesiones de marcación">
        <p className="alert alert-error">Solo un administrador puede gestionar las sesiones de marcación.</p>
      </AdminShell>
    );
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
      setError(err instanceof ApiError ? err.message : "No se pudo revocar la sesión de marcación");
    } finally {
      setActionKey(null);
    }
  }

  return (
    <AdminShell
      title="Sesiones de marcación"
      subtitle="Sesiones establecidas automáticamente al identificarse en /asistencia. Revocar finaliza el contexto vigente de ese navegador; no autoriza ni desautoriza equipos."
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

      <div className="devices-toolbar">
        <div className="devices-search">
          <Search size={16} aria-hidden />
          <input
            type="search"
            className="input"
            placeholder="Buscar por nombre o código…"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            aria-label="Buscar sesiones de marcación"
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
          <Select
            value={statusFilter}
            onValueChange={(value) => setStatusFilter(value as "all" | "active" | "revoked")}
          >
            <SelectTrigger
              id="device-status-filter"
              className="statusfilter"
              aria-label="Filtrar por estado"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos los estados ({devices.length})</SelectItem>
              <SelectItem value="active">Solo activas ({devices.filter((d) => d.active).length})</SelectItem>
              <SelectItem value="revoked">Solo revocadas ({devices.filter((d) => !d.active).length})</SelectItem>
            </SelectContent>
          </Select>

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
        Mostrando {filteredDevices.length} de {devices.length} {devices.length === 1 ? "sesión" : "sesiones"}
      </p>

      <div className="table-wrap devices-table-wrap">
        <table className="table devices-stack-table">
          <thead>
            <tr>
              <th scope="col">Contexto</th>
              <th scope="col">Código</th>
              <th scope="col">Estado</th>
              <th scope="col">Última actividad</th>
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
                  No hay sesiones de marcación registradas en el sistema.
                </td>
              </tr>
            )}
            {!loading && devices.length > 0 && filteredDevices.length === 0 && (
              <tr>
                <td colSpan={5} className="empty">
                  <div style={{ padding: "1.5rem 1rem", textAlign: "center" }}>
                    <p style={{ margin: "0 0 0.5rem", fontWeight: 600 }}>
                      Ninguna sesión coincide con la búsqueda o filtro aplicado.
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
                    <td data-label="Contexto">
                      <strong>{device.name}</strong>
                    </td>
                    <td data-label="Código">
                      <code className="device-code-badge">{device.device_code}</code>
                    </td>
                    <td data-label="Estado">
                      <span className={`badge ${device.active ? "badge-green" : "badge-neutral"}`}>
                        {device.active ? "Activa" : "Revocada"}
                      </span>
                    </td>
                    <td data-label="Última actividad">
                      <span className={syncInfo.isOnline ? "device-sync-online" : "device-sync-offline"}>
                        {syncInfo.text}
                      </span>
                    </td>
                    <td data-label="Acciones" style={{ textAlign: "right" }}>
                      {device.active && (
                        <div className="device-row-actions">
                          <AsyncButton
                            className="btn btn-outline btn-sm device-revoke-button"
                            type="button"
                            busy={actionKey === `revoke:${device.id}`}
                            busyLabel="Revocando…"
                            disabled={actionKey !== null}
                            onClick={() => setConfirmAction(device)}
                            aria-label={`Revocar sesión de marcación de ${device.name}`}
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
                  background: "rgba(180, 35, 24, 0.12)",
                  color: "var(--expense-red)",
                  flexShrink: 0,
                }}
                aria-hidden
              >
                <Alert size={20} />
              </div>
              <div>
                <h2
                  id="confirm-dialog-title"
                  style={{ margin: 0, fontSize: "1.15rem", fontWeight: 700, color: "var(--brand-ink)" }}
                >
                  {`¿Revocar la sesión «${confirmAction.name}»?`}
                </h2>
                <p
                  id="confirm-dialog-desc"
                  style={{ margin: "0.45rem 0 0", fontSize: "0.84rem", color: "var(--muted)", lineHeight: 1.5 }}
                >
                  Se cierra el contexto de marcación <strong>{confirmAction.name}</strong> (código{" "}
                  <code>{confirmAction.device_code}</code>). Ese navegador dejará de poder consultar sus
                  intentos pendientes. No es una autorización de equipos: la próxima identificación exitosa
                  desde el mismo dispositivo puede establecer un contexto nuevo.
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
              <AsyncButton
                type="button"
                className="btn btn-danger"
                busy={actionKey === `revoke:${confirmAction.id}`}
                busyLabel="Revocando…"
                disabled={actionKey !== null}
                onClick={async () => {
                  await revokeDevice(confirmAction.id);
                  setConfirmAction(null);
                }}
                style={{ minHeight: "2.5rem" }}
              >
                Sí, revocar
              </AsyncButton>
            </div>
          </section>
        </div>
      )}

    </AdminShell>
  );
}
