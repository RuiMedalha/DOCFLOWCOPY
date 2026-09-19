import { AuditAction } from '@prisma/client';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { DocumentsService } from '../documents.service';
import type { StorageService } from '../storage/storage-service.interface';

/**
 * Sprint 1.A — extraction-confidence surface.
 *
 * Three endpoints land behind a single test file because they share
 * the same shape (read per-field confidence → confirm-field →
 * confirm-all) and the same audit invariants. Coverage:
 *
 *   1. GET /:id/extraction-confidence — returns the per-field map +
 *      summary, surfaces aiProvider/aiModel from
 *      `metadata.extraction`, and is tenant-scoped (404 for
 *      cross-tenant ids).
 *   2. PATCH /:id/confirm-field — writes the new value (or no value)
 *      to the right column/metadata slot, records the confirmation
 *      row, emits an AuditAction.EDIT row carrying the BEFORE/AFTER
 *      diff, and recomputes nifValid/ibanValid for the structural
 *      fields.
 *   3. POST /:id/confirm-all — stamps `supplierVerifiedAt = now()`
 *      and emits a single AuditAction.CONFIRM row carrying the
 *      confirmed-field list + `previousVerifiedAt`.
 *
 * RBAC: the controller gates PATCH/POST on @Roles(ADMIN, OPERADOR);
 * the unit tests do not exercise the guard directly (NestJS RBAC is
 * a controller-layer concern tested in the e2e suite). Service-layer
 * tests focus on the audit invariants the brief calls out.
 */

const TENANT_A = 'tenant-A';
const TENANT_B = 'tenant-B';
const USER_ID = 'user-1';
const DOC_ID = 'doc-extraction';

function buildPrismaStub() {
  const stub: any = {
    document: {
      findFirst: jest.fn(),
      update: jest.fn(),
    },
    documentFieldConfirmation: {
      create: jest.fn(),
      findMany: jest.fn(),
    },
  };
  // Default: no prior confirmations — per-field tests override when needed.
  stub.documentFieldConfirmation.findMany.mockResolvedValue([]);
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
  return { suggest: jest.fn(), render: jest.fn(), fallback: jest.fn() };
}

