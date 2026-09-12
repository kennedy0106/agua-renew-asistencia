"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { ApiError, attendanceApi, AttendanceRecordOut, IdentifyResponse } from "@/lib/api";
import { Check, Clock, Droplet, User } from "@/components/Icons";
import { Spinner } from "@/components/Loading";

type Phase =
  | "pairing"
  | "identificando"
  | "escaneando_qr"
  | "abriendo_camara"
  | "video_listo"
  | "cuenta_regresiva"
  | "capturando"
  | "enviando"
  | "confirmado"
  | "incidencia";

type RecoverOutcome =
  | { kind: "confirmed"; record: AttendanceRecordOut }
  | { kind: "pending"; evidenceReady: boolean; writeTokenValid: boolean }
  | { kind: "expired_unconfirmed"; evidenceReady: boolean }
  | { kind: "cancelled"; reason: string | null }
  | { kind: "reviewed"; reason: string | null }
  | { kind: "unauthorized" }
  | { kind: "gone" }
  | { kind: "error" }
  | { kind: "unknown" }
  | { kind: "stale" };

type BarcodeDetectorLike = {
  detect: (source: CanvasImageSource) => Promise<Array<{ rawValue: string }>>;
};

function stopStream(stream: MediaStream | null) {
  stream?.getTracks().forEach((track) => track.stop());
}

function barcodeDetectorCtor(): (new (opts: { formats: string[] }) => BarcodeDetectorLike) | null {
  return (window as unknown as { BarcodeDetector?: new (opts: { formats: string[] }) => BarcodeDetectorLike }).BarcodeDetector ?? null;
}

/** Referencia mínima del intento enviado. No guarda cookie del terminal ni fotografías. */
const KIOSK_ATTEMPT_KEY = "agua_renew_kiosk_open_attempt";

type DeliveryStage = "EVIDENCE_REQUESTED" | "EVIDENCE_STORED" | "MARKING_REQUESTED" | "UNKNOWN";

type StoredAttempt = {
  v: 1 | 2;
  marking_token: string;
  marking_action: IdentifyResponse["marking_action"];
  employee: IdentifyResponse["employee"];
  stage: DeliveryStage;
};

function nonceFromMarkingToken(token: string): string | null {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const padded = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = atob(padded.padEnd(padded.length + ((4 - (padded.length % 4)) % 4), "="));
    const payload = JSON.parse(json) as { nonce?: unknown };
    return typeof payload.nonce === "string" ? payload.nonce : null;
  } catch {
    return null;
  }
}

