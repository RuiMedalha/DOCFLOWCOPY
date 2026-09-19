import { Logger } from '@nestjs/common';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import { decodeAtQr } from './qr-decoder';

/**
 * Run the AT-QR decoder cascade in a worker thread so the HTTP event loop
 * (and the container healthcheck) keep responding while a big raster is
 * being scanned. Falls back to the in-thread decoder when the compiled
 * worker file is not available (ts-jest / ts-node runs) or the worker
 * fails to start, so behaviour is identical in tests.
 *
 * `timeoutMs` bounds a pathological image: the worker is terminated and
 * `null` is returned (same as "no QR found").
 */
export async function decodeAtQrOffThread(
  buffer: Buffer,
  mimeType: string,
  logger: Logger,
  timeoutMs = 90_000,
): Promise<string | null> {
  const workerFile = path.join(__dirname, 'qr-decode.worker.js');
  if (process.env.QR_DECODE_INLINE === '1' || !fs.existsSync(workerFile)) {
    return decodeAtQr(buffer, mimeType, logger);
  }
  return new Promise<string | null>((resolve) => {
    let settled = false;
    const finish = (v: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    let worker: Worker;
    try {
      worker = new Worker(workerFile, {
        workerData: { buffer: new Uint8Array(buffer), mimeType },
        // Keep the worker from inheriting a huge heap; the cascade is
        // memory-heavy but bounded (WORK_MAX_EDGE downscale).
        resourceLimits: { maxOldGenerationSizeMb: 1024 },
      });
    } catch (err) {
      logger.warn(`qr worker spawn failed (${(err as Error).message}) — decoding inline`);
      decodeAtQr(buffer, mimeType, logger).then(finish, () => finish(null));
      return;
    }
    const timer = setTimeout(() => {
      logger.warn(`qr worker timed out after ${timeoutMs}ms — giving up on this image`);
      void worker.terminate();
      finish(null);
    }, timeoutMs);
    worker.once('message', (msg: { ok: boolean; result?: string | null; error?: string }) => {
      if (!msg.ok) logger.warn(`qr worker error: ${msg.error}`);
      finish(msg.ok ? (msg.result ?? null) : null);
      void worker.terminate();
    });
    worker.once('error', (err) => {
      logger.warn(`qr worker crashed: ${err.message}`);
      finish(null);
    });
    worker.once('exit', (code) => {
      if (code !== 0 && !settled) logger.warn(`qr worker exited with code ${code}`);
      finish(null);
    });
  });
}
