
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { ApiError, attendanceApi, AttendanceRecordOut, IdentifyResponse, PreparationSnapshot } from "@/lib/api";
import {
  LOCATION_MAX_AGE_MS,
  locationAgeMs,
  locationFailureMessage,
  requestBrowserPosition,
  type ClientPosition,
  type LocationFailure,
} from "@/lib/attendance-location";
import AttendanceLocationDialog from "@/components/AttendanceLocationDialog";
import { Collapse } from "@/components/Collapse";
import { ArrowLeft, Camera, Check, ClipboardCheck, Clock, Droplet, Info } from "@/components/Icons";
import { Spinner } from "@/components/Loading";

type Phase =
  | "identificando"
  | "escaneando_qr"
  | "abriendo_camara"
  | "video_listo"
  | "cuenta_regresiva"
  | "capturando"
  | "enviando"
  | "confirmado"
  | "incidencia";

// Agrupa fases que comparten la misma superficie continua (la cámara no debe
// remontarse al pasar de abrir a listo, cuenta regresiva o capturando).
function phaseStage(phase: Phase): string {
  switch (phase) {
    case "abriendo_camara":
    case "video_listo":
    case "cuenta_regresiva":
    case "capturando":
      return "camera";
    default:
      return phase;
  }
}

type RecoverOutcome =
  | { kind: "confirmed"; record: AttendanceRecordOut }
  | {
      kind: "pending";
      evidenceReady: boolean;
      writeTokenValid: boolean;
      markingToken?: string;
      preparation?: PreparationSnapshot | null;
    }
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

type PrepareOutcome =
  | { ok: true; token: string }
  | { ok: false; reason: "location" | "untrusted_token" };

/** Referencia mínima del intento enviado. No guarda cookie del terminal ni fotografías. */
const KIOSK_ATTEMPT_KEY = "agua_renew_kiosk_open_attempt";
const CAMERA_COUNTDOWN_SECONDS = 10;

type DeliveryStage = "EVIDENCE_REQUESTED" | "PREPARED" | "EVIDENCE_STORED" | "MARKING_REQUESTED" | "UNKNOWN";

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

/**
 * Dos tokens son el mismo intento sólo si son la misma cadena opaca o si ambos
 * exponen el MISMO nonce JWT no vacío. La firma la valida el backend; el
 * navegador jamás acepta un reemplazo sin nonce.
 */
function hasSameNonce(candidate: string, currentToken: string): boolean {
  const candidateNonce = nonceFromMarkingToken(candidate);
  const currentNonce = nonceFromMarkingToken(currentToken);
  return Boolean(candidateNonce) && Boolean(currentNonce) && candidateNonce === currentNonce;
}

/**
 * Fail-closed: sólo se adopta un token renovado idéntico al vigente o con el
 * mismo nonce no vacío. Ausente, malformado o de otro intento nunca sustituye
 * al token actual.
 */
