import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AsistenciaPage from "@/pages/AsistenciaPage";

type GeoSuccess = (position: {
  coords: { latitude: number; longitude: number; accuracy: number; altitude: number | null; altitudeAccuracy: number | null; heading: number | null; speed: number | null };
  timestamp: number;
}) => void;
type GeoError = (error: { code: number; message?: string }) => void;
type GeoCall = { success: GeoSuccess; error: GeoError; options?: PositionOptions };

let geolocationCalls: GeoCall[] = [];
let monotonicOffset = 0;
const realMonotonicNow = performance.now.bind(performance);

function successPosition(latitude = -12.0464, longitude = -77.0428, accuracy = 12.5) {
  return {
    coords: { latitude, longitude, accuracy, altitude: null, altitudeAccuracy: null, heading: null, speed: null },
    timestamp: 0,
  };
}

function installGeolocation(
  responder: (success: GeoSuccess, error: GeoError, options?: PositionOptions) => void,
) {
  geolocationCalls = [];
  const getCurrentPosition = vi.fn((success: GeoSuccess, error: GeoError, options?: PositionOptions) => {
    geolocationCalls.push({ success, error, options });
    responder(success, error, options);
  });
  Object.defineProperty(navigator, "geolocation", {
    configurable: true,
    value: { getCurrentPosition, watchPosition: vi.fn(() => 1), clearWatch: vi.fn() },
  });
  return { getCurrentPosition };
}

function resetMediaDouble() {
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined });
  Object.defineProperty(HTMLVideoElement.prototype, "videoWidth", { configurable: true, get: () => 0 });
  Object.defineProperty(HTMLVideoElement.prototype, "videoHeight", { configurable: true, get: () => 0 });
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
  return { getUserMedia, setFrame: (w: number, h: number) => { width = w; height = h; } };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(normalizeTokens(body)), { status, headers: { "Content-Type": "application/json" } });
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

function base64url(value: string): string {
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Token de marcación con forma JWT: el navegador sólo compara el nonce, la
 * firma sigue siendo autoridad del backend.
 */
function markingToken(nonce: string, marker: string): string {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ nonce, sub: "emp-1", action: "CHECK_IN" }));
  return `${header}.${payload}.${marker}-signature`;
}

function tokenNonce(token: string | null): string | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const padded = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = atob(padded.padEnd(padded.length + ((4 - (padded.length % 4)) % 4), "="));
    return (JSON.parse(json) as { nonce?: string }).nonce ?? null;
  } catch {
    return null;
  }
}

/**
 * Fixtures de los mocks con forma JWT real: el navegador sólo compara el nonce
 * y la firma sigue siendo autoridad del backend. `tok-other` representa un
 * reemplazo de otro intento y los valores desconocidos quedan malformados.
 */
const TOKEN_FIXTURES: Record<string, string> = {
  "tok-ana": markingToken("nonce-a", "identify"),
  "tok-prepared": markingToken("nonce-a", "refreshed"),
  "tok-recovery": markingToken("nonce-a", "recovery"),
  "tok-other": markingToken("nonce-b", "other"),
};

function jwt(value: string): string {
  return TOKEN_FIXTURES[value] ?? value;
}

function normalizeTokens(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeTokens);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        key === "marking_token" && typeof entry === "string" ? jwt(entry) : normalizeTokens(entry),
      ]),
    );
  }
  return value;
}

const MARKED_AT = "2026-10-16T12:00:05+00:00";
const EXPIRES_AT = "2026-10-16T12:05:05+00:00";
const PREPARED_LOCATION = {
  latitude: -12.0464,
  longitude: -77.0428,
  accuracy_m: 12.5,
  observed_at: "2026-10-16T12:00:00+00:00",
  address: "Av. Siempre Viva 742, Lima",
};

const CONFIRMED_RECORD = {
  id: "rec-1",
  employee_id: "emp-1",
  work_date: "2026-10-16",
  check_in_at: MARKED_AT,
  check_out_at: null,
  worked_minutes: null,
  status: "OPEN",
  notes: null,
  created_at: MARKED_AT,
  updated_at: MARKED_AT,
  event_type: "CHECK_IN",
};

function storedAttemptToken(): string | null {
  try {
    const raw = window.sessionStorage.getItem("agua_renew_kiosk_open_attempt");
    if (!raw) return null;
    return (JSON.parse(raw) as { marking_token?: string }).marking_token ?? null;
  } catch {
    return null;
  }
}

function installQrMediaDouble() {
  const streams: Array<{ stream: MediaStream; trackStop: ReturnType<typeof vi.fn> }> = [];
  const constraints: Array<MediaStreamConstraints | undefined> = [];
  const getUserMedia = vi.fn(async (requested?: MediaStreamConstraints) => {
    constraints.push(requested);
    const trackStop = vi.fn();
    const stream = { getTracks: () => [{ stop: trackStop }] } as unknown as MediaStream;
    streams.push({ stream, trackStop });
    return stream;
  });
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  return { getUserMedia, streams, constraints };
}

/** Lector QR falso: los cuadros los decide la prueba, no el tiempo real. */
function installBarcodeDetector() {
  let payload: string[] = [];
  const detectorMock = vi.fn(async () => payload.map((rawValue) => ({ rawValue })));
  class Detector {
    static formats: string[] = [];
    constructor(options: { formats: string[] }) {
      Detector.formats = options.formats;
    }
    detect = detectorMock;
  }
  Object.defineProperty(window, "BarcodeDetector", { configurable: true, value: Detector });
  return {
    detect: detectorMock,
    formats: () => Detector.formats,
    setPayload: (values: string[]) => {
      payload = values;
    },
  };
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Unexpected network request")));
  monotonicOffset = 0;
  resetMediaDouble();
  // Lectura puntual por defecto: cualquier prueba puede reemplazarla.
  installGeolocation((success) => success(successPosition()));
  vi.spyOn(performance, "now").mockImplementation(() => realMonotonicNow() + monotonicOffset);
});

