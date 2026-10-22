import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AsistenciaPage from "@/pages/AsistenciaPage";

/**
 * Regresiones de fiabilidad del kiosco público: foto pendiente, recuperación
 * acotada, mensajes honestos, pausa de la cuenta regresiva y GPS con reintento
 * transitorio. La cámara y la red son mocks deterministas; no hay backend real.
 */

const photoStoreState = vi.hoisted(() => ({
  photo: null as null | {
    v: 1;
    nonce: string;
    employeeId: string;
    action: "CHECK_IN" | "CHECK_OUT";
    imageBase64: string;
    storedAt: number;
    expiresAt: number;
  },
  saveResult: { ok: true } as { ok: true } | { ok: false; reason: string },
  loadCalls: 0,
  clearCalls: 0,
}));

vi.mock("@/lib/attendance-photo-store", () => ({
  purgeExpiredPendingPhotos: vi.fn().mockResolvedValue(undefined),
  PENDING_PHOTO_TTL_MS: 10 * 60_000,
  savePendingPhoto: vi.fn(async (photo: typeof photoStoreState.photo) => {
    if (photoStoreState.saveResult.ok) photoStoreState.photo = photo;
    return photoStoreState.saveResult;
  }),
  loadPendingPhoto: vi.fn(async (expected: { nonce: string; employeeId: string; action: string }, now: number) => {
    photoStoreState.loadCalls += 1;
    const photo = photoStoreState.photo;
    if (!photo) return null;
    const valid =
      photo.nonce === expected.nonce &&
      photo.employeeId === expected.employeeId &&
      photo.action === expected.action &&
      photo.expiresAt > now;
    if (!valid) {
      photoStoreState.photo = null;
      return null;
    }
    return photo;
  }),
  clearPendingPhoto: vi.fn(async (expected: { nonce: string; employeeId: string; action: string }) => {
    photoStoreState.clearCalls += 1;
    const photo = photoStoreState.photo;
    if (
      photo &&
      photo.nonce === expected.nonce &&
      photo.employeeId === expected.employeeId &&
      photo.action === expected.action
    ) {
      photoStoreState.photo = null;
    }
  }),
}));

type GeoSuccess = (position: {
  coords: { latitude: number; longitude: number; accuracy: number; altitude: null; altitudeAccuracy: null; heading: null; speed: null };
  timestamp: number;
}) => void;
type GeoError = (error: { code: number; message?: string }) => void;
type GeoCall = { success: GeoSuccess; error: GeoError; options?: PositionOptions };

let geolocationCalls: GeoCall[] = [];

function position(accuracy = 12.5) {
  return {
    coords: { latitude: -12.0464, longitude: -77.0428, accuracy, altitude: null, altitudeAccuracy: null, heading: null, speed: null },
    timestamp: 0,
  };
}

function installGeolocation(responder: (success: GeoSuccess, error: GeoError) => void) {
  geolocationCalls = [];
  const getCurrentPosition = vi.fn((success: GeoSuccess, error: GeoError, options?: PositionOptions) => {
    geolocationCalls.push({ success, error, options });
    responder(success, error);
  });
  Object.defineProperty(navigator, "geolocation", {
    configurable: true,
    value: { getCurrentPosition, watchPosition: vi.fn(() => 1), clearWatch: vi.fn() },
  });
  return { getCurrentPosition };
}

function installMediaDouble() {
  const track = { stop: vi.fn() };
  const stream = { getTracks: () => [track] } as unknown as MediaStream;
  const getUserMedia = vi.fn().mockResolvedValue(stream);
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/jpeg;base64,QUJD");
  let width = 640;
  let height = 480;
  Object.defineProperty(HTMLVideoElement.prototype, "videoWidth", { configurable: true, get: () => width });
  Object.defineProperty(HTMLVideoElement.prototype, "videoHeight", { configurable: true, get: () => height });
  return { getUserMedia, track, setFrame: (w: number, h: number) => { width = w; height = h; } };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function base64url(value: string): string {
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function markingToken(nonce: string, marker: string): string {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ nonce, sub: "emp-1", action: "CHECK_IN" }));
  return `${header}.${payload}.${marker}`;
}

