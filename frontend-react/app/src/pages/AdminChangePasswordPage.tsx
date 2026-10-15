
import { useEffect, useId, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Alert, Check, Eye, EyeOff, Key, Shield } from "@/components/Icons";
import { useAdminSession, writeAdminSessionHint } from "@/components/AdminSession";
import { Spinner } from "@/components/Loading";
import { ApiError, authApi, usersApi } from "@/lib/api";

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

export default function ChangePasswordPage() {
  const navigate = useNavigate();
  const { user, ready } = useAdminSession();
  const strengthId = useId();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNext, setShowNext] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const strength = getPasswordStrength(next);
  const isMatching = confirm.length > 0 && confirm === next;
  const isMismatch = confirm.length > 0 && confirm !== next;

  useEffect(() => {
    if (!ready) return;
    if (!user) {
      navigate("/admin/login", { replace: true });
      return;
    }
    if (!user.must_change_password) {
      navigate("/admin/dashboard", { replace: true });
      return;
    }
    // No forzamos autoFocus invasivo: permite a lectores de pantalla y móviles
    // leer naturalmente la cabecera y el contexto antes del formulario.
  }, [ready, navigate, user]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
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
      const refreshedUser = await authApi.me();
      writeAdminSessionHint(refreshedUser);
      navigate("/admin/dashboard", { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No pudimos cambiar la contraseña. Inténtalo nuevamente.");
    } finally {
      setBusy(false);
    }
  }

  if (ready && user && !user.must_change_password) {
    return (
      <main className="password-change-wrap">
        <section className="password-change-card" role="status" aria-live="polite">
          <img className="password-change-brand" src="/brand/logo_color.svg" alt="Agua ReNew" width={700} height={190} />
          <h1 id="password-change-title">Contraseña al día</h1>
          <p className="password-change-copy">Tu cuenta ya posee una contraseña definitiva activa. Redirigiendo al panel de control…</p>
        </section>
      </main>
    );
  }

  return (
    <main className="password-change-wrap password-change-wrap--adaptive">
      <section className="password-change-card password-change-card--adaptive" aria-labelledby="password-change-title">
        <img className="password-change-brand" src="/brand/logo_color.svg" alt="Agua ReNew" width={700} height={190} />
        <span className="password-change-icon" aria-hidden><Shield size={24} /></span>
        <h1 id="password-change-title">Actualiza tu contraseña</h1>
        <p className="password-change-copy">Por seguridad, debes reemplazar tu contraseña temporal antes de usar el panel.</p>
        <form className="password-change-form" onSubmit={submit}>
          <div className="field-group">
            <label className="label" htmlFor="temporary-password">Contraseña temporal o actual</label>
            <div className="password-input-wrap">
              <input
                id="temporary-password"
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
                className="login-password-toggle password-toggle-btn password-change-toggle"
                onClick={() => setShowCurrent((v) => !v)}
                aria-label={showCurrent ? "Ocultar contraseña temporal" : "Mostrar contraseña temporal"}
                aria-pressed={showCurrent}
                aria-controls="temporary-password"
              >
                {showCurrent ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
          </div>

          <div className="field-group">
            <label className="label" htmlFor="required-new-password">Nueva contraseña</label>
            <div className="password-input-wrap">
              <input
                id="required-new-password"
                className="input"
                type={showNext ? "text" : "password"}
                autoComplete="new-password"
                value={next}
                onChange={(event) => setNext(event.target.value)}
                required
                minLength={8}
                aria-describedby={`required-password-help ${strengthId}`}
                aria-invalid={Boolean(error)}
              />
              <button
                type="button"
                className="login-password-toggle password-toggle-btn password-change-toggle"
                onClick={() => setShowNext((v) => !v)}
                aria-label={showNext ? "Ocultar nueva contraseña" : "Mostrar nueva contraseña"}
                aria-pressed={showNext}
                aria-controls="required-new-password"
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
                  <small id="required-password-help" className="field-help">Mínimo 8 caracteres. No compartas esta contraseña.</small>
                  <small className="password-strength-badge" style={{ color: strength.color }}>{strength.label}</small>
                </div>
              </div>
            )}
            {next.length === 0 && (
              <small id="required-password-help" className="field-help">Mínimo 8 caracteres. No compartas esta contraseña.</small>
            )}
          </div>

          <div className="field-group">
            <label className="label" htmlFor="required-confirm-password">Confirma la nueva contraseña</label>
            <div className="password-input-wrap">
              <input
                id="required-confirm-password"
                className="input"
                type={showConfirm ? "text" : "password"}
                autoComplete="new-password"
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
                required
                minLength={8}
                aria-invalid={isMismatch || Boolean(error)}
                aria-describedby="required-confirm-help"
              />
              <button
                type="button"
                className="login-password-toggle password-toggle-btn password-change-toggle"
                onClick={() => setShowConfirm((v) => !v)}
                aria-label={showConfirm ? "Ocultar confirmación de contraseña" : "Mostrar confirmación de contraseña"}
                aria-pressed={showConfirm}
                aria-controls="required-confirm-password"
              >
                {showConfirm ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
            <div id="required-confirm-help">
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

          {error && <p className="alert alert-error" role="alert"><Alert size={16} />{error}</p>}
          <button
            className="btn btn-primary password-change-submit"
            type="submit"
            disabled={busy}
            aria-busy={busy}
          >
            {busy ? <Spinner /> : <Key size={16} />}
            {busy ? "Actualizando…" : "Guardar y continuar"}
          </button>
        </form>
        <p className="password-change-note"><Check size={15} /> Tu nueva contraseña se guarda de forma segura.</p>
      </section>
    </main>
  );
}
