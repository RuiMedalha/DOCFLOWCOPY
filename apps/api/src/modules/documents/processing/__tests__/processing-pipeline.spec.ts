import {
  AuditAction,
  DocumentProcessingStatus,
  Prisma,
} from '@prisma/client';
import { ProcessingService } from '../processing.service';
import { ProcessingEventsStore } from '../processing-events-store.service';
import type { ExtractionService } from '../../../extraction/extraction.service';
import type { AuditService } from '../../../audit/audit.service';
import type { DocumentsService } from '../../documents.service';
import type { QueueAdapter } from '../../../../common/queue/queue-adapter.interface';

/**
 * ProcessingService — 4-stage pipeline (RECEIVED → EXTRACTING → ENRICHING
 * → ROUTING → COMPLETED, FAILED is terminal).
 *
 * Coverage:
 *   1. RECEIVED handler transitions to EXTRACTING and emits SSE
 *   2. EXTRACTED handler transitions to ENRICHING with partyId
 *   3. ENRICHED handler transitions to ROUTING
 *   4. ROUTED handler transitions to COMPLETED
 *   5. Idempotency: re-receiving an event after terminal state is a no-op
 *   6. Failure recovery: any handler throwing marks FAILED + audit row
 */

const TENANT = 'tenant-A';
const USER = 'user-1';
const DOC = 'doc-1';

interface FakePrisma {
  document: {
    findFirst: jest.Mock;
    update: jest.Mock;
  };
  $transaction: jest.Mock;
  $executeRaw: jest.Mock;
}

function buildPrisma(opts: {
  initialStatus?: DocumentProcessingStatus | null;
  partyId?: string | null;
  tenantSettings?: { autoApprove?: boolean } | null;
} = {}): FakePrisma {
  const documentFindFirst = jest.fn(async ({ where }: any) => {
    if (where.id !== DOC) return null;
    return {
      id: DOC,
      tenantId: TENANT,
      partyId: opts.partyId ?? null,
      processingStatus: opts.initialStatus ?? DocumentProcessingStatus.RECEIVED,
      processingStartedAt: null,
      tenant: { settings: opts.tenantSettings ?? null },
    };
  });
  const documentUpdate = jest.fn(async ({ where, data }: any) => ({
    id: where.id,
    ...data,
  }));
  const $executeRaw = jest.fn(async () => undefined);
  const tx = {
    document: { findFirst: documentFindFirst, update: documentUpdate },
    $executeRaw,
  };
  const $transaction = jest.fn(async (work: any) => {
    if (typeof work !== 'function') return work;
    return work(tx);
  });
  return {
    document: { findFirst: documentFindFirst, update: documentUpdate },
    $transaction,
    $executeRaw,
  } as unknown as FakePrisma;
}

function buildAudit(): AuditService {
  return {
    log: jest.fn(async () => undefined),
    logInTx: jest.fn(async () => undefined),
  } as unknown as AuditService;
}

function buildExtraction(): ExtractionService {
  return {
    enqueue: jest.fn(async () => ({
      queued: true,
      documentId: DOC,
      ok: true,
      source: 'at_qr',
      confidence: 0.95,
    })),
  } as unknown as ExtractionService;
}

function buildDocuments(): DocumentsService {
  return {
    approve: jest.fn(async () => ({
      id: DOC,
      tenantId: TENANT,
      status: 'APROVADO',
      fileKey: 'tenant-A/fornecedores/x/2026-09/doc-1.pdf',
    })),
  } as unknown as DocumentsService;
}

function buildEventsStore(): ProcessingEventsStore {
  return {
    emit: jest.fn(),
    drop: jest.fn(),
  } as unknown as ProcessingEventsStore;
}

function buildQueue(): QueueAdapter {
  return {
    driver: 'eventemitter',
    publish: jest.fn(async () => undefined),
    subscribe: jest.fn(),
    subscribeBatch: jest.fn(),
  } as unknown as QueueAdapter;
}