function identifyResponse(token: string) {
  return {
    employee: { id: "emp-1", first_name: "Ana", last_name: "Prueba", job_role_name: "Operario", active: true },
    state: { has_open_entry: false, open_check_in_at: null, last_record: null },
    server_time: "2026-10-16T12:00:00+00:00",
    server_time_label: "ahora",
    marking_token: token,
    marking_action: "CHECK_IN",
  };
}

const PREPARED = {
  marking_token: markingToken("nonce-a", "refreshed"),
  marked_at: "2026-10-16T12:00:05+00:00",
  expires_at: "2026-10-16T12:05:05+00:00",
  location: { latitude: -12.0464, longitude: -77.0428, accuracy_m: 12.5, observed_at: "2026-10-16T12:00:00+00:00", address: null },
};

const CONFIRMED = {
  id: "rec-1",
  employee_id: "emp-1",
  work_date: "2026-10-16",
  check_in_at: "2026-10-16T12:00:05+00:00",
  check_out_at: null,
  worked_minutes: null,
  status: "OPEN",
  notes: null,
  created_at: "2026-10-16T12:00:05+00:00",
  updated_at: "2026-10-16T12:00:05+00:00",
  event_type: "CHECK_IN",
};

function storedAttemptToken(): string | null {
  const raw = window.sessionStorage.getItem("agua_renew_kiosk_open_attempt");
  if (!raw) return null;
  return (JSON.parse(raw) as { marking_token?: string }).marking_token ?? null;
}

function seedStoredAttempt(token: string) {
  window.sessionStorage.setItem(
    "agua_renew_kiosk_open_attempt",
    JSON.stringify({
      v: 2,
      marking_token: token,
      marking_action: "CHECK_IN",
      employee: { id: "emp-1", first_name: "Ana", last_name: "Prueba", job_role_name: "Operario", active: true },
      stage: "EVIDENCE_REQUESTED",
    }),
  );
}

function seedPhoto(overrides: Partial<NonNullable<typeof photoStoreState.photo>> = {}) {
  photoStoreState.photo = {
    v: 1,
    nonce: "nonce-a",
    employeeId: "emp-1",
    action: "CHECK_IN",
    imageBase64: "QUJD",
    storedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Unexpected network request")));
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined });
  Object.defineProperty(HTMLVideoElement.prototype, "videoWidth", { configurable: true, get: () => 0 });
  Object.defineProperty(HTMLVideoElement.prototype, "videoHeight", { configurable: true, get: () => 0 });
  installGeolocation((success) => success(position()));
  photoStoreState.photo = null;
  photoStoreState.saveResult = { ok: true };
  photoStoreState.loadCalls = 0;
  photoStoreState.clearCalls = 0;
  window.sessionStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
});

async function identifyAndCapture(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByTestId("kiosk-identifier"), "71112233");
  await user.click(screen.getByTestId("kiosk-identify"));
  await user.click(await screen.findByTestId("kiosk-capture-now"));
}

