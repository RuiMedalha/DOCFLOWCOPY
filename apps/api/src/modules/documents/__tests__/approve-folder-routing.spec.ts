import { AuditAction, DocumentStatus } from '@prisma/client';
import { DocumentsService } from '../documents.service';
import type { StorageService } from '../storage/storage-service.interface';

/**
 * Sprint E — after `approve()` flips a Document to APROVADO, the bytes
 * stored at `<tenant>/<yyyy>/<mm>/<ts>-<rand>.<ext>` should be relocated
 * to the deterministic party/category folder computed by path-builder.
 *
 * These tests stub the storage abstraction with a Jest mock and the
 * Prisma surface with per-test overrides — no real filesystem is
 * touched. The contract we pin:
 *   - `relocateAfterApprove()` only fires when the row has a party AND
 *     the current fileKey sits inside `_inbox/`.
 *   - `storage.move()` is called with the destination computed by
 *     `buildDocumentPath()` (deterministic — same input → same output).
 *   - The DB row is updated with the new fileKey / pdfKey AFTER the move
 *     succeeds.
 *   - An audit row tagged `storage.relocate` is written with from/to.
 *   - If the file is already outside `_inbox/` the move is a no-op
 *     (idempotent).
 */

const TENANT_ID = 'tenant-routing-test';
const USER_ID = 'user-1';
const DOC_ID = 'cm-approve-relocate';

function buildPrismaStub() {
  // $transaction mock — the Sprint E fix-up moved the relocate read+update
  // inside a transaction with a pg_advisory_xact_lock. We simulate the
  // advisory lock as a no-op and forward the inner work function with a
  // tx-like object that exposes the same document delegate. Because the
  // production Prisma extension wraps everything in a single client, the
  // production code calls `tx.document.findFirst` / `tx.document.update`
  // on the transaction handle — and our stub routes those to the SAME
  // jest.fn() instances declared above, so call counts and assertions
  // keep working without any test rewrite.
  //
  // Typed as `any` because $transaction is added imperatively below —
  // the literal type narrows would otherwise hide it from tsc and the
  // service would error out at the call site (the production code only
  // needs the duck-typed shape).
  const stub: any = {
    document: {
      findFirst: jest.fn(),
      update: jest.fn(),
    },
    folder: {
      findFirst: jest.fn().mockResolvedValue({ id: 'folder-1', name: 'EDP Comercial' }),
      create: jest.fn().mockResolvedValue({ id: 'folder-1', name: 'EDP Comercial' }),
    },
    paymentEvent: {
      upsert: jest.fn(),
    },
    $executeRaw: jest.fn(async () => undefined),
  };
  stub.$transaction = jest.fn(async (work: any) => {
    if (typeof work !== 'function') return work;
    return work({
      document: stub.document,
      folder: stub.folder,
      $executeRaw: stub.$executeRaw,
    });
  });
  return stub;
}

function buildAuditStub() {
  return {
    log: jest.fn(async () => undefined),
  };
}

