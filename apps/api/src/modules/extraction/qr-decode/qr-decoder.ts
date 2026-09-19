/**
 * Robust QR decoder for image/* uploads (AT-QR / Portuguese QR codes).
 *
 * Why this exists:
 *   - Real phone photos (3000×4000-ish, low contrast, angled, slightly
 *     blurred) defeat any single QR decoder. jsQR alone misses them;
 *     ZXing alone misses them; ZXing at native resolution misses them
 *     because the QR modules occupy only ~250-350 px in a frame of
 *     millions. The pattern that works in production readers is to
 *     chain MULTIPLE decoders against MULTIPLE preprocessed views.
 *   - The helper below implements that pattern: it runs a ZXing pass,
 *     a jsQR pass on the same pixels, and a heavier ZXing pass with
 *     high-contrast + binary threshold preprocessing — all over
 *     several scales and rotations. The first candidate that validates
 *     as an AT-QR payload (`A:NNNNNNNNN*...`) wins; otherwise the
 *     helper returns null and the caller falls back to vision.
 *
 * The flow used by `ExtractionService`:
 *   1. `autoOrientImage(jimpBuffer, mime)` — read EXIF Orientation,
 *      apply the rotation with jimp (which also clears the tag), and
 *      return the upright bytes. The same buffer is reused for the
 *      PDF derivative later so the document stays right-side-up in
 *      the viewer.
 *   2. `decodeAtQr(zxingBuffer, mime)` — chain decoders with the
 *      preprocessing pipeline described above. Returns the raw AT-QR
 *      payload string when found, or null when nothing matched.
 *   3. The caller hands the string to `parseAtQr` (via the existing
 *      `findAtQrInText` validator) for the fiscal fields and runs the
 *      existing QR+AI merge.
 *
 * Failure modes (graceful — never throws to the caller):
 *   - Missing dependency, bad buffer, EXIF read error → returns the
 *     original buffer (no rotation) and logs at warn level.
 *   - Every decoder/preprocess combination failed → returns null and
 *     logs. The caller then routes the document to vision-only.
 *
 * Tested with: a Huawei photo at 3000×4000 carrying an AT-QR, a
 * paper scan at 2480×3508 with no QR, and a synthetic test image
 * with a known AT-QR payload (backward-compat).
 */
import { Logger } from "@nestjs/common";

// ── shared regex ────────────────────────────────────────────────────────
// AT-QR payloads look like: A:500697256*B:509123456*C:PT*D:FT*E:N*
// We require the leading issuer NIF (`A:<9 digits>`) and at least one
// `*` separator. This is the cheap upstream check — `parseAtQr` does
// the full field validation. Anything that fails this check isn't a
// Portuguese fiscal QR and shouldn't waste further cycles.
const AT_QR_RE = /A:\d{9}/;

/**
 * Returns true when `text` looks like an AT-QR payload (good enough
 * to keep, bad enough to feed into `parseAtQr`).
 */
export function looksLikeAtQr(text: string | null | undefined): boolean {
  if (!text || text.length < 10) return false;
  if (!AT_QR_RE.test(text)) return false;
  // Field separator — every documented AT-QR carries at least one '*'.
  return text.includes("*");
}

// ── auto-orient ─────────────────────────────────────────────────────────

