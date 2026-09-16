import { BadRequestException, ConflictException } from '@nestjs/common';
import { AuditAction, DocumentOrigin, DocumentStatus, DocumentType } from '@prisma/client';
import * as crypto from 'crypto';
import { DocumentsService } from './documents.service';
import type { StorageService } from './storage/storage-service.interface';

// ──────────────────────────────────────────────── test doubles
const TENANT_ID = 'tenant-test-1';
const USER_ID = 'user-test-1';

type DeepPartial<T> = { [K in keyof T]?: T[K] };

function buildPrismaStub() {
  const document = {
    findFirst: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  };
  const folder = { findFirst: jest.fn(), create: jest.fn() };
  const folderRule = { findMany: jest.fn() };
  const party = { findFirst: jest.fn() };
  const account = { upsert: jest.fn() };

  return {
    document,
    folder,
    folderRule,
    party,
    account,
  };
}

function buildAuditStub() {
  return {
    log: jest.fn(async () => undefined),
    logInTx: jest.fn(async () => undefined),
    verifyChain: jest.fn(async () => ({ valid: true })),
  };
}

function buildStorageStub(): StorageService {
  return {
    driver: 'local',
    put: jest.fn(async (_key, _buf) => undefined),
    getBuffer: jest.fn(async (_key) => ({ buffer: Buffer.from(''), size: 0 })),
    remove: jest.fn(async () => undefined),
    exists: jest.fn(async () => true),
    move: jest.fn(async () => undefined),
    getSignedUrl: jest.fn(async (key) => `/api/v1/documents/storage/${encodeURIComponent(key)}`),
  };
}

function buildRulesEngineStub() {
  return {
    suggest: jest.fn(async (_tenantId, _doc, _date) => '/Inbox/2026/08/OUTRO'),
    render: jest.fn(),
    fallback: jest.fn(),
  };
}

function buildImageToPdfStub() {
  // Default: no PDF derivative (tests for PDFs don't care). The
  // image→PDF tests override `supports` / `convert`.
  return {
    supports: jest.fn(() => false),
    convert: jest.fn(),
  };
}

function makePdfBuffer(payload = 'hello docflow'): Buffer {
  // Magic-bytes fix (AUDIT §4.8): prepend the PDF `%PDF-` signature so the
  // buffer survives the new MIME-confusion check in `upload()`. The trailing
  // payload is whatever the test asserts about.
  return Buffer.concat([Buffer.from('%PDF-1.4\n', 'utf8'), Buffer.from(payload, 'utf8')]);
}

function makeJpegBuffer(payload = 'jpeg-bytes'): Buffer {
  // Magic-bytes fix: prepend the JPEG SOI + APP0 signature so the buffer
  // survives `assertMimeMatchesSignature` in `upload()`.
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(payload, 'utf8')]);
}

// ──────────────────────────────────────────────── tests

