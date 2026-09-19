import { AuditAction } from '@prisma/client';
import { NotFoundException } from '@nestjs/common';
import { DocumentsService } from '../documents.service';
import type { StorageService } from '../storage/storage-service.interface';

/**
 * Sprint H+ — PATCH /documents/:id/verify-supplier
 *
 * Manual confirmation that the AI-extracted supplier block is correct
 * AS-IS (no field edit). Tests cover the four invariants the endpoint
 * MUST hold:
 *
 *   1. Tenant ownership — cross-tenant id → 404, no mutation, no audit row.
 *   2. Forensic trail — a single audit row is written under
 *      subAction `document.verify_supplier` carrying the verifiedAt
 *      timestamp.
 *   3. supplierVerifiedAt is stamped to a Date instance on the document
 *      row.
 *   4. No pipeline re-trigger — this is a no-op confirmation, the
 *      extraction queue MUST NOT receive a `document.uploaded` event
 *      (otherwise a "confirm" click would kick off a fresh AI run, which
 *      is the bug Sprint H+ is fixing in the UX layer).
 *
 * Mirrors the construction helpers in `correct-supplier.spec.ts` so the
 * two suites stay readable together.
 */

const TENANT_A = 'tenant-A';
const TENANT_B = 'tenant-B';
const USER_ID = 'user-1';
const DOC_ID = 'doc-verify';

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

describe('DocumentsService.verifySupplier()', () => {
  it('stamps supplierVerifiedAt on the document when the tenant owns it', async () => {
    const prisma = buildPrismaStub();
    const audit = buildAuditStub();
    const storage = buildStorageStub();

    prisma.document.findFirst.mockResolvedValueOnce({ id: DOC_ID });
    prisma.document.update.mockResolvedValueOnce({ id: DOC_ID });

    const svc = makeSvc(prisma, audit, storage);
    const result = await svc.verifySupplier(TENANT_A, USER_ID, DOC_ID);

    expect(result.ok).toBe(true);
    expect(typeof result.verifiedAt).toBe('string');
    // ISO timestamp round-trip — guards against accidental epoch / Date.toString leak.
    expect(() => new Date(result.verifiedAt).toISOString()).not.toThrow();
    expect(new Date(result.verifiedAt).toISOString()).toBe(result.verifiedAt);

    expect(prisma.document.update).toHaveBeenCalledTimes(1);
    const updateArg = (prisma.document.update as jest.Mock).mock.calls[0][0];
    expect(updateArg.where).toEqual({ id: DOC_ID });
    expect(updateArg.data.supplierVerifiedAt).toBeInstanceOf(Date);
    // No pipeline state reset — verifySupplier is a confirmation, not a re-run.
    expect('processingStatus' in updateArg.data).toBe(false);
  });

  it('writes an audit row tagged document.verify_supplier carrying the verifiedAt timestamp', async () => {
    const prisma = buildPrismaStub();
    const audit = buildAuditStub();
    const storage = buildStorageStub();

    prisma.document.findFirst.mockResolvedValueOnce({ id: DOC_ID });
    prisma.document.update.mockResolvedValueOnce({ id: DOC_ID });

    const svc = makeSvc(prisma, audit, storage);
    await svc.verifySupplier(TENANT_A, USER_ID, DOC_ID);

    expect(audit.log).toHaveBeenCalledTimes(1);
    const auditArg = (audit.log as jest.Mock).mock.calls[0][0];
    expect(auditArg).toMatchObject({
      tenantId: TENANT_A,
      userId: USER_ID,
      action: AuditAction.EDIT,
      entityType: 'document',
      entityId: DOC_ID,
    });
    expect(auditArg.metadata.subAction).toBe('document.verify_supplier');
    expect(typeof auditArg.metadata.verifiedAt).toBe('string');
    expect(auditArg.metadata.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('does NOT publish a document.uploaded event (no pipeline re-trigger on a confirmation)', async () => {
    const prisma = buildPrismaStub();
    const audit = buildAuditStub();
    const storage = buildStorageStub();
    const queue = buildQueueStub();

    prisma.document.findFirst.mockResolvedValueOnce({ id: DOC_ID });
    prisma.document.update.mockResolvedValueOnce({ id: DOC_ID });

    const svc = makeSvc(prisma, audit, storage, queue);
    await svc.verifySupplier(TENANT_A, USER_ID, DOC_ID);

    expect(queue.publish).not.toHaveBeenCalled();
  });

  it('throws NotFoundException when the document belongs to another tenant', async () => {
    const prisma = buildPrismaStub();
    const audit = buildAuditStub();
    const storage = buildStorageStub();

    // tenant-scoped findFirst returns null when the doc belongs to TENANT_B
    prisma.document.findFirst.mockResolvedValueOnce(null);

    const svc = makeSvc(prisma, audit, storage);

    await expect(
      svc.verifySupplier(TENANT_A, USER_ID, DOC_ID),
    ).rejects.toBeInstanceOf(NotFoundException);

    // No mutation should have happened when the doc is not in this tenant.
    expect(prisma.document.update).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('stamps with the tenant-supplied id and forwards the tenantId into the audit row', async () => {
    // Belt-and-braces check — guards against a future regression where
    // someone refactors verifySupplier to accept a body and accidentally
    // trusts a tenantId from there instead of from the JWT.
    const prisma = buildPrismaStub();
    const audit = buildAuditStub();
    const storage = buildStorageStub();

    prisma.document.findFirst.mockResolvedValueOnce({ id: DOC_ID });
    prisma.document.update.mockResolvedValueOnce({ id: DOC_ID });

    const svc = makeSvc(prisma, audit, storage);
    await svc.verifySupplier(TENANT_A, USER_ID, DOC_ID);

    const findArg = (prisma.document.findFirst as jest.Mock).mock.calls[0][0];
    expect(findArg.where).toEqual({ id: DOC_ID, tenantId: TENANT_A });

    const auditArg = (audit.log as jest.Mock).mock.calls[0][0];
    expect(auditArg.tenantId).toBe(TENANT_A);
    expect(auditArg.userId).toBe(USER_ID);
  });
});
