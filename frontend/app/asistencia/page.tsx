"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { ApiError, attendanceApi, AttendanceRecordOut, IdentifyResponse } from "@/lib/api";
import { Check, Clock, Droplet, User } from "@/components/Icons";
import { Spinner } from "@/components/Loading";

type Phase =
  | "pairing"
  | "identificando"
  | "abriendo_camara"
  | "video_listo"
  | "cuenta_regresiva"
  | "capturando"
  | "enviando"
  | "confirmado"
  | "incidencia";

type BarcodeDetectorLike = {
  detect: (source: CanvasImageSource) => Promise<Array<{ rawValue: string }>>;
};

function stopStream(stream: MediaStream | null) {
  stream?.getTracks().forEach((track) => track.stop());
}

export default function AsistenciaPage() {
  const [phase, setPhase] = useState<Phase>("identificando");
  const [identifier, setIdentifier] = useState("");
  const [pairingCode, setPairingCode] = useState("");
  const [info, setInfo] = useState<IdentifyResponse | null>(null);
  const [record, setRecord] = useState<AttendanceRecordOut | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [countdown, setCountdown] = useState(3);
  const [lastPhoto, setLastPhoto] = useState<string | null>(null);
  const [qrArmed, setQrArmed] = useState(false);
  const [now, setNow] = useState<Date>(() => new Date());
  const [serverOffset, setServerOffset] = useState(0);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const qrStreamRef = useRef<MediaStream | null>(null);
  const captureLock = useRef(false);

  function releaseAllCameras() {
    stopStream(streamRef.current);
    streamRef.current = null;
    stopStream(qrStreamRef.current);
    qrStreamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    return () => {
      releaseAllCameras();
    };
  }, []);

  useEffect(() => {
    const cameraPhases: Phase[] = ["abriendo_camara", "video_listo", "cuenta_regresiva", "capturando"];
    if (!cameraPhases.includes(phase)) {
      stopStream(streamRef.current);
      streamRef.current = null;
      if (videoRef.current) videoRef.current.srcObject = null;
      return;
    }
    if (streamRef.current || phase !== "abriendo_camara") return;
    let cancelled = false;
    (async () => {
      try {
        stopStream(qrStreamRef.current);
        qrStreamRef.current = null;
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: "user", width: { ideal: 720 }, height: { ideal: 720 } },
        });
        if (cancelled) {
          stopStream(stream);
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        if (!cancelled) setPhase("video_listo");
      } catch {
        setError("No se pudo abrir la cámara frontal. Permita el acceso e intente de nuevo.");
        setPhase("incidencia");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [phase]);

  useEffect(() => {
    if (phase !== "video_listo") return;
    const video = videoRef.current;
    if (!video || video.videoWidth < 320 || video.videoHeight < 240) {
      const wait = window.setTimeout(() => {
        if (videoRef.current && videoRef.current.videoWidth >= 320) {
          setPhase("cuenta_regresiva");
          setCountdown(3);
        } else {
          setError("La cámara no entregó un cuadro válido. No se tomó foto.");
          setPhase("incidencia");
        }
      }, 800);
      return () => window.clearTimeout(wait);
    }
    setPhase("cuenta_regresiva");
    setCountdown(3);
  }, [phase]);

  useEffect(() => {
    if (phase !== "cuenta_regresiva") return;
    if (countdown <= 0) {
      setPhase("capturando");
      return;
    }
    const timer = window.setTimeout(() => setCountdown((value) => value - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [phase, countdown]);

  useEffect(() => {
    if (!qrArmed) return;
    let cancelled = false;
    let detector: BarcodeDetectorLike | null = null;
    const Detector = (window as unknown as { BarcodeDetector?: new (opts: { formats: string[] }) => BarcodeDetectorLike }).BarcodeDetector;
    if (!Detector) {
      setError("Este navegador no lee QR con la cámara. Use el recuadro AR:…");
      setQrArmed(false);
      return;
    }
    detector = new Detector({ formats: ["qr_code"] });
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: "environment" } },
        });
        if (cancelled) {
          stopStream(stream);
          return;
        }
        qrStreamRef.current = stream;
        const video = document.createElement("video");
        video.srcObject = stream;
        video.setAttribute("playsinline", "true");
        await video.play();
        const tick = async () => {
          if (cancelled || !detector) return;
          try {
            const codes = await detector.detect(video);
            const raw = codes.map((item) => item.rawValue).find((value) => value);
            if (raw) {
              setIdentifier(raw.startsWith("AR:") ? raw : `AR:${raw}`);
              setQrArmed(false);
              stopStream(qrStreamRef.current);
              qrStreamRef.current = null;
              return;
            }
          } catch {
            // el detector puede fallar un frame
          }
          window.setTimeout(() => void tick(), 250);
        };
        void tick();
      } catch {
        setError("No se pudo abrir la cámara trasera para el QR.");
        setQrArmed(false);
      }
    })();
    return () => {
      cancelled = true;
      stopStream(qrStreamRef.current);
      qrStreamRef.current = null;
    };
  }, [qrArmed]);

  const serverNow = new Date(now.getTime() + serverOffset);

  async function handlePair(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      await attendanceApi.pairTerminal(pairingCode.trim());
      setPairingCode("");
      setPhase("identificando");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo emparejar este equipo");
    }
  }

  async function handleIdentify(event: React.FormEvent) {
    event.preventDefault();
    const value = identifier.trim();
    if (!value) return;
    setError(null);
    try {
      const result = await attendanceApi.identify(value);
      setInfo(result);
      setServerOffset(new Date(result.server_time).getTime() - Date.now());
      setIdentifier("");
      setLastPhoto(null);
      captureLock.current = false;
      setPhase("abriendo_camara");
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setPhase("pairing");
        setError(err.message);
        return;
      }
      setError(err instanceof ApiError ? err.message : "No se pudo conectar con el servidor");
      setPhase("incidencia");
    }
  }

  function grabFrame(): string | null {
    const video = videoRef.current;
    if (!video || video.videoWidth < 320 || video.videoHeight < 240) return null;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.8);
    return dataUrl.split(",")[1] ?? null;
  }

  async function sendPhoto(imageBase64: string, markingToken: string, markingAction: string) {
    setPhase("enviando");
    await attendanceApi.captureEvidence(markingToken, imageBase64);
    const result =
      markingAction === "CHECK_OUT"
        ? await attendanceApi.checkOut(markingToken)
        : await attendanceApi.checkIn(markingToken);
    releaseAllCameras();
    setRecord(result);
    setPhase("confirmado");
  }

  async function captureAndMark() {
    if (!info || captureLock.current) return;
    captureLock.current = true;
    setPhase("capturando");
    const imageBase64 = grabFrame();
    if (!imageBase64) {
      setError("No hay un cuadro válido de cámara. No se registró la marcación.");
      setPhase("incidencia");
      captureLock.current = false;
      return;
    }
    setLastPhoto(imageBase64);
    try {
      await sendPhoto(imageBase64, info.marking_token, info.marking_action);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo registrar la marcación");
      setPhase("incidencia");
      captureLock.current = false;
    }
  }

  useEffect(() => {
    if (phase !== "capturando") return;
    void captureAndMark();
    // captureAndMark se recrea cada render; el lock evita un segundo envío.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  async function resendSamePhoto() {
    if (!info || !lastPhoto) return;
    setError(null);
    try {
      await sendPhoto(lastPhoto, info.marking_token, info.marking_action);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo reenviar la foto");
      setPhase("incidencia");
    }
  }

  function takeAnotherPhoto() {
    releaseAllCameras();
    setInfo(null);
    setLastPhoto(null);
    captureLock.current = false;
    setError(null);
    setPhase("identificando");
  }

  function reset() {
    releaseAllCameras();
    setPhase("identificando");
    setInfo(null);
    setRecord(null);
    setError(null);
    setLastPhoto(null);
    setQrArmed(false);
    setServerOffset(0);
    captureLock.current = false;
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
  const cameraOpen = phase === "abriendo_camara" || phase === "video_listo" || phase === "cuenta_regresiva" || phase === "capturando";

  return (
    <div className="kiosk">
      <div className="kiosk-brand">
        <Image src="/brand/logo_color.svg" alt="Agua ReNew" width={700} height={190} priority />
      </div>

      <div className="kiosk-card">
        {phase === "pairing" && (
          <form onSubmit={handlePair} style={{ display: "grid", gap: "0.7rem" }}>
            <p className="kiosk-date">Este equipo necesita un código de emparejamiento de un solo uso.</p>
            <input
              className="input"
              value={pairingCode}
              onChange={(e) => setPairingCode(e.target.value)}
              placeholder="Código emitido por administración"
              autoFocus
            />
            {error && (
              <p className="alert alert-error" role="alert">
                {error}
              </p>
            )}
            <button type="submit" className="btn btn-primary kiosk-btn">
              Emparejar tablet
            </button>
          </form>
        )}

        {phase === "identificando" && (
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
              <button type="submit" className="btn btn-primary kiosk-btn">
                <User size={18} />
                Identificarme
              </button>
              <button type="button" className="btn btn-outline kiosk-btn" onClick={() => setQrArmed(true)}>
                Escanear QR con cámara trasera
              </button>
            </form>
          </>
        )}

        {cameraOpen && info && (
          <>
            <div className="kiosk-employee">
              <div className="avatar-lg">{initials}</div>
              <div>
                <div className="name">
                  {info.employee.first_name} {info.employee.last_name}
                </div>
                <div className="role">
                  {info.marking_action === "CHECK_OUT" ? "Foto de salida" : "Foto de entrada"}
                </div>
              </div>
            </div>
            <video ref={videoRef} className="kiosk-video" playsInline muted autoPlay />
            {phase === "cuenta_regresiva" && <p className="kiosk-countdown">{countdown}</p>}
            {phase === "abriendo_camara" && <p className="muted">Abriendo cámara…</p>}
            <button className="btn btn-outline btn-sm" onClick={reset} type="button">
              Cancelar
            </button>
          </>
        )}

        {phase === "enviando" && (
          <p className="kiosk-date">
            <Spinner size={18} /> Enviando marcación…
          </p>
        )}

        {phase === "incidencia" && (
          <>
            {error && (
              <p className="alert alert-error" role="alert">
                {error}
              </p>
            )}
            {lastPhoto && info && (
              <button className="btn btn-primary kiosk-btn" type="button" onClick={() => void resendSamePhoto()}>
                Reenviar la misma foto
              </button>
            )}
            <button className="btn btn-outline kiosk-btn" type="button" onClick={takeAnotherPhoto}>
              Tomar otra foto
            </button>
          </>
        )}

        {phase === "confirmado" && record && (
          <div className="kiosk-done">
            <div className={`big-icon ${(record.event_type ?? record.status) === "CHECK_IN" || record.status === "OPEN" ? "ok" : "blue"}`}>
              {(record.event_type ?? record.status) === "CHECK_IN" || record.status === "OPEN" ? <Droplet size={26} /> : <Check size={26} />}
            </div>
            <h2>
              {(record.event_type ?? record.status) === "CHECK_IN" || record.status === "OPEN"
                ? "Entrada registrada"
                : "Salida registrada"}
            </h2>
            <p className="detail">
              {(record.event_type ?? record.status) === "CHECK_IN" || record.status === "OPEN"
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
