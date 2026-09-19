import { NotFoundException } from '@nestjs/common';
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { S3Storage, guessContentType } from '../s3.storage';
import { resolveStorageDriver } from '../storage.module';
import { StorageService } from '../storage-service.interface';

/**
 * S3Storage (driver=s3) — unit tests with `S3Client.prototype.send` stubbed.
 * The real MinIO round-trip (put/get/move/presign/list/policy) is covered
 * by the Fase 1 smoke script against docker-compose; here we lock down the
 * command shapes and the error mapping so a refactor cannot silently change
 * key sanitisation, NotFound semantics or the copy+verify+delete move.
 */
describe('S3Storage (driver=s3)', () => {
  const ENV = { ...process.env };
  let sent: unknown[];
  let sendMock: jest.SpyInstance;

  const notFound = () =>
    Object.assign(new Error('NotFound'), {
      name: 'NotFound',
      $metadata: { httpStatusCode: 404 },
    });

  beforeEach(() => {
    process.env.STORAGE_DRIVER = 's3';
    process.env.S3_ENDPOINT = 'http://minio:9000';
    process.env.S3_ACCESS_KEY = 'k';
    process.env.S3_SECRET_KEY = 's';
    process.env.S3_BUCKET = 'docflow';
    delete process.env.S3_PUBLIC_ENDPOINT;
    sent = [];
    sendMock = jest
      .spyOn(S3Client.prototype, 'send')
      .mockImplementation(async (cmd: unknown) => {
        sent.push(cmd);
        return {};
      });
  });

  afterEach(() => {
    sendMock.mockRestore();
    process.env = { ...ENV };
  });

  it('implements the StorageService interface', () => {
    const s: StorageService = new S3Storage();
    expect(s.driver).toBe('s3');
    for (const m of ['put', 'getBuffer', 'remove', 'exists', 'move', 'getSignedUrl', 'list', 'healthCheck']) {
      expect(typeof (s as unknown as Record<string, unknown>)[m]).toBe('function');
    }
  });

  it('put() sends PutObject with sanitised key, content-type and length', async () => {
    const s = new S3Storage();
    const body = Buffer.from('hello');
    await s.put('/_inbox/t1/2026/09/a.pdf', body, { metadata: { sha256: 'x' } });
    const cmd = sent[0] as PutObjectCommand;
    expect(cmd).toBeInstanceOf(PutObjectCommand);
    expect(cmd.input).toMatchObject({
      Bucket: 'docflow',
      Key: '_inbox/t1/2026/09/a.pdf',
      ContentType: 'application/pdf',
      ContentLength: 5,
      Metadata: { sha256: 'x' },
    });
  });

  it('rejects traversal / absolute / NUL keys before touching S3', async () => {
    const s = new S3Storage();
    await expect(s.put('../x.pdf', Buffer.from('a'))).rejects.toThrow(/Unsafe/);
    await expect(s.exists('a/../../b')).rejects.toThrow(/Unsafe/);
    await expect(s.getBuffer('a\0b')).rejects.toThrow(/NUL/);
    await expect(s.remove('')).rejects.toThrow(/non-empty/);
    expect(sent).toHaveLength(0);
  });

  it('getBuffer() maps a 404 to NotFoundException and returns bytes otherwise', async () => {
    const s = new S3Storage();
    sendMock.mockImplementationOnce(async () => {
      throw notFound();
    });
    await expect(s.getBuffer('t1/missing.pdf')).rejects.toBeInstanceOf(NotFoundException);

    sendMock.mockImplementationOnce(async (cmd: unknown) => {
      sent.push(cmd);
      return {
        Body: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) },
        ContentType: 'image/png',
        ContentLength: 3,
      };
    });
    const out = await s.getBuffer('t1/a.png');
    expect(sent.at(-1)).toBeInstanceOf(GetObjectCommand);
    expect(out).toEqual({ buffer: Buffer.from([1, 2, 3]), contentType: 'image/png', size: 3 });
  });

  it('exists() is true on HEAD 200 and false on 404; other errors propagate', async () => {
    const s = new S3Storage();
    expect(await s.exists('t1/a.pdf')).toBe(true);
    expect(sent.at(-1)).toBeInstanceOf(HeadObjectCommand);
    sendMock.mockImplementationOnce(async () => {
      throw notFound();
    });
    expect(await s.exists('t1/b.pdf')).toBe(false);
    sendMock.mockImplementationOnce(async () => {
      throw Object.assign(new Error('boom'), { name: 'InternalError', $metadata: { httpStatusCode: 500 } });
    });
    await expect(s.exists('t1/c.pdf')).rejects.toThrow('boom');
  });

  it('move() = HEAD source → Copy → HEAD dest (size verify) → Delete source', async () => {
    const s = new S3Storage();
    sendMock.mockImplementation(async (cmd: unknown) => {
      sent.push(cmd);
      if (cmd instanceof HeadObjectCommand) return { ContentLength: 42 };
      return {};
    });
    await s.move('_inbox/t1/a.pdf', 'fornecedores/edp/2026/FT_EDP_1.pdf');
    expect(sent.map((c) => c!.constructor.name)).toEqual([
      'HeadObjectCommand',
      'CopyObjectCommand',
      'HeadObjectCommand',
      'DeleteObjectCommand',
    ]);
    const copy = sent[1] as CopyObjectCommand;
    expect(copy.input).toMatchObject({
      Bucket: 'docflow',
      Key: 'fornecedores/edp/2026/FT_EDP_1.pdf',
      CopySource: 'docflow/_inbox/t1/a.pdf',
    });
    const del = sent[3] as DeleteObjectCommand;
    expect(del.input.Key).toBe('_inbox/t1/a.pdf');
  });

  it('move() URL-encodes the CopySource per segment', async () => {
    const s = new S3Storage();
    sendMock.mockImplementation(async (cmd: unknown) => {
      sent.push(cmd);
      if (cmd instanceof HeadObjectCommand) return { ContentLength: 1 };
      return {};
    });
    await s.move('_inbox/t1/FT 2026 1 é.pdf', 'x/y.pdf');
    const copy = sent[1] as CopyObjectCommand;
    expect(copy.input.CopySource).toBe('docflow/_inbox/t1/FT%202026%201%20%C3%A9.pdf');
  });

  it('move() is a no-op for identical keys and idempotent when the source is gone', async () => {
    const s = new S3Storage();
    await s.move('a/b.pdf', 'a/b.pdf');
    expect(sent).toHaveLength(0);
    sendMock.mockImplementationOnce(async () => {
      throw notFound();
    });
    await expect(s.move('a/gone.pdf', 'a/new.pdf')).resolves.toBeUndefined();
    expect(sent).toHaveLength(0);
  });

  it('move() deletes the destination and throws on size mismatch, keeping the source', async () => {
    const s = new S3Storage();
    let heads = 0;
    sendMock.mockImplementation(async (cmd: unknown) => {
      sent.push(cmd);
      if (cmd instanceof HeadObjectCommand) return { ContentLength: heads++ === 0 ? 10 : 7 };
      return {};
    });
    await expect(s.move('a/src.pdf', 'a/dst.pdf')).rejects.toThrow(/size mismatch/);
    const deletes = sent.filter((c) => c instanceof DeleteObjectCommand) as DeleteObjectCommand[];
    expect(deletes).toHaveLength(1);
    expect(deletes[0].input.Key).toBe('a/dst.pdf');
  });

  it('getSignedUrl() returns "" without S3_PUBLIC_ENDPOINT and a presigned URL with it', async () => {
    const s = new S3Storage();
    expect(await s.getSignedUrl('t1/a.pdf', 60)).toBe('');

    process.env.S3_PUBLIC_ENDPOINT = 'https://files.example.test';
    const pub = new S3Storage();
    const url = await pub.getSignedUrl('t1/2026/a.pdf', 60);
    expect(url.startsWith('https://files.example.test/docflow/t1/2026/a.pdf?')).toBe(true);
    expect(url).toContain('X-Amz-Signature=');
    expect(url).toContain('X-Amz-Expires=60');
    expect(url).toContain('response-content-disposition=');
  });

  it('list() maps CommonPrefixes to folders and Contents to files, following pagination', async () => {
    const s = new S3Storage();
    let page = 0;
    sendMock.mockImplementation(async (cmd: unknown) => {
      sent.push(cmd);
      if (!(cmd instanceof ListObjectsV2Command)) return {};
      if (page++ === 0) {
        return {
          IsTruncated: true,
          NextContinuationToken: 'tok',
          CommonPrefixes: [{ Prefix: 't1/_inbox/' }],
          Contents: [{ Key: 't1/README.md', Size: 4, LastModified: new Date('2026-09-01T00:00:00Z') }],
        };
      }
      return {
        IsTruncated: false,
        CommonPrefixes: [{ Prefix: 't1/fornecedores/' }],
        Contents: [{ Key: 't1/' }],
      };
    });
    const out = await s.list('t1');
    expect((sent[0] as ListObjectsV2Command).input).toMatchObject({ Prefix: 't1/', Delimiter: '/' });
    expect((sent[1] as ListObjectsV2Command).input.ContinuationToken).toBe('tok');
    expect(out).toEqual({
      folders: [{ name: '_inbox' }, { name: 'fornecedores' }],
      files: [{ name: 'README.md', size: 4, modifiedAt: '2026-09-01T00:00:00.000Z' }],
    });
  });

  it('healthCheck() HEADs the bucket and never throws', async () => {
    const s = new S3Storage();
    expect(await s.healthCheck()).toBe(true);
    expect(sent[0]).toBeInstanceOf(HeadBucketCommand);
    sendMock.mockImplementationOnce(async () => {
      throw new Error('ECONNREFUSED');
    });
    expect(await s.healthCheck()).toBe(false);
  });

  it('onModuleInit() is a no-op when the driver is not selected', async () => {
    process.env.STORAGE_DRIVER = 'local';
    const s = new S3Storage();
    await s.onModuleInit();
    expect(sent).toHaveLength(0);
  });
});

describe('resolveStorageDriver / guessContentType', () => {
  it.each([
    [undefined, 'local'],
    ['', 'local'],
    ['local', 'local'],
    ['s3', 's3'],
    ['MinIO', 's3'],
    ['supabase', 'local'],
    ['garbage', 'local'],
  ])('resolveStorageDriver(%p) → %s', (raw, expected) => {
    expect(resolveStorageDriver(raw as string | undefined)).toBe(expected);
  });

  it('guessContentType() covers the upload formats and falls back to octet-stream', () => {
    expect(guessContentType('a/b.PDF')).toBe('application/pdf');
    expect(guessContentType('a/b.jpeg')).toBe('image/jpeg');
    expect(guessContentType('a/b.heic')).toBe('image/heic');
    expect(guessContentType('a/b.bin')).toBe('application/octet-stream');
  });
});
