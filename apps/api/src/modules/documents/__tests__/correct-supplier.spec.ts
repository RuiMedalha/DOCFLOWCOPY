import { AuditAction, DocumentProcessingStatus } from '@prisma/client';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DocumentsService } from '../documents.service';
import type { StorageService } from '../storage/storage-service.interface';
import { CorrectSupplierDto } from '../dto/document.dto';

/**
 * Sprint H+ — POST /documents/:id/correct-supplier
 *
 * Manual override of the supplier/customer fields when the AI extraction
 * picked the wrong side (the canonical "extracted the customer as the
 * supplier" failure mode). Tests cover the four invariants the endpoint
 * MUST hold:
 *
 *   1. Tenant ownership — cross-tenant id → 404, no mutation, no audit row.
 *   2. Forensic trail — a single audit row is written carrying the
 *      BEFORE/AFTER diff (oldSupplier / newSupplier / etc.) under
 *      subAction `document.correct_supplier`.
 *   3. Pipeline re-trigger — `document.uploaded` is published to the
 *      queue with the same payload shape as upload()/reExtract().
 *   4. DTO validation — bad NIF / IBAN fails class-validator BEFORE the
 *      service runs.
 *
 * No real DB / filesystem is touched; Prisma + storage + queue are
 * per-test jest mocks (same pattern as `re-extract.spec.ts`).
 */

const TENANT_A = 'tenant-A';
const TENANT_B = 'tenant-B';
const USER_ID = 'user-1';
const DOC_ID = 'doc-correct';

const BASE_DOC_ROW = {
  id: DOC_ID,
  supplier: 'NOV OUSADO LDA',
  supplierNif: '515208566',
  customer: 'EDENOX',
  customerNif: '502782160',
  iban: 'PT50003300004531296655007',
  partyId: null,
  fileKey: '_inbox/tenant-A/2026/09/invoice.pdf',
  mimeType: 'application/pdf',
  fileName: 'invoice.pdf',
  fileSize: 12345,
};

const VALID_DTO: CorrectSupplierDto = {
  supplier: 'EDENOX',
  supplierNif: '502782160',
  iban: 'PT50003300004531296655007',
  customer: 'NOV OUSADO LDA',
  customerNif: '515208566',
  reason: 'AI extracted wrong supplier',
};

