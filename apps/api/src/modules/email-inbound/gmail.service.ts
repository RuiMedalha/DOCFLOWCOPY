import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { DocumentOrigin, Prisma } from '@prisma/client';
import { OAuthStateStore } from '../integrations/core/oauth-state.store';
import { PrismaService } from '../../prisma/prisma.service';
import { InboundService } from '../inbound/inbound.service';
import { decryptJson, encryptJson } from './oauth-crypto';
import { fetchWithTimeout } from './fetch-with-timeout';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1';
const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
].join(' ');

interface GmailTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number; // epoch ms
  scope?: string;
  email?: string;
}

interface GmailMessageListItem {
  id: string;
  threadId: string;
}

interface GmailMessage {
  id: string;
  threadId: string;
  snippet?: string;
  payload?: GmailPayload;
}

interface GmailPayload {
  headers?: Array<{ name?: string; value?: string }>;
  parts?: GmailPayload[];
  body?: { data?: string; attachmentId?: string };
  mimeType?: string;
  filename?: string;
}

const ACCEPTED_EXTS = new Set(['pdf', 'png', 'jpg', 'jpeg', 'docx']);
const MAX_FILE_SIZE = 10 * 1024 * 1024;

/**
 * GmailService — Google OAuth web-server flow + Gmail API polling for
 * PDF/PNG/JPG/DOCX attachments.
 *
 * The service uses the same envelope crypto (`encryptJson`/`decryptJson`)
 * as the existing IMAP path, and persists OAuth credentials in the
 * `Integration` table keyed by `provider = 'gmail'`.
 */
@Injectable()
export class GmailService {
  private readonly logger = new Logger(GmailService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly oauthStates: OAuthStateStore,
    @Inject(forwardRef(() => InboundService))
    private readonly inbound: InboundService,
  ) {}

