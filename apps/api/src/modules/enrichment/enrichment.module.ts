import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EnrichmentService } from './enrichment.service';
import { EnrichmentController } from './enrichment.controller';
import { SabiPtProvider } from './providers/sabi-pt.provider';
import { ViesProvider } from './providers/vies.provider';
import { ManualProvider } from './providers/manual.provider';
import { EnrichmentProviderFactory } from './providers/provider.factory';
import { NifLookupModule } from '../nif-lookup/nif-lookup.module';

/**
 * EnrichmentModule — Sprint I.
 *
 * Provides party enrichment via external APIs (Sabi PT for Portuguese
 * suppliers, VIES for EU VAT numbers, ManualProvider fallback for
 * extra-EU). Wires the provider chain, the service that orchestrates
 * the 30-day TTL cache + only-fill-nulls semantic, and the controller
 * exposing `POST /parties/:id/enrich` (manual trigger from the UI).
 */
@Module({
  imports: [ConfigModule, NifLookupModule],
  controllers: [EnrichmentController],
  providers: [
    SabiPtProvider,
    ViesProvider,
    ManualProvider,
    EnrichmentProviderFactory,
    EnrichmentService,
  ],
  exports: [EnrichmentService, EnrichmentProviderFactory, ViesProvider],
})
export class EnrichmentModule {}
