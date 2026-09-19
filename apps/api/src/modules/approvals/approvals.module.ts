import { Module } from '@nestjs/common';
import { ApprovalsController } from './approvals.controller';
import { ApprovalsService } from './approvals.service';
import { AuditModule } from '../audit/audit.module';

/**
 * ApprovalsModule — Sprint 1.B invoice-approval workflow.
 *
 * Imports `AuditModule` so the service can write the
 * forensic trail rows that the controller's NestJS RBAC
 * guard runs alongside. Exports `ApprovalsService` so the
 * sidebar badge component / detail page can call into the
 * same code path without re-implementing the join shape.
 */
@Module({
  imports: [AuditModule],
  controllers: [ApprovalsController],
  providers: [ApprovalsService],
  exports: [ApprovalsService],
})
export class ApprovalsModule {}
