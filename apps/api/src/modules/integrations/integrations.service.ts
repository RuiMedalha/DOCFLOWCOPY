import {
  BadRequestException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { OAuthStateStore } from './core/oauth-state.store';
import { WebhookVerifier } from './core/webhook-verifier';
import {
  ProcessedOrder,
  WooOrder,
  WooProvider,
} from './providers/woo.provider';

type Credentials = Record<string, unknown>;

/**
 * L3 fix: per-provider whitelist of fields that are SAFE to return over the
 * test endpoint. The previous blacklist tried to enumerate every possible
 * sensitive key — a fragile approach. Only the listed fields (or those
 * explicitly opted-in via `KNOWN_NON_SECRET_KEYS`) ever leave the service.
 */
const SAFE_CREDENTIAL_FIELDS: Record<string, readonly string[]> = {
  toconline: ['client_id', 'apiUrl', 'oauthUrl', 'redirectUri'],
  ifthenpay: ['entidade', 'subentidade'],
  woocommerce: ['webhookUrl'],
  moloni: ['company_id'],
  sage: ['companyId'],
  quickbooks: ['realmId'],
};

const SAFE_CONFIG_FIELDS: readonly string[] = ['enabled', 'webhookUrl', 'lastSyncAt', 'lastSyncStatus', 'mode', 'environment'];

function pickWhitelisted(input: Credentials, whitelist: readonly string[]): Credentials {
  const out: Credentials = {};
  for (const key of whitelist) {
    if (input[key] !== undefined) out[key] = input[key];
  }
  return out;
}

@Injectable()
export class IntegrationsService {
  private readonly logger = new Logger(IntegrationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly oauthStates: OAuthStateStore,
    private readonly woo: WooProvider,
  ) {}

  /** Derive a 256-bit AES key from the env var. Throws if unset � no dev fallback. */
  private key(): Buffer {
    const envKey = process.env.INTEGRATION_ENC_KEY;
    if (!envKey) {
      throw new Error('INTEGRATION_ENC_KEY env var is required');
    }
    return createHash('sha256').update(envKey).digest();
  }

  private encrypt(v: Credentials): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key(), iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(v), 'utf8'), cipher.final()]);
    return `${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${data.toString('base64')}`;
  }

  private decrypt(v: string): Credentials {
    const [iv, tag, data] = v.split('.');
    const decipher = createDecipheriv('aes-256-gcm', this.key(), Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString()) as Credentials;
  }

  /**
   * L3 fix: returns ONLY the whitelisted non-sensitive fields for the given
   * provider. Unknown providers return an empty object rather than the raw
   * credentials, so a future provider that introduces a new secret key name
   * cannot leak through until the whitelist is updated.
   */
  private safe(c: Credentials, provider: string): Credentials {
    const whitelist = SAFE_CREDENTIAL_FIELDS[provider];
    if (!whitelist) return {};
    return pickWhitelisted(c, whitelist);
  }

  async configure(
    tenantId: string,
    userId: string,
    provider: string,
    dto: { credentials: Credentials; config?: Credentials },
  ) {
    const result = await this.prisma.integration.upsert({
      where: { tenantId_provider: { tenantId, provider } },
      create: {
        tenantId,
        provider,
        credentials: this.encrypt(dto.credentials),
        config: (dto.config as Prisma.InputJsonValue) ?? undefined,
      },
      update: {
        credentials: this.encrypt(dto.credentials),
        config: (dto.config as Prisma.InputJsonValue) ?? undefined,
        isActive: true,
      },
    });
    await this.audit.log({
      tenantId,
      userId,
      action: 'INTEGRATION_SYNC' as any,
      entityType: 'Integration',
      entityId: result.id,
      metadata: { provider, operation: 'configure' },
    });
    return {
      id: result.id,
      provider,
      isActive: result.isActive,
      config: result.config,
      lastSyncAt: result.lastSyncAt,
      lastSyncStatus: result.lastSyncStatus,
    };
  }

  async list(tenantId: string) {
    const rows = await this.prisma.integration.findMany({
      where: {
        tenantId,
        NOT: [
          { provider: { startsWith: '__state__:' } },
          { provider: 'ai_settings' },
        ],
      },
      orderBy: { provider: 'asc' },
    });
    return rows.map((r) => ({
      id: r.id,
      provider: r.provider,
      isActive: r.isActive,
      config: r.config,
      lastSyncAt: r.lastSyncAt,
      lastSyncStatus: r.lastSyncStatus,
    }));
  }

  async test(tenantId: string, provider: string) {
    const row = await this.get(tenantId, provider);
    return {
      provider,
      configured: true,
      credentials: this.safe(this.decrypt(String(row.credentials)), provider),
      config: pickWhitelisted((row.config as Credentials | null) ?? {}, SAFE_CONFIG_FIELDS),
    };
  }

  async authorize(tenantId: string, provider: string, redirectUri?: string) {
    const row = await this.get(tenantId, provider);
    const creds = this.decrypt(String(row.credentials));
    const state = randomBytes(24).toString('hex');
    const uri =
      redirectUri ??
      String(
        creds.redirectUri ??
          `${process.env.API_URL ?? 'http://localhost:4000/api/v1'}/integrations/${provider}/callback`,
      );
    // Persist the state through the OAuthStateStore so it survives
    // restarts and is shared across replicas.
    await this.oauthStates.put(tenantId, provider, state, uri);

    if (provider !== 'toconline') {
      return { authorizationUrl: null, state };
    }

    const authUrl = new URL(
      String(
        creds.oauthUrl ?? 'https://identity.toconline.pt/oauth/authorize',
      ),
    );
    authUrl.search = new URLSearchParams({
      response_type: 'code',
      client_id: String(creds.client_id ?? ''),
      redirect_uri: uri,
      scope: 'commercial',
      state,
    }).toString();
    return { authorizationUrl: authUrl.toString(), state };
  }

  async callback(provider: string, code: string, state: string) {
    const session = await this.oauthStates.consume(provider, state);
    if (!session || session.provider !== provider) {
      throw new UnauthorizedException('Invalid or expired OAuth state');
    }

    const row = await this.get(session.tenantId, provider);
    const creds = this.decrypt(String(row.credentials));

    if (code && creds.oauthUrl) {
      const tokenUrl = String(creds.oauthUrl).replace(/\/$/, '') + '/token';
      const response = await fetch(tokenUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: `Basic ${Buffer.from(`${creds.client_id}:${creds.client_secret}`).toString('base64')}`,
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: session.redirectUri,
          scope: 'commercial',
        }),
      });
      if (response.ok) {
        const data = (await response.json()) as Credentials;
        await this.prisma.integration.update({
          where: { id: row.id },
          data: { credentials: this.encrypt({ ...creds, ...data }) },
        });
      }
    }
    return { success: true, provider };
  }

  async sync(tenantId: string, userId: string, provider: string, payload?: Credentials) {
    const row = await this.get(tenantId, provider);
    let status = 'success';
    try {
      if (provider === 'toconline' && payload) {
        const creds = this.decrypt(String(row.credentials));
        const apiUrl = String(creds.apiUrl).replace(/\/$/, '') + '/api/v1/commercial_purchases_documents';
        const response = await fetch(apiUrl, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${creds.access_token}`,
            'content-type': 'application/vnd.api+json',
          },
          body: JSON.stringify(payload),
        });
        if (!response.ok) throw new Error('TOConline error');
      }
    } catch {
      status = 'error';
    }
    const updated = await this.prisma.integration.update({
      where: { id: row.id },
      data: { lastSyncAt: new Date(), lastSyncStatus: status },
    });
    await this.audit.log({
      tenantId,
      userId,
      action: 'INTEGRATION_SYNC' as any,
      entityType: 'Integration',
      entityId: row.id,
      metadata: { provider, status },
    });
    return {
      provider,
      status,
      lastSyncAt: updated.lastSyncAt,
      lastSyncStatus: updated.lastSyncStatus,
    };
  }

  /** Ifthenpay callback — validates anti-phishing key via timing-safe comparison. */
  async ifthenpay(query: Credentials) {
    const integrations = await this.prisma.integration.findMany({
      where: {
        provider: 'ifthenpay',
        isActive: true,
        NOT: { provider: { startsWith: '__state__:' } },
      },
    });
    const incomingKey = String(query.chave ?? '');
    const match = integrations.find((x) => {
      try {
        const creds = this.decrypt(String(x.credentials));
        const stored = Buffer.from(String(creds.antiPhishingKey ?? creds.key ?? ''));
        const incoming = Buffer.from(incomingKey);
        return (
          stored.length === incoming.length &&
          timingSafeEqual(stored, incoming) &&
          (!creds.entidade || String(creds.entidade) === String(query.entidade))
        );
      } catch {
        return false;
      }
    });
    if (!match) throw new UnauthorizedException('Invalid callback signature');

    const ref = String(query.referencia ?? query.reference ?? query.orderId ?? '');
    const amount = Number(String(query.valor ?? query.amount ?? '0').replace(',', '.'));
    const payment = await this.prisma.payment.findFirst({
      where: { tenantId: match.tenantId, reference: ref },
    });
    // M2 fix: require the callback amount to satisfy the outstanding balance
    // (no over/under-tolerance loophole). Equality within a sub-cent rounding
    // margin is allowed; a 0.01 EUR callback no longer marks a 100 EUR invoice
    // as paid. The state transition also writes an audit row so the
    // pending→paid change is tamper-evident.
    if (
      payment &&
      !Number.isNaN(amount) &&
      amount > 0 &&
      Math.abs(Number(payment.amount) - amount) < 0.01
    ) {
      await this.prisma.payment.update({
        where: { id: payment.id },
        data: {
          status: 'paid',
          provider: 'ifthenpay',
          externalId: ref,
          rawPayload: query as Prisma.InputJsonValue,
        },
      });
      await this.audit.log({
        tenantId: match.tenantId,
        userId: null,
        action: 'PAYMENT_CONFIRM' as any,
        entityType: 'Payment',
        entityId: payment.id,
        metadata: { provider: 'ifthenpay', reference: ref, amount },
      });
    }
    return 'OK';
  }

  /** WooCommerce webhook � validates HMAC-SHA256 signature. */
  async woocommerce(rawBody: string, signature: string, payload: Credentials) {
    const integrations = await this.prisma.integration.findMany({
      where: {
        provider: 'woocommerce',
        isActive: true,
        NOT: { provider: { startsWith: '__state__:' } },
      },
    });
    const match = integrations.find((x) => {
      try {
        const creds = this.decrypt(String(x.credentials));
        const secret = String(creds.webhookSecret ?? creds.secret ?? '');
        const expected = Buffer.from(
          createHmac('sha256', secret).update(rawBody).digest('base64'),
        );
        const received = Buffer.from(signature ?? '');
        return expected.length === received.length && timingSafeEqual(expected, received);
      } catch {
        return false;
      }
    });
    if (!match) throw new UnauthorizedException('Invalid webhook signature');
    return { accepted: true, orderId: payload.id, tenantId: match.tenantId };
  }

  /**
   * Verify the X-WC-Webhook-Signature against every active WooCommerce
   * integration using WebhookVerifier (the SendGrid/Mailgun/Stripe
   * pattern). Returns the tenant id on match; throws 401 on miss.
   */
  async verifyWooWebhook(rawBody: string, signature: string): Promise<string> {
    const integrations = await this.prisma.integration.findMany({
      where: { provider: 'woocommerce', isActive: true },
    });
    for (const x of integrations) {
      try {
        const creds = this.decrypt(String(x.credentials));
        const secret = String(
          creds.webhookSecret ?? creds.consumerSecret ?? creds.secret ?? '',
        );
        if (!secret) continue;
        const result = WebhookVerifier.verify(
          rawBody,
          signature,
          secret,
          'sha256',
        );
        if (result.valid) return x.tenantId;
      } catch {
        continue;
      }
    }
    throw new UnauthorizedException('Invalid WooCommerce webhook signature');
  }

  /** Process a verified WooCommerce order payload → Document + Party. */
  async processWooWebhook(
    tenantId: string,
    rawBody: string,
  ): Promise<ProcessedOrder | { ignored: true; reason: string }> {
    let order: WooOrder;
    try {
      order = JSON.parse(rawBody);
    } catch {
      return { ignored: true, reason: 'invalid-json' };
    }
    return this.woo.processOrder(tenantId, 'webhook', order, 'webhook');
  }

  /** Manual sync — pulls orders since the last sync and ingests them. */
  async syncWooOrders(tenantId: string, userId: string) {
    const row = await this.get(tenantId, 'woocommerce');
    const creds = this.decrypt(String(row.credentials));
    const orders = await this.woo.fetchOrders(tenantId, {
      storeUrl: String(creds.storeUrl ?? ''),
      consumerKey: String(creds.consumerKey ?? ''),
      consumerSecret: String(creds.consumerSecret ?? ''),
      perPage: 100,
    });
    let created = 0;
    let skipped = 0;
    for (const order of orders) {
      const out = await this.woo.processOrder(tenantId, userId, order, 'sync');
      if (out.alreadyProcessed) skipped++;
      else created++;
    }
    const updated = await this.prisma.integration.update({
      where: { id: row.id },
      data: { lastSyncAt: new Date(), lastSyncStatus: 'success' },
    });
    await this.audit.log({
      tenantId,
      userId,
      action: 'INTEGRATION_SYNC' as any,
      entityType: 'Integration',
      entityId: row.id,
      metadata: { provider: 'woocommerce', created, skipped },
    });
    return {
      provider: 'woocommerce',
      status: 'success',
      processed: orders.length,
      created,
      skipped,
      lastSyncAt: updated.lastSyncAt,
    };
  }

  private async get(tenantId: string, provider: string) {
    const row = await this.prisma.integration.findUnique({
      where: { tenantId_provider: { tenantId, provider } },
    });
    if (!row) throw new BadRequestException(`Integration ${provider} not configured`);
    return row;
  }
}