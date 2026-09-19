import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { ThrottleBucketGuard } from './common/throttle/throttle-bucket.guard';
import { ScheduleModule } from '@nestjs/schedule';
import { BullModule } from '@nestjs/bullmq';
import { APP_GUARD, APP_INTERCEPTOR, APP_FILTER } from '@nestjs/core';
import IORedis from 'ioredis';
import { RedisConnection, createIORedisClient } from 'bullmq';

// Prisma
import { PrismaModule } from './prisma/prisma.module';

// Common (guards, interceptors, filters, decorators, middleware)
import { CommonModule } from './common/common.module';
import { TenantMiddlewareModule } from './common/middleware/tenant.middleware.module';
import { JwtGuard } from './common/guards/jwt.guard';
import { TenantGuard } from './common/guards/tenant.guard';
import { RbacGuard } from './common/guards/rbac.guard';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import {
  LoggingInterceptor,
  TenantInterceptor,
  TransformInterceptor,
} from './common/interceptors';

// Feature modules
import { AuthModule } from './modules/auth/auth.module';
import { DocumentsModule } from './modules/documents/documents.module';
import { CategoriesModule } from './modules/documents/categories.module';
import { AiModule } from './modules/ai/ai.module';
import { InboundModule } from './modules/inbound/inbound.module';
import { ScannerModule } from './modules/scanner/scanner.module';
import { EmailInboundModule } from './modules/email-inbound/email-inbound.module';
import { AuditModule } from './modules/audit/audit.module';
import { ApprovalsModule } from './modules/approvals/approvals.module';
import { SaftExportModule } from './modules/saft-export/saft-export.module';
import { NifLookupModule } from './modules/nif-lookup/nif-lookup.module';
import { ExtractionModule } from './modules/extraction/extraction.module';
import { PartiesModule } from './modules/parties/parties.module';
import { PartyCategoriesModule } from './modules/party-categories/party-categories.module';
import { IntegrationsModule } from './modules/integrations/integrations.module';
import { ReconciliationModule } from './modules/reconciliation/reconciliation.module';
import { BankingModule } from './modules/banking/banking.module';
import { CrmModule } from './modules/crm/crm.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { PayrollModule } from './modules/payroll/payroll.module';
import { FleetModule } from './modules/fleet/fleet.module';
import { TaxSimulatorModule } from './modules/tax-simulator/tax-simulator.module';
import { HealthModule } from './modules/health/health.module';
import { ViesModule } from './modules/vies/vies.module';
import { FxModule } from './common/fx/ecb-fx.service';
// Sprint H — async processing pipeline.
import { ProcessingModule } from './modules/documents/processing/processing.module';
import { TenantsModule } from './modules/tenants/tenants.module';
// Sprint I — external-API enrichment (Sabi PT / VIES / manual).
import { EnrichmentModule } from './modules/enrichment/enrichment.module';
// Static chart-of-accounts stub for the document detail debit/credit dropdowns.
import { AccountingModule } from './modules/accounting/accounting.module';
// QueueModule is global-with-factory; we MUST call .forRoot() here so
// ProcessingService can resolve the QueueAdapter at construction time.
import { QueueModule } from './common/queue/queue.module';
// Sprint H+ fix-up — filesystem tree browser for the /storage UI page.
import { StorageBrowseModule } from './modules/storage/storage.module';

@Module({
  imports: [
    // Config & infra
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', '../../.env'],
    }),
    // ThrottlerModule disabled to eliminate 429s in production/staging environments
    // ThrottlerModule.forRoot([...]),
    ScheduleModule.forRoot(),
    BullModule.forRootAsync({
      useFactory: () => {
        const host = process.env.REDIS_HOST || 'localhost';
        const port = parseInt(process.env.REDIS_PORT || '6379', 10);
        // BullMQ >=6 lazy-loads ioredis from CJS contexts; on this Windows box
        // that fails because the dynamic import lands in an ESM-only resolution
        // path. Pre-install a clientFactory that hands BullMQ our already
        // resolved ioredis instance, wrapped with createIORedisClient so the
        // client exposes runCommand (Lua dispatch) per the IRedisClient contract.
        RedisConnection.clientFactory = ((opts: Record<string, unknown>) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return createIORedisClient(
            new IORedis({
              ...opts,
              lazyConnect: true,
              maxRetriesPerRequest: null,
            }),
          ) as any;
        }) as any;
        return {
          connection: {
            host,
            port,
            lazyConnect: true,
            maxRetriesPerRequest: null,
          },
        };
      },
    }),

    // Core
    PrismaModule,
    CommonModule,
    TenantMiddlewareModule,

    // Features
    AuthModule,
    DocumentsModule,
    CategoriesModule,
    AiModule,
    InboundModule,
    ScannerModule,
    EmailInboundModule,
    ExtractionModule,
    ReconciliationModule,
    AuditModule,
    ApprovalsModule,
    SaftExportModule,
    NifLookupModule,
    BankingModule,
    PartiesModule,
    PartyCategoriesModule,
    IntegrationsModule,
    CrmModule,
    PaymentsModule,
    PayrollModule,
    FleetModule,
    TaxSimulatorModule,
    HealthModule,
    ViesModule,
    FxModule,
    // Sprint H — wire the queue + the processing pipeline. QueueModule
    // is `global: true` after .forRoot() so any module that injects
    // QueueAdapter can find it. ProcessingModule owns the SSE controller.
    QueueModule.forRoot(),
    ProcessingModule,
    TenantsModule,
    EnrichmentModule,
    AccountingModule,
    StorageBrowseModule,
  ],
  providers: [
    // Global rate-limit guard disabled to completely prevent 429 errors in production
    // { provide: APP_GUARD, useClass: ThrottleBucketGuard },
    // Auth stack: JWT → Tenant → RBAC. Order matters.
    { provide: APP_GUARD, useClass: JwtGuard },
    { provide: APP_GUARD, useClass: TenantGuard },
    { provide: APP_GUARD, useClass: RbacGuard },
    // Global response/error pipeline.
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: LoggingInterceptor },
    { provide: APP_INTERCEPTOR, useClass: TenantInterceptor },
    { provide: APP_INTERCEPTOR, useClass: TransformInterceptor },
  ],
})
export class AppModule {}