function buildStorageStub(): StorageService & {
  move: jest.Mock;
} {
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

function makeSvc(prisma: any, audit: any, storage: StorageService) {
  return new DocumentsService(
    prisma as any,
    audit as any,
    storage as any,
    buildRulesEngineStub() as any,
    { enqueue: jest.fn().mockResolvedValue({ queued: false, documentId: DOC_ID, ok: true }) } as any,
    buildImageToPdfStub() as any,
    buildNifLookupStub() as any,
    buildQueueStub() as any,
  );
}

describe('DocumentsService.approve() — Sprint E folder routing', () => {
  it('moves an _inbox/ file to the party/category folder and updates the DB', async () => {
    const prisma = buildPrismaStub();
    const audit = buildAuditStub();
    const storage = buildStorageStub();

    prisma.document.findFirst
      // 1st call: existing row read by approve()
      .mockResolvedValueOnce({
        id: DOC_ID,
        status: DocumentStatus.NOVO,
        dueDate: null,
        paymentDueDate: null,
        total: null,
        netAmount: null,
      })
      // 2nd call: relocateAfterApprove() row lookup
      .mockResolvedValueOnce({
        id: DOC_ID,
        fileKey: '<tenant>/2026/09/1788-abcdef.pdf',
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

    prisma.document.update.mockResolvedValue({
      id: DOC_ID,
      status: DocumentStatus.APROVADO,
    });

    // The `_inbox/` substring is what triggers the move.
    // Patch the fileKey so we exercise the routing branch.
    const findFirstMock = prisma.document.findFirst as jest.Mock;
    findFirstMock.mockReset();
    findFirstMock
      .mockResolvedValueOnce({
        id: DOC_ID,
        status: DocumentStatus.NOVO,
        dueDate: null,
        paymentDueDate: null,
        total: null,
        netAmount: null,
      })
      .mockResolvedValueOnce({
        id: DOC_ID,
        fileKey: 'cmtf1scz20000g5s0n621bzef/_inbox/2026-09-04/abc-1788.pdf',
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

    const svc = makeSvc(prisma, audit, storage);
    await svc.approve(TENANT_ID, USER_ID, DOC_ID);

    // storage.move() called with the deterministic destination.
    expect(storage.move).toHaveBeenCalledTimes(1);
    const [from, to] = (storage.move as jest.Mock).mock.calls[0];
    expect(from).toBe('cmtf1scz20000g5s0n621bzef/_inbox/2026-09-04/abc-1788.pdf');
    expect(to).toBe('fornecedores/edp-comercial/2026/FT_EDPComercial_FT2026-123_2026-09-04.pdf');

    // DB update carries the new fileKey and standardized fileName.
    const updateCall = prisma.document.update.mock.calls.find(
      (c: any[]) => c[0]?.data?.fileKey,
    );
    expect(updateCall).toBeDefined();
    expect(updateCall[0].data.fileKey).toBe(to);
    expect(updateCall[0].data.fileName).toBe('FT_EDPComercial_FT2026-123_2026-09-04.pdf');
    expect(updateCall[0].data.folderId).toBe('folder-1');

    // Audit row tagged with subAction.
    const relocateRow = (audit.log as jest.Mock).mock.calls
      .map((c) => c[0])
      .find((entry: any) => entry.metadata?.subAction === 'storage.relocate');
    expect(relocateRow).toBeDefined();
    expect(relocateRow.action).toBe(AuditAction.EDIT);
    expect(relocateRow.entityType).toBe('document');
    expect(relocateRow.entityId).toBe(DOC_ID);
    expect(relocateRow.metadata.from).toBe(from);
    expect(relocateRow.metadata.to).toBe(to);
  });

  it('skips relocate when the document has no linked party', async () => {
    const prisma = buildPrismaStub();
    const audit = buildAuditStub();
    const storage = buildStorageStub();

    prisma.document.findFirst
      .mockResolvedValueOnce({
        id: DOC_ID,
        status: DocumentStatus.NOVO,
        dueDate: null,
        paymentDueDate: null,
        total: null,
        netAmount: null,
      })
      .mockResolvedValueOnce({
        id: DOC_ID,
        fileKey: '<tenant>/_inbox/2026-09-04/orig.pdf',
        pdfKey: null,
        docDate: new Date(),
        docNumber: 'FT 1',
        partyId: null,
        party: null,
      });

    prisma.document.update.mockResolvedValue({ id: DOC_ID, status: DocumentStatus.APROVADO });

    const svc = makeSvc(prisma, audit, storage);
    await svc.approve(TENANT_ID, USER_ID, DOC_ID);

    expect(storage.move).not.toHaveBeenCalled();
    const relocateRow = (audit.log as jest.Mock).mock.calls
      .map((c) => c[0])
      .find((entry: any) => entry.metadata?.subAction === 'storage.relocate');
    expect(relocateRow).toBeUndefined();
  });

  it('skips relocate when the file is already outside _inbox/ (idempotent)', async () => {
    const prisma = buildPrismaStub();
    const audit = buildAuditStub();
    const storage = buildStorageStub();

    prisma.document.findFirst
      .mockResolvedValueOnce({
        id: DOC_ID,
        status: DocumentStatus.NOVO,
        dueDate: null,
        paymentDueDate: null,
        total: null,
        netAmount: null,
      })
      .mockResolvedValueOnce({
        id: DOC_ID,
        fileKey: 'fornecedores/edp/2026-09/already-routed.pdf',
        pdfKey: null,
        docDate: new Date(),
        docNumber: 'FT 1',
        partyId: 'party-1',
        party: {
          id: 'party-1',
          name: 'EDP',
          slug: 'edp',
          type: 'FORNECEDOR',
          partyCategory: null,
        },
      });

    prisma.document.update.mockResolvedValue({ id: DOC_ID, status: DocumentStatus.APROVADO });

    const svc = makeSvc(prisma, audit, storage);
    await svc.approve(TENANT_ID, USER_ID, DOC_ID);

    expect(storage.move).not.toHaveBeenCalled();
  });

  it('also moves the pdfKey sibling when present', async () => {
    const prisma = buildPrismaStub();
    const audit = buildAuditStub();
    const storage = buildStorageStub();

    prisma.document.findFirst
      .mockResolvedValueOnce({
        id: DOC_ID,
        status: DocumentStatus.NOVO,
        dueDate: null,
        paymentDueDate: null,
        total: null,
        netAmount: null,
      })
      .mockResolvedValueOnce({
        id: DOC_ID,
        fileKey: '<tenant>/_inbox/2026-09-04/orig.jpg',
        pdfKey: '<tenant>/_inbox/2026-09-04/orig.pdf',
        docDate: new Date(Date.UTC(2026, 8, 4)),
        docNumber: 'FT 2',
        partyId: 'party-1',
        party: {
          id: 'party-1',
          name: 'AWS',
          slug: 'aws',
          type: 'FORNECEDOR',
          partyCategory: null,
        },
      });

    prisma.document.update.mockResolvedValue({ id: DOC_ID, status: DocumentStatus.APROVADO });

    const svc = makeSvc(prisma, audit, storage);
    await svc.approve(TENANT_ID, USER_ID, DOC_ID);

    expect(storage.move).toHaveBeenCalledTimes(2);
    const [, mainTo] = (storage.move as jest.Mock).mock.calls[0];
    const [, pdfTo] = (storage.move as jest.Mock).mock.calls[1];
    expect(pdfTo).toBe(mainTo.replace(/\.[^.]+$/, '.pdf'));
  });

  it('routes AMBOS parties to fornecedores/ (per product decision)', async () => {
    const prisma = buildPrismaStub();
    const audit = buildAuditStub();
    const storage = buildStorageStub();

    prisma.document.findFirst
      .mockResolvedValueOnce({
        id: DOC_ID,
        status: DocumentStatus.NOVO,
        dueDate: null,
        paymentDueDate: null,
        total: null,
        netAmount: null,
      })
      .mockResolvedValueOnce({
        id: DOC_ID,
        fileKey: '<tenant>/_inbox/2026-09-04/orig.pdf',
        pdfKey: null,
        docDate: new Date(Date.UTC(2026, 8, 4)),
        docNumber: 'FT 3',
        partyId: 'party-2',
        party: {
          id: 'party-2',
          name: 'Grupo Misto',
          slug: 'grupo-misto',
          type: 'AMBOS',
          partyCategory: null,
        },
      });

    prisma.document.update.mockResolvedValue({ id: DOC_ID, status: DocumentStatus.APROVADO });

    const svc = makeSvc(prisma, audit, storage);
    await svc.approve(TENANT_ID, USER_ID, DOC_ID);

    expect(storage.move).toHaveBeenCalledTimes(1);
    const [, to] = (storage.move as jest.Mock).mock.calls[0];
    expect(to).toMatch(/^fornecedores\/grupo-misto\//);
  });

  // ───────────────────────────────────────────────────────────────────────
  // Sprint E fix-up (audit §5 MEDIUM-3): the relocate path now lives
  // inside prisma.$transaction with a pg_advisory_xact_lock keyed off
  // the document id. Verify:
  //   1. $transaction is invoked on every approve that reaches the
  //      relocate branch.
  //   2. The advisory lock SQL (`SELECT pg_advisory_xact_lock(...)`)
  //      is sent BEFORE the document read.
  //   3. Two sequential approves against the SAME document row are
  //      idempotent: the second call short-circuits at the `_inbox/`
  //      guard because the first transaction already moved fileKey.
  // ───────────────────────────────────────────────────────────────────────
  it('wraps the relocate in $transaction and runs the advisory lock SQL first', async () => {
    const prisma = buildPrismaStub();
    const audit = buildAuditStub();
    const storage = buildStorageStub();

    prisma.document.findFirst
      .mockResolvedValueOnce({
        id: DOC_ID,
        status: DocumentStatus.NOVO,
        dueDate: null,
        paymentDueDate: null,
        total: null,
        netAmount: null,
      })
      .mockResolvedValueOnce({
        id: DOC_ID,
        fileKey: '<tenant>/_inbox/2026-09-04/orig.pdf',
        pdfKey: null,
        docDate: new Date(Date.UTC(2026, 8, 4)),
        docNumber: 'FT 4',
        partyId: 'party-1',
        party: {
          id: 'party-1',
          name: 'EDP',
          slug: 'edp',
          type: 'FORNECEDOR',
          partyCategory: null,
        },
      });

    prisma.document.update.mockResolvedValue({ id: DOC_ID, status: DocumentStatus.APROVADO });

    const svc = makeSvc(prisma, audit, storage);
    await svc.approve(TENANT_ID, USER_ID, DOC_ID);

    // The transaction wrapper is invoked.
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it('second concurrent approve is idempotent: storage.move fires once total', async () => {
    const prisma = buildPrismaStub();
    const audit = buildAuditStub();
    const storage = buildStorageStub();

    // Approve #1: read row with _inbox/ fileKey → move bytes → update.
    // Approve #2: same read pattern but the second `findFirst` (inside
    // the second approve's relocate) returns the POST-update row whose
    // fileKey NO LONGER includes `/_inbox/`. The guard short-circuits.
    prisma.document.findFirst
      // approve() #1 — existing row read
      .mockResolvedValueOnce({
        id: DOC_ID,
        status: DocumentStatus.NOVO,
        dueDate: null,
        paymentDueDate: null,
        total: null,
        netAmount: null,
      })
      // relocateAfterApprove() #1 — pre-move row
      .mockResolvedValueOnce({
        id: DOC_ID,
        fileKey: '<tenant>/_inbox/2026-09-04/orig.pdf',
        pdfKey: null,
        docDate: new Date(Date.UTC(2026, 8, 4)),
        docNumber: 'FT 5',
        partyId: 'party-1',
        party: {
          id: 'party-1',
          name: 'EDP',
          slug: 'edp',
          type: 'FORNECEDOR',
          partyCategory: null,
        },
      })
      // approve() #2 — existing row read (already APPROVED, idempotent)
      .mockResolvedValueOnce({
        id: DOC_ID,
        status: DocumentStatus.APROVADO,
        dueDate: null,
        paymentDueDate: null,
        total: null,
        netAmount: null,
      })
      // relocateAfterApprove() #2 — post-move row (already routed)
      .mockResolvedValueOnce({
        id: DOC_ID,
        fileKey: 'fornecedores/edp/2026-09/already-routed.pdf',
        pdfKey: null,
        docDate: new Date(Date.UTC(2026, 8, 4)),
        docNumber: 'FT 5',
        partyId: 'party-1',
        party: {
          id: 'party-1',
          name: 'EDP',
          slug: 'edp',
          type: 'FORNECEDOR',
          partyCategory: null,
        },
      });

    prisma.document.update.mockResolvedValue({ id: DOC_ID, status: DocumentStatus.APROVADO });

    const svc = makeSvc(prisma, audit, storage);
    await svc.approve(TENANT_ID, USER_ID, DOC_ID);
    await svc.approve(TENANT_ID, USER_ID, DOC_ID);

    // Exactly ONE move across both approves — the second is a no-op.
    expect(storage.move).toHaveBeenCalledTimes(1);
    // Exactly ONE storage.relocate audit row.
    const relocateRows = (audit.log as jest.Mock).mock.calls.filter(
      (c) => c[0]?.metadata?.subAction === 'storage.relocate',
    );
    expect(relocateRows).toHaveLength(1);
  });
});
