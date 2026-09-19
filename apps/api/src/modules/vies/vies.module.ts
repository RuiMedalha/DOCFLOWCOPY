import { Global, Module } from '@nestjs/common';
import { ViesService } from './vies.service';

/** Fase 4 — global so ExtractionService and PartiesService share one cache. */
@Global()
@Module({
  providers: [ViesService],
  exports: [ViesService],
})
export class ViesModule {}
