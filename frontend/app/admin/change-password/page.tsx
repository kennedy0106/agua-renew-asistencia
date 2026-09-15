"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { Alert, Check, Key, Shield } from "@/components/Icons";
import { useAdminSession } from "@/components/AdminSession";
import { Spinner } from "@/components/Loading";
import { ApiError, authApi, usersApi } from "@/lib/api";

export default function ChangePasswordPage() {
  const router = useRouter();
  const { user, ready } = useAdminSession();
  const currentRef = useRef<HTMLInputElement>(null);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!ready) return;
    if (!user) {
      router.replace("/admin/login");
      return;
    }
    currentRef.current?.focus();
  }, [ready, router, user]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    if (next !== confirm) {
      setError("La confirmación no coincide. Vuelve a escribir la nueva contraseña.");
      return;
    }
    setBusy(true);
    try {
      await usersApi.changeOwnPassword(current, next);
      // La sesión continúa válida, pero vuelve a leer el estado que ya no
      // exige cambio antes de permitir que el layout muestre el dashboard.
      await authApi.me();
      router.replace("/admin/dashboard");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No pudimos cambiar la contraseña. Inténtalo nuevamente.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="password-change-wrap">
      <section className="password-change-card" aria-labelledby="password-change-title">
        <Image className="password-change-brand" src="/brand/logo_color.svg" alt="Agua ReNew" width={700} height={190} priority />
        <span className="password-change-icon" aria-hidden><Shield size={24} /></span>
        <h1 id="password-change-title">Actualiza tu contraseña</h1>
        <p className="password-change-copy">Por seguridad, debes reemplazar tu contraseña temporal antes de usar el panel.</p>
        <form className="password-change-form" onSubmit={submit}>
          <div className="field-group">
            <label className="label" htmlFor="temporary-password">Contraseña temporal o actual</label>
            <input ref={currentRef} id="temporary-password" className="input" type="password" autoComplete="current-password" value={current} onChange={(event) => setCurrent(event.target.value)} required aria-invalid={Boolean(error)} />
          </div>
          <div className="field-group">
            <label className="label" htmlFor="required-new-password">Nueva contraseña</label>
            <input id="required-new-password" className="input" type="password" autoComplete="new-password" value={next} onChange={(event) => setNext(event.target.value)} required minLength={8} aria-describedby="required-password-help" aria-invalid={Boolean(error)} />
            <small id="required-password-help" className="field-help">Mínimo 8 caracteres. No compartas esta contraseña.</small>
          </div>
          <div className="field-group">
            <label className="label" htmlFor="required-confirm-password">Confirma la nueva contraseña</label>
            <input id="required-confirm-password" className="input" type="password" autoComplete="new-password" value={confirm} onChange={(event) => setConfirm(event.target.value)} required minLength={8} aria-invalid={Boolean(error)} />
          </div>
          {error && <p className="alert alert-error" role="alert"><Alert size={16} />{error}</p>}
          <button className="btn btn-primary password-change-submit" type="submit" disabled={busy}>{busy ? <Spinner /> : <Key size={16} />}{busy ? "Actualizando…" : "Guardar y continuar"}</button>
        </form>
        <p className="password-change-note"><Check size={15} /> Tu nueva contraseña se guarda de forma segura.</p>
      </section>
    </main>
  );
}
