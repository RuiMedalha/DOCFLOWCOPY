import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  AuditAction,
  DocumentProcessingStatus,
  type PrismaClient,
} from '@prisma/client';
import { AuditService } from '../../audit/audit.service';
import { DocumentsService } from '../documents.service';
import { ExtractionService } from '../../extraction/extraction.service';
import {
  QUEUE_ADAPTER,
  type QueueAdapter,
} from '../../../common/queue/queue-adapter.interface';
import { EnrichmentService } from '../../enrichment/enrichment.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { docLockKey } from '../../../common/locks';
import { ProcessingEventsStore } from './processing-events-store.service';

/**
 * Sprint H — the doc-processing pipeline.
 *
 * Four stages, each driven by an event:
 *
 *   document.uploaded  → handleReceived  (RECEIVED → EXTRACTING)
 *   document.extracted → handleExtracted (EXTRACTING → ENRICHING)
 *   document.enriched  → handleEnriched  (ENRICHING → ROUTING)
 *   document.routed    → handleRouted    (ROUTING → COMPLETED)
 *
 * Every stage is idempotent: a second invocation after the doc has
 * already advanced past the stage is a no-op. We check the persisted
 * status at the start of the handler and bail if it's not the one we
 * expect. A `pg_advisory_xact_lock` per documentId (centralised in
 * `common/locks.ts`) keeps the read-modify-write cycle honest.
 *
 * Failure path: any handler that throws is caught and the doc is
 * marked FAILED with the error message truncated to 500 chars. An
 * audit row with `subAction: 'processing.failed'` is written so
 * forensics can replay.
 *
 * Security notes (Sprint H security-audit 2026-09-05):
 *   - Every `findFirst` is gated by `tenantId` (BOLA fix H-6).
 *   - Every transaction acquires `pg_advisory_xact_lock` on the
 *     centralised `docLockKey(documentId)` (race fix H-7).
 *   - On idempotent skip, the SSE event is replayed when the doc
 *     is already at the terminal state (UX fix H-8).
 *   - Auto-approve writes a separate `processing.auto_approved`
 *     audit row (audit fix H-10).
 */

// ─── payloads ────────────────────────────────────────────────────────

export interface DocumentUploadedEvent {
  documentId: string;
  tenantId: string;
  userId: string;
  fileKey: string;
  mimeType: string;
  fileSize: number;
  originalFilename: string;
  uploadedAt: string;
  modelOverride?: string;
  providerOverride?: string;
  forceReextract?: boolean;
}

export interface DocumentExtractedEvent {
  documentId: string;
  tenantId: string;
  userId: string;
  extractedFields: Record<string, unknown>;
  confidence: number;
  source: 'at_qr' | 'at_qr+ai' | 'ocr' | 'regex' | 'ai' | 'none';
}

export interface DocumentEnrichedEvent {
  documentId: string;
  tenantId: string;
  userId: string;
  partyId: string | null;
  partyMatched: boolean;
  ibanUpdated: boolean;
  ibanRiskScore: number;
}

export interface DocumentRoutedEvent {
  documentId: string;
  tenantId: string;
  userId: string;
  approved: boolean;
  newFileKey: string | null;
  partyId: string | null;
  completedAt: string;
}

// ─── tenant settings shape ───────────────────────────────────────────

interface TenantSettingsShape {
  autoApprove?: boolean;
}

// ─── prisma shape (narrow — we only touch these models) ──────────────

interface ProcessingPrisma {
  document: {
    findFirst: (args: { where: { id: string; tenantId?: string } }) => Promise<
      | {
          id: string;
          tenantId: string;
          partyId: string | null;
          processingStatus: DocumentProcessingStatus | null;
          processingStartedAt: Date | null;
          tenant: { settings: TenantSettingsShape | null } | null;
        }
      | null
    >;
    update: (args: {
      where: { id: string };
      data: Record<string, unknown>;
    }) => Promise<unknown>;
  };
  $transaction: <T>(work: (tx: ProcessingPrisma) => Promise<T>) => Promise<T>;
  $executeRaw: (...args: unknown[]) => Promise<unknown>;
}

