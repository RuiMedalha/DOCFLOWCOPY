import { assertMimeMatchesSignature } from '../mime-validator';

/**
 * Build the canonical head buffer for the signatures declared in
 * `mime-validator.ts`. Each helper returns AT LEAST 16 bytes so the
 * matchers can see past the longest signature (DOCX PNG = 8 bytes, but
 * we keep the table at 16 for safety).
 */
function pngHeader(): Buffer {
  // 89 50 4E 47 0D 0A 1A 0A + trailing zeros
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0]);
}

function jpegHeader(): Buffer {
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
}

function pdfHeader(): Buffer {
  // % P D F - 1 . 4 \n
  return Buffer.from('%PDF-1.4\n', 'utf8');
}

function webpHeader(): Buffer {
  // 'RIFF' + 4 size bytes (zero) + 'WEBP'
  return Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
}

function heicHeader(): Buffer {
  // 00 00 00 18 ftyp heic
  return Buffer.from([
    0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63,
  ]);
}

describe('assertMimeMatchesSignature', () => {
  it('accepts a PNG file declared as image/png', () => {
    expect(() => assertMimeMatchesSignature(pngHeader(), 'image/png')).not.toThrow();
  });

  it('rejects a PNG file declared as application/pdf (mismatch)', () => {
    expect(() => assertMimeMatchesSignature(pngHeader(), 'application/pdf')).toThrow(
      /Invalid file signature/,
    );
  });

  it('accepts a valid PDF declared as application/pdf', () => {
    expect(() => assertMimeMatchesSignature(pdfHeader(), 'application/pdf')).not.toThrow();
  });

  it('rejects an empty buffer', () => {
    expect(() => assertMimeMatchesSignature(Buffer.alloc(0), 'application/pdf')).toThrow(
      /Empty/,
    );
  });

  it('rejects random bytes for any declared MIME', () => {
    const random = Buffer.from([0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0]);
    expect(() => assertMimeMatchesSignature(random, 'application/pdf')).toThrow(
      /Invalid file signature/,
    );
    expect(() => assertMimeMatchesSignature(random, 'image/png')).toThrow(
      /Invalid file signature/,
    );
  });

  it('accepts a JPEG declared as image/jpeg (or image/jpg)', () => {
    expect(() => assertMimeMatchesSignature(jpegHeader(), 'image/jpeg')).not.toThrow();
    expect(() => assertMimeMatchesSignature(jpegHeader(), 'image/jpg')).not.toThrow();
  });

  it('rejects a PDF declared as image/jpeg (mismatch)', () => {
    expect(() => assertMimeMatchesSignature(pdfHeader(), 'image/jpeg')).toThrow(
      /Invalid file signature/,
    );
  });

  it('accepts a WebP declared as image/webp', () => {
    expect(() => assertMimeMatchesSignature(webpHeader(), 'image/webp')).not.toThrow();
  });

  it('accepts an HEIC declared as image/heic or image/heif', () => {
    expect(() => assertMimeMatchesSignature(heicHeader(), 'image/heic')).not.toThrow();
    expect(() => assertMimeMatchesSignature(heicHeader(), 'image/heif')).not.toThrow();
  });

  it('rejects unknown declared MIME (not in signature table)', () => {
    expect(() => assertMimeMatchesSignature(pngHeader(), 'application/x-evil')).toThrow(
      /not in signature table/,
    );
  });

  it('treats null/undefined buffer as empty', () => {
    expect(() => assertMimeMatchesSignature(undefined, 'application/pdf')).toThrow(/Empty/);
    expect(() => assertMimeMatchesSignature(null, 'application/pdf')).toThrow(/Empty/);
  });

  it('is case-insensitive on the declared MIME', () => {
    expect(() => assertMimeMatchesSignature(pngHeader(), 'IMAGE/PNG')).not.toThrow();
    expect(() => assertMimeMatchesSignature(pdfHeader(), 'Application/PDF')).not.toThrow();
  });
});