  /** Build the Google authorize() URL and persist the CSRF state. */
  async generateAuthUrl(tenantId: string, userId: string): Promise<{ authUrl: string; state: string }> {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const redirectUri =
      process.env.GOOGLE_REDIRECT_URI ??
      'http://localhost:4000/api/v1/email-inbound/oauth/google/callback';
    if (!clientId) {
      throw new Error('GOOGLE_CLIENT_ID env var is required');
    }
    const state = randomBytes(32).toString('hex');
    await this.oauthStates.put(tenantId, 'gmail', state, redirectUri);

    const url = new URL(GOOGLE_AUTH_URL);
    url.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      access_type: 'offline',
      // Force the consent screen so Google issues a refresh_token.
      // Without `prompt=consent` a returning user only gets an access
      // token and polling breaks in <1h.
      prompt: 'consent',
      scope: GMAIL_SCOPES,
      state,
    }).toString();

    return { authUrl: url.toString(), state };
  }

  /**
   * Exchange the authorization code for an access token + refresh token
   * and persist the encrypted credentials on the tenant's `Integration`
   * row.
   */
  async handleCallback(
    code: string,
    state: string,
    tenantId: string,
    _userId: string,
  ): Promise<{ provider: 'gmail'; email?: string }> {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const redirectUri =
      process.env.GOOGLE_REDIRECT_URI ??
      'http://localhost:4000/api/v1/email-inbound/oauth/google/callback';
    if (!clientId || !clientSecret) {
      throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required');
    }

    const tokenRes = await fetchWithTimeout(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });
    if (!tokenRes.ok) {
      const detail = await tokenRes.text().catch(() => '');
      throw new Error(`Google token exchange failed: ${tokenRes.status} ${detail}`);
    }
    const body = (await tokenRes.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
      scope?: string;
    };

    let email: string | undefined;
    try {
      const profile = await this.fetchUserEmail(body.access_token);
      email = profile;
    } catch (err) {
      this.logger.warn(`Gmail userinfo fetch failed: ${(err as Error).message}`);
    }

    const tokens: GmailTokens = {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresAt: Date.now() + body.expires_in * 1000,
      scope: body.scope,
      email,
    };

    await this.prisma.integration.upsert({
      where: { tenantId_provider: { tenantId, provider: 'gmail' } },
      create: {
        tenantId,
        provider: 'gmail',
        credentials: encryptJson(tokens),
        isActive: true,
      },
      update: {
        credentials: encryptJson(tokens),
        isActive: true,
        lastSyncAt: null,
        lastSyncStatus: null,
      },
    });
    return { provider: 'gmail', email };
  }

  /** Pull unread attachments for one tenant. Returns created count. */
  async pollTenant(tenantId: string): Promise<{ processed: number; errors: string[] }> {
    const integration = await this.prisma.integration.findUnique({
      where: { tenantId_provider: { tenantId, provider: 'gmail' } },
    });
    if (!integration?.isActive) return { processed: 0, errors: ['not-configured'] };

    const tokens = decryptJson<GmailTokens>(String(integration.credentials));
    const fresh = await this.refreshAccessTokenIfNeeded(tenantId, tokens);
    const errors: string[] = [];
    let processed = 0;

    let messages: GmailMessageListItem[] = [];
    try {
      const listUrl = new URL(`${GMAIL_API_BASE}/users/me/messages`);
      listUrl.search = new URLSearchParams({
        q: 'has:attachment is:unread',
        maxResults: '25',
      }).toString();
      const res = await fetchWithTimeout(listUrl.toString(), {
        headers: { authorization: `Bearer ${fresh.accessToken}` },
      });
      if (!res.ok) throw new Error(`gmail list ${res.status}`);
      const body = (await res.json()) as { messages?: GmailMessageListItem[] };
      messages = body.messages ?? [];
    } catch (err) {
      errors.push((err as Error).message);
    }

    for (const meta of messages) {
      try {
        const message = await this.fetchMessage(fresh.accessToken, meta.id);
        const attachments = this.collectAttachments(message.payload);
        const headers = this.headersToRecord(message.payload?.headers ?? []);
        const accept = attachments
          .filter((a) => this.acceptByExt(a.filename))
          .filter((a) => a.size <= MAX_FILE_SIZE);
        if (accept.length > 0) {
          const inboundFiles = await Promise.all(
            accept.map(async (a) => {
              const data = await this.fetchAttachment(
                fresh.accessToken,
                meta.id,
                a.attachmentId,
              );
              return {
                buffer: Buffer.from(data, 'base64'),
                originalname: a.filename,
                mimetype: a.mimeType,
                size: a.size,
              };
            }),
          );
          if (inboundFiles.length > 0) {
            await this.inbound.ingestFiles(
              tenantId,
              inboundFiles,
              DocumentOrigin.GMAIL,
              {
                source: 'gmail-poller',
                gmailMessageId: meta.id,
                gmailThreadId: meta.threadId,
                from: headers['from'] ?? null,
                subject: headers['subject'] ?? null,
              } as Prisma.InputJsonValue,
            );
            processed += inboundFiles.length;
          }
        }
      } catch (err) {
        errors.push(`${meta.id}: ${(err as Error).message}`);
      }
    }

    await this.prisma.integration.update({
      where: { tenantId_provider: { tenantId, provider: 'gmail' } },
      data: {
        lastSyncAt: new Date(),
        lastSyncStatus: errors.length === 0 ? 'success' : 'partial',
      },
    });
    return { processed, errors };
  }

  private async refreshAccessTokenIfNeeded(
    tenantId: string,
    tokens: GmailTokens,
  ): Promise<GmailTokens> {
    const REFRESH_SKEW_MS = 60_000;
    if (!tokens.refreshToken || tokens.expiresAt - Date.now() > REFRESH_SKEW_MS) {
      return tokens;
    }
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required');
    }
    const res = await fetchWithTimeout(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: tokens.refreshToken,
        grant_type: 'refresh_token',
      }),
    });
    if (!res.ok) throw new Error(`gmail refresh ${res.status}`);
    const body = (await res.json()) as { access_token: string; expires_in: number; scope?: string };
    const next: GmailTokens = {
      ...tokens,
      accessToken: body.access_token,
      expiresAt: Date.now() + body.expires_in * 1000,
      scope: body.scope ?? tokens.scope,
    };
    await this.prisma.integration.update({
      where: { tenantId_provider: { tenantId, provider: 'gmail' } },
      data: { credentials: encryptJson(next) },
    });
    return next;
  }

  private async fetchUserEmail(accessToken: string): Promise<string | undefined> {
    const res = await fetchWithTimeout('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) throw new Error(`userinfo ${res.status}`);
    const body = (await res.json()) as { email?: string };
    return body.email;
  }

  private async fetchMessage(accessToken: string, id: string): Promise<GmailMessage> {
    const res = await fetchWithTimeout(
      `${GMAIL_API_BASE}/users/me/messages/${id}?format=full`,
      { headers: { authorization: `Bearer ${accessToken}` } },
    );
    if (!res.ok) throw new Error(`gmail message ${res.status}`);
    return (await res.json()) as GmailMessage;
  }

  private async fetchAttachment(accessToken: string, messageId: string, attachmentId: string): Promise<string> {
    const res = await fetchWithTimeout(
      `${GMAIL_API_BASE}/users/me/messages/${messageId}/attachments/${attachmentId}`,
      { headers: { authorization: `Bearer ${accessToken}` } },
    );
    if (!res.ok) throw new Error(`gmail attachment ${res.status}`);
    const body = (await res.json()) as { data: string; size: number };
    return body.data;
  }

  private collectAttachments(
    payload: GmailPayload | undefined,
    acc: Array<{ filename: string; mimeType: string; attachmentId: string; size: number }> = [],
  ): Array<{ filename: string; mimeType: string; attachmentId: string; size: number }> {
    if (!payload) return acc;
    if (payload.filename && payload.body?.attachmentId) {
      acc.push({
        filename: payload.filename,
        mimeType: payload.mimeType ?? 'application/octet-stream',
        attachmentId: payload.body.attachmentId,
        size: 0,
      });
    }
    if (payload.parts) {
      for (const part of payload.parts) {
        this.collectAttachments(part, acc);
      }
    }
    return acc;
  }

  private acceptByExt(filename: string | undefined): boolean {
    if (!filename) return false;
    const ext = filename.split('.').pop()?.toLowerCase();
    return !!ext && ACCEPTED_EXTS.has(ext);
  }

  private headersToRecord(headers: Array<{ name?: string; value?: string }>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const h of headers) {
      if (h.name && h.value) out[h.name.toLowerCase()] = h.value;
    }
    return out;
  }
}
