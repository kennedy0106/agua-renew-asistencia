"use client";

import { useState } from "react";
import AdminShell from "@/components/AdminShell";
import { useAdminUser } from "@/components/AdminSession";
import { Alert, Check, Key, Shield, User } from "@/components/Icons";
import { Spinner } from "@/components/Loading";
import { ApiError, usersApi } from "@/lib/api";

const ROLE_LABELS: Record<string, string> = { ADMIN: "Administrador", BOSS: "Jefe", SUPERVISOR: "Supervisor" };
export default function AccountPage() {
  const user = useAdminUser();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setMessage(null);
    if (next !== confirm) {
      setError("La confirmación no coincide. Vuelve a escribir la nueva contraseña.");
      return;
    }
    setBusy(true);
    try {
      await usersApi.changeOwnPassword(current, next);
      setMessage("Tu contraseña se actualizó correctamente.");
      setCurrent("");
      setNext("");
      setConfirm("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No pudimos cambiar la contraseña. Inténtalo nuevamente.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AdminShell title="Mi cuenta" subtitle="Perfil y seguridad de acceso">
      <div className="account-layout">
        <section className="operations-panel surface-material account-profile" aria-labelledby="profile-title">
          <span className="account-avatar" aria-hidden>{user?.username.charAt(0).toUpperCase() ?? <User size={22} />}</span>
          <div><h2 id="profile-title">{user?.username ?? "Usuario"}</h2><p>{user ? ROLE_LABELS[user.role] ?? user.role : "Cuenta administrativa"}</p></div>
        </section>

        <section className="operations-panel surface-material account-security" aria-labelledby="security-title">
          <div className="operations-panel-head">
            <div className="account-heading"><span><Shield size={19} /></span><div><h2 id="security-title">Cambiar contraseña</h2><p>Usa al menos 8 caracteres y evita contraseñas compartidas.</p></div></div>
          </div>
          <form className="account-form" onSubmit={handleSubmit}>
            <div className="field-group">
              <label className="label" htmlFor="current-password">Contraseña actual</label>
              <input id="current-password" className="input" type="password" autoComplete="current-password" value={current} onChange={(event) => setCurrent(event.target.value)} required aria-invalid={Boolean(error)} />
            </div>
            <div className="field-group">
              <label className="label" htmlFor="new-password">Nueva contraseña</label>
              <input id="new-password" className="input" type="password" autoComplete="new-password" value={next} onChange={(event) => setNext(event.target.value)} required minLength={8} aria-describedby="password-help" aria-invalid={Boolean(error)} />
              <small id="password-help" className="field-help">Mínimo 8 caracteres.</small>
            </div>
            <div className="field-group">
              <label className="label" htmlFor="confirm-password">Confirmar nueva contraseña</label>
              <input id="confirm-password" className="input" type="password" autoComplete="new-password" value={confirm} onChange={(event) => setConfirm(event.target.value)} required minLength={8} aria-invalid={Boolean(error)} />
            </div>
            <button type="submit" className="btn btn-primary account-submit" disabled={busy}>{busy ? <Spinner /> : <Key size={16} />}{busy ? "Guardando…" : "Actualizar contraseña"}</button>
            <div className="account-feedback" aria-live="polite">
              {message && <p className="alert alert-success"><Check size={16} />{message}</p>}
              {error && <p className="alert alert-error" role="alert"><Alert size={16} />{error}</p>}
            </div>
          </form>
        </section>
      </div>
    </AdminShell>
  );
}
