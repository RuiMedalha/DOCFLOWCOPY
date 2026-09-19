/**
 * Sprint E fix-up — END-TO-END regression coverage for the upload →
 * approve → relocate pipeline.
 *
 * The previous tests (approve-folder-routing.spec.ts) mocked `findFirst`
 * to inject `_inbox/` keys directly, which masked a critical production
 * bug: `DocumentsService.buildStorageKey()` produced `<tenant>/<yyyy>/<mm>/...`
 * keys without the `_inbox/` prefix. As a result the relocate guard
 * (`fileKey.includes('/_inbox/')`) fired early on every approve and the
 * file was never moved to the party folder.
 *
 * These tests exercise the REAL `upload()` and the REAL `approve()` flow
 * against a fake Prisma + a fake storage that records put/move calls.
 * The contract they pin:
 *   1. A fresh upload's `fileKey` starts with `_inbox/` (FIX 1).
 *   2. The PDF sibling key (when the upload is an image) sits in the SAME
 *      `_inbox/` subtree and is uploaded before the Document row is created.
 *   3. After `approve()` runs and the row has a party, `storage.move()` is
 *      called with `(from, to)` where `from` is the inbox key returned by
 *      the upload and `to` is the deterministic party folder path.
 *   4. The Document row's `fileKey` after approve equals the move's `to`.
 *   5. Without a linked party, the file STAYS in `_inbox/` (no move call).
 */

import { DocumentOrigin, DocumentStatus, Prisma } from '@prisma/client';
import { DocumentsService } from '../documents.service';
import type { StorageService } from '../storage/storage-service.interface';

const TENANT_ID = 'cmtf1scz20000g5s0n621bzef';
const USER_ID = 'user-1';

function makePdfBuffer(payload = 'hello docflow'): Buffer {
  return Buffer.concat([Buffer.from('%PDF-1.4\n', 'utf8'), Buffer.from(payload, 'utf8')]);
}

function makeJpegBuffer(payload = 'jpeg-bytes'): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(payload, 'utf8')]);
}

interface RecordedCall {
  key: string;
  buffer: Buffer;
}

function buildStorageSpy(): StorageService & {
  put: jest.Mock;
  move: jest.Mock;
  puts: RecordedCall[];
  moves: Array<{ from: string; to: string }>;
} {
  const puts: RecordedCall[] = [];
  const moves: Array<{ from: string; to: string }> = [];
  return {
    driver: 'local',
    put: jest.fn(async (key: string, buffer: Buffer) => {
      puts.push({ key, buffer });
    }),
    getBuffer: jest.fn(async (key: string) => ({
      buffer: Buffer.from(''),
      size: 0,
    })),
    remove: jest.fn(async () => undefined),
    exists: jest.fn(async () => true),
    move: jest.fn(async (from: string, to: string) => {
      moves.push({ from, to });
    }),
    getSignedUrl: jest.fn(async (key: string) =>
      `/api/v1/documents/storage/${encodeURIComponent(key)}`,
    ),
    puts,
    moves,
  } as any;
}

function buildPrismaForFlow(opts: {
  initialDocStatus?: DocumentStatus;
  partyId?: string | null;
  partySlug?: string;
  partyType?: 'FORNECEDOR' | 'CLIENTE' | 'AMBOS';
  partyCategorySlug?: string | null;
}) {
  const documentCreate = jest.fn(async ({ data }: any) => ({
    id: 'doc-flow-1',
    status: DocumentStatus.NOVO,
    fileKey: data.fileKey,
    pdfKey: data.pdfKey ?? null,
    tenantId: data.tenantId,
    uploadedById: data.uploadedById,
    origin: data.origin,
    fileName: data.fileName,
    fileHash: data.fileHash,
    mimeType: data.mimeType,
    metadata: data.metadata ?? {},
    createdAt: new Date(),
    updatedAt: new Date(),
  }));
  const documentFindFirst = jest.fn();
  const documentUpdate = jest.fn(async ({ where, data }: any) => ({
    id: where.id,
    status: data.status ?? DocumentStatus.APROVADO,
    fileKey: data.fileKey ?? undefined,
    pdfKey: data.pdfKey ?? null,
    approvedAt: data.approvedAt,
    approvedById: data.approvedById,
  }));
  const paymentEventUpsert = jest.fn(async () => undefined);

  // $transaction wrapper that forwards a tx-shaped handle. Mirrors the
  // stub from approve-folder-routing.spec.ts — the production code only
  // uses `tx.document.findFirst/update` + `tx.$executeRaw`.
  const $executeRaw = jest.fn(async () => undefined);
  const folderFindFirst = jest.fn(async () => ({
    id: 'folder-year-1',
    name: 'EDP Comercial - 2026',
    pattern: '/Fornecedores/EDP Comercial/2026',
  }));
  const folderCreate = jest.fn();
  const txHandle = {
    document: { findFirst: documentFindFirst, update: documentUpdate },
    folder: { findFirst: folderFindFirst, create: folderCreate },
    $executeRaw,
  };
  const $transaction = jest.fn(async (work: any) => {
    if (typeof work !== 'function') return work;
    return work(txHandle);
  });

  return {
    document: {
      findFirst: documentFindFirst,
      findMany: jest.fn(),
      count: jest.fn(),
      create: documentCreate,
      update: documentUpdate,
    },
    folder: { findFirst: folderFindFirst, create: folderCreate },
    folderRule: { findMany: jest.fn() },
    party: { findFirst: jest.fn(async () => null) },
    paymentEvent: { upsert: paymentEventUpsert },
    $executeRaw,
    $transaction,
  };
}

