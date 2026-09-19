import { AuditAction } from '@prisma/client';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DocumentsService } from '../documents.service';
import type { StorageService } from '../storage/storage-service.interface';
import { UpdateSupplierDto } from '../dto/supplier.dto';

/**
 * Sprint H+ Part 2 — supplier surface.
 *
 * Covers:
 *   1. `extractSupplierFromDocument` — re-extract path
 *      - happy path: AI vision + regex return a payload; service
 *        persists + audits.
 *      - Operator-Verified Guard: `supplierVerifiedAt` set +
 *        `opts.force !== true` → 409 ConflictException, no write.
 *      - Operator-Verified Guard: `supplierVerifiedAt` set +
 *        `opts.force === true` → succeeds, audit row carries `forced: true`.
 *
 *   2. `updateSupplier` — manual edit path
 *      - happy path: valid payload overwrites the row, audit row
 *        carries the BEFORE/AFTER diff + `changedFields`.
 *      - partial update: only the supplied fields change; the others
 *        are preserved.
 *      - pipeline re-trigger: `document.uploaded` is published.
 *
 *   3. `UpdateSupplierDto` — class-validator
 *      - happy path: payload with valid PT NIF + mod-97 IBAN passes.
 *      - PT NIF that fails mod-11 → 400.
 *      - IBAN that fails mod-97 → 400.
 *      - empty payload (no fields supplied) controller-level concern,
 *        covered via the DTO `validate()` path (no validator fires
 *        for empty body → 0 errors, then the controller throws 400).
 *
 * Per-test jest mocks — same pattern as `correct-supplier.spec.ts` /
 * `re-extract.spec.ts` — no real DB or filesystem is touched.
 */

const TENANT_A = 'tenant-A';
const USER_ID = 'user-1';
const DOC_ID = 'doc-supplier';

const BASE_DOC_ROW = {
  id: DOC_ID,
  supplier: 'OLD NAME',
  supplierNif: '515208566',
  iban: 'PT50000201231234567890154',
  partyId: null,
  fileKey: '_inbox/tenant-A/2026/09/invoice.pdf',
  mimeType: 'application/pdf',
  fileName: 'invoice.pdf',
  fileSize: 12345,
  metadata: null as Record<string, unknown> | null,
  supplierVerifiedAt: null as Date | null,
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
    extractSupplierFromDocument: jest.fn(async () => ({
      supplierName: 'NEW NAME FROM AI',
      supplierNif: '515208566',
      supplierIban: 'PT50000201231234567890154',
      address: null,
      country: 'PT',
    })),
  };
}

function makeSvc(
  prisma: any,
  audit: any,
  storage: StorageService,
  queue?: any,
  extraction?: any,
) {
  return new DocumentsService(
    prisma as any,
    audit as any,
    storage as any,
    buildRulesEngineStub() as any,
    (extraction ?? buildExtractionStub()) as any,
    buildImageToPdfStub() as any,
    buildNifLookupStub() as any,
    (queue ?? buildQueueStub()) as any,
  );
}

// ─────────────────────────────────────────────── re-extract ────────────────

