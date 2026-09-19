import { AuditAction } from '@prisma/client';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { DocumentsService } from '../documents.service';
import type { StorageService } from '../storage/storage-service.interface';

/**
 * Soft-delete (trash) suite — Sprint I+.
 *
 * Covers the three Sprint I+ invariants on `deletedAt`:
 *
 *   1. softDelete — flips `deletedAt` to now(), emits a single forensic
 *      audit row tagged `document.soft_deleted`, and never touches storage.
 *      Tenant-scoped: a cross-tenant id 404s without side effects.
 *
 *   2. restore — clears `deletedAt`, is idempotent (already-live row
 *      returns `restored: false` with NO audit row), and is tenant-scoped
 *      (cross-tenant 404s).
 *
 *   3. findInTrash — returns only rows where `deletedAt IS NOT NULL` and
 *      never leaks the inbox rows (where `deletedAt IS NULL`). The
 *      pagination envelope mirrors findAll.
 *
 * The RBAC gate (ADMIN-only restore) is enforced by `@Roles(Role.ADMIN)`
 * on the controller, NOT the service. The service treats restore as a
 * permission-gated operation at the HTTP layer — this spec exercises the
 * service contract only.
 */

const TENANT_A = 'tenant-A';
const TENANT_B = 'tenant-B';
const USER_ID = 'user-1';
const DOC_ID = 'doc-trash';

function buildPrismaStub() {
  const stub: any = {
    document: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
    },
  };
  return stub;
}

function buildAuditStub() {
  return { log: jest.fn(async () => undefined) };
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

describe('DocumentsService.softDelete()', () => {
  it('sets deletedAt to now() and writes a document.soft_deleted audit row', async () => {
    const prisma = buildPrismaStub();
    const audit = buildAuditStub();
    const storage = buildStorageStub();

    prisma.document.findFirst.mockResolvedValueOnce({
      id: DOC_ID,
      deletedAt: null,
    });
    prisma.document.update.mockResolvedValueOnce({
      id: DOC_ID,
      deletedAt: new Date('2026-09-07T12:00:00Z'),
    });

    const svc = makeSvc(prisma, audit, storage);
    const result = await svc.softDelete(TENANT_A, USER_ID, DOC_ID);

    expect(result.id).toBe(DOC_ID);
    expect(result.deletedAt).toBeInstanceOf(Date);

    // audit row tagged EDIT / document.soft_deleted
    expect(audit.log).toHaveBeenCalledTimes(1);
    const auditArg = (audit.log as jest.Mock).mock.calls[0][0];
    expect(auditArg).toMatchObject({
      tenantId: TENANT_A,
      userId: USER_ID,
      action: AuditAction.EDIT,
      entityType: 'document',
      entityId: DOC_ID,
      metadata: { subAction: 'document.soft_deleted', previousDeletedAt: null },
    });
    expect(auditArg.metadata.deletedAt).toEqual(expect.any(String));
  });

  it('throws NotFoundException when the document belongs to another tenant', async () => {
    const prisma = buildPrismaStub();
    const audit = buildAuditStub();
    const storage = buildStorageStub();

    prisma.document.findFirst.mockResolvedValueOnce(null);

    const svc = makeSvc(prisma, audit, storage);
    await expect(svc.softDelete(TENANT_A, USER_ID, DOC_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );

    expect(prisma.document.update).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });
});

describe('DocumentsService.restore()', () => {
  it('clears deletedAt and writes a document.restored audit row', async () => {
    const prisma = buildPrismaStub();
    const audit = buildAuditStub();
    const storage = buildStorageStub();

    prisma.document.findFirst.mockResolvedValueOnce({
      id: DOC_ID,
      deletedAt: new Date('2026-09-06T09:00:00Z'),
    });
    prisma.document.update.mockResolvedValueOnce({
      id: DOC_ID,
      deletedAt: null,
    });

    const svc = makeSvc(prisma, audit, storage);
    const result = await svc.restore(TENANT_A, USER_ID, DOC_ID);

    expect(result.id).toBe(DOC_ID);
    expect(result.deletedAt).toBeNull();
    expect(result.restored).toBe(true);

    expect(audit.log).toHaveBeenCalledTimes(1);
    const auditArg = (audit.log as jest.Mock).mock.calls[0][0];
    expect(auditArg).toMatchObject({
      tenantId: TENANT_A,
      userId: USER_ID,
      action: AuditAction.EDIT,
      entityType: 'document',
      entityId: DOC_ID,
      metadata: {
        subAction: 'document.restored',
        previousDeletedAt: new Date('2026-09-06T09:00:00Z').toISOString(),
      },
    });
  });

  it('is idempotent — already-live row returns restored:false with no audit row', async () => {
    const prisma = buildPrismaStub();
    const audit = buildAuditStub();
    const storage = buildStorageStub();

    prisma.document.findFirst.mockResolvedValueOnce({
      id: DOC_ID,
      deletedAt: null,
    });

    const svc = makeSvc(prisma, audit, storage);
    const result = await svc.restore(TENANT_A, USER_ID, DOC_ID);

    expect(result.restored).toBe(false);
    expect(result.deletedAt).toBeNull();
    expect(prisma.document.update).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('throws NotFoundException when the document belongs to another tenant', async () => {
    const prisma = buildPrismaStub();
    const audit = buildAuditStub();
    const storage = buildStorageStub();

    prisma.document.findFirst.mockResolvedValueOnce(null);

    const svc = makeSvc(prisma, audit, storage);
    await expect(svc.restore(TENANT_A, USER_ID, DOC_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );

    expect(prisma.document.update).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });
});

describe('DocumentsService.findInTrash()', () => {
  it('returns only rows with deletedAt not null and never leaks live rows', async () => {
    const prisma = buildPrismaStub();
    const audit = buildAuditStub();
    const storage = buildStorageStub();

    prisma.document.findMany.mockResolvedValueOnce([
      {
        id: DOC_ID,
        tenantId: TENANT_A,
        deletedAt: new Date('2026-09-06T09:00:00Z'),
        uploadedBy: { id: USER_ID, name: 'U', email: 'u@x' },
        folder: null,
        party: null,
      },
    ]);
    prisma.document.count.mockResolvedValueOnce(1);

    const svc = makeSvc(prisma, audit, storage);
    const out = await svc.findInTrash(TENANT_A, { page: 1, limit: 20 } as any);

    expect(out.items).toHaveLength(1);
    expect(out.meta.total).toBe(1);

    // Where clause must include the deletedAt:not:null predicate and tenantId scope.
    const whereArg = (prisma.document.findMany as jest.Mock).mock.calls[0][0].where;
    expect(whereArg.tenantId).toBe(TENANT_A);
    expect(whereArg.deletedAt).toEqual({ not: null });
    expect(whereArg.status).toBeUndefined();
  });

  it('applies date filters on deletedAt (trash-specific range)', async () => {
    const prisma = buildPrismaStub();
    const audit = buildAuditStub();
    const storage = buildStorageStub();

    prisma.document.findMany.mockResolvedValueOnce([]);
    prisma.document.count.mockResolvedValueOnce(0);

    const svc = makeSvc(prisma, audit, storage);
    await svc.findInTrash(TENANT_A, {
      page: 1,
      limit: 20,
      dateFrom: '2026-09-01',
      dateTo: '2026-09-07',
    } as any);

    const whereArg = (prisma.document.findMany as jest.Mock).mock.calls[0][0].where;
    expect(whereArg.deletedAt).toMatchObject({ gte: expect.any(Date) });
    expect(whereArg.deletedAt).toMatchObject({ lte: expect.any(Date) });
  });
});