function trustRefreshedToken(candidate: unknown, currentToken: string): string | null {
  if (typeof candidate !== "string" || candidate === "") return null;
  if (candidate === currentToken) return currentToken;
  return hasSameNonce(candidate, currentToken) ? candidate : null;
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
      parsed.stage === "EVIDENCE_REQUESTED" || parsed.stage === "PREPARED" || parsed.stage === "EVIDENCE_STORED" || parsed.stage === "MARKING_REQUESTED"
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
  const [info, setInfo] = useState<IdentifyResponse | null>(null);
  const [record, setRecord] = useState<AttendanceRecordOut | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [countdown, setCountdown] = useState(CAMERA_COUNTDOWN_SECONDS);
  const [lastPhoto, setLastPhoto] = useState<string | null>(null);
  const [identifying, setIdentifying] = useState(false);
  const [consulting, setConsulting] = useState(false);
  const [sending, setSending] = useState(false);
  const [qrSupported, setQrSupported] = useState(true);
  const [now, setNow] = useState<Date>(() => new Date());
  const [serverOffset, setServerOffset] = useState(0);
  const [attemptSubmitted, setAttemptSubmitted] = useState(false);
  const [lastAttemptStatus, setLastAttemptStatus] = useState<RecoverOutcome | null>(null);
  const [idMode, setIdMode] = useState<"dni" | "code">("dni");
  // Teclado/lector de pantalla cambian de modo sin animación; el puntero sí la
  // conserva. La escritura que fuerza Código también es inmediata.
  const [idModeInstant, setIdModeInstant] = useState(true);
  const [copiedNonce, setCopiedNonce] = useState(false);
  const [requestingLocation, setRequestingLocation] = useState(false);
  const [locationFailure, setLocationFailure] = useState<LocationFailure | null>(null);
  const [locationDialogOpen, setLocationDialogOpen] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const qrVideoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const qrStreamRef = useRef<MediaStream | null>(null);
  const idInputRef = useRef<HTMLInputElement>(null);
  const incidentAlertRef = useRef<HTMLParagraphElement>(null);
  const captureLock = useRef(false);
  const identifyingRef = useRef(false);
  const sendingRef = useRef(false);
  const recoverLockRef = useRef(false);
  const generationRef = useRef(0);
  const infoRef = useRef<IdentifyResponse | null>(null);
  const submittedRef = useRef(false);
  const positionRef = useRef<ClientPosition | null>(null);
  const locationErrorMessage = useRef<string | null>(null);
  // Valor leído del QR que no pudo identificarse por falta de ubicación. Vive
  // sólo en memoria para Reintentar y se limpia al cancelar o editar el campo.
  const pendingIdentifierRef = useRef<string | null>(null);

  function reportLocationFailure(reason: LocationFailure) {
    locationErrorMessage.current = locationFailureMessage(reason);
    setLocationFailure(reason);
  }

  function clearLocationState() {
    positionRef.current = null;
    locationErrorMessage.current = null;
    pendingIdentifierRef.current = null;
    setLocationFailure(null);
    setLocationDialogOpen(false);
  }

  /**
   * Cierra la alerta sin reintentar. Conserva el DNI o código escrito, pero
   * descarta el valor temporal del QR y cualquier lectura en vuelo.
   */
  function closeLocationDialog() {
    setLocationDialogOpen(false);
    setLocationFailure(null);
    locationErrorMessage.current = null;
    pendingIdentifierRef.current = null;
    setPhase("identificando");
  }

  /**
   * Se invoca al iniciar cualquier cierre (Escape, Volver o backdrop). Invalida
   * la generación vigente para que una lectura lenta ya no pueda identificar.
   */
  function invalidateLocationAttempt() {
    bumpGeneration();
    identifyingRef.current = false;
    setIdentifying(false);
    setRequestingLocation(false);
  }

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
    if (phase === "incidencia") {
      const timer = window.setTimeout(() => {
        incidentAlertRef.current?.focus();
      }, 50);
      return () => window.clearTimeout(timer);
    }
  }, [phase]);

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
        setCountdown(CAMERA_COUNTDOWN_SECONDS);
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

  // El callback que consume el QR vive en un effect event: el escaneo usa
  // siempre la última versión confirmada de `identifyValue` sin que los
  // rerenders del reloj del kiosco reinicien `getUserMedia`.
  const identifyFromScan = useEffectEvent((value: string, gen: number) => identifyValue(value, gen));

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
              await identifyFromScan(value, gen);
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

  async function identifyValue(value: string, gen: number) {
    if (!value || identifyingRef.current) return;
    identifyingRef.current = true;
    setIdentifying(true);
    setError(null);
    setRequestingLocation(true);
    locationErrorMessage.current = null;
    pendingIdentifierRef.current = value;
    try {
      // La ubicación es requisito previo: si falla no hay API, cámara ni escritura.
      const position = await readPositionForOperation(gen, "identify");
      if (gen !== generationRef.current) return;
      if (!position) {
        // Si veníamos del escaneo QR, se vuelve al formulario; el valor leído
        // queda en memoria para que Reintentar no reabra la cámara del QR.
        setPhase((current) => (current === "escaneando_qr" ? "identificando" : current));
        return;
      }
      const result = await attendanceApi.identify(value);
      if (gen !== generationRef.current) return;
      infoRef.current = result;
      setInfo(result);
      setServerOffset(new Date(result.server_time).getTime() - Date.now());
      setLocationFailure(null);
      setLocationDialogOpen(false);
      pendingIdentifierRef.current = null;
      setIdentifier("");
      setLastPhoto(null);
      setLastAttemptStatus(null);
      captureLock.current = false;
      setPhase("abriendo_camara");
    } catch (err) {
      if (gen !== generationRef.current) return;
      setLocationFailure(null);
      setLocationDialogOpen(false);
      pendingIdentifierRef.current = null;
      setError(err instanceof ApiError ? err.message : "No se pudo conectar con el servidor");
      setPhase("incidencia");
    } finally {
      if (gen === generationRef.current) {
        identifyingRef.current = false;
        setIdentifying(false);
        setRequestingLocation(false);
      }
    }
  }

  async function handleIdentify(event: React.FormEvent) {
    event.preventDefault();
    if (identifyingRef.current) return;
    pendingIdentifierRef.current = identifier.trim();
    await identifyValue(identifier.trim(), generationRef.current);
  }

  /**
   * Un fallo previo a identificar abre la alerta accesible; el fallo posterior
   * a la foto conserva la recuperación inline existente del mismo intento.
   */
  async function readPositionForOperation(
    gen: number,
    surface: "identify" | "prepare" = "prepare",
  ): Promise<ClientPosition | null> {
    setRequestingLocation(true);
    locationErrorMessage.current = null;
    try {
      const outcome = await requestBrowserPosition();
      if (gen !== generationRef.current) return null;
      if (!outcome.ok) {
        positionRef.current = null;
        reportLocationFailure(outcome.reason);
        if (surface === "identify") setLocationDialogOpen(true);
        return null;
      }
      positionRef.current = outcome.position;
      if (surface === "identify") {
        setLocationFailure(null);
        setLocationDialogOpen(false);
      }
      return outcome.position;
    } finally {
      if (gen === generationRef.current) setRequestingLocation(false);
    }
  }

  /** Un único reintento explícito: reutiliza el flujo y sus locks. */
  function retryLocation() {
    if (identifyingRef.current) return;
    const value = pendingIdentifierRef.current ?? identifier.trim();
    if (!value) {
      closeLocationDialog();
      idInputRef.current?.focus();
      return;
    }
    void identifyValue(value, generationRef.current);
  }

  /**
   * Reutiliza la lectura si sigue vigente (<= 60 s) o pide una nueva. Fija la
   * hora oficial en el servidor y devuelve el token renovado del mismo intento.
   */
  async function prepareLocation(gen: number): Promise<PrepareOutcome> {
    const nowMs = () => performance.now();
    let position = positionRef.current;
    if (!position || locationAgeMs(position, nowMs()) > LOCATION_MAX_AGE_MS) {
      const freshlyRead = await readPositionForOperation(gen);
      if (gen !== generationRef.current) return { ok: false, reason: "location" };
      if (!freshlyRead) return { ok: false, reason: "location" };
      position = freshlyRead;
    }
    const ageMs = locationAgeMs(position, nowMs());
    if (ageMs > LOCATION_MAX_AGE_MS) {
      // Fallo posterior a la foto: conserva el mensaje inline del intento y no
      // abre la alerta previa a identificar.
      locationErrorMessage.current =
        "La ubicación quedó desactualizada. Vuelva a intentar la marcación para obtener una lectura nueva.";
      return { ok: false, reason: "location" };
    }
    const current = infoRef.current;
    if (!current) return { ok: false, reason: "untrusted_token" };
    const prepared = await attendanceApi.prepareAttempt(current.marking_token, {
      latitude: position.latitude,
      longitude: position.longitude,
      accuracy_m: position.accuracyM,
      age_ms: ageMs,
    });
    if (gen !== generationRef.current) return { ok: false, reason: "untrusted_token" };
    const refreshedToken = trustRefreshedToken(prepared.marking_token, current.marking_token);
    if (!refreshedToken) return { ok: false, reason: "untrusted_token" };
    const preparedInfo: IdentifyResponse = { ...current, marking_token: refreshedToken };
    infoRef.current = preparedInfo;
    setInfo(preparedInfo);
    return { ok: true, token: refreshedToken };
  }

  /** Adopta el token acotado que la recuperación expone para el mismo nonce. */
  function adoptRefreshedToken(token: string) {
    const current = infoRef.current;
    if (!current || current.marking_token === token) return;
    if (!hasSameNonce(token, current.marking_token)) return;
    const updated: IdentifyResponse = { ...current, marking_token: token };
    infoRef.current = updated;
    setInfo(updated);
    persistAttempt(updated, readStoredAttempt()?.stage ?? "UNKNOWN");
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
          markingToken: typeof frozen.marking_token === "string" ? frozen.marking_token : undefined,
          preparation: frozen.preparation ?? null,
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
      if (outcome.markingToken) adoptRefreshedToken(outcome.markingToken);
      showUncertain(
        outcome.evidenceReady
          ? "El intento sigue pendiente. Si la foto ya está guardada, complete la marcación sin tomar otra."
          : outcome.preparation?.marked_at
            ? "El intento sigue pendiente sin foto guardada. La ubicación y la hora oficial ya quedaron reservadas, pero la marcación aún no se registró."
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
    let activeToken = markingToken;
    try {
      const prepared = await prepareLocation(gen);
      if (gen !== generationRef.current) return;
      if (!prepared.ok) {
        // Fail-closed: sin lectura válida o con un token no verificable no se
        // sube la foto ni se marca; la referencia del intento original queda
        // intacta para reconciliarla.
        showUncertain(
          prepared.reason === "untrusted_token"
            ? "El servidor no confirmó una preparación verificable para este intento. No se subió la fotografía ni se registró la marcación. Consulte este mismo intento."
            : locationErrorMessage.current ??
              "No se pudo confirmar la ubicación del equipo. No se subió la fotografía ni se registró la marcación.",
        );
        return;
      }
      activeToken = prepared.token;
      const preparedInfo = infoRef.current;
      // El token renovado y la etapa se guardan ANTES de subir la fotografía.
      if (!preparedInfo || !persistAttempt(preparedInfo, "PREPARED")) {
        setLastAttemptStatus({ kind: "pending", evidenceReady: false, writeTokenValid: true });
        showUncertain(
          "La hora oficial quedó reservada, pero no se pudo guardar la referencia. No se envió la fotografía ni la marcación.",
        );
        return;
      }
      await attendanceApi.captureEvidence(activeToken, imageBase64);
      if (gen !== generationRef.current) return;
      persistAttempt(preparedInfo, "EVIDENCE_STORED");
      if (!persistAttempt(preparedInfo, "MARKING_REQUESTED")) {
        setLastAttemptStatus({ kind: "pending", evidenceReady: true, writeTokenValid: true });
        showUncertain("La foto se guardó. Consulte o complete este intento. No se envió la marcación.");
        return;
      }
      const result =
        markingAction === "CHECK_OUT"
          ? await attendanceApi.checkOut(activeToken)
          : await attendanceApi.checkIn(activeToken);
      if (gen !== generationRef.current) return;
      showConfirmed(result);
    } catch {
      if (gen !== generationRef.current) return;
      const recovered = await recoverAttempt(activeToken, gen);
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

  function captureNow() {
    if ((phase !== "video_listo" && phase !== "cuenta_regresiva") || !infoRef.current || captureLock.current) return;
    setPhase("capturando");
  }

  useEffect(() => {
    if (phase !== "capturando") return;
    void captureAndMark();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  function isSameAttempt(token: string): boolean {
    const activeToken = infoRef.current?.marking_token;
    if (!activeToken) return false;
    if (activeToken === token) return true;
    return hasSameNonce(activeToken, token);
  }

  async function consultAttempt() {
    const current = infoRef.current;
    if (!current || sendingRef.current || recoverLockRef.current) return;
    const gen = generationRef.current;
    const token = current.marking_token;
    recoverLockRef.current = true;
    setConsulting(true);
    const isCurrent = () => gen === generationRef.current && isSameAttempt(token);
    try {
      const outcome = await recoverAttempt(token, gen);
      if (!isCurrent() || outcome.kind === "stale") return;
      applyReadOnlyAttemptOutcome(outcome);
    } finally {
      if (gen === generationRef.current) {
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
    const isCurrent = () => gen === generationRef.current && isSameAttempt(current.marking_token);
    try {
      const recovered = await recoverAttempt(current.marking_token, gen);
      if (!isCurrent() || recovered.kind === "stale") return;
      if (recovered.kind !== "pending" || !recovered.writeTokenValid) {
        applyReadOnlyAttemptOutcome(recovered);
        return;
      }
      const active = infoRef.current;
      if (!active || !lastPhoto) {
        applyReadOnlyAttemptOutcome(recovered);
        return;
      }
      recoverLockRef.current = false;
      await sendPhoto(lastPhoto, active.marking_token, active.marking_action, gen);
    } finally {
      if (gen === generationRef.current) recoverLockRef.current = false;
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
    clearLocationState();
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
    clearLocationState();
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
    clearLocationState();
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
    setCopiedNonce(false);
  }

  async function copyNonceToClipboard() {
    if (!attemptNonce) return;
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(attemptNonce);
      } else if (typeof document !== "undefined") {
        const textArea = document.createElement("textarea");
        textArea.value = attemptNonce;
        textArea.style.position = "fixed";
        textArea.style.opacity = "0";
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand("copy");
        document.body.removeChild(textArea);
      }
      setCopiedNonce(true);
      window.setTimeout(() => setCopiedNonce(false), 2000);
    } catch {
      // Ignorar restricciones de portapapeles
    }
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

  // Teclado táctil del modo DNI: sólo dígitos, máximo 8 posiciones. El input
  // real sigue siendo el control autoritativo (tests y lectores de pantalla).
  function appendDigit(digit: string) {
    pendingIdentifierRef.current = null;
    setIdentifier((value) => {
      const digits = value.replace(/\D/g, "");
      if (digits.length >= 8) return value;
      return digits + digit;
    });
    idInputRef.current?.focus();
  }

  function backspaceDigit() {
    pendingIdentifierRef.current = null;
    setIdentifier((value) => value.slice(0, -1));
    idInputRef.current?.focus();
  }

  function clearIdentifier() {
    pendingIdentifierRef.current = null;
    setIdentifier("");
    idInputRef.current?.focus();
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
        <img src="/brand/logo_color.svg" alt="Agua ReNew" width={700} height={190} />
      </div>

      <div className="kiosk-card" data-phase={phase}>
        <span className="kiosk-card-accent" aria-hidden />
        <div className="kiosk-phase-body" key={phaseStage(phase)}>
        {phase === "identificando" && (
          <>
            <div className="kiosk-clock" suppressHydrationWarning>
              {timeLabel}
            </div>
            <div className="kiosk-date" suppressHydrationWarning>
              {dateLabel}
            </div>
            <form onSubmit={handleIdentify} className="kiosk-form" data-testid="kiosk-identify-form">
              <div className="kiosk-id-mode-group" role="tablist" aria-label="Modo de ingreso">
                <button
                  type="button"
                  role="tab"
                  aria-selected={idMode === "dni"}
                  className={`kiosk-mode-tab${idMode === "dni" ? " is-active" : ""}`}
                  onClick={(event) => {
                    setIdModeInstant(event.detail <= 0);
                    setIdMode("dni");
                    idInputRef.current?.focus();
                  }}
                >
                  DNI (números)
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={idMode === "code"}
                  className={`kiosk-mode-tab${idMode === "code" ? " is-active" : ""}`}
                  onClick={(event) => {
                    setIdModeInstant(event.detail <= 0);
                    setIdMode("code");
                    idInputRef.current?.focus();
                  }}
                >
                  Código / AR: (texto)
                </button>
              </div>

              <label className="label kiosk-id-label" htmlFor="kiosk-id">
                {idMode === "dni" ? "Número de DNI (8 dígitos)" : "Código de trabajador o QR"}
              </label>

              <div className="kiosk-id-cluster">
                <div className={`kiosk-id-field${idMode === "dni" ? " is-dni" : ""}`}>
                  {/* El campo real es siempre este input; el display segmentado
                      sólo refleja su valor y se desvanece al escribir un código. */}
                  <div className="kiosk-dni-display" aria-hidden>
                    {Array.from({ length: 8 }).map((_, index) => {
                      const digit = identifier[index] ?? "";
                      const active = index === Math.min(identifier.length, 7);
                      return (
                        <span
                          key={index}
                          className={`kiosk-dni-cell${digit ? " is-filled" : ""}${active && !digit ? " is-active" : ""}`}
                        >
                          {digit}
                        </span>
                      );
                    })}
                  </div>
                  {/* El DNI usa el teclado propio sin bloquear la escritura con teclado físico. */}
                  <input
                    ref={idInputRef}
                    id="kiosk-id"
                    className={`kiosk-id-input${idMode === "dni" ? " is-dni" : " input"}`}
                    type="text"
                    inputMode={idMode === "dni" ? "none" : "text"}
                    enterKeyHint="go"
                    autoCapitalize="characters"
                    autoCorrect="off"
                    spellCheck={false}
                    value={identifier}
                    onChange={(e) => {
                      const val = e.target.value;
                      pendingIdentifierRef.current = null;
                      setIdentifier(val);
                    if (/[^0-9\s]/.test(val) && idMode === "dni") {
                      setIdModeInstant(true);
                      setIdMode("code");
                    }
                    }}
                    placeholder={idMode === "dni" ? "Ej. 71112233" : "Ej. EMP-002 o AR:…"}
                    autoFocus
                    autoComplete="off"
                    disabled={identifying}
                    data-testid="kiosk-identifier"
                  />
                </div>

                <Collapse
                  open={idMode === "dni"}
                  duration={idModeInstant ? 0 : undefined}
                  className="kiosk-keypad-slot"
                >
                  <div className="kiosk-keypad" role="group" aria-label="Teclado numérico">
                    {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((digit) => (
                      <button key={digit} type="button" className="kiosk-key" onClick={() => appendDigit(digit)}>
                        {digit}
                      </button>
                    ))}
                    <button type="button" className="kiosk-key kiosk-key--muted" onClick={clearIdentifier} aria-label="Limpiar DNI">
                      C
                    </button>
                    <button type="button" className="kiosk-key" onClick={() => appendDigit("0")}>
                      0
                    </button>
                    <button type="button" className="kiosk-key kiosk-key--muted" onClick={backspaceDigit} aria-label="Borrar último dígito">
                      <ArrowLeft size={18} />
                    </button>
                  </div>
                </Collapse>
              </div>

              {requestingLocation && !locationDialogOpen && (
                <p className="alert alert-notice" role="status" data-testid="kiosk-location-status">
                  <Info size={15} />
                  <span>Solicitando la ubicación del equipo para marcar asistencia…</span>
                </p>
              )}

              {error && (
                <p className="alert alert-error" role="alert">
                  <Droplet size={15} />
                  <span>{error}</span>
                </p>
              )}

              <button type="submit" className="btn kiosk-cta kiosk-btn" disabled={identifying} data-testid="kiosk-identify">
                {identifying ? <Spinner size={18} /> : <ClipboardCheck size={18} />}
                {requestingLocation ? "Solicitando ubicación…" : identifying ? "Verificando…" : "Identificar asistencia"}
              </button>
              <button
                type="button"
                className="btn btn-outline kiosk-btn kiosk-qr-btn"
                onClick={startQrScan}
                disabled={identifying || !qrSupported}
                data-testid="kiosk-scan-qr"
              >
                <Camera size={18} />
                Escanear QR
              </button>
              {!qrSupported && (
                <div className="alert alert-notice kiosk-qr-notice" role="status">
                  <Info size={16} />
                  <span>El escaneo de QR no está disponible en este dispositivo. Use el teclado arriba.</span>
                </div>
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
          <div className="kiosk-camera-view">
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
            {phase === "cuenta_regresiva" && (
              <p className="kiosk-countdown" role="status" aria-live="polite" aria-label="Cuenta regresiva activa. Puede tomar la foto ahora.">
                Acomódate frente a la cámara… <span aria-hidden>{countdown}</span> segundos
              </p>
            )}
            {phase === "abriendo_camara" && <p className="muted">Abriendo cámara…</p>}
            <div className="kiosk-camera-actions">
              {(phase === "video_listo" || phase === "cuenta_regresiva") && (
                <button className="btn btn-primary kiosk-btn" type="button" onClick={captureNow} disabled={captureLock.current} data-testid="kiosk-capture-now">
                  {info.marking_action === "CHECK_OUT" ? "Registrar ahora" : "Tomar foto ahora"}
                </button>
              )}
              <button className="btn btn-outline kiosk-btn" onClick={reset} type="button" data-testid="kiosk-cancel-camera">
                Cancelar
              </button>
            </div>
          </div>
        )}

        {phase === "enviando" && (
          <p className="kiosk-date">
            <Spinner size={18} /> Enviando marcación…
          </p>
        )}

        {phase === "incidencia" && (
          <div className="kiosk-incident-view">
            {error && (
              <p
                ref={incidentAlertRef}
                tabIndex={-1}
                className="alert alert-error kiosk-incident-alert"
                role="alert"
                data-testid="kiosk-incident-message"
              >
                <Droplet size={15} />
                <span>{error}</span>
              </p>
            )}
            {attemptSubmitted && (
              <p className="muted" data-testid="kiosk-review-hint">
                Conserve este intento. Un fallo de consulta no demuestra que la marcación no se haya registrado.
              </p>
            )}
            {attemptNonce && (
              <div className="kiosk-nonce-row">
                <p className="muted kiosk-nonce-text" data-testid="kiosk-attempt-nonce">
                  Referencia para revisión: <code className="kiosk-nonce-code">{attemptNonce}</code>
                </p>
                <button
                  type="button"
                  className="btn btn-outline btn-sm kiosk-nonce-copy-btn"
                  onClick={() => void copyNonceToClipboard()}
                  title="Copiar referencia al portapapeles"
                  aria-label="Copiar código de referencia"
                >
                  {copiedNonce ? <Check size={14} /> : <ClipboardCheck size={14} />}
                  <span>{copiedNonce ? "Copiado" : "Copiar código"}</span>
                </button>
              </div>
            )}
            <div className="kiosk-incident-actions">
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
            </div>
          </div>
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
            {info && <p className="kiosk-confirmed-employee" data-testid="kiosk-confirmed-employee">{info.employee.first_name} {info.employee.last_name}</p>}
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

      {locationDialogOpen && locationFailure && (
        <AttendanceLocationDialog
          failure={locationFailure}
          busy={identifying || requestingLocation}
          onRetry={retryLocation}
          onClose={closeLocationDialog}
          onCloseRequest={invalidateLocationAttempt}
        />
      )}
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
