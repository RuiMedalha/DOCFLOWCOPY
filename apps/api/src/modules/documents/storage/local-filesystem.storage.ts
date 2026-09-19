import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
  GetObjectResult,
  PutObjectOptions,
  StorageListResult,
  StorageService,
} from './storage-service.interface';

/**
 * Local-filesystem StorageService — default driver for development.
 *
 * Stores objects under `<project-root>/apps/api/uploads/` (configurable via
 * `UPLOADS_DIR`). Each object lives at `<uploadsDir>/<key>` with the key
 * being a relative POSIX path the caller built (e.g. tenantId/year/hash.ext).
 *
 * Security notes:
 *   - Keys are sanitized before joining to disk — no traversal, no absolute paths.
 *   - All writes are atomic via a temp-file rename (the public file never
 *     appears half-written).
 *   - File permissions follow the OS umask. In production, the uploads
 *     directory should sit outside the web root and be served via a
 *     controller route (we do that via `/documents/:id/download`).
 */
@Injectable()
export class LocalFilesystemStorage implements StorageService, OnModuleInit {
  readonly driver = 'local' as const;

  private readonly logger = new Logger(LocalFilesystemStorage.name);
  private readonly rootDir: string;

  constructor() {
    this.rootDir = path.resolve(
      process.env.UPLOADS_DIR ?? path.join(process.cwd(), 'uploads'),
    );
  }

  /**
   * Absolute path of the uploads root. Exposed for sibling modules that
   * need to list the filesystem (e.g. the storage tree browser) — they
   * MUST still apply tenant-scoping and path sanitization on top, never
   * trust caller-supplied keys verbatim.
   */
  get uploadsRoot(): string {
    return this.rootDir;
  }

  async onModuleInit(): Promise<void> {
    await fs.mkdir(this.rootDir, { recursive: true });
    this.logger.log(`LocalFilesystemStorage ready at ${this.rootDir}`);
  }

  async put(
    key: string,
    buffer: Buffer,
    _options?: PutObjectOptions,
  ): Promise<void> {
    const target = this.resolveSafe(key);
    await fs.mkdir(path.dirname(target), { recursive: true });

    // Atomic write: write to temp then rename. Prevents readers from seeing
    // a half-written file if the process is killed mid-upload.
    const tmp = path.join(path.dirname(target), `.${crypto.randomBytes(8).toString('hex')}.part`);
    await fs.writeFile(tmp, buffer);
    try {
      await fs.rename(tmp, target);
    } catch (err) {
      await fs.unlink(tmp).catch(() => undefined);
      throw err;
    }
  }