afterEach(() => {
  vi.restoreAllMocks();
  resetMediaDouble();
  delete (window as unknown as { BarcodeDetector?: unknown }).BarcodeDetector;
});

describe("kiosk identifier keyboard", () => {
  it("suppresses the native keyboard hint while using the DNI keypad", () => {
    render(<AsistenciaPage />);
    const input = screen.getByTestId("kiosk-identifier");
    const keypad = screen.getByRole("group", { name: "Teclado numérico" });

    expect(input).toHaveFocus();
    expect(input).toHaveAttribute("inputmode", "none");
    fireEvent.click(within(keypad).getByRole("button", { name: "1" }));
    expect(input).toHaveValue("1");
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute("inputmode", "none");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("preserves keypad editing, the eight-digit limit and physical keyboard input", async () => {
    const user = userEvent.setup();
    render(<AsistenciaPage />);
    const input = screen.getByTestId("kiosk-identifier");
    const keypad = screen.getByRole("group", { name: "Teclado numérico" });

    for (const digit of "12345678") {
      await user.click(within(keypad).getByRole("button", { name: digit }));
    }
    expect(input).toHaveValue("12345678");
    await user.click(within(keypad).getByRole("button", { name: "9" }));
    expect(input).toHaveValue("12345678");
    await user.click(screen.getByRole("button", { name: "Borrar último dígito" }));
    expect(input).toHaveValue("1234567");
    await user.click(within(keypad).getByRole("button", { name: "0" }));
    expect(input).toHaveValue("12345670");
    await user.click(screen.getByRole("button", { name: "Limpiar DNI" }));
    expect(input).toHaveValue("");
    expect(input).toHaveFocus();
    expect(input).toHaveProperty("readOnly", false);
    await user.keyboard("87654321");
    expect(input).toHaveValue("87654321");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("cambia de DNI a Código por teclado sin retener el teclado numérico", async () => {
    const user = userEvent.setup();
    render(<AsistenciaPage />);

    // Grupo de botones con aria-pressed: no simula un tablist incompleto.
    const codeButton = screen.getByRole("button", { name: /código/i });
    expect(screen.getByRole("group", { name: "Modo de ingreso" })).toBeInTheDocument();
    expect(screen.queryByRole("tablist")).toBeNull();
    codeButton.focus();
    await user.keyboard("{Enter}");

    expect(codeButton).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("kiosk-identifier")).toHaveAttribute("inputmode", "text");
    expect(document.querySelector(".kiosk-keypad")).toBeNull();
    expect(screen.getByTestId("kiosk-identify")).not.toBeDisabled();
  });

  it("keeps the native text keyboard for worker codes and restores DNI mode", async () => {
    const user = userEvent.setup();
    render(<AsistenciaPage />);
    const input = screen.getByTestId("kiosk-identifier");

    await user.click(screen.getByRole("button", { name: "Código / AR: (texto)" }));
    expect(input).toHaveAttribute("inputmode", "text");
    expect(screen.queryByRole("group", { name: "Teclado numérico" })).not.toBeInTheDocument();
    await user.type(input, "EMP-002");
    expect(input).toHaveValue("EMP-002");
    await user.click(screen.getByRole("button", { name: "DNI (números)" }));
    expect(input).toHaveAttribute("inputmode", "none");
    expect(screen.getByRole("group", { name: "Teclado numérico" })).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("kiosk sin autorización de dispositivos", () => {
  it("no muestra ningún control de emparejamiento en la identificación", () => {
    render(<AsistenciaPage />);

    expect(document.querySelector("[data-phase='identificando']")).not.toBeNull();
    expect(screen.queryByLabelText("Código de emparejamiento")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /emparejar/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/emparejamiento/i)).not.toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("un 401 al identificar entra en incidencia y no pide código de emparejamiento", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ detail: { code: "DEVICE_NOT_ENROLLED", message: "Equipo no habilitado" } }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<AsistenciaPage />);

    await user.type(screen.getByTestId("kiosk-identifier"), "71112233");
    await user.click(screen.getByTestId("kiosk-identify"));

    expect(await screen.findByTestId("kiosk-incident-message")).toBeInTheDocument();
    expect(document.querySelector("[data-phase='incidencia']")).not.toBeNull();
    expect(screen.queryByLabelText("Código de emparejamiento")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /emparejar/i })).not.toBeInTheDocument();
    const paths = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(paths).toHaveLength(1);
    expect(paths[0]).toContain("/api/v1/attendance/identify");
    expect(paths.some((path) => path.includes("pair"))).toBe(false);
  });
});

describe("kiosco ubicación obligatoria antes de identificar", () => {
  it("pide una lectura reciente de alta precisión y avanza a la identificación", async () => {
    installMediaDouble();
    const geolocation = installGeolocation((success) => success(successPosition()));
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(identifyResponse("tok-ana")));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<AsistenciaPage />);

    await user.type(screen.getByTestId("kiosk-identifier"), "71112233");
    await user.click(screen.getByTestId("kiosk-identify"));

    expect(await screen.findByTestId("kiosk-employee-name")).toHaveTextContent("Ana Prueba");
    expect(geolocation.getCurrentPosition).toHaveBeenCalledTimes(1);
    // El presupuesto total es 20 s; cada intento usa un plazo acotado menor.
    expect(geolocationCalls[0].options).toMatchObject({ enableHighAccuracy: true, maximumAge: 0 });
    expect(geolocationCalls[0].options?.timeout).toBeGreaterThan(0);
    expect(geolocationCalls[0].options?.timeout).toBeLessThanOrEqual(20000);
    const paths = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(paths).toHaveLength(1);
    expect(paths[0]).toContain("/api/v1/attendance/identify");
  });

  it("una ubicación denegada abre una alerta accesible, no llama al API y preserva el DNI", async () => {
    const geolocation = installGeolocation((_success, error) => error({ code: 1, message: "denied" }));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<AsistenciaPage />);

    const input = screen.getByTestId("kiosk-identifier");
    await user.type(input, "71112233");
    await user.click(screen.getByTestId("kiosk-identify"));

    const dialog = await screen.findByRole("alertdialog", { name: "Activa la ubicación para continuar" });
    expect(dialog).toHaveAttribute("aria-describedby", "kiosk-location-dialog-description");
    expect(dialog).toHaveTextContent(/permiso de ubicación/i);
    expect(dialog).toHaveTextContent(/supervisor/i);
    expect(screen.getByTestId("kiosk-location-dialog-description")).toHaveTextContent(/dirección/i);
    // No se duplica el anuncio: la alerta vive sólo en el alertdialog.
    expect(screen.queryByTestId("kiosk-location-error")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(input).toHaveValue("71112233");
    await waitFor(() => expect(screen.getByTestId("kiosk-location-back")).toHaveFocus());
    expect(screen.getByTestId("kiosk-location-dialog-title")).not.toHaveFocus();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId("kiosk-capture-now")).toBeNull();
    expect(screen.queryByTestId("kiosk-employee-name")).toBeNull();
    expect(document.querySelector("[data-phase='incidencia']")).toBeNull();

    await user.click(screen.getByTestId("kiosk-location-retry"));
    await waitFor(() => expect(geolocation.getCurrentPosition).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("alertdialog", { name: "Activa la ubicación para continuar" })).toBeInTheDocument();
    expect(input).toHaveValue("71112233");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("un reintento con ubicación válida continúa una sola vez y cierra la alerta", async () => {
    installMediaDouble();
    let attempt = 0;
    const geolocation = installGeolocation((success, error) => {
      attempt += 1;
      if (attempt === 1) error({ code: 1, message: "denied" });
      else success(successPosition());
    });
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(identifyResponse("tok-ana")));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<AsistenciaPage />);

    await user.type(screen.getByTestId("kiosk-identifier"), "71112233");
    await user.click(screen.getByTestId("kiosk-identify"));
    await screen.findByRole("alertdialog", { name: "Activa la ubicación para continuar" });

    await user.click(screen.getByTestId("kiosk-location-retry"));

    expect(await screen.findByTestId("kiosk-employee-name")).toHaveTextContent("Ana Prueba");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(geolocation.getCurrentPosition).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.filter((call) => String(call[0]).includes("/identify"))).toHaveLength(1);
  });

  it("conserva el foco dentro de la alerta durante la lectura y Volver cancela", async () => {
    const media = installMediaDouble();
    const gate: { success?: GeoSuccess } = {};
    let attempt = 0;
    const geolocation = installGeolocation((success, error) => {
      attempt += 1;
      if (attempt === 1) error({ code: 1, message: "denied" });
      else gate.success = success;
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<AsistenciaPage />);

    await user.type(screen.getByTestId("kiosk-identifier"), "71112233");
    await user.click(screen.getByTestId("kiosk-identify"));
    const dialog = await screen.findByRole("alertdialog", { name: "Activa la ubicación para continuar" });

    // Esperar el foco inicial programado por AppDialog antes de interactuar.
    await waitFor(() => expect(screen.getByTestId("kiosk-location-back")).toHaveFocus());
    await user.click(screen.getByTestId("kiosk-location-retry"));
    const retry = screen.getByTestId("kiosk-location-retry");
    await waitFor(() => expect(retry).toHaveAttribute("aria-disabled", "true"));
    expect(retry).toHaveTextContent(/comprobando/i);
    expect(retry).toHaveFocus();
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    fireEvent.click(retry);
    expect(geolocation.getCurrentPosition).toHaveBeenCalledTimes(2);

    await user.click(screen.getByTestId("kiosk-location-back"));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(media.getUserMedia).not.toHaveBeenCalled();
    expect(geolocation.getCurrentPosition).toHaveBeenCalledTimes(2);

    await act(async () => {
      gate.success?.(successPosition());
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(media.getUserMedia).not.toHaveBeenCalled();
    expect(document.querySelector("[data-phase='identificando']")).not.toBeNull();
  });

  it("Volver cierra la alerta, conserva el DNI y restaura el foco", async () => {
    installGeolocation((_success, error) => error({ code: 1, message: "denied" }));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<AsistenciaPage />);

    await user.type(screen.getByTestId("kiosk-identifier"), "71112233");
    await user.click(screen.getByTestId("kiosk-identify"));
    await screen.findByRole("alertdialog", { name: "Activa la ubicación para continuar" });

    await user.click(screen.getByTestId("kiosk-location-back"));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(screen.getByTestId("kiosk-identifier")).toHaveValue("71112233");
    expect(screen.getByTestId("kiosk-identify")).toHaveFocus();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("Escape cierra la alerta y restaura el foco sin identificar", async () => {
    installGeolocation((_success, error) => error({ code: 1, message: "denied" }));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<AsistenciaPage />);

    await user.type(screen.getByTestId("kiosk-identifier"), "71112233");
    await user.click(screen.getByTestId("kiosk-identify"));
    await screen.findByRole("alertdialog", { name: "Activa la ubicación para continuar" });

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(screen.getByTestId("kiosk-identifier")).toHaveValue("71112233");
    expect(screen.getByTestId("kiosk-identify")).toHaveFocus();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("un callback tardío después de cerrar no identifica ni deja bloqueos", async () => {
    const gate: { success?: GeoSuccess } = {};
    let attempt = 0;
    const geolocation = installGeolocation((success, error) => {
      attempt += 1;
      if (attempt === 1) error({ code: 1, message: "denied" });
      else gate.success = success;
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<AsistenciaPage />);

    await user.type(screen.getByTestId("kiosk-identifier"), "71112233");
    await user.click(screen.getByTestId("kiosk-identify"));
    await screen.findByRole("alertdialog", { name: "Activa la ubicación para continuar" });

    await user.click(screen.getByTestId("kiosk-location-retry"));
    await waitFor(() =>
      expect(screen.getByTestId("kiosk-location-retry")).toHaveAttribute("aria-disabled", "true"),
    );
    await user.keyboard("{Escape}");
    await act(async () => {
      gate.success?.(successPosition());
    });

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(geolocation.getCurrentPosition).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("kiosk-identify")).not.toBeDisabled();
    expect(document.querySelector("[data-phase='identificando']")).not.toBeNull();
  });

  it("Escape durante la lectura bloquea Reintentar hasta terminar la salida", async () => {
    const media = installMediaDouble();
    const gate: { success?: GeoSuccess } = {};
    let attempt = 0;
    const geolocation = installGeolocation((success, error) => {
      attempt += 1;
      if (attempt === 1) error({ code: 1, message: "denied" });
      else gate.success = success;
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<AsistenciaPage />);

    await user.type(screen.getByTestId("kiosk-identifier"), "71112233");
    await user.click(screen.getByTestId("kiosk-identify"));
    await screen.findByRole("alertdialog", { name: "Activa la ubicación para continuar" });
    await user.click(screen.getByTestId("kiosk-location-retry"));
    const retry = screen.getByTestId("kiosk-location-retry");
    await waitFor(() => expect(retry).toHaveAttribute("aria-disabled", "true"));

    fireEvent.keyDown(document, { key: "Escape" });
    // La ventana sigue montada durante 170 ms; el ref de cierre ya está activo.
    expect(document.querySelector(".dialog-backdrop.dialog-portal")).toHaveAttribute("data-motion-state", "exiting");
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(retry).toHaveAttribute("aria-disabled", "false");
    expect(retry).toHaveTextContent("Reintentar");
    fireEvent.click(retry);
    expect(geolocation.getCurrentPosition).toHaveBeenCalledTimes(2);

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await act(async () => {
      gate.success?.(successPosition());
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(media.getUserMedia).not.toHaveBeenCalled();
    expect(geolocation.getCurrentPosition).toHaveBeenCalledTimes(2);
    expect(document.querySelector("[data-phase='identificando']")).not.toBeNull();
  });

  it("un nuevo montaje después de Volver puede reintentar normalmente", async () => {
    installMediaDouble();
    let attempt = 0;
    const geolocation = installGeolocation((success, error) => {
      attempt += 1;
      if (attempt === 1) error({ code: 1, message: "denied" });
      else success(successPosition());
    });
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(identifyResponse("tok-ana")));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<AsistenciaPage />);

    await user.type(screen.getByTestId("kiosk-identifier"), "71112233");
    await user.click(screen.getByTestId("kiosk-identify"));
    await screen.findByRole("alertdialog", { name: "Activa la ubicación para continuar" });
    await user.click(screen.getByTestId("kiosk-location-back"));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());

    await user.click(screen.getByTestId("kiosk-identify"));
    expect(await screen.findByTestId("kiosk-employee-name")).toHaveTextContent("Ana Prueba");
    expect(geolocation.getCurrentPosition).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.filter((call) => String(call[0]).includes("/identify"))).toHaveLength(1);
  });

  it("aplica su propio plazo de 20 segundos cuando la geolocalización nunca responde", async () => {
    vi.useFakeTimers();
    try {
      installGeolocation(() => undefined);
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      render(<AsistenciaPage />);

      fireEvent.change(screen.getByTestId("kiosk-identifier"), { target: { value: "71112233" } });
      fireEvent.click(screen.getByTestId("kiosk-identify"));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20000);
      });

      expect(screen.getByRole("alertdialog", { name: "La ubicación está tardando demasiado" })).toBeInTheDocument();
      expect(screen.getByTestId("kiosk-location-dialog-description")).toHaveTextContent(/20 segundos/i);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(screen.queryByTestId("kiosk-capture-now")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("un fallo no disponible explica el estado sin asegurar la causa", async () => {
    installGeolocation((_success, error) => error({ code: 2, message: "unavailable" }));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<AsistenciaPage />);

    await user.type(screen.getByTestId("kiosk-identifier"), "71112233");
    await user.click(screen.getByTestId("kiosk-identify"));

    const dialog = await screen.findByRole("alertdialog", { name: "No pudimos obtener tu ubicación" });
    expect(dialog).toHaveTextContent(/no entregó una ubicación/i);
    expect(dialog).not.toHaveTextContent(/GPS apagado/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("bloquea lecturas imprecisas o inválidas y acepta el límite de 50 m", async () => {
    installMediaDouble();
    let accuracy = 51;
    installGeolocation((success) => success(successPosition(-12.0464, -77.0428, accuracy)));
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(identifyResponse("tok-ana")));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<AsistenciaPage />);

    await user.type(screen.getByTestId("kiosk-identifier"), "71112233");
    await user.click(screen.getByTestId("kiosk-identify"));
    expect(await screen.findByRole("alertdialog", { name: "Necesitamos una ubicación más precisa" })).toBeInTheDocument();
    expect(screen.getByTestId("kiosk-location-dialog-description")).toHaveTextContent(/50 metros/i);
    expect(screen.getByTestId("kiosk-location-dialog-description")).toHaveTextContent(/Reintentar/i);
    expect(fetchMock).not.toHaveBeenCalled();

    accuracy = 0;
    await user.click(screen.getByTestId("kiosk-location-retry"));
    await waitFor(() =>
      expect(screen.getByTestId("kiosk-location-dialog-title")).toHaveTextContent("La ubicación recibida no es válida"),
    );
    expect(screen.getByTestId("kiosk-location-dialog-description")).toHaveTextContent(/lectura incompleta/i);
    await waitFor(() =>
      expect(screen.getByTestId("kiosk-location-retry")).toHaveAttribute("aria-disabled", "false"),
    );
    expect(fetchMock).not.toHaveBeenCalled();

    accuracy = 50;
    await user.click(screen.getByTestId("kiosk-location-retry"));
    expect(await screen.findByTestId("kiosk-employee-name")).toHaveTextContent("Ana Prueba");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("ignora una lectura de ubicación que llega después de desmontar", async () => {
    const gate: { resolve?: GeoSuccess } = {};
    installGeolocation((success) => {
      gate.resolve = success;
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const view = render(<AsistenciaPage />);

    await user.type(screen.getByTestId("kiosk-identifier"), "71112233");
    await user.click(screen.getByTestId("kiosk-identify"));
    view.unmount();
    await act(async () => {
      gate.resolve?.(successPosition());
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("kiosco prepara la marcación con ubicación y foto", () => {
  it("prepara con la ubicación exacta, persiste el token renovado antes de subir y confirma una sola vez", async () => {
    installMediaDouble();
    const requests: Array<{ url: string; body: Record<string, unknown> | null; storedToken: string | null }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      requests.push({ url, body, storedToken: storedAttemptToken() });
      if (url.includes("/attempt/prepare")) {
        return jsonResponse({
          marking_token: "tok-prepared",
          marked_at: MARKED_AT,
          expires_at: EXPIRES_AT,
          location: PREPARED_LOCATION,
        });
      }
      if (url.includes("/identify")) return jsonResponse(identifyResponse("tok-ana"));
      if (url.includes("/evidence")) return jsonResponse({ id: "ev-1", content_type: "image/jpeg" }, 201);
      if (url.includes("/check-in")) return jsonResponse(CONFIRMED_RECORD, 201);
      return jsonResponse({ detail: "inesperado" }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<AsistenciaPage />);

    await user.type(screen.getByTestId("kiosk-identifier"), "71112233");
    await user.click(screen.getByTestId("kiosk-identify"));
    await user.click(await screen.findByTestId("kiosk-capture-now"));

    expect(await screen.findByTestId("kiosk-confirmed-title")).toHaveTextContent("Entrada registrada");

    const orderedPaths = requests.map((request) => request.url);
    const order = [
      orderedPaths.findIndex((url) => url.includes("/identify")),
      orderedPaths.findIndex((url) => url.includes("/attempt/prepare")),
      orderedPaths.findIndex((url) => url.includes("/evidence")),
      orderedPaths.findIndex((url) => url.includes("/check-in")),
    ];
    expect(order.every((index, position) => index >= 0 && (position === 0 || index > order[position - 1]))).toBe(true);

    const prepare = requests.find((request) => request.url.includes("/attempt/prepare"))!;
    expect(prepare.body).toEqual({
      marking_token: jwt("tok-ana"),
      location: { latitude: -12.0464, longitude: -77.0428, accuracy_m: 12.5, age_ms: expect.any(Number) },
    });
    const ageMs = (prepare.body as { location: { age_ms: number } }).location.age_ms;
    expect(ageMs).toBeGreaterThanOrEqual(0);
    expect(ageMs).toBeLessThanOrEqual(60000);

    const evidence = requests.find((request) => request.url.includes("/evidence"))!;
    expect((evidence.body as { marking_token: string }).marking_token).toBe(jwt("tok-prepared"));
    expect(evidence.storedToken).toBe(jwt("tok-prepared"));

    const checkIn = requests.find((request) => request.url.includes("/check-in"))!;
    expect((checkIn.body as { marking_token: string }).marking_token).toBe(jwt("tok-prepared"));
    expect(requests.filter((request) => request.url.includes("/check-in"))).toHaveLength(1);
    expect(requests.filter((request) => request.url.includes("/evidence"))).toHaveLength(1);
  });

  it("no renueva la lectura mientras siga dentro de los 60 s", async () => {
    installMediaDouble();
    const geolocation = installGeolocation((success) => success(successPosition()));
    const prepares: Array<{ location: { age_ms: number } }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/attempt/prepare")) {
        const body = JSON.parse(String(init?.body)) as { location: { age_ms: number } };
        prepares.push(body);
        return jsonResponse({
          marking_token: "tok-prepared",
          marked_at: MARKED_AT,
          expires_at: EXPIRES_AT,
          location: PREPARED_LOCATION,
        });
      }
      if (url.includes("/identify")) return jsonResponse(identifyResponse("tok-ana"));
      if (url.includes("/evidence")) return jsonResponse({ id: "ev-1" }, 201);
      if (url.includes("/check-in")) return jsonResponse(CONFIRMED_RECORD, 201);
      return jsonResponse({ detail: "inesperado" }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<AsistenciaPage />);

    await user.type(screen.getByTestId("kiosk-identifier"), "71112233");
    await user.click(screen.getByTestId("kiosk-identify"));
    await screen.findByTestId("kiosk-capture-now");

    monotonicOffset = 59000;
    await user.click(screen.getByTestId("kiosk-capture-now"));
    await waitFor(() => expect(prepares).toHaveLength(1));
    expect(geolocation.getCurrentPosition).toHaveBeenCalledTimes(1);
    expect(prepares[0].location.age_ms).toBeGreaterThanOrEqual(59000);
    expect(prepares[0].location.age_ms).toBeLessThanOrEqual(59999);
    await screen.findByTestId("kiosk-confirmed-title");
  });

  it("pide una lectura nueva si la ubicación queda más vieja que 60 s", async () => {
    installMediaDouble();
    const geolocation = installGeolocation((success) => success(successPosition()));
    const prepares: Array<{ location: { age_ms: number } }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/attempt/prepare")) {
        const body = JSON.parse(String(init?.body)) as { location: { age_ms: number } };
        prepares.push(body);
        return jsonResponse({
          marking_token: "tok-prepared",
          marked_at: MARKED_AT,
          expires_at: EXPIRES_AT,
          location: PREPARED_LOCATION,
        });
      }
      if (url.includes("/identify")) return jsonResponse(identifyResponse("tok-ana"));
      if (url.includes("/evidence")) return jsonResponse({ id: "ev-1" }, 201);
      if (url.includes("/check-in")) return jsonResponse(CONFIRMED_RECORD, 201);
      return jsonResponse({ detail: "inesperado" }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<AsistenciaPage />);

    await user.type(screen.getByTestId("kiosk-identifier"), "71112233");
    await user.click(screen.getByTestId("kiosk-identify"));
    await screen.findByTestId("kiosk-capture-now");

    monotonicOffset = 61000;
    await user.click(screen.getByTestId("kiosk-capture-now"));
    await screen.findByTestId("kiosk-confirmed-title");

    expect(geolocation.getCurrentPosition).toHaveBeenCalledTimes(2);
    expect(prepares[0].location.age_ms).toBeLessThanOrEqual(1000);
  });

  it("un fallo de captura local no genera ninguna escritura", async () => {
    const media = installMediaDouble();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/identify")) return jsonResponse(identifyResponse("tok-ana"));
      return jsonResponse({ detail: "inesperado" }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<AsistenciaPage />);

    await user.type(screen.getByTestId("kiosk-identifier"), "71112233");
    await user.click(screen.getByTestId("kiosk-identify"));
    await screen.findByTestId("kiosk-capture-now");
    media.setFrame(0, 0);
    await user.click(screen.getByTestId("kiosk-capture-now"));

    expect(await screen.findByTestId("kiosk-incident-message")).toHaveTextContent(/no se registró la marcación/i);
    const paths = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(paths.filter((path) => path.includes("/attempt/prepare"))).toHaveLength(0);
    expect(paths.filter((path) => path.includes("/evidence"))).toHaveLength(0);
    expect(paths.filter((path) => path.includes("/check-in"))).toHaveLength(0);
  });

  it("reconcilia una subida incierta con el mismo intento sin duplicar identidad ni marcación", async () => {
    installMediaDouble();
    const paths: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      paths.push(url);
      if (url.includes("/attempt/prepare")) {
        return jsonResponse({
          marking_token: "tok-prepared",
          marked_at: MARKED_AT,
          expires_at: EXPIRES_AT,
          location: PREPARED_LOCATION,
        });
      }
      if (url.includes("/identify")) return jsonResponse(identifyResponse("tok-ana"));
      if (url.includes("/evidence")) return jsonResponse({ detail: "red" }, 500);
      if (url.includes("/attempt/status")) {
        return jsonResponse({
          state: "PENDING",
          record: null,
          evidence_ready: false,
          write_token_valid: true,
          marking_token: "tok-recovery",
          preparation: { marked_at: MARKED_AT, expires_at: EXPIRES_AT, location: PREPARED_LOCATION },
        });
      }
      return jsonResponse({ detail: "inesperado" }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<AsistenciaPage />);

    await user.type(screen.getByTestId("kiosk-identifier"), "71112233");
    await user.click(screen.getByTestId("kiosk-identify"));
    await user.click(await screen.findByTestId("kiosk-capture-now"));

    const incident = await screen.findByTestId("kiosk-incident-message");
    expect(incident).toHaveTextContent(/pendiente/i);
    expect(incident).toHaveTextContent(/aún no se registró/i);
    expect(screen.queryByTestId("kiosk-confirmed-title")).toBeNull();
    expect(paths.filter((path) => path.includes("/identify"))).toHaveLength(1);
    expect(paths.filter((path) => path.includes("/check-in"))).toHaveLength(0);
    expect(paths.filter((path) => path.includes("/attempt/status"))).toHaveLength(1);
    expect(storedAttemptToken()).toBe(jwt("tok-recovery"));
    expect(tokenNonce(storedAttemptToken())).toBe("nonce-a");
    // La adopción del token renovado no debe dejar bloqueada la consulta.
    expect(await screen.findByTestId("kiosk-consult-attempt")).not.toBeDisabled();
  });

  it("al reenviar la misma foto tras una preparación sin foto no crea identidad ni marcación nueva", async () => {
    installMediaDouble();
    const paths: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      paths.push(url);
      if (url.includes("/attempt/prepare")) {
        return jsonResponse({
          marking_token: "tok-prepared",
          marked_at: MARKED_AT,
          expires_at: EXPIRES_AT,
          location: PREPARED_LOCATION,
        });
      }
      if (url.includes("/identify")) return jsonResponse(identifyResponse("tok-ana"));
      if (url.includes("/evidence")) return jsonResponse({ detail: "red" }, 500);
      if (url.includes("/attempt/status")) {
        return jsonResponse({ state: "PENDING", record: null, evidence_ready: false, write_token_valid: true });
      }
      return jsonResponse({ detail: "inesperado" }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<AsistenciaPage />);

    await user.type(screen.getByTestId("kiosk-identifier"), "71112233");
    await user.click(screen.getByTestId("kiosk-identify"));
    await user.click(await screen.findByTestId("kiosk-capture-now"));
    await screen.findByTestId("kiosk-incident-message");

    const resend = await screen.findByTestId("kiosk-resend");
    await user.click(resend);

    await waitFor(() => expect(paths.filter((path) => path.includes("/attempt/prepare")).length).toBe(2));
    expect(paths.filter((path) => path.includes("/identify"))).toHaveLength(1);
    expect(paths.filter((path) => path.includes("/check-in"))).toHaveLength(0);
    expect(paths.filter((path) => path.includes("/evidence"))).toHaveLength(2);
    expect(await screen.findByTestId("kiosk-resend")).not.toBeDisabled();
  });

  it("no adopta ni sube nada si la preparación responde con otro nonce", async () => {
    installMediaDouble();
    const paths: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      paths.push(url);
      if (url.includes("/attempt/prepare")) {
        return jsonResponse({
          marking_token: "tok-other",
          marked_at: MARKED_AT,
          expires_at: EXPIRES_AT,
          location: PREPARED_LOCATION,
        });
      }
      if (url.includes("/identify")) return jsonResponse(identifyResponse("tok-ana"));
      if (url.includes("/evidence")) return jsonResponse({ id: "ev-1" }, 201);
      if (url.includes("/check-in")) return jsonResponse(CONFIRMED_RECORD, 201);
      return jsonResponse({ detail: "inesperado" }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<AsistenciaPage />);

    await user.type(screen.getByTestId("kiosk-identifier"), "71112233");
    await user.click(screen.getByTestId("kiosk-identify"));
    await user.click(await screen.findByTestId("kiosk-capture-now"));

    const incident = await screen.findByTestId("kiosk-incident-message");
    expect(incident).toHaveTextContent(/no se subió la fotografía/i);
    expect(incident).not.toHaveTextContent(/registrada/i);
    expect(paths.filter((path) => path.includes("/evidence"))).toHaveLength(0);
    expect(paths.filter((path) => path.includes("/check-in"))).toHaveLength(0);
    expect(paths.filter((path) => path.includes("/identify"))).toHaveLength(1);
    // La referencia del intento original se conserva para reconciliarla.
    expect(storedAttemptToken()).toBe(jwt("tok-ana"));
    expect(tokenNonce(storedAttemptToken())).toBe("nonce-a");
    expect(await screen.findByTestId("kiosk-consult-attempt")).not.toBeDisabled();
  });

  it("no adopta ni sube nada si la preparación no devuelve token", async () => {
    installMediaDouble();
    const paths: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      paths.push(url);
      if (url.includes("/attempt/prepare")) {
        return jsonResponse({
          marking_token: null,
          marked_at: MARKED_AT,
          expires_at: EXPIRES_AT,
          location: PREPARED_LOCATION,
        });
      }
      if (url.includes("/identify")) return jsonResponse(identifyResponse("tok-ana"));
      if (url.includes("/evidence")) return jsonResponse({ id: "ev-1" }, 201);
      if (url.includes("/check-in")) return jsonResponse(CONFIRMED_RECORD, 201);
      return jsonResponse({ detail: "inesperado" }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<AsistenciaPage />);

    await user.type(screen.getByTestId("kiosk-identifier"), "71112233");
    await user.click(screen.getByTestId("kiosk-identify"));
    await user.click(await screen.findByTestId("kiosk-capture-now"));

    expect(await screen.findByTestId("kiosk-incident-message")).toHaveTextContent(/no se subió la fotografía/i);
    expect(paths.filter((path) => path.includes("/evidence"))).toHaveLength(0);
    expect(paths.filter((path) => path.includes("/check-in"))).toHaveLength(0);
    expect(storedAttemptToken()).toBe(jwt("tok-ana"));
  });

  it("la recuperación no reemplaza el intento cuando el token no expone nonce", async () => {
    installMediaDouble();
    const paths: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      paths.push(url);
      if (url.includes("/attempt/prepare")) {
        // Repetir la misma cadena no cambia la identidad del intento.
        return jsonResponse({
          marking_token: "legacy-plain",
          marked_at: MARKED_AT,
          expires_at: EXPIRES_AT,
          location: PREPARED_LOCATION,
        });
      }
      if (url.includes("/identify")) return jsonResponse(identifyResponse("legacy-plain"));
      if (url.includes("/evidence")) return jsonResponse({ detail: "red" }, 500);
      if (url.includes("/attempt/status")) {
        return jsonResponse({
          state: "PENDING",
          record: null,
          evidence_ready: false,
          write_token_valid: true,
          marking_token: "legacy-other",
          preparation: { marked_at: MARKED_AT, expires_at: EXPIRES_AT, location: PREPARED_LOCATION },
        });
      }
      return jsonResponse({ detail: "inesperado" }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<AsistenciaPage />);

    await user.type(screen.getByTestId("kiosk-identifier"), "71112233");
    await user.click(screen.getByTestId("kiosk-identify"));
    await user.click(await screen.findByTestId("kiosk-capture-now"));
    await screen.findByTestId("kiosk-incident-message");

    expect(paths.filter((path) => path.includes("/attempt/status"))).toHaveLength(1);
    expect(storedAttemptToken()).toBe("legacy-plain");
    expect(storedAttemptToken()).not.toBe("legacy-other");
  });
});

describe("kiosco alerta de ubicación al escanear QR", () => {
  it("conserva el valor leído para Reintentar sin reabrir el escáner", async () => {
    const media = installQrMediaDouble();
    const detector = installBarcodeDetector();
    let attempt = 0;
    const geolocation = installGeolocation((success, error) => {
      attempt += 1;
      if (attempt === 1) error({ code: 1, message: "denied" });
      else success(successPosition());
    });
    const identifyBodies: unknown[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/identify")) {
        identifyBodies.push(init?.body ? JSON.parse(String(init.body)) : null);
        return jsonResponse(identifyResponse("tok-ana"));
      }
      return jsonResponse({ detail: "inesperado" }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<AsistenciaPage />);

    await user.click(screen.getByTestId("kiosk-scan-qr"));
    await waitFor(() => expect(media.getUserMedia).toHaveBeenCalledTimes(1));
    detector.setPayload(["EMP-777"]);

    const dialog = await screen.findByRole("alertdialog", { name: "Activa la ubicación para continuar" }, { timeout: 3000 });
    expect(dialog).toBeInTheDocument();
    expect(media.streams[0].trackStop).toHaveBeenCalled();
    expect(media.getUserMedia).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("kiosk-identifier")).toHaveValue("");
    expect(fetchMock).not.toHaveBeenCalled();

    await user.click(screen.getByTestId("kiosk-location-retry"));

    expect(await screen.findByTestId("kiosk-employee-name", {}, { timeout: 3000 })).toHaveTextContent("Ana Prueba");
    expect(identifyBodies).toEqual([{ identifier: "AR:EMP-777" }]);
    expect(geolocation.getCurrentPosition).toHaveBeenCalledTimes(2);
    // La primera cámara fue el escáner QR; la segunda, la cámara frontal normal.
    expect(media.constraints[0]).toMatchObject({ video: { facingMode: { ideal: "environment" } } });
    expect(media.constraints[1]).toMatchObject({ video: { facingMode: "user" } });
    expect(media.constraints).toHaveLength(2);
  });

  it("Volver limpia el valor temporal del QR y no identifica ni reabre la cámara", async () => {
    const media = installQrMediaDouble();
    const detector = installBarcodeDetector();
    const geolocation = installGeolocation((_success, error) => error({ code: 1, message: "denied" }));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<AsistenciaPage />);

    await user.click(screen.getByTestId("kiosk-scan-qr"));
    await waitFor(() => expect(media.getUserMedia).toHaveBeenCalledTimes(1));
    detector.setPayload(["EMP-777"]);
    await screen.findByRole("alertdialog", { name: "Activa la ubicación para continuar" }, { timeout: 3000 });

    await user.click(screen.getByTestId("kiosk-location-back"));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(screen.getByTestId("kiosk-identifier")).toHaveValue("");

    await user.click(screen.getByTestId("kiosk-identify"));
    expect(geolocation.getCurrentPosition).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(media.getUserMedia).toHaveBeenCalledTimes(1);
    expect(document.querySelector("[data-phase='identificando']")).not.toBeNull();
  });
});

describe("kiosco escaneo QR con el reloj en marcha", () => {
  it("mantiene una sola cámara abierta entre rerenders del reloj e identifica el QR una sola vez", async () => {
    vi.useFakeTimers();
    try {
      const media = installQrMediaDouble();
      const detector = installBarcodeDetector();
      const geolocation = installGeolocation((success) => success(successPosition()));
      const identifyBodies: unknown[] = [];
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/identify")) {
          identifyBodies.push(init?.body ? JSON.parse(String(init.body)) : null);
          return jsonResponse(identifyResponse("tok-ana"));
        }
        return jsonResponse({ detail: "inesperado" }, 404);
      });
      vi.stubGlobal("fetch", fetchMock);
      render(<AsistenciaPage />);

      await act(async () => {
        fireEvent.click(screen.getByTestId("kiosk-scan-qr"));
      });
      expect(document.querySelector("[data-phase='escaneando_qr']")).not.toBeNull();
      expect(media.getUserMedia).toHaveBeenCalledTimes(1);
      expect(media.constraints[0]).toMatchObject({ video: { facingMode: { ideal: "environment" } } });
      expect(detector.formats()).toEqual(["qr_code"]);

      // Tres lecturas del reloj (un rerender por segundo) sin reabrir la cámara.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(media.getUserMedia).toHaveBeenCalledTimes(1);
      expect(detector.detect.mock.calls.length).toBeGreaterThan(1);
      expect(fetchMock).not.toHaveBeenCalled();

      // El siguiente cuadro sí trae el QR: se identifica exactamente una vez.
      detector.setPayload(["EMP-777"]);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(250);
        await vi.advanceTimersByTimeAsync(250);
      });

      const identifyCalls = fetchMock.mock.calls.filter((call) => String(call[0]).includes("/identify"));
      expect(identifyCalls).toHaveLength(1);
      expect(identifyBodies).toEqual([{ identifier: "AR:EMP-777" }]);
      // La ubicación sigue siendo requisito previo: se leyó antes de identificar.
      expect(geolocation.getCurrentPosition).toHaveBeenCalledTimes(1);
      // Al entregar el valor se cierra la cámara del QR y sigue el flujo normal.
      expect(media.streams[0].trackStop).toHaveBeenCalled();
      expect(screen.getByTestId("kiosk-employee-name")).toHaveTextContent("Ana Prueba");
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancelar el escaneo detiene la cámara del QR sin identificar ni reabrirla", async () => {
    vi.useFakeTimers();
    try {
      const media = installQrMediaDouble();
      const detector = installBarcodeDetector();
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const view = render(<AsistenciaPage />);

      await act(async () => {
        fireEvent.click(screen.getByTestId("kiosk-scan-qr"));
      });
      expect(media.getUserMedia).toHaveBeenCalledTimes(1);

      detector.setPayload(["EMP-777"]);
      await act(async () => {
        fireEvent.click(screen.getByTestId("kiosk-cancel-qr"));
      });
      expect(media.streams[0].trackStop).toHaveBeenCalled();
      expect(document.querySelector("[data-phase='identificando']")).not.toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();

      // Un cuadro pendiente ya no identifica ni vuelve a abrir la cámara.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(media.getUserMedia).toHaveBeenCalledTimes(1);

      view.unmount();
      expect(media.streams[0].trackStop).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
