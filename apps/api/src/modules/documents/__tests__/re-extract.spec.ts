import { AuditAction, DocumentProcessingStatus } from '@prisma/client';
import { DocumentsService } from '../documents.service';
import type { StorageService } from '../storage/storage-service.interface';

/**
 * Sprint H + re-extract fix — POST /documents/:id/re-extract
 *
 * The frontend's "Re-extrair" button calls this endpoint. It must:
 *   - validate tenant ownership (404 cross-tenant);
 *   - reset processingStatus to RECEIVED so the pipeline idempotency
 *     guard picks the doc up again;
 *   - publish `document.uploaded` to the queue (same payload shape
 *     as the upload() flow — ProcessingService.handleReceived is the
 *     downstream handler);
 *   - log an audit row tagged `re-extraction.triggered`.
 *
 * These tests stub Prisma / storage / queue with per-test jest mocks
 * — no real filesystem or DB is touched.
 */

const TENANT_A = 'tenant-A';
const TENANT_B = 'tenant-B';
const USER_ID = 'user-1';
const DOC_ID = 'doc-re-extract';

function buildPrismaStub() {
  const stub: any = {
    document: {
      findFirst: jest.fn(),
      update: jest.fn(),
    },
  };
  return stub;
}

function buildAuditStub() {
  return {
    log: jest.fn(async () => undefined),
  };
}

function buildStorageStub(): StorageService {
  return {
    driver: 'local',
    put: jest.fn(async () => undefined),
    getBuffer: jest.fn(async () => ({ buffer: Buffer.from(''), size: 0 })),
    remove: jest.fn(async () => undefined),
    exists: jest.fn(async () => true),
    move: jest.fn(async () => undefined),
    getSignedUrl: jest.fn(async (key: string) =>
      `/api/v1/documents/storage/${encodeURIComponent(key)}`,
    ),
  };
}

function buildRulesEngineStub() {
  return {
    suggest: jest.fn(async () => '/Inbox/2026/09/OUTRO'),
    render: jest.fn(),
    fallback: jest.fn(),
  };
}

function buildImageToPdfStub() {
  return {
    supports: jest.fn(() => false),
    convert: jest.fn(),
  };
}

function buildNifLookupStub() {
  return {
    lookup: jest.fn().mockResolvedValue({
      nif: "515208566",
      mod11Valid: true,
      baseVerified: false,
      reason: "upstream_unavailable",
      source: "mod11_only",
      fetchedAt: new Date().toISOString(),
    }),
  };
}

function buildQueueStub() {
  return {
    driver: 'eventemitter' as const,
    publish: jest.fn().mockResolvedValue(undefined),
    subscribe: jest.fn(),
    subscribeBatch: jest.fn(),
  };
}

function buildExtractionStub() {
  return {
    enqueue: jest.fn().mockResolvedValue({ queued: false, documentId: DOC_ID, ok: true }),
  };
}

function makeSvc(prisma: any, audit: any, storage: StorageService) {
  return new DocumentsService(
    prisma as any,
    audit as any,
    storage as any,
    buildRulesEngineStub() as any,
    buildExtractionStub() as any,
    buildImageToPdfStub() as any,
    buildNifLookupStub() as any,
    buildQueueStub() as any,
  );
}