function buildImageToPdfStub() {
  return { supports: jest.fn(() => false), convert: jest.fn() };
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
  return { enqueue: jest.fn() };
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

// ─── getExtractionConfidence ────────────────────────────────────────────────

describe('DocumentsService.getExtractionConfidence()', () => {
  it('returns a per-field map + summary for a document the tenant owns', async () => {
    const prisma = buildPrismaStub();
    const audit = buildAuditStub();
    const storage = buildStorageStub();

    prisma.document.findFirst.mockResolvedValueOnce({
      supplier: 'EDENOX',
      supplierNif: '502782160',
      iban: 'PT50000201231234567890154',
      total: { toString: () => '1234.56' } as any,
      docDate: new Date('2026-09-01T00:00:00Z'),
      dueDate: new Date('2026-10-01T00:00:00Z'),
      ocrConfidence: 0.92,
      supplierNameConfidence: 0.95,
      supplierNifConfidence: 0.97,
      supplierIbanConfidence: 0.88,
      supplierAddressConfidence: 0.6,
      supplierCountryConfidence: 0.95,
      totalAmountConfidence: 0.94,
      issueDateConfidence: 0.93,
      dueDateConfidence: 0.93,
      categoryConfidence: null,
      nifValid: true,
      ibanValid: true,
      supplierVerifiedAt: null,
      metadata: {
        extraction: { aiProvider: 'openrouter', aiModel: 'gemini-2.5-flash' },
        supplierAddress: 'Rua das Indústrias 123',
        supplierCountry: 'PT',
      },
    });

    const svc = makeSvc(prisma, audit, storage);
    const result = await svc.getExtractionConfidence(TENANT_A, DOC_ID);

    expect(result.aiProvider).toBe('openrouter');
    expect(result.aiModel).toBe('gemini-2.5-flash');
    expect(result.supplierName.value).toBe('EDENOX');
    expect(result.supplierNif.value).toBe('502782160');
    expect(result.supplierNif.confidence).toBe(0.97);
    expect(result.supplierNif.valid).toBe(true);
    expect(result.totalAmount.value).toBe('1234.56');
    expect(result.issueDate.value).toBe('2026-09-01');
    expect(result.dueDate.value).toBe('2026-10-01');
    expect(result.supplierAddress.value).toBe('Rua das Indústrias 123');
    expect(result.supplierCountry.value).toBe('PT');
    expect(result.supplierVerifiedAt).toBeNull();
    // Summary rolls up bands correctly.
    expect(result.summary.totalFields).toBe(9);
    expect(result.summary.highConfidence).toBeGreaterThanOrEqual(5);
    expect(result.summary.invalid).toBe(0);
  });

  it('throws NotFoundException for a cross-tenant id without leaking data', async () => {
    const prisma = buildPrismaStub();
    const audit = buildAuditStub();
    const storage = buildStorageStub();

    prisma.document.findFirst.mockResolvedValueOnce(null);

    const svc = makeSvc(prisma, audit, storage);

    await expect(
      svc.getExtractionConfidence(TENANT_B, DOC_ID),
    ).rejects.toBeInstanceOf(NotFoundException);

    // No read of confirmations when the doc itself is missing — the
    // tenant-scoping guard fires before any other query.
    expect(prisma.documentFieldConfirmation.findMany).not.toHaveBeenCalled();
  });
});

// ─── confirmField ───────────────────────────────────────────────────────────

describe('DocumentsService.confirmField()', () => {
  it('writes a value to the matching column + records a confirmation + audit row', async () => {
    const prisma = buildPrismaStub();
    const audit = buildAuditStub();
    const storage = buildStorageStub();

    prisma.document.findFirst
      // First call: the upfront read
      .mockResolvedValueOnce({
        id: DOC_ID,
        supplier: 'EDENOX',
        supplierNif: '502782160',
        iban: 'PT50000201231234567890154',
        total: { toString: () => '1234.56' } as any,
        docDate: new Date('2026-09-01T00:00:00Z'),
        dueDate: new Date('2026-10-01T00:00:00Z'),
        nifValid: true,
        ibanValid: true,
        supplierNameConfidence: 0.95,
        supplierNifConfidence: 0.97,
        supplierIbanConfidence: 0.88,
        totalAmountConfidence: 0.94,
        issueDateConfidence: 0.93,
        dueDateConfidence: 0.93,
        metadata: { supplierAddress: 'Rua das Indústrias 123' },
      })
      // Subsequent reads (the nifValid / ibanValid recompute path is
      // only triggered when the corresponding field is the one being
      // confirmed, so we mock only what confirmField calls).
      .mockResolvedValueOnce({ supplierNif: '502782160', iban: 'PT50000201231234567890154' });

    prisma.document.update.mockResolvedValue({ id: DOC_ID });

    const svc = makeSvc(prisma, audit, storage);
    const result = await svc.confirmField(TENANT_A, USER_ID, DOC_ID, {
      field: 'supplierAddress',
      value: 'Rua Nova 456',
    });

    expect(result.ok).toBe(true);
    expect(result.field).toBe('supplierAddress');

    // Document.update was called with the metadata merge.
    expect(prisma.document.update).toHaveBeenCalled();
    const updateCalls = (prisma.document.update as jest.Mock).mock.calls;
    const metaUpdate = updateCalls.find(
      (c) => c[0]?.data?.metadata !== undefined,
    );
    expect(metaUpdate).toBeDefined();
    expect(metaUpdate[0].data.metadata.supplierAddress).toBe('Rua Nova 456');

    // Confirmation row recorded.
    expect(prisma.documentFieldConfirmation.create).toHaveBeenCalledTimes(1);
    const confArg = (prisma.documentFieldConfirmation.create as jest.Mock).mock.calls[0][0];
    expect(confArg.data).toMatchObject({
      tenantId: TENANT_A,
      documentId: DOC_ID,
      field: 'supplierAddress',
      value: 'Rua Nova 456',
      previousValue: 'Rua das Indústrias 123',
      confirmedById: USER_ID,
    });
    expect(confArg.data.confirmedAt).toBeInstanceOf(Date);

    // Audit row tagged with the diff.
    expect(audit.log).toHaveBeenCalledTimes(1);
    const auditArg = (audit.log as jest.Mock).mock.calls[0][0];
    expect(auditArg.action).toBe(AuditAction.EDIT);
    expect(auditArg.metadata.subAction).toBe('document.confirm_field');
    expect(auditArg.metadata.previousValue).toBe('Rua das Indústrias 123');
    expect(auditArg.metadata.newValue).toBe('Rua Nova 456');
    expect(auditArg.metadata.valueChanged).toBe(true);
  });

  it('records a confirmation with valueChanged=false when no value is supplied', async () => {
    const prisma = buildPrismaStub();
    const audit = buildAuditStub();
    const storage = buildStorageStub();

    prisma.document.findFirst.mockResolvedValueOnce({
      id: DOC_ID,
      supplier: 'EDENOX',
      supplierNif: '502782160',
      iban: 'PT50000201231234567890154',
      total: { toString: () => '1234.56' } as any,
      docDate: new Date('2026-09-01T00:00:00Z'),
      dueDate: new Date('2026-10-01T00:00:00Z'),
      nifValid: true,
      ibanValid: true,
      supplierNameConfidence: 0.95,
      supplierNifConfidence: 0.97,
      supplierIbanConfidence: 0.88,
      totalAmountConfidence: 0.94,
      issueDateConfidence: 0.93,
      dueDateConfidence: 0.93,
      metadata: {},
    });

    prisma.document.update.mockResolvedValue({ id: DOC_ID });

    const svc = makeSvc(prisma, audit, storage);
    await svc.confirmField(TENANT_A, USER_ID, DOC_ID, {
      field: 'supplierName',
    });

    // Audit row tagged with the no-change subAction.
    expect(audit.log).toHaveBeenCalledTimes(1);
    const auditArg = (audit.log as jest.Mock).mock.calls[0][0];
    expect(auditArg.metadata.subAction).toBe('document.confirm_field_no_change');
    expect(auditArg.metadata.valueChanged).toBe(false);
  });

  it('throws NotFoundException when the document belongs to another tenant', async () => {
    const prisma = buildPrismaStub();
    const audit = buildAuditStub();
    const storage = buildStorageStub();

    prisma.document.findFirst.mockResolvedValueOnce(null);

    const svc = makeSvc(prisma, audit, storage);

    await expect(
      svc.confirmField(TENANT_B, USER_ID, DOC_ID, {
        field: 'supplierName',
        value: 'X',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(prisma.document.update).not.toHaveBeenCalled();
    expect(prisma.documentFieldConfirmation.create).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('rejects malformed totalAmount values with a 400', async () => {
    const prisma = buildPrismaStub();
    const audit = buildAuditStub();
    const storage = buildStorageStub();

    prisma.document.findFirst.mockResolvedValueOnce({
      id: DOC_ID,
      supplier: 'EDENOX',
      supplierNif: '502782160',
      iban: 'PT50000201231234567890154',
      total: null,
      docDate: null,
      dueDate: null,
      nifValid: null,
      ibanValid: null,
      supplierNameConfidence: 0.95,
      supplierNifConfidence: 0.97,
      supplierIbanConfidence: 0.88,
      totalAmountConfidence: 0.94,
      issueDateConfidence: 0.93,
      dueDateConfidence: 0.93,
      metadata: {},
    });

    const svc = makeSvc(prisma, audit, storage);

    await expect(
      svc.confirmField(TENANT_A, USER_ID, DOC_ID, {
        field: 'totalAmount',
        value: 'not-a-number',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('recomputes nifValid when the supplierNif column changes', async () => {
    const prisma = buildPrismaStub();
    const audit = buildAuditStub();
    const storage = buildStorageStub();

    prisma.document.findFirst.mockResolvedValueOnce({
      id: DOC_ID,
      supplier: 'NOV OUSADO LDA',
      supplierNif: '000000000', // invalid (fails mod-11)
      iban: 'PT50003300004531296655007',
      total: null,
      docDate: null,
      dueDate: null,
      nifValid: false,
      ibanValid: true,
      supplierNameConfidence: 0.95,
      supplierNifConfidence: 0.97,
      supplierIbanConfidence: 0.88,
      totalAmountConfidence: 0.94,
      issueDateConfidence: 0.93,
      dueDateConfidence: 0.93,
      metadata: {},
    });

    prisma.document.update.mockResolvedValue({ id: DOC_ID });

    const svc = makeSvc(prisma, audit, storage);
    await svc.confirmField(TENANT_A, USER_ID, DOC_ID, {
      field: 'supplierNif',
      // mod-11-valid NIF (NOV OUSADO LDA per tax-id.validator.ts docblock).
      value: '515208566',
    });

    // Two updates: the column write + the validator recompute.
    expect(prisma.document.update).toHaveBeenCalledTimes(2);
    const calls = (prisma.document.update as jest.Mock).mock.calls;
    const validatorCall = calls.find(
      (c) => c[0]?.data?.nifValid !== undefined,
    );
    expect(validatorCall).toBeDefined();
    expect(validatorCall[0].data.nifValid).toBe(true);
  });
});

// ─── confirmAll ─────────────────────────────────────────────────────────────

describe('DocumentsService.confirmAll()', () => {
  it('stamps supplierVerifiedAt + emits an AuditAction.CONFIRM row', async () => {
    const prisma = buildPrismaStub();
    const audit = buildAuditStub();
    const storage = buildStorageStub();

    prisma.document.findFirst.mockResolvedValueOnce({
      id: DOC_ID,
      supplierVerifiedAt: null,
    });

    prisma.document.update.mockResolvedValue({ id: DOC_ID });

    const svc = makeSvc(prisma, audit, storage);
    const result = await svc.confirmAll(TENANT_A, USER_ID, DOC_ID, {
      confirmedFields: ['supplierName', 'supplierNif', 'totalAmount'],
    });

    expect(result.ok).toBe(true);
    expect(typeof result.verifiedAt).toBe('string');
    expect(() => new Date(result.verifiedAt).toISOString()).not.toThrow();
    expect(result.confirmedFields).toEqual(['supplierName', 'supplierNif', 'totalAmount']);

    expect(prisma.document.update).toHaveBeenCalledTimes(1);
    const updateArg = (prisma.document.update as jest.Mock).mock.calls[0][0];
    expect(updateArg.data.supplierVerifiedAt).toBeInstanceOf(Date);

    expect(audit.log).toHaveBeenCalledTimes(1);
    const auditArg = (audit.log as jest.Mock).mock.calls[0][0];
    expect(auditArg.action).toBe(AuditAction.CONFIRM);
    expect(auditArg.metadata.subAction).toBe('document.confirm_all');
    expect(auditArg.metadata.confirmedFields).toEqual([
      'supplierName',
      'supplierNif',
      'totalAmount',
    ]);
    expect(auditArg.metadata.previousVerifiedAt).toBeNull();
    expect(typeof auditArg.metadata.verifiedAt).toBe('string');
  });

  it('records previousVerifiedAt when called on an already-verified doc', async () => {
    const prisma = buildPrismaStub();
    const audit = buildAuditStub();
    const storage = buildStorageStub();

    const previous = new Date('2026-09-01T10:00:00Z');
    prisma.document.findFirst.mockResolvedValueOnce({
      id: DOC_ID,
      supplierVerifiedAt: previous,
    });

    prisma.document.update.mockResolvedValue({ id: DOC_ID });

    const svc = makeSvc(prisma, audit, storage);
    await svc.confirmAll(TENANT_A, USER_ID, DOC_ID, {
      confirmedFields: [],
    });

    const auditArg = (audit.log as jest.Mock).mock.calls[0][0];
    expect(auditArg.metadata.previousVerifiedAt).toBe(previous.toISOString());
  });

  it('throws NotFoundException for a cross-tenant id', async () => {
    const prisma = buildPrismaStub();
    const audit = buildAuditStub();
    const storage = buildStorageStub();

    prisma.document.findFirst.mockResolvedValueOnce(null);

    const svc = makeSvc(prisma, audit, storage);

    await expect(
      svc.confirmAll(TENANT_B, USER_ID, DOC_ID, { confirmedFields: [] }),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(prisma.document.update).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });
});

// ─── RBAC note (kept here so the next reviewer sees the gap) ────────────────
//
// The controller gates PATCH /confirm-field + POST /confirm-all with
// @Roles(ADMIN, OPERADOR); GET /extraction-confidence is open to every
// authenticated member. RBAC enforcement lives at the controller
// layer (rbac.guard) and is exercised end-to-end in the e2e suite.
// Unit-level tests bypass the guard by calling the service directly,
// which is the convention used by every other DocumentsService suite
// (correct-supplier, verify-supplier, hard-delete, …).
