import { Module } from '@nestjs/common';
import { PartyCategoriesController } from './party-categories.controller';
import { PartyCategoriesService } from './party-categories.service';

/**
 * PartyCategoriesModule — Sprint E module for the per-tenant
 * PartyCategory taxonomy. Exports the service so PartiesModule can
 * validate `partyCategoryId` references inside its update flow.
 */
@Module({
  controllers: [PartyCategoriesController],
  providers: [PartyCategoriesService],
  exports: [PartyCategoriesService],
})
export class PartyCategoriesModule {}
