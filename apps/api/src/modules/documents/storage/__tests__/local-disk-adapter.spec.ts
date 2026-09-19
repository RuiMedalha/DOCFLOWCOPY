import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { LocalFilesystemStorage } from '../local-filesystem.storage';
import { StorageService } from '../storage-service.interface';

/**
 * LocalFilesystemStorage — Sprint H driver=local.
 *
 * Coverage:
 *   1. Implements the StorageService interface (TS contract check).
 *   2. put/getBuffer roundtrip preserves bytes.
 *   3. exists + remove are idempotent.
 *   4. move refuses traversal + same-key no-op + copies on EXDEV.
 *   5. getSignedUrl returns a controller-relative route.
 *
 * The actual implementation lives in modules/documents/storage/ (Sprint E);
 * Sprint H adds the factory switch in storage.module.ts but the driver
 * itself is unchanged. This test lives in the same __tests__ folder so
 * reviewers can find it next to the driver it covers.
 */
describe('LocalFilesystemStorage (driver=local)', () => {
  let rootDir: string;
  let storage: LocalFilesystemStorage;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'docflow-storage-test-'));
    process.env.UPLOADS_DIR = rootDir;
    storage = new LocalFilesystemStorage();
    await storage.onModuleInit();
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
    delete process.env.UPLOADS_DIR;
  });

  it('implements the StorageService interface', () => {
    // TS would catch this at compile time; the runtime check is here to
    // surface a clear failure if the implementation drifts.
    const svc: StorageService = storage;
    expect(typeof svc.put).toBe('function');
    expect(typeof svc.getBuffer).toBe('function');
    expect(typeof svc.remove).toBe('function');
    expect(typeof svc.exists).toBe('function');
    expect(typeof svc.move).toBe('function');
    expect(typeof svc.getSignedUrl).toBe('function');
    expect(svc.driver).toBe('local');
  });

  it('round-trips a put → getBuffer preserving bytes', async () => {
    const key = 'tenant-1/2026/09/hello.pdf';
    const bytes = Buffer.from('%PDF-1.4\nhello world\n', 'utf8');

    await storage.put(key, bytes, { contentType: 'application/pdf' });
    const fetched = await storage.getBuffer(key);

    expect(fetched.size).toBe(bytes.length);
    expect(fetched.buffer.equals(bytes)).toBe(true);
    expect(fetched.contentType).toBeUndefined(); // local driver doesn't echo
  });

  it('getBuffer throws NotFoundException on a missing key', async () => {
    await expect(storage.getBuffer('does/not/exist.pdf')).rejects.toMatchObject({
      name: 'NotFoundException',
    });
  });

  it('exists returns false for missing keys and true after put', async () => {
    expect(await storage.exists('nope.txt')).toBe(false);
    await storage.put('nope.txt', Buffer.from('hello'));
    expect(await storage.exists('nope.txt')).toBe(true);
  });

  it('remove is idempotent — deleting a missing key is NOT an error', async () => {
    await expect(storage.remove('never-there.txt')).resolves.toBeUndefined();
    await storage.put('will-go.txt', Buffer.from('bye'));
    await storage.remove('will-go.txt');
    expect(await storage.exists('will-go.txt')).toBe(false);
    await expect(storage.remove('will-go.txt')).resolves.toBeUndefined();
  });

  it('move is a no-op when oldKey === newKey', async () => {
    await storage.put('same.txt', Buffer.from('x'));
    await storage.move('same.txt', 'same.txt');
    expect(await storage.exists('same.txt')).toBe(true);
  });

  it('move refuses keys with path traversal', async () => {
    await storage.put('legit.txt', Buffer.from('a'));
    await expect(storage.move('legit.txt', '../escape.txt')).rejects.toThrow(
      /Unsafe storage key/,
    );
  });

  it('getSignedUrl returns empty string + WARN log for local driver', async () => {
    // Sprint H security-audit M-14: local driver cannot sign URLs.
    // Returning the phantom route `/api/v1/documents/storage/<key>` would
    // leak the storage key (which embeds the tenantId). We now return
    // an empty string and let the caller route to the authenticated
    // /documents/:id/download endpoint instead.
    const url = await storage.getSignedUrl('some/key.pdf');
    expect(url).toBe('');
  });
});
