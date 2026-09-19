import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Logger,
  Param,
  Query,
  Redirect,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
import { Public } from '../../common/decorators/public.decorator';
import type { TenantRequestContext } from '../../common/context/tenant-context';
import { PrismaService } from '../../prisma/prisma.service';
import { OAuthStateStore } from '../integrations/core/oauth-state.store';
import { decryptJson } from './oauth-crypto';
import { GmailService } from './gmail.service';
import { OutlookService } from './outlook.service';

/**
 * OAuthController — entry points for Gmail / Outlook authorisation and
 * the OAuth callbacks. The callback endpoints are `Public()` because
 * Google / Microsoft redirect the user's browser there without a bearer
 * token. Tenant identity is recovered from the CSRF state, which was
 * persisted by `generateAuthUrl()` via the shared `OAuthStateStore`.
 */
@ApiTags('Email Inbound')
@Controller('email-inbound')
export class OAuthController {
  private readonly logger = new Logger(OAuthController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly oauthStates: OAuthStateStore,
    private readonly gmail: GmailService,
    private readonly outlook: OutlookService,
  ) {}

  // ────────────────────────────── Gmail ──────────────────────────────

  @Get('oauth/google')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Start Gmail OAuth (returns authorize URL)' })
  async googleAuth(@CurrentTenant() tenant: TenantRequestContext) {
    const { authUrl, state } = await this.gmail.generateAuthUrl(
      tenant.tenantId,
      tenant.userId,
    );
    return { authUrl, state };
  }

  @Public()
  @Get('oauth/google/callback')
  @HttpCode(302)
  @Redirect()
  @ApiOperation({ summary: 'Gmail OAuth callback (browser redirect)' })
  async googleCallback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Res() res: Response,
  ) {
    if (!code || !state) throw new BadRequestException('Missing code/state');
    const session = await this.oauthStates.consume('gmail', state);
    if (!session) {
      throw new UnauthorizedException('Invalid or expired OAuth state');
    }
    try {
      await this.gmail.handleCallback(code, state, session.tenantId, 'system');
    } catch (err) {
      this.logger.error(`Gmail callback failed: ${(err as Error).message}`);
      return res.redirect(
        `${this.frontendBase()}/documents?tab=email&connected=gmail&error=callback`,
      );
    }
    return res.redirect(
      `${this.frontendBase()}/documents?tab=email&connected=gmail`,
    );
  }

  // ──────────────────────────── Outlook ──────────────────────────────

  @Get('oauth/microsoft')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Start Outlook OAuth (disabled — client credentials active)' })
  async microsoftAuth(@CurrentTenant() _tenant: TenantRequestContext) {
    throw new BadRequestException(
      'O login interativo do Outlook está desativado para evitar conexões duplicadas. O DocFlow utiliza o conector de aplicação Microsoft Graph (financeiro@hotelequip.pt) para ingestão contínua.',
    );
  }

  @Public()
  @Get('oauth/microsoft/callback')
  @HttpCode(302)
  @Redirect()
  @ApiOperation({ summary: 'Outlook OAuth callback (disabled)' })
  async microsoftCallback(
    @Query('code') _code: string | undefined,
    @Query('state') _state: string | undefined,
    @Res() res: Response,
  ) {
    return res.redirect(
      `${this.frontendBase()}/documents?tab=email&error=outlook_oauth_disabled`,
    );
  }

  // ──────────────────────────── Lifecycle ────────────────────────────

  @Delete('oauth/:provider')
  @ApiBearerAuth()
  @HttpCode(200)
  @ApiOperation({ summary: 'Disconnect an OAuth provider (keeps audit trail)' })
  async disconnect(
    @CurrentTenant() tenant: TenantRequestContext,
    @Param('provider') provider: string,
  ) {
    if (!['gmail', 'outlook'].includes(provider)) {
      throw new BadRequestException('Unknown provider');
    }
    const result = await this.prisma.integration.updateMany({
      where: { tenantId: tenant.tenantId, provider },
      data: { isActive: false },
    });
    return { ok: true, updated: result.count };
  }

  @Get('status')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Per-tenant OAuth connection status' })
  async status(@CurrentTenant() tenant: TenantRequestContext) {
    const rows = await this.prisma.integration.findMany({
      where: {
        tenantId: tenant.tenantId,
        provider: { in: ['gmail', 'outlook'] },
      },
      select: {
        provider: true,
        isActive: true,
        lastSyncAt: true,
        lastSyncStatus: true,
        credentials: true,
      },
    });
    const graphStats = this.outlook.getStats();
    const isGraphConfigured = Boolean(this.outlook.clientSecret);

    const out: Record<string, { connected: boolean; email?: string; lastSyncAt?: Date | null; lastSyncStatus?: string | null }> = {
      google: { connected: false },
      microsoft: {
        connected: isGraphConfigured,
        email: isGraphConfigured ? this.outlook.mailbox : undefined,
        lastSyncAt: graphStats.lastRunAt,
        lastSyncStatus: graphStats.lastRunStatus,
      },
    };
    for (const row of rows) {
      if (row.provider === 'gmail') {
        let email: string | undefined;
        if (row.isActive) {
          try {
            const creds = decryptJson<{ email?: string }>(String(row.credentials));
            email = creds.email;
          } catch {
            email = undefined;
          }
        }
        out.google = {
          connected: row.isActive && process.env.GMAIL_ENABLED === 'true',
          email,
          lastSyncAt: row.lastSyncAt,
          lastSyncStatus: row.lastSyncStatus,
        };
      }
    }
    return out;
  }

  private frontendBase(): string {
    return process.env.WEB_ORIGIN ?? 'http://localhost:3000';
  }
}
