import { ConflictException, NotFoundException } from '@nestjs/common';
import { AuditAction } from '@prisma/client';
import { DocumentsService } from '../documents.service';
import type { StorageService } from '../storage/storage-service.interface';

/**
 * POST /api/v1/documents/:id/supplier/re-extract — AI supplier re-extraction.
 *
 * The Sprint H+ extraction-fix-3 fix added an Operator-Verified Guard: when
 * Document.supplierVerifiedAt is set, the endpoint refuses with 409 unless
 * `?force=true` is passed. The two previous extraction bugs (operator
 * corrected a row → AI hallucinated back to the wrong supplier, twice) are
 * what made this guard mandatory.
 *
 * This spec verifies the four invariants:
 *
 *   1. Tenant scoping — cross-tenant id 404s without touching extraction.
 *   2. Operator-Verified Guard — `supplierVerifiedAt` set + no force → 409
 *      with the verifiedAt timestamp surfaced to the caller.
 *   3. Force override — `supplierVerifiedAt` set + force=true → runs
 *      extraction.audit row tagged `document.extract_supplier` with
 *      `forced: true`.
 *   4. Happy path — non-verified doc runs extraction, persists the
 *      supplier block, and emits one audit row.
 */

const TENANT_A = 'tenant-A';
const TENANT_B = 'tenant-B';
const USER_ID = 'user-1';
const DOC_ID = 'doc-re-extract-supplier';

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
    extractSupplierFromDocument: jest.fn(async () => ({
      supplierName: 'EDP Comercial',
      supplierNif: '500000001',
      supplierIban: 'PT50000201231234567890154',
      address: 'Rua das Indústrias 123',
      country: 'PT',
    })),
  };
}

function makeSvc(prisma: any, audit: any, storage: StorageService, extraction: any) {
  return new DocumentsService(
    prisma as any,
    audit as any,
    storage as any,
    buildRulesEngineStub() as any,
    extraction as any,
    buildImageToPdfStub() as any,
    buildNifLookupStub() as any,
    buildQueueStub() as any,
  );
}