const TOPICS = [
  'document.uploaded',
  'document.extracted',
  'document.enriched',
  'document.routed',
] as const;

@Injectable()
export class ProcessingService {
  private readonly logger = new Logger(ProcessingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly events: ProcessingEventsStore,
    private readonly extraction: ExtractionService,
    private readonly documents: DocumentsService,
    @Inject(QUEUE_ADAPTER) private readonly queue: QueueAdapter,
    // Sprint I — enrich party (supplier + customer) during the
    // ENRICHING stage and publish `document.enriched` when done so
    // the pipeline can advance to ROUTING. Optional so the existing
    // processing test fixture (which builds ProcessingService
    // directly without EnrichmentModule) keeps compiling — the
    // enrichment leg simply becomes a no-op when absent.
    private readonly enrichment?: EnrichmentService,
  ) {
    // Bind once at construction time. Production always provides a
    // QueueAdapter via QueueModule.forRoot() — we removed the @Optional
    // accessor pattern (security-audit H-5) because the static accessor
    // broke cross-pod delivery. Every event the pipeline emits must go
    // through the same DI-injected instance.
    for (const topic of TOPICS) {
      this.queue.subscribe(topic, async (payload: unknown) => {
        await this.dispatch(topic, payload);
      });
    }
  }

  // ============================================================ handlers