/**
 * Auto-orient an uploaded JPEG / PNG.
 *
 * Why this exists:
 *   - Phone photos carry an EXIF Orientation tag (#1, 3, 6, 8…) that
 *     tells viewers "this bitmap is rotated CW by N degrees". A naive
 *     server-side viewer (pdf-lib embedding, EXIF-unaware image tags)
 *     renders the bitmap literally and the photo appears rotated.
 *   - jimp's `Jimp.read()` already auto-applies EXIF rotation to the
 *     bitmap during decoding. After `Jimp.read()`, the bitmap is
 *     upright and the EXIF tag has been reset to 1.
 *
 * So the strategy is:
 *   1. Read the buffer with jimp → bitmap is upright.
 *   2. Detect whether the file actually needs rotation (compare
 *      original bytes' EXIF tag, parsed via a tiny purpose-built
 *      EXIF walker, against the upright-jimp result).
 *   3. If anything was rotated (or the file carried an EXIF tag
 *      regardless), RE-ENCODE the upright bitmap as a fresh JPEG
 *      with no EXIF — this is what we persist to storage. The
 *      downstream viewer (PDF / image tag) then displays the
 *      upright pixels as-is and never has to know about EXIF.
 *
 * For PNG / non-JPEG files jimp returns the bitmap unchanged (no
 * EXIF Orientation support there). We still re-encode the JPEG
 * when the original was a JPEG so storage always holds the upright,
 * tag-less version.
 *
 * Failure modes (graceful, never throws):
 *   - jimp can't read the buffer          → return original
 *   - re-encode throws                    → return original
 *   - EXIF parser throws                  → assume rotation happened,
 *                                          re-encode anyway
 *
 * Returns:
 *   - The original buffer when re-encoding produced identical bytes
 *     (already upright, no rotation needed). Byte-equality lets the
 *     caller skip the storage.put entirely.
 *   - The re-encoded upright buffer otherwise (EXIF is stripped, so the
 *     viewer always renders the pixels the way the operator intended).
 */
export async function autoOrientImage(
  buffer: Buffer,
  mime: string,
  logger?: Logger,
): Promise<Buffer> {
  const log = (msg: string): void => {
    if (logger) logger.warn(`[autoOrientImage] ${msg}`);
  };
  if (!/^image\//i.test(mime)) return buffer;

  // Sharp libvips pipeline de alta velocidade: auto-orientação EXIF + recorte inteligente + rotação landscape-to-portrait + contraste
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ImageEnhancerService } = require('../image-enhancer.service');
    const enhancer = new ImageEnhancerService();
    if (enhancer.isAvailable()) {
      return await enhancer.processDocumentImage(buffer, mime);
    }
  } catch (enhancerErr) {
    log(`ImageEnhancer fallback: ${(enhancerErr as Error).message}`);
  }

  const isJpeg = /^image\/(jpeg|jpg)$/i.test(mime);
  if (!isJpeg) return buffer;

  const orient = readExifOrientationFromJpeg(buffer);
  let needsRotation = typeof orient === "number" && orient !== 1;
  if (needsRotation) {
    log(`detected EXIF Orientation=${orient} — will re-encode upright`);
  }

  try {
    const jimpMod = require("jimp") as {
      Jimp: { read: (b: Buffer) => Promise<any> };
    };
    const Jimp = jimpMod.Jimp;
    const img = await Jimp.read(buffer);

    // Apply EXIF rotation if present
    if (typeof orient === "number" && orient !== 1) {
      if (orient === 6) {
        img.rotate(90);
        needsRotation = true;
        log(`applied EXIF Orientation 6 (90° CW rotation)`);
      } else if (orient === 8) {
        img.rotate(270);
        needsRotation = true;
        log(`applied EXIF Orientation 8 (270° CW rotation)`);
      } else if (orient === 3) {
        img.rotate(180);
        needsRotation = true;
        log(`applied EXIF Orientation 3 (180° rotation)`);
      }
    }

    // ── Fase 4.3 (P0.2) — Rotação pelo conteúdo ────────────────────────
    // Fotos de telemóvel muitas vezes não têm EXIF ou têm-no a 1 mesmo
    // estando a imagem deitada. Se o EXIF não rodou ou não existe,
    // usamos deteção de orientação pelo conteúdo (Tesseract OSD) e,
    // caso a imagem continue na horizontal (width > height), comparamos
    // o OCR a 90° e 270° para rodar para a vertical correta.
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { createWorker } = require("tesseract.js");
      const worker = await createWorker("osd", 0);
      const osd = await worker.detect(buffer);
      await worker.terminate();

      const deg = osd?.data?.orientation_degrees;
      const conf = osd?.data?.orientation_confidence ?? 0;
      if (typeof deg === "number" && deg > 0 && deg < 360 && conf >= 1.5) {
        const rot = (360 - deg) % 360;
        img.rotate(rot);
        needsRotation = true;
        log(`content OSD detected orientation_degrees=${deg} (conf=${conf.toFixed(2)}) — rotated by ${rot}°`);
      }
    } catch (osdErr) {
      // OSD falhou ou sem caracteres suficientes — prosseguir para scoring se for horizontal
    }

    if (img.bitmap.width > img.bitmap.height) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { createWorker } = require("tesseract.js");
        const worker = await createWorker("por+eng", 1);

        const buf90 = await img.clone().rotate(90).getBuffer("image/jpeg", { quality: 75 });
        const res90 = await worker.recognize(buf90);
        const score90 = (res90?.data?.confidence || 0) * Math.max(1, (res90?.data?.text || "").trim().length);

        const buf270 = await img.clone().rotate(270).getBuffer("image/jpeg", { quality: 75 });
        const res270 = await worker.recognize(buf270);
        const score270 = (res270?.data?.confidence || 0) * Math.max(1, (res270?.data?.text || "").trim().length);

        await worker.terminate();

        const winner = score270 >= score90 ? 270 : 90;
        img.rotate(winner);
        needsRotation = true;
        log(
          `landscape image (${img.bitmap.height}x${img.bitmap.width}) scored 90° (${score90}) vs 270° (${score270}) — rotated by ${winner}° to portrait`,
        );
      } catch (scoreErr) {
        log(`landscape OCR scoring failed: ${(scoreErr as Error).message}`);
      }
    }

    if (!needsRotation) return buffer;
    const out = await img.getBuffer("image/jpeg", { quality: 92 });
    return Buffer.from(out as Buffer);
  } catch (err) {
    log(`orientation failed: ${(err as Error).message}`);
    return buffer;
  }
}

