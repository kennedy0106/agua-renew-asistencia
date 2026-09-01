"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { ApiError, authApi } from "@/lib/api";
import { Check, Clock, Droplet, Eye, EyeOff, Key, Shield, User } from "@/components/Icons";
import { Spinner } from "@/components/Loading";

export default function AdminLoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await authApi.login(username, password);
      router.replace("/admin/dashboard");
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
    <div className="login-wrap">
      <section className="login-hero" aria-labelledby="login-hero-title">
        <div className="login-caustic" aria-hidden />
        <Image src="/brand/logo_color.svg" alt="Agua ReNew" width={700} height={190} priority />
        <h1 id="login-hero-title">El tiempo del equipo, claro y en orden</h1>
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
          <Image src="/brand/logo_gotita.svg" alt="" width={754} height={1065} aria-hidden />
          Agua que renueva · Espíritu que transforma
        </p>
      </section>

      <section className="login-card" aria-labelledby="login-title">
        <div className="brand">
          <Image src="/brand/logo_color.svg" alt="Agua ReNew" width={700} height={190} priority />
        </div>

        <div className="login-card-heading">
          <div className="login-drop" aria-hidden>
            <Image src="/brand/logo_gotita.svg" alt="" width={754} height={1065} />
          </div>
          <div>
            <h2 id="login-title">Iniciar sesión</h2>
            <p>Entra con tu usuario de Agua Renew para administrar la asistencia.</p>
          </div>
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
                autoFocus
                required
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
              />
              <button
                type="button"
                className="login-password-toggle"
                onClick={() => setShowPassword((visible) => !visible)}
                aria-label={showPassword ? "Ocultar contraseña" : "Mostrar contraseña"}
                aria-pressed={showPassword}
              >
                {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
          </div>

          {error && (
            <p className="alert alert-error" role="alert">
              <Droplet size={15} style={{ marginTop: 2, flexShrink: 0 }} />
              {error}
            </p>
          )}

          <button type="submit" className="btn btn-primary login-submit" disabled={busy}>
            {busy && <Spinner />}
            {busy ? "Ingresando…" : "Ingresar al sistema"}
          </button>
        </form>
        <p className="login-security">
          <Image src="/brand/logo_gotita.svg" alt="" width={754} height={1065} aria-hidden />
          Acceso solo para el equipo Agua Renew.
        </p>
      </section>
    </div>
  );
}