  /**
   * RECEIVED → EXTRACTING. The handler also kicks off extraction —
   * we don't wait for `document.extracted` to begin work.
   */
  async handleReceived(evt: DocumentUploadedEvent): Promise<void> {
    await this.tryHandler(async () => {
      const updated = await this.prisma.$transaction(async (tx) => {
        // H-7: serialise concurrent handlers on the same documentId
        // using the centralised lock key (same key documents.service
        // uses for relocate/approve — see common/locks.ts).
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${docLockKey(evt.documentId)})`;
        // H-6: gate every read by tenantId so a forged event for
        // another tenant's docId is refused (BOLA).
        const doc = await tx.document.findFirst({
          where: { id: evt.documentId, tenantId: evt.tenantId },
        });
        if (!doc) {
          this.logger.warn(`[handleReceived] doc not found or cross-tenant: ${evt.documentId}`);
          return false;
        }
        // Idempotency: skip when the doc is already past RECEIVED.
        if (doc.processingStatus && doc.processingStatus !== DocumentProcessingStatus.RECEIVED) {
          return false;
        }
        await tx.document.update({
          where: { id: evt.documentId },
          data: {
            processingStatus: DocumentProcessingStatus.EXTRACTING,
            processingError: null,
            processingStartedAt: new Date(),
          },
        });
        await this.audit.logInTx(tx as unknown as PrismaClient, {
          tenantId: evt.tenantId,
          userId: evt.userId,
          action: AuditAction.EDIT,
          entityType: 'document',
          entityId: evt.documentId,
          metadata: { subAction: 'processing.started', stage: 'EXTRACTING' },
        });
        return true;
      });
      if (!updated) return;
      this.events.emit({
        documentId: evt.documentId,
        tenantId: evt.tenantId,
        stage: 'EXTRACTING',
        event: 'processing.stage.completed',
        payload: {
          stage: 'EXTRACTING',
          status: 'started',
          completedAt: new Date().toISOString(),
        },
      });
      // Trigger the next stage — failures inside enqueue are caught
      // by tryHandler and mark the doc FAILED.
      await this.extraction.enqueue({
        tenantId: evt.tenantId,
        userId: evt.userId,
        documentId: evt.documentId,
        modelOverride: evt.modelOverride,
        providerOverride: evt.providerOverride,
        forceReextract: evt.forceReextract,
      });
    }, evt, 'EXTRACTING');
  }

  /**
   * EXTRACTING → ENRICHING. Sprint I — after the transition fires
   * the enrichment chain against the doc's supplier party + customer
   * party (if not the tenant itself) and publishes `document.enriched`
   * so `handleEnriched` can advance the pipeline.
   */
  async handleExtracted(evt: DocumentExtractedEvent): Promise<void> {
    await this.tryHandler(async () => {
      const updated = await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${docLockKey(evt.documentId)})`;
        const doc = await tx.document.findFirst({
          where: { id: evt.documentId, tenantId: evt.tenantId },
        });
        if (!doc) return false;
        if (
          doc.processingStatus &&
          doc.processingStatus !== DocumentProcessingStatus.EXTRACTING
        ) {
          return false;
        }
        await tx.document.update({
          where: { id: evt.documentId },
          data: {
            processingStatus: DocumentProcessingStatus.ENRICHING,
          },
        });
        await this.audit.logInTx(tx as unknown as PrismaClient, {
          tenantId: evt.tenantId,
          userId: evt.userId,
          action: AuditAction.EDIT,
          entityType: 'document',
          entityId: evt.documentId,
          metadata: { subAction: 'processing.stage.advanced', stage: 'ENRICHING' },
        });
        return true;
      });
      if (!updated) return;
      this.events.emit({
        documentId: evt.documentId,
        tenantId: evt.tenantId,
        stage: 'ENRICHING',
        event: 'processing.stage.completed',
        payload: {
          stage: 'ENRICHING',
          status: 'started',
          completedAt: new Date().toISOString(),
        },
      });

      // Sprint I — drive the enrichment chain off the doc's partyId
      // (supplier) + its customer string. Failures are caught and
      // logged; we ALWAYS publish document.enriched so the pipeline
      // is never wedged on an enrichment outage.
      await this.runEnrichment(evt);
    }, evt, 'ENRICHING');
  }

  /**
   * Sprint I — kick off the enrichment chain for the doc's supplier
   * + customer parties and publish `document.enriched` when done.
   *
   * Best-effort: any error from `enrichment.enrichParty` is caught
   * and logged. We refuse to let a misbehaving provider stall the
   * pipeline at ENRICHING — the operator can retry via the manual
   * "Re-extrair dados" button. The publish is a second best-effort
   * call; if it fails, `handleEnriched` won't run but the doc stays
   * at ENRICHING with `enrichmentError` recorded on the Party row.
   */
  private async runEnrichment(evt: DocumentExtractedEvent): Promise<void> {
    if (!this.enrichment) {
      this.logger.debug(
        `[runEnrichment] no EnrichmentService wired — skipping auto-enrich`,
      );
    } else {
      try {
        // Look up the doc to find its partyId + customerId.
        // Re-read after the EXTRACTING → ENRICHING transition.
        const doc = await this.readDocWithParties(
          evt.documentId,
          evt.tenantId,
        );
        if (!doc) return;

        if (doc.partyId) {
          await this.enrichment.enrichParty(
            evt.tenantId,
            doc.partyId,
            evt.userId,
          );
        } else {
          this.logger.warn(
            `[runEnrichment] doc=${evt.documentId} has no supplier partyId — skipping supplier enrich`,
          );
        }

        // Customer enrichment: name-match a Party in the tenant and
        // enrich it if it isn't the tenant itself. Best-effort, see
        // `enrichCustomerIfKnown` for the matching heuristic.
        await this.enrichCustomerIfKnown(evt, doc.customer ?? null);
      } catch (err) {
        this.logger.warn(
          `[runEnrichment] enrichment chain failed for doc=${evt.documentId}: ` +
            `${(err as Error).message}`,
        );
        // Fall through to publish document.enriched so the pipeline
        // can advance — ENRICHING state is not sticky.
      }
    }

    // ALWAYS publish document.enriched so handleEnriched can run.
    try {
      await this.queue.publish('document.enriched', {
        topic: 'document.enriched',
        documentId: evt.documentId,
        tenantId: evt.tenantId,
        userId: evt.userId,
        partyId: null,
        partyMatched: false,
        ibanUpdated: false,
        ibanRiskScore: 0,
      });
    } catch (err) {
      this.logger.error(
        `[runEnrichment] document.enriched publish FAILED for doc=${evt.documentId}: ` +
          `${(err as Error).message}`,
      );
    }
  }

  /**
   * Minimal doc read for the enrichment leg. Avoids dragging the
   * full Prisma model shape through the pipeline — we only need
   * partyId + customer string (and would need customerId FK once
   * Sprint G.1 lands).
   */
  private async readDocWithParties(
    documentId: string,
    tenantId: string,
  ): Promise<
    | { id: string; partyId: string | null; customer: string | null }
    | null
  > {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const doc = await (this.prisma as any).document.findFirst({
        where: { id: documentId, tenantId },
        select: { id: true, partyId: true, customer: true },
      });
      return doc;
    } catch (err) {
      this.logger.warn(
        `[readDocWithParties] doc=${documentId}: ${(err as Error).message}`,
      );
      return null;
    }
  }

  /**
   * Sprint I — customer enrichment (best-effort).
   *
   * The Document model doesn't yet have a customerId FK (Sprint G.1
   * will add it). For now we match on the `customer` free-text name
   * to a Party in the same tenant. If we find a match AND the
   * customer isn't the tenant itself, we enrich that party too.
   *
   * We do NOT create new Parties here — that's the supplier-resolver's
   * job, and creating a Party from a free-text customer name without
   * NIF would be ambiguous. Sprint G.1 will lift this restriction.
   */
  private async enrichCustomerIfKnown(
    evt: { tenantId: string; userId: string },
    customerName: string | null,
  ): Promise<void> {
    if (!this.enrichment || !customerName || customerName.trim().length === 0) {
      return;
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tenant: { name: string | null } | null = await (this.prisma as any).tenant?.findFirst?.({
        where: { id: evt.tenantId },
        select: { name: true },
      });
      const customerTrimmed = customerName.trim().toLowerCase();
      if (
        tenant?.name &&
        tenant.name.trim().toLowerCase() === customerTrimmed
      ) {
        this.logger.debug(
          `[enrichCustomerIfKnown] customer matches tenant.name — skip`,
        );
        return;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const match: { id: string } | null = await (this.prisma as any).party.findFirst({
        where: {
          tenantId: evt.tenantId,
          name: { equals: customerName.trim(), mode: 'insensitive' },
        },
        select: { id: true },
      });
      if (match) {
        this.logger.log(
          `[enrichCustomerIfKnown] enriching customer party=${match.id} for tenant=${evt.tenantId}`,
        );
        await this.enrichment.enrichParty(evt.tenantId, match.id, evt.userId);
      } else {
        this.logger.debug(
          `[enrichCustomerIfKnown] no Party matches customer name "${customerName}" — skipping`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `[enrichCustomerIfKnown] customer enrichment failed: ${(err as Error).message}`,
      );
    }
  }

  /**
   * ENRICHING → ROUTING.
   *
   * When `tenant.settings.autoApprove === true` AND `partyId` is
   * present we call `documents.approve()`. Failure of the approve
   * call is captured and surfaced via SSE (we still advance the
   * pipeline) — it must not poison the pipeline.
   */
  async handleEnriched(evt: DocumentEnrichedEvent): Promise<void> {
    await this.tryHandler(async () => {
      const updated = await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${docLockKey(evt.documentId)})`;
        const doc = await tx.document.findFirst({
          where: { id: evt.documentId, tenantId: evt.tenantId },
        });
        if (!doc) return false;
        if (
          doc.processingStatus &&
          doc.processingStatus !== DocumentProcessingStatus.ENRICHING
        ) {
          return false;
        }
        await tx.document.update({
          where: { id: evt.documentId },
          data: {
            processingStatus: DocumentProcessingStatus.ROUTING,
          },
        });
        await this.audit.logInTx(tx as unknown as PrismaClient, {
          tenantId: evt.tenantId,
          userId: evt.userId,
          action: AuditAction.EDIT,
          entityType: 'document',
          entityId: evt.documentId,
          metadata: { subAction: 'processing.stage.advanced', stage: 'ROUTING' },
        });
        return true;
      });
      if (!updated) return;

      // Auto-approve gate — only fires when BOTH conditions hold:
      //   1. tenant.settings.autoApprove === true
      //   2. the doc has a partyId linked (we refuse to auto-approve
      //      a document we can't attribute to a counterparty)
      // The doc is the source of truth — the event's partyId field
      // is informational only.
      // A failure here is captured and logged but never re-thrown;
      // we still emit the SSE event so the UI keeps moving.
      const settings = await this.readTenantSettings(evt.documentId, evt.tenantId);
      const docPartyId = await this.readDocPartyId(evt.documentId, evt.tenantId);
      const autoApprove = settings?.autoApprove === true;
      let approveError: string | null = null;
      if (autoApprove && docPartyId) {
        try {
          await this.documents.approve(evt.tenantId, evt.userId, evt.documentId);
          // H-10: separate audit row so forensic tools can grep for
          // 'processing.auto_approved' without sifting through the
          // stage.advanced rows.
          await this.audit.log({
            tenantId: evt.tenantId,
            userId: evt.userId,
            action: AuditAction.EDIT,
            entityType: 'document',
            entityId: evt.documentId,
            metadata: { subAction: 'processing.auto_approved' },
          });
        } catch (err) {
          approveError = err instanceof Error ? err.message : String(err);
          this.logger.warn(
            `[handleEnriched] approve failed for doc=${evt.documentId}: ${approveError}`,
          );
        }
      }

      this.events.emit({
        documentId: evt.documentId,
        tenantId: evt.tenantId,
        stage: 'ROUTING',
        event: 'processing.stage.completed',
        payload: {
          stage: 'ROUTING',
          status: 'started',
          completedAt: new Date().toISOString(),
          approved: !approveError && autoApprove && Boolean(docPartyId),
          error: approveError,
        },
      });

      // The ROUTING stage is only complete after the terminal transition
      // has been persisted by handleRouted. Publishing this event here is
      // required for both queue-backed and in-process adapters; emitting
      // the SSE progress event alone leaves documents stuck in ROUTING.
      await this.queue.publish('document.routed', {
        topic: 'document.routed',
        documentId: evt.documentId,
        tenantId: evt.tenantId,
        userId: evt.userId,
        approved: !approveError && autoApprove && Boolean(docPartyId),
        newFileKey: null,
        partyId: docPartyId,
        completedAt: new Date().toISOString(),
      } satisfies DocumentRoutedEvent & { topic: string });
    }, evt, 'ROUTING');
  }

  /**
   * ROUTING → COMPLETED. Terminal — the SSE Subject is closed by
   * ProcessingEventsStore on receipt of `processing.completed`.
   *
   * H-8: if a duplicate `document.routed` event lands when the doc
   * is already at COMPLETED, we STILL emit the terminal SSE event so
   * late subscribers see the pipeline finish.
   */
  async handleRouted(evt: DocumentRoutedEvent): Promise<void> {
    await this.tryHandler(async () => {
      const updated = await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${docLockKey(evt.documentId)})`;
        const doc = await tx.document.findFirst({
          where: { id: evt.documentId, tenantId: evt.tenantId },
        });
        if (!doc) return false;
        if (
          doc.processingStatus &&
          doc.processingStatus !== DocumentProcessingStatus.ROUTING
        ) {
          // H-8: late event for an already-COMPLETED doc — we still
          // want the SSE stream to receive the terminal event so
          // subscribers that connected late know the doc is done.
          return 'duplicate-terminal';
        }
        await tx.document.update({
          where: { id: evt.documentId },
          data: {
            processingStatus: DocumentProcessingStatus.COMPLETED,
            processingCompletedAt: new Date(),
            processingError: null,
          },
        });
        await this.audit.logInTx(tx as unknown as PrismaClient, {
          tenantId: evt.tenantId,
          userId: evt.userId,
          action: AuditAction.EDIT,
          entityType: 'document',
          entityId: evt.documentId,
          metadata: { subAction: 'processing.completed', stage: 'COMPLETED' },
        });
        return true;
      });
      if (updated === true) {
        this.events.emit({
          documentId: evt.documentId,
          tenantId: evt.tenantId,
          stage: 'COMPLETED',
          event: 'processing.completed',
          payload: {
            stage: 'COMPLETED',
            status: 'completed',
            completedAt: evt.completedAt,
          },
        });
      } else if (updated === 'duplicate-terminal') {
        // Late subscriber still needs to see the pipeline finish.
        this.events.emit({
          documentId: evt.documentId,
          tenantId: evt.tenantId,
          stage: 'COMPLETED',
          event: 'processing.completed',
          payload: {
            stage: 'COMPLETED',
            status: 'completed',
            completedAt: evt.completedAt,
            replay: true,
          },
        });
      }
    }, evt, 'COMPLETED');
  }

  // ============================================================ internals

  /**
   * Topic → handler dispatch. The subscribeBatch binding on
   * constructor funnels every published event here.
   */
  private async dispatch(topic: (typeof TOPICS)[number], payload: unknown): Promise<void> {
    if (!payload || typeof payload !== 'object') return;
    const evt = payload as Record<string, unknown>;
    switch (topic) {
      case 'document.uploaded':
        await this.handleReceived(evt as unknown as DocumentUploadedEvent);
        break;
      case 'document.extracted':
        await this.handleExtracted(evt as unknown as DocumentExtractedEvent);
        break;
      case 'document.enriched':
        await this.handleEnriched(evt as unknown as DocumentEnrichedEvent);
        break;
      case 'document.routed':
        await this.handleRouted(evt as unknown as DocumentRoutedEvent);
        break;
      default:
        // Other topics may be published later — silently ignore.
        break;
    }
  }

  /**
   * Wraps a handler in try/catch. On failure: marks the doc FAILED
   * with the error message, writes an audit row, and emits
   * `processing.failed` so the SSE controller can close cleanly.
   *
   * The FAILED update + audit row are bundled in a single Prisma
   * transaction so an observer never sees a FAILED doc without its
   * audit row (or vice-versa). AuditService.logInTx is the in-tx
   * variant we use here.
   */
  private async tryHandler(
    work: () => Promise<void>,
    evt: { documentId: string; tenantId: string; userId: string },
    stage: string,
  ): Promise<void> {
    try {
      await work();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const truncated = message.slice(0, 500);
      this.logger.error(
        `[tryHandler] stage=${stage} doc=${evt.documentId} failed: ${message}`,
        err instanceof Error ? err.stack : undefined,
      );
      // FAILED update + audit row, in one txn. If the txn itself
      // throws we fall back to a best-effort outside-the-txn write
      // so we never leave the pipeline wedged.
      try {
        await this.prisma.$transaction(async (tx) => {
          await tx.document.update({
            where: { id: evt.documentId },
            data: {
              processingStatus: DocumentProcessingStatus.FAILED,
              processingError: truncated,
            },
          });
          await this.audit.logInTx(tx as unknown as PrismaClient, {
            tenantId: evt.tenantId,
            userId: evt.userId,
            action: AuditAction.EDIT,
            entityType: 'document',
            entityId: evt.documentId,
            metadata: {
              subAction: 'processing.failed',
              error: truncated,
              stage,
            },
          });
        });
      } catch (txErr) {
        this.logger.error(
          `[tryHandler] FAILED txn also failed for doc=${evt.documentId}: ${txErr instanceof Error ? txErr.message : String(txErr)}`,
        );
      }
      this.events.emit({
        documentId: evt.documentId,
        tenantId: evt.tenantId,
        stage: 'FAILED',
        event: 'processing.failed',
        payload: {
          stage: 'FAILED',
          status: 'failed',
          completedAt: new Date().toISOString(),
          error: truncated,
        },
      });
    }
  }

  /**
   * Re-read the doc to pick up `tenant.settings` after the txn
   * that advanced the pipeline. Kept simple — single SELECT, no
   * caching. `tenantId` is required so a forged event can't leak
   * another tenant's settings (H-6).
   */
  private async readTenantSettings(
    documentId: string,
    tenantId: string,
  ): Promise<TenantSettingsShape | null> {
    try {
      const doc = await this.prisma.document.findFirst({
        where: { id: documentId, tenantId },
        include: { tenant: { select: { settings: true } } },
      });
      const tenant = (doc as unknown as { tenant?: { settings: TenantSettingsShape | null } | null } | null)?.tenant;
      return tenant?.settings ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Re-read the doc to pick up `partyId` after the txn. The auto-
   * approve gate wants the persisted value, not the event payload,
   * because the doc is the source of truth.
   */
  private async readDocPartyId(
    documentId: string,
    tenantId: string,
  ): Promise<string | null> {
    try {
      const doc = await this.prisma.document.findFirst({
        where: { id: documentId, tenantId },
      });
      return doc?.partyId ?? null;
    } catch {
      return null;
    }
  }
}
