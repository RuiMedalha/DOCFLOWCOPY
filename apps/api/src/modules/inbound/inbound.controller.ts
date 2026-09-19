import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Optional,
  Post,
  Req,
  UnauthorizedException,
  UploadedFile,
  UploadedFiles,
  UseInterceptors,
  forwardRef,
} from '@nestjs/common';
import { AnyFilesInterceptor, FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { memoryStorage } from 'multer';
import type { Request } from 'express';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
import { Public } from '../../common/decorators/public.decorator';
import type { TenantRequestContext } from '../../common/context/tenant-context';
import { assertCronSecret } from '../../common/auth/cron-secret';
import { ImapConfigDto } from './dto/imap-config.dto';
import { InboundService } from './inbound.service';
import { MicrosoftGraphService } from '../email-inbound/microsoft-graph.service';

const uploadOptions = { storage: memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 20 } };

@ApiTags('Inbound')
@Controller('inbound')
export class InboundController {
  constructor(
    private readonly inboundService: InboundService,
    @Optional()
    @Inject(forwardRef(() => MicrosoftGraphService))
    private readonly graphService?: MicrosoftGraphService,
  ) {}

  @Post('mail/config')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Store the current tenant IMAP mailbox configuration' })
  saveImapConfig(@CurrentTenant() tenant: TenantRequestContext, @Body() dto: ImapConfigDto) {
    return this.inboundService.saveImapConfig(tenant.tenantId, dto);
  }

  @Public()
  @SkipThrottle() // cron-controlled, signature already enforced
  @Post('mail/sync-all')
  @HttpCode(200)
  @ApiOperation({ summary: 'Cron-only sync of every configured IMAP mailbox' })
  syncAll(@Headers('x-cron-secret') secret: string | undefined) {
    // Constant-time compare to avoid leaking the secret byte-by-byte via
    // timing. The previous `!==` short-circuited on the first differing
    // byte. Audit finding §5.2 of AUDIT-REPORT.md (MEDIUM).
    if (!assertCronSecret(secret, process.env.CRON_SECRET)) {
      throw new UnauthorizedException('Invalid cron secret');
    }
    return this.inboundService.syncAll();
  }

  @Public()
  @SkipThrottle() // signature-verified; per-IP throttling delegated to WAF
  @Post('email')
  @HttpCode(200)
  @UseInterceptors(AnyFilesInterceptor(uploadOptions))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'SendGrid/Mailgun inbound parse webhook' })
  email(
    @Req() req: Request,
    @Body() body: Record<string, unknown>,
    @UploadedFiles() files: Express.Multer.File[],
  ) {
    // C-10: forward the raw request bytes so the inbound service can
    // recompute the SendGrid HMAC over the ORIGINAL multipart payload
    // — body parsing alone is not enough because Nest/multer has already
    // mutated the field order and binary boundaries by the time @Body()
    // fires.
    const rawBody = (req as unknown as { rawBody?: Buffer | string }).rawBody;
    const headers = req.headers as Record<string, unknown> & {
      rawBody?: Buffer | string;
    };
    if (rawBody !== undefined) headers.rawBody = rawBody;
    return this.inboundService.ingestWebhookEmail(
      body,
      files ?? [],
      headers,
    );
  }

  // M4 fix: hard rate limit the scanner endpoint. scanToken is a single-factor
  // shared secret; without throttling it is trivially brute-forceable.
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('scan')
  @HttpCode(201)
  @UseInterceptors(FileInterceptor('file', uploadOptions))
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } } })
  @ApiOperation({ summary: 'Token-authenticated scanner drop endpoint' })
  scan(
    @Headers('x-scan-token') scanToken: string | undefined,
    @Req() request: Request,
    @UploadedFile() file: Express.Multer.File,
  ) {
    const bearer = request.headers.authorization?.startsWith('Bearer ')
      ? request.headers.authorization.slice('Bearer '.length)
      : undefined;
    return this.inboundService.ingestScanner(scanToken ?? bearer, file);
  }

  // ────────────────────────── Direct Upload ──────────────────────────

  @Post(['', 'upload'])
  @HttpCode(201)
  @UseInterceptors(AnyFilesInterceptor(uploadOptions))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Ingest documents directly through the unified inbound pipeline' })
  async upload(
    @Req() req: Request,
    @Body() body: Record<string, unknown>,
    @UploadedFiles() files: Express.Multer.File[],
    @CurrentTenant() tenant?: TenantRequestContext,
  ) {
    const tenantId =
      tenant?.tenantId ||
      (body.tenantId as string) ||
      (req.headers['x-tenant-id'] as string) ||
      'demo';
    const origin = (body.origin as any) || 'UPLOAD';
    const metadata = body.metadata ? JSON.parse(String(body.metadata)) : {};

    return this.inboundService.ingestDirectUpload(tenantId, files ?? [], origin, metadata);
  }

  // ────────────────────────── WhatsApp (Evolution API) ───────────────

  @Public()
  @Post('whatsapp')
  @HttpCode(200)
  @UseInterceptors(AnyFilesInterceptor(uploadOptions))
  @ApiConsumes('multipart/form-data', 'application/json')
  @ApiOperation({ summary: 'Evolution API WhatsApp webhook & media ingest' })
  async whatsapp(
    @Req() req: Request,
    @Body() body: Record<string, unknown>,
    @UploadedFiles() files?: Express.Multer.File[],
  ) {
    const file = files && files.length > 0 ? files[0] : undefined;
    const tenantId = (req.query?.tenantId as string) || (body.tenantId as string);

    return this.inboundService.ingestWhatsApp(body, file, tenantId);
  }

  // ────────────────────────── Inbound Status ─────────────────────────

  @Public()
  @Get('status')
  @ApiOperation({ summary: 'Aggregated status of all inbound document channels' })
  async status() {
    const counts = await this.inboundService.getInboundStatus();
    const graphStats = this.graphService ? this.graphService.getStats() : null;

    return {
      channels: {
        manualUpload: { active: true },
        emailGraph: {
          active: Boolean(process.env.MS_CLIENT_SECRET || process.env.MICROSOFT_CLIENT_SECRET),
          mailbox: process.env.MS_MAILBOX || 'financeiro@hotelequip.pt',
          folder: process.env.MS_MAIL_FOLDER || 'Faturas',
          stats: graphStats,
        },
        oneDrive: {
          active: Boolean(process.env.MS_CLIENT_SECRET || process.env.MICROSOFT_CLIENT_SECRET),
          folder: process.env.ONEDRIVE_ENTRADA_FOLDER || '/DocFlow/Entrada',
          stats: {
            filesIngested: graphStats?.oneDriveFilesIngested ?? 0,
          },
        },
        scanner: {
          active: true,
          watchPath: process.env.SCANNER_PATH || './uploads/scanner',
        },
        whatsApp: {
          active: true,
          endpoint: '/api/v1/inbound/whatsapp',
        },
      },
      documents: counts,
    };
  }

  // ────────────────────────── Manual Graph Sync ──────────────────────

  @Post('graph/sync')
  @HttpCode(200)
  @ApiOperation({ summary: 'Manually trigger Microsoft Graph email & OneDrive poller' })
  async triggerGraphSync() {
    if (!this.graphService) {
      return { ok: false, error: 'Graph service not loaded' };
    }
    const result = await this.graphService.pollAll();
    return { ok: true, result };
  }
}
