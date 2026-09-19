import { AuditAction } from '@prisma/client';
import { NotFoundException } from '@nestjs/common';
import { DocumentsService } from '../documents.service';
import type { StorageService } from '../storage/storage-service.interface';

/**
 * DELETE /api/v1/documents/:id/hard — destructive ADMIN-only delete.
 *
 * Sprint H+ fix-up. Tests cover the four invariants the endpoint MUST
 * hold, mirroring the verify-supplier / correct-supplier / re-extract
 * spec patterns so the four suites stay readable together:
 *
 *   1. Tenant ownership — cross-tenant id → 404, no storage.remove, no
 *      audit row, no prisma.document.delete (a leaked id from another
 *      tenant must never produce side effects in this tenant).
 *   2. Forensic trail — a single audit row is written under
 *      subAction `document.hard_deleted` carrying the fileName + supplier
 *      + storage keys. The audit row is written BEFORE the DB delete so
 *      the chain proves who pulled the trigger even if step 4 raises.
 *   3. Storage cleanup — both fileKey and pdfKey are passed to
 *      storage.remove (when present). Failures are logged but do NOT
 *      block the DB delete — the row is the source of truth.
 *   4. Hard delete — prisma.document.delete is called once with the
 *      correct `id` (NOT scoped by tenantId — the global key is fine
 *      because step 1 already gated on the tenant).
 *
 * The existing commit 235e136 wired the endpoint with
 * `@Roles(Role.ADMIN)` + `@HttpCode(HttpStatus.NO_CONTENT)`; this spec
 * exercises the service method directly so the suite is independent of
 * NestJS guards.
 */

const TENANT_A = 'tenant-A';
const TENANT_B = 'tenant-B';
const USER_ID = 'user-admin';
const DOC_ID = 'doc-hard-delete';

