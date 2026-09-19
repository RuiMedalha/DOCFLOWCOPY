import {
  BadRequestException,
  forwardRef,
  Inject,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { DocumentOrigin, Prisma } from '@prisma/client';
import { OAuthStateStore } from '../integrations/core/oauth-state.store';
import { PrismaService } from '../../prisma/prisma.service';
import { InboundService } from '../inbound/inbound.service';
import { fetchWithTimeout } from './fetch-with-timeout';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const ACCEPTED_EXTS = new Set(['pdf', 'png', 'jpg', 'jpeg', 'docx', 'heic', 'heif']);
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

/**
 * Padrões de nomes de ficheiros que correspondem a assinaturas de email,
 * botões de redes sociais, avatares, logotipos e imagens decorativas.
 */
export const JUNK_ATTACHMENT_PATTERNS: RegExp[] = [
  /^(?:image\d{3,}|img_\d{3,}|outlook-[a-z0-9_-]+)\.[a-z0-9]+$/i,
  /^(?:inline_image\d*|att_\d+|attachment\d*)\.[a-z0-9]+$/i,
  // Redes sociais e botões de contacto
  /^(?:facebook|instagram|linkedin|twitter|youtube|whatsapp|telegram|tiktok|vimeo|skype|social)(?:[-_.\s]|$)/i,
  // Logotipos, rodapés, cabeçalhos, banners, carimbos de assinatura
  /^(?:logo|logos|logotipo|signature|assinatura|header|footer|banner|cabecalho|rodape|carimbo|assinatura_email)(?:[-_.\s]|$)/i,
  // Ícones e espaçadores de layout
  /^(?:icon|icons|icone|icones|avatar|badge|spacer|pixel|blank|divider|btn|button)(?:[-_.\s]|$)/i,
];

/**
 * Padrões de documentos comerciais/operacionais que NÃO são faturas nem comprovativos fiscais
 * (catálogos, termos e condições, políticas de privacidade, manuais de produto, etc.)
 */
export const NON_INVOICE_DOC_PATTERNS: RegExp[] = [
  /^(?:catalogo|cat[aá]logo|brochura|folheto|flyer|panfleto|prospecto)(?:[-_.\s\d]|$)/i,
  /^(?:manual|guia[-_]?utilizador|ficha[-_]?t[eé]cnica|especifica[cç][aã]o|user[-_]?guide)(?:[-_.\s\d]|$)/i,
  /^(?:termos|condi[cç][oõ]es[-_]?gerais|politica[-_]?privacidade|aviso[-_]?legal|rgpd|gdpr|aviso[-_]?privacidade)(?:[-_.\s\d]|$)/i,
  /^(?:apresenta[cç][aã]o|newsletter|tabela[-_]?pre[cç]os|lista[-_]?pre[cç]os|boas[-_]?festas|comunicado)(?:[-_.\s\d]|$)/i,
];

/**
 * Assuntos de email que indicam claramente comunicações gerais, publicidade ou felicitações
 * sem qualquer relevância para faturação ou compras.
 */
export const SPAM_SUBJECT_PATTERNS: RegExp[] = [
  /\b(newsletter|boas\s+festas|feliz\s+natal|feliz\s+ano|votos\s+de|aviso\s+de\s+f[eé]rias)\b/i,
  /\b(pesquisa\s+de\s+satisfa[cç][aã]o|inqu[eé]rito|convite\s+para|webinar|participe)\b/i,
  /\b(atualiza[cç][aã]o\s+de\s+contactos|informa[cç][aã]o\s+importante\s+sobre\s+f[eé]rias)\b/i,
];

export interface GraphPollerStats {
  lastRunAt: Date | null;
  lastRunStatus: 'idle' | 'running' | 'success' | 'partial' | 'error';
  emailsRead: number;
  documentsIngested: number;
  oneDriveFilesIngested: number;
  recentErrors: Array<{ timestamp: Date; message: string; source: string }>;
  pendingConfirmationLinks: Array<{
    date: Date;
    from: string;
    subject: string;
    links: string[];
    messageId: string;
  }>;
}

export interface ExtractedEmailAttachment {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
  size: number;
  metadata: {
    source: string;
    internetMessageId?: string;
    graphMessageId: string;
    originalSender?: string;
    originalSubject?: string;
    originalDate?: string;
    originalMailbox?: string;
    downloadLinks?: string[];
  };
}

/**
 * OutlookService — Microsoft Graph Inbound Service (Client Credentials / App-Only).
 *
 * Configured in Azure Entra ID with Application Permissions (Mail.ReadWrite, Files.ReadWrite.All)
 * and an ApplicationAccessPolicy restricting mailbox access strictly to financeiro@hotelequip.pt.
 *
 * Capabilities:
 *   - Client credentials authentication with token caching and 429 rate-limit backoff.
 *   - Ingestion of unread emails from the 'Faturas' folder of financeiro@hotelequip.pt.
 *   - Recursive extraction of forwarded messages (itemAttachment / message/rfc822, P0.1).
 *   - Post-ingest: marks email as read and moves it to 'Faturas/Processado'.
 *   - Detection of download links in email bodies (Moloni, TOConline, etc.) for review.
 *   - Ingestion of documents from OneDrive /DocFlow/Entrada -> moves to /DocFlow/Processados (origin: ONEDRIVE).
 *   - Delegated OAuth flow (authorization_code) is deactivated to prevent dual connections.
 */
@Injectable()
export class OutlookService {
  private readonly logger = new Logger(OutlookService.name);

  private cachedToken: { accessToken: string; expiresAt: number } | null = null;
  private faturasFolderId: string | null = null;
  private processadoFolderId: string | null = null;
  private oneDriveProcessadosFolderId: string | null = null;
  private cachedDriveBasePath: string | null = null;
  private isPolling = false;

  private stats: GraphPollerStats = {
    lastRunAt: null,
    lastRunStatus: 'idle',
    emailsRead: 0,
    documentsIngested: 0,
    oneDriveFilesIngested: 0,
    recentErrors: [],
    pendingConfirmationLinks: [],
  };

  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => InboundService))
    private readonly inbound: InboundService,
    @Optional()
    private readonly oauthStates?: OAuthStateStore,
  ) {}

  getStats(): GraphPollerStats {
    return { ...this.stats };
  }

  get tenantId(): string {
    return process.env.MS_TENANT_ID || 'f27c295b-2490-4101-9ae3-6db45ffd9489';
  }

  get clientId(): string {
    return (
      process.env.MS_CLIENT_ID ||
      process.env.MICROSOFT_CLIENT_ID ||
      '0dcb16b8-3214-49c2-ab13-80c7e07fa332'
    );
  }

  get clientSecret(): string | undefined {
    return process.env.MS_CLIENT_SECRET || process.env.MICROSOFT_CLIENT_SECRET;
  }

  get mailbox(): string {
    return process.env.MS_MAILBOX || 'financeiro@hotelequip.pt';
  }

  get mailboxIdFallback(): string {
    return process.env.MS_MAILBOX_ID || '24bc1dc4-59ac-475d-9696-54a4b9327411';
  }

  get mailFolderName(): string {
    return process.env.MS_MAIL_FOLDER || 'Faturas';
  }

  get mailProcessedFolderName(): string {
    return process.env.MS_MAIL_PROCESSED_FOLDER || 'Faturas/Processado';
  }

  get mailMoveEnabled(): boolean {
    return process.env.MS_MAIL_MOVE_ENABLED !== 'false';
  }

  get oneDriveMoveEnabled(): boolean {
    // Default to false (copy only) per user requirement: "so quero que faca uma copia e nao mover!"
    return process.env.ONEDRIVE_MOVE_ENABLED === 'true';
  }

  get blockedSenders(): string[] {
    const raw = process.env.MS_MAIL_BLOCKED_SENDERS || '';
    return raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  }

  get allowedSenders(): string[] {
    const raw = process.env.MS_MAIL_ALLOWED_SENDERS || '';
    return raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  }

  isSenderBlocked(fromAddress?: string | null): boolean {
    if (!fromAddress) return false;
    const clean = fromAddress.toLowerCase().trim();
    return this.blockedSenders.some((blocked) => clean.includes(blocked));
  }

  isSenderAllowed(fromAddress?: string | null): boolean {
    if (this.allowedSenders.length === 0) return true;
    if (!fromAddress) return false;
    const clean = fromAddress.toLowerCase().trim();
    return this.allowedSenders.some((allowed) => clean.includes(allowed));
  }

  get oneDriveEntradaPath(): string {
    return process.env.ONEDRIVE_ENTRADA_FOLDER || '/DocFlow/Entrada';
  }

  get oneDriveProcessadosPath(): string {
    return process.env.ONEDRIVE_PROCESSADOS_FOLDER || '/DocFlow/Processados';
  }

  // ─────────────────────────────────────────── Delegated OAuth (Deactivated) ──

  async generateAuthUrl(_tenantId: string, _userId: string): Promise<{ authUrl: string; state: string }> {
    throw new BadRequestException(
      'O caminho delegado (authorization_code) do Outlook está desativado para evitar conexões duplicadas à mesma caixa. O DocFlow utiliza credenciais de aplicação (Client Credentials) com ApplicationAccessPolicy restrita à caixa financeiro@hotelequip.pt.',
    );
  }

  async handleCallback(
    _code: string,
    _state: string,
    _tenantId: string,
    _userId: string,
  ): Promise<{ provider: 'outlook'; email?: string }> {
    throw new BadRequestException(
      'O caminho delegado (authorization_code) do Outlook está desativado para evitar conexões duplicadas à mesma caixa.',
    );
  }

  // ─────────────────────────────────────────── Client Credentials Token ──

  /**
   * Acquire an application-level bearer token via Client Credentials flow.
   * Auto-refreshes when within 60s of expiry.
   */
  async getAccessToken(forceRefresh = false): Promise<string> {
    const now = Date.now();
    if (!forceRefresh && this.cachedToken && this.cachedToken.expiresAt - now > 60_000) {
      return this.cachedToken.accessToken;
    }

    const secret = this.clientSecret;
    if (!secret) {
      throw new Error(
        'MS_CLIENT_SECRET / MICROSOFT_CLIENT_SECRET env var is required for Microsoft Graph client credentials',
      );
    }

    const tokenUrl = `https://login.microsoftonline.com/${this.tenantId}/oauth2/v2.0/token`;
    const params = new URLSearchParams({
      client_id: this.clientId,
      client_secret: secret,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    });

    const res = await fetchWithTimeout(tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    if (!res.ok) {
      const errorText = await res.text().catch(() => '');
      throw new Error(`Microsoft Graph token request failed (${res.status}): ${errorText}`);
    }

    const data = (await res.json()) as { access_token: string; expires_in: number };
    this.cachedToken = {
      accessToken: data.access_token,
      expiresAt: now + data.expires_in * 1000,
    };
    return this.cachedToken.accessToken;
  }

  // ─────────────────────────────────────────── Polling Operations ──

  /**
   * Compatibility adapter for legacy per-tenant poller calls.
   * Delegates to pollMailbox using Client Credentials.
   */
  async pollTenant(tenantId: string): Promise<{ processed: number; errors: string[] }> {
    return this.pollMailbox(tenantId);
  }

  /**
   * Main entrypoint for background polling.
   * Runs email polling and OneDrive polling in parallel/sequence every 2 minutes.
   */
  async pollAll(): Promise<{ emailProcessed: number; oneDriveProcessed: number; errors: string[] }> {
    if (this.isPolling) {
      this.logger.warn('Microsoft Graph poller is already running — skipping this tick');
      return { emailProcessed: 0, oneDriveProcessed: 0, errors: ['already-running'] };
    }

    if (!this.clientSecret) {
      this.logger.debug('MS_CLIENT_SECRET not configured — skipping Microsoft Graph polling');
      return { emailProcessed: 0, oneDriveProcessed: 0, errors: ['not-configured'] };
    }

    this.isPolling = true;
    this.stats.lastRunStatus = 'running';
    const errors: string[] = [];
    let emailProcessed = 0;
    let oneDriveProcessed = 0;

    try {
      const tenant = await this.resolveActiveTenant();
      if (!tenant) {
        this.logger.warn('No active tenant found for Microsoft Graph ingestion');
        return { emailProcessed: 0, oneDriveProcessed: 0, errors: ['no-active-tenant'] };
      }

      // 1. Ingest emails from financeiro@hotelequip.pt -> Faturas
      try {
        const mailResult = await this.pollMailbox(tenant.id);
        emailProcessed = mailResult.processed;
        if (mailResult.errors.length > 0) {
          errors.push(...mailResult.errors);
        }
      } catch (err) {
        const msg = `Email polling error: ${(err as Error).message}`;
        this.logger.error(msg);
        errors.push(msg);
        this.recordError(msg, 'email');
      }

      // 2. Ingest files from OneDrive -> /DocFlow/Entrada
      try {
        const oneDriveResult = await this.pollOneDrive(tenant.id);
        oneDriveProcessed = oneDriveResult.processed;
        if (oneDriveResult.errors.length > 0) {
          errors.push(...oneDriveResult.errors);
        }
      } catch (err) {
        const msg = `OneDrive polling error: ${(err as Error).message}`;
        this.logger.error(msg);
        errors.push(msg);
        this.recordError(msg, 'onedrive');
      }

      this.stats.lastRunAt = new Date();
      this.stats.lastRunStatus = errors.length === 0 ? 'success' : 'partial';
      this.stats.emailsRead += emailProcessed;
      this.stats.documentsIngested += emailProcessed + oneDriveProcessed;
      this.stats.oneDriveFilesIngested += oneDriveProcessed;

      return { emailProcessed, oneDriveProcessed, errors };
    } catch (err) {
      const msg = (err as Error).message;
      this.logger.error(`Microsoft Graph poller fatal error: ${msg}`);
      this.stats.lastRunAt = new Date();
      this.stats.lastRunStatus = 'error';
      this.recordError(msg, 'global');
      return { emailProcessed, oneDriveProcessed, errors: [msg] };
    } finally {
      this.isPolling = false;
    }
  }

  /**
   * Polls the target mailbox (financeiro@hotelequip.pt), reads unread messages
   * in the 'Faturas' folder, extracts attachments (including nested itemAttachments),
   * ingests them into InboundService, marks messages as read, and moves them to 'Faturas/Processado'.
   */
  async pollMailbox(tenantId: string): Promise<{ processed: number; errors: string[] }> {
    const token = await this.getAccessToken();
    const userPath = await this.resolveUserPath(token);
    const folderId = await this.resolveFaturasFolderId(token, userPath);
    if (!folderId) {
      return { processed: 0, errors: [`Folder '${this.mailFolderName}' not found`] };
    }

    const processadoId = await this.resolveProcessadoFolderId(token, userPath, folderId);

    const listUrl = `${GRAPH_BASE}/${userPath}/mailFolders/${folderId}/messages?$filter=isRead eq false&$expand=attachments&$top=25`;
    const res = await this.fetchWithAuth(listUrl, token);

    if (res.status === 403) {
      this.logger.warn(
        `[OutlookService] 403 Forbidden accessing ${userPath}. ApplicationAccessPolicy restriction active — expected.`,
      );
      return { processed: 0, errors: ['403 ApplicationAccessPolicy restriction'] };
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Failed to list messages (${res.status}): ${detail}`);
    }

    const data = (await res.json()) as { value: any[] };
    const messages = data.value ?? [];
    let totalProcessed = 0;
    const errors: string[] = [];

    for (const msg of messages) {
      try {
        const senderAddress = msg.from?.emailAddress?.address?.toLowerCase().trim() || '';

        // 1. Verificação de remetente bloqueado (Blacklist)
        if (this.isSenderBlocked(senderAddress)) {
          this.logger.log(
            `[OutlookService] Email '${msg.subject}' from blocked sender '${senderAddress}' — marked as read and ignored`,
          );
          await this.markAndMoveMessage(token, userPath, msg.id, processadoId);
          continue;
        }

        // 2. Verificação de whitelist (se ativa)
        if (!this.isSenderAllowed(senderAddress)) {
          this.logger.log(
            `[OutlookService] Email '${msg.subject}' from '${senderAddress}' not in allowed senders list — marked as read and ignored`,
          );
          await this.markAndMoveMessage(token, userPath, msg.id, processadoId);
          continue;
        }

        // 3. Pré-filtro de assunto: ignorar emails manifestamente não-fiscais (marketing, newsletters, etc.)
        if (this.shouldIgnoreEmailSubject(msg.subject)) {
          this.logger.log(
            `[OutlookService] Email '${msg.subject}' ignored by subject heuristic (non-invoice/marketing) — marked as read and moved to Processado`,
          );
          await this.markAndMoveMessage(token, userPath, msg.id, processadoId);
          continue;
        }

        const extracted = await this.extractAttachmentsFromMessage(token, userPath, msg);

        if (extracted.attachments.length > 0) {
          for (const item of extracted.attachments) {
            await this.inbound.ingestFiles(
              tenantId,
              [
                {
                  buffer: item.buffer,
                  originalname: item.originalname,
                  mimetype: item.mimetype,
                  size: item.size,
                },
              ],
              DocumentOrigin.EMAIL,
              item.metadata as Prisma.InputJsonValue,
            );
            totalProcessed++;
          }
          this.logger.log(
            `[OutlookService] Successfully ingested ${extracted.attachments.length} attachment(s) from '${msg.subject}'`,
          );
          // After processing: mark as read and move to Processado folder
          await this.markAndMoveMessage(token, userPath, msg.id, processadoId);
        } else if (extracted.downloadLinks.length > 0) {
          // Links in body without direct attachments: register for review
          this.stats.pendingConfirmationLinks.unshift({
            date: new Date(msg.receivedDateTime || Date.now()),
            from: msg.from?.emailAddress?.address || 'unknown',
            subject: msg.subject || 'Sem assunto',
            links: extracted.downloadLinks,
            messageId: msg.id,
          });
          if (this.stats.pendingConfirmationLinks.length > 30) {
            this.stats.pendingConfirmationLinks.pop();
          }
          this.logger.log(
            `[OutlookService] Email '${msg.subject}' from ${msg.from?.emailAddress?.address} has ${extracted.downloadLinks.length} download links and no attachments — flagged for review`,
          );
          await this.markAndMoveMessage(token, userPath, msg.id, processadoId);
        } else {
          this.logger.log(
            `[OutlookService] Email '${msg.subject}' (id: ${msg.id}) had no valid invoice attachments or links — marked as read and moved to Processado`,
          );
          await this.markAndMoveMessage(token, userPath, msg.id, processadoId);
        }
      } catch (err) {
        const msgError = `Message ${msg.id} processing failed: ${(err as Error).message}`;
        this.logger.error(msgError);
        errors.push(msgError);
        this.recordError(msgError, 'email-message');
      }
    }

    return { processed: totalProcessed, errors };
  }

  /**
   * Polls OneDrive folder /DocFlow/Entrada, downloads files, ingests via InboundService,
   * and moves processed files to /DocFlow/Processados.
   */
  async pollOneDrive(tenantId: string): Promise<{ processed: number; errors: string[] }> {
    const token = await this.getAccessToken();
    const userPath = await this.resolveUserPath(token);
    const driveBase = await this.resolveDriveBasePath(token, userPath);

    const entradaUrl = `${GRAPH_BASE}/${driveBase}/root:${this.oneDriveEntradaPath}:/children`;
    const res = await this.fetchWithAuth(entradaUrl, token);

    if (res.status === 404) {
      // Folder doesn't exist yet — attempt to ensure folders exist
      await this.ensureOneDriveFolders(token, driveBase).catch(() => undefined);
      return { processed: 0, errors: [] };
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Failed to list OneDrive children (${res.status}): ${detail}`);
    }

    const data = (await res.json()) as { value: any[] };
    const items = data.value ?? [];
    let processed = 0;
    const errors: string[] = [];

    const processadosFolderId = await this.resolveOneDriveProcessadosId(token, driveBase);

    for (const item of items) {
      // Only process files, skip subfolders
      if (!item.file) continue;

      const ext = (item.name || '').split('.').pop()?.toLowerCase();
      if (!ext || !ACCEPTED_EXTS.has(ext)) {
        continue;
      }

      const check = this.shouldIgnoreAttachment(item.name || '', item.file?.mimeType || '', item.size || 0);
      if (check.ignore) {
        this.logger.log(`[OneDrive] Skipping non-invoice file '${item.name}': ${check.reason}`);
        continue;
      }

      if (item.size <= 0 || item.size > MAX_FILE_SIZE) {
        continue;
      }

      try {
        const contentUrl = `${GRAPH_BASE}/${driveBase}/items/${item.id}/content`;
        const contentRes = await this.fetchWithAuth(contentUrl, token);
        if (!contentRes.ok) {
          throw new Error(`Failed to download file ${item.name} (${contentRes.status})`);
        }

        const buffer = Buffer.from(await contentRes.arrayBuffer());
        const mimetype = item.file?.mimeType || this.mimeForExt(ext);

        await this.inbound.ingestFiles(
          tenantId,
          [
            {
              buffer,
              originalname: item.name,
              mimetype,
              size: buffer.length,
            },
          ],
          DocumentOrigin.ONEDRIVE,
          {
            source: 'onedrive',
            itemId: item.id,
            originalPath: `${this.oneDriveEntradaPath}/${item.name}`,
            createdAt: item.createdDateTime,
            lastModifiedAt: item.lastModifiedDateTime,
          } as Prisma.InputJsonValue,
        );

        processed++;

        // Copy or Move to /DocFlow/Processados if destination folder exists
        if (processadosFolderId) {
          if (this.oneDriveMoveEnabled) {
            const moveUrl = `${GRAPH_BASE}/${driveBase}/items/${item.id}`;
            await this.fetchWithAuth(moveUrl, token, {
              method: 'PATCH',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                parentReference: { id: processadosFolderId },
                name: item.name,
              }),
            });
          } else {
            const copyUrl = `${GRAPH_BASE}/${driveBase}/items/${item.id}/copy`;
            await this.fetchWithAuth(copyUrl, token, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                parentReference: { id: processadosFolderId },
                name: item.name,
              }),
            });
          }
        }
      } catch (err) {
        const errMsg = `OneDrive file ${item.name} (${item.id}) failed: ${(err as Error).message}`;
        this.logger.error(errMsg);
        errors.push(errMsg);
        this.recordError(errMsg, 'onedrive-file');
      }
    }

    return { processed, errors };
  }

  /**
   * Recursively unpacks message attachments.
   * If an attachment is an itemAttachment (#microsoft.graph.itemAttachment / message/rfc822),
   * it fetches the item with attachments expanded and recurses, preserving original provenance.
   */
  async extractAttachmentsFromMessage(
    token: string,
    userPath: string,
    message: any,
  ): Promise<{ attachments: ExtractedEmailAttachment[]; downloadLinks: string[] }> {
    const results: ExtractedEmailAttachment[] = [];
    const downloadLinks = this.detectDownloadLinks(message.body?.content || '');

    // Collect recipient emails to deduce original receiving mailbox
    const topRecipients = (message.toRecipients || [])
      .map((r: any) => r.emailAddress?.address?.toLowerCase())
      .filter(Boolean);
    const topMailbox = this.findOriginalMailbox(topRecipients) || this.mailbox;

    const provenance = {
      originalSender: message.from?.emailAddress?.address,
      originalSubject: message.subject,
      originalDate: message.receivedDateTime,
      originalMailbox: topMailbox,
      internetMessageId: message.internetMessageId,
      graphMessageId: message.id,
    };

    const rawAttachments = message.attachments || [];

    for (const att of rawAttachments) {
      await this.processSingleAttachment(
        token,
        userPath,
        message.id,
        att,
        provenance,
        downloadLinks,
        results,
        0,
      );
    }

    return { attachments: results, downloadLinks };
  }

  private async processSingleAttachment(
    token: string,
    userPath: string,
    messageId: string,
    att: any,
    currentProvenance: any,
    downloadLinks: string[],
    results: ExtractedEmailAttachment[],
    depth: number,
  ): Promise<void> {
    if (depth > 5) return; // Prevent excessive recursion

    const odataType = att['@odata.type'] || '';
    const isItemAttachment =
      odataType === '#microsoft.graph.itemAttachment' ||
      att.contentType === 'message/rfc822';

    if (isItemAttachment) {
      // Fetch full expanded item attachment if item is missing or not fully expanded
      let item = att.item;
      if (!item || !item.attachments) {
        // In MS Graph OData, attachments belongs to microsoft.graph.message, not base outlookItem.
        // Try casting to microsoft.graph.message/attachments first, then fallback to item expansion.
        const expandUrlWithCast = `${GRAPH_BASE}/${userPath}/messages/${messageId}/attachments/${att.id}?$expand=microsoft.graph.itemAttachment/item($expand=microsoft.graph.message/attachments)`;
        let res = await this.fetchWithAuth(expandUrlWithCast, token);
        if (!res.ok) {
          const fallbackUrl = `${GRAPH_BASE}/${userPath}/messages/${messageId}/attachments/${att.id}?$expand=microsoft.graph.itemAttachment/item`;
          res = await this.fetchWithAuth(fallbackUrl, token);
        }
        if (res.ok) {
          const detailed = (await res.json()) as any;
          item = detailed.item;
        } else {
          const errDetail = await res.text().catch(() => '');
          this.logger.warn(`Failed to expand itemAttachment ${att.id} (${res.status}): ${errDetail}`);
        }
      }

      if (item) {
        const itemRecipients = (item.toRecipients || [])
          .map((r: any) => r.emailAddress?.address?.toLowerCase())
          .filter(Boolean);
        const itemMailbox = this.findOriginalMailbox(itemRecipients) || currentProvenance.originalMailbox;

        const nestedProvenance = {
          originalSender: item.from?.emailAddress?.address || currentProvenance.originalSender,
          originalSubject: item.subject || currentProvenance.originalSubject,
          originalDate: item.receivedDateTime || currentProvenance.originalDate,
          originalMailbox: itemMailbox,
          internetMessageId: item.internetMessageId || currentProvenance.internetMessageId,
          graphMessageId: messageId,
        };

        const itemAttachments = item.attachments || [];
        for (const nestedAtt of itemAttachments) {
          await this.processSingleAttachment(
            token,
            userPath,
            messageId,
            nestedAtt,
            nestedProvenance,
            downloadLinks,
            results,
            depth + 1,
          );
        }
      }
      return;
    }

    // Standard file attachment
    const filename = att.name || 'unnamed-attachment';
    const ext = filename.split('.').pop()?.toLowerCase();
    if (!ext || !ACCEPTED_EXTS.has(ext)) {
      return;
    }

    // Skip inline images, signatures, logos, and non-invoice attachments
    const check = this.shouldIgnoreAttachment(filename, att.contentType || '', att.size || 0, att.isInline);
    if (check.ignore) {
      this.logger.log(`[OutlookService] Skipping attachment '${filename}': ${check.reason}`);
      return;
    }

    if (att.size > MAX_FILE_SIZE) {
      this.logger.warn(`Attachment ${filename} exceeds max size (10MB) — skipped`);
      return;
    }

    let buffer: Buffer | null = null;
    if (att.contentBytes) {
      buffer = Buffer.from(att.contentBytes, 'base64');
    } else {
      const valUrl = `${GRAPH_BASE}/${userPath}/messages/${messageId}/attachments/${att.id}/$value`;
      const valRes = await this.fetchWithAuth(valUrl, token);
      if (valRes.ok) {
        buffer = Buffer.from(await valRes.arrayBuffer());
      }
    }

    if (buffer && buffer.length > 0) {
      results.push({
        buffer,
        originalname: filename,
        mimetype: att.contentType || this.mimeForExt(ext),
        size: buffer.length,
        metadata: {
          source: 'microsoft-graph-client-credentials',
          internetMessageId: currentProvenance.internetMessageId,
          graphMessageId: currentProvenance.graphMessageId,
          originalSender: currentProvenance.originalSender,
          originalSubject: currentProvenance.originalSubject,
          originalDate: currentProvenance.originalDate,
          originalMailbox: currentProvenance.originalMailbox,
          downloadLinks: downloadLinks.length > 0 ? downloadLinks : undefined,
        },
      });
    }
  }

  private async markAndMoveMessage(
    token: string,
    userPath: string,
    messageId: string,
    processadoFolderId: string | null,
  ): Promise<void> {
    // 1. Mark as read
    const patchUrl = `${GRAPH_BASE}/${userPath}/messages/${messageId}`;
    await this.fetchWithAuth(patchUrl, token, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ isRead: true }),
    }).catch(() => undefined);

    // 2. Move to Processado folder (only if move is enabled)
    if (this.mailMoveEnabled && processadoFolderId) {
      const moveUrl = `${GRAPH_BASE}/${userPath}/messages/${messageId}/move`;
      await this.fetchWithAuth(moveUrl, token, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ destinationId: processadoFolderId }),
      }).catch(() => undefined);
    }
  }

  private async markAsRead(token: string, userPath: string, messageId: string): Promise<void> {
    const patchUrl = `${GRAPH_BASE}/${userPath}/messages/${messageId}`;
    await this.fetchWithAuth(patchUrl, token, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ isRead: true }),
    }).catch(() => undefined);
  }

  private async resolveUserPath(token: string): Promise<string> {
    // Try UPN first
    const primary = `users/${encodeURIComponent(this.mailbox)}`;
    const checkUrl = `${GRAPH_BASE}/${primary}`;
    const res = await this.fetchWithAuth(checkUrl, token);
    if (res.ok || res.status === 403) {
      return primary;
    }
    // Fallback to internal ID
    return `users/${encodeURIComponent(this.mailboxIdFallback)}`;
  }

  private async resolveFaturasFolderId(token: string, userPath: string): Promise<string | null> {
    if (this.faturasFolderId) return this.faturasFolderId;

    const targetName = this.mailFolderName.toLowerCase();
    const url = `${GRAPH_BASE}/${userPath}/mailFolders?$top=50`;
    const res = await this.fetchWithAuth(url, token);
    if (!res.ok) return null;

    const data = (await res.json()) as { value: any[] };
    const folder = (data.value ?? []).find(
      (f) => (f.displayName || '').trim().toLowerCase() === targetName,
    );
    if (folder) {
      this.faturasFolderId = folder.id;
      return folder.id;
    }
    return null;
  }

  private async resolveProcessadoFolderId(
    token: string,
    userPath: string,
    faturasFolderId: string,
  ): Promise<string | null> {
    if (this.processadoFolderId) return this.processadoFolderId;

    const url = `${GRAPH_BASE}/${userPath}/mailFolders/${faturasFolderId}/childFolders?$top=20`;
    const res = await this.fetchWithAuth(url, token);
    if (res.ok) {
      const data = (await res.json()) as { value: any[] };
      const sub = (data.value ?? []).find(
        (f) => (f.displayName || '').trim().toLowerCase() === 'processado',
      );
      if (sub) {
        this.processadoFolderId = sub.id;
        return sub.id;
      }
    }

    // Try creating 'Processado' if not found
    try {
      const createUrl = `${GRAPH_BASE}/${userPath}/mailFolders/${faturasFolderId}/childFolders`;
      const createRes = await this.fetchWithAuth(createUrl, token, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ displayName: 'Processado' }),
      });
      if (createRes.ok) {
        const created = (await createRes.json()) as any;
        this.processadoFolderId = created.id;
        return created.id;
      }
    } catch {
      // Ignored
    }
    return null;
  }

  private async resolveDriveBasePath(token: string, userPath: string): Promise<string> {
    if (this.cachedDriveBasePath) return this.cachedDriveBasePath;

    if (process.env.ONEDRIVE_DRIVE_TARGET) {
      this.cachedDriveBasePath = process.env.ONEDRIVE_DRIVE_TARGET;
      return this.cachedDriveBasePath;
    }

    if (process.env.ONEDRIVE_USER) {
      this.cachedDriveBasePath = `users/${encodeURIComponent(process.env.ONEDRIVE_USER)}/drive`;
      return this.cachedDriveBasePath;
    }

    // Try userPath drive first
    const userDriveUrl = `${GRAPH_BASE}/${userPath}/drive`;
    const res = await this.fetchWithAuth(userDriveUrl, token);
    if (res.ok) {
      this.cachedDriveBasePath = `${userPath}/drive`;
      return this.cachedDriveBasePath;
    }

    // Fallback to organization root SharePoint/OneDrive drive
    const siteDriveUrl = `${GRAPH_BASE}/sites/root/drive`;
    const siteRes = await this.fetchWithAuth(siteDriveUrl, token);
    if (siteRes.ok) {
      this.logger.log(
        '[OutlookService] Mailbox has no personal drive (mysite) — using organization SharePoint/OneDrive root drive (sites/root/drive)',
      );
      this.cachedDriveBasePath = 'sites/root/drive';
      return this.cachedDriveBasePath;
    }

    return `${userPath}/drive`;
  }

  private async resolveOneDriveProcessadosId(token: string, driveBase: string): Promise<string | null> {
    if (this.oneDriveProcessadosFolderId) return this.oneDriveProcessadosFolderId;

    const url = `${GRAPH_BASE}/${driveBase}/root:${this.oneDriveProcessadosPath}`;
    const res = await this.fetchWithAuth(url, token);
    if (res.ok) {
      const data = (await res.json()) as any;
      this.oneDriveProcessadosFolderId = data.id;
      return data.id;
    }

    // Create the folder if not found
    try {
      const parentPath = '/DocFlow';
      const createUrl = `${GRAPH_BASE}/${driveBase}/root:${parentPath}:/children`;
      const createRes = await this.fetchWithAuth(createUrl, token, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Processados', folder: {} }),
      });
      if (createRes.ok) {
        const created = (await createRes.json()) as any;
        this.oneDriveProcessadosFolderId = created.id;
        return created.id;
      }
    } catch {
      // Ignored
    }
    return null;
  }

  private async ensureOneDriveFolders(token: string, driveBase: string): Promise<void> {
    const rootChildrenUrl = `${GRAPH_BASE}/${driveBase}/root/children`;
    await this.fetchWithAuth(rootChildrenUrl, token, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'DocFlow', folder: {} }),
    }).catch(() => undefined);

    const docflowChildrenUrl = `${GRAPH_BASE}/${driveBase}/root:/DocFlow:/children`;
    await Promise.allSettled([
      this.fetchWithAuth(docflowChildrenUrl, token, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Entrada', folder: {} }),
      }),
      this.fetchWithAuth(docflowChildrenUrl, token, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Processados', folder: {} }),
      }),
    ]);
  }

  private async fetchWithAuth(url: string, token: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers || {});
    headers.set('authorization', `Bearer ${token}`);

    let res = await fetchWithTimeout(url, { ...init, headers });

    // Handle 429 Too Many Requests (Rate limit)
    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get('retry-after') || '3', 10);
      this.logger.warn(`Microsoft Graph 429 Rate limit — retrying after ${retryAfter}s`);
      await new Promise((r) => setTimeout(r, Math.min(retryAfter, 10) * 1000));
      res = await fetchWithTimeout(url, { ...init, headers });
    }

    // Handle 401 Unauthorized (Expired token during long run)
    if (res.status === 401) {
      const freshToken = await this.getAccessToken(true);
      headers.set('authorization', `Bearer ${freshToken}`);
      res = await fetchWithTimeout(url, { ...init, headers });
    }

    return res;
  }

  private findOriginalMailbox(recipients: string[]): string | undefined {
    const KNOWN = ['geral@', 'apoio.cliente@', 'faturacao@', 'orcamentos@', 'financeiro@'];
    for (const r of recipients) {
      for (const k of KNOWN) {
        if (r.includes(k)) return r;
      }
    }
    return recipients[0];
  }

  private detectDownloadLinks(bodyContent: string): string[] {
    if (!bodyContent) return [];
    const urlRegex = /(https?:\/\/[^\s"'<>]+)/gi;
    const matches = bodyContent.match(urlRegex) || [];
    const unique = Array.from(new Set(matches));

    return unique.filter((url) => {
      const lower = url.toLowerCase();
      return (
        lower.includes('moloni.pt') ||
        lower.includes('toconline.pt') ||
        lower.includes('sage.com') ||
        lower.includes('jasminsoftware') ||
        lower.includes('primaverabss') ||
        lower.includes('invoice') ||
        lower.includes('fatura') ||
        lower.includes('download')
      );
    });
  }

  /**
   * Helper que determina se um anexo de email deve ser descartado
   * por ser assinatura, logotipo, ícone de rede social, catálogo ou documento não fiscal.
   */
  shouldIgnoreAttachment(
    filename: string,
    contentType: string,
    size: number,
    isInline?: boolean,
  ): { ignore: boolean; reason?: string } {
    if (isInline === true) {
      return { ignore: true, reason: 'inline_attachment' };
    }

    const lowerName = (filename || '').toLowerCase().trim();
    const isImage =
      (contentType || '').startsWith('image/') ||
      /\.(png|jpg|jpeg|gif|webp|bmp)$/i.test(lowerName);

    // Imagens minúsculas (< 25 KB) são invariavelmente ícones de assinatura, pixels ou logos
    if (isImage && size < 25 * 1024) {
      return { ignore: true, reason: `image_below_minimum_size:${size}B` };
    }

    // Nomes típicos de assinaturas, rodapés e redes sociais
    for (const pattern of JUNK_ATTACHMENT_PATTERNS) {
      if (pattern.test(lowerName)) {
        return { ignore: true, reason: `junk_filename_pattern:${pattern}` };
      }
    }

    // Documentos que manifestamente não são faturas (catálogos, termos, manuais, newsletters)
    for (const pattern of NON_INVOICE_DOC_PATTERNS) {
      if (pattern.test(lowerName)) {
        return { ignore: true, reason: `non_invoice_document_pattern:${pattern}` };
      }
    }

    return { ignore: false };
  }

  /**
   * Verifica se o assunto do email é manifestamente não-fatura (ex.: publicidade, boas festas, etc.)
   */
  shouldIgnoreEmailSubject(subject: string): boolean {
    const s = (subject || '').toLowerCase().trim();
    if (!s) return false;

    // Se tiver palavras fiscais ou de faturação explícitas, nunca ignora
    const hasInvoiceSignal =
      /\b(fatura|factura|ft\s*\d|fr\s*\d|nc\s*\d|nd\s*\d|invoice|recibo|vencimento|pagamento|d[eé]bito|cr[eé]dito|conta\s*corrente|encomenda)\b/i.test(
        s,
      );
    if (hasInvoiceSignal) return false;

    return SPAM_SUBJECT_PATTERNS.some((pattern) => pattern.test(s));
  }

  private async resolveActiveTenant(): Promise<{ id: string } | null> {
    // Look up by demo NIF first
    const byNif = await this.prisma.tenant.findFirst({
      where: { nif: '515208566', active: true },
      select: { id: true },
    });
    if (byNif) return byNif;

    // Fallback to first active tenant
    return this.prisma.tenant.findFirst({
      where: { active: true },
      select: { id: true },
    });
  }

  private recordError(message: string, source: string) {
    this.stats.recentErrors.unshift({
      timestamp: new Date(),
      message,
      source,
    });
    if (this.stats.recentErrors.length > 20) {
      this.stats.recentErrors.pop();
    }
  }

  private mimeForExt(ext: string): string {
    switch (ext) {
      case 'pdf':
        return 'application/pdf';
      case 'jpg':
      case 'jpeg':
        return 'image/jpeg';
      case 'png':
        return 'image/png';
      case 'heic':
        return 'image/heic';
      case 'heif':
        return 'image/heif';
      case 'docx':
        return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      default:
        return 'application/octet-stream';
    }
  }
}
