import { Module, forwardRef } from '@nestjs/common';
import { IntegrationsModule } from '../integrations/integrations.module';
import { InboundModule } from '../inbound/inbound.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { GmailService } from './gmail.service';
import { OutlookService } from './outlook.service';
import { MicrosoftGraphService } from './microsoft-graph.service';
import { PollerService } from './poller.service';
import { OAuthController } from './oauth.controller';

/**
 * EmailInboundModule — Gmail + Outlook / Microsoft Graph ingestion.
 *
 * Ingests documents automatically from:
 *   - Microsoft Graph Client Credentials (financeiro@hotelequip.pt -> Faturas)
 *   - OneDrive cloud folder (/DocFlow/Entrada)
 *   - Gmail (when configured and GMAIL_ENABLED=true)
 */
@Module({
  imports: [
    PrismaModule,
    IntegrationsModule,
    forwardRef(() => InboundModule),
  ],
  controllers: [OAuthController],
  providers: [
    GmailService,
    OutlookService,
    { provide: MicrosoftGraphService, useExisting: OutlookService },
    PollerService,
  ],
  exports: [GmailService, OutlookService, MicrosoftGraphService],
})
export class EmailInboundModule {}

