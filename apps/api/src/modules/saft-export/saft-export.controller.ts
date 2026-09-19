import {
  BadRequestException,
  Controller,
  Get,
  Header,
  Query,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Readable } from 'stream';
import type { Response } from 'express';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role } from '../../common/guards/rbac.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { SaftExportService } from './saft-export.service';

/**
 * SaftExportController — SAF-T PT file streaming.
 *
 * Two endpoints:
 *   GET /saft/export?from=YYYY-MM-DD&to=YYYY-MM-DD
 *     Streams a SAF-T PT v1.04_01 XML over an `application/xml`
 *     response with Content-Disposition: attachment. Default
 *     window (when `from`/`to` are missing) is the last 30 days.
 *
 *   GET /saft/export/test
 *     Returns the same XML shape but with the tenant's docs
 *     from the last 24h only — small enough to inspect without
 *     pulling the whole audit window. Same RBAC gate.
 *
 * RBAC: ADMIN + ACCOUNTANT. The controller gates the route so a
 * leaking token without the right role gets a 403 before any
 * XML is built.
 */
@ApiTags('saft-export')
@ApiBearerAuth()
@Controller('saft')
export class SaftExportController {
  constructor(private readonly saft: SaftExportService) {}

  @Get('export')
  @Roles(Role.ADMIN, Role.ACCOUNTANT)
  @Header('Content-Type', 'application/xml; charset=utf-8')
  @ApiOperation({
    summary: 'Export SAF-T PT v1.04_01 for the supplied period',
    description:
      'Streams the SAF-T XML inline. Only documents with status=APROVADO inside the period are included — every other state is filtered server-side. The hash chain is computed once at the end so the body never has to be re-hashed.',
  })
  @ApiQuery({
    name: 'from',
    required: false,
    type: String,
    description: 'ISO 8601 date (YYYY-MM-DD). Defaults to 30 days back.',
  })
  @ApiQuery({
    name: 'to',
    required: false,
    type: String,
    description: 'ISO 8601 date (YYYY-MM-DD). Defaults to today.',
  })
  @ApiResponse({
    status: 200,
    description: 'SAF-T PT XML stream',
    content: { 'application/xml': { schema: { type: 'string' } } },
  })
  @ApiResponse({ status: 400, description: 'Invalid from/to dates' })
  @ApiResponse({ status: 403, description: 'Caller lacks ADMIN/ACCOUNTANT role' })
  async export(
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: false }) res: Response,
    @Query('from') fromRaw?: string,
    @Query('to') toRaw?: string,
  ): Promise<void> {
    const range = this.parseRange(fromRaw, toRaw);
    const tenantSlug = await this.saft.tenantSlug(user.tenantId);
    const fileName = `saft-pt-${tenantSlug}-${this.dateSlug(range.from)}-${this.dateSlug(range.to)}.xml`;

    // Headers first, then the body as a stream — the controller
    // does not buffer the whole payload in memory.
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${fileName}"`,
    );
    res.setHeader('Cache-Control', 'no-store');

    // Pipe the async generator into a Readable so Express can
    // stream it back. The async generator emits fragments in
    // ~64 KiB chunks at most (one XML element each, in practice).
    const gen = this.saft.streamSaft(user.tenantId, user.id, range);
    const stream = Readable.from(genToAsyncIterable(gen));
    stream.pipe(res);
    // Resolve when the stream ends so Express flushes cleanly.
    await new Promise<void>((resolve, reject) => {
      stream.on('end', resolve);
      stream.on('error', reject);
      res.on('error', reject);
    });
  }

  @Get('export/test')
  @Roles(Role.ADMIN, Role.ACCOUNTANT)
  @ApiOperation({
    summary: 'Return a small SAF-T PT sample for the last 24h',
    description:
      'Smoke-test the XML shape without pulling a 50 MB export. Same RBAC gate, but only the last 24h of documents are included.',
  })
  @ApiResponse({
    status: 200,
    description: 'SAF-T PT XML snippet',
    content: { 'application/xml': { schema: { type: 'string' } } },
  })
  async sample(@CurrentUser() user: AuthenticatedUser): Promise<string> {
    // For the sample we don't filter to the calling tenant's docs
    // specifically — the underlying service is tenant-scoped
    // through the Prisma extension. We just return the smaller
    // window so callers can inspect the wire format.
    const xs = await this.saft.buildSample();
    return xs;
  }

  // ─── Helpers ──────────────────────────────────────────────────────

  private parseRange(fromRaw?: string, toRaw?: string): { from: Date; to: Date } {
    const now = new Date();
    const to = toRaw ? new Date(toRaw) : now;
    if (Number.isNaN(to.getTime())) {
      throw new BadRequestException(`Invalid 'to' value: ${toRaw}`);
    }
    const defaultFrom = new Date(now);
    defaultFrom.setUTCDate(defaultFrom.getUTCDate() - 30);
    const from = fromRaw ? new Date(fromRaw) : defaultFrom;
    if (Number.isNaN(from.getTime())) {
      throw new BadRequestException(`Invalid 'from' value: ${fromRaw}`);
    }
    if (from.getTime() > to.getTime()) {
      throw new BadRequestException(`'from' must be <= 'to'`);
    }
    return { from, to };
  }

  private dateSlug(d: Date): string {
    return d.toISOString().slice(0, 10);
  }
}

// Async generator → Readable.from async iterable glue. Express
// uses Node streams, not async iterators, so we wrap.
function genToAsyncIterable<T>(gen: AsyncGenerator<T>): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      return gen;
    },
  };
}
