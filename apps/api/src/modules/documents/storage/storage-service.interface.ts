/**
 * StorageService — provider-agnostic object-storage interface.
 *
 * Designed so that the LocalFilesystem driver (default in dev) and an S3 /
 * MinIO driver can swap without changing business code. Every driver
 * implements the same minimal surface; key shape is opaque to callers.
 *
 * Key contract:
 *   - Keys are POSIX-style relative paths, e.g. `<tenantId>/<yyyy>/<...>`
 *   - Keys MUST be safe (no `..`, no leading `/`). Drivers may prefix with
 *     a bucket; they MUST NOT trust caller input verbatim.
 *   - getBuffer() throws NotFoundException if the object is missing.
 *   - getSignedUrl() is best-effort: local driver returns a relative path,
 *     S3/MinIO driver returns a presigned URL with TTL.
 */

export interface PutObjectOptions {
  contentType?: string;
  metadata?: Record<string, string>;
}

export interface GetObjectResult {
  buffer: Buffer;
  contentType?: string;
  size: number;
}

export interface StorageListEntry {
  name: string;
  size?: number;
  modifiedAt?: string;
}

export interface StorageListResult {
  folders: StorageListEntry[];
  files: StorageListEntry[];
}

export interface StorageService {
  /**
   * Persist `buffer` at `key`. Overwrites if it exists (object storage is
   * key/value; we never rely on partial updates).
   */
  put(key: string, buffer: Buffer, options?: PutObjectOptions): Promise<void>;

  /**
   * Stream the bytes back. Implementations must throw NotFoundException
   * (NOT a generic Error) when the key is missing — the controller maps
   * that to HTTP 404.
   */
  getBuffer(key: string): Promise<GetObjectResult>;

  /**
   * Remove an object. Idempotent — deleting a missing key is NOT an error.
   */
  remove(key: string): Promise<void>;

  /**
   * Cheap existence probe. Used by health checks and the cleanup job.
   */
  exists(key: string): Promise<boolean>;

  /**
   * Move an object from `oldKey` to `newKey` atomically. Sprint E uses this
   * to relocate approved documents from `_inbox/` to the party/category
   * folder without copying bytes through the controller. Implementations must:
   *   - Refuse if `oldKey === newKey` (no-op).
   *   - Verify size after copy-fallback (size mismatch ⇒ throw + cleanup dest).
   *   - Be safe across volumes: prefer native `rename` when possible, fall
   *     back to copy+verify+unlink otherwise.
   */
  move(oldKey: string, newKey: string): Promise<void>;

  /**
   * Return a URL the client can use to fetch the file. Local driver
   * returns the controller route `/api/v1/documents/<id>/download`. S3/MinIO
   * returns a presigned URL. Returned value is opaque to callers — only
   * the controller surfaces it to the user.
   */
  getSignedUrl(key: string, ttlSeconds?: number): Promise<string>;

  /**
   * Immediate children (folders + files) of a directory-like prefix.
   * `prefix` is a POSIX path relative to the storage root ('' = root).
   * Used by the storage tree browser; optional so test doubles that only
   * exercise put/get/move don't have to implement it.
   */
  list?(prefix: string): Promise<StorageListResult>;

  /**
   * Cheap reachability probe for /health (bucket HEAD, root dir access).
   * Optional for the same reason as `list`.
   */
  healthCheck?(): Promise<boolean>;

  /**
   * Driver label for logging/metrics.
   *
   * `supabase` was added (security-audit M-13 / SCOUT §2.2) even
   * though no driver implementation ships yet — the storage factory
   * already reads `STORAGE_DRIVER` and falls back to `local` with a
   * loud log for any other value, so listing it here is documentation
   * of the public contract rather than a runtime change.
   */
  readonly driver: 'local' | 's3' | 'minio' | 'supabase';
}

/** Nest DI token for the provider-agnostic storage interface. */
export const StorageService = Symbol('StorageService');