describe("foto y referencia del intento", () => {
  it("un 401 al consultar tras un envío fallido conserva foto y referencia", async () => {
    installMediaDouble();
    let statusUnauthorized = false;
    const checkIns: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/identify")) return jsonResponse(identifyResponse(markingToken("nonce-a", "identify")));
      if (url.includes("/attempt/prepare")) return jsonResponse(PREPARED);
      if (url.includes("/evidence")) return jsonResponse({ detail: "red" }, 500);
      if (url.includes("/attempt/status")) {
        if (statusUnauthorized) return jsonResponse({ detail: "no" }, 401);
        return jsonResponse({
          state: "PENDING",
          record: null,
          evidence_ready: false,
          write_token_valid: true,
          marking_token: markingToken("nonce-a", "recovery"),
        });
      }
      if (url.includes("/check-in")) {
        checkIns.push(url);
        return jsonResponse(CONFIRMED, 201);
      }
      return jsonResponse({ detail: "inesperado" }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<AsistenciaPage />);

    await identifyAndCapture(user);
    expect(await screen.findByTestId("kiosk-resend")).toBeInTheDocument();
    expect(photoStoreState.photo).not.toBeNull();
    expect(storedAttemptToken()).toBe(markingToken("nonce-a", "recovery"));

    statusUnauthorized = true;
    await user.click(screen.getByTestId("kiosk-resend"));

    const incident = await screen.findByTestId("kiosk-incident-message");
    expect(incident).toHaveTextContent(/No se pudo verificar este intento desde este equipo/i);
    expect(incident).toHaveTextContent(/Causa original del envío/i);
    expect(incident).not.toHaveTextContent(/registrad[ao] con éxito/i);
    expect(screen.getByTestId("kiosk-resend")).toBeInTheDocument();
    expect(photoStoreState.photo).not.toBeNull();
    expect(storedAttemptToken()).toBe(markingToken("nonce-a", "recovery"));
    expect(checkIns).toHaveLength(0);
  });

  it("reenviar adopta el token renovado del mismo nonce antes de preparar y subir", async () => {
    installMediaDouble();
    const renewed = markingToken("nonce-a", "renewed");
    const prepareTokens: string[] = [];
    const evidenceTokens: string[] = [];
    const checkInTokens: string[] = [];
    let statusCalls = 0;
    let evidenceCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? (JSON.parse(String(init.body)) as { marking_token?: string }) : null;
      if (url.includes("/identify")) return jsonResponse(identifyResponse(markingToken("nonce-a", "identify")));
      if (url.includes("/attempt/prepare")) {
        prepareTokens.push(String(body?.marking_token ?? ""));
        return jsonResponse({ ...PREPARED, marking_token: body?.marking_token });
      }
      if (url.includes("/evidence")) {
        evidenceTokens.push(String(body?.marking_token ?? ""));
        evidenceCalls += 1;
        return evidenceCalls === 1
          ? jsonResponse({ detail: "red" }, 500)
          : jsonResponse({ id: "ev-1", content_type: "image/jpeg" }, 201);
      }
      if (url.includes("/attempt/status")) {
        statusCalls += 1;
        return jsonResponse({
          state: "PENDING",
          record: null,
          evidence_ready: false,
          write_token_valid: true,
          marking_token: statusCalls === 1 ? markingToken("nonce-a", "recovery") : renewed,
        });
      }
      if (url.includes("/check-in")) {
        checkInTokens.push(String(body?.marking_token ?? ""));
        return jsonResponse(CONFIRMED, 201);
      }
      return jsonResponse({ detail: "inesperado" }, 404);
    }));
    const user = userEvent.setup();
    render(<AsistenciaPage />);

    await identifyAndCapture(user);
    await screen.findByTestId("kiosk-resend");
    await user.click(screen.getByTestId("kiosk-resend"));
    expect(await screen.findByTestId("kiosk-confirmed-title")).toHaveTextContent("Entrada registrada");

    expect(prepareTokens).toHaveLength(2);
    expect(prepareTokens[1]).toBe(renewed);
    expect(evidenceTokens[1]).toBe(renewed);
    expect(checkInTokens).toEqual([renewed]);
    // Confirmar limpia la referencia durable; el token renovado ya se usó.
    expect(storedAttemptToken()).toBeNull();
  });

  it("una recarga restaura la foto sólo con la misma referencia y no escribe", async () => {
    seedStoredAttempt(markingToken("nonce-a", "stored"));
    seedPhoto();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<AsistenciaPage />);

    expect(await screen.findByTestId("kiosk-resend")).toBeInTheDocument();
    expect(screen.getByTestId("kiosk-photo-notice")).toHaveTextContent(/Se recuperó la foto/i);
    expect(screen.getByTestId("kiosk-photo-notice")).toHaveTextContent(/No se envió nada automáticamente/i);
    expect(photoStoreState.loadCalls).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("no restaura una foto de otro empleado ni una copia vencida", async () => {
    seedStoredAttempt(markingToken("nonce-a", "stored"));
    seedPhoto({ employeeId: "emp-2" });
    render(<AsistenciaPage />);
    await waitFor(() => expect(photoStoreState.loadCalls).toBe(1));
    expect(screen.queryByTestId("kiosk-resend")).toBeNull();
    expect(photoStoreState.photo).toBeNull();

    photoStoreState.photo = null;
    seedPhoto({ expiresAt: Date.now() - 1 });
    const second = render(<AsistenciaPage />);
    await waitFor(() => expect(photoStoreState.loadCalls).toBe(2));
    expect(screen.queryByTestId("kiosk-resend")).toBeNull();
    second.unmount();
  });

  it("si el almacenamiento falla conserva la memoria y no bloquea el envío", async () => {
    installMediaDouble();
    photoStoreState.saveResult = { ok: false, reason: "unavailable" };
    const evidenceCalls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/identify")) return jsonResponse(identifyResponse(markingToken("nonce-a", "identify")));
      if (url.includes("/attempt/prepare")) return jsonResponse(PREPARED);
      if (url.includes("/evidence")) {
        evidenceCalls.push(url);
        return jsonResponse({ id: "ev-1", content_type: "image/jpeg" }, 201);
      }
      if (url.includes("/check-in")) return jsonResponse(CONFIRMED, 201);
      return jsonResponse({ detail: "inesperado" }, 404);
    }));
    const user = userEvent.setup();
    render(<AsistenciaPage />);

    await identifyAndCapture(user);
    expect(await screen.findByTestId("kiosk-confirmed-title")).toHaveTextContent("Entrada registrada");
    expect(evidenceCalls).toHaveLength(1);
    expect(photoStoreState.photo).toBeNull();
  });
});

