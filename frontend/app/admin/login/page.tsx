"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ApiError, authApi } from "@/lib/api";
import { Droplet } from "@/components/Icons";

export default function AdminLoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
      <div className="login-hero">
        <div className="watermark" aria-hidden />
        <img src="/brand/logo_color.svg" alt="Agua ReNew" />
        <h1>Asistencia y planilla</h1>
        <p>
          Marcación de entrada y salida, control de horas y cálculo interno de
          remuneraciones del personal.
        </p>
      </div>

      <div className="login-card">
        <div className="brand">
          <img src="/brand/logo_color.svg" alt="Agua ReNew" />
          <span className="sub">Panel administrativo</span>
        </div>

        <form onSubmit={handleSubmit} style={{ display: "grid", gap: "0.9rem" }}>
          <div>
            <label className="label" htmlFor="login-user">
              Usuario
            </label>
            <input
              id="login-user"
              className="input"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoFocus
              required
            />
          </div>
          <div>
            <label className="label" htmlFor="login-pass">
              Contraseña
            </label>
            <input
              id="login-pass"
              className="input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </div>

          {error && (
            <p className="alert alert-error" role="alert">
              <Droplet size={15} style={{ marginTop: 2, flexShrink: 0 }} />
              {error}
            </p>
          )}

          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? "Ingresando…" : "Ingresar al sistema"}
          </button>
        </form>
      </div>
    </div>
  );
}
