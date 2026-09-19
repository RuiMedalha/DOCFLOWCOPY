import { Module } from '@nestjs/common';
import { SaftExportController } from './saft-export.controller';
import { SaftExportService } from './saft-export.service';
import { AuditModule } from '../audit/audit.module';

/**
 * SaftExportModule — Sprint 1.C SAF-T PT v1.04_01 exporter.
 *
 * Imports `AuditModule` for the per-export forensic trail.
 * Exports the service so future modules (e.g. the SAF-T
 * obfuscator for test fixtures) can compose against it without
 * a circular import.
 */
@Module({
  imports: [AuditModule],
  controllers: [SaftExportController],
  providers: [SaftExportService],
  exports: [SaftExportService],
})
export class SaftExportModule {}