describe('ProcessingService (4-stage pipeline)', () => {
  let prisma: FakePrisma;
  let audit: AuditService;
  let extraction: ExtractionService;
  let documents: DocumentsService;
  let events: ProcessingEventsStore;
  let queue: QueueAdapter;
  let service: ProcessingService;

  beforeEach(() => {
    prisma = buildPrisma();
    audit = buildAudit();
    extraction = buildExtraction();
    documents = buildDocuments();
    events = buildEventsStore();
    queue = buildQueue();
    service = new ProcessingService(
      prisma as any,
      audit,
      events,
      extraction,
      documents,
      queue,
    );
  });

  it('handleReceived moves RECEIVED → EXTRACTING and emits SSE', async () => {
    await service.handleReceived({
      documentId: DOC,
      tenantId: TENANT,
      userId: USER,
      fileKey: 'tenant-A/_inbox/foo.pdf',
      mimeType: 'application/pdf',
      fileSize: 1024,
      originalFilename: 'foo.pdf',
      uploadedAt: new Date().toISOString(),
    });

    // EXTRACTING was set, audit row written, SSE emit fired
    const updateCalls = prisma.document.update.mock.calls;
    expect(updateCalls.length).toBeGreaterThanOrEqual(1);
    expect(updateCalls[0][0]).toEqual({
      where: { id: DOC },
      data: expect.objectContaining({
        processingStatus: DocumentProcessingStatus.EXTRACTING,
        processingError: null,
      }),
    });
    expect(events.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        documentId: DOC,
        stage: 'EXTRACTING',
        event: 'processing.stage.completed',
      }),
    );
    // extraction was triggered
    expect(extraction.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: DOC, tenantId: TENANT }),
    );
  });

  it('handleReceived skips when status is already past RECEIVED', async () => {
    prisma = buildPrisma({ initialStatus: DocumentProcessingStatus.ENRICHING });
    service = new ProcessingService(
      prisma as any,
      audit,
      events,
      extraction,
      documents,
      queue,
    );

    await service.handleReceived({
      documentId: DOC,
      tenantId: TENANT,
      userId: USER,
      fileKey: 'k',
      mimeType: 'application/pdf',
      fileSize: 1,
      originalFilename: 'x',
      uploadedAt: new Date().toISOString(),
    });

    expect(prisma.document.update).not.toHaveBeenCalled();
  });

  it('handleExtracted moves to ENRICHING and emits SSE', async () => {
    // Pre-stage the doc into EXTRACTING so the handler can advance it
    prisma = buildPrisma({ initialStatus: DocumentProcessingStatus.EXTRACTING, partyId: 'party-1' });
    service = new ProcessingService(
      prisma as any,
      audit,
      events,
      extraction,
      documents,
      queue,
    );

    await service.handleExtracted({
      documentId: DOC,
      tenantId: TENANT,
      userId: USER,
      extractedFields: {
        supplier: 'ACME',
        supplierNif: '123456789',
        total: 100,
        currency: 'EUR',
      },
      confidence: 0.9,
      source: 'at_qr',
    });

    expect(prisma.document.update).toHaveBeenCalledWith({
      where: { id: DOC },
      data: { processingStatus: DocumentProcessingStatus.ENRICHING },
    });
    expect(events.emit).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'ENRICHING' }),
    );
  });

  it('handleEnriched moves to ROUTING (autoApprove=false → no approve call)', async () => {
    prisma = buildPrisma({
      initialStatus: DocumentProcessingStatus.ENRICHING,
      partyId: 'party-1',
      tenantSettings: { autoApprove: false },
    });
    service = new ProcessingService(
      prisma as any,
      audit,
      events,
      extraction,
      documents,
      queue,
    );

    await service.handleEnriched({
      documentId: DOC,
      tenantId: TENANT,
      userId: USER,
      partyId: 'party-1',
      partyMatched: true,
      ibanUpdated: false,
      ibanRiskScore: 0,
    });

    expect(prisma.document.update).toHaveBeenCalledWith({
      where: { id: DOC },
      data: { processingStatus: DocumentProcessingStatus.ROUTING },
    });
    expect(documents.approve).not.toHaveBeenCalled();
    expect(events.emit).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'ROUTING' }),
    );
    expect(queue.publish).toHaveBeenCalledWith(
      'document.routed',
      expect.objectContaining({
        topic: 'document.routed',
        documentId: DOC,
        tenantId: TENANT,
        partyId: 'party-1',
      }),
    );
  });

  it('publishes the terminal route event even when auto-approval is disabled', async () => {
    prisma = buildPrisma({
      initialStatus: DocumentProcessingStatus.ENRICHING,
      partyId: null,
      tenantSettings: { autoApprove: false },
    });
    service = new ProcessingService(prisma as any, audit, events, extraction, documents, queue);

    await service.handleEnriched({
      documentId: DOC,
      tenantId: TENANT,
      userId: USER,
      partyId: null,
      partyMatched: false,
      ibanUpdated: false,
      ibanRiskScore: 0,
    });

    expect(queue.publish).toHaveBeenCalledWith(
      'document.routed',
      expect.objectContaining({ approved: false, partyId: null }),
    );
  });

  it('handleEnriched calls approve() when autoApprove=true AND party is linked', async () => {
    prisma = buildPrisma({
      initialStatus: DocumentProcessingStatus.ENRICHING,
      partyId: 'party-1',
      tenantSettings: { autoApprove: true },
    });
    service = new ProcessingService(
      prisma as any,
      audit,
      events,
      extraction,
      documents,
      queue,
    );

    await service.handleEnriched({
      documentId: DOC,
      tenantId: TENANT,
      userId: USER,
      partyId: 'party-1',
      partyMatched: true,
      ibanUpdated: false,
      ibanRiskScore: 0,
    });

    expect(documents.approve).toHaveBeenCalledWith(TENANT, USER, DOC);
  });

  it('handleEnriched does NOT auto-approve when party is missing (even with autoApprove=true)', async () => {
    prisma = buildPrisma({
      initialStatus: DocumentProcessingStatus.ENRICHING,
      partyId: null,
      tenantSettings: { autoApprove: true },
    });
    service = new ProcessingService(
      prisma as any,
      audit,
      events,
      extraction,
      documents,
      queue,
    );

    await service.handleEnriched({
      documentId: DOC,
      tenantId: TENANT,
      userId: USER,
      partyId: null,
      partyMatched: false,
      ibanUpdated: false,
      ibanRiskScore: 0,
    });

    expect(documents.approve).not.toHaveBeenCalled();
  });

  it('handleRouted moves to COMPLETED', async () => {
    prisma = buildPrisma({ initialStatus: DocumentProcessingStatus.ROUTING });
    service = new ProcessingService(
      prisma as any,
      audit,
      events,
      extraction,
      documents,
      queue,
    );

    await service.handleRouted({
      documentId: DOC,
      tenantId: TENANT,
      userId: USER,
      approved: true,
      newFileKey: 'tenant-A/fornecedores/x/2026-09/doc-1.pdf',
      partyId: 'party-1',
      completedAt: new Date().toISOString(),
    });

    expect(prisma.document.update).toHaveBeenCalledWith({
      where: { id: DOC },
      data: expect.objectContaining({
        processingStatus: DocumentProcessingStatus.COMPLETED,
        processingCompletedAt: expect.any(Date),
      }),
    });
    expect(events.emit).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'COMPLETED', event: 'processing.completed' }),
    );
  });

  it('handleRouted is a no-op when the doc is already COMPLETED (idempotent retry)', async () => {
    prisma = buildPrisma({ initialStatus: DocumentProcessingStatus.COMPLETED });
    service = new ProcessingService(
      prisma as any,
      audit,
      events,
      extraction,
      documents,
      queue,
    );

    await service.handleRouted({
      documentId: DOC,
      tenantId: TENANT,
      userId: USER,
      approved: false,
      newFileKey: null,
      partyId: null,
      completedAt: new Date().toISOString(),
    });

    expect(prisma.document.update).not.toHaveBeenCalled();
    // Sprint H security-audit H-8: idempotent skip on a COMPLETED doc
    // still emits a `processing.completed` event (with `replay: true`)
    // so late SSE subscribers see the terminal event.
    expect(events.emit).toHaveBeenCalledTimes(1);
    expect(events.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'COMPLETED',
        event: 'processing.completed',
        payload: expect.objectContaining({ replay: true }),
      }),
    );
  });

  it('handler exception marks the doc FAILED and emits processing.failed', async () => {
    prisma = buildPrisma();
    // Make the first tx work but the second update throw — the inner
    // tryHandler catches it and writes FAILED on a SECOND update.
    let firstUpdate = true;
    prisma.document.update.mockImplementation(async ({ data }: any) => {
      if (firstUpdate) {
        firstUpdate = false;
        throw new Error('database connection refused');
      }
      return { id: DOC, ...data };
    });
    service = new ProcessingService(
      prisma as any,
      audit,
      events,
      extraction,
      documents,
      queue,
    );

    await service.handleReceived({
      documentId: DOC,
      tenantId: TENANT,
      userId: USER,
      fileKey: 'k',
      mimeType: 'application/pdf',
      fileSize: 1,
      originalFilename: 'x',
      uploadedAt: new Date().toISOString(),
    });

    // The second update inside tryHandler should have written FAILED.
    const allUpdateCalls = prisma.document.update.mock.calls;
    expect(allUpdateCalls.length).toBeGreaterThanOrEqual(2);
    const lastData = allUpdateCalls[allUpdateCalls.length - 1][0].data;
    expect(lastData.processingStatus).toBe(DocumentProcessingStatus.FAILED);
    expect(lastData.processingError).toMatch(/database connection refused/);

    expect(events.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'FAILED',
        event: 'processing.failed',
      }),
    );

    expect(audit.logInTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: AuditAction.EDIT,
        metadata: expect.objectContaining({
          subAction: 'processing.failed',
          error: expect.stringContaining('database connection refused'),
        }),
      }),
    );
  });
});
