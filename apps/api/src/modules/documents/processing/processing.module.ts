import { forwardRef, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { DocumentsModule } from '../documents.module';
import { QueueModule } from '../../../common/queue/queue.module';
import { EnrichmentModule } from '../../enrichment/enrichment.module';
import { ProcessingService } from './processing.service';
import { ProcessingEventsStore } from './processing-events-store.service';
import { ProcessingController } from './processing.controller';

/**
 * ProcessingModule — wires the 4-stage pipeline.
 *
 *   - ProcessingService subscribes to `document.uploaded` / `.extracted`
 *     / `.enriched` / `.routed` on the QueueAdapter and drives each
 *     stage transition.
 *   - ProcessingEventsStore is the in-memory broadcaster consumed by
 *     the SSE controller.
 *   - ProcessingController exposes `GET /documents/:id/processing/stream`
 *     with @Throttle + per-doc cap + 20s keepalive.
 *
 * Sprint I — EnrichmentModule is imported so ProcessingService can
 * fire `enrichment.enrichParty` from inside `handleExtracted` and
 * publish `document.enriched` when the outer chain finishes.
 *
 * DocumentsModule is imported via forwardRef because both sides
 * reference each other (DocumentsService.approve ↔ ProcessingService).
 * In practice the cycle is mediated by the queue — the pipeline
 * publishes events back through the QueueAdapter, never by calling
 * DocumentsService methods on the same call stack — but the type
 * graph needs both sides.
 *
 * JwtModule is imported (not made global) so the SSE controller can
 * verify the `?token=` query-param fallback (security-audit H-3)
 * without depending on the global module configuration.
 */
@Module({
  imports: [
    QueueModule,
    JwtModule.register({}), // controllers pull secret from config when verifying
    forwardRef(() => DocumentsModule),
    EnrichmentModule,
  ],
  controllers: [ProcessingController],
  providers: [ProcessingService, ProcessingEventsStore],
  exports: [ProcessingService, ProcessingEventsStore],
})
export class ProcessingModule {}
