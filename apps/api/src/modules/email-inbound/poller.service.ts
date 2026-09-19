import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { GmailService } from './gmail.service';
import { OutlookService } from './outlook.service';

/**
 * PollerService — cron poller for automated email and cloud document ingestion.
 *
 * Single-channel policy (Fase B2):
 *   - Microsoft Graph Client Credentials (financeiro@hotelequip.pt) via OutlookService runs
 *     every 2 minutes. This ingests both the Faturas folder and OneDrive (/DocFlow/Entrada).
 *   - Interactive Outlook OAuth polling is disabled to avoid dual connections.
 *   - Gmail polling is deactivated unless explicitly enabled via GMAIL_ENABLED=true.
 */
@Injectable()
export class PollerService {
  private readonly logger = new Logger(PollerService.name);
  private outlookRunning = false;
  private gmailRunning = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly gmail: GmailService,
    private readonly outlook: OutlookService,
  ) {}

  @Cron('*/2 * * * *')
  async pollAll() {
    if (this.outlookRunning) {
      this.logger.warn('Microsoft Graph / Outlook poller still running — skipping tick');
      return;
    }
    this.outlookRunning = true;
    try {
      await this.outlook.pollAll();
    } catch (err) {
      this.logger.error(`Microsoft Graph / Outlook poller error: ${(err as Error).message}`);
    } finally {
      this.outlookRunning = false;
    }

    // Gmail: only poll if explicitly enabled (default: false / deactivated)
    if (process.env.GMAIL_ENABLED === 'true' && !this.gmailRunning) {
      this.gmailRunning = true;
      try {
        await this.pollGmailTenants();
      } finally {
        this.gmailRunning = false;
      }
    }
  }

  private async pollGmailTenants(): Promise<void> {
    const integrations = await this.prisma.integration.findMany({
      where: { provider: 'gmail', isActive: true },
      select: { tenantId: true },
    });
    for (const integration of integrations) {
      try {
        await this.gmail.pollTenant(integration.tenantId);
      } catch (err) {
        this.logger.error(
          `gmail poller failed for tenant ${integration.tenantId}: ${(err as Error).message}`,
        );
      }
    }
  }
}