describe('DocumentsService.extractSupplierFromDocument()', () => {
  it('persists the supplier block + audit row when no supplierVerifiedAt is set', async () => {
    const prisma = buildPrismaStub();
    const audit = buildAuditStub();
    const storage = buildStorageStub();

    prisma.document.findFirst.mockResolvedValueOnce({ ...BASE_DOC_ROW });
    prisma.document.update.mockResolvedValueOnce({ id: DOC_ID });

    const svc = makeSvc(prisma, audit, storage);
    const result = await svc.extractSupplierFromDocument(
      TENANT_A,
      USER_ID,
      DOC_ID,
    );

    expect(result).toEqual({
      ok: true,
      reExtracted: true,
      supplier: {
        name: 'NEW NAME FROM AI',
        nif: '515208566',
        iban: 'PT50000201231234567890154',
        address: null,
        country: 'PT',
      },
    });

    // Persisted fields — supplier + nif + iban (the AI stub's return value).
    expect(prisma.document.update).toHaveBeenCalledTimes(1);
    const updateArg = (prisma.document.update as jest.Mock).mock.calls[0][0];
    expect(updateArg.where).toEqual({ id: DOC_ID });
    expect(updateArg.data.supplier).toBe('NEW NAME FROM AI');
    expect(updateArg.data.supplierNif).toBe('515208566');
    expect(updateArg.data.iban).toBe('PT50000201231234567890154');
    // Country lands in metadata (no dedicated column).
    expect(updateArg.data.metadata.supplierCountry).toBe('PT');
    // supplierVerifiedAt is NOT cleared by a re-extract.
    // (Setting verifiedAt is a separate operator decision.)

    // Audit row — subAction + BEFORE/AFTER diff.
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
      subAction: 'document.extract_supplier',
      oldSupplier: 'OLD NAME',
      newSupplier: 'NEW NAME FROM AI',
      oldSupplierNif: '515208566',
      newSupplierNif: '515208566',
      oldIban: 'PT50000201231234567890154',
      newIban: 'PT50000201231234567890154',
      newSupplierCountry: 'PT',
      forced: false,
      fieldsChanged: true,
    });
  });

  it('throws ConflictException (409) when supplierVerifiedAt is set and force is NOT passed', async () => {
    const prisma = buildPrismaStub();
    const audit = buildAuditStub();
    const storage = buildStorageStub();

    prisma.document.findFirst.mockResolvedValueOnce({
      ...BASE_DOC_ROW,
      supplierVerifiedAt: new Date('2026-09-01T00:00:00Z'),
    });

    const svc = makeSvc(prisma, audit, storage);

    await expect(
      svc.extractSupplierFromDocument(TENANT_A, USER_ID, DOC_ID),
    ).rejects.toBeInstanceOf(ConflictException);

    // No document write / no audit row when the guard fires.
    expect(prisma.document.update).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('overwrites the verified supplier block when force=true is passed', async () => {
    const prisma = buildPrismaStub();
    const audit = buildAuditStub();
    const storage = buildStorageStub();

    prisma.document.findFirst.mockResolvedValueOnce({
      ...BASE_DOC_ROW,
      supplierVerifiedAt: new Date('2026-09-01T00:00:00Z'),
    });
    prisma.document.update.mockResolvedValueOnce({ id: DOC_ID });

    const svc = makeSvc(prisma, audit, storage);
    const result = await svc.extractSupplierFromDocument(
      TENANT_A,
      USER_ID,
      DOC_ID,
      { force: true },
    );

    // Service still returns the AI-extracted payload, even on a
    // previously-verified row, because the operator explicitly opted
    // into the overwrite.
    expect(result.supplier.name).toBe('NEW NAME FROM AI');

    expect(prisma.document.update).toHaveBeenCalledTimes(1);
    expect(audit.log).toHaveBeenCalledTimes(1);
    const auditArg = (audit.log as jest.Mock).mock.calls[0][0];
    // `forced: true` ends up on the audit row so the forensic trail
    // shows "yes, the operator knew they were overwriting a verified
    // block".
    expect(auditArg.metadata.forced).toBe(true);
    expect(auditArg.metadata.subAction).toBe('document.extract_supplier');
  });

  it('throws NotFoundException on cross-tenant document', async () => {
    const prisma = buildPrismaStub();
    const audit = buildAuditStub();
    const storage = buildStorageStub();

    prisma.document.findFirst.mockResolvedValueOnce(null);

    const svc = makeSvc(prisma, audit, storage);

    await expect(
      svc.extractSupplierFromDocument(TENANT_A, USER_ID, DOC_ID),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(prisma.document.update).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────── update-supplier ───────────────

describe('DocumentsService.updateSupplier()', () => {
  it('overwrites only the supplied fields and writes an audit row with changedFields', async () => {
    const prisma = buildPrismaStub();
    const audit = buildAuditStub();
    const storage = buildStorageStub();

    prisma.document.findFirst.mockResolvedValueOnce({ ...BASE_DOC_ROW });
    prisma.document.update.mockResolvedValueOnce({ id: DOC_ID });

    const svc = makeSvc(prisma, audit, storage);
    const result = await svc.updateSupplier(TENANT_A, USER_ID, DOC_ID, {
      name: 'NEW NAME',
      nif: '515208566',
    });

    expect(result.ok).toBe(true);
    expect(result.supplier).toEqual({
      name: 'NEW NAME',
      nif: '515208566',
      iban: 'PT50000201231234567890154', // unchanged from existing row
      address: null,
      country: null,
    });

    // Persisted payload only carries the fields we supplied — name and
    // nif are overwritten, iban/country are NOT in the payload.
    const updateArg = (prisma.document.update as jest.Mock).mock.calls[0][0];
    expect(updateArg.data.supplier).toBe('NEW NAME');
    expect(updateArg.data.supplierNif).toBe('515208566');
    expect('iban' in updateArg.data).toBe(false);
    expect('metadata' in updateArg.data).toBe(false);
    // Pipeline reset (mirrors correct-supplier / re-extract).
    expect(updateArg.data.processingStatus).toBe('RECEIVED');
    expect(updateArg.data.processingCompletedAt).toBeNull();
    expect(updateArg.data.processingError).toBeNull();

    expect(audit.log).toHaveBeenCalledTimes(1);
    const auditArg = (audit.log as jest.Mock).mock.calls[0][0];
    expect(auditArg.metadata).toMatchObject({
      subAction: 'document.update_supplier',
      oldSupplier: 'OLD NAME',
      newSupplier: 'NEW NAME',
      oldSupplierNif: '515208566',
      newSupplierNif: '515208566',
      // Unchanged fields still land on the audit row as the existing value.
      oldIban: 'PT50000201231234567890154',
      newIban: 'PT50000201231234567890154',
      changedFields: ['name', 'nif'],
    });
  });

  it('publishes document.uploaded so the pipeline re-runs', async () => {
    const prisma = buildPrismaStub();
    const audit = buildAuditStub();
    const storage = buildStorageStub();
    const queue = buildQueueStub();

    prisma.document.findFirst.mockResolvedValueOnce({ ...BASE_DOC_ROW });
    prisma.document.update.mockResolvedValueOnce({ id: DOC_ID });

    const svc = makeSvc(prisma, audit, storage, queue);
    await svc.updateSupplier(TENANT_A, USER_ID, DOC_ID, {
      name: 'NEW NAME',
    });

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
    });
  });

  it('writes supplierAddress + supplierCountry into metadata when supplied', async () => {
    const prisma = buildPrismaStub();
    const audit = buildAuditStub();
    const storage = buildStorageStub();

    prisma.document.findFirst.mockResolvedValueOnce({ ...BASE_DOC_ROW });
    prisma.document.update.mockResolvedValueOnce({ id: DOC_ID });

    const svc = makeSvc(prisma, audit, storage);
    const result = await svc.updateSupplier(TENANT_A, USER_ID, DOC_ID, {
      address: 'Rua das Indústrias 123',
      country: 'PT',
    });

    expect(result.supplier.address).toBe('Rua das Indústrias 123');
    expect(result.supplier.country).toBe('PT');

    const updateArg = (prisma.document.update as jest.Mock).mock.calls[0][0];
    expect(updateArg.data.metadata.supplierAddress).toBe(
      'Rua das Indústrias 123',
    );
    expect(updateArg.data.metadata.supplierCountry).toBe('PT');

    const auditArg = (audit.log as jest.Mock).mock.calls[0][0];
    expect(auditArg.metadata.changedFields).toEqual(['address', 'country']);
  });

  it('coerces an empty IBAN string to null (FraudWarning does not render an empty chip)', async () => {
    const prisma = buildPrismaStub();
    const audit = buildAuditStub();
    const storage = buildStorageStub();

    prisma.document.findFirst.mockResolvedValueOnce({ ...BASE_DOC_ROW });
    prisma.document.update.mockResolvedValueOnce({ id: DOC_ID });

    const svc = makeSvc(prisma, audit, storage);
    await svc.updateSupplier(TENANT_A, USER_ID, DOC_ID, { iban: '   ' });

    const updateArg = (prisma.document.update as jest.Mock).mock.calls[0][0];
    expect(updateArg.data.iban).toBeNull();
  });

  it('throws NotFoundException on cross-tenant document', async () => {
    const prisma = buildPrismaStub();
    const audit = buildAuditStub();
    const storage = buildStorageStub();

    prisma.document.findFirst.mockResolvedValueOnce(null);

    const svc = makeSvc(prisma, audit, storage);

    await expect(
      svc.updateSupplier(TENANT_A, USER_ID, DOC_ID, { name: 'X' }),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(prisma.document.update).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────── UpdateSupplierDto validators ──

describe('UpdateSupplierDto — class-validator', () => {
  it('accepts a valid payload (PT NIF + mod-97 IBAN)', async () => {
    const dto = plain({
      name: 'EDENOX',
      nif: '515208566',
      iban: 'PT50000201231234567890154',
      address: 'Rua das Indústrias 123',
      country: 'PT',
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('accepts a Spanish NIF (foreign VAT — mod-11 skipped)', async () => {
    // Spanish ONNERA CIF — isValidPortugueseNif returns false for
    // non-PT NIFs (line 73 in tax-id.validator.ts), so our validator
    // must accept foreign VAT IDs without choking on them.
    const dto = plain({ nif: 'ES14219836' });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('rejects a PT NIF that fails the mod-11 checksum', async () => {
    // 100000000 — mod-11 expects a `2`, actual is `0` → invalid.
    const dto = plain({ nif: '100000000' });
    const errors = await validate(dto);
    const nifErr = errors.find((e) => e.property === 'nif');
    expect(nifErr).toBeDefined();
  });

  it('rejects an IBAN that fails the mod-97 checksum', async () => {
    // PT50003300004531296655007 — mod-97 = 88 (NOT 1), so the
    // structural validator catches this even though the body is the
    // right length and country prefix.
    const dto = plain({ iban: 'PT50003300004531296655007' });
    const errors = await validate(dto);
    const ibanErr = errors.find((e) => e.property === 'iban');
    expect(ibanErr).toBeDefined();
  });

  it('accepts a structurally valid IBAN with whitespace and lowercase', async () => {
    const dto = plain({ iban: 'es25 0182 5699 6902 0151 5634' });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('treats null / empty fields as valid (optional semantics)', async () => {
    const dto = plain({});
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });
});

// ─────────────────────────────────────────── mergeSupplierOnly ─────────────
//
// Unit coverage for the top-level helper exported by extraction.service.ts.
// Pure function — no DI needed. Pins the vision-wins-over-regex merge
// priority and the empty-string fallback to null.

import { mergeSupplierOnly } from '../../extraction/extraction.service';

describe('mergeSupplierOnly()', () => {
  it('returns null fields when both inputs are null', () => {
    expect(mergeSupplierOnly(null, null)).toEqual({
      supplierName: null,
      supplierNif: null,
      supplierIban: null,
      address: null,
      country: null,
    });
  });

  it('vision wins on overlap', () => {
    const vision = {
      supplier: 'VISION-NAME',
      supplierNif: '515208566',
      iban: 'PT50000201231234567890154',
      country: 'PT',
    };
    const regex = {
      supplier: 'REGEX-NAME',
      supplierNif: '999999990',
      iban: 'PT99999999999999999999999',
      country: 'ES',
    };
    const out = mergeSupplierOnly(vision as any, regex as any);
    expect(out.supplierName).toBe('VISION-NAME');
    expect(out.supplierNif).toBe('515208566');
    expect(out.supplierIban).toBe('PT50000201231234567890154');
    expect(out.country).toBe('PT');
  });

  it('falls back to regex when vision has empty/missing fields', () => {
    const vision = { supplier: '', supplierNif: undefined };
    const regex = { supplier: 'REGEX-NAME', supplierNif: '515208566' };
    const out = mergeSupplierOnly(vision as any, regex as any);
    expect(out.supplierName).toBe('REGEX-NAME');
    expect(out.supplierNif).toBe('515208566');
  });
});

/** Strip methods class-validator needs so the DTO acts as a plain object. */
function plain(input: Record<string, unknown>): UpdateSupplierDto {
  return plainToInstance(UpdateSupplierDto, input);
}
