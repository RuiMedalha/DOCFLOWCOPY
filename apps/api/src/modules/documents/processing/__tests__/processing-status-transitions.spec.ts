import { DocumentProcessingStatus } from '@prisma/client';
import { ProcessingService } from '../processing.service';
import { ProcessingEventsStore } from '../processing-events-store.service';
import type { ExtractionService } from '../../../extraction/extraction.service';
import type { AuditService } from '../../../audit/audit.service';
import type { DocumentsService } from '../../documents.service';

/**
 * ProcessingService — every stage transitions processingStatus correctly.
 *
 * One test per stage, asserting the update call writes the right enum
 * value. These tests are deliberately narrow — broad behaviour lives in
 * processing-pipeline.spec.ts; here we just pin the state machine.
 */

function buildPrisma(currentStatus: DocumentProcessingStatus, partyId: string | null = null) {
  const documentFindFirst = jest.fn(async () => ({
    id: 'doc',
    tenantId: 'tenant',
    partyId,
    processingStatus: currentStatus,
    processingStartedAt: null,
    tenant: { settings: null },
  }));
  const documentUpdate = jest.fn(async ({ where, data }: any) => ({
    id: where.id,
    ...data,
  }));
  const tx = {
    document: { findFirst: documentFindFirst, update: documentUpdate },
    $executeRaw: jest.fn(async () => undefined),
  };
  return {
    document: { findFirst: documentFindFirst, update: documentUpdate },
    $transaction: jest.fn(async (work: any) => work(tx)),
    $executeRaw: jest.fn(async () => undefined),
  };
}

function buildAudit() {
  return {
    log: jest.fn(async () => undefined),
    logInTx: jest.fn(async () => undefined),
  } as unknown as AuditService;
}

function buildExtraction() {
  return {
    enqueue: jest.fn(async () => ({ queued: true, documentId: 'doc', ok: true })),
  } as unknown as ExtractionService;
}

function buildDocuments() {
  return { approve: jest.fn(async () => ({ id: 'doc', fileKey: 'k', status: 'APROVADO' })) } as unknown as DocumentsService;
}

function buildEvents() {
  return { emit: jest.fn(), drop: jest.fn() } as unknown as ProcessingEventsStore;
}

function buildQueue() {
  return {
    driver: 'eventemitter' as const,
    publish: jest.fn(async () => undefined),
    subscribe: jest.fn(),
    subscribeBatch: jest.fn(),
  } as unknown as import('../../../../common/queue/queue-adapter.interface').QueueAdapter;
}

function buildService(prisma: any) {
  return new ProcessingService(
    prisma as any,
    buildAudit(),
    buildEvents(),
    buildExtraction(),
    buildDocuments(),
    buildQueue(),
  );
}

describe('ProcessingService — state transitions', () => {
  it('RECEIVED → EXTRACTING', async () => {
    const prisma = buildPrisma(DocumentProcessingStatus.RECEIVED);
    const svc = buildService(prisma);
    await svc.handleReceived({
      documentId: 'doc',
      tenantId: 'tenant',
      userId: 'user',
      fileKey: 'k',
      mimeType: 'application/pdf',
      fileSize: 1,
      originalFilename: 'x',
      uploadedAt: new Date().toISOString(),
    });
    expect(prisma.document.update.mock.calls[0][0].data.processingStatus).toBe(
      DocumentProcessingStatus.EXTRACTING,
    );
  });

  it('EXTRACTING → ENRICHING', async () => {
    const prisma = buildPrisma(DocumentProcessingStatus.EXTRACTING, 'party-1');
    const svc = buildService(prisma);
    await svc.handleExtracted({
      documentId: 'doc',
      tenantId: 'tenant',
      userId: 'user',
      extractedFields: { supplier: 'ACME', total: 100 },
      confidence: 0.9,
      source: 'at_qr',
    });
    expect(prisma.document.update.mock.calls[0][0].data.processingStatus).toBe(
      DocumentProcessingStatus.ENRICHING,
    );
  });

  it('ENRICHING → ROUTING', async () => {
    const prisma = buildPrisma(DocumentProcessingStatus.ENRICHING, 'party-1');
    const svc = buildService(prisma);
    await svc.handleEnriched({
      documentId: 'doc',
      tenantId: 'tenant',
      userId: 'user',
      partyId: 'party-1',
      partyMatched: true,
      ibanUpdated: false,
      ibanRiskScore: 0,
    });
    expect(prisma.document.update.mock.calls[0][0].data.processingStatus).toBe(
      DocumentProcessingStatus.ROUTING,
    );
  });

  it('ROUTING → COMPLETED', async () => {
    const prisma = buildPrisma(DocumentProcessingStatus.ROUTING);
    const svc = buildService(prisma);
    await svc.handleRouted({
      documentId: 'doc',
      tenantId: 'tenant',
      userId: 'user',
      approved: false,
      newFileKey: null,
      partyId: null,
      completedAt: new Date().toISOString(),
    });
    const updateData = prisma.document.update.mock.calls[0][0].data;
    expect(updateData.processingStatus).toBe(DocumentProcessingStatus.COMPLETED);
    expect(updateData.processingCompletedAt).toBeInstanceOf(Date);
  });

  it('FAILED is terminal — re-entering RECEIVED skips the transition', async () => {
    const prisma = buildPrisma(DocumentProcessingStatus.FAILED);
    const svc = buildService(prisma);
    await svc.handleReceived({
      documentId: 'doc',
      tenantId: 'tenant',
      userId: 'user',
      fileKey: 'k',
      mimeType: 'application/pdf',
      fileSize: 1,
      originalFilename: 'x',
      uploadedAt: new Date().toISOString(),
    });
    expect(prisma.document.update).not.toHaveBeenCalled();
  });
});