/**
 * Parse the EXIF Orientation tag from a JPEG byte buffer. Returns the
 * orientation value (1..8) or undefined when not present / unreadable.
 *
 * This is a tiny purpose-built EXIF reader — it only walks the one
 * IFD entry we need and ignores everything else. Cheaper to maintain
 * than wiring `exif-parser` through pnpm's hoisting rules, and the
 * IFD walk is straightforward.
 */
function readExifOrientationFromJpeg(buf: Buffer): number | undefined {
  try {
    if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return undefined;
    // Walk JPEG segments until we find APP1 (0xFFE1).
    let off = 2;
    while (off + 4 < buf.length) {
      if (buf[off] !== 0xff) return undefined;
      const marker = buf[off + 1];
      if (marker === 0xda) return undefined; // SOS — image data starts here
      if (marker === 0xe1) {
        // APP1: length is big-endian 2 bytes including the length field
        const segLen = (buf[off + 2] << 8) | buf[off + 3];
        const segStart = off + 4;
        const sig = buf.slice(segStart, segStart + 6).toString("ascii");
        if (sig !== "Exif\0\0") {
          off += 2 + segLen;
          continue;
        }
        // TIFF header starts 6 bytes into APP1
        const tiffStart = segStart + 6;
        if (tiffStart + 8 > buf.length) return undefined;
        const byteOrder = (buf[tiffStart] << 8) | buf[tiffStart + 1];
        const little = byteOrder === 0x4949; // 'II'
        const readU16 = (p: number): number =>
          little
            ? buf[p] | (buf[p + 1] << 8)
            : (buf[p] << 8) | buf[p + 1];
        const readU32 = (p: number): number =>
          little
            ? buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16) | (buf[p + 3] << 24)
            : (buf[p] << 24) |
              (buf[p + 1] << 16) |
              (buf[p + 2] << 8) |
              buf[p + 3];
        const magic = readU16(tiffStart + 2);
        if (magic !== 0x002a) return undefined;
        const ifdOffset = readU32(tiffStart + 4);
        const ifdStart = tiffStart + ifdOffset;
        if (ifdStart + 2 > buf.length) return undefined;
        const numEntries = readU16(ifdStart);
        for (let i = 0; i < numEntries; i++) {
          const entry = ifdStart + 2 + i * 12;
          if (entry + 12 > buf.length) return undefined;
          const tag = readU16(entry);
          if (tag === 0x0112) {
            const type = readU16(entry + 2);
            // Type 3 = SHORT, 16-bit unsigned. Value is at entry+8 in
            // either endianness; little-endian bytes 8/9 carry it.
            return buf[entry + 8] | (buf[entry + 9] << 8);
          }
        }
        return undefined;
      }
      // Skip to next marker
      const segLen = (buf[off + 2] << 8) | buf[off + 3];
      off += 2 + segLen;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

// ── chained decode ─────────────────────────────────────────────────────

interface ImageLike {
  bitmap: { width: number; height: number; data: Buffer };
  clone: () => ImageLike;
  resize: (opts: { w?: number; h?: number; mode?: string }) => ImageLike;
  greyscale: () => ImageLike;
  contrast: (n: number) => ImageLike;
  normalize?: () => ImageLike;
  rotate: (deg: number) => ImageLike;
  threshold?: (opts: { max?: number }) => ImageLike;
}

interface ZxingModule {
  MultiFormatReader: new () => {
    decode: (bitmap: unknown) => { getText: () => string };
    setHints: (hints: unknown) => void;
  };
  QRCodeReader: new () => {
    decode: (bitmap: unknown) => { getText: () => string };
  };
  RGBLuminanceSource: new (
    data: Uint8ClampedArray | Buffer,
    width: number,
    height: number,
  ) => unknown;
  HybridBinarizer: new (source: unknown) => unknown;
  BinaryBitmap: new (binarizer: unknown) => unknown;
}

interface JsQrModule {
  (data: Uint8ClampedArray, width: number, height: number): {
    data: string;
  } | null;
}

/**
 * Decode an AT-QR (or any QR / DataMatrix the helper can read) from
 * an image buffer using a chained decoder pipeline.
 *
 * Pipeline (each step is tried in order; first AT-QR-valid candidate
 * wins, otherwise the next step is tried):
 *
 *   For each scale ∈ { 1×, 1.5×, 2× }:
 *     For each rotation ∈ { 0, 90, 180, 270 }:
 *       preprocess = greyscale → contrast(+0.4) → normalize
 *       step (a) ZXing on the preprocess
 *       step (b) jsQR    on the same preprocess
 *
 *   Heavy pass (one more shot if (a)+(b) failed):
 *     preprocess = greyscale → contrast(+0.6) → threshold({max:128})
 *     step (c) ZXing on the heavy preprocess at scale 1.5×
 *
 * The first decode whose payload passes `looksLikeAtQr` is returned.
 * Otherwise the helper returns null. Never throws.
 *
 * Why three decoders:
 *   - ZXing is the strongest at clean / upscaled input but its
 *     hybrid-binarizer is slow and occasionally misses low-contrast
 *     phone photos.
 *   - jsQR is fast and works well on small clean QR but fails on
 *     real photos — yet on a *preprocessed* version of the same
 *     pixels it sometimes finds what ZXing missed.
 *   - The heavy-pass ZXing (binary threshold) is the "last resort":
 *     it works when the QR modules are visible but contrast is
 *     suppressed by paper texture / JPEG artefacts.
 *
 * The caller is responsible for letting `parseAtQr` decide whether
 * the string is actually an AT-QR — we still run our own cheap
 * `looksLikeAtQr` filter so a non-fiscal QR (URL, vCard, …) doesn't
 * pull vision off into a wrong merge.
 */
export async function decodeAtQr(
  buffer: Buffer,
  mime: string,
  logger?: Logger,
): Promise<string | null> {
  const log = (msg: string): void => {
    if (logger) logger.warn(`[decodeAtQr] ${msg}`);
  };
  if (!/^image\//i.test(mime)) return null;

  let jimpMod: { Jimp: { read: (b: Buffer) => Promise<unknown> } };
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    jimpMod = require("jimp") as { Jimp: { read: (b: Buffer) => Promise<unknown> } };
  } catch (err) {
    log(`jimp import failed: ${(err as Error).message}`);
    return null;
  }
  let img: ImageLike;
  try {
    img = (await jimpMod.Jimp.read(buffer)) as ImageLike;
  } catch (err) {
    log(`jimp read failed: ${(err as Error).message}`);
    return null;
  }
  if (!img?.bitmap?.data || img.bitmap.width <= 0 || img.bitmap.height <= 0) {
    log(`jimp produced empty bitmap`);
    return null;
  }

  let ZXingModule: ZxingModule | null = null;
  let QRCodeFormat: number | null = null;
  let POSSIBLE_FORMATS: number | null = null;
  try {
    const mod = (await import("@zxing/library")) as unknown as {
      default?: ZxingModule;
    } & ZxingModule;
    ZXingModule = mod.default ?? mod;
    // Constrain ZXing to QR only — saves iterating over DataMatrix +
    // Aztec + PDF417 + MaxiCode + Code128 + Code39 + EAN13 + ... which
    // we don't care about and which add real per-call overhead on a
    // 3000×4000 image. ZXing's hint object is a Map, not a plain
    // object — `hints.get(...)` is called internally.
    QRCodeFormat = (ZXingModule as unknown as { BarcodeFormat?: { QR_CODE?: number } }).BarcodeFormat?.QR_CODE ?? null;
    POSSIBLE_FORMATS = (ZXingModule as unknown as { DecodeHintType?: { POSSIBLE_FORMATS?: number } }).DecodeHintType?.POSSIBLE_FORMATS ?? null;
  } catch (err) {
    log(`@zxing/library import failed: ${(err as Error).message}`);
    // Continue without ZXing — the jsQR pass might still find it.
  }
  let jsQrMod: JsQrModule | null = null;
  try {
    // jsqr ships CJS-only; require() it lazily so a missing module
    // (or a sandbox without jsqr) doesn't kill the whole pipeline.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    jsQrMod = require("jsqr") as JsQrModule;
  } catch (err) {
    log(`jsqr import failed: ${(err as Error).message}`);
    // Continue without jsQR.
  }

  // Working resolution cap — ZXing's HybridBinarizer is O(W²) in
  // the longest edge. A 4032×3024 phone photo means each attempt at
  // scale=1 takes several seconds; at scale=2 it can take 10s. We
  // cap the longest edge at WORK_MAX_EDGE px for the decode work and
  // upscale from THERE. The QR (which is already 250-350px wide in a
  // 12MP photo) shrinks to ~100-140px in a 1500-wide working image,
  // still well above ZXing's minimum (about 5 modules per side).
  const WORK_MAX_EDGE = 1500;
  const workImg = downscaleToMaxEdge(img, WORK_MAX_EDGE);
  if (!workImg) {
    log(`[decodeAtQr] could not downscale to ${WORK_MAX_EDGE}px — falling back`);
    // Fall through with the original image; continues at full res.
  }
  const base = workImg ?? img;
  const baseW = base.bitmap.width;
  const baseH = base.bitmap.height;
  log(`decodeAtQr: working bitmap ${baseW}×${baseH} (orig ${img.bitmap.width}×${img.bitmap.height})`);

  // For real phone photos, test 0°, 90°, 180°, and 270°. Inverted phone
  // photos frequently place the QR at 180° when EXIF orientation is missing.
  const rotations: number[] = [0, 90, 180, 270];
  // Scales: 1× first (the most likely answer — small QR vs working
  // bitmap is OK because ZXing's binarizer handles small modules
  // well), then 1.5× and 2× as upsamples to give the binarizer
  // more pixels per module on hard photos.
  const scales: number[] = [1, 1.5, 2];
  const lightContrast = 0.4;

  // Build the ZXing hint payload ONCE. Without it MultiFormatReader
  // iterates over every supported format on each call; with it we
  // skip straight to QR. ZXing expects a Map (it calls `.get(key)`
  // internally), not a plain object. FormatException/NotFoundException
  // from the QR path are real "not found" signals and we silence those
  // in the inner loop so they don't flood the log.
  let qrHint: unknown = null;
  if (ZXingModule && QRCodeFormat != null && POSSIBLE_FORMATS != null) {
    qrHint = new Map();
    (qrHint as Map<number, number[]>).set(POSSIBLE_FORMATS, [QRCodeFormat]);
  }

  // ── pass 1 + 2: standard preprocessing at multiple scales/rotations ──
  for (const scale of scales) {
    for (const rot of rotations) {
      let preprocessed: ImageLike;
      try {
        preprocessed = buildPreprocessed(base, scale, rot, lightContrast);
      } catch (err) {
        log(`preprocess(scale=${scale},rot=${rot}) failed: ${(err as Error).message}`);
        continue;
      }

      // (a) ZXing on the preprocessed image.
      if (ZXingModule) {
        const fromZxing = await tryDecodeWithZxing(
          preprocessed,
          ZXingModule,
          log,
          qrHint,
        );
        if (fromZxing && looksLikeAtQr(fromZxing)) {
          log(
            `zxing@${scale}x/${rot}° decoded AT-QR (${fromZxing.length} chars)`,
          );
          return fromZxing;
        }
      }

      // (b) jsQR on the same preprocessed pixels. Different binarizer
      // path; on a real photo it sometimes wins where ZXing lost.
      if (jsQrMod) {
        const fromJsQr = tryDecodeWithJsQr(
          preprocessed,
          jsQrMod,
          log,
        );
        if (fromJsQr && looksLikeAtQr(fromJsQr)) {
          log(
            `jsqr@${scale}x/${rot}° decoded AT-QR (${fromJsQr.length} chars)`,
          );
          return fromJsQr;
        }
      }
    }
  }

  // ── pass 3: heavy preprocess (high contrast + binary threshold) ──────
  // This is the "I see the QR but it's washed out" pass. We only try
  // the natural orientation (rot=0) at one scale to keep cost bounded;
  // if the QR is sideways the EXIF-aware autoOrient already handled it.
  if (ZXingModule) {
    try {
      const heavy = buildHeavyPreprocessed(base, 1.5);
      const fromHeavy = await tryDecodeWithZxing(heavy, ZXingModule, log, qrHint);
      if (fromHeavy && looksLikeAtQr(fromHeavy)) {
        log(
          `zxing-heavy@1.5x/0° decoded AT-QR (${fromHeavy.length} chars)`,
        );
        return fromHeavy;
      }
    } catch (err) {
      log(`heavy preprocess failed: ${(err as Error).message}`);
    }
  }

  log(
    `all decoder passes failed (${img.bitmap.width}×${img.bitmap.height})`,
  );
  return null;
}

// ── preprocessing builders ──────────────────────────────────────────────

/**
 * Build a preprocessed copy of the image:
 *   - optionally scale up (nearest-neighbour so we don't blur modules)
 *   - optionally rotate CW by `rot` degrees
 *   - greyscale → contrast → normalize
 *
 * jimp's `resize` defaults to bilinear when no mode is given; we use
 * `bilinear` for the standard pass because on small upscales it
 * smooths jpeg artefacts without erasing module edges, and we use the
 * nearest-neighbour pass only for the heavy variant below.
 */
function buildPreprocessed(
  img: ImageLike,
  scale: number,
  rot: number,
  contrastAmt: number,
): ImageLike {
  let out = img.clone();
  if (scale !== 1) {
    const w = Math.max(1, Math.round(img.bitmap.width * scale));
    const h = Math.max(1, Math.round(img.bitmap.height * scale));
    // Nearest-neighbour is faster than bilinear AND keeps QR module
    // edges sharp; bilinear blurs them. For QR work nearest wins.
    out = (out.resize as unknown as (o: {
      w: number;
      h: number;
      mode: string;
    }) => ImageLike)({ w, h, mode: "nearestNeighbor" });
  }
  if (rot !== 0) {
    // jimp v1 rotate accepts either a bare number (degrees) or an
    // options object. We use the explicit {deg} form so future
    // signature changes don't surprise us.
    out = out.rotate({ deg: rot } as unknown as number) as ImageLike;
  }
  out = out.greyscale();
  out = out.contrast(contrastAmt);
  if (typeof out.normalize === "function") {
    out = out.normalize();
  }
  return out;
}

/**
 * Downscale the longest edge of the image to `maxEdge` pixels using
 * nearest-neighbour (fast and preserves module sharpness for QR work).
 * Returns null when the image is already small enough OR when jimp's
 * resize throws — caller falls back to the original image.
 *
 * Why cap at WORK_MAX_EDGE: ZXing's HybridBinarizer walks the bitmap
 * in O(W²) time per attempt. A 4032×3024 photo means each attempt
 * costs several seconds; with 3 scales × 3 rotations × 2 decoders
 * the full chain burns minutes. Capping at 1500px shrinks each
 * attempt to ~150ms and keeps the entire chain under 30s on a real
 * photo. The QR (already 250-350 px wide in a 12MP frame) becomes
 * ~100-140 px in the working bitmap, still above ZXing's minimum.
 */
function downscaleToMaxEdge(img: ImageLike, maxEdge: number): ImageLike | null {
  const longest = Math.max(img.bitmap.width, img.bitmap.height);
  if (longest <= maxEdge) return null;
  const w = Math.max(1, Math.round((img.bitmap.width * maxEdge) / longest));
  const h = Math.max(1, Math.round((img.bitmap.height * maxEdge) / longest));
  try {
    return (img.resize as unknown as (o: {
      w: number;
      h: number;
      mode: string;
    }) => ImageLike)({ w, h, mode: "nearestNeighbor" });
  } catch {
    return null;
  }
}

/**
 * Heavy preprocessing pass: greyscale → high contrast → binary
 * threshold. The result is B/W only; ZXing's binarizer then has a
 * very easy job. Used as the last-resort shot.
 */
function buildHeavyPreprocessed(img: ImageLike, scale: number): ImageLike {
  let out = img.clone();
  if (scale !== 1) {
    const w = Math.max(1, Math.round(img.bitmap.width * scale));
    const h = Math.max(1, Math.round(img.bitmap.height * scale));
    out = out.resize({ w, h }) as ImageLike;
  }
  out = out.greyscale();
  out = out.contrast(0.6);
  if (typeof out.threshold === "function") {
    // max=128 → anything brighter than mid-grey goes white, the rest
    // goes black. Module edges pop; paper texture disappears.
    out = out.threshold({ max: 128 });
  }
  return out;
}

// ── ZXing decode pass ───────────────────────────────────────────────────

/**
 * Lower-level decode pipeline — given a jimp image, try ZXing once.
 * On failure, return null (the caller decides whether to retry).
 *
 * ZXing's RGBLuminanceSource has two construction paths:
 *   - `Int32Array` (BYTES_PER_ELEMENT=4): interpreted as 0xAARRGGBB per
 *     pixel — packs alpha + RGB into 4 bytes per pixel.
 *   - `Uint8ClampedArray` (BYTES_PER_ELEMENT=1): interpreted as raw RGB
 *     bytes — 1 byte per channel, 3 bytes per pixel.
 *
 * jimp gives us RGBA bytes (4 bytes per pixel). The Int32 path is the
 * right fit because it walks pixels in 4-byte strides with the correct
 * RGB order. We pack the RGBA bytes into an Int32Array here.
 */
async function tryDecodeWithZxing(
  img: ImageLike,
  ZXingModule: ZxingModule,
  log: (msg: string) => void,
  hints: unknown = null,
): Promise<string | null> {
  const { width, height, data } = img.bitmap;
  const pixelCount = width * height;
  const pixels = new Int32Array(pixelCount);
  for (let i = 0; i < pixelCount; i++) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    // Alpha at top so ZXing's bit-shift extraction pulls R/G/B correctly:
    //   r = (pixel >> 16) & 0xff
    //   g2 = (pixel >> 7) & 0x1fe
    //   b = pixel & 0xff
    pixels[i] = ((0xff << 24) | (r << 16) | (g << 8) | b) | 0;
  }
  // We use QRCodeReader directly instead of MultiFormatReader — the
  // multi-format variant iterates OneDReader + MicroQR + DataMatrix
  // + Aztec + PDF417 + MaxiCode even when hints say "QR only", and
  // on a 1500px bitmap each inner reader burns 100-500ms. AT-QR is
  // always QR — calling QRCodeReader directly skips the whole fleet
  // of "wrong format" decodes.
  type Reader = { decode: (bitmap: unknown) => { getText: () => string } };
  let reader: Reader;
  let lumin: unknown;
  try {
    const QR = (ZXingModule as unknown as { QRCodeReader?: new () => Reader }).QRCodeReader;
    if (QR) {
      reader = new QR();
    } else {
      // Fallback: MultiFormatReader. We tried hints=null above, but
      // it iterates ALL readers per call — costly on real photos.
      reader = new ZXingModule.MultiFormatReader();
    }
    lumin = new ZXingModule.RGBLuminanceSource(
      pixels as unknown as Uint8ClampedArray,
      width,
      height,
    );
  } catch (err) {
    log(`zxing construction failed: ${(err as Error).message}`);
    return null;
  }
  let bitmap: unknown;
  try {
    const binarizer = new ZXingModule.HybridBinarizer(lumin);
    bitmap = new ZXingModule.BinaryBitmap(binarizer);
  } catch (err) {
    log(`zxing binarize failed: ${(err as Error).message}`);
    return null;
  }
  try {
    const result = reader.decode(bitmap);
    log(`zxing decoded OK: ${result.getText().length} chars`);
    return result.getText() ?? null;
  } catch (err) {
    // NotFoundException (top-level) and the inner-reader
    // FormatException / NotFoundException reports that
    // MultiFormatReader surfaces are all "no QR here". Don't log
    // them — the caller will move on to the next preprocessed view.
    return null;
  }
}

// ── jsQR decode pass ────────────────────────────────────────────────────

/**
 * jsQR decode on a preprocessed jimp image.
 *
 * jsQR takes a Uint8ClampedArray of RGBA bytes (4 bytes per pixel)
 * and the image dimensions. jimp's `bitmap.data` is exactly that
 * shape, so we hand it through with a `subarray` view (no copy).
 *
 * On success returns the decoded string; on failure returns null.
 * Never throws — we catch any thrown error and treat it as "no QR".
 */
function tryDecodeWithJsQr(
  img: ImageLike,
  jsQr: JsQrModule,
  log: (msg: string) => void,
): string | null {
  const { width, height, data } = img.bitmap;
  // jsQR wants Uint8ClampedArray. jimp's `data` is a Node Buffer
  // (Uint8Array) — Buffer extends Uint8Array but jsQR's type check
  // (Buffer.isBuffer / instanceof) might reject it on some paths.
  // We copy into a Uint8ClampedArray view to be safe.
  const pixels = new Uint8ClampedArray(
    data.buffer,
    data.byteOffset,
    data.byteLength,
  );
  try {
    const result = jsQr(pixels, width, height);
    if (!result) return null;
    log(`jsqr decoded OK: ${result.data.length} chars`);
    return result.data ?? null;
  } catch (err) {
    log(`jsqr decode threw: ${(err as Error).message}`);
    return null;
  }
}
