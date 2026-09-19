import { DocumentOrigin } from '@prisma/client';
import { GmailService } from '../gmail.service';
import { encryptJson } from '../oauth-crypto';

/**
 * Tests for GmailService — Google OAuth + Gmail API polling. Mocks
 * fetch entirely so no network calls are made and we can pin the
 * service-to-Integration persistence + the refresh-token lifecycle.
 */

const TENANT = 'tenant-gmail';
const FIXED_NOW = 1_700_000_000_000;

function makeFixture(opts: { tokenBody: any; integrationIsActive?: boolean } = {
  tokenBody: {
    access_token: 'access-1',
    refresh_token: 'refresh-1',
    expires_in: 3600,
    scope: 'gmail.readonly',
  },
}) {
  const integrations = new Map<string, any>();
  integrations.set(`gmail:${TENANT}`, {
    tenantId: TENANT,
    provider: 'gmail',
    credentials: encryptJson({
      accessToken: 'stale',
      refreshToken: 'refresh-1',
      expiresAt: FIXED_NOW - 1000 * 1000, // expired
      email: 'me@example.com',
    }),
    isActive: opts.integrationIsActive ?? true,
  });

  const prisma = {
    integration: {
      findUnique: jest.fn(async ({ where }: any) =>
        integrations.get(`${where.tenantId_provider.provider}:${where.tenantId_provider.tenantId}`) ?? null,
      ),
      upsert: jest.fn(async ({ where, create, update }: any) => {
        const key = `${where.tenantId_provider.provider}:${where.tenantId_provider.tenantId}`;
        if (integrations.has(key)) {
          Object.assign(integrations.get(key), update);
          return integrations.get(key);
        }
        const row = {
          tenantId: create.tenantId,
          provider: create.provider,
          credentials: create.credentials,
          isActive: create.isActive ?? true,
        };
        integrations.set(key, row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = integrations.get(`${where.tenantId_provider.provider}:${where.tenantId_provider.tenantId}`);
        if (!row) throw new Error('not found');
        Object.assign(row, data);
        return row;
      }),
    },
  } as any;

  const ingestCalls: any[] = [];
  const inbound = {
    ingestFiles: jest.fn(async (...args: any[]) => {
      ingestCalls.push(args);
      return [{ id: 'doc-1' }];
    }),
  } as any;

  return { prisma, integrations, ingestCalls, inbound };
}

describe('GmailService.handleCallback', () => {
  beforeEach(() => {
    process.env.GOOGLE_CLIENT_ID = 'cid';
    process.env.GOOGLE_CLIENT_SECRET = 'csecret';
    process.env.GOOGLE_REDIRECT_URI = 'http://localhost:4000/callback';
    process.env.INTEGRATION_ENC_KEY = 'integration-secret-key';
  });

  it('exchanges code for tokens and persists encrypted credentials', async () => {
    // Order: token endpoint first, then userinfo.
    const fetchMock = jest.fn().mockImplementation(async (url: any) => {
      const urlStr = String(url);
      if (urlStr.includes('oauth2.googleapis.com/token')) {
        return new Response(
          JSON.stringify({
            access_token: 'access-1',
            refresh_token: 'refresh-1',
            expires_in: 3600,
            scope: 'gmail.readonly',
          }),
          { status: 200 },
        );
      }
      if (urlStr.includes('openidconnect.googleapis.com')) {
        return new Response(
          JSON.stringify({ email: 'me@example.com' }),
          { status: 200 },
        );
      }
      return new Response('not found', { status: 404 });
    });

    (globalThis as any).fetch = fetchMock;

    const { prisma, integrations, ingestCalls, inbound } = makeFixture();
    const oauthStates = { put: jest.fn(async () => undefined) } as any;
    const service = new GmailService(prisma, oauthStates, inbound);

    const out = await service.handleCallback('code', 'state', TENANT, 'user-1');
    expect(out).toEqual({ provider: 'gmail', email: 'me@example.com' });
    const row = integrations.get(`gmail:${TENANT}`);
    expect(row.isActive).toBe(true);
    expect(String(row.credentials).split('.').length).toBe(3);
  });
});

describe('fetchWithTimeout', () => {
  let originalFetch: any;
  beforeEach(() => {
    originalFetch = (globalThis as any).fetch;
    process.env.INTEGRATION_ENC_KEY = 'integration-secret-key';
  });
  afterEach(() => {
    (globalThis as any).fetch = originalFetch;
  });

  it('rejects with an AbortError when the upstream hangs beyond the timeout', async () => {
    // Simulate a hanging upstream by attaching an abort listener and
    // rejecting manually. This exercises fetchWithTimeout's signal
    // wiring without depending on wall-clock waits.
    const hangingFetch = jest
      .fn()
      .mockImplementation((_url: any, opts: any) => {
        return new Promise((_resolve, reject) => {
          opts?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
      });
    (globalThis as any).fetch = hangingFetch;

    // Inline-import the helper for the unit test.
    const { fetchWithTimeout } = require('../fetch-with-timeout');
    await expect(
      fetchWithTimeout('http://example.test', {}, 50),
    ).rejects.toThrow();
    expect(hangingFetch).toHaveBeenCalled();
  });
});

describe('GmailService.pollTenant', () => {
  let originalFetch: any;
  beforeEach(() => {
    originalFetch = (globalThis as any).fetch;
    process.env.INTEGRATION_ENC_KEY = 'integration-secret-key';
  });
  afterEach(() => {
    (globalThis as any).fetch = originalFetch;
  });

  it('skips when integration is not active', async () => {
    const { prisma, ingestCalls, inbound } = makeFixture({ tokenBody: null as any, integrationIsActive: false });
    const oauthStates = { put: jest.fn() } as any;
    const service = new GmailService(prisma, oauthStates, inbound);
    const out = await service.pollTenant(TENANT);
    expect(out).toEqual({ processed: 0, errors: ['not-configured'] });
    expect(ingestCalls).toHaveLength(0);
  });

  it('refreshes expired tokens and ingests attachments as GMAIL origin', async () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(FIXED_NOW);

    const listJson = { messages: [{ id: 'm1', threadId: 't1' }] };
    const messageJson = {
      id: 'm1',
      threadId: 't1',
      payload: {
        headers: [
          { name: 'From', value: 'sender@example.com' },
          { name: 'Subject', value: 'Invoice 1' },
        ],
        parts: [
          {
            filename: 'invoice.pdf',
            mimeType: 'application/pdf',
            body: { attachmentId: 'att-1' },
          },
        ],
      },
    };
    const refreshJson = {
      access_token: 'refreshed-access',
      expires_in: 3600,
    };

    const fetchMock = jest.fn().mockImplementation(async (url: any) => {
      const urlStr = String(url);
      if (urlStr.includes('oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify(refreshJson), { status: 200 });
      }
      if (urlStr.includes('/users/me/messages?') || urlStr.includes('/users/me/messages&')) {
        return new Response(JSON.stringify(listJson), { status: 200 });
      }
      if (urlStr.includes('/messages/m1?format=full')) {
        return new Response(JSON.stringify(messageJson), { status: 200 });
      }
      if (urlStr.includes('/messages/m1/attachments/att-1')) {
        return new Response(JSON.stringify({ data: 'BASE64', size: 8 }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    });
    (globalThis as any).fetch = fetchMock;

    const { prisma, ingestCalls, inbound } = makeFixture();
    const oauthStates = { put: jest.fn() } as any;
    const service = new GmailService(prisma, oauthStates, inbound);

    const out = await service.pollTenant(TENANT);
    expect(out.processed).toBeGreaterThanOrEqual(1);
    expect(ingestCalls).toHaveLength(1);
    expect(ingestCalls[0][2]).toBe(DocumentOrigin.GMAIL);
    expect((ingestCalls[0][3] as any).source).toBe('gmail-poller');

    nowSpy.mockRestore();
  });
});
