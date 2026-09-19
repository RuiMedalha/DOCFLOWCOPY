import { Injectable, type ExecutionContext } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Request } from 'express';
import { getTenantContext } from '../context/tenant-context';

/**
 * Custom ThrottlerGuard that picks the rate-limit tracker based on the
 * current request:
 *
 *   - @Public() routes (no tenant context yet)        → key by IP
 *   - authenticated routes (tenant context present)   → key by tenantId
 *   - if no tenant context AND we want user-scoped    → fall back to IP
 *
 * The actual per-route window/limit is set in @Throttle({ name: 'login' })
 * etc. — those names map to buckets declared in app.module.ts.
 *
 * Why custom?
 *   - The default ThrottlerGuard always keys by IP. For /extraction we
 *     want per-tenant accounting (one tenant's burst shouldn't lock out
 *     another), and for /exports we want per-user accounting.
 *   - We keep the IP-keyed behaviour as the fallback for public routes.
 */
@Injectable()
export class ThrottleBucketGuard extends ThrottlerGuard {
  /**
   * Skip rate-limiting entirely outside production. Local UAT, demos and the
   * frontend dev server issue many rapid requests (HMR, React Query refetch,
   * repeated logins) that legitimately trip production-grade limits and lock
   * the developer out for the full window. In production the configured
   * buckets (global / login / extract / export) apply as normal.
   */
  protected async shouldSkip(context: ExecutionContext): Promise<boolean> {
      if (process.env.NODE_ENV !== 'production') return true;
      const req = context.switchToHttp().getRequest<Request>();
      const path = req?.originalUrl ?? req?.url ?? '';
      return path.startsWith('/api/v1/health');
  }

  protected async getTracker(req: Record<string, unknown>): Promise<string> {
    const ctx = getTenantContext();
    if (ctx?.tenantId) {
      return `tenant:${ctx.tenantId}`;
    }
    if (ctx?.userId) {
      return `user:${ctx.userId}`;
    }
    // Fall back to IP (set by express trust-proxy, see main.ts).
    const expressReq = req as unknown as Request;
    return `ip:${expressReq.ip ?? 'unknown'}`;
  }
}
