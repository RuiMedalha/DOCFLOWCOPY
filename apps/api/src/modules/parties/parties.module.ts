import { Module, forwardRef } from '@nestjs/common';
import { PartiesService } from './parties.service';
import { PartiesController } from './parties.controller';
import { DocumentsModule } from '../documents/documents.module';
import { PartyCategoriesModule } from '../party-categories/party-categories.module';
import { PartyContactsController } from './party-contacts.controller';
import { PartyContactsService } from './party-contacts.service';
import { PartyAddressesController } from './party-addresses.controller';
import { PartyAddressesService } from './party-addresses.service';
import { PartyTimelineController } from './timeline/party-timeline.controller';
import { PartyTimelineService } from './timeline/party-timeline.service';
import { PartyPaymentsController } from './payments/party-payments.controller';
import { PartyPaymentsService } from './payments/party-payments.service';
import { PartyImportService } from './party-import.service';
import { PartyProductsService } from './party-products.service';
import { PartyMergeService } from './party-merge.service';

/**
 * PartiesModule — supplier/customer master + PT chart of accounts + IBAN
 * anti-fraud helpers + Sprint G 360° add-ons (contacts, addresses,
 * timeline, payments).
 *
 * Sprint G nests four additional sub-resources under `/parties/:id`:
 *   - PartyContactsController       (CRUD on named contacts)
 *   - PartyAddressesController      (CRUD on multi-type addresses)
 *   - PartyPaymentsController       (read-only JOIN through Document.partyId)
 *   - PartyTimelineController       (read-only aggregator across 4 sources)
 *
 * Each ships its own service + controller and lives in its own folder
 * under `parties/` to keep file paths clean. They share the same
 * `PrismaService` + `AuditService` injections — both are global, so
 * there's no need to import their modules here.
 *
 * AuditModule is GLOBAL so we don't need to import it here — `AuditService`
 * is resolvable from anywhere in the DI tree. PrismaModule is the same.
 *
 * DocumentsModule is imported via `forwardRef` to break the circular
 * dependency (DocumentsModule also depends on PartiesService for the
 * supplier assignment path). The PartiesController reaches into
 * DocumentsService directly for the GET /parties/:id/documents read,
 * keeping the documents query logic inside the documents module.
 *
 * Exports PartiesService so other modules (Documents when assigning a
 * supplier, Extraction when matching a NIF, etc.) can reach into it.
 */
@Module({
  imports: [forwardRef(() => DocumentsModule), PartyCategoriesModule],
  controllers: [
    PartiesController,
    PartyContactsController,
    PartyAddressesController,
    PartyTimelineController,
    PartyPaymentsController,
  ],
  providers: [
    PartiesService,
    PartyContactsService,
    PartyAddressesService,
    PartyTimelineService,
    PartyPaymentsService,
    PartyImportService,
    PartyProductsService,
    PartyMergeService,
  ],
  exports: [
    PartiesService,
    PartyContactsService,
    PartyAddressesService,
    PartyTimelineService,
    PartyPaymentsService,
    PartyMergeService,
  ],
})
export class PartiesModule {}
