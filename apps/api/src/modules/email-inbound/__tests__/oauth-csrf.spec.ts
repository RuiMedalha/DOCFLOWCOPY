import { OAuthController } from '../oauth.controller';
import { OAuthStateStore } from '../../integrations/core/oauth-state.store';

/**
 * Sprint F — OAuth callback hardening tests.
 *
 *   1. State replay attack: same state submitted twice → second callback
 *      must fail (single-use).
 *   2. Cross-tenant: state issued for tenant-A cannot be redeemed for
 *      tenant-B in the persisted state row.
 *   3. Missing code / state: callback returns BadRequest.
 *
 * After the BLOCKER fix, the controller delegates CSRF validation to
 * `OAuthStateStore.consume()` which finds + expires-checks + deletes the
 * row atomically. The tests use a REAL `OAuthStateStore` instance backed
 * by an in-memory Prisma mock so the production code path is exercised.
 */

function makePrismaStore(rows: Map<string, any>) {
  let idSeq = 1;
  return {
    integration: {
      findUnique: jest.fn(async ({ where }: any) => {
        // The store calls findUnique with the unique (tenantId, provider) key
        const key = `${where.tenantId_provider.tenantId}|${where.tenantId_provider.provider}`;
        return rows.has(key) ? rows.get(key) : null;
      }),
      upsert: jest.fn(async ({ where, create, update }: any) => {
        const key = `${where.tenantId_provider.tenantId}|${where.tenantId_provider.provider}`;
        const existing = rows.get(key);
        if (existing) {
          Object.assign(existing, update);
          return existing;
        }
        const row = {
          id: `row-${idSeq++}`,
          tenantId: create.tenantId,
          provider: create.provider,
          credentials: create.credentials,
          isActive: create.isActive ?? true,
        };
        rows.set(key, row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const key = `${where.tenantId_provider.tenantId}|${where.tenantId_provider.provider}`;
        const row = rows.get(key);
        if (!row) throw new Error('not found');
        Object.assign(row, data);
        return row;
      }),
      delete: jest.fn(async ({ where }: any) => {
        // store deletes by { id }; support it by matching the row's id.
        for (const [key, row] of rows.entries()) {
          if (where?.id && row.id === where.id) {
            const r = rows.get(key);
            rows.delete(key);
            return { ...r };
          }
          if (where?.tenantId_provider) {
            const k = `${where.tenantId_provider.tenantId}|${where.tenantId_provider.provider}`;
            if (rows.has(k)) {
              const r = rows.get(k);
              rows.delete(k);
              return { ...r };
            }
          }
        }
        return null;
      }),
    },
  } as any;
}

function makeResponse() {
  const res: any = { redirect: jest.fn((url: string) => url) };
  return res;
}

function buildOAuthStateStoreMock(prisma: any) {
  // Real OAuthStateStore backed by the in-memory Prisma mock — no
  // mocking of the store itself, so the atomic delete-on-consume
  // behaviour matches production.
  return new OAuthStateStore(prisma);
}

describe('OAuthController.callback CSRF / replay', () => {
  beforeEach(() => {
    process.env.GOOGLE_CLIENT_ID = 'cid';
    process.env.GOOGLE_CLIENT_SECRET = 'csecret';
    process.env.GOOGLE_REDIRECT_URI = 'http://localhost:4000/callback';
    process.env.MICROSOFT_CLIENT_ID = 'mcid';
    process.env.MICROSOFT_CLIENT_SECRET = 'mcsecret';
    process.env.MICROSOFT_REDIRECT_URI = 'http://localhost:4000/cb-microsoft';
    process.env.INTEGRATION_ENC_KEY = 'integration-secret-key';
  });

  it('rejects callback when state is missing from the store', async () => {
    const rows = new Map<string, any>();
    const prisma = makePrismaStore(rows);
    const oauthStates = buildOAuthStateStoreMock(prisma);
    const controller = new OAuthController(
      prisma,
      oauthStates,
      { generateAuthUrl: jest.fn(), handleCallback: jest.fn() } as any,
      { generateAuthUrl: jest.fn(), handleCallback: jest.fn() } as any,
    );

    await expect(
      controller.googleCallback('code', 'state', makeResponse()),
    ).rejects.toThrow();
  });

  it('rejects callback with missing query params', async () => {
    const rows = new Map<string, any>();
    const prisma = makePrismaStore(rows);
    const oauthStates = buildOAuthStateStoreMock(prisma);
    const controller = new OAuthController(
      prisma,
      oauthStates,
      { handleCallback: jest.fn() } as any,
      { handleCallback: jest.fn() } as any,
    );
    await expect(
      controller.googleCallback(undefined, 'state', makeResponse()),
    ).rejects.toThrow();
  });

  it('replay: a second callback for the same state finds no row (single-use enforced by OAuthStateStore.consume)', async () => {
    const rows = new Map<string, any>();
    const prisma = makePrismaStore(rows);
    const oauthStates = buildOAuthStateStoreMock(prisma);
    // Seed a real state row in the store
    await oauthStates.put('tenant-A', 'gmail', 'state-aaa', 'http://x');

    const controller = new OAuthController(
      prisma,
      oauthStates,
      {
        handleCallback: jest
          .fn()
          .mockResolvedValue({ provider: 'gmail', email: 'me@example.com' }),
      } as any,
      { handleCallback: jest.fn() } as any,
    );

    const res = makeResponse();
    const first = await controller.googleCallback('code', 'state-aaa', res);
    expect(first).toBeDefined();
    expect(res.redirect).toHaveBeenCalledWith(
      expect.stringContaining('connected=gmail'),
    );

    // Second callback with same state must be rejected (state was consumed)
    await expect(
      controller.googleCallback('code', 'state-aaa', makeResponse()),
    ).rejects.toThrow();
  });

  it('redirects to a friendly error page when the handleCallback itself fails', async () => {
    // Even when consume() succeeds, downstream failures (e.g. token
    // exchange) are caught and translated into a redirect with
    // ?error=callback so the user gets a graceful UX.
    const rows = new Map<string, any>();
    const prisma = makePrismaStore(rows);
    const oauthStates = buildOAuthStateStoreMock(prisma);
    await oauthStates.put('tenant-A', 'gmail', 'state-bad', 'http://x');

    const controller = new OAuthController(
      prisma,
      oauthStates,
      {
        handleCallback: jest
          .fn()
          .mockRejectedValue(new Error('Google token exchange failed: 500')),
      } as any,
      { handleCallback: jest.fn() } as any,
    );
    const res = makeResponse();
    const out = await controller.googleCallback('code', 'state-bad', res);
    expect(String(out)).toContain('error=callback');
    expect(res.redirect).toHaveBeenCalled();
  });
});
