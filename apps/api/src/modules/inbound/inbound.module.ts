import { Module, forwardRef } from '@nestjs/common';
import { StorageModule } from '../documents/storage/storage.module';
import { EmailInboundModule } from '../email-inbound/email-inbound.module';
import { ExtractionModule } from '../extraction/extraction.module';
import { InboundController } from './inbound.controller';
import { InboundService } from './inbound.service';

@Module({
  imports: [
    StorageModule,
    forwardRef(() => EmailInboundModule),
    forwardRef(() => ExtractionModule),
  ],
  controllers: [InboundController],
  providers: [InboundService],
  exports: [InboundService],
})
export class InboundModule {}

