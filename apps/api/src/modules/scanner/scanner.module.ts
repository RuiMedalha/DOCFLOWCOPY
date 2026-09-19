import { Module, forwardRef } from '@nestjs/common';
import { InboundModule } from '../inbound/inbound.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { ScannerController } from './scanner.controller';
import { ScannerService } from './scanner.service';

/**
 * ScannerModule — file-watcher service that turns filesystem drops into
 * `Document` rows through the existing inbound pipeline.
 *
 * The forwardRef dance around `InboundModule` is required because both
 * modules depend on each other through `DocumentsModule`. `InboundService`
 * exposes `ingestFiles()` as a thin wrapper over `createFromInbound`,
 * which lives in `DocumentsService`; the dependency graph is already
 * handled by Nest's circular resolution in the existing wiring.
 */
@Module({
  imports: [PrismaModule, forwardRef(() => InboundModule)],
  controllers: [ScannerController],
  providers: [ScannerService],
  exports: [ScannerService],
})
export class ScannerModule {}
