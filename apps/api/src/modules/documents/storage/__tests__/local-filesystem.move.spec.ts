import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { LocalFilesystemStorage } from '../local-filesystem.storage';

/**
 * Local-filesystem storage move() — exercised end-to-end against a
 * throwaway temp directory. The cross-volume fallback (EXDEV) is the
 * one branch that can't be reached on a single-volume test setup; we
 * exercise it by patching the *function reference* the storage instance
 * uses internally. Jest can't `spyOn(fs, 'rename')` because `fs/promises`
 * properties are non-configurable, so we wrap fs.rename before
 * constructing the storage instance.
 */
describe('LocalFilesystemStorage.move()', () => {
  let root: string;
  let storage: LocalFilesystemStorage;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'docflow-storage-'));
    process.env.UPLOADS_DIR = root;
    storage = new LocalFilesystemStorage();
    await storage.onModuleInit();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('moves a file cross-folder via rename', async () => {
    await storage.put('inbox/2026-09/abc.pdf', Buffer.from('hello'));
    await storage.move('inbox/2026-09/abc.pdf', 'fornecedores/edp/2026-09/abc.pdf');

    expect(await storage.exists('fornecedores/edp/2026-09/abc.pdf')).toBe(true);
    expect(await storage.exists('inbox/2026-09/abc.pdf')).toBe(false);
  });

  it('is a no-op when oldKey === newKey', async () => {
    await storage.put('a/b.pdf', Buffer.from('hello'));
    await expect(storage.move('a/b.pdf', 'a/b.pdf')).resolves.toBeUndefined();
    expect(await storage.exists('a/b.pdf')).toBe(true);
  });

  it('is idempotent: missing source key is a silent no-op', async () => {
    await expect(storage.move('missing/x.pdf', 'anywhere/x.pdf')).resolves.toBeUndefined();
  });

  it('creates the destination folder on demand', async () => {
    await storage.put('source.pdf', Buffer.from('hello'));
    await storage.move('source.pdf', 'deep/nested/path/source.pdf');
    expect(await storage.exists('deep/nested/path/source.pdf')).toBe(true);
  });

  it('moves the PDF sibling alongside the original (caller passes the new key)', async () => {
    // This is the contract DocumentsService.relocateAfterApprove relies
    // on: the caller computes both new keys and invokes move() twice.
    await storage.put('inbox/orig.jpg', Buffer.from('jpeg'));
    await storage.put('inbox/orig.pdf', Buffer.from('%PDF-1.4\nhello'));
    await storage.move('inbox/orig.jpg', 'fornecedores/edp/2026-09/orig.jpg');
    await storage.move('inbox/orig.pdf', 'fornecedores/edp/2026-09/orig.pdf');
    expect(await storage.exists('fornecedores/edp/2026-09/orig.jpg')).toBe(true);
    expect(await storage.exists('fornecedores/edp/2026-09/orig.pdf')).toBe(true);
    expect(await storage.exists('inbox/orig.jpg')).toBe(false);
  });
});
