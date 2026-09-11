"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { ApiError, attendanceApi, AttendanceRecordOut, IdentifyResponse } from "@/lib/api";
import { Check, Clock, Droplet, Logout, User } from "@/components/Icons";
import { Spinner } from "@/components/Loading";

type Step = "identify" | "employee" | "photo" | "done";

export default function AsistenciaPage() {
  const [step, setStep] = useState<Step>("identify");
  const [identifier, setIdentifier] = useState("");
  const [info, setInfo] = useState<IdentifyResponse | null>(null);
  const [record, setRecord] = useState<AttendanceRecordOut | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState<Date>(() => new Date());
  const [serverOffset, setServerOffset] = useState(0);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  function stopCamera() {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (step !== "photo") {
      stopCamera();
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: "user", width: { ideal: 720 }, height: { ideal: 720 } },
        });
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
      } catch {
        setError("No se pudo abrir la cámara frontal. Permita el acceso e intente de nuevo.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [step]);

  const serverNow = new Date(now.getTime() + serverOffset);

  async function handleIdentify(event: React.FormEvent) {
    event.preventDefault();
    const value = identifier.trim();
    if (!value) return;
    setBusy(true);
    setError(null);
    try {
      const result = await attendanceApi.identify(value);
      setInfo(result);
      setServerOffset(new Date(result.server_time).getTime() - Date.now());
      setStep("employee");
      setIdentifier("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo conectar con el servidor");
    } finally {
      setBusy(false);
    }
  }

  async function handleCaptureAndMark() {
    if (!info || !videoRef.current) return;
    setBusy(true);
    setError(null);
    try {
      const video = videoRef.current;
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth || 480;
      canvas.height = video.videoHeight || 480;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("canvas");
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.72);
      const imageBase64 = dataUrl.split(",")[1];
      if (!imageBase64) throw new Error("foto");
      await attendanceApi.captureEvidence(info.marking_token, imageBase64);
      const result =
        info.marking_action === "CHECK_OUT"
          ? await attendanceApi.checkOut(info.marking_token)
          : await attendanceApi.checkIn(info.marking_token);
      stopCamera();
      setRecord(result);
      setStep("done");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo registrar la marcación");
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    stopCamera();
    setStep("identify");
    setInfo(null);
    setRecord(null);
    setError(null);
    setServerOffset(0);
  }

  const limaClock: Intl.DateTimeFormatOptions = {
    timeZone: "America/Lima",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  };
  const limaDate: Intl.DateTimeFormatOptions = {
    timeZone: "America/Lima",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  };
  const timeLabel = serverNow.toLocaleTimeString("es-PE", limaClock);
  const dateLabel = serverNow.toLocaleDateString("es-PE", limaDate);
  const firstName = info?.employee.first_name ?? "";
  const initials = firstName.charAt(0).toUpperCase() || "?";

  return (
    <div className="kiosk">
      <div className="kiosk-brand">
        <Image src="/brand/logo_color.svg" alt="Agua ReNew" width={700} height={190} priority />
      </div>

      <div className="kiosk-card">
        {step === "identify" && (
          <>
            <div className="kiosk-clock" suppressHydrationWarning>
              {timeLabel}
            </div>
            <div className="kiosk-date" suppressHydrationWarning>
              {dateLabel}
            </div>

            <form onSubmit={handleIdentify} style={{ display: "grid", gap: "0.7rem" }}>
              <label className="label" htmlFor="kiosk-id">
                DNI, código interno o QR
              </label>
              <input
                id="kiosk-id"
                className="input"
                type="text"
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                placeholder="Ej. 71112233, EMP-002 o AR:…"
                autoFocus
                autoComplete="off"
                style={{ fontSize: "1rem", padding: "0.7rem 0.85rem" }}
              />
              {error && (
                <p className="alert alert-error" role="alert">
                  <Droplet size={15} style={{ marginTop: 2, flexShrink: 0 }} />
                  {error}
                </p>
              )}
              <button type="submit" className="btn btn-primary kiosk-btn" disabled={busy}>
                {busy ? <Spinner size={18} /> : <User size={18} />}
                {busy ? "Verificando…" : "Identificarme"}
              </button>
            </form>
          </>
        )}

        {step === "employee" && info && (
          <>
            <div className="kiosk-clock" style={{ fontSize: "1.9rem" }} suppressHydrationWarning>
              {timeLabel}
            </div>
            <div className="kiosk-date" suppressHydrationWarning>
              {dateLabel}
            </div>

            <div className="kiosk-employee">
              <div className="avatar-lg">{initials}</div>
              <div>
                <div className="name">
                  {info.employee.first_name} {info.employee.last_name}
                </div>
                <div className="role">{info.employee.job_role_name ?? "—"}</div>
              </div>
            </div>

            {error && (
              <p className="alert alert-error" role="alert">
                <Droplet size={15} style={{ marginTop: 2, flexShrink: 0 }} />
                {error}
              </p>
            )}

            {info.state.has_open_entry ? (
              <button className="btn btn-primary kiosk-btn" onClick={() => setStep("photo")} disabled={busy}>
                <Logout size={18} />
                Continuar a foto de salida
              </button>
            ) : (
              <button className="btn btn-green kiosk-btn" onClick={() => setStep("photo")} disabled={busy}>
                <Droplet size={18} />
                Continuar a foto de entrada
              </button>
            )}
            <button
              className="btn btn-outline btn-sm"
              onClick={reset}
              type="button"
              style={{ display: "flex", margin: "0.8rem auto 0" }}
            >
              Cambiar de trabajador
            </button>
          </>
        )}

        {step === "photo" && info && (
          <>
            <p className="kiosk-date" style={{ marginBottom: "0.6rem" }}>
              Mire a la cámara frontal. La foto se toma ahora, no se reutiliza.
            </p>
            <video ref={videoRef} className="kiosk-video" playsInline muted autoPlay />
            {error && (
              <p className="alert alert-error" role="alert">
                <Droplet size={15} style={{ marginTop: 2, flexShrink: 0 }} />
                {error}
              </p>
            )}
            <button className="btn btn-green kiosk-btn" onClick={handleCaptureAndMark} disabled={busy}>
              {busy ? <Spinner size={18} /> : <Check size={18} />}
              {busy ? "Registrando…" : info.marking_action === "CHECK_OUT" ? "Tomar foto y marcar salida" : "Tomar foto y marcar entrada"}
            </button>
            <button className="btn btn-outline btn-sm" onClick={reset} type="button" style={{ display: "flex", margin: "0.8rem auto 0" }}>
              Cancelar
            </button>
          </>
        )}

        {step === "done" && record && (
          <div className="kiosk-done">
            <div className={`big-icon ${record.status === "OPEN" ? "ok" : "blue"}`}>
              {record.status === "OPEN" ? <Droplet size={26} /> : <Check size={26} />}
            </div>
            <h2>
              {record.status === "OPEN"
                ? "Entrada registrada"
                : "Salida registrada"}
            </h2>
            <p className="detail">
              {record.status === "OPEN"
                ? `Ingresaste a las ${formatTime(record.check_in_at)}.`
                : `Saliste a las ${formatTime(record.check_out_at)} · ${fmtMin(record.worked_minutes)} trabajadas.`}
            </p>
            <button className="btn btn-outline kiosk-btn" onClick={reset}>
              <Clock size={17} />
              Nueva marcación
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function formatTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("es-PE", {
    timeZone: "America/Lima",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function fmtMin(minutes: number | null): string {
  if (minutes === null || minutes === undefined) return "—";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h} h ${m} min` : `${m} min`;
}