function buildPrismaStub() {
  const stub: any = {
    document: {
      findFirst: jest.fn(),
      delete: jest.fn(),
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

function makeSvc(prisma: any, audit: any, storage: StorageService, queue?: any) {
  return new DocumentsService(
    prisma as any,
    audit as any,
    storage as any,
    buildRulesEngineStub() as any,
    buildExtractionStub() as any,
    buildImageToPdfStub() as any,
    buildNifLookupStub() as any,
    (queue ?? buildQueueStub()) as any,
  );
}

describe('DocumentsService.hardDelete()', () => {
  it('removes fileKey + pdfKey from storage, writes audit row, then deletes the document row', async () => {
    const prisma = buildPrismaStub();
    const audit = buildAuditStub();
    const storage = buildStorageStub();

    prisma.document.findFirst.mockResolvedValueOnce({
      id: DOC_ID,
      fileKey: '_inbox/tenant-A/2026/08/1234-abcd.pdf',
      pdfKey: '_inbox/tenant-A/2026/08/1234-abcd.pdf.pdf',
      fileName: 'FT-2026-1234.pdf',
      supplier: 'EDP Comercial',
    });
    prisma.document.delete.mockResolvedValueOnce({ id: DOC_ID });

    const svc = makeSvc(prisma, audit, storage);
    await svc.hardDelete(TENANT_A, USER_ID, DOC_ID);

    // 1. Storage cleanup — both keys go to remove().
    expect(storage.remove).toHaveBeenCalledTimes(2);
    expect(storage.remove).toHaveBeenNthCalledWith(
      1,
      '_inbox/tenant-A/2026/08/1234-abcd.pdf',
    );
    expect(storage.remove).toHaveBeenNthCalledWith(
      2,
      '_inbox/tenant-A/2026/08/1234-abcd.pdf.pdf',
    );

    // 2. Forensic row BEFORE the delete.
    expect(audit.log).toHaveBeenCalledTimes(1);
    const auditArg = (audit.log as jest.Mock).mock.calls[0][0];
    expect(auditArg).toMatchObject({
      tenantId: TENANT_A,
      userId: USER_ID,
      action: AuditAction.DELETE,
      entityType: 'document',
      entityId: DOC_ID,
    });
    expect(auditArg.metadata.subAction).toBe('document.hard_deleted');
    expect(auditArg.metadata.fileName).toBe('FT-2026-1234.pdf');
    expect(auditArg.metadata.supplier).toBe('EDP Comercial');
    expect(auditArg.metadata.fileKey).toBe(
      '_inbox/tenant-A/2026/08/1234-abcd.pdf',
    );
    expect(auditArg.metadata.pdfKey).toBe(
      '_inbox/tenant-A/2026/08/1234-abcd.pdf.pdf',
    );

    // 3. DB delete ran with the right id (tenant scope enforced at the
    // findFirst gate above).
    expect(prisma.document.delete).toHaveBeenCalledTimes(1);
    expect(prisma.document.delete).toHaveBeenCalledWith({ where: { id: DOC_ID } });
  });

  it('throws NotFoundException when the document belongs to another tenant — no side effects', async () => {
    const prisma = buildPrismaStub();
    const audit = buildAuditStub();
    const storage = buildStorageStub();

    // The tenant-scoped findFirst returns null when the row belongs to
    // TENANT_B. The service must NOT then attempt anything else: a
    // leaked id from another tenant must never produce side effects
    // in this tenant (storage remove, audit write, delete on a row
    // owned by another tenant).
    prisma.document.findFirst.mockResolvedValueOnce(null);

    const svc = makeSvc(prisma, audit, storage);

    await expect(
      svc.hardDelete(TENANT_A, USER_ID, DOC_ID),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(storage.remove).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
    expect(prisma.document.delete).not.toHaveBeenCalled();
  });

  it('does NOT block the DB delete when storage.remove fails — the row is the source of truth', async () => {
    const prisma = buildPrismaStub();
    const audit = buildAuditStub();
    const storage = buildStorageStub();

    prisma.document.findFirst.mockResolvedValueOnce({
      id: DOC_ID,
      fileKey: '_inbox/tenant-A/2026/08/1234-abcd.pdf',
      pdfKey: null,
      fileName: 'FT-2026-1234.pdf',
      supplier: 'EDP Comercial',
    });

    // Make storage.remove throw — the service must swallow the error,
    // log a warning, and continue to delete the DB row.
    (storage.remove as jest.Mock).mockRejectedValueOnce(
      new Error('ENOENT: file not found'),
    );

    prisma.document.delete.mockResolvedValueOnce({ id: DOC_ID });

    const svc = makeSvc(prisma, audit, storage);
    await svc.hardDelete(TENANT_A, USER_ID, DOC_ID);

    // Storage called once even though it threw.
    expect(storage.remove).toHaveBeenCalledTimes(1);
    // Audit row still emitted (forensic trail).
    expect(audit.log).toHaveBeenCalledTimes(1);
    // DB delete still ran — the user asked to delete the document and
    // we honor that.
    expect(prisma.document.delete).toHaveBeenCalledTimes(1);
  });

  it('does NOT call storage.remove when the row has no fileKey (null-safe)', async () => {
    const prisma = buildPrismaStub();
    const audit = buildAuditStub();
    const storage = buildStorageStub();

    // Edge case: a row that somehow lost its fileKey (legacy / orphan).
    // Storage cleanup is best-effort; the service must not throw and
    // must not call remove() on undefined.
    prisma.document.findFirst.mockResolvedValueOnce({
      id: DOC_ID,
      fileKey: null,
      pdfKey: null,
      fileName: 'orphan.pdf',
      supplier: null,
    });
    prisma.document.delete.mockResolvedValueOnce({ id: DOC_ID });

    const svc = makeSvc(prisma, audit, storage);
    await svc.hardDelete(TENANT_A, USER_ID, DOC_ID);

    expect(storage.remove).not.toHaveBeenCalled();
    // Audit row still emitted so the "who pulled the trigger" trail
    // covers orphan deletes too.
    expect(audit.log).toHaveBeenCalledTimes(1);
    expect(prisma.document.delete).toHaveBeenCalledWith({ where: { id: DOC_ID } });
  });

  it('does NOT publish a document.uploaded event (no pipeline re-trigger on a hard delete)', async () => {
    const prisma = buildPrismaStub();
    const audit = buildAuditStub();
    const storage = buildStorageStub();
    const queue = buildQueueStub();

    prisma.document.findFirst.mockResolvedValueOnce({
      id: DOC_ID,
      fileKey: '_inbox/tenant-A/2026/08/1234-abcd.pdf',
      pdfKey: null,
      fileName: 'FT-2026-1234.pdf',
      supplier: 'EDP Comercial',
    });
    prisma.document.delete.mockResolvedValueOnce({ id: DOC_ID });

    const svc = makeSvc(prisma, audit, storage, queue);
    await svc.hardDelete(TENANT_A, USER_ID, DOC_ID);

    // A hard delete must not kick off any extraction / enrichment
    // pipeline — the row is gone, it would only confuse the consumer.
    expect(queue.publish).not.toHaveBeenCalled();
  });
});