describe('DocumentsService', () => {
  let svc: DocumentsService;
  let prisma: ReturnType<typeof buildPrismaStub>;
  let audit: ReturnType<typeof buildAuditStub>;
  let storage: StorageService;
  let rules: ReturnType<typeof buildRulesEngineStub>;
  let imageToPdf: ReturnType<typeof buildImageToPdfStub>;

  beforeEach(() => {
    prisma = buildPrismaStub();
    audit = buildAuditStub();
    storage = buildStorageStub();
    rules = buildRulesEngineStub();
    imageToPdf = buildImageToPdfStub();
    // Default folder-create stub — materialiseFolderPath() may call it.
    // Tests that need different behaviour override per-test.
    prisma.folder.create.mockImplementation(async ({ data }) => ({
      id: `folder-${data.name}`,
      ...data,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));
    // Default folder.findFirst: no existing folder row.
    prisma.folder.findFirst.mockResolvedValue(null);
    // Default party.findFirst: no linked party.
    prisma.party.findFirst.mockResolvedValue(null);
    svc = new DocumentsService(
      prisma as any,
      audit as any,
      storage,
      rules as any,
      // ExtractionService stub — auto-extract fires-and-forgets in
      // upload(), so a no-op stub is enough for the dedup tests.
      { enqueue: jest.fn().mockResolvedValue({ queued: false, documentId: 'doc-1', ok: true }) } as any,
      imageToPdf as any,
      // QueueAdapter stub — Sprint H pipeline trigger publishes
      // `document.uploaded` to this adapter; tests don't assert on it.
      {
        driver: 'eventemitter' as const,
        publish: jest.fn().mockResolvedValue(undefined),
        subscribe: jest.fn(),
        subscribeBatch: jest.fn(),
      } as any,
    );
  });

  // ──────────────────────────────────────────────── upload + hash dedup
  describe('upload() — SHA-256 dedup', () => {
    const file = {
      fieldname: 'file',
      originalname: 'invoice.pdf',
      encoding: '7bit',
      mimetype: 'application/pdf',
      size: 5,
      buffer: makePdfBuffer('the same bytes'),
    };

    it('persists a new document and computes the file hash', async () => {
      prisma.document.findFirst.mockResolvedValue(null); // no duplicate
      rules.suggest.mockResolvedValue('/2026/08/fatura_recebida/_');
      prisma.document.create.mockImplementation(async ({ data }) => ({
        id: 'doc-1',
        ...data,
        createdAt: new Date(),
        updatedAt: new Date(),
      }));
      // Audit writes now go through AuditService — stubbed above.

      const out = await svc.upload(TENANT_ID, USER_ID, file, DocumentOrigin.UPLOAD);

      // Hash matches SHA-256 of "the same bytes"
      const expectedHash = crypto.createHash('sha256').update(file.buffer).digest('hex');
      expect(prisma.document.create).toHaveBeenCalledTimes(1);
      const createArgs = prisma.document.create.mock.calls[0][0];
      expect(createArgs.data.fileHash).toBe(expectedHash);
      // Sprint E fix-up: every upload lands under `_inbox/` so the
      // approve → relocate flow can move it to the party/category folder.
      expect(createArgs.data.fileKey).toMatch(/^_inbox\/tenant-test-1\/\d{4}\/\d{2}\//);
      expect(createArgs.data.fileKey.endsWith('.pdf')).toBe(true);
      expect(createArgs.data.status).toBe(DocumentStatus.NOVO);
      expect(createArgs.data.suggestedFolder).toBe('/2026/08/fatura_recebida/_');
      expect(createArgs.data.finalFolder).toBe('/2026/08/fatura_recebida/_');

      expect(storage.put).toHaveBeenCalledWith(
        createArgs.data.fileKey,
        file.buffer,
        { contentType: 'application/pdf' },
      );

      // Audit log entry was written via AuditService
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.UPLOAD,
          entityType: 'document',
          entityId: 'doc-1',
          tenantId: TENANT_ID,
          userId: USER_ID,
        }),
      );

      // Sanitize: fileKey and fileHash MUST NOT leak in the response.
      expect(out).not.toHaveProperty('fileKey');
      expect(out).not.toHaveProperty('fileHash');
      expect(out.id).toBe('doc-1');
    });

    it('rejects a duplicate file (same hash) per tenant with the existing id', async () => {
      const existingId = 'doc-existing';
      prisma.document.findFirst.mockResolvedValue({
        id: existingId,
        fileName: 'invoice.pdf',
        createdAt: new Date(),
      });

      await expect(
        svc.upload(TENANT_ID, USER_ID, file, DocumentOrigin.UPLOAD),
      ).rejects.toBeInstanceOf(ConflictException);

      // Nothing was written — neither the file nor the row, no audit log.
      expect(storage.put).not.toHaveBeenCalled();
      expect(prisma.document.create).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
    });

    // ──────────────── H-06 unique-violation race ────────────────
    it('H-06: a unique-violation (P2002) during create is converted into a clean 409', async () => {
      // First read says no duplicate (the race window). Then Prisma throws
      // a P2002 because a concurrent upload of the same bytes beat us.
      // The service must re-read, return the winner's id, and surface a
      // 409 ConflictException.
      prisma.document.findFirst.mockResolvedValueOnce(null); // pre-check
      const p2002 = Object.assign(new Error('Unique constraint violation'), {
        code: 'P2002',
      });
      prisma.document.create.mockRejectedValueOnce(p2002);
      prisma.document.findFirst.mockResolvedValueOnce({
        id: 'doc-winner',
        fileName: 'invoice.pdf',
        createdAt: new Date(),
      });

      await expect(
        svc.upload(TENANT_ID, USER_ID, file, DocumentOrigin.UPLOAD),
      ).rejects.toMatchObject({
        // ConflictException shape from the service — body tells the client
        // the surviving row's id.
        response: expect.objectContaining({
          message: expect.stringContaining('Duplicate'),
        }),
      });
    });

    it('per-tenant dedup: same bytes from another tenant are allowed', async () => {
      // Prisma stub is tenant-scoped via `where.tenantId`, so the same
      // findFirst with a different tenantId returns null. We simulate that
      // by accepting the call and returning null for this tenant.
      prisma.document.findFirst.mockResolvedValue(null);
      rules.suggest.mockResolvedValue('/Inbox/2026/08/OUTRO');
      prisma.document.create.mockImplementation(async ({ data }) => ({
        id: 'doc-2',
        ...data,
        createdAt: new Date(),
        updatedAt: new Date(),
      }));
      // Audit writes now go through AuditService — stubbed above.

      const out = await svc.upload('tenant-other', USER_ID, file, DocumentOrigin.UPLOAD);
      expect(out.id).toBe('doc-2');
      expect(prisma.document.create).toHaveBeenCalledTimes(1);
    });

    it('rejects unsupported mime types before computing a hash', async () => {
      const bad = { ...file, mimetype: 'application/x-msdownload' };
      await expect(svc.upload(TENANT_ID, USER_ID, bad, DocumentOrigin.UPLOAD)).rejects.toThrow(
        /Unsupported file type/,
      );
      expect(prisma.document.findFirst).not.toHaveBeenCalled();
    });
  });

  // ──────────────────────────────────────────────── image → PDF derivative
  describe('upload() — image → PDF derivative', () => {
    const makeJpeg = (payload = 'jpeg-bytes') => makeJpegBuffer(payload);

    beforeEach(() => {
      // Default imageToPdf stub: yes it supports jpeg, returns a
      // minimal PDF buffer. Tests that need different behaviour override.
      imageToPdf.supports.mockImplementation(
        (m: string) => m === 'image/jpeg' || m === 'image/png',
      );
      imageToPdf.convert.mockResolvedValue(Buffer.from('%PDF-1.7\nfake'));
    });

    it('generates a PDF sibling when the upload is image/jpeg', async () => {
      const jpeg = makeJpeg();
      const file = {
        fieldname: 'file',
        originalname: 'phone.jpg',
        encoding: '7bit',
        mimetype: 'image/jpeg',
        size: jpeg.length,
        buffer: jpeg,
      };
      prisma.document.findFirst.mockResolvedValue(null);
      rules.suggest.mockResolvedValue('/Inbox/2026/08/OUTRO');
      prisma.document.create.mockImplementation(async ({ data }) => ({
        id: 'doc-jpg',
        ...data,
        createdAt: new Date(),
        updatedAt: new Date(),
      }));

      await svc.upload(TENANT_ID, USER_ID, file, DocumentOrigin.UPLOAD);

      expect(imageToPdf.supports).toHaveBeenCalledWith('image/jpeg');
      expect(imageToPdf.convert).toHaveBeenCalledWith(jpeg, 'image/jpeg');

      const createArgs = prisma.document.create.mock.calls[0][0];
      expect(createArgs.data.fileKey).toMatch(/\.jpg$/);
      expect(createArgs.data.pdfKey).toMatch(/\.pdf$/);
      expect(createArgs.data.pdfKey).toBe(
        createArgs.data.fileKey.replace(/\.jpg$/, '.pdf'),
      );

      // Storage.put called twice — original then PDF.
      expect(storage.put).toHaveBeenCalledTimes(2);
      const putCalls = (storage.put as jest.Mock).mock.calls;
      expect(putCalls[0][0]).toBe(createArgs.data.fileKey);
      expect(putCalls[1][0]).toBe(createArgs.data.pdfKey);
      expect(putCalls[1][2]).toEqual({ contentType: 'application/pdf' });
    });

    it('skips PDF generation for non-image uploads (PDF / DOCX)', async () => {
      const pdfFile = {
        fieldname: 'file',
        originalname: 'invoice.pdf',
        encoding: '7bit',
        mimetype: 'application/pdf',
        size: 4,
        buffer: makePdfBuffer('pdf!'),
      };
      prisma.document.findFirst.mockResolvedValue(null);
      rules.suggest.mockResolvedValue('/Inbox/2026/08/OUTRO');
      prisma.document.create.mockImplementation(async ({ data }) => ({
        id: 'doc-pdf',
        ...data,
        createdAt: new Date(),
        updatedAt: new Date(),
      }));

      await svc.upload(TENANT_ID, USER_ID, pdfFile, DocumentOrigin.UPLOAD);

      expect(imageToPdf.supports).toHaveBeenCalledWith('application/pdf');
      expect(imageToPdf.convert).not.toHaveBeenCalled();
      const createArgs = prisma.document.create.mock.calls[0][0];
      expect(createArgs.data.pdfKey).toBeNull();
    });

    it('continues upload (with image only) when PDF generation throws', async () => {
      const jpeg = makeJpeg();
      const file = {
        fieldname: 'file',
        originalname: 'phone.jpg',
        encoding: '7bit',
        mimetype: 'image/jpeg',
        size: jpeg.length,
        buffer: jpeg,
      };
      prisma.document.findFirst.mockResolvedValue(null);
      rules.suggest.mockResolvedValue('/Inbox/2026/08/OUTRO');
      prisma.document.create.mockImplementation(async ({ data }) => ({
        id: 'doc-no-pdf',
        ...data,
        createdAt: new Date(),
        updatedAt: new Date(),
      }));
      imageToPdf.convert.mockRejectedValue(new Error('pdf-lib OOM'));

      const out = await svc.upload(TENANT_ID, USER_ID, file, DocumentOrigin.UPLOAD);

      // Upload succeeds; the Document row has pdfKey=null because the
      // derivative failed.
      expect(out.id).toBe('doc-no-pdf');
      const createArgs = prisma.document.create.mock.calls[0][0];
      expect(createArgs.data.fileKey).toMatch(/\.jpg$/);
      expect(createArgs.data.pdfKey).toBeNull();
    });
  });

  // ──────────────────────────────────────────────── folder rule engine wiring
  describe('upload() — folder-rule integration', () => {
    const file = {
      fieldname: 'file',
      originalname: 'invoice.pdf',
      encoding: '7bit',
      mimetype: 'application/pdf',
      size: 5,
      buffer: makePdfBuffer(),
    };

    it('passes the pre-classified type to the rules engine', async () => {
      prisma.document.findFirst.mockResolvedValue(null);
      rules.suggest.mockImplementation(async (_t, doc) => `/2026/08/${doc.type}/_`);
      prisma.document.create.mockImplementation(async ({ data }) => ({
        id: 'doc-3',
        ...data,
        createdAt: new Date(),
        updatedAt: new Date(),
      }));
      // Audit writes now go through AuditService — stubbed above.

      await svc.upload(
        TENANT_ID,
        USER_ID,
        file,
        DocumentOrigin.EMAIL,
        DocumentType.FATURA_RECEBIDA,
      );

      expect(rules.suggest).toHaveBeenCalledTimes(1);
      const [calledTenant, calledDoc] = rules.suggest.mock.calls[0];
      expect(calledTenant).toBe(TENANT_ID);
      expect(calledDoc.type).toBe(DocumentType.FATURA_RECEBIDA);

      const createArgs = prisma.document.create.mock.calls[0][0];
      expect(createArgs.data.type).toBe(DocumentType.FATURA_RECEBIDA);
      expect(createArgs.data.origin).toBe(DocumentOrigin.EMAIL);
    });

    it('falls back to OUTRO when no pre-classification is provided', async () => {
      prisma.document.findFirst.mockResolvedValue(null);
      rules.suggest.mockResolvedValue('/Inbox/2026/08/OUTRO');
      prisma.document.create.mockImplementation(async ({ data }) => ({
        id: 'doc-4',
        ...data,
        createdAt: new Date(),
        updatedAt: new Date(),
      }));
      // Audit writes now go through AuditService — stubbed above.

      await svc.upload(TENANT_ID, USER_ID, file, DocumentOrigin.UPLOAD);

      const createArgs = prisma.document.create.mock.calls[0][0];
      expect(createArgs.data.type).toBe(DocumentType.OUTRO);
    });

    it('coerces unknown pre-classification to OUTRO', async () => {
      prisma.document.findFirst.mockResolvedValue(null);
      rules.suggest.mockResolvedValue('/Inbox/2026/08/OUTRO');
      prisma.document.create.mockImplementation(async ({ data }) => ({
        id: 'doc-5',
        ...data,
        createdAt: new Date(),
        updatedAt: new Date(),
      }));
      // Audit writes now go through AuditService — stubbed above.

      await svc.upload(
        TENANT_ID,
        USER_ID,
        file,
        DocumentOrigin.UPLOAD,
        // runtime coercion — value is not a real DocumentType enum member
        'NOT_A_VALID_TYPE' as unknown as DocumentType,
      );

      const createArgs = prisma.document.create.mock.calls[0][0];
      expect(createArgs.data.type).toBe(DocumentType.OUTRO);
    });
  });

  // ──────────────────────────────────────────────── update / folder rules
  describe('update() — re-runs the rules engine on classification change', () => {
    it('updates metadata and re-suggests folder when type changes', async () => {
      prisma.document.findFirst.mockResolvedValue({
        id: 'doc-6',
        type: DocumentType.OUTRO,
        supplier: 'EDP',
        supplierNif: null,
        customer: null,
      });
      // party is null (no link yet)
      prisma.party.findFirst.mockResolvedValue(null);
      prisma.folder.findFirst.mockResolvedValue(null);
      rules.suggest.mockResolvedValue('/2026/08/fatura_recebida/edp');
      prisma.document.update.mockImplementation(async ({ where, data }) => ({
        id: where.id,
        ...data,
        createdAt: new Date(),
        updatedAt: new Date(),
      }));
      // Audit writes now go through AuditService — stubbed above.

      await svc.update(TENANT_ID, USER_ID, 'doc-6', {
        type: DocumentType.FATURA_RECEBIDA,
      });

      expect(rules.suggest).toHaveBeenCalledTimes(1);
      const updateArgs = prisma.document.update.mock.calls[0][0];
      expect(updateArgs.data.type).toBe(DocumentType.FATURA_RECEBIDA);
      expect(updateArgs.data.suggestedFolder).toBe('/2026/08/fatura_recebida/edp');
      expect(updateArgs.data.finalFolder).toBe('/2026/08/fatura_recebida/edp');
    });

    it('does NOT call the rules engine when only metadata changes', async () => {
      prisma.document.findFirst.mockResolvedValue({
        id: 'doc-7',
        type: DocumentType.FATURA_RECEBIDA,
        supplier: 'EDP',
        supplierNif: null,
        customer: null,
      });
      prisma.document.update.mockImplementation(async ({ where, data }) => ({
        id: where.id,
        ...data,
        createdAt: new Date(),
        updatedAt: new Date(),
      }));
      // Audit writes now go through AuditService — stubbed above.

      await svc.update(TENANT_ID, USER_ID, 'doc-7', { docNumber: 'FT 2026/999' });

      expect(rules.suggest).not.toHaveBeenCalled();
      const updateArgs = prisma.document.update.mock.calls[0][0];
      expect(updateArgs.data.docNumber).toBe('FT 2026/999');
      expect(updateArgs.data).not.toHaveProperty('suggestedFolder');
    });

    it('manual expenseCategory override re-files and stamps metadata.filing', async () => {
      prisma.document.findFirst.mockResolvedValue({
        id: 'doc-8',
        type: DocumentType.FATURA_RECEBIDA,
        supplier: null,
        supplierNif: null,
        customer: null,
      });
      prisma.party.findFirst.mockResolvedValue(null);
      prisma.folder.findFirst.mockResolvedValue(null);
      rules.suggest.mockResolvedValue('/Despesas/refeicoes/2026/08');
      prisma.document.update.mockImplementation(async ({ where, data }) => ({
        id: where.id,
        ...data,
        createdAt: new Date(),
        updatedAt: new Date(),
      }));

      await svc.update(TENANT_ID, USER_ID, 'doc-8', {
        expenseCategory: 'Refeições',
      });

      const updateArgs = prisma.document.update.mock.calls[0][0];
      expect(updateArgs.data.suggestedFolder).toBe('/Despesas/refeicoes/2026/08');
      expect(updateArgs.data.finalFolder).toBe('/Despesas/refeicoes/2026/08');
      // metadata.filing was set; the manual override is recorded as 'user'.
      expect(updateArgs.data.metadata).toMatchObject({
        filing: {
          expenseCategory: 'Refeições',
          source: 'user',
          vatDeductibilityHint: expect.stringContaining('Refeições'),
        },
      });
      // The DTO's expenseCategory field does NOT leak into the update payload
      // (it's only stored inside metadata.filing).
      expect(updateArgs.data).not.toHaveProperty('expenseCategory');
    });

    it('rejects an invalid expenseCategory with BadRequestException', async () => {
      prisma.document.findFirst.mockResolvedValue({
        id: 'doc-9',
        type: DocumentType.FATURA_RECEBIDA,
        supplier: null,
        supplierNif: null,
        customer: null,
      });

      await expect(
        svc.update(TENANT_ID, USER_ID, 'doc-9', {
          expenseCategory: 'NaoExiste',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('expenseCategory="" clears the override', async () => {
      prisma.document.findFirst.mockResolvedValue({
        id: 'doc-10',
        type: DocumentType.FATURA_RECEBIDA,
        supplier: null,
        supplierNif: null,
        customer: null,
      });
      prisma.party.findFirst.mockResolvedValue(null);
      prisma.folder.findFirst.mockResolvedValue(null);
      rules.suggest.mockResolvedValue('/Inbox/2026/08/FATURA_RECEBIDA');
      prisma.document.update.mockImplementation(async ({ where, data }) => ({
        id: where.id,
        ...data,
        createdAt: new Date(),
        updatedAt: new Date(),
      }));

      await svc.update(TENANT_ID, USER_ID, 'doc-10', { expenseCategory: '' });

      const updateArgs = prisma.document.update.mock.calls[0][0];
      expect(updateArgs.data.metadata.filing).toMatchObject({ source: 'cleared' });
      expect(updateArgs.data.metadata.filing.expenseCategory).toBeUndefined();
    });
  });

  // ──────────────────────────────────────────────── L1 — path-traversal hardening
  describe('extractExtension() — L1 path-traversal hardening', () => {
    // Reach the private method via the class prototype (test-only).
    const ext = (name: string) => (svc as any).extractExtension(name);

    it('rejects filenames containing parent-directory traversal', () => {
      expect(ext('../../etc/passwd.pdf')).toBe('');
      expect(ext('..\\windows\\system.pdf')).toBe('');
      expect(ext('foo/../bar.pdf')).toBe('');
    });

    it('rejects filenames with embedded NUL bytes', () => {
      expect(ext('invoice\0bad.pdf')).toBe('');
    });

    it('returns the lowercased extension for a safe filename', () => {
      expect(ext('Invoice.PDF')).toBe('.pdf');
      expect(ext('simple.docx')).toBe('.docx');
    });

    it('returns "" for filenames without an extension or with junk', () => {
      expect(ext('no-ext-file')).toBe('');
      expect(ext('weird.<script>')).toBe('');
    });
  });

  // ──────────────────────────────────────────────── #6 document naming
  describe('buildDocumentFileName() — human-friendly slug', () => {
    const slug = (args: Parameters<DocumentsService['buildDocumentFileName']>[0]) =>
      (svc as any).buildDocumentFileName(args);

    it('produces <SUPPLIER>_<DATE>_<DOCNUMBER>.<ext> when all fields are present', () => {
      const out = slug({
        docId: 'cm123abc',
        supplier: 'Américo Alves, Lda',
        docNumber: 'FT 2026/1751',
        docDate: new Date(Date.UTC(2026, 6, 31)), // July 31 (month is 0-indexed)
        mimeType: 'application/pdf',
      });
      // Diacritics get stripped to ASCII (brief's example: AMERICO-ALVES).
      // Spaces, commas and slashes collapse into dashes.
      expect(out).toBe('AMERICO-ALVES-LDA_2026-07-31_FT-2026-1751.pdf');
    });

    it('uses the mime-type extension when available (more reliable than filename)', () => {
      const out = slug({
        docId: 'cm123abc',
        supplier: 'EDP',
        docNumber: 'FT 2026/999',
        docDate: new Date(Date.UTC(2026, 0, 5)),
        mimeType: 'image/jpeg',
        currentFileName: 'garbage.bin',
      });
      expect(out).toBe('EDP_2026-01-05_FT-2026-999.jpg');
    });

    it('falls back to the upload-time extension when mime-type is unknown', () => {
      const out = slug({
        docId: 'cm123abc',
        supplier: 'NOS',
        docNumber: 'FT 1',
        docDate: new Date(Date.UTC(2026, 11, 1)),
        mimeType: null,
        currentFileName: 'phone.JPG',
      });
      expect(out).toBe('NOS_2026-12-01_FT-1.jpg');
    });

    it('uses doc_<id> when supplier is missing', () => {
      const out = slug({
        docId: 'cmDocOnly',
        supplier: null,
        docNumber: 'FT 2026/1',
        docDate: new Date(Date.UTC(2026, 6, 31)),
        mimeType: 'application/pdf',
      });
      expect(out).toBe('doc_cmDocOnly.pdf');
    });

    it('uses doc_<id> when docNumber is missing', () => {
      const out = slug({
        docId: 'cmDocOnly',
        supplier: 'EDP',
        docNumber: null,
        docDate: new Date(Date.UTC(2026, 6, 31)),
        mimeType: 'application/pdf',
      });
      expect(out).toBe('doc_cmDocOnly.pdf');
    });

    it('falls back to .bin when nothing indicates the extension', () => {
      const out = slug({
        docId: 'cmDocOnly',
        supplier: 'EDP',
        docNumber: 'FT 2026/1',
        docDate: new Date(Date.UTC(2026, 6, 31)),
        mimeType: null,
        currentFileName: 'garbage',
      });
      expect(out.endsWith('.bin')).toBe(true);
    });

    it('falls back to fallbackDate (or now) when docDate is null', () => {
      const out = slug({
        docId: 'cmDocOnly',
        supplier: 'EDP',
        docNumber: 'FT 2026/1',
        docDate: null,
        fallbackDate: new Date(Date.UTC(2026, 6, 31)),
        mimeType: 'application/pdf',
      });
      expect(out).toBe('EDP_2026-07-31_FT-2026-1.pdf');
    });

    it('strips path-traversal characters from supplier/docNumber', () => {
      const out = slug({
        docId: 'cmDocOnly',
        supplier: '../etc/passwd',
        docNumber: 'FT/2026/../../foo',
        docDate: new Date(Date.UTC(2026, 6, 31)),
        mimeType: 'application/pdf',
      });
      // None of the resulting slug should contain `/` or `\`.
      expect(out).not.toMatch(/[\/\\]/);
      expect(out).not.toContain('..');
      // Stem still resolves to a slugged shape.
      expect(out.endsWith('.pdf')).toBe(true);
    });
  });

  describe('upload() — #6 metadata.originalFilename + initial fileName', () => {
    const file = {
      fieldname: 'file',
      originalname: 'phone.jpg',
      encoding: '7bit',
      mimetype: 'image/jpeg',
      size: 11,
      buffer: makeJpegBuffer('jpeg-bytes'),
    };

    beforeEach(() => {
      imageToPdf.supports.mockReturnValue(false);
      prisma.document.findFirst.mockResolvedValue(null);
      rules.suggest.mockResolvedValue('/Inbox/2026/08/OUTRO');
      prisma.document.create.mockImplementation(async ({ data }) => ({
        id: 'doc-orig',
        ...data,
        createdAt: new Date(),
        updatedAt: new Date(),
      }));
    });

    it('persists metadata.originalFilename = file.originalname for audit', async () => {
      await svc.upload(TENANT_ID, USER_ID, file);
      const createArgs = prisma.document.create.mock.calls[0][0];
      expect(createArgs.data.metadata).toEqual(
        expect.objectContaining({ originalFilename: 'phone.jpg' }),
      );
    });

    it('keeps fileName = file.originalname at upload time (rename happens after extraction)', async () => {
      await svc.upload(TENANT_ID, USER_ID, file);
      const createArgs = prisma.document.create.mock.calls[0][0];
      expect(createArgs.data.fileName).toBe('phone.jpg');
    });
  });

  describe('renameAfterExtraction() — #6 post-extraction rename hook', () => {
    beforeEach(() => {
      prisma.document.update.mockImplementation(async ({ where, data }) => ({
        id: where.id,
        ...data,
        createdAt: new Date(),
        updatedAt: new Date(),
      }));
    });

    it('swaps fileName for the human-friendly slug when supplier+docNumber are present', async () => {
      prisma.document.findFirst.mockResolvedValue({
        id: 'doc-rename',
        fileName: 'phone.jpg',
        mimeType: 'image/jpeg',
        supplier: 'Américo Alves, Lda',
        docNumber: 'FT 2026/1751',
        docDate: new Date(Date.UTC(2026, 6, 31)),
      });

      const out = await svc.renameAfterExtraction(TENANT_ID, 'doc-rename', {
        supplier: 'Américo Alves, Lda',
        docNumber: 'FT 2026/1751',
        docDate: new Date(Date.UTC(2026, 6, 31)),
      });

      expect(out).toBe('AMERICO-ALVES-LDA_2026-07-31_FT-2026-1751.pdf');
      expect(prisma.document.update).toHaveBeenCalledTimes(1);
      expect(prisma.document.update.mock.calls[0][0].data.fileName).toBe(
        'AMERICO-ALVES-LDA_2026-07-31_FT-2026-1751.pdf',
      );
    });

    it('matches the brief\'s reference example exactly: AMERICO-ALVES_2026-07-31_FT-2026-1751.pdf', async () => {
      // Reference: brief gives this exact string. Pin it so a future
      // refactor doesn't drift away from the user-facing contract.
      prisma.document.findFirst.mockResolvedValue({
        id: 'doc-ref',
        fileName: 'phone.pdf',
        mimeType: 'application/pdf',
        supplier: 'Américo Alves',
        docNumber: 'FT 2026/1751',
        docDate: new Date(Date.UTC(2026, 6, 31)),
      });

      const out = await svc.renameAfterExtraction(TENANT_ID, 'doc-ref', {
        supplier: 'Américo Alves',
        docNumber: 'FT 2026/1751',
        docDate: new Date(Date.UTC(2026, 6, 31)),
      });

      // Brief's exact reference value. The "," gets dropped by slugify,
      // giving us the form the user described.
      expect(out).toBe('AMERICO-ALVES_2026-07-31_FT-2026-1751.pdf');
    });

    it('is idempotent: no-op when the slug already matches fileName', async () => {
      prisma.document.findFirst.mockResolvedValue({
        id: 'doc-already',
        fileName: 'EDP_2026-01-05_FT-2026-999.pdf',
        mimeType: 'application/pdf',
        supplier: 'EDP',
        docNumber: 'FT 2026/999',
        docDate: new Date(Date.UTC(2026, 0, 5)),
      });

      const out = await svc.renameAfterExtraction(TENANT_ID, 'doc-already', {
        supplier: 'EDP',
        docNumber: 'FT 2026/999',
        docDate: new Date(Date.UTC(2026, 0, 5)),
      });

      expect(out).toBeNull();
      expect(prisma.document.update).not.toHaveBeenCalled();
    });

    it('keeps the original name when supplier is missing (re-extraction may still produce a slug)', async () => {
      prisma.document.findFirst.mockResolvedValue({
        id: 'doc-noslug',
        fileName: 'phone.jpg',
        mimeType: 'image/jpeg',
        supplier: null,
        docNumber: null,
        docDate: null,
      });

      const out = await svc.renameAfterExtraction(TENANT_ID, 'doc-noslug', {
        supplier: null,
        docNumber: null,
        docDate: null,
      });

      // No-op: don't fall back to doc_<id>; the user may re-extract
      // and we want to preserve the original audit trail.
      expect(out).toBeNull();
      expect(prisma.document.update).not.toHaveBeenCalled();
    });

    it('falls back to the row values when the caller passes empty fields', async () => {
      prisma.document.findFirst.mockResolvedValue({
        id: 'doc-rowvals',
        fileName: 'phone.jpg',
        mimeType: 'image/jpeg',
        supplier: 'NOS',
        docNumber: 'FT 9',
        docDate: new Date(Date.UTC(2026, 5, 1)),
      });

      const out = await svc.renameAfterExtraction(TENANT_ID, 'doc-rowvals', {
        supplier: null,
        docNumber: null,
        docDate: null,
      });

      // The row already has fields — we should still rename.
      expect(out).toBe('NOS_2026-06-01_FT-9.pdf');
      expect(prisma.document.update).toHaveBeenCalledTimes(1);
    });

    it('does NOT touch the storage key (only the fileName column)', async () => {
      prisma.document.findFirst.mockResolvedValue({
        id: 'doc-keysafe',
        fileName: 'phone.jpg',
        mimeType: 'image/jpeg',
        supplier: 'EDP',
        docNumber: 'FT 1',
        docDate: new Date(Date.UTC(2026, 0, 1)),
      });

      await svc.renameAfterExtraction(TENANT_ID, 'doc-keysafe', {
        supplier: 'EDP',
        docNumber: 'FT 1',
        docDate: new Date(Date.UTC(2026, 0, 1)),
      });

      const updateArgs = prisma.document.update.mock.calls[0][0];
      // fileKey / pdfKey are not part of the update payload — the
      // rename is purely a `fileName` column write.
      expect(updateArgs.data).not.toHaveProperty('fileKey');
      expect(updateArgs.data).not.toHaveProperty('pdfKey');
      expect(updateArgs.data.fileName).toBe('EDP_2026-01-01_FT-1.pdf');
    });

    it('logs and returns null when the update throws (does not abort the caller)', async () => {
      prisma.document.findFirst.mockResolvedValue({
        id: 'doc-dbdown',
        fileName: 'phone.jpg',
        mimeType: 'image/jpeg',
        supplier: 'EDP',
        docNumber: 'FT 1',
        docDate: new Date(Date.UTC(2026, 0, 1)),
      });
      prisma.document.update.mockRejectedValueOnce(new Error('connection reset'));

      const out = await svc.renameAfterExtraction(TENANT_ID, 'doc-dbdown', {
        supplier: 'EDP',
        docNumber: 'FT 1',
        docDate: new Date(Date.UTC(2026, 0, 1)),
      });

      expect(out).toBeNull();
    });

    it('returns null when the document does not exist (caller already surfaced this elsewhere)', async () => {
      prisma.document.findFirst.mockResolvedValue(null);

      const out = await svc.renameAfterExtraction(TENANT_ID, 'doc-missing', {
        supplier: 'EDP',
        docNumber: 'FT 1',
        docDate: new Date(Date.UTC(2026, 0, 1)),
      });

      expect(out).toBeNull();
      expect(prisma.document.update).not.toHaveBeenCalled();
    });
  });

  // ──────────────────────────────────────────────── Fase 4.2 (P2) — contabilização
  describe('sanitize() via findOne() — a conta atribuída sobrevive a reabrir o documento', () => {
    it('achata o objeto Account em código (string), como o frontend espera', async () => {
      prisma.document.findFirst.mockResolvedValue({
        id: 'doc-1',
        debitAccount: { code: '312' },
        creditAccount: { code: '2211' },
      });
      const out = await svc.findOne(TENANT_ID, 'doc-1');
      expect(out.debitAccount).toBe('312');
      expect(out.creditAccount).toBe('2211');
    });

    it('sem conta atribuída, devolve null em vez do objeto vazio', async () => {
      prisma.document.findFirst.mockResolvedValue({
        id: 'doc-1',
        debitAccount: null,
        creditAccount: null,
      });
      const out = await svc.findOne(TENANT_ID, 'doc-1');
      expect(out.debitAccount).toBeNull();
      expect(out.creditAccount).toBeNull();
    });
  });

  describe('assignAccounting() — o frontend já chamava esta rota; não existia', () => {
    it('resolve o código para uma Account (cria-a se não existir) e liga o documento', async () => {
      prisma.document.findFirst.mockResolvedValue({ id: 'doc-acc' });
      prisma.account.upsert
        .mockResolvedValueOnce({ id: 'acc-312' })
        .mockResolvedValueOnce({ id: 'acc-2211' });
      prisma.document.update.mockResolvedValue({
        id: 'doc-acc',
        debitAccountId: 'acc-312',
        creditAccountId: 'acc-2211',
      });

      const out = await svc.assignAccounting(TENANT_ID, USER_ID, 'doc-acc', {
        debitAccount: '312',
        creditAccount: '2211',
      });

      expect(prisma.account.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { tenantId_code: { tenantId: TENANT_ID, code: '312' } },
          create: expect.objectContaining({ code: '312', name: 'Compras — mercadorias' }),
        }),
      );
      expect(prisma.document.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'doc-acc' },
          data: { debitAccountId: 'acc-312', creditAccountId: 'acc-2211' },
        }),
      );
      expect(out.debitAccountId).toBe('acc-312');
      expect(audit.log).toHaveBeenCalled();
    });

    it('um código fora do SNC_BASELINE ainda é aceite, com rótulo genérico', async () => {
      prisma.document.findFirst.mockResolvedValue({ id: 'doc-acc' });
      prisma.account.upsert.mockResolvedValueOnce({ id: 'acc-custom' });
      prisma.document.update.mockResolvedValue({ id: 'doc-acc' });

      await svc.assignAccounting(TENANT_ID, USER_ID, 'doc-acc', { debitAccount: '9999' });

      expect(prisma.account.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ create: expect.objectContaining({ code: '9999', name: 'Conta 9999' }) }),
      );
    });

    it('null limpa a atribuição; undefined não mexe', async () => {
      prisma.document.findFirst.mockResolvedValue({ id: 'doc-acc' });
      prisma.document.update.mockResolvedValue({ id: 'doc-acc' });

      await svc.assignAccounting(TENANT_ID, USER_ID, 'doc-acc', { debitAccount: null });

      expect(prisma.account.upsert).not.toHaveBeenCalled();
      expect(prisma.document.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { debitAccountId: null } }),
      );
    });

    it('404 quando o documento não existe', async () => {
      prisma.document.findFirst.mockResolvedValue(null);
      await expect(
        svc.assignAccounting(TENANT_ID, USER_ID, 'doc-missing', { debitAccount: '312' }),
      ).rejects.toThrow('Document not found');
    });
  });

  describe('getAccountingProposal() — determinística, natureza + regime de IVA', () => {
    it('compra nacional de mercadorias', async () => {
      prisma.document.findFirst.mockResolvedValue({
        expenseNature: 'MERCADORIAS_REVENDA',
        party: { vatRegime: 'PT' },
      });
      const out = await svc.getAccountingProposal(TENANT_ID, 'doc-1');
      expect(out.debit.map((l: { code: string }) => l.code)).toEqual(['312', '2432']);
    });

    it('sem fornecedor ligado, sem regime — não propõe nada', async () => {
      prisma.document.findFirst.mockResolvedValue({ expenseNature: 'MERCADORIAS_REVENDA', party: null });
      const out = await svc.getAccountingProposal(TENANT_ID, 'doc-1');
      expect(out.reason).toBe('sem_regime_iva_definido');
    });

    it('404 quando o documento não existe', async () => {
      prisma.document.findFirst.mockResolvedValue(null);
      await expect(svc.getAccountingProposal(TENANT_ID, 'doc-missing')).rejects.toThrow(
        'Document not found',
      );
    });
  });
});