import { type Page } from "@playwright/test";

/** Cámara y BarcodeDetector solo en el harness. El producto recorre el flujo real. */
export async function installKioskCameraHarness(page: Page) {
  await page.addInitScript(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 480;
    canvas.setAttribute("data-kiosk-harness-camera", "1");
    const ctx = canvas.getContext("2d");
    const draw = () => {
      if (ctx) {
        ctx.fillStyle = "#224466";
        ctx.fillRect(0, 0, 640, 480);
        ctx.fillStyle = "#99ccee";
        ctx.fillRect(80, 60, 240, 200);
      }
      requestAnimationFrame(draw);
    };
    const attach = () => {
      if (!canvas.isConnected && document.documentElement) {
        canvas.style.position = "fixed";
        canvas.style.left = "-9999px";
        document.documentElement.appendChild(canvas);
      }
      draw();
    };
    if (document.documentElement) attach();
    else document.addEventListener("DOMContentLoaded", attach, { once: true });

    const proto = HTMLVideoElement.prototype;
    const nativeWidth = Object.getOwnPropertyDescriptor(proto, "videoWidth");
    const nativeHeight = Object.getOwnPropertyDescriptor(proto, "videoHeight");
    Object.defineProperty(proto, "videoWidth", {
      configurable: true,
      get() {
        const value = nativeWidth?.get?.call(this) ?? 0;
        return value >= 320 ? value : 640;
      },
    });
    Object.defineProperty(proto, "videoHeight", {
      configurable: true,
      get() {
        const value = nativeHeight?.get?.call(this) ?? 0;
        return value >= 240 ? value : 480;
      },
    });
    const baseStream = canvas.captureStream(15);
    navigator.mediaDevices.getUserMedia = async () => {
      const tracks = baseStream.getTracks().map((track) => track.clone());
      return new MediaStream(tracks);
    };

    type DetectResult = Array<{ rawValue: string }>;
    const queued: string[] = [];
    let hanging: { promise: Promise<DetectResult>; resolve: (value: DetectResult) => void } | null = null;
    const harness = window as unknown as {
      __pushQr: (value: string) => void;
      __armHangingDetect: () => void;
      __resolveHangingDetect: (value: string | null) => void;
      __detectEnteredCount: number;
    };
    harness.__detectEnteredCount = 0;
    harness.__pushQr = (value: string) => {
      queued.push(value);
    };
    harness.__armHangingDetect = () => {
      let resolve!: (value: DetectResult) => void;
      const promise = new Promise<DetectResult>((res) => {
        resolve = res;
      });
      hanging = { promise, resolve };
    };
    harness.__resolveHangingDetect = (value: string | null) => {
      const current = hanging;
      hanging = null;
      current?.resolve(value ? [{ rawValue: value }] : []);
    };
    class FakeDetector {
      async detect() {
        harness.__detectEnteredCount += 1;
        if (hanging) return hanging.promise;
        const raw = queued.shift();
        return raw ? [{ rawValue: raw }] : [];
      }
    }
    (window as unknown as { BarcodeDetector: unknown }).BarcodeDetector = FakeDetector;
  });
}

export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}
