"use client";

import { useEffect, useState } from "react";
import AdminShell from "@/components/AdminShell";
import { useAdminUser } from "@/components/AdminSession";
import { Alert } from "@/components/Icons";
import { TableSkeleton } from "@/components/Loading";
import { TablePagination, useTablePagination } from "@/components/Pagination";
import { ApiError, devicesApi, AttendanceDevice, AttendanceDeviceCreated } from "@/lib/api";

export default function AdminDevicesPage() {
  const user = useAdminUser();
  const [devices, setDevices] = useState<AttendanceDevice[]>([]);
  const [name, setName] = useState("Tablet planta");
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<AttendanceDeviceCreated | null>(null);
  const [loading, setLoading] = useState(true);

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
    try {
      const created = await devicesApi.create(name.trim());
      setIssued(created);
      setName("Tablet planta");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo crear el terminal");
    }
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
        <button className="btn btn-primary" type="submit">
          Registrar terminal
        </button>
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
                      <button
                        className="btn btn-ghost btn-sm"
                        type="button"
                        onClick={async () => {
                          setIssued(await devicesApi.rotate(device.id));
                          await load();
                        }}
                      >
                        Nuevo código
                      </button>
                      <button
                        className="btn btn-ghost btn-sm"
                        type="button"
                        onClick={async () => {
                          await devicesApi.revoke(device.id);
                          await load();
                        }}
                      >
                        Revocar
                      </button>
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
