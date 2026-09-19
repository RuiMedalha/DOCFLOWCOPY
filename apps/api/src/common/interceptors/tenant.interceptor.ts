import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { getTenantContext } from '../context/tenant-context';

/**
 * Lightweight per-request observability hook. Runs AFTER the controller, so:
 *
 *  - We can log the tenant + user + latency for every business request, which
 *    is what audit trails want (the AuditLog module later subscribes to this).
 *  - We stamp `x-tenant-id` on the response so clients can verify which tenant
 *    actually handled the call — useful for debugging multi-tenant routing.
 *
 * The interceptor is read-only; it never throws or mutates the response body.
 */
@Injectable()
export class TenantInterceptor implements NestInterceptor {
  private readonly logger = new Logger(TenantInterceptor.name);

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const start = Date.now();
    const http = context.switchToHttp();
    const req = http.getRequest();
    const res = http.getResponse();
    const ctx = getTenantContext();

    return next.handle().pipe(
      tap(() => {
        const elapsed = Date.now() - start;
        // The download endpoint uses @Res({ passthrough: false }) and
        // calls res.end(buffer) itself. By the time tap() runs the
        // response has already been flushed; setHeader / send would
        // throw ERR_HTTP_HEADERS_SENT and the global filter would try
        // to re-send, producing the misleading "Cannot set headers
        // after they are sent → 500" we used to see on /download. We
        // detect that and skip the header write + summary log when
        // headers have already been sent.
        const headersAlreadySent = res.headersSent || res.writableEnded;
        if (!headersAlreadySent && ctx?.tenantId) {
          res.setHeader('x-tenant-id', ctx.tenantId);
        }
        if (!headersAlreadySent) {
          this.logger.log(
            `${req.method} ${req.url} tenant=${ctx?.tenantId ?? 'public'} ` +
              `user=${ctx?.userId ?? 'anonymous'} ${elapsed}ms`,
          );
        }
      }),
    );
  }
}
