/**
 * HEIC/HEIF support — Fase 2.
 *
 * iPhones send `image/heic` (sometimes `application/octet-stream` with a
 * `.heic` extension). Nothing downstream (jimp/ZXing, pdf-lib, the vision
 * providers, browsers) reads HEIC, so we normalise to JPEG at the ingestion
 * boundary: the JPEG bytes become the canonical document (hash, storage,
 * PDF derivative, extraction) and the HEIC original is not kept.
 *
 * Detection is by magic bytes (`....ftyphe??` / `ftypmif1`), then by MIME,
 * then by extension — in that order — so a mislabelled file still converts.
 */
import { Logger } from '@nestjs/common';

export const HEIC_MIMES = new Set(['image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence']);
const HEIC_EXTENSIONS = new Set(['heic', 'heif', 'hif']);
const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1', 'heif']);

export function hasHeicSignature(buffer: Buffer): boolean {
  if (!buffer || buffer.length < 12) return false;
  if (buffer.toString('ascii', 4, 8) !== 'ftyp') return false;
  const brand = buffer.toString('ascii', 8, 12).toLowerCase();
  return HEIC_BRANDS.has(brand);
}

export function isHeic(input: { buffer?: Buffer; mimetype?: string; originalname?: string }): boolean {
  if (input.buffer && hasHeicSignature(input.buffer)) return true;
  const mime = (input.mimetype ?? '').toLowerCase();
  if (HEIC_MIMES.has(mime)) return true;
  const ext = (input.originalname ?? '').split('.').pop()?.toLowerCase();
  if (ext && HEIC_EXTENSIONS.has(ext) && (mime === '' || mime === 'application/octet-stream' || HEIC_MIMES.has(mime))) {
    return true;
  }
  return false;
}

export interface NormalisedImage {
  buffer: Buffer;
  mimetype: 'image/jpeg';
  originalname: string;
  size: number;
  /** Original bytes/MIME, for the audit trail. */
  convertedFrom: { mimetype: string; size: number; originalname: string };
}

/**
 * Convert a HEIC/HEIF buffer to JPEG. Throws on undecodable input so the
 * caller can reject the upload with a clear 400 instead of storing bytes
 * nothing can read.
 */
export async function convertHeicToJpeg(
  buffer: Buffer,
  quality = 0.9,
  logger?: Logger,
): Promise<Buffer> {
  type Converter = (o: { buffer: Buffer; format: 'JPEG' | 'PNG'; quality?: number }) => Promise<ArrayBuffer | Buffer>;
  const mod = (await import('heic-convert')) as unknown as Converter | { default?: Converter };
  const convert: Converter | undefined =
    typeof mod === 'function' ? mod : (mod as { default?: Converter }).default;
  if (!convert) throw new Error('heic-convert module did not export a converter');
  const started = Date.now();
  const out = await convert({ buffer, format: 'JPEG', quality });
  const jpeg = Buffer.isBuffer(out) ? out : Buffer.from(out);
  logger?.log(`heic→jpeg: in=${buffer.length}B out=${jpeg.length}B in ${Date.now() - started}ms`);
  return jpeg;
}

/**
 * If `file` is HEIC/HEIF, return a JPEG replacement; otherwise return null
 * (caller keeps the original untouched).
 */
export async function normaliseHeic(
  file: { buffer: Buffer; mimetype: string; originalname: string; size?: number },
  logger?: Logger,
): Promise<NormalisedImage | null> {
  if (!isHeic(file)) return null;
  const jpeg = await convertHeicToJpeg(file.buffer, 0.9, logger);
  const base = file.originalname.replace(/\.(heic|heif|hif)$/i, '') || 'photo';
  return {
    buffer: jpeg,
    mimetype: 'image/jpeg',
    originalname: `${base}.jpg`,
    size: jpeg.length,
    convertedFrom: {
      mimetype: file.mimetype,
      size: file.size ?? file.buffer.length,
      originalname: file.originalname,
    },
  };
}