function buildPrismaStub() {
  const stub: any = {
    document: {
      findFirst: jest.fn(),
      update: jest.fn(),
    },
    party: {
      findFirst: jest.fn(),
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

describe('DocumentsService.correctSupplier()', () => {
  it('overwrites supplier/customer fields and resets processingStatus when the tenant owns the doc', async () => {
    const prisma = buildPrismaStub();
    const audit = buildAuditStub();
    const storage = buildStorageStub();

    prisma.document.findFirst.mockResolvedValueOnce({ ...BASE_DOC_ROW });
    prisma.document.update.mockResolvedValueOnce({ id: DOC_ID });
    prisma.party.findFirst.mockResolvedValueOnce(null); // dto.partyId is undefined → not called

    const svc = makeSvc(prisma, audit, storage);
    const result = await svc.correctSupplier(TENANT_A, USER_ID, DOC_ID, { ...VALID_DTO });

    expect(result).toEqual({ ok: true, supplier: 'EDENOX', partyId: null });

    expect(prisma.document.update).toHaveBeenCalledTimes(1);
    const updateArg = (prisma.document.update as jest.Mock).mock.calls[0][0];
    expect(updateArg.where).toEqual({ id: DOC_ID });
    expect(updateArg.data.supplier).toBe('EDENOX');
    expect(updateArg.data.supplierNif).toBe('502782160');
    expect(updateArg.data.customer).toBe('NOV OUSADO LDA');
    expect(updateArg.data.customerNif).toBe('515208566');
    expect(updateArg.data.iban).toBe('PT50003300004531296655007');
    // partyId should NOT be in the update payload when dto.partyId is undefined
    expect('partyId' in updateArg.data).toBe(false);
    // Pipeline state reset (idempotency guard)
    expect(updateArg.data.processingStatus).toBe(DocumentProcessingStatus.RECEIVED);
    expect(updateArg.data.processingCompletedAt).toBeNull();
    expect(updateArg.data.processingError).toBeNull();
    expect(updateArg.data.processingStartedAt).toBeInstanceOf(Date);
  });

  it('publishes document.uploaded with the doc payload to the queue (pipeline re-trigger)', async () => {
    const prisma = buildPrismaStub();
    const audit = buildAuditStub();
    const storage = buildStorageStub();
    const queue = buildQueueStub();

    prisma.document.findFirst.mockResolvedValueOnce({ ...BASE_DOC_ROW });
    prisma.document.update.mockResolvedValueOnce({ id: DOC_ID });

    const svc = makeSvc(prisma, audit, storage, queue);
    await svc.correctSupplier(TENANT_A, USER_ID, DOC_ID, { ...VALID_DTO });

    expect(queue.publish).toHaveBeenCalledTimes(1);
    const [topic, payload] = (queue.publish as jest.Mock).mock.calls[0];
    expect(topic).toBe('document.uploaded');
    expect(payload).toMatchObject({
      topic: 'document.uploaded',
      documentId: DOC_ID,
      tenantId: TENANT_A,
      userId: USER_ID,
      fileKey: BASE_DOC_ROW.fileKey,
      mimeType: BASE_DOC_ROW.mimeType,
      fileSize: BASE_DOC_ROW.fileSize,
      originalFilename: BASE_DOC_ROW.fileName,
    });
    expect(payload.uploadedAt).toEqual(expect.any(String));
  });

  it('writes an audit row tagged document.correct_supplier with BEFORE/AFTER diff', async () => {
    const prisma = buildPrismaStub();
    const audit = buildAuditStub();
    const storage = buildStorageStub();

    prisma.document.findFirst.mockResolvedValueOnce({ ...BASE_DOC_ROW });
    prisma.document.update.mockResolvedValueOnce({ id: DOC_ID });

    const svc = makeSvc(prisma, audit, storage);
    await svc.correctSupplier(TENANT_A, USER_ID, DOC_ID, { ...VALID_DTO });

    expect(audit.log).toHaveBeenCalledTimes(1);
    const auditArg = (audit.log as jest.Mock).mock.calls[0][0];
    expect(auditArg).toMatchObject({
      tenantId: TENANT_A,
      userId: USER_ID,
      action: AuditAction.EDIT,
      entityType: 'document',
      entityId: DOC_ID,
    });
    expect(auditArg.metadata).toMatchObject({
      subAction: 'document.correct_supplier',
      oldSupplier: 'NOV OUSADO LDA',
      oldSupplierNif: '515208566',
      oldCustomer: 'EDENOX',
      oldCustomerNif: '502782160',
      oldIban: 'PT50003300004531296655007',
      oldPartyId: null,
      newSupplier: 'EDENOX',
      newSupplierNif: '502782160',
      newCustomer: 'NOV OUSADO LDA',
      newCustomerNif: '515208566',
      newIban: 'PT50003300004531296655007',
      newPartyId: null,
      reason: 'AI extracted wrong supplier',
    });
  });

  it('re-links partyId when dto.partyId resolves to a party in the same tenant', async () => {
    const prisma = buildPrismaStub();
    const audit = buildAuditStub();
    const storage = buildStorageStub();
    const PARTY_ID = 'party-edenox';

    prisma.document.findFirst.mockResolvedValueOnce({ ...BASE_DOC_ROW });
    prisma.party.findFirst.mockResolvedValueOnce({ id: PARTY_ID });
    prisma.document.update.mockResolvedValueOnce({ id: DOC_ID });

    const svc = makeSvc(prisma, audit, storage);
    const result = await svc.correctSupplier(TENANT_A, USER_ID, DOC_ID, {
      ...VALID_DTO,
      partyId: PARTY_ID,
    });

    expect(result.partyId).toBe(PARTY_ID);
    const updateArg = (prisma.document.update as jest.Mock).mock.calls[0][0];
    expect(updateArg.data.partyId).toBe(PARTY_ID);
    expect(prisma.party.findFirst).toHaveBeenCalledWith({
      where: { id: PARTY_ID, tenantId: TENANT_A },
      select: { id: true },
    });
  });

  it('throws NotFoundException when dto.partyId points to a party that does not exist in this tenant', async () => {
    const prisma = buildPrismaStub();
    const audit = buildAuditStub();
    const storage = buildStorageStub();

    prisma.document.findFirst.mockResolvedValueOnce({ ...BASE_DOC_ROW });
    prisma.party.findFirst.mockResolvedValueOnce(null); // party not in this tenant

    const svc = makeSvc(prisma, audit, storage);

    await expect(
      svc.correctSupplier(TENANT_A, USER_ID, DOC_ID, {
        ...VALID_DTO,
        partyId: 'party-not-in-tenant',
      }),
    ).rejects.toMatchObject({ status: 404 });

    // No document write / no audit row / no queue publish on a bad partyId.
    expect(prisma.document.update).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('coerces empty IBAN to null so FraudWarning does not render an empty chip', async () => {
    const prisma = buildPrismaStub();
    const audit = buildAuditStub();
    const storage = buildStorageStub();

    prisma.document.findFirst.mockResolvedValueOnce({ ...BASE_DOC_ROW });
    prisma.document.update.mockResolvedValueOnce({ id: DOC_ID });

    const svc = makeSvc(prisma, audit, storage);
    await svc.correctSupplier(TENANT_A, USER_ID, DOC_ID, {
      ...VALID_DTO,
      iban: '   ',
    });

    const updateArg = (prisma.document.update as jest.Mock).mock.calls[0][0];
    expect(updateArg.data.iban).toBeNull();
  });

  it('throws NotFoundException when the document belongs to another tenant', async () => {
    const prisma = buildPrismaStub();
    const audit = buildAuditStub();
    const storage = buildStorageStub();

    // tenant-scoped findFirst returns null when the doc belongs to TENANT_B
    prisma.document.findFirst.mockResolvedValueOnce(null);

    const svc = makeSvc(prisma, audit, storage);

    await expect(
      svc.correctSupplier(TENANT_A, USER_ID, DOC_ID, { ...VALID_DTO }),
    ).rejects.toBeInstanceOf(NotFoundException);

    // No mutation should have happened when the doc is not in this tenant.
    expect(prisma.document.update).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });
});

describe('CorrectSupplierDto — class-validator', () => {
  it('accepts a valid payload', async () => {
    const errors = await validate(plain(VALID_DTO));
    expect(errors).toHaveLength(0);
  });

  it('rejects a supplierNif that does not match the regex (lowercase)', async () => {
    const dto = plain({ ...VALID_DTO, supplierNif: 'pt502782160' });
    const errors = await validate(dto);
    const nifErr = errors.find((e) => e.property === 'supplierNif');
    expect(nifErr).toBeDefined();
  });

  it('rejects an IBAN that is missing the country prefix', async () => {
    const dto = plain({ ...VALID_DTO, iban: '50003300004531296655007' });
    const errors = await validate(dto);
    const ibanErr = errors.find((e) => e.property === 'iban');
    expect(ibanErr).toBeDefined();
  });

  it('rejects an empty supplier / customer', async () => {
    const dto = plain({ ...VALID_DTO, supplier: '' });
    const errors = await validate(dto);
    const supplierErr = errors.find((e) => e.property === 'supplier');
    expect(supplierErr).toBeDefined();

    const dto2 = plain({ ...VALID_DTO, customer: '' });
    const errors2 = await validate(dto2);
    const customerErr = errors2.find((e) => e.property === 'customer');
    expect(customerErr).toBeDefined();
  });
});

/** Strip methods class-validator needs so the DTO acts as a plain object. */
function plain(input: Record<string, unknown>): CorrectSupplierDto {
  return plainToInstance(CorrectSupplierDto, input);
}

// Silence "not used" lints when only the DTO suite is exercising BadRequestException.
void BadRequestException;