function readStoredAttempt(): StoredAttempt | null {
  try {
    const raw = sessionStorage.getItem(KIOSK_ATTEMPT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredAttempt> & { v?: number };
    if (!parsed?.marking_token || !parsed?.employee?.id) return null;
    if (parsed.marking_action !== "CHECK_IN" && parsed.marking_action !== "CHECK_OUT") return null;
    const version = parsed.v === 2 ? 2 : 1;
    const stage: DeliveryStage =
      parsed.stage === "EVIDENCE_REQUESTED" || parsed.stage === "EVIDENCE_STORED" || parsed.stage === "MARKING_REQUESTED"
        ? parsed.stage
        : "UNKNOWN";
    return {
      v: version,
      marking_token: parsed.marking_token,
      marking_action: parsed.marking_action,
      employee: parsed.employee,
      stage: version === 2 ? stage : "UNKNOWN",
    };
  } catch {
    return null;
  }
}

function persistAttempt(info: IdentifyResponse, stage: DeliveryStage): boolean {
  try {
    const payload: StoredAttempt = {
      v: 2,
      marking_token: info.marking_token,
      marking_action: info.marking_action,
      employee: info.employee,
      stage,
    };
    sessionStorage.setItem(KIOSK_ATTEMPT_KEY, JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

function clearStoredAttempt() {
  try {
    sessionStorage.removeItem(KIOSK_ATTEMPT_KEY);
  } catch {
    // El storage no es autoritativo; el servidor conserva el intento.
  }
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
  const [identifying, setIdentifying] = useState(false);
  const [consulting, setConsulting] = useState(false);
  const [sending, setSending] = useState(false);
  const [qrSupported, setQrSupported] = useState(true);
  const [now, setNow] = useState<Date>(() => new Date());
  const [serverOffset, setServerOffset] = useState(0);
  const [attemptSubmitted, setAttemptSubmitted] = useState(false);
  const [lastAttemptStatus, setLastAttemptStatus] = useState<RecoverOutcome | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const qrVideoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const qrStreamRef = useRef<MediaStream | null>(null);
  const captureLock = useRef(false);
  const identifyingRef = useRef(false);
  const sendingRef = useRef(false);
  const recoverLockRef = useRef(false);
  const generationRef = useRef(0);
  const infoRef = useRef<IdentifyResponse | null>(null);
  const submittedRef = useRef(false);

  function bumpGeneration() {
    generationRef.current += 1;
  }

  function releaseAllCameras() {
    stopStream(streamRef.current);
    streamRef.current = null;
    stopStream(qrStreamRef.current);
    qrStreamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    if (qrVideoRef.current) qrVideoRef.current.srcObject = null;
  }

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const stored = readStoredAttempt();
    if (!stored) return;
    const restored: IdentifyResponse = {
      employee: stored.employee,
      state: {
        has_open_entry: stored.marking_action === "CHECK_OUT",
        open_check_in_at: null,
        last_record: null,
      },
      server_time: new Date().toISOString(),
      server_time_label: "",
      marking_token: stored.marking_token,
      marking_action: stored.marking_action,
    };
    infoRef.current = restored;
    submittedRef.current = true;
    setAttemptSubmitted(true);
    setInfo(restored);
    setLastAttemptStatus({ kind: "pending", evidenceReady: stored.stage === "EVIDENCE_STORED" || stored.stage === "MARKING_REQUESTED" || stored.stage === "UNKNOWN", writeTokenValid: false });
    setError(
      "Hay una marcación enviada sin confirmar. Consulte este mismo intento o pida a un jefe que la revise en el panel. No se afirma que no se haya marcado.",
    );
    setPhase("incidencia");
  }, []);

  useEffect(() => {
    return () => {
      bumpGeneration();
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
    const gen = generationRef.current;
    let cancelled = false;
    (async () => {
      try {
        stopStream(qrStreamRef.current);
        qrStreamRef.current = null;
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: "user", width: { ideal: 720 }, height: { ideal: 720 } },
        });
        if (cancelled || gen !== generationRef.current) {
          stopStream(stream);
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        if (!cancelled && gen === generationRef.current) setPhase("video_listo");
      } catch {
        if (gen !== generationRef.current) return;
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
    const gen = generationRef.current;
    const video = videoRef.current;
    let cancelled = false;

    const proceed = () => {
      if (cancelled || gen !== generationRef.current) return;
      const current = videoRef.current;
      if (current && current.videoWidth >= 320 && current.videoHeight >= 240) {
        setPhase("cuenta_regresiva");
        setCountdown(3);
        return;
      }
      setError("La cámara no entregó un cuadro válido. No se tomó foto.");
      setPhase("incidencia");
    };

    if (video && video.videoWidth >= 320 && video.videoHeight >= 240) {
      proceed();
      return;
    }
    const wait = window.setTimeout(proceed, 800);
    const onMeta = () => {
      if (video && video.videoWidth >= 320 && video.videoHeight >= 240) {
        window.clearTimeout(wait);
        proceed();
      }
    };
    video?.addEventListener("loadedmetadata", onMeta);
    return () => {
      cancelled = true;
      window.clearTimeout(wait);
      video?.removeEventListener("loadedmetadata", onMeta);
    };
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
    if (phase !== "escaneando_qr") {
      stopStream(qrStreamRef.current);
      qrStreamRef.current = null;
      if (qrVideoRef.current) qrVideoRef.current.srcObject = null;
      return;
    }
    const Detector = barcodeDetectorCtor();
    if (!Detector) {
      setQrSupported(false);
      setError("Este navegador no lee QR con la cámara. Use el recuadro AR:…");
      setPhase("identificando");
      return;
    }
    const gen = generationRef.current;
    let cancelled = false;
    const detector = new Detector({ formats: ["qr_code"] });
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: "environment" } },
        });
        if (cancelled || gen !== generationRef.current) {
          stopStream(stream);
          return;
        }
        qrStreamRef.current = stream;
        if (qrVideoRef.current) {
          qrVideoRef.current.srcObject = stream;
          await qrVideoRef.current.play();
        }
        const tick = async () => {
          if (cancelled || gen !== generationRef.current || !qrVideoRef.current) return;
          try {
            const codes = await detector.detect(qrVideoRef.current);
            if (cancelled || gen !== generationRef.current) return;
            const raw = codes.map((item) => item.rawValue).find((value) => value);
            if (raw) {
              if (gen !== generationRef.current) return;
              stopStream(qrStreamRef.current);
              qrStreamRef.current = null;
              const value = raw.startsWith("AR:") ? raw : `AR:${raw}`;
              await identifyValue(value, gen);
              return;
            }
          } catch {
            // un frame fallido no cancela el escaneo
          }
          window.setTimeout(() => void tick(), 250);
        };
        void tick();
      } catch {
        if (gen !== generationRef.current) return;
        setError("No se pudo abrir la cámara trasera para el QR.");
        setPhase("identificando");
      }
    })();
    return () => {
      cancelled = true;
      stopStream(qrStreamRef.current);
      qrStreamRef.current = null;
    };
  }, [phase]);

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

  async function identifyValue(value: string, gen: number) {
    if (!value || identifyingRef.current) return;
    identifyingRef.current = true;
    setIdentifying(true);
    setError(null);
    try {
      const result = await attendanceApi.identify(value);
      if (gen !== generationRef.current) return;
      infoRef.current = result;
      setInfo(result);
      setServerOffset(new Date(result.server_time).getTime() - Date.now());
      setIdentifier("");
      setLastPhoto(null);
      setLastAttemptStatus(null);
      captureLock.current = false;
      setPhase("abriendo_camara");
    } catch (err) {
      if (gen !== generationRef.current) return;
      if (err instanceof ApiError && err.status === 401) {
        setPhase("pairing");
        setError(err.message);
        return;
      }
      setError(err instanceof ApiError ? err.message : "No se pudo conectar con el servidor");
      setPhase("incidencia");
    } finally {
      if (gen === generationRef.current) {
        identifyingRef.current = false;
        setIdentifying(false);
      }
    }
  }

  async function handleIdentify(event: React.FormEvent) {
    event.preventDefault();
    if (identifyingRef.current) return;
    await identifyValue(identifier.trim(), generationRef.current);
  }

  function grabFrame(): string | null {
    const video = videoRef.current;
    if (!video || video.videoWidth < 320 || video.videoHeight < 240) {
      return null;
    }
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.8);
    return dataUrl.split(",")[1] ?? null;
  }

  async function recoverAttempt(markingToken: string, gen: number): Promise<RecoverOutcome> {
    try {
      const frozen = await attendanceApi.attemptStatus(markingToken);
      if (gen !== generationRef.current) return { kind: "stale" };
      if (frozen.state === "CONFIRMED" && frozen.record) {
        return { kind: "confirmed", record: frozen.record };
      }
      if (frozen.state === "PENDING") {
        return {
          kind: "pending",
          evidenceReady: Boolean(frozen.evidence_ready),
          writeTokenValid: Boolean(frozen.write_token_valid),
        };
      }
      if (frozen.state === "EXPIRED_UNCONFIRMED") {
        return { kind: "expired_unconfirmed", evidenceReady: Boolean(frozen.evidence_ready) };
      }
      if (frozen.state === "CANCELLED") {
        return { kind: "cancelled", reason: frozen.reason ?? null };
      }
      if (frozen.state === "REVIEWED") {
        return { kind: "reviewed", reason: frozen.reason ?? null };
      }
      return { kind: "unknown" };
    } catch (err) {
      if (gen !== generationRef.current) return { kind: "stale" };
      if (err instanceof ApiError && err.status === 401) return { kind: "unauthorized" };
      if (err instanceof ApiError && err.status === 410) return { kind: "gone" };
      return { kind: "error" };
    }
  }

  function showConfirmed(result: AttendanceRecordOut) {
    releaseAllCameras();
    submittedRef.current = false;
    setAttemptSubmitted(false);
    setLastAttemptStatus({ kind: "confirmed", record: result });
    clearStoredAttempt();
    setRecord(result);
    setPhase("confirmado");
  }

  function rememberSubmittedAttempt() {
    const current = infoRef.current;
    if (!current) return;
    submittedRef.current = true;
    setAttemptSubmitted(true);
  }

  function showUncertain(message: string) {
    setError(message);
    setPhase("incidencia");
    captureLock.current = false;
  }

  function applyReadOnlyAttemptOutcome(outcome: RecoverOutcome) {
    if (outcome.kind === "stale") return;
    setLastAttemptStatus(outcome);
    if (outcome.kind === "confirmed") {
      showConfirmed(outcome.record);
      return;
    }
    if (outcome.kind === "pending") {
      showUncertain(
        outcome.evidenceReady
          ? "El intento sigue pendiente. Si la foto ya está guardada, complete la marcación sin tomar otra."
          : "El intento sigue pendiente. Conserve esta referencia; no se inició una marcación nueva.",
      );
      return;
    }
    if (outcome.kind === "expired_unconfirmed") {
      showUncertain(
        "El permiso de este intento ya venció. Resuélvalo aquí para identificarse de nuevo. No se afirma que no se haya marcado.",
      );
      return;
    }
    if (outcome.kind === "cancelled") {
      showUncertain("Este intento quedó cerrado. Pulse volver al inicio para identificarse de nuevo.");
      return;
    }
    if (outcome.kind === "reviewed") {
      showUncertain("Un jefe revisó este intento. Pulse volver al inicio. No se registró una marcación nueva.");
      return;
    }
    if (outcome.kind === "unauthorized") {
      showUncertain(
        "Este equipo no está autorizado para consultar el intento. Conserve esta referencia y pida a un jefe que revise la marcación en el panel. No se afirma que no se haya marcado.",
      );
      return;
    }
    if (outcome.kind === "gone") {
      showUncertain(
        "El plazo para recuperar este intento ya venció. Pida a un jefe que revise la marcación en el panel. No se afirma que no se haya marcado.",
      );
      return;
    }
    showUncertain("No se pudo confirmar si la marcación quedó registrada. Consulte de nuevo este mismo intento.");
  }

  async function sendPhoto(imageBase64: string, markingToken: string, markingAction: string, gen: number) {
    if (gen !== generationRef.current) return;
    if (sendingRef.current) return;
    const current = infoRef.current;
    if (!current || current.marking_token !== markingToken) return;
    sendingRef.current = true;
    setSending(true);
    rememberSubmittedAttempt();
    if (!persistAttempt(current, "EVIDENCE_REQUESTED")) {
      showUncertain(
        "No se pudo guardar la referencia de este intento. No se envió la fotografía ni la marcación.",
      );
      sendingRef.current = false;
      setSending(false);
      return;
    }
    setPhase("enviando");
    try {
      await attendanceApi.captureEvidence(markingToken, imageBase64);
      if (gen !== generationRef.current) return;
      persistAttempt(current, "EVIDENCE_STORED");
      if (!persistAttempt(current, "MARKING_REQUESTED")) {
        setLastAttemptStatus({ kind: "pending", evidenceReady: true, writeTokenValid: true });
        showUncertain("La foto se guardó. Consulte o complete este intento. No se envió la marcación.");
        return;
      }
      const result =
        markingAction === "CHECK_OUT"
          ? await attendanceApi.checkOut(markingToken)
          : await attendanceApi.checkIn(markingToken);
      if (gen !== generationRef.current) return;
      showConfirmed(result);
    } catch {
      if (gen !== generationRef.current) return;
      const recovered = await recoverAttempt(markingToken, gen);
      if (recovered.kind === "stale") return;
      applyReadOnlyAttemptOutcome(recovered);
    } finally {
      if (gen === generationRef.current) {
        sendingRef.current = false;
        setSending(false);
      }
    }
  }

  async function captureAndMark() {
    const current = infoRef.current;
    if (!current || captureLock.current) return;
    const gen = generationRef.current;
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
    await sendPhoto(imageBase64, current.marking_token, current.marking_action, gen);
  }

  useEffect(() => {
    if (phase !== "capturando") return;
    void captureAndMark();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  async function consultAttempt() {
    const current = infoRef.current;
    if (!current || sendingRef.current || recoverLockRef.current) return;
    const gen = generationRef.current;
    const token = current.marking_token;
    recoverLockRef.current = true;
    setConsulting(true);
    const isCurrent = () => gen === generationRef.current && infoRef.current?.marking_token === token;
    try {
      const outcome = await recoverAttempt(token, gen);
      if (!isCurrent() || outcome.kind === "stale") return;
      applyReadOnlyAttemptOutcome(outcome);
    } finally {
      if (isCurrent()) {
        recoverLockRef.current = false;
        setConsulting(false);
      }
    }
  }

  async function resendSamePhoto() {
    const current = infoRef.current;
    if (!current || !lastPhoto) return;
    const gen = generationRef.current;
    if (sendingRef.current || recoverLockRef.current) return;
    recoverLockRef.current = true;
    setError(null);
    const isCurrent = () => gen === generationRef.current && infoRef.current?.marking_token === current.marking_token;
    try {
      const recovered = await recoverAttempt(current.marking_token, gen);
      if (!isCurrent() || recovered.kind === "stale") return;
      if (recovered.kind !== "pending" || !recovered.writeTokenValid) {
        applyReadOnlyAttemptOutcome(recovered);
        return;
      }
      if (!lastPhoto) {
        applyReadOnlyAttemptOutcome(recovered);
        return;
      }
      recoverLockRef.current = false;
      await sendPhoto(lastPhoto, current.marking_token, current.marking_action, gen);
    } finally {
      if (isCurrent()) recoverLockRef.current = false;
    }
  }

  async function completeAttempt() {
    const current = infoRef.current;
    if (!current || sendingRef.current || recoverLockRef.current) return;
    const gen = generationRef.current;
    const token = current.marking_token;
    sendingRef.current = true;
    setSending(true);
    rememberSubmittedAttempt();
    const isCurrent = () => gen === generationRef.current && infoRef.current?.marking_token === token;
    if (!persistAttempt(current, "MARKING_REQUESTED")) {
      showUncertain("No se pudo guardar la referencia. No se envió la marcación.");
      sendingRef.current = false;
      setSending(false);
      return;
    }
    setPhase("enviando");
    try {
      const result =
        current.marking_action === "CHECK_OUT"
          ? await attendanceApi.checkOut(token)
          : await attendanceApi.checkIn(token);
      if (!isCurrent()) return;
      showConfirmed(result);
    } catch {
      if (!isCurrent()) return;
      const recovered = await recoverAttempt(token, gen);
      if (recovered.kind === "stale" || !isCurrent()) return;
      applyReadOnlyAttemptOutcome(recovered);
    } finally {
      if (isCurrent()) {
        sendingRef.current = false;
        setSending(false);
      }
    }
  }

  async function resolveKioskAttempt(reasonCode: "TOKEN_EXPIRED" | "PHOTO_RETAKE" | "USER_CANCELLED") {
    const current = infoRef.current;
    if (!current || sendingRef.current || recoverLockRef.current) return;
    const gen = generationRef.current;
    const token = current.marking_token;
    recoverLockRef.current = true;
    setConsulting(true);
    const isCurrent = () => gen === generationRef.current && infoRef.current?.marking_token === token;
    try {
      const frozen = await attendanceApi.resolveAttempt(token, reasonCode);
      if (!isCurrent()) return;
      if (frozen.state === "CONFIRMED" && frozen.record) {
        showConfirmed(frozen.record);
        return;
      }
      const mapped: RecoverOutcome =
        frozen.state === "CANCELLED"
          ? { kind: "cancelled", reason: frozen.reason ?? reasonCode }
          : frozen.state === "REVIEWED"
            ? { kind: "reviewed", reason: frozen.reason ?? null }
            : frozen.state === "PENDING"
              ? { kind: "pending", evidenceReady: Boolean(frozen.evidence_ready), writeTokenValid: Boolean(frozen.write_token_valid) }
              : frozen.state === "EXPIRED_UNCONFIRMED"
                ? { kind: "expired_unconfirmed", evidenceReady: Boolean(frozen.evidence_ready) }
                : { kind: "unknown" };
      applyReadOnlyAttemptOutcome(mapped);
    } catch (err) {
      if (!isCurrent()) return;
      if (err instanceof ApiError && err.status === 401) {
        applyReadOnlyAttemptOutcome({ kind: "unauthorized" });
        return;
      }
      if (err instanceof ApiError && err.status === 410) {
        applyReadOnlyAttemptOutcome({ kind: "gone" });
        return;
      }
      applyReadOnlyAttemptOutcome({ kind: "error" });
    } finally {
      if (isCurrent()) {
        recoverLockRef.current = false;
        setConsulting(false);
      }
    }
  }

  function releaseInFlightLocks() {
    captureLock.current = false;
    identifyingRef.current = false;
    sendingRef.current = false;
    recoverLockRef.current = false;
    setIdentifying(false);
    setConsulting(false);
    setSending(false);
  }

  function restartResolvedAttempt() {
    if (lastAttemptStatus?.kind !== "cancelled" && lastAttemptStatus?.kind !== "reviewed") return;
    bumpGeneration();
    releaseAllCameras();
    releaseInFlightLocks();
    submittedRef.current = false;
    setAttemptSubmitted(false);
    clearStoredAttempt();
    infoRef.current = null;
    setInfo(null);
    setRecord(null);
    setError(null);
    setLastPhoto(null);
    setLastAttemptStatus(null);
    setServerOffset(0);
    setPhase("identificando");
  }

  async function takeAnotherPhoto() {
    const current = infoRef.current;
    const needsResolve =
      submittedRef.current ||
      lastAttemptStatus?.kind === "pending" ||
      lastAttemptStatus?.kind === "expired_unconfirmed" ||
      lastAttemptStatus?.kind === "error" ||
      lastAttemptStatus?.kind === "unknown" ||
      lastAttemptStatus?.kind === "gone";
    const reason: "TOKEN_EXPIRED" | "PHOTO_RETAKE" =
      lastAttemptStatus?.kind === "expired_unconfirmed" ? "TOKEN_EXPIRED" : "PHOTO_RETAKE";
    bumpGeneration();
    releaseAllCameras();
    releaseInFlightLocks();
    setError(null);
    setLastPhoto(null);
    if (needsResolve && current) {
      infoRef.current = current;
      setInfo(current);
      await resolveKioskAttempt(reason);
      return;
    }
    if (current) {
      infoRef.current = current;
      setPhase("abriendo_camara");
      return;
    }
    setPhase("identificando");
  }

  function reset() {
    bumpGeneration();
    releaseAllCameras();
    releaseInFlightLocks();
    if (submittedRef.current && phase !== "confirmado") {
      setError(
        "Hay una marcación enviada sin confirmar. Consulte este mismo intento o pida a un jefe que la revise en el panel. Cancelar no borra una asistencia ya registrada.",
      );
      setPhase("incidencia");
      return;
    }
    if (phase === "confirmado") {
      submittedRef.current = false;
      setAttemptSubmitted(false);
      setLastAttemptStatus(null);
      clearStoredAttempt();
    }
    setPhase("identificando");
    infoRef.current = null;
    setInfo(null);
    setRecord(null);
    setError(null);
    setLastPhoto(null);
    setServerOffset(0);
  }

  function startQrScan() {
    if (identifyingRef.current) return;
    const Detector = barcodeDetectorCtor();
    if (!Detector) {
      setQrSupported(false);
      setError("Este navegador no lee QR con la cámara. Use el recuadro AR:…");
      return;
    }
    setError(null);
    setPhase("escaneando_qr");
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
  const attemptNonce = info ? nonceFromMarkingToken(info.marking_token) : null;
  const canComplete =
    lastAttemptStatus?.kind === "pending" && lastAttemptStatus.evidenceReady && lastAttemptStatus.writeTokenValid;
  const canResolveExpired = lastAttemptStatus?.kind === "expired_unconfirmed";
  const canRestartResolved = lastAttemptStatus?.kind === "cancelled" || lastAttemptStatus?.kind === "reviewed";

  return (
    <div className="kiosk">
      <div className="kiosk-brand">
        <Image src="/brand/logo_color.svg" alt="Agua ReNew" width={700} height={190} priority />
      </div>

      <div className="kiosk-card" data-phase={phase}>
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
            <form onSubmit={handleIdentify} style={{ display: "grid", gap: "0.7rem" }} data-testid="kiosk-identify-form">
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
                disabled={identifying}
                data-testid="kiosk-identifier"
                style={{ fontSize: "1rem", padding: "0.7rem 0.85rem" }}
              />
              {error && (
                <p className="alert alert-error" role="alert">
                  <Droplet size={15} style={{ marginTop: 2, flexShrink: 0 }} />
                  {error}
                </p>
              )}
              <button type="submit" className="btn btn-primary kiosk-btn" disabled={identifying} data-testid="kiosk-identify">
                {identifying ? <Spinner size={18} /> : <User size={18} />}
                {identifying ? "Verificando…" : "Identificarme"}
              </button>
              <button type="button" className="btn btn-outline kiosk-btn" onClick={startQrScan} disabled={identifying} data-testid="kiosk-scan-qr">
                Escanear QR con cámara trasera
              </button>
              {!qrSupported && (
                <p className="muted">El escaneo de QR no está disponible aquí. Use el recuadro AR:…</p>
              )}
            </form>
          </>
        )}

        {phase === "escaneando_qr" && (
          <>
            <p className="kiosk-date">Encuadre el código QR. Al leerlo se identificará automáticamente.</p>
            <video ref={qrVideoRef} className="kiosk-video" playsInline muted autoPlay />
            {error && (
              <p className="alert alert-error" role="alert">
                {error}
              </p>
            )}
            <button className="btn btn-outline kiosk-btn" type="button" onClick={reset} data-testid="kiosk-cancel-qr">
              Cancelar escaneo
            </button>
          </>
        )}

        {cameraOpen && info && (
          <>
            <div className="kiosk-employee">
              <div className="avatar-lg">{initials}</div>
              <div>
                <div className="name" data-testid="kiosk-employee-name">
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
            <button className="btn btn-outline btn-sm" onClick={reset} type="button" data-testid="kiosk-cancel-camera">
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
              <p className="alert alert-error" role="alert" data-testid="kiosk-incident-message">
                {error}
              </p>
            )}
            {attemptSubmitted && (
              <p className="muted" data-testid="kiosk-review-hint">
                Conserve este intento. Un fallo de consulta no demuestra que la marcación no se haya registrado.
              </p>
            )}
            {attemptNonce && (
              <p className="muted" data-testid="kiosk-attempt-nonce">
                Referencia para revisión: {attemptNonce}
              </p>
            )}
            {info && (
              <button
                className="btn btn-primary kiosk-btn"
                type="button"
                onClick={() => void consultAttempt()}
                disabled={consulting || sending}
                data-testid="kiosk-consult-attempt"
              >
                {consulting ? "Consultando…" : "Consultar este intento"}
              </button>
            )}
            {canComplete && info && (
              <button
                className="btn btn-primary kiosk-btn"
                type="button"
                onClick={() => void completeAttempt()}
                disabled={consulting || sending}
                data-testid="kiosk-complete-attempt"
              >
                Completar este intento
              </button>
            )}
            {lastPhoto && info && (
              <button
                className="btn btn-primary kiosk-btn"
                type="button"
                onClick={() => void resendSamePhoto()}
                disabled={consulting || sending}
                data-testid="kiosk-resend"
              >
                Reenviar la misma foto
              </button>
            )}
            {canResolveExpired && (
              <button
                className="btn btn-outline kiosk-btn"
                type="button"
                onClick={() => void resolveKioskAttempt("TOKEN_EXPIRED")}
                disabled={consulting || sending}
                data-testid="kiosk-resolve-attempt"
              >
                Cerrar intento vencido
              </button>
            )}
            {attemptSubmitted && !canRestartResolved && (
              <button
                className="btn btn-outline kiosk-btn"
                type="button"
                onClick={() => void resolveKioskAttempt("USER_CANCELLED")}
                disabled={consulting || sending}
                data-testid="kiosk-cancel-attempt"
              >
                Cerrar este intento
              </button>
            )}
            {canRestartResolved ? (
              <button className="btn btn-outline kiosk-btn" type="button" onClick={restartResolvedAttempt} data-testid="kiosk-restart-resolved">
                Volver al inicio
              </button>
            ) : (
              <button className="btn btn-outline kiosk-btn" type="button" onClick={() => void takeAnotherPhoto()} data-testid="kiosk-take-another">
                Tomar otra foto
              </button>
            )}
          </>
        )}

        {phase === "confirmado" && record && (
          <div className="kiosk-done">
            <div className={`big-icon ${(record.event_type ?? record.status) === "CHECK_IN" || record.status === "OPEN" ? "ok" : "blue"}`}>
              {(record.event_type ?? record.status) === "CHECK_IN" || record.status === "OPEN" ? <Droplet size={26} /> : <Check size={26} />}
            </div>
            <h2 data-testid="kiosk-confirmed-title">
              {(record.event_type ?? record.status) === "CHECK_IN" || record.status === "OPEN"
                ? "Entrada registrada"
                : "Salida registrada"}
            </h2>
            <p className="detail">
              {(record.event_type ?? record.status) === "CHECK_IN" || record.status === "OPEN"
                ? `Ingresaste a las ${formatTime(record.check_in_at)}.`
                : `Saliste a las ${formatTime(record.check_out_at)} · ${fmtMin(record.worked_minutes)} trabajadas.`}
            </p>
            <button className="btn btn-outline kiosk-btn" onClick={reset} data-testid="kiosk-new-marking">
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