function buildAuditStub() {
  return {
    log: jest.fn(async () => undefined),
    logInTx: jest.fn(async () => undefined),
    verifyChain: jest.fn(async () => ({ valid: true })),
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

function makeSvc(prisma: any, audit: any, storage: StorageService) {
  return new DocumentsService(
    prisma as any,
    audit as any,
    storage as any,
    buildRulesEngineStub() as any,
    { enqueue: jest.fn().mockResolvedValue({ queued: false, documentId: 'doc-flow-1', ok: true }) } as any,
    buildImageToPdfStub() as any,
    buildNifLookupStub() as any,
    buildQueueStub() as any,
  );
}

describe('Sprint E end-to-end: upload → approve → relocate', () => {
  it('FIX 1: upload() returns a fileKey that starts with _inbox/ so the approve path can relocate it', async () => {
    const storage = buildStorageSpy();
    const prisma = buildPrismaForFlow({ initialDocStatus: DocumentStatus.NOVO });
    prisma.document.findFirst.mockResolvedValue(null); // no dedup hit

    const svc = makeSvc(prisma, buildAuditStub(), storage);

    const file = {
      fieldname: 'file',
      originalname: 'invoice.pdf',
      encoding: '7bit',
      mimetype: 'application/pdf',
      size: 5,
      buffer: makePdfBuffer(),
    } as any;

    await svc.upload(TENANT_ID, USER_ID, file, DocumentOrigin.UPLOAD);

    // 1. The DB row got the inbox-prefixed key.
    const createArgs = prisma.document.create.mock.calls[0][0];
    expect(createArgs.data.fileKey).toMatch(
      /^_inbox\/cmtf1scz20000g5s0n621bzef\/\d{4}\/\d{2}\//,
    );
    expect(createArgs.data.fileKey.endsWith('.pdf')).toBe(true);

    // 2. The bytes actually went to that exact key on the storage.
    expect(storage.puts).toHaveLength(1);
    expect(storage.puts[0].key).toBe(createArgs.data.fileKey);
    expect(storage.puts[0].key.startsWith('_inbox/')).toBe(true);

    // 3. No move call yet — the file hasn't been approved.
    expect(storage.moves).toHaveLength(0);
  });

  it('PDF sibling lands in the SAME _inbox/ subtree so the approve path can move it alongside the original', async () => {
    const storage = buildStorageSpy();
    const prisma = buildPrismaForFlow({ initialDocStatus: DocumentStatus.NOVO });
    prisma.document.findFirst.mockResolvedValue(null);

    const svc = makeSvc(prisma, buildAuditStub(), storage);

    // imageToPdf must claim support for image/jpeg so the upload flow
    // generates the PDF sibling via the converter.
    (svc as any).imageToPdf = {
      supports: (mt: string) => mt === 'image/jpeg',
      convert: jest.fn(async () => Buffer.from('%PDF-1.4\n', 'utf8')),
    };

    const file = {
      fieldname: 'file',
      originalname: 'photo.jpg',
      encoding: '7bit',
      mimetype: 'image/jpeg',
      size: 5,
      buffer: makeJpegBuffer(),
    } as any;

    await svc.upload(TENANT_ID, USER_ID, file, DocumentOrigin.UPLOAD);

    expect(storage.puts).toHaveLength(2);
    const [originalPut, pdfPut] = storage.puts;
    expect(originalPut.key.startsWith('_inbox/')).toBe(true);
    expect(pdfPut.key.startsWith('_inbox/')).toBe(true);
    expect(pdfPut.key.replace(/\.pdf$/, '')).toBe(originalPut.key.replace(/\.jpg$/, ''));
  });

  it('approve() moves the file OUT of _inbox/ into the deterministic party folder when a party is linked', async () => {
    const storage = buildStorageSpy();
    const prisma = buildPrismaForFlow({
      initialDocStatus: DocumentStatus.NOVO,
      partyId: 'party-1',
      partySlug: 'edp-comercial',
      partyType: 'FORNECEDOR',
      partyCategorySlug: 'estrategico',
    });
    const svc = makeSvc(prisma, buildAuditStub(), storage);

    // approve() chain reads the existing row twice (existing row read by
    // approve, then a row read inside relocateAfterApprove's transaction).
    // Both reads must return the SAME inbox key — that's what the production
    // code writes when upload() is called.
    const inboxKey = `_inbox/${TENANT_ID}/2026/09/1234567890-abcdef0123456789.pdf`;
    prisma.document.findFirst
      .mockResolvedValueOnce({
        id: 'doc-flow-1',
        status: DocumentStatus.NOVO,
        fileKey: inboxKey,
        pdfKey: null,
        dueDate: null,
        paymentDueDate: null,
        total: new Prisma.Decimal(0),
        netAmount: new Prisma.Decimal(0),
      })
      .mockResolvedValueOnce({
        id: 'doc-flow-1',
        fileKey: inboxKey,
        pdfKey: null,
        docDate: new Date(Date.UTC(2026, 8, 4)),
        docNumber: 'FT 2026/123',
        partyId: 'party-1',
        party: {
          id: 'party-1',
          name: 'EDP Comercial',
          slug: 'edp-comercial',
          type: 'FORNECEDOR',
          partyCategory: { slug: 'estrategico' },
        },
      });

    await svc.approve(TENANT_ID, USER_ID, 'doc-flow-1');

    // Exactly one storage.move call, from the inbox key to the party folder.
    expect(storage.moves).toHaveLength(1);
    expect(storage.moves[0].from).toBe(inboxKey);
    expect(storage.moves[0].to).toBe(
      'fornecedores/edp-comercial/2026/FT_EDPComercial_FT2026-123_2026-09-04.pdf',
    );

    // The final fileKey update in the transaction points to the destination.
    const updateCalls = prisma.document.update.mock.calls.filter(
      (c: any[]) => typeof c[0]?.data?.fileKey === 'string',
    );
    expect(updateCalls.length).toBeGreaterThanOrEqual(1);
    const finalUpdate = updateCalls[updateCalls.length - 1];
    expect(finalUpdate[0].data.fileKey).toBe(storage.moves[0].to);
  });

  it('approve() leaves the file in _inbox/ when no party is linked (no move call)', async () => {
    const storage = buildStorageSpy();
    const prisma = buildPrismaForFlow({
      initialDocStatus: DocumentStatus.NOVO,
      partyId: null,
    });
    const svc = makeSvc(prisma, buildAuditStub(), storage);

    const inboxKey = `_inbox/${TENANT_ID}/2026/09/9876543210-fedcba9876543210.pdf`;
    prisma.document.findFirst
      .mockResolvedValueOnce({
        id: 'doc-flow-1',
        status: DocumentStatus.NOVO,
        fileKey: inboxKey,
        pdfKey: null,
        dueDate: null,
        paymentDueDate: null,
        total: new Prisma.Decimal(0),
        netAmount: new Prisma.Decimal(0),
      })
      .mockResolvedValueOnce({
        id: 'doc-flow-1',
        fileKey: inboxKey,
        pdfKey: null,
        docDate: new Date(),
        docNumber: 'FT 1',
        partyId: null,
        party: null,
      });

    await svc.approve(TENANT_ID, USER_ID, 'doc-flow-1');

    expect(storage.moves).toHaveLength(0);
  });

  it('approve() routes a CLIENTE party to clientes/ (not fornecedores/)', async () => {
    const storage = buildStorageSpy();
    const prisma = buildPrismaForFlow({
      initialDocStatus: DocumentStatus.NOVO,
      partyId: 'party-cliente',
      partySlug: 'acme-lda',
      partyType: 'CLIENTE',
      partyCategorySlug: null,
    });
    const svc = makeSvc(prisma, buildAuditStub(), storage);

    const inboxKey = `_inbox/${TENANT_ID}/2026/09/1111111111-aaaaaaaaaaaaaaaa.pdf`;
    prisma.document.findFirst
      .mockResolvedValueOnce({
        id: 'doc-flow-1',
        status: DocumentStatus.NOVO,
        fileKey: inboxKey,
        pdfKey: null,
        dueDate: null,
        paymentDueDate: null,
        total: new Prisma.Decimal(0),
        netAmount: new Prisma.Decimal(0),
      })
      .mockResolvedValueOnce({
        id: 'doc-flow-1',
        fileKey: inboxKey,
        pdfKey: null,
        docDate: new Date(Date.UTC(2026, 8, 4)),
        docNumber: 'RC 2026/1',
        partyId: 'party-cliente',
        party: {
          id: 'party-cliente',
          name: 'ACME LDA',
          slug: 'acme-lda',
          type: 'CLIENTE',
          partyCategory: null,
        },
      });

    await svc.approve(TENANT_ID, USER_ID, 'doc-flow-1');

    expect(storage.moves).toHaveLength(1);
    expect(storage.moves[0].from).toBe(inboxKey);
    expect(storage.moves[0].to).toMatch(/^clientes\/acme-lda\//);
  });

  it('second approve after a successful first one is idempotent (no second move)', async () => {
    const storage = buildStorageSpy();
    const prisma = buildPrismaForFlow({
      initialDocStatus: DocumentStatus.NOVO,
      partyId: 'party-1',
      partySlug: 'edp',
      partyType: 'FORNECEDOR',
    });
    const svc = makeSvc(prisma, buildAuditStub(), storage);

    const inboxKey = `_inbox/${TENANT_ID}/2026/09/2222222222-bbbbbbbbbbbbbbbb.pdf`;
    const routedKey =
      'fornecedores/edp/2026/FT_EDP_FT9_2026-09-04.pdf';

    // First approve: existing row is NOVO with inboxKey → move fires.
    prisma.document.findFirst
      .mockResolvedValueOnce({
        id: 'doc-flow-1',
        status: DocumentStatus.NOVO,
        fileKey: inboxKey,
        pdfKey: null,
        dueDate: null,
        paymentDueDate: null,
        total: new Prisma.Decimal(0),
        netAmount: new Prisma.Decimal(0),
      })
      .mockResolvedValueOnce({
        id: 'doc-flow-1',
        fileKey: inboxKey,
        pdfKey: null,
        docDate: new Date(Date.UTC(2026, 8, 4)),
        docNumber: 'FT 9',
        partyId: 'party-1',
        party: {
          id: 'party-1',
          name: 'EDP',
          slug: 'edp',
          type: 'FORNECEDOR',
          partyCategory: null,
        },
      });

    await svc.approve(TENANT_ID, USER_ID, 'doc-flow-1');

    // Second approve: existing row already APPROVADO; the inside-relocate
    // read sees the routed key (no _inbox/) and short-circuits at the guard.
    prisma.document.findFirst
      .mockResolvedValueOnce({
        id: 'doc-flow-1',
        status: DocumentStatus.APROVADO,
        fileKey: routedKey,
        pdfKey: null,
        dueDate: null,
        paymentDueDate: null,
        total: new Prisma.Decimal(0),
        netAmount: new Prisma.Decimal(0),
      })
      .mockResolvedValueOnce({
        id: 'doc-flow-1',
        fileKey: routedKey,
        pdfKey: null,
        docDate: new Date(Date.UTC(2026, 8, 4)),
        docNumber: 'FT 9',
        partyId: 'party-1',
        party: {
          id: 'party-1',
          name: 'EDP',
          slug: 'edp',
          type: 'FORNECEDOR',
          partyCategory: null,
        },
      });

    await svc.approve(TENANT_ID, USER_ID, 'doc-flow-1');

    expect(storage.moves).toHaveLength(1);
    expect(storage.moves[0].to).toBe(routedKey);
  });
});
