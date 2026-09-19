import { Module } from '@nestjs/common';
import { IntegrationsController } from './integrations.controller';
import { IntegrationsService } from './integrations.service';
import { OAuthStateStore } from './core/oauth-state.store';
import { WooProvider } from './providers/woo.provider';

/**
 * IntegrationsModule — provider-agnostic core + per-provider adapters.
 *
 *   - IntegrationsService: encrypted credential storage, OAuth state
 *     lifecycle, list/configure/test endpoints.
 *   - OAuthStateStore: Prisma-backed state for OAuth2 PKCE flows
 *     (survives restarts, shared across replicas).
 *   - WooProvider: WooCommerce-specific mapping (orders → Document + Party).
 *
 * The module is kept lean; future providers (Sage, QuickBooks, Moloni)
 * plug in the same way: a `providers/<name>.provider.ts` + a route on
 * the controller that delegates to the service.
 */
@Module({
  controllers: [IntegrationsController],
  providers: [IntegrationsService, OAuthStateStore, WooProvider],
  // OAuthStateStore must be re-exported so that sibling modules (e.g.
  // EmailInboundModule, which receives GmailService) can inject it through
  // the IntegrationsModule DI boundary. Without this export NestJS raises
  // "Nest can't resolve dependencies of the GmailService" at boot because
  // the provider is module-private.
  exports: [IntegrationsService, OAuthStateStore],
})
export class IntegrationsModule {}