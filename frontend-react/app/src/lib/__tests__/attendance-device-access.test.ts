import { afterEach, describe, expect, it, vi } from "vitest";
import { API_URL, ApiError, attendanceApi, devicesApi } from "@/lib/api";

/**
 * Contrato público de marcación tras eliminar la autorización de dispositivos.
 *
 * Cualquier tablet o teléfono puede marcar asistencia: la identificación
 * transparente sucede en el mismo POST /attendance/identify de siempre, sin
 * emparejamiento previo. Estas pruebas fijan la superficie pública y evitan que
 * vuelva a colarse un paso de provisioning o la creación/rotación de códigos.
 */

function identifyPayload() {
  return {
    employee: {
      id: "emp-1",
      first_name: "María",
      last_name: "López",
      job_role_name: "Operaria",
      active: true,
    },
    state: { has_open_entry: false, open_check_in_at: null, last_record: null },
    server_time: new Date().toISOString(),
    server_time_label: "",
    marking_token: "header.payload.signature",
    marking_action: "CHECK_IN",
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("acceso público a marcación sin emparejamiento", () => {
  it("identify sigue siendo la única entrada y viaja con la cookie del navegador", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, identifyPayload()));
    vi.stubGlobal("fetch", fetchMock);

    const result = await attendanceApi.identify("71112233");

    expect(result.marking_action).toBe("CHECK_IN");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${API_URL}/api/v1/attendance/identify`);
    expect(options.method).toBe("POST");
    expect(options.credentials).toBe("include");
    expect(JSON.parse(String(options.body))).toEqual({ identifier: "71112233" });
  });

  it("no expone emparejamiento ni creación/rotación de códigos de equipo", () => {
    expect("pairTerminal" in attendanceApi).toBe(false);
    expect("create" in devicesApi).toBe(false);
    expect("rotate" in devicesApi).toBe(false);
    // La administración conserva listado y revocación del contexto.
    expect("list" in devicesApi).toBe(true);
    expect("revoke" in devicesApi).toBe(true);
  });

  it("un 401 de identify no dispara ninguna solicitud de código de emparejamiento", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(401, { detail: { code: "DEVICE_NOT_ENROLLED", message: "Equipo no habilitado" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(attendanceApi.identify("71112233")).rejects.toBeInstanceOf(ApiError);
    const calledPaths = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(calledPaths.every((path) => path.endsWith("/api/v1/attendance/identify"))).toBe(true);
    expect(calledPaths.some((path) => path.includes("pair"))).toBe(false);
  });
});
