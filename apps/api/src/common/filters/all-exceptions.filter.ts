import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { getTenantContext } from '../context/tenant-context';

/**
 * Single error envelope for the whole API. Every error response — whether it
 * came from a 4xx business validation, a 401, a Prisma constraint violation
 * or a 500 — leaves the server in the same shape:
 *
 *   {
 *     "statusCode": 400,
 *     "error": "Bad Request",
 *     "message": "email must be a valid email",
 *     "path": "/api/v1/users",
 *     "timestamp": "2026-01-01T12:00:00.000Z",
 *     "requestId": "uuid"
 *   }
 *
 * The filter is also responsible for translating Prisma's well-known errors
 * (`P2002`, `P2025`, `P2003`) into semantic HTTP statuses, and for never
 * leaking stack traces or DB error strings in production.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    const ctx = getTenantContext();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message: string | string[] = 'Internal server error';
    let errorName = 'InternalServerError';
    // Carry extra context fields thrown on ConflictException etc. (e.g.
    // 409 dedup throws { message, existingId, existingFileName } so the
    // client can link to the original document instead of treating the
    // upload as broken). The frontend reads these to render a friendly
    // "already loaded" affordance.
    const extra: Record<string, unknown> = {};

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'string') {
        message = body;
      } else if (typeof body === 'object' && body !== null) {
        const b = body as Record<string, unknown>;
        message = (b.message as string | string[]) ?? exception.message;
        // Forward every key that isn't part of the standard envelope, so
        // ConflictException detail fields (existingId, existingFileName,
        // code, etc.) reach the client without us having to whitelist
        // each one. The frontend should treat unknown fields as
        // informational — never trust them for routing.
        for (const [k, v] of Object.entries(b)) {
          if (
            k === 'message' ||
            k === 'error' ||
            k === 'statusCode' ||
            k === 'path' ||
            k === 'timestamp' ||
            k === 'requestId'
          ) {
            continue;
          }
          extra[k] = v;
        }
        // Fallback chain: explicit error → statusText from code → exception.name
        // (ThrottlerException sometimes ships body.error="InternalServerError" which
        // is misleading for HTTP 429; prefer the canonical HTTP status text instead.)
        const explicitError = b.error as string | undefined;
        if (explicitError && explicitError !== 'InternalServerError') {
          errorName = explicitError;
        } else {
          errorName = httpStatusText(status) ?? exception.name;
        }
      }
    } else if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      ({ status, message, errorName } = mapPrismaError(exception));
    } else if (exception instanceof Prisma.PrismaClientValidationError) {
      status = HttpStatus.BAD_REQUEST;
      message = exception.message.replace(/\n+/g, ' ').trim();
      errorName = 'PrismaValidationError';
      this.logger.error(`PrismaClientValidationError on ${req.method} ${req.url}: ${message}`);
    } else if (exception instanceof Error) {
      message = exception.message;
      errorName = exception.name;
    }

    const payload = {
      statusCode: status,
      error: errorName,
      message,
      path: req.originalUrl ?? req.url,
      timestamp: new Date().toISOString(),
      requestId: ctx?.requestId ?? (req.headers['x-request-id'] as string) ?? undefined,
      ...extra,
    };

    if (status >= 500) {
      this.logger.error(
        `${req.method} ${req.url} → ${status} ${errorName}: ${JSON.stringify(message)}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    } else {
      this.logger.warn(
        `${req.method} ${req.url} → ${status} ${errorName}: ${JSON.stringify(message)}`,
      );
    }

    // The download endpoint (and any other passthrough:false handler) may
    // have already flushed the response. Trying to write a JSON envelope
    // here would throw ERR_HTTP_HEADERS_SENT and cascade into a second
    // 500. End the socket instead so the client gets the bytes that
    // already went out and nothing more.
    if (res.headersSent || res.writableEnded) {
      try {
        res.end();
      } catch {
        // socket already closed — nothing we can do.
      }
      return;
    }

    res.status(status).json(payload);
  }
}

function httpStatusText(status: number): string | undefined {
  // Mirror Node's http.STATUS_CODES without importing 'http' (keeps the filter
  // independent of the platform adapter). Covers the cases we actually emit.
  switch (status) {
    case 400: return 'Bad Request';
    case 401: return 'Unauthorized';
    case 403: return 'Forbidden';
    case 404: return 'Not Found';
    case 409: return 'Conflict';
    case 413: return 'Payload Too Large';
    case 415: return 'Unsupported Media Type';
    case 422: return 'Unprocessable Entity';
    case 429: return 'Too Many Requests';
    case 500: return 'Internal Server Error';
    case 502: return 'Bad Gateway';
    case 503: return 'Service Unavailable';
    case 504: return 'Gateway Timeout';
    default: return undefined;
  }
}

function mapPrismaError(
  err: Prisma.PrismaClientKnownRequestError,
): { status: HttpStatus; message: string; errorName: string } {
  switch (err.code) {
    case 'P2002': {
      const target = (err.meta?.target as string[] | string | undefined) ?? 'field';
      return {
        status: HttpStatus.CONFLICT,
        message: `Unique constraint failed on ${Array.isArray(target) ? target.join(', ') : target}`,
        errorName: 'UniqueConstraintViolation',
      };
    }
    case 'P2025':
      return {
        status: HttpStatus.NOT_FOUND,
        message: 'Resource not found',
        errorName: 'NotFound',
      };
    case 'P2003':
      return {
        status: HttpStatus.BAD_REQUEST,
        message: 'Foreign key constraint failed',
        errorName: 'ForeignKeyViolation',
      };
    case 'P2014':
      return {
        status: HttpStatus.BAD_REQUEST,
        message: 'Relation constraint violation',
        errorName: 'RelationViolation',
      };
    default:
      return {
        status: HttpStatus.BAD_REQUEST,
        message: `Database error: ${err.code}`,
        errorName: 'DatabaseError',
      };
  }
}