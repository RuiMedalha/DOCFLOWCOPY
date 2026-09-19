import { Module, forwardRef } from '@nestjs/common';
import { DocumentsController } from './documents.controller';
import { SupplierController } from './supplier.controller';
import { DocumentsService } from './documents.service';
import { FolderRulesEngine } from './folder-rules/folder-rules.engine';
import { StorageModule } from './storage/storage.module';
import { ExtractionModule } from '../extraction/extraction.module';
import { ImageToPdfService } from './image-to-pdf/image-to-pdf.service';
import { ArchiveImageService } from './image-to-pdf/archive-image.service';
import { OcrmypdfService } from '../extraction/ocrmypdf.service';
import { ImageEnhancerService } from '../extraction/image-enhancer.service';
import { DocumentImagePipelineService } from './image-pipeline/document-image-pipeline.service';
import { NifLookupModule } from '../nif-lookup/nif-lookup.module';
import { EmailInboundModule } from '../email-inbound/email-inbound.module';

/**
 * DocumentsModule — inbox + folder-rules + storage.
 *
 * Exports DocumentsService and FolderRulesEngine so other modules (CRM,
 * Banking, Reconciliation) can query/update documents without reaching
 * into this module's controllers.
 *
 * StorageModule is imported (NOT made global) so the storage token only
 * resolves inside the documents surface; if S3/MinIO is added later the
 * dependency stays localised.
 *
 * ExtractionModule is imported via forwardRef (it is also `@Global()`,
 * but an explicit import guarantees the injection order is correct AND
 * lets ExtractionService use FolderRulesEngine for AI-driven
 * auto-filing. Both modules reference each other, hence the cycle
 * break).
 *
 * SupplierController is registered alongside DocumentsController so
 * the supplier re-extract / strict-update routes can evolve without
 * touching the legacy DocumentsController. Mounted at the same
 * `/documents` prefix.
 */
@Module({
  imports: [
    StorageModule,
    forwardRef(() => ExtractionModule),
    forwardRef(() => EmailInboundModule),
    // Sprint 1.C — supplier re-extract enriches with the
    // Portal das Finanças base when the AI left fields at
    // low confidence. The import is forward-safe: NifLookupModule
    // does not import DocumentsModule.
    NifLookupModule,
  ],
  controllers: [DocumentsController, SupplierController],
  providers: [DocumentsService, FolderRulesEngine, ImageToPdfService, ArchiveImageService, OcrmypdfService, ImageEnhancerService, DocumentImagePipelineService],
  exports: [DocumentsService, FolderRulesEngine, ImageToPdfService, ArchiveImageService, OcrmypdfService, ImageEnhancerService, DocumentImagePipelineService],
})
export class DocumentsModule {}