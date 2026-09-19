import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { TenantsService } from './tenants.service';
import { TenantsController } from './tenants.controller';

/**
 * Sprint H — Tenants module.
 *
 * Wires the (currently minimal) tenant settings surface. Future Sprint
 * H+/I work — retention policies, AI-extraction budgets, branding —
 * will land here as additional endpoints / services in this module.
 *
 * PrismaModule is registered as `@Global()` in app.module.ts, but we
 * still import it explicitly here so the DI graph stays self-describing
 * and a future move away from `@Global()` doesn't break this module.
 *
 * AuthModule is imported (not made global) so the `@CurrentUser()`
 * decorator (which resolves from the JwtGuard-bound request) works
 * inside the controller.
 */
@Module({
  imports: [PrismaModule, AuditModule, AuthModule],
  controllers: [TenantsController],
  providers: [TenantsService],
  exports: [TenantsService],
})
export class TenantsModule {}