describe('DocumentsService.reExtract()', () => {
  it('returns the doc and resets processingStatus when the tenant owns it', async () => {
    const prisma = buildPrismaStub();
    const audit = buildAuditStub();
    const storage = buildStorageStub();

    prisma.document.findFirst.mockResolvedValueOnce({
      id: DOC_ID,
      status: 'PROCESSADO',
      fileKey: '_inbox/tenant-A/2026/09/file.pdf',
      mimeType: 'application/pdf',
      fileName: 'invoice.pdf',
      fileSize: 12345,
    });
    prisma.document.update.mockResolvedValueOnce({ id: DOC_ID });

    const svc = makeSvc(prisma, audit, storage);
    const result = await svc.reExtract(TENANT_A, USER_ID, DOC_ID);

    expect(result.id).toBe(DOC_ID);

    // Reset must point processingStatus back to RECEIVED — the pipeline's
    // idempotency guard keys off that flag.
    expect(prisma.document.update).toHaveBeenCalledTimes(1);
    const updateArg = (prisma.document.update as jest.Mock).mock.calls[0][0];
    expect(updateArg.where).toEqual({ id: DOC_ID });
    expect(updateArg.data.processingStatus).toBe(DocumentProcessingStatus.RECEIVED);
    expect(updateArg.data.processingCompletedAt).toBeNull();
    expect(updateArg.data.processingError).toBeNull();
    expect(updateArg.data.processingStartedAt).toBeInstanceOf(Date);
  });

  it('publishes document.uploaded with the doc payload to the queue', async () => {
    const prisma = buildPrismaStub();
    const audit = buildAuditStub();
    const storage = buildStorageStub();
    const queue = buildQueueStub();

    prisma.document.findFirst.mockResolvedValueOnce({
      id: DOC_ID,
      status: 'PROCESSADO',
      fileKey: '_inbox/tenant-A/2026/09/file.pdf',
      mimeType: 'application/pdf',
      fileName: 'invoice.pdf',
      fileSize: 12345,
    });
    prisma.document.update.mockResolvedValueOnce({ id: DOC_ID });

    const svc = new DocumentsService(
      prisma as any,
      audit as any,
      storage as any,
      buildRulesEngineStub() as any,
      buildExtractionStub() as any,
      buildImageToPdfStub() as any,
      buildNifLookupStub() as any,
      queue as any,
    );

    await svc.reExtract(TENANT_A, USER_ID, DOC_ID);

    expect(queue.publish).toHaveBeenCalledTimes(1);
    const [topic, payload] = (queue.publish as jest.Mock).mock.calls[0];
    expect(topic).toBe('document.uploaded');
    expect(payload).toMatchObject({
      topic: 'document.uploaded',
      documentId: DOC_ID,
      tenantId: TENANT_A,
      userId: USER_ID,
      fileKey: '_inbox/tenant-A/2026/09/file.pdf',
      mimeType: 'application/pdf',
      fileSize: 12345,
      originalFilename: 'invoice.pdf',
    });
    expect(payload.uploadedAt).toEqual(expect.any(String));
  });

  it('logs an audit row tagged re-extraction.triggered', async () => {
    const prisma = buildPrismaStub();
    const audit = buildAuditStub();
    const storage = buildStorageStub();

    prisma.document.findFirst.mockResolvedValueOnce({
      id: DOC_ID,
      status: 'PROCESSADO',
      fileKey: '_inbox/tenant-A/2026/09/file.pdf',
      mimeType: 'application/pdf',
      fileName: 'invoice.pdf',
      fileSize: 12345,
    });
    prisma.document.update.mockResolvedValueOnce({ id: DOC_ID });

    const svc = makeSvc(prisma, audit, storage);
    await svc.reExtract(TENANT_A, USER_ID, DOC_ID);

    expect(audit.log).toHaveBeenCalledTimes(1);
    const auditArg = (audit.log as jest.Mock).mock.calls[0][0];
    expect(auditArg).toMatchObject({
      tenantId: TENANT_A,
      userId: USER_ID,
      action: AuditAction.EDIT,
      entityType: 'document',
      entityId: DOC_ID,
      metadata: { subAction: 're-extraction.triggered' },
    });
  });

  it('throws NotFoundException when the document belongs to another tenant', async () => {
    const prisma = buildPrismaStub();
    const audit = buildAuditStub();
    const storage = buildStorageStub();

    // tenant-scoped findFirst returns null when the doc belongs to TENANT_B
    prisma.document.findFirst.mockResolvedValueOnce(null);

    const svc = makeSvc(prisma, audit, storage);

    await expect(svc.reExtract(TENANT_A, USER_ID, DOC_ID)).rejects.toMatchObject({
      status: 404,
    });

    // No mutation should have happened when the doc is not in this tenant.
    expect(prisma.document.update).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });
});