describe("mensajes de identificación", () => {
  it("un identify fallido ofrece volver o reintentar, nunca tomar otra foto", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      jsonResponse({ detail: { code: "DEVICE_NOT_ENROLLED", message: "Equipo no habilitado" } }, 401),
    ));
    const user = userEvent.setup();
    render(<AsistenciaPage />);

    await user.type(screen.getByTestId("kiosk-identifier"), "71112233");
    await user.click(screen.getByTestId("kiosk-identify"));

    expect(await screen.findByTestId("kiosk-back-identify")).toBeInTheDocument();
    expect(screen.getByTestId("kiosk-retry-identify")).toBeInTheDocument();
    expect(screen.queryByTestId("kiosk-take-another")).toBeNull();
    const incident = screen.getByTestId("kiosk-incident-message");
    expect(incident).toHaveTextContent(/No se pudo verificar este intento desde este equipo/i);
    expect(incident).toHaveTextContent(/revise la marcación en el panel/i);
    expect(incident).not.toHaveTextContent(/Equipo no habilitado/i);
    await user.click(screen.getByTestId("kiosk-back-identify"));
    expect(await screen.findByTestId("kiosk-identifier")).toHaveValue("71112233");
  });
});

describe("cuenta regresiva y anuncios", () => {
  it("no captura al llegar a cero si visibilitychange sigue pendiente y permite reanudar", async () => {
    installMediaDouble();
    const writes: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/identify")) return jsonResponse(identifyResponse(markingToken("nonce-a", "identify")));
      if (url.includes("/attempt/prepare")) return jsonResponse(PREPARED);
      if (url.includes("/evidence")) {
        writes.push("photo");
        return jsonResponse({ id: "ev-1", content_type: "image/jpeg" }, 201);
      }
      if (url.includes("/check-in")) {
        writes.push("mark");
        return jsonResponse(CONFIRMED, 201);
      }
      return jsonResponse({ detail: "inesperado" }, 404);
    }));
    const user = userEvent.setup();
    render(<AsistenciaPage />);
    await user.type(screen.getByTestId("kiosk-identifier"), "71112233");
    await user.click(screen.getByTestId("kiosk-identify"));
    await screen.findByTestId("kiosk-countdown-toggle");
    // Instala el reloj antes de programar un nuevo tick, tras pausar/reanudar.
    fireEvent.click(screen.getByTestId("kiosk-countdown-toggle"));
    vi.useFakeTimers();
    fireEvent.click(screen.getByTestId("kiosk-countdown-toggle"));
    for (let tick = 0; tick < 9; tick += 1) {
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    }
    expect(document.querySelector(".kiosk-countdown")).toHaveTextContent("1 segundos");
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(document.querySelector(".kiosk-card")).toHaveAttribute("data-phase", "cuenta_regresiva");
    expect(writes).toEqual([]);
    expect(screen.getByTestId("kiosk-countdown-toggle")).toHaveAttribute("aria-pressed", "true");
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    fireEvent(document, new Event("visibilitychange"));
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(writes).toEqual([]);
    vi.useRealTimers();
    await user.click(screen.getByTestId("kiosk-capture-now"));
    expect(await screen.findByTestId("kiosk-confirmed-title")).toBeInTheDocument();
    expect(writes).toEqual(["photo", "mark"]);
  });

  it("pausa, pestaña oculta y reanudación conservan el tiempo; la captura manual funciona una vez", async () => {
    const media = installMediaDouble();
    const evidenceCalls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/identify")) return jsonResponse(identifyResponse(markingToken("nonce-a", "identify")));
      if (url.includes("/attempt/prepare")) return jsonResponse(PREPARED);
      if (url.includes("/evidence")) {
        evidenceCalls.push(url);
        return jsonResponse({ id: "ev-1", content_type: "image/jpeg" }, 201);
      }
      if (url.includes("/check-in")) return jsonResponse(CONFIRMED, 201);
      return jsonResponse({ detail: "inesperado" }, 404);
    }));
    const user = userEvent.setup();
    render(<AsistenciaPage />);

    await user.type(screen.getByTestId("kiosk-identifier"), "71112233");
    await user.click(screen.getByTestId("kiosk-identify"));
    const toggle = await screen.findByTestId("kiosk-countdown-toggle");
    const countdown = () => document.querySelector(".kiosk-countdown")?.textContent ?? "";

    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_150));
    });
    expect(countdown()).toContain("10");
    expect(evidenceCalls).toHaveLength(0);

    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    fireEvent(document, new Event("visibilitychange"));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_150));
    });
    expect(countdown()).toContain("10");

    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    fireEvent(document, new Event("visibilitychange"));
    await user.click(toggle);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_150));
    });
    expect(countdown()).toContain("9");

    await user.click(screen.getByTestId("kiosk-capture-now"));
    expect(await screen.findByTestId("kiosk-confirmed-title")).toHaveTextContent("Entrada registrada");
    expect(evidenceCalls).toHaveLength(1);
    expect(media.getUserMedia).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".sr-only")?.textContent).toContain("Marcación confirmada");
    await waitFor(() => expect(screen.getByTestId("kiosk-confirmed-title")).toHaveFocus());
  }, 20_000);
});

