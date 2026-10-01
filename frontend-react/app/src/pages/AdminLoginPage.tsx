import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError, authApi } from "@/lib/api";
import { preloadRouteWhenIdle } from "@/lib/routePreload";
import { clearAdminSessionHint, writeAdminSessionHint } from "@/components/AdminSession";
import { Check, ChevronRight, Clock, Droplet, Eye, EyeOff, Key, Shield, User } from "@/components/Icons";
import { Spinner } from "@/components/Loading";

/**
 * `/admin/login` — inicio de sesión administrativo. Paridad 1:1 con la pantalla
 * original (tema y markup intactos); la navegación usa React Router.
 */
export default function AdminLoginPage() {
  const navigate = useNavigate();
  const [username, setUsername] = useState("");

  // Paridad con `app/admin/layout.tsx`: al entrar en /admin/login se descarta
  // cualquier hint de sesión previo (`isLogin` -> clearAdminSessionHint). El
  // hint es solo presentación y nunca autoriza; esto evita arrastrar datos de
  // una sesión que ya no aplica. No altera el tema ni el markup.
  useEffect(() => {
    clearAdminSessionHint();
    // El dashboard es el destino casi seguro tras autenticar: se precarga en
    // reposo para que el chunk ya esté listo al enviar el formulario y no haya
    // salto de Suspense. Si el cambio de contraseña es obligatorio, la ruta se
    // resuelve igualmente sin penalización perceptible.
    preloadRouteWhenIdle("/admin/dashboard");
  }, []);

  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const loggedIn = await authApi.login(username, password);
      writeAdminSessionHint(loggedIn);
      navigate(
        loggedIn.must_change_password ? "/admin/change-password" : "/admin/dashboard",
        { replace: true },
      );
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : "No se pudo conectar con el servidor. Verifica tu conexión.",
      );
      setBusy(false);
    }
  }

  return (
    <main className="login-wrap login-wrap--adaptive">
      <section className="login-hero login-hero--adaptive" aria-labelledby="login-hero-title">
        <div className="login-caustic" aria-hidden />
        <div className="login-brand-plaque">
          <img src="/brand/logo_color.svg" alt="Agua ReNew" width={700} height={190} />
        </div>
        <h1 id="login-hero-title"><span>Asistencia</span> diaria</h1>
        <p>
          Registra jornadas, revisa incidencias y calcula remuneraciones con la
          misma precisión con la que Agua Renew cuida cada operación.
        </p>
        <ul className="login-features">
          <li><Clock size={17} /><span>Marcaciones y jornadas en hora Lima</span></li>
          <li><Check size={17} /><span>Horas extra y diferencias visibles</span></li>
          <li><Shield size={17} /><span>Planilla y auditoría según tu rol</span></li>
        </ul>
        <p className="login-motto">
          <img src="/brand/logo_gotita.svg" alt="" width={754} height={1065} aria-hidden />
          Agua que renueva · Espíritu que transforma
        </p>
      </section>

      <section className="login-card login-card--adaptive" aria-labelledby="login-title">
        <div className="brand">
          <img src="/brand/logo_color.svg" alt="Agua ReNew" width={700} height={190} />
        </div>

        <div className="login-drop" aria-hidden>
          <img src="/brand/logo_gotita.svg" alt="" width={754} height={1065} />
        </div>
        <div className="login-card-heading">
          <span className="login-mobile-context">
            Agua ReNew · Asistencia
          </span>
          <h2 id="login-title">Iniciar sesión</h2>
          <p>Entra con tu usuario de Agua Renew para administrar la asistencia.</p>
        </div>

        <form onSubmit={handleSubmit} className="login-form">
          <div>
            <label className="label" htmlFor="login-user">
              Usuario
            </label>
            <div className="login-input-wrap">
              <User size={18} />
              <input
                id="login-user"
                className="input"
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                placeholder="tu.usuario"
                required
                aria-invalid={Boolean(error)}
                aria-describedby={error ? "login-error" : undefined}
              />
            </div>
          </div>
          <div>
            <label className="label" htmlFor="login-pass">
              Contraseña
            </label>
            <div className="login-input-wrap">
              <Key size={18} />
              <input
                id="login-pass"
                className="input"
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                placeholder="Tu contraseña"
                required
                aria-invalid={Boolean(error)}
                aria-describedby={error ? "login-error" : undefined}
              />
              <button
                type="button"
                className="login-password-toggle"
                onClick={() => setShowPassword((visible) => !visible)}
                aria-label={showPassword ? "Ocultar contraseña" : "Mostrar contraseña"}
                aria-pressed={showPassword}
                aria-controls="login-pass"
              >
                {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
          </div>

          {error && (
            <p id="login-error" className="alert alert-error" role="alert" aria-live="assertive">
              <Droplet size={15} className="alert-icon" />
              {error}
            </p>
          )}

          <button
            type="submit"
            className="btn btn-primary login-submit"
            disabled={busy}
            aria-busy={busy}
          >
            {busy && <Spinner />}
            {busy ? "Ingresando…" : "Ingresar al sistema"}
            {!busy && <ChevronRight className="login-submit-arrow" size={18} />}
          </button>
        </form>
        <div className="login-security-divider" aria-hidden><span><img src="/brand/logo_gotita.svg" alt="" width={754} height={1065} /></span></div>
        <p className="login-security">
          <img src="/brand/logo_gotita.svg" alt="" width={754} height={1065} aria-hidden />
          Acceso solo para el equipo Agua Renew.
        </p>
      </section>
    </main>
  );
}
