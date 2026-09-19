import {
  Module,
  Logger,
  Global,
  forwardRef,
} from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { PrismaModule } from '../../prisma/prisma.module';
import { StorageModule } from '../documents/storage/storage.module';
import { AiModule } from '../ai/ai.module';
import { DocumentsModule } from '../documents/documents.module';
import { ExtractionController } from './extraction.controller';
import { ExtractionProcessor } from './extraction.processor';
import { ExtractionService } from './extraction.service';
import { SupplierResolver } from './supplier-resolver';
// Fase 4.1 — providos aqui directamente (são folhas, sem dependências
// próprias) para o ExtractionService os receber mesmo com o forwardRef
// do DocumentsModule pelo meio.
import { ImageToPdfService } from '../documents/image-to-pdf/image-to-pdf.service';
import { ArchiveImageService } from '../documents/image-to-pdf/archive-image.service';
import { OcrmypdfService } from './ocrmypdf.service';
import { ImageEnhancerService } from './image-enhancer.service';
import { EXTRACTION_QUEUE, EXTRACTION_QUEUE_OPTIONS } from './extraction.constants';
import { QueueModule } from '../../common/queue/queue.module';
import { NifLookupModule } from '../nif-lookup/nif-lookup.module';
import { EnrichmentModule } from '../enrichment/enrichment.module';
import { PartiesModule } from '../parties/parties.module';

/**
 * ExtractionModule — owns the AT-QR decode + OCR + IBAN anti-fraud flow.
 *
 * Design choices:
 *   - BullMQ is OPTIONAL. We register the queue+worker only when Redis
 *     is reachable; otherwise ExtractionService falls back to in-process
 *     execution so the API still works for one-off uploads. The
 *     producer-side `Queue` is `@Optional()` and tolerates `null`.
 *   - StorageModule is imported so the service can pull document bytes
 *     for OCR. We bind the storage port under a string token to keep
 *     the dependency loose (the storage module exports its own symbol).
 *   - PrismaModule is global — no need to re-import for tenant scoping.
 *   - DocumentsModule is imported via forwardRef so ExtractionService
 *     can call FolderRulesEngine to auto-file a well-read invoice into
 *     the right accounting folder when the AI supplied an SNC category.
 *     DocumentsModule also imports ExtractionModule (it triggers
 *     extraction on upload); forwardRef resolves the cycle.
 *
 * The auto-trigger hook is exported as `ExtractionService` and consumed
 * by the inbound/documents modules on successful Document creation.
 */
@Global()
@Module({
  imports: [
    PrismaModule,
    StorageModule,
    AiModule,
    NifLookupModule,
    EnrichmentModule,
    // QueueModule.forRoot() returns a DynamicModule with `global: true`,
    // so the QUEUE_ADAPTER provider is reachable from any module in the
    // app — including ExtractionService, which @Injects the symbol to
    // publish `document.extracted` at the end of a successful
    // processDocumentAsync. We import it here explicitly so that the
    // extraction pipeline can publish pipeline events regardless of the
    // order in which app.module.ts composes the feature modules, and
    // so this module's wiring is self-contained — an operator reading
    // extraction.module.ts can see all of its dependencies at a glance.
    QueueModule.forRoot(),
    forwardRef(() => DocumentsModule),
    forwardRef(() => PartiesModule),
    BullModule.registerQueueAsync({
      name: EXTRACTION_QUEUE,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const host = config.get<string>('REDIS_HOST') ?? 'localhost';
        const port = parseInt(config.get<string>('REDIS_PORT') ?? '6379', 10);
        // lazyConnect + maxRetriesPerRequest:null keeps the worker
        // alive when Redis is down at boot. Failures come back as
        // `Error: ECONNREFUSED` from `queue.add()` — the service
        // catches them and runs sync.
        return {
          connection: { host, port, lazyConnect: true, maxRetriesPerRequest: null },
          defaultJobOptions: {
            attempts: EXTRACTION_QUEUE_OPTIONS.attempts,
            backoff: { type: 'exponential', delay: EXTRACTION_QUEUE_OPTIONS.backoffMs },
            removeOnComplete: 200,
            removeOnFail: 200,
          },
        };
      },
    }),
  ],
  controllers: [ExtractionController],
  providers: [ExtractionService, ExtractionProcessor, SupplierResolver, ImageToPdfService, ArchiveImageService, OcrmypdfService, ImageEnhancerService],
  exports: [ExtractionService, SupplierResolver, BullModule, OcrmypdfService, ImageEnhancerService],
})
export class ExtractionModule {
  private readonly logger = new Logger(ExtractionModule.name);

  constructor() {
    this.logger.log(
      'ExtractionModule loaded — AT-QR + OCR + IBAN anti-fraud active ' +
        '(BullMQ background worker active when Redis is reachable)',
    );
  }
}
