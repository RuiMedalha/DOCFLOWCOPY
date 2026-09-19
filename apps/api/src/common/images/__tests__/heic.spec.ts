import { convertHeicToJpeg, hasHeicSignature, isHeic, normaliseHeic } from '../heic';

function ftyp(brand: string): Buffer {
  const b = Buffer.alloc(24, 0);
  b.writeUInt32BE(24, 0);
  b.write('ftyp', 4, 'ascii');
  b.write(brand, 8, 'ascii');
  return b;
}

describe('HEIC detection (Fase 2)', () => {
  it('recognises the ftyp brands iPhones write', () => {
    for (const brand of ['heic', 'heix', 'mif1', 'msf1', 'hevc']) {
      expect(hasHeicSignature(ftyp(brand))).toBe(true);
    }
  });

  it('does not flag JPEG / PDF / PNG / MP4 bytes', () => {
    expect(hasHeicSignature(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe(false);
    expect(hasHeicSignature(Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n'))).toBe(false);
    expect(hasHeicSignature(ftyp('isom'))).toBe(false); // plain MP4
    expect(hasHeicSignature(Buffer.alloc(4))).toBe(false);
  });

  it('isHeic: magic bytes win over a wrong MIME; MIME wins over extension; extension only when MIME is generic', () => {
    expect(isHeic({ buffer: ftyp('heic'), mimetype: 'image/jpeg', originalname: 'x.jpg' })).toBe(true);
    expect(isHeic({ buffer: Buffer.alloc(0), mimetype: 'image/heif', originalname: 'x.bin' })).toBe(true);
    expect(isHeic({ mimetype: 'application/octet-stream', originalname: 'IMG_0001.HEIC' })).toBe(true);
    expect(isHeic({ mimetype: '', originalname: 'IMG_0001.heif' })).toBe(true);
    expect(isHeic({ mimetype: 'image/jpeg', originalname: 'IMG_0001.heic' })).toBe(false);
    expect(isHeic({ mimetype: 'image/png', originalname: 'a.png' })).toBe(false);
  });

  it('normaliseHeic returns null for non-HEIC input without touching it', async () => {
    const out = await normaliseHeic({ buffer: Buffer.from('%PDF-1.4'), mimetype: 'application/pdf', originalname: 'a.pdf' });
    expect(out).toBeNull();
  });

  it('convertHeicToJpeg rejects undecodable bytes instead of returning garbage', async () => {
    await expect(convertHeicToJpeg(ftyp('heic'))).rejects.toThrow();
  });

  it('normaliseHeic renames to .jpg and records the original for the audit trail', async () => {
    // Stub the converter so we exercise the wrapper without a real HEIC fixture.
    jest.resetModules();
    jest.doMock('heic-convert', () => async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]), { virtual: false });
    const mod = await import('../heic');
    const out = await mod.normaliseHeic({
      buffer: ftyp('heic'),
      mimetype: 'image/heic',
      originalname: 'IMG_0007.HEIC',
      size: 24,
    });
    expect(out).toMatchObject({
      mimetype: 'image/jpeg',
      originalname: 'IMG_0007.jpg',
      size: 4,
      convertedFrom: { mimetype: 'image/heic', size: 24, originalname: 'IMG_0007.HEIC' },
    });
    expect(out!.buffer.equals(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))).toBe(true);
    jest.dontMock('heic-convert');
  });
});
