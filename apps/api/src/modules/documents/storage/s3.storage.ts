import {
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { getSignedUrl as presign } from '@aws-sdk/s3-request-presigner';
import * as path from 'path';
import {
  GetObjectResult,
  PutObjectOptions,
  StorageListResult,
  StorageService,
} from './storage-service.interface';

/**
 * S3Storage — StorageService driver for any S3-compatible object store
 * (MinIO in production, AWS S3 / Cloudflare R2 / Supabase Storage S3 gateway
 * should all work — the client is configured with `forcePathStyle: true`).
 *
 * Configuration (env):
 *   STORAGE_DRIVER=s3|minio       selects this driver (see storage.module.ts)
 *   S3_ENDPOINT                   e.g. http://minio:9000 (internal network)
 *   S3_PUBLIC_ENDPOINT            optional — endpoint the *browser* can reach;
 *                                 used ONLY for presigned URLs. When unset,
 *                                 getSignedUrl() returns '' and callers fall
 *                                 back to the authenticated download route
 *                                 (exactly like the local driver).
 *   S3_ACCESS_KEY / S3_SECRET_KEY service user scoped to the bucket
 *   S3_BUCKET                     default `docflow`
 *   S3_REGION                     default `us-east-1` (MinIO ignores it)
 *
 * Key contract is the same as LocalFilesystemStorage: POSIX-style relative
 * keys, no `..`, no leading `/`. The key scheme the application already
 * uses (`_inbox/<tenantId>/<yyyy>/<mm>/<ts>-<hash8>.<ext>` on upload,
 * `fornecedores/<slug>/<yyyy>/<STD_NAME>.<ext>` after approval) is kept
 * verbatim so `scripts/migrate-local-to-s3` is a pure 1:1 copy.
 */
@Injectable()
export class S3Storage implements StorageService, OnModuleInit {
  readonly driver = 's3' as const;

  private readonly logger = new Logger(S3Storage.name);
  private readonly client: S3Client;
  private readonly publicClient: S3Client | null;
  private readonly bucket: string;
  private readonly active: boolean;

  constructor() {
    const driver = (process.env.STORAGE_DRIVER ?? 'local').toLowerCase();
    this.active = driver === 's3' || driver === 'minio';
    this.bucket = process.env.S3_BUCKET || 'docflow';

    const endpoint = process.env.S3_ENDPOINT || undefined;
    const region = process.env.S3_REGION || 'us-east-1';
    const credentials =
      process.env.S3_ACCESS_KEY && process.env.S3_SECRET_KEY
        ? {
            accessKeyId: process.env.S3_ACCESS_KEY,
            secretAccessKey: process.env.S3_SECRET_KEY,
          }
        : undefined;

    this.client = new S3Client({
      endpoint,
      region,
      credentials,
      forcePathStyle: true,
    });

    const publicEndpoint = process.env.S3_PUBLIC_ENDPOINT || undefined;
    this.publicClient = publicEndpoint
      ? new S3Client({
          endpoint: publicEndpoint,
          region,
          credentials,
          forcePathStyle: true,
        })
      : null;
  }

  async onModuleInit(): Promise<void> {
    if (!this.active) return; // instantiated by the factory but not selected
    const maxAttempts = 5;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (await this.healthCheck()) {
        this.logger.log(
          `S3Storage ready — bucket "${this.bucket}" at ${process.env.S3_ENDPOINT ?? '(default endpoint)'}` +
            (this.publicClient ? ` (presign via ${process.env.S3_PUBLIC_ENDPOINT})` : ' (no S3_PUBLIC_ENDPOINT — presigned URLs disabled)'),
        );
        return;
      }
      this.logger.warn(
        `S3Storage: bucket "${this.bucket}" not reachable (attempt ${attempt}/${maxAttempts})`,
      );
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
    // Do NOT throw: the process stays up so /health can report storage=down
    // and the operator sees a clear signal instead of a crash loop.
    this.logger.error(
      `S3Storage: bucket "${this.bucket}" unreachable after ${maxAttempts} attempts — uploads WILL fail until fixed`,
    );
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return true;
    } catch {
      return false;
    }
  }

  async put(
    key: string,
    buffer: Buffer,
    options?: PutObjectOptions,
  ): Promise<void> {
    const Key = this.safeKey(key);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key,
        Body: buffer,
        ContentType: options?.contentType ?? guessContentType(Key),
        ContentLength: buffer.length,
        Metadata: options?.metadata,
      }),
    );
  }

  async getBuffer(key: string): Promise<GetObjectResult> {
    const Key = this.safeKey(key);
    try {
      const res = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key }),
      );
      if (!res.Body) throw new NotFoundException(`Object not found: ${key}`);
      const bytes = await res.Body.transformToByteArray();
      const buffer = Buffer.from(bytes);
      return {
        buffer,
        contentType: res.ContentType,
        size: res.ContentLength ?? buffer.length,
      };
    } catch (err) {
      if (isNotFound(err)) throw new NotFoundException(`Object not found: ${key}`);
      throw err;
    }
  }

  async remove(key: string): Promise<void> {
    const Key = this.safeKey(key);
    // DeleteObject is idempotent on S3 — missing keys return 204.
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key }));
  }

  async exists(key: string): Promise<boolean> {
    const Key = this.safeKey(key);
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key }));
      return true;
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }
  }

  /**
   * S3 has no rename: copy → verify size → delete source. A missing source
   * is treated as "already moved" (idempotent, mirrors the local driver's
   * ENOENT behaviour). On size mismatch the destination is removed so no
   * half-moved object is left behind.
   */
  async move(oldKey: string, newKey: string): Promise<void> {
    if (!oldKey || !newKey) {
      throw new Error('move() requires both oldKey and newKey');
    }
    if (oldKey === newKey) return;
    const from = this.safeKey(oldKey);
    const to = this.safeKey(newKey);

    let srcSize: number | undefined;
    try {
      const head = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: from }),
      );
      srcSize = head.ContentLength;
    } catch (err) {
      if (isNotFound(err)) return; // source already gone — idempotent
      throw err;
    }

    await this.client.send(
      new CopyObjectCommand({
        Bucket: this.bucket,
        Key: to,
        CopySource: `${this.bucket}/${encodeKeyForCopy(from)}`,
        MetadataDirective: 'COPY',
      }),
    );

    const dst = await this.client.send(
      new HeadObjectCommand({ Bucket: this.bucket, Key: to }),
    );
    if (srcSize !== undefined && dst.ContentLength !== srcSize) {
      await this.client
        .send(new DeleteObjectCommand({ Bucket: this.bucket, Key: to }))
        .catch(() => undefined);
      throw new Error(
        `move() verification failed: size mismatch ${oldKey} (${srcSize}) → ${newKey} (${dst.ContentLength})`,
      );
    }

    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: from }));
  }

  /**
   * Presigned GET URL. Signed against `S3_PUBLIC_ENDPOINT` (the host the
   * browser can reach). Without it the URL would embed the internal
   * `http://minio:9000` host and be useless outside the Docker network,
   * so we return '' and let DocumentsService fall back to the
   * authenticated `/documents/:id/download` route.
   */
  async getSignedUrl(key: string, ttlSeconds = 300): Promise<string> {
    if (!this.publicClient) return '';
    const Key = this.safeKey(key);
    const fileName = path.posix.basename(Key);
    return presign(
      this.publicClient,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key,
        ResponseContentDisposition: `inline; filename="${fileName.replace(/"/g, '')}"`,
      }),
      { expiresIn: Math.max(30, Math.min(ttlSeconds, 7 * 24 * 3600)) },
    );
  }

  /**
   * Immediate children of a prefix (delimiter `/`), used by the storage
   * tree browser. `prefix` is a POSIX directory path without leading `/`;
   * '' lists the bucket root.
   */
  async list(prefix: string): Promise<StorageListResult> {
    const clean = prefix ? this.safeKey(prefix).replace(/\/+$/, '') + '/' : '';
    const folders: StorageListResult['folders'] = [];
    const files: StorageListResult['files'] = [];
    let ContinuationToken: string | undefined;
    do {
      const res = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: clean,
          Delimiter: '/',
          ContinuationToken,
          MaxKeys: 1000,
        }),
      );
      for (const cp of res.CommonPrefixes ?? []) {
        if (!cp.Prefix) continue;
        const name = cp.Prefix.slice(clean.length).replace(/\/$/, '');
        if (name) folders.push({ name });
      }
      for (const obj of res.Contents ?? []) {
        if (!obj.Key || obj.Key === clean) continue;
        const name = obj.Key.slice(clean.length);
        if (!name || name.includes('/')) continue;
        files.push({
          name,
          size: obj.Size,
          modifiedAt: obj.LastModified?.toISOString(),
        });
      }
      ContinuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (ContinuationToken);
    return { folders, files };
  }

  /** Same sanitisation rules as LocalFilesystemStorage.resolveSafe(). */
  private safeKey(key: string): string {
    if (!key || typeof key !== 'string') {
      throw new Error('Storage key must be a non-empty string');
    }
    if (key.includes('\0')) {
      throw new Error('Storage key contains NUL byte');
    }
    const normalized = path.posix.normalize(key).replace(/^[/\\]+/, '');
    if (normalized.startsWith('..') || normalized.includes('../')) {
      throw new Error(`Unsafe storage key: ${key}`);
    }
    return normalized;
  }
}

function isNotFound(err: unknown): boolean {
  if (err instanceof S3ServiceException) {
    const status = err.$metadata?.httpStatusCode;
    return (
      status === 404 ||
      err.name === 'NoSuchKey' ||
      err.name === 'NotFound' ||
      err.name === 'NoSuchBucket'
    );
  }
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === 'NoSuchKey' || e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404;
}

/** S3 CopySource must be URL-encoded per path segment. */
function encodeKeyForCopy(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/');
}

const MIME_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  heic: 'image/heic',
  heif: 'image/heif',
  webp: 'image/webp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  csv: 'text/csv',
  json: 'application/json',
  xml: 'application/xml',
  txt: 'text/plain',
};

export function guessContentType(key: string): string {
  const ext = path.posix.extname(key).slice(1).toLowerCase();
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}