  async getBuffer(key: string): Promise<GetObjectResult> {
    const target = this.resolveSafe(key);
    try {
      const buffer = await fs.readFile(target);
      const stat = await fs.stat(target);
      return { buffer, size: stat.size };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new NotFoundException(`Object not found: ${key}`);
      }
      throw err;
    }
  }

  async remove(key: string): Promise<void> {
    const target = this.resolveSafe(key);
    try {
      await fs.unlink(target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      // idempotent: missing key is fine
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await fs.access(this.resolveSafe(key));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Move an object between storage keys. Tries native `rename` first (atomic
   * in POSIX/Linux and on the same Windows volume); on `EXDEV` (cross-volume)
   * or any other failure, falls back to copy + size-verify + unlink. The
   * destination folder is created on demand.
   *
   * Idempotency: `oldKey === newKey` is a no-op.
   *
   * Sprint E uses this from DocumentsService.approve() to relocate files
   * out of `_inbox/` into the party/category folder without copying bytes
   * through the controller.
   */
  async move(oldKey: string, newKey: string): Promise<void> {
    if (!oldKey || !newKey) {
      throw new Error('move() requires both oldKey and newKey');
    }
    if (oldKey === newKey) return;

    const from = this.resolveSafe(oldKey);
    const to = this.resolveSafe(newKey);

    // Ensure destination directory exists before any rename / copy.
    await fs.mkdir(path.dirname(to), { recursive: true });

    // Prefer atomic rename when both keys live on the same filesystem.
    try {
      await fs.rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // EXDEV = cross-device link (rename can't span volumes). Any other
      // error is unexpected — propagate after best-effort cleanup below.
      if (code !== 'EXDEV') {
        // ENOENT at source is the typical "file already gone" race — treat
        // as idempotent and let the caller decide. Anything else is fatal.
        if (code === 'ENOENT') return;
        throw err;
      }
    }

    // Cross-volume fallback: copy + verify size + unlink source. If the
    // size check fails we DELETE the partial destination so we never leave a
    // half-moved file behind — the caller can retry with a fresh key.
    await fs.copyFile(from, to);
    const [srcStat, dstStat] = await Promise.all([fs.stat(from), fs.stat(to)]);
    if (srcStat.size !== dstStat.size) {
      await fs.unlink(to).catch(() => undefined);
      throw new Error(
        `move() verification failed: size mismatch ${oldKey} (${srcStat.size}) → ${newKey} (${dstStat.size})`,
      );
    }
    await fs.unlink(from);
  }

  async getSignedUrl(key: string, _ttlSeconds?: number): Promise<string> {
    // Sprint H security-audit M-14 — the previous implementation
    // returned `/api/v1/documents/storage/<encoded key>` which is NOT
    // a registered route. The only real download endpoint is
    // `GET /documents/:id/download` and it takes a documentId, NOT a
    // storage key. Returning the phantom URL silently leaked the
    // storage key (which embeds the tenantId in its path).
    //
    // Local driver has no signing facility. Return the storage root as
    // a path the controller can use to map back to the documentId, but
    // log a WARN so the caller knows to resolve via the documentId
    // endpoint instead.
    //
    // Callers (DocumentsService) handle the null/empty return by
    // routing the UI to the authenticated `/documents/:id/download`
    // route directly.
    this.logger.warn(
      `[getSignedUrl] local driver cannot sign keys (key="${key}"); ` +
        `callers must resolve documentId and use GET /documents/:id/download`,
    );
    return '';
  }

  async healthCheck(): Promise<boolean> {
    try {
      await fs.access(this.rootDir);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Immediate children of `<root>/<prefix>`. A missing directory yields an
   * empty listing (the UI renders an "empty" state) — same semantics as the
   * S3 driver, where a prefix with no objects simply lists nothing.
   * Symlinks and special files are skipped so they can never become a
   * traversal vector.
   */
  async list(prefix: string): Promise<StorageListResult> {
    const absolute = prefix ? this.resolveSafe(prefix) : this.rootDir;
    let dirents: import('fs').Dirent[];
    try {
      dirents = await fs.readdir(absolute, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { folders: [], files: [] };
      }
      throw err;
    }
    const folders: StorageListResult['folders'] = [];
    const files: StorageListResult['files'] = [];
    for (const d of dirents) {
      if (d.isDirectory()) {
        folders.push({ name: d.name });
      } else if (d.isFile()) {
        const stat = await fs.stat(path.join(absolute, d.name)).catch(() => null);
        files.push({
          name: d.name,
          size: stat?.size,
          modifiedAt: stat?.mtime?.toISOString(),
        });
      }
    }
    return { folders, files };
  }

  /**
   * Sanitize a caller-supplied key and join it under the uploads root.
   * Throws on traversal attempts or absolute paths.
   */
  private resolveSafe(key: string): string {
    if (!key || typeof key !== 'string') {
      throw new Error('Storage key must be a non-empty string');
    }
    if (key.includes('\0')) {
      throw new Error('Storage key contains NUL byte');
    }
    // Normalize: reject absolute, reject traversal segments.
    const normalized = path.posix.normalize(key).replace(/^[/\\]+/, '');
    if (normalized.startsWith('..') || normalized.includes('../')) {
      throw new Error(`Unsafe storage key: ${key}`);
    }
    const resolved = path.resolve(this.rootDir, normalized);
    if (!resolved.startsWith(this.rootDir)) {
      throw new Error(`Storage key escapes root: ${key}`);
    }
    return resolved;
  }
}