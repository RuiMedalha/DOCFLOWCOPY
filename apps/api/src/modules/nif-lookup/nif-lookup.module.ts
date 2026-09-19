import { Module } from '@nestjs/common';
import { NifLookupController } from './nif-lookup.controller';
import { NifLookupService } from './nif-lookup.service';
import { AuditModule } from '../audit/audit.module';

/**
 * NifLookupModule — Sprint 1.C Portal das Finanças integration.
 *
 * Imports `AuditModule` for the per-lookup forensic trail.
 * Exports the service so the supplier re-extract pipeline can
 * call `lookup()` after a `?force=true` re-run to enrich the
 * supplier block with the public-base name/address when the AI
 * extracted those fields with low confidence.
 */
@Module({
  imports: [AuditModule],
  controllers: [NifLookupController],
  providers: [NifLookupService],
  exports: [NifLookupService],
})
export class NifLookupModule {}
