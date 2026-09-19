/**
 * migrate-local-to-s3 — copy every object from the local filesystem driver
 * (UPLOADS_DIR) into the S3/MinIO bucket, preserving keys 1:1.
 *
 * Idempotent: objects already present in the bucket with the same size are
 * skipped; re-running after a partial migration only copies what is missing.
 * Local files are NEVER deleted — remove the volume manually once the S3
 * driver has been in production for a while.
 *
 * Runs with plain Node (no Nest bootstrap) so it can be executed inside the
 * production container:
 *
 *   node dist/src/scripts/migrate-local-to-s3.js [--dry-run] [--verify]
 *
 * Env (same as the S3Storage driver): UPLOADS_DIR, S3_ENDPOINT, S3_ACCESS_KEY,
 * S3_SECRET_KEY, S3_BUCKET, S3_REGION.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash } from 'crypto';
import {
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { guessContentType } from '../modules/documents/storage/s3.storage';

interface Summary {
  scanned: number;
  copied: number;
  skipped: number;
  failed: number;
  bytes: number;
}

async function* walk(dir: string): AsyncGenerator<string> {
  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      yield* walk(full);
    } else if (e.isFile()) {
      // Skip in-progress atomic writes of the local driver.
      if (e.name.startsWith('.') && e.name.endsWith('.part')) continue;
      yield full;
    }
  }
}

async function headSize(client: S3Client, bucket: string, key: string): Promise<number | null> {
  try {
    const res = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return res.ContentLength ?? 0;
  } catch (err) {
    const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (e?.name === 'NotFound' || e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404) {
      return null;
    }
    throw err;
  }
}

export async function migrateLocalToS3(opts: {
  uploadsDir: string;
  bucket: string;
  client: S3Client;
  dryRun?: boolean;
  verify?: boolean;
  log?: (msg: string) => void;
}): Promise<Summary> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const root = path.resolve(opts.uploadsDir);
  const summary: Summary = { scanned: 0, copied: 0, skipped: 0, failed: 0, bytes: 0 };

  for await (const file of walk(root)) {
    summary.scanned++;
    const key = path.relative(root, file).split(path.sep).join('/');
    try {
      const stat = await fs.stat(file);
      const existing = await headSize(opts.client, opts.bucket, key);
      if (existing !== null && existing === stat.size) {
        summary.skipped++;
        continue;
      }
      if (opts.dryRun) {
        log(`[dry-run] would copy ${key} (${stat.size} B)${existing !== null ? ' (size differs in bucket)' : ''}`);
        summary.copied++;
        summary.bytes += stat.size;
        continue;
      }
      const body = await fs.readFile(file);
      await opts.client.send(
        new PutObjectCommand({
          Bucket: opts.bucket,
          Key: key,
          Body: body,
          ContentLength: body.length,
          ContentType: guessContentType(key),
          Metadata: {
            'migrated-from': 'local',
            'sha256': createHash('sha256').update(body).digest('hex'),
          },
        }),
      );
      if (opts.verify) {
        const after = await headSize(opts.client, opts.bucket, key);
        if (after !== body.length) {
          throw new Error(`size mismatch after upload: local=${body.length} bucket=${after}`);
        }
      }
      summary.copied++;
      summary.bytes += body.length;
      log(`copied ${key} (${body.length} B)`);
    } catch (err) {
      summary.failed++;
      log(`FAILED ${key}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return summary;
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const dryRun = args.has('--dry-run');
  const verify = args.has('--verify') || !dryRun;

  const uploadsDir = process.env.UPLOADS_DIR ?? path.join(process.cwd(), 'uploads');
  const bucket = process.env.S3_BUCKET || 'docflow';
  if (!process.env.S3_ENDPOINT) {
    console.error('S3_ENDPOINT is required');
    process.exit(2);
  }
  const client = new S3Client({
    endpoint: process.env.S3_ENDPOINT,
    region: process.env.S3_REGION || 'us-east-1',
    forcePathStyle: true,
    credentials:
      process.env.S3_ACCESS_KEY && process.env.S3_SECRET_KEY
        ? { accessKeyId: process.env.S3_ACCESS_KEY, secretAccessKey: process.env.S3_SECRET_KEY }
        : undefined,
  });

  console.log(`migrate-local-to-s3: ${uploadsDir} -> s3://${bucket} (${dryRun ? 'DRY RUN' : 'live'})`);
  const s = await migrateLocalToS3({ uploadsDir, bucket, client, dryRun, verify });
  console.log(
    `done: scanned=${s.scanned} copied=${s.copied} skipped=${s.skipped} failed=${s.failed} bytes=${s.bytes}`,
  );
  process.exit(s.failed > 0 ? 1 : 0);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