describe("GPS con reintento acotado", () => {
  it("una lectura imprecisa seguida de una precisa continúa sin abrir la alerta", async () => {
    installMediaDouble();
    let attempt = 0;
    const geolocation = installGeolocation((success) => {
      attempt += 1;
      success(position(attempt === 1 ? 51 : 49));
    });
    const identifyCalls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/identify")) {
        identifyCalls.push(url);
        return jsonResponse(identifyResponse(markingToken("nonce-a", "identify")));
      }
      return jsonResponse({ detail: "inesperado" }, 404);
    }));
    const user = userEvent.setup();
    render(<AsistenciaPage />);

    await user.type(screen.getByTestId("kiosk-identifier"), "71112233");
    await user.click(screen.getByTestId("kiosk-identify"));

    expect(await screen.findByTestId("kiosk-employee-name")).toHaveTextContent("Ana Prueba");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(geolocation.getCurrentPosition).toHaveBeenCalledTimes(2);
    expect(identifyCalls).toHaveLength(1);
  });
});

describe("cámara: causas distintas y cancelación", () => {
  it("distingue permiso denegado de equipo ausente sin inventar la causa", async () => {
    const getUserMedia = vi.fn().mockRejectedValue(new DOMException("denied", "NotAllowedError"));
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/identify")) return jsonResponse(identifyResponse(markingToken("nonce-a", "identify")));
      return jsonResponse({ detail: "inesperado" }, 404);
    }));
    const user = userEvent.setup();
    const first = render(<AsistenciaPage />);
    await user.type(screen.getByTestId("kiosk-identifier"), "71112233");
    await user.click(screen.getByTestId("kiosk-identify"));
    expect(await screen.findByTestId("kiosk-incident-message")).toHaveTextContent(/no permitió usar la cámara/i);
    first.unmount();

    getUserMedia.mockRejectedValue(new DOMException("missing", "NotFoundError"));
    render(<AsistenciaPage />);
    await user.type(screen.getByTestId("kiosk-identifier"), "71112233");
    await user.click(screen.getByTestId("kiosk-identify"));
    expect(await screen.findByTestId("kiosk-incident-message")).toHaveTextContent(/No se encontró una cámara/i);
  });

  it("cancelar durante la apertura detiene un stream que llega tarde", async () => {
    const track = { stop: vi.fn() };
    let resolveStream: ((stream: MediaStream) => void) | null = null;
    const getUserMedia = vi.fn(() => new Promise<MediaStream>((resolve) => {
      resolveStream = resolve;
    }));
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/identify")) return jsonResponse(identifyResponse(markingToken("nonce-a", "identify")));
      return jsonResponse({ detail: "inesperado" }, 404);
    }));
    const user = userEvent.setup();
    render(<AsistenciaPage />);

    await user.type(screen.getByTestId("kiosk-identifier"), "71112233");
    await user.click(screen.getByTestId("kiosk-identify"));
    await user.click(await screen.findByTestId("kiosk-cancel-camera"));
    expect(document.querySelector("[data-phase='identificando']")).not.toBeNull();

    await act(async () => {
      resolveStream?.({ getTracks: () => [track] } as unknown as MediaStream);
    });
    expect(track.stop).toHaveBeenCalled();
    expect(screen.queryByTestId("kiosk-incident-message")).toBeNull();
  });
});

describe("cámara con cuadro lento", () => {
  it("espera un cuadro útil más allá de 800 ms sin declarar incidencia", async () => {
    const media = installMediaDouble();
    media.setFrame(0, 0);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/identify")) return jsonResponse(identifyResponse(markingToken("nonce-a", "identify")));
      return jsonResponse({ detail: "inesperado" }, 404);
    }));
    const user = userEvent.setup();
    render(<AsistenciaPage />);

    await user.type(screen.getByTestId("kiosk-identifier"), "71112233");
    await user.click(screen.getByTestId("kiosk-identify"));
    await screen.findByTestId("kiosk-capture-now");

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_200));
    });
    media.setFrame(640, 480);
    expect(await screen.findByTestId("kiosk-countdown-toggle", {}, { timeout: 3_000 })).toBeInTheDocument();
    expect(screen.queryByTestId("kiosk-incident-message")).toBeNull();
  });
});
