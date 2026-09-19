/**
 * Worker-thread entry for the AT-QR decoder cascade (Fase 2).
 *
 * The ZXing/jsQR cascade is pure CPU work that can take 5–40 s on a big
 * raster. Run on the main thread it starves the event loop: /health stops
 * answering, Docker marks the container unhealthy, Traefik drops it and the
 * API returns "no available server" for every client. This file is loaded
 * with `new Worker()` by `decodeAtQrOffThread()`; it must stay dependency-
 * light (only the decoder itself).
 */
import { parentPort, workerData } from 'node:worker_threads';
import { decodeAtQr } from './qr-decoder';

interface Input {
  buffer: Uint8Array;
  mimeType: string;
}

const silentLogger = {
  log: () => undefined,
  debug: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

(async () => {
  const { buffer, mimeType } = workerData as Input;
  try {
    const result = await decodeAtQr(Buffer.from(buffer), mimeType, silentLogger as never);
    parentPort?.postMessage({ ok: true, result });
  } catch (err) {
    parentPort?.postMessage({ ok: false, error: (err as Error).message });
  }
})();
