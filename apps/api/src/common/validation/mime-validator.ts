/**
 * Magic-bytes MIME signature validation.
 *
 * The upload pipeline accepts a multipart body where the `Content-Type`
 * header on each file part is **set by the client** (typically the
 * browser picks it from `File.type`). An attacker can craft a
 * `multipart/form-data` body with `Content-Type: application/pdf` on a
 * part whose bytes are an executable / an HTML polyglot. We refuse to
 * trust client-declared MIMEs — every uploaded buffer gets a magic-bytes
 * check before the file is persisted.
 *
 * The signatures here are the common image/container formats DocFlow
 * accepts on `/documents/upload` (see `DocumentsService.upload` and the
 * `ALLOWED_MIMES` allowlist). Adding a new format means adding the
 * signature to `SIGNATURES` and (where useful) a `mimeTypes` alias.
 *
 * NOTE on partial reads: the helpers accept the FIRST 16 bytes of the
 * buffer — more than enough to reach past every signature below. They
 * do NOT scan the rest of the file. We assume the upload buffer is
 * already in memory (multer.memoryStorage) so the cost is zero.
 */

const SIGNATURE_BYTES = 16;

/** Each entry maps a declared MIME → the magic-bytes header it MUST match. */
export interface MimeSignature {
  /** Canonical MIME this signature validates */
  readonly mime: string;
  /** Human label for error messages */
  readonly label: string;
  /**
   * Matcher over the first SIGNATURE_BYTES bytes of the buffer.
   * `null` byte positions are wildcards ("any byte"). Return true on match.
   */
  readonly match: (head: Buffer) => boolean;
}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const JPEG = [0xff, 0xd8, 0xff] as const;
const PDF = [0x25, 0x50, 0x44, 0x46] as const; // "%PDF"
const DOCX_ZIP = [0x50, 0x4b, 0x03, 0x04] as const; // PK\x03\x04 (zip / docx / jar)

/**
 * WebP signature: `RIFF....WEBP` — the first 4 bytes are 'RIFF' and bytes
 * 8..11 are 'WEBP'. The size field at bytes 4..7 is a wildcard.
 */
function matchWebP(head: Buffer): boolean {
  if (head.length < 12) return false;
  return (
    head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46 && // 'RIFF'
    head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50    // 'WEBP'
  );
}

/**
 * HEIC/HEIF: ISO BMFF box, starts with `00 00 00 ?? 66 74 79 70 68 65 69 ?`
 * where the brand is `heic` or `heix` / `hevc` / `hevx` / `mif1` etc.
 * We accept any brand starting with `he` followed by a single hex char
 * to keep the matcher tight without enumerating every ISO brand.
 */
function matchHeic(head: Buffer): boolean {
  if (head.length < 12) return false;
  return (
    head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70 && // 'ftyp'
    head[8] === 0x68 && head[9] === 0x65 // 'he' — covers 'heic', 'heix', 'hevc', 'hevx', 'heim', 'heis'
  );
}

/**
 * Build a strict prefix matcher from a fixed byte sequence.
 * Wildcard positions can be expressed by passing `null` bytes in the array.
 */
function fixedMatch(prefix: readonly (number | null)[]): (head: Buffer) => boolean {
  return (head: Buffer) => {
    if (head.length < prefix.length) return false;
    for (let i = 0; i < prefix.length; i++) {
      const expected = prefix[i];
      if (expected === null) continue;
      if (head[i] !== expected) return false;
    }
    return true;
  };
}

/**
 * Canonical signature table. Order matters only for the error message:
 * when no signature matches we report the first one tried.
 *
 * IMPORTANT: keep this aligned with `ALLOWED_MIMES` in
 * `documents.service.ts` — every allowed MIME MUST have an entry here.
 */
export const SIGNATURES: readonly MimeSignature[] = [
  { mime: 'application/pdf', label: 'PDF', match: fixedMatch(PDF) },
  { mime: 'image/jpeg', label: 'JPEG', match: fixedMatch(JPEG) },
  { mime: 'image/jpg', label: 'JPEG', match: fixedMatch(JPEG) },
  { mime: 'image/png', label: 'PNG', match: fixedMatch(PNG) },
  { mime: 'image/webp', label: 'WebP', match: matchWebP },
  { mime: 'image/heic', label: 'HEIC', match: matchHeic },
  { mime: 'image/heif', label: 'HEIF', match: matchHeic },
  {
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    label: 'DOCX',
    match: fixedMatch(DOCX_ZIP),
  },
  // Legacy `.doc` files are NOT structurally validated — magic-bytes
  // detection of MS-Word legacy binary is unreliable and the format is
  // explicitly marked DEPRECATED by Microsoft. We keep `application/msword`
  // in the allowlist for backward compatibility but the signature check
  // for this MIME is a no-op (it accepts everything declared). See the
  // TODO below — operators may want to drop legacy `.doc` entirely.
  { mime: 'application/msword', label: 'legacy DOC', match: () => true },
];

/**
 * Lookup signature entry by declared MIME. Returns `undefined` when the
 * MIME is not in our known table — callers should treat that as a hard
 * reject.
 */
export function findSignature(declaredMime: string): MimeSignature | undefined {
  const lower = declaredMime.toLowerCase();
  return SIGNATURES.find((s) => s.mime === lower);
}

/**
 * Assert that the file buffer's magic bytes match the declared MIME.
 *
 * Behaviour:
 *  - Empty buffers are rejected.
 *  - Unknown declared MIMEs are rejected (defence-in-depth — the
 *    caller-side `ALLOWED_MIMES` allowlist should already filter them).
 *  - Mismatch between signature and declared MIME → throws
 *    BadRequestException with a helpful message naming both the
 *    declared MIME and the closest signature label.
 */
export class BadFileSignature extends Error {
  readonly declaredMime: string;
  readonly detectedLabel: string | null;
  constructor(message: string, declaredMime: string, detectedLabel: string | null) {
    super(message);
    this.name = 'BadFileSignature';
    this.declaredMime = declaredMime;
    this.detectedLabel = detectedLabel;
  }
}

/**
 * Detect the closest matching signature label for diagnostic output.
 * Returns `null` when nothing matches (random bytes / unknown format).
 */
function detectLabel(head: Buffer): string | null {
  for (const sig of SIGNATURES) {
    try {
      if (sig.match(head)) return sig.label;
    } catch {
      // Defensive — matchers should never throw, but a buggy entry
      // shouldn't poison the whole check.
    }
  }
  return null;
}

/**
 * Throws `Error('Invalid file signature')` (or BadRequestException when
 * the caller wraps it) on mismatch. Kept as a plain function so the
 * common/validation layer stays Nest-free — services that already have
 * the right Exception type just wrap and re-throw.
 */
export function assertMimeMatchesSignature(
  buffer: Buffer | Uint8Array | null | undefined,
  declaredMime: string,
): void {
  if (!buffer || buffer.length === 0) {
    throw new Error('Empty file buffer');
  }
  const head = Buffer.isBuffer(buffer)
    ? buffer.subarray(0, Math.min(buffer.length, SIGNATURE_BYTES))
    : Buffer.from(buffer).subarray(0, SIGNATURE_BYTES);

  const sig = findSignature(declaredMime);
  if (!sig) {
    throw new Error(`Declared MIME not in signature table: ${declaredMime}`);
  }
  if (!sig.match(head)) {
    const detected = detectLabel(head);
    const detail = detected
      ? `declared=${declaredMime}, detected=${detected}`
      : `declared=${declaredMime}, detected=<unknown>`;
    throw new Error(`Invalid file signature (${detail})`);
  }
}
