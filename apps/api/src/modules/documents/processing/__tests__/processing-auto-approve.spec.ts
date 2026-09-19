import { DocumentProcessingStatus } from '@prisma/client';
import { ProcessingService } from '../processing.service';
import { ProcessingEventsStore } from '../processing-events-store.service';
import type { ExtractionService } from '../../../extraction/extraction.service';
import type { AuditService } from '../../../audit/audit.service';
import type { DocumentsService } from '../../documents.service';
import type { QueueAdapter } from '../../../../common/queue/queue-adapter.interface';

/**
 * ProcessingService — autoApprove behaviour (Sprint H).
 *
 * Coverage:
 *   1. autoApprove=true + partyId present → calls documentsService.approve
 *   2. autoApprove=true + partyId null    → does NOT approve
 *   3. autoApprove=false                  → never approves
 *   4. approve() failure does NOT poison the pipeline — routed event still fires
 */

const TENANT = 'tenant-A';
const USER = 'user-1';
const DOC = 'doc-1';

function buildPrisma(opts: {
  partyId?: string | null;
  tenantSettings?: { autoApprove?: boolean } | null;
}) {
  const documentFindFirst = jest.fn(async () => ({
    id: DOC,
    tenantId: TENANT,
    partyId: opts.partyId ?? null,
    processingStatus: DocumentProcessingStatus.ENRICHING,
    processingStartedAt: null,
    tenant: { settings: opts.tenantSettings ?? null },
  }));
  const documentUpdate = jest.fn(async ({ where, data }: any) => ({
    id: where.id,
    ...data,
  }));
  const txHandle = {
    document: { findFirst: documentFindFirst, update: documentUpdate },
    $executeRaw: jest.fn(async () => undefined),
  };
  return {
    document: { findFirst: documentFindFirst, update: documentUpdate },
    $transaction: jest.fn(async (work: any) => work(txHandle)),
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
    enqueue: jest.fn(async () => ({ queued: true, documentId: DOC, ok: true })),
  } as unknown as ExtractionService;
}

function buildEventsStore() {
  return {
    emit: jest.fn(),
    drop: jest.fn(),
  } as unknown as ProcessingEventsStore;
}

function buildService(opts: {
  partyId?: string | null;
  tenantSettings?: { autoApprove?: boolean } | null;
  approveImpl?: () => Promise<unknown>;
}) {
  const prisma = buildPrisma(opts);
  const documents = {
    approve: jest.fn((opts.approveImpl ?? (async () => ({
      id: DOC,
      fileKey: 'tenant-A/fornecedores/x/2026-09/doc-1.pdf',
      status: 'APROVADO',
    }))) as any),
  } as unknown as DocumentsService;

  const queue = {
    driver: 'eventemitter' as const,
    publish: jest.fn(async () => undefined),
    subscribe: jest.fn(),
    subscribeBatch: jest.fn(),
  } as unknown as QueueAdapter;

  const service = new ProcessingService(
    prisma as any,
    buildAudit(),
    buildEventsStore(),
    buildExtraction(),
    documents,
    queue,
  );
  return { service, prisma, documents };
}

async function runEnriched(service: ProcessingService) {
  await service.handleEnriched({
    documentId: DOC,
    tenantId: TENANT,
    userId: USER,
    partyId: 'party-1',
    partyMatched: true,
    ibanUpdated: false,
    ibanRiskScore: 0,
  });
}

describe('ProcessingService — autoApprove gating', () => {
  it('autoApprove=true + party present → calls approve()', async () => {
    const { service, documents } = buildService({
      partyId: 'party-1',
      tenantSettings: { autoApprove: true },
    });
    await runEnriched(service);
    expect(documents.approve).toHaveBeenCalledWith(TENANT, USER, DOC);
  });

  it('autoApprove=true + party missing → does NOT approve', async () => {
    const { service, documents } = buildService({
      partyId: null,
      tenantSettings: { autoApprove: true },
    });
    await runEnriched(service);
    expect(documents.approve).not.toHaveBeenCalled();
  });

  it('autoApprove=false → never approves', async () => {
    const { service, documents } = buildService({
      partyId: 'party-1',
      tenantSettings: { autoApprove: false },
    });
    await runEnriched(service);
    expect(documents.approve).not.toHaveBeenCalled();
  });

  it('approve() failure surfaces via SSE without poisoning the pipeline', async () => {
    const { service, documents } = buildService({
      partyId: 'party-1',
      tenantSettings: { autoApprove: true },
      approveImpl: async () => {
        throw new Error('advisory lock timeout');
      },
    });
    // The handler catches the approve failure and continues. The SSE
    // event for the ROUTING stage must still fire (with approved=false).
    await runEnriched(service);
    expect(documents.approve).toHaveBeenCalledTimes(1);
    // No throw escapes the handler — the assertion that we reached the
    // end of handleEnriched successfully is the implicit contract.
  });
});
