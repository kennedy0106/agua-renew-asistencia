"use client";

import { useEffect, useState } from "react";
import AdminShell from "@/components/AdminShell";
import { useAdminUser } from "@/components/AdminSession";
import { Alert } from "@/components/Icons";
import { TableSkeleton } from "@/components/Loading";
import { AsyncButton } from "@/components/AsyncButton";
import { TablePagination, useTablePagination } from "@/components/Pagination";
import { ApiError, devicesApi, AttendanceDevice, AttendanceDeviceCreated } from "@/lib/api";

export default function AdminDevicesPage() {
  const user = useAdminUser();
  const [devices, setDevices] = useState<AttendanceDevice[]>([]);
  const [name, setName] = useState("Tablet planta");
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<AttendanceDeviceCreated | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionKey, setActionKey] = useState<string | null>(null);

  async function load() {
    try {
      setLoading(true);
      setDevices(await devicesApi.list());
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudieron listar los terminales");
    } finally { setLoading(false); }
  }

  useEffect(() => {
    if (user?.role === "ADMIN") void load();
  }, [user?.role]);
  const pagination = useTablePagination(devices, devices.length);

  if (user && user.role !== "ADMIN") {
    return (
      <AdminShell title="Terminales">
        <p className="alert alert-error">Solo un administrador puede enrolar tablets.</p>
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
      setName("Tablet planta");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo crear el terminal");
    } finally { setActionKey(null); }
  }

  async function rotateDevice(id: string) {
    if (actionKey) return;
    setActionKey(`rotate:${id}`); setError(null);
    try { setIssued(await devicesApi.rotate(id)); await load(); }
    catch (err) { setError(err instanceof ApiError ? err.message : "No se pudo generar el nuevo código"); }
    finally { setActionKey(null); }
  }

  async function revokeDevice(id: string) {
    if (actionKey) return;
    setActionKey(`revoke:${id}`); setError(null);
    try { await devicesApi.revoke(id); await load(); }
    catch (err) { setError(err instanceof ApiError ? err.message : "No se pudo revocar el terminal"); }
    finally { setActionKey(null); }
  }

  return (
    <AdminShell title="Terminales" subtitle="Código de emparejamiento de un solo uso para cada tablet">
      {error && (
        <p className="alert alert-error" role="alert">
          <Alert size={15} /> {error}
        </p>
      )}
      <form className="card card-pad" onSubmit={createDevice} style={{ marginBottom: "1rem", display: "grid", gap: "0.6rem", maxWidth: 420 }}>
        <label className="label">Nombre del equipo</label>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} required />
        <AsyncButton type="submit" busy={actionKey === "create"} busyLabel="Registrando terminal…">Registrar terminal</AsyncButton>
      </form>
      {issued && (
        <p className="alert" role="status">
          Código de un uso para <strong>{issued.name}</strong>: <code>{issued.pairing_code}</code>
        </p>
      )}
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Nombre</th>
              <th>Código</th>
              <th>Estado</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {loading && <TableSkeleton rows={5} cols={4} />}
            {!loading && devices.length === 0 && <tr><td colSpan={4} className="empty">No hay terminales registrados.</td></tr>}
            {!loading && pagination.pageItems.map((device) => (
              <tr key={device.id}>
                <td>{device.name}</td>
                <td>{device.device_code}</td>
                <td>{device.active ? "Activo" : "Revocado"}</td>
                <td style={{ textAlign: "right" }}>
                  {device.active && (
                    <>
                      <AsyncButton
                        className="btn btn-ghost btn-sm"
                        type="button"
                        busy={actionKey === `rotate:${device.id}`}
                        busyLabel="Generando…"
                        disabled={actionKey !== null}
                        onClick={() => void rotateDevice(device.id)}
                      >
                        Nuevo código
                      </AsyncButton>
                      <AsyncButton
                        className="btn btn-ghost btn-sm"
                        type="button"
                        busy={actionKey === `revoke:${device.id}`}
                        busyLabel="Revocando…"
                        disabled={actionKey !== null}
                        onClick={() => void revokeDevice(device.id)}
                      >
                        Revocar
                      </AsyncButton>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <TablePagination {...pagination} />
    </AdminShell>
  );
}
