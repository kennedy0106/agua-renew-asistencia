
import { useId, useState } from "react";
import AdminShell from "@/components/AdminShell";
import { useAdminUser } from "@/components/AdminSession";
import { Alert, Check, Eye, EyeOff, Key, Shield, User } from "@/components/Icons";
import { Spinner } from "@/components/Loading";
import { ApiError, usersApi } from "@/lib/api";

const ROLE_LABELS: Record<string, string> = {
  ADMIN: "Administrador",
  BOSS: "Jefe",
  SUPERVISOR: "Supervisor",
};

function getPasswordStrength(password: string): { score: number; label: string; color: string } {
  if (!password) {
    return { score: 0, label: "", color: "" };
  }
  let score = 0;
  if (password.length >= 8) score++;
  if (/\d/.test(password)) score++;
  if (/[A-Z]/.test(password) && /[a-z]/.test(password)) score++;
  if (/[^A-Za-z0-9]/.test(password)) score++;

  if (password.length < 8) {
    return { score: 1, label: "Débil (mínimo 8 caracteres)", color: "#ef4444" };
  }
  if (score <= 2) {
    return { score: 1, label: "Débil", color: "#ef4444" };
  }
  if (score === 3) {
    return { score: 2, label: "Aceptable", color: "#f59e0b" };
  }
  return { score: 3, label: "Fuerte", color: "#10b981" };
}

export default function AccountPage() {
  const user = useAdminUser();
  const strengthId = useId();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNext, setShowNext] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const strength = getPasswordStrength(next);
  const isMatching = confirm.length > 0 && confirm === next;
  const isMismatch = confirm.length > 0 && confirm !== next;

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setMessage(null);
    if (next !== confirm) {
      setError("La confirmación no coincide. Vuelve a escribir la nueva contraseña.");
      return;
    }
    if (next.length < 8) {
      setError("La nueva contraseña debe tener al menos 8 caracteres.");
      return;
    }
    setBusy(true);
    try {
      await usersApi.changeOwnPassword(current, next);
      setMessage("Tu contraseña se actualizó correctamente.");
      setCurrent("");
      setNext("");
      setConfirm("");
      setShowCurrent(false);
      setShowNext(false);
      setShowConfirm(false);
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
          <span className="account-avatar" aria-hidden>
            {user?.username.charAt(0).toUpperCase() ?? <User size={22} />}
          </span>
          <div>
            <h2 id="profile-title">{user?.username ?? "Usuario"}</h2>
            <p>{user ? ROLE_LABELS[user.role] ?? user.role : "Cuenta administrativa"}</p>
          </div>
        </section>

        <section className="operations-panel surface-material account-security" aria-labelledby="security-title">
          <div className="operations-panel-head">
            <div className="account-heading">
              <span><Shield size={19} /></span>
              <div>
                <h2 id="security-title">Cambiar contraseña</h2>
                <p>Usa al menos 8 caracteres y evita contraseñas compartidas.</p>
              </div>
            </div>
          </div>
          <form
            className="account-form account-form--stacked"
            onSubmit={handleSubmit}
          >
            <div className="field-group account-field-group">
              <label className="label" htmlFor="current-password">Contraseña actual</label>
              <div className="password-input-wrap">
                <input
                  id="current-password"
                  className="input"
                  type={showCurrent ? "text" : "password"}
                  autoComplete="current-password"
                  value={current}
                  onChange={(event) => setCurrent(event.target.value)}
                  required
                  aria-invalid={Boolean(error)}
                />
                <button
                  type="button"
                  className="login-password-toggle password-toggle-btn account-password-toggle"
                  onClick={() => setShowCurrent((v) => !v)}
                  aria-label={showCurrent ? "Ocultar contraseña actual" : "Mostrar contraseña actual"}
                  aria-pressed={showCurrent}
                  aria-controls="current-password"
                >
                  {showCurrent ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
            </div>

            <div className="field-group account-field-group">
              <label className="label" htmlFor="new-password">Nueva contraseña</label>
              <div className="password-input-wrap">
                <input
                  id="new-password"
                  className="input"
                  type={showNext ? "text" : "password"}
                  autoComplete="new-password"
                  value={next}
                  onChange={(event) => setNext(event.target.value)}
                  required
                  minLength={8}
                  aria-describedby={`password-help ${strengthId}`}
                  aria-invalid={Boolean(error)}
                />
                <button
                  type="button"
                  className="login-password-toggle password-toggle-btn account-password-toggle"
                  onClick={() => setShowNext((v) => !v)}
                  aria-label={showNext ? "Ocultar nueva contraseña" : "Mostrar nueva contraseña"}
                  aria-pressed={showNext}
                  aria-controls="new-password"
                >
                  {showNext ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>

              {next.length > 0 && (
                <div id={strengthId} className="password-strength-container">
                  <div
                    className="password-strength-meter"
                    role="progressbar"
                    aria-valuenow={strength.score * 33.3}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label={`Fortaleza de la contraseña: ${strength.label}`}
                  >
                    <div className="password-strength-segment" style={{ backgroundColor: strength.score >= 1 ? strength.color : "transparent" }} />
                    <div className="password-strength-segment" style={{ backgroundColor: strength.score >= 2 ? strength.color : "transparent" }} />
                    <div className="password-strength-segment" style={{ backgroundColor: strength.score >= 3 ? strength.color : "transparent" }} />
                  </div>
                  <div className="password-strength-labels">
                    <small className="field-help" id="password-help">Mínimo 8 caracteres. Combina mayúsculas, minúsculas, números y símbolos.</small>
                    <small className="password-strength-badge" style={{ color: strength.color }}>{strength.label}</small>
                  </div>
                </div>
              )}
              {next.length === 0 && (
                <small id="password-help" className="field-help">Mínimo 8 caracteres. Usa una combinación robusta.</small>
              )}
            </div>

            <div className="field-group account-field-group">
              <label className="label" htmlFor="confirm-password">Confirmar nueva contraseña</label>
              <div className="password-input-wrap">
                <input
                  id="confirm-password"
                  className="input"
                  type={showConfirm ? "text" : "password"}
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(event) => setConfirm(event.target.value)}
                  required
                  minLength={8}
                  aria-invalid={isMismatch || Boolean(error)}
                  aria-describedby="confirm-help"
                />
                <button
                  type="button"
                  className="login-password-toggle password-toggle-btn account-password-toggle"
                  onClick={() => setShowConfirm((v) => !v)}
                  aria-label={showConfirm ? "Ocultar confirmación de contraseña" : "Mostrar confirmación de contraseña"}
                  aria-pressed={showConfirm}
                  aria-controls="confirm-password"
                >
                  {showConfirm ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
              <div id="confirm-help">
                {isMatching && (
                  <small className="field-help field-help--success">
                    <Check size={14} /> Las contraseñas coinciden
                  </small>
                )}
                {isMismatch && (
                  <small className="field-help field-help--warning">
                    Las contraseñas aún no coinciden
                  </small>
                )}
              </div>
            </div>

            <button
              type="submit"
              className="btn btn-primary account-submit"
              disabled={busy}
              aria-busy={busy}
            >
              {busy ? <Spinner /> : <Key size={16} />}
              {busy ? "Guardando…" : "Actualizar contraseña"}
            </button>
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
