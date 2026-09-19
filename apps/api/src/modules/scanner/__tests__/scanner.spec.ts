import { ScannerService } from '../scanner.service';

/**
 * Tests for ScannerService — chokidar file watcher that turns
 * filesystem drops into Document rows through InboundService.ingestFiles
 * with `origin: SCANNER`.
 *
 * The integration surface (chokidar events + InboundService) is mocked
 * here so the spec exercises only the routing / prefix-parse /
 * tenant-resolution logic, which is where the file-watcher-specific
 * behaviour lives.
 */

interface IngestCall {
  tenantId: string;
  files: Array<{
    buffer: Buffer;
    originalname: string;
    mimetype: string;
    size: number;
  }>;
  origin: string;
  metadata: Record<string, unknown>;
}

function makeFixture() {
  const ingestCalls: IngestCall[] = [];
  const inbound = {
    ingestFiles: jest.fn(async (tenantId: string, files: any[], origin: any, metadata: any) => {
      ingestCalls.push({ tenantId, files, origin, metadata });
      return [{ id: 'doc-1' }];
    }),
  };
  const tenants = new Map<string, { id: string; active: boolean }>();
  tenants.set('tenant-a', { id: 'tenant-a', active: true });
  tenants.set('tenant-inactive', { id: 'tenant-inactive', active: false });
  const prisma = {
    tenant: {
      findUnique: jest.fn(async ({ where }: any) => tenants.get(where.id) ?? null),
    },
  } as any;
  const service = new ScannerService(prisma, inbound as any);
  (service as any).watchPath = '/tmp/scanner';
  return { service, ingestCalls };
}

describe('ScannerService.handleAdd', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it('rejects filenames without a tenant prefix', async () => {
    const { service, ingestCalls } = makeFixture();
    await (service as any).handleAdd('/tmp/scanner/badfile.pdf');
    expect(ingestCalls).toHaveLength(0);
  });

  it('skips files belonging to inactive tenants', async () => {
    const { service, ingestCalls } = makeFixture();
    const fsPromises = require('node:fs').promises as any;
    jest
      .spyOn(fsPromises, 'readFile')
      .mockResolvedValue(Buffer.from('not-a-real-pdf'));
    await (service as any).handleAdd('/tmp/scanner/tenant-inactive__doc.pdf');
    expect(ingestCalls).toHaveLength(0);
  });

  it('skips files with unsupported extensions', async () => {
    const { service, ingestCalls } = makeFixture();
    const fsPromises = require('node:fs').promises as any;
    jest.spyOn(fsPromises, 'readFile').mockResolvedValue(Buffer.from('MZ'));
    await (service as any).handleAdd('/tmp/scanner/tenant-a__script.exe');
    expect(ingestCalls).toHaveLength(0);
  });

  it('ingests a valid PDF for an active tenant', async () => {
    const { service, ingestCalls } = makeFixture();
    const fsPromises = require('node:fs').promises as any;
    jest
      .spyOn(fsPromises, 'readFile')
      .mockResolvedValue(Buffer.from('%PDF-1.4 hello world'));
    await (service as any).handleAdd('/tmp/scanner/tenant-a__ft12345.pdf');
    expect(ingestCalls).toHaveLength(1);
    expect(ingestCalls[0].origin).toBe('SCANNER');
    expect(ingestCalls[0].tenantId).toBe('tenant-a');
    expect(ingestCalls[0].files[0].originalname).toBe('ft12345.pdf');
    expect(ingestCalls[0].files[0].mimetype).toBe('application/pdf');
    expect((ingestCalls[0].metadata as any).source).toBe('file-watcher');
  });

  it('handles JPG attachments with the right MIME', async () => {
    const { service, ingestCalls } = makeFixture();
    const fsPromises = require('node:fs').promises as any;
    jest.spyOn(fsPromises, 'readFile').mockResolvedValue(Buffer.from('jpeg-bytes'));
    await (service as any).handleAdd('/tmp/scanner/tenant-a__scan123.jpg');
    expect(ingestCalls).toHaveLength(1);
    expect(ingestCalls[0].files[0].mimetype).toBe('image/jpeg');
    expect(ingestCalls[0].files[0].originalname).toBe('scan123.jpg');
  });

  it('moves the processed file into a .processed/ subdir after successful ingest', async () => {
    const { service, ingestCalls } = makeFixture();
    const fsPromises = require('node:fs').promises as any;
    jest
      .spyOn(fsPromises, 'readFile')
      .mockResolvedValue(Buffer.from('%PDF-1.4 hello world'));
    const renameMock = jest
      .spyOn(fsPromises, 'rename')
      .mockResolvedValue(undefined);
    const mkdirMock = jest
      .spyOn(fsPromises, 'mkdir')
      .mockResolvedValue(undefined);

    await (service as any).handleAdd('/tmp/scanner/tenant-a__ft12345.pdf');
    expect(ingestCalls).toHaveLength(1);
    // mkdir .processed/ + actual rename
    expect(mkdirMock).toHaveBeenCalledWith(
      expect.stringContaining('.processed'),
      { recursive: true },
    );
    expect(renameMock).toHaveBeenCalledWith(
      '/tmp/scanner/tenant-a__ft12345.pdf',
      expect.stringContaining('.processed'),
    );
  });
});
