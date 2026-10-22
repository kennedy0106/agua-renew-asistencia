import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiTimeoutError, apiFetch, attendanceApi } from "@/lib/api";

/**
 * El plazo público incluye la lectura del cuerpo. Sin esto, un servidor que
 * envía cabeceras y deja el cuerpo abierto mantendría el kiosco esperando.
 */
describe("plazo de operaciones públicas", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("cancela una petición que nunca responde", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => undefined)));
    const promise = apiFetch("/api/v1/attendance/attempt/status", { method: "POST", timeoutMs: 50 });
    const assertion = expect(promise).rejects.toBeInstanceOf(ApiTimeoutError);
    await vi.advanceTimersByTimeAsync(50);
    await assertion;
  });

  it("cancela también cuando el cuerpo queda abierto tras las cabeceras", async () => {
    vi.useFakeTimers();
    const response = {
      ok: true,
      status: 200,
      json: () => new Promise(() => undefined),
    } as unknown as Response;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    const promise = apiFetch("/api/v1/attendance/identify", { method: "POST", timeoutMs: 50 });
    const assertion = expect(promise).rejects.toBeInstanceOf(ApiTimeoutError);
    await vi.advanceTimersByTimeAsync(50);
    await assertion;
  });

  it("la consulta del intento aplica su plazo por defecto sin bloquearse", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => undefined)));
    const promise = attendanceApi.attemptStatus("token");
    const assertion = expect(promise).rejects.toBeInstanceOf(ApiTimeoutError);
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
  });
});
