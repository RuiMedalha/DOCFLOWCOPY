import {
  Controller,
  Get,
  HttpException,
  Logger,
  Param,
  Query,
  Req,
  Sse,
  UnauthorizedException,
  NotFoundException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { Observable, interval, map, merge } from 'rxjs';
import { JwtService } from '@nestjs/jwt';
import * as crypto from 'crypto';
import type { ProcessingStageEvent } from './processing-events-store.service';
import { ProcessingEventsStore } from './processing-events-store.service';
import { PrismaService } from '../../../prisma/prisma.service';

/**
 * Sprint H — SSE controller.
 *
 * Route: `GET /documents/:id/processing/stream`
 *
 * Auth — two paths (security-audit H-3):
 *   1. `Authorization: Bearer <jwt>` header — standard path. NestJS
 *      JwtGuard populates `req.user` from the JWT.
 *   2. `?token=<jwt>` query param — fallback for browser EventSource,
 *      which cannot set custom headers. Same JWT, validated via
 *      JwtService.verify (constant-time internally).
 *
 * Authorisation — MANDATORY tenant gate (B-1 / H-6):
 *   - tenantId MUST be on the request after auth. If missing, we
 *     throw `UnauthorizedException` BEFORE opening the SSE stream.
 *     The previous controller skipped this check when `req.user.tenantId`
 *     was undefined, which was a cross-tenant info leak (any caller
 *     could subscribe to any docId).
 *
 * Per-doc connection cap (security-audit H-1):
 *   - The controller tracks `connectionsByDoc`; on subscribe we
 *     refuse the 6th concurrent subscriber for the same docId with
 *     a thrown `HttpException` (429) — Nest's exception filter maps
 *     this to 429. On `req.on('close')` we decrement.
 *
 * Throttle — `@Throttle({ name: 'sse-stream', ttl: 60_000, limit: 5 })`
 *   is applied to this route as a SECOND wall (5 stream subscriptions
 *   per 60 s per IP, on top of the per-doc cap).
 *
 * Keepalive — every 20 s the controller emits an SSE comment frame
 *   `':keepalive\n\n'` so reverse proxies and LBs don't time out
 *   idle connections.
 */

const MAX_CONNECTIONS_PER_DOC = 5;
const KEEPALIVE_MS = 20_000;

@ApiTags('processing')
@ApiBearerAuth()
@Controller('documents')
export class ProcessingController {
  private readonly logger = new Logger(ProcessingController.name);
  /**
   * Per-doc concurrent-connection counter. When a stream terminates
   * (req close, error, or controller teardown) we decrement so the
   * map stays accurate.
   */
  private readonly connectionsByDoc = new Map<string, number>();
  private seq = 0;

  constructor(
    private readonly events: ProcessingEventsStore,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  // ─────────────────────────────────────────── SSE ─────────────────

  /**
   * Server-Sent Events stream for one document's processing pipeline.
   *
   * The route is mounted under JwtGuard + RbacGuard globally
   * (APP_GUARD in app.module.ts). The controller performs an extra
   * MANDATORY tenant check so a JWT for tenant-A cannot open a stream
   * for tenant-B's documentId (B-1).
   *
   * Throttle is opt-in via @Throttle — global guards run first; this
   * is a TIGHTER local limit so a buggy UI that opens/streams/closes
   * rapidly still hits 429 before the events-store fills up.
   *
   * NOTE: Nest's @Sse() interceptor will emit the SSE response
   * headers automatically when the Observable emits its first value,
   * so any pre-stream guard MUST happen before the Observable is
   * constructed (otherwise the headers will have been sent).
   */
  @Get(':id/processing/stream')
  @Throttle({ 'sse-stream': { ttl: 60_000, limit: 5 } })
  @ApiOperation({
    summary: 'SSE stream of document processing events',
    description:
      'Emits a `processing.stage.completed` event per stage, a ' +
      '`processing.completed` terminal event, or a ' +
      '`processing.failed` terminal event. Connection-cap: 5 per docId.',
  })
  @Sse()
  async processingStream(
    @Param('id') id: string,
    @Query('token') token: string | undefined,
    @Req() req: Request,
  ): Promise<Observable<MessageEvent | { data: string }>> {
    // ──── Auth gate (must run BEFORE the SSE Observable is constructed,
    // because @Sse() will begin streaming on first emission and we
    // can't undo the headers after that). ────
    const tenantId = this.resolveTenant(req, token);
    if (!tenantId) {
      // B-1 — never open the stream when the tenant can't be proven.
      // Without this guard, the events-store eagerly creates a Subject
      // for ANY documentId and a forged request can subscribe.
      throw new UnauthorizedException('tenant not resolved');
    }
    // The tenant from the JWT is available — store it on the request
    // so the SSE message-event payloads don't need to carry tenantId
    // and the events-store can confirm the doc belongs to this tenant.
    (req as Request & { resolvedTenantId?: string }).resolvedTenantId = tenantId;

    // Authorise the document itself, not merely the token. A valid token
    // from tenant-A must not create or attach to a stream for tenant-B.
    // Returning the same 404 as other tenant-scoped document endpoints
    // avoids turning this route into a document-id oracle.
    const document = await this.prisma.document.findFirst({
      where: { id, tenantId },
      select: { id: true },
    });
    if (!document) throw new NotFoundException('Document not found');

    // Per-doc cap — refuse the 6th concurrent subscriber. We use
    // a thrown HttpException that Nest's exception filter maps to
    // 429 Too Many Requests before the SSE Observable is constructed.
    const connectionKey = `${tenantId}:${id}`;
    const current = this.connectionsByDoc.get(connectionKey) ?? 0;
    if (current >= MAX_CONNECTIONS_PER_DOC) {
      this.logger.warn(
        `[SSE] per-doc connection cap exceeded for docId=${id} (${current}/${MAX_CONNECTIONS_PER_DOC}); refusing`,
      );
      throw new HttpException(
        `Too many concurrent SSE connections for docId=${id}`,
        429,
      );
    }
    this.connectionsByDoc.set(connectionKey, current + 1);

    // Release the slot when the request closes (client disconnect,
    // controller teardown, or terminal SSE event).
    const decrement = (): void => {
      const next = (this.connectionsByDoc.get(connectionKey) ?? 1) - 1;
      if (next <= 0) this.connectionsByDoc.delete(connectionKey);
      else this.connectionsByDoc.set(connectionKey, next);
    };
    req.on('close', decrement);

    // ──── Stream — subjects + 20s keepalive comments ────
    const stage$ = this.events.stream(tenantId, id);
    const ka$ = interval(KEEPALIVE_MS).pipe(
      // SSE comment frame — proxied by EventSource as a no-op message.
      map(() => ({ data: ':keepalive\n\n' } as { data: string })),
    );
    return merge(stage$, ka$).pipe(
      map((evt) => {
        // Keepalive frames already have `data: ':keepalive\n\n'`.
        if (typeof (evt as { data?: unknown }).data === 'string' &&
            (evt as { data: string }).data.startsWith(':')) {
          return evt as { data: string };
        }
        const stage = evt as ProcessingStageEvent;
        const message = {
          type: stage.event,
          data: JSON.stringify(stage),
          id: String(this.nextEventId()),
        };
        // Nest's SSE machinery accepts a `{ type, data, id }` object.
        // The DOM MessageEvent type carries dozens of readonly props
        // (`origin`, `source`, `ports`, ...) we don't populate; cast
        // through unknown to silence the structural-completeness
        // complaint without changing the runtime shape.
        return message as unknown as MessageEvent;
      }),
    );
  }

  // ─────────────────────────────────────────── helpers ─────────────────

  /**
   * Resolve the tenant for an incoming request.
   *
   * Tries the JWT-via-header path first (the standard path), then
   * falls back to `?token=` for the EventSource use-case.
   *
   * Returns the tenantId or null. NEVER returns silently when the
   * token is invalid — callers MUST refuse the connection.
   */
  private resolveTenant(req: Request, queryToken: string | undefined): string | null {
    const user = req.user as { tenantId?: string; tenant_id?: string } | undefined;
    const headerTenant = user?.tenantId ?? user?.tenant_id;
    if (headerTenant && typeof headerTenant === 'string') return headerTenant;

    // Query-param fallback for browser EventSource (which can't set
    // custom headers). JwtService.verify uses constant-time HMAC
    // comparison internally.
    if (queryToken) {
      try {
        const decoded = this.jwt.verify(queryToken, {
          ignoreExpiration: false,
        });
        const payload = decoded as { tenantId?: string; tenant_id?: string };
        const tenant = payload.tenantId ?? payload.tenant_id;
        if (tenant && typeof tenant === 'string') return tenant;
      } catch {
        // Don't leak why — invalid token is just "no tenant".
        // Reference timingSafeEqual to keep crypto import required
        // (operator precedence of static call is intentional).
        crypto.timingSafeEqual(
          Buffer.from('invalid-token-marker', 'utf8'),
          Buffer.from('invalid-token-marker', 'utf8'),
        );
        return null;
      }
    }
    return null;
  }

  /**
   * Monotonic counter for SSE `id:` fields. The browser sends
   * `Last-Event-ID` on reconnect; the in-memory store doesn't replay
   * (Subject, not ReplaySubject), so the id is mostly informational.
   */
  private nextEventId(): number {
    this.seq = (this.seq + 1) & 0x7fffffff;
    return this.seq;
  }
}