describe('DocumentsService.extractSupplierFromDocument()', () => {
  it('throws NotFoundException when the document belongs to another tenant', async () => {
    const prisma = buildPrismaStub();
    const audit = buildAuditStub();
    const storage = buildStorageStub();
    const extraction = buildExtractionStub();

    prisma.document.findFirst.mockResolvedValueOnce(null);

    const svc = makeSvc(prisma, audit, storage, extraction);
    await expect(
      svc.extractSupplierFromDocument(TENANT_A, USER_ID, DOC_ID),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(extraction.extractSupplierFromDocument).not.toHaveBeenCalled();
    expect(prisma.document.update).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('refuses with 409 when supplierVerifiedAt is set and force is NOT passed', async () => {
    const prisma = buildPrismaStub();
    const audit = buildAuditStub();
    const storage = buildStorageStub();
    const extraction = buildExtractionStub();

    prisma.document.findFirst.mockResolvedValueOnce({
      id: DOC_ID,
      supplier: 'ONNERA REFRIGERATION S.A.',
      supplierNif: '509999999',
      iban: 'PT50000201231234567890154',
      fileKey: '_inbox/tenant-A/2026/09/x.pdf',
      fileName: 'invoice.pdf',
      mimeType: 'application/pdf',
      fileSize: 12345,
      metadata: null,
      supplierVerifiedAt: new Date('2026-09-06T10:00:00Z'),
    });

    const svc = makeSvc(prisma, audit, storage, extraction);
    await expect(
      svc.extractSupplierFromDocument(TENANT_A, USER_ID, DOC_ID, {}),
    ).rejects.toMatchObject({
      // ConflictException surfaces a 409 with the verifiedAt timestamp so
      // the UI can show "Last verified: ..." in the override modal. The
      // Nest exception filter may re-serialise the `verifiedAt` field as
      // either ISO string or Date depending on the path; we assert status
      // is 409 and the message carries the verifiedAt marker.
      status: 409,
      message: expect.stringContaining('supplierVerifiedAt'),
    });

    expect(extraction.extractSupplierFromDocument).not.toHaveBeenCalled();
    expect(prisma.document.update).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('runs extraction when supplierVerifiedAt is set AND force=true', async () => {
    const prisma = buildPrismaStub();
    const audit = buildAuditStub();
    const storage = buildStorageStub();
    const extraction = buildExtractionStub();

    prisma.document.findFirst.mockResolvedValueOnce({
      id: DOC_ID,
      supplier: 'ONNERA REFRIGERATION S.A.',
      supplierNif: '509999999',
      iban: 'PT50000201231234567890154',
      fileKey: '_inbox/tenant-A/2026/09/x.pdf',
      fileName: 'invoice.pdf',
      mimeType: 'application/pdf',
      fileSize: 12345,
      metadata: null,
      supplierVerifiedAt: new Date('2026-09-06T10:00:00Z'),
    });
    prisma.document.update.mockResolvedValueOnce({ id: DOC_ID });

    const svc = makeSvc(prisma, audit, storage, extraction);
    const result = await svc.extractSupplierFromDocument(
      TENANT_A,
      USER_ID,
      DOC_ID,
      { force: true },
    );

    expect(result.reExtracted).toBe(true);
    expect(result.supplier.name).toBe('EDP Comercial');
    expect(result.supplier.nif).toBe('500000001');

    // Extraction service called with the correct (tenantId, userId, id).
    expect(extraction.extractSupplierFromDocument).toHaveBeenCalledWith(
      TENANT_A,
      USER_ID,
      DOC_ID,
    );

    // Update persisted the freshly-extracted fields.
    expect(prisma.document.update).toHaveBeenCalledTimes(1);
    const updateData = (prisma.document.update as jest.Mock).mock.calls[0][0].data;
    expect(updateData.supplier).toBe('EDP Comercial');
    expect(updateData.supplierNif).toBe('500000001');
    expect(updateData.iban).toBe('PT50000201231234567890154');
    expect(updateData.metadata.supplierAddress).toBe('Rua das Indústrias 123');
    expect(updateData.metadata.supplierCountry).toBe('PT');

    // Audit row tagged EDIT / document.extract_supplier with forced=true.
    expect(audit.log).toHaveBeenCalledTimes(1);
    const auditArg = (audit.log as jest.Mock).mock.calls[0][0];
    expect(auditArg).toMatchObject({
      tenantId: TENANT_A,
      userId: USER_ID,
      action: AuditAction.EDIT,
      entityType: 'document',
      entityId: DOC_ID,
    });
    expect(auditArg.metadata.subAction).toBe('document.extract_supplier');
    expect(auditArg.metadata.forced).toBe(true);
    expect(auditArg.metadata.oldSupplier).toBe('ONNERA REFRIGERATION S.A.');
    expect(auditArg.metadata.newSupplier).toBe('EDP Comercial');
  });

  it('happy path — non-verified doc runs extraction and persists the block', async () => {
    const prisma = buildPrismaStub();
    const audit = buildAuditStub();
    const storage = buildStorageStub();
    const extraction = buildExtractionStub();

    prisma.document.findFirst.mockResolvedValueOnce({
      id: DOC_ID,
      supplier: null,
      supplierNif: null,
      iban: null,
      fileKey: '_inbox/tenant-A/2026/09/x.pdf',
      fileName: 'invoice.pdf',
      mimeType: 'application/pdf',
      fileSize: 12345,
      metadata: null,
      supplierVerifiedAt: null,
    });
    prisma.document.update.mockResolvedValueOnce({ id: DOC_ID });

    const svc = makeSvc(prisma, audit, storage, extraction);
    const result = await svc.extractSupplierFromDocument(TENANT_A, USER_ID, DOC_ID);

    expect(result.reExtracted).toBe(true);
    expect(result.supplier.name).toBe('EDP Comercial');
    expect(extraction.extractSupplierFromDocument).toHaveBeenCalledTimes(1);

    const auditArg = (audit.log as jest.Mock).mock.calls[0][0];
    expect(auditArg.metadata.subAction).toBe('document.extract_supplier');
    expect(auditArg.metadata.forced).toBe(false);
    expect(auditArg.metadata.fieldsChanged).toBe(true);
  });
});
