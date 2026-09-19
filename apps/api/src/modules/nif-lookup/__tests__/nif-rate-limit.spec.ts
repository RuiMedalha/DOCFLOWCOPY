import { NifLookupService } from '../nif-lookup.service';

/**
 * Sprint 1.C — rate-limit invariant.
 *
 * The brief pins 10 req/min per tenant. The 11th call MUST throw
 * a sentinel error that the controller maps to HTTP 429. The
 * test pins the count directly so a future tweak to the limit
 * fails loudly (the test should be updated alongside the constant).
 */

const TENANT_ID = 'tenant-A';
const USER_ID = 'user-1';

function makeSvc(): NifLookupService {
  return new NifLookupService({ log: jest.fn(async () => undefined) });
}

describe('NifLookupService — rate limit', () => {
  it('throws on the 11th call within the same minute window', async () => {
    const svc = makeSvc();
    svc.resetForTests();

    // Stub fetch so the upstream calls don't hang on real DNS.
    // @ts-expect-error — global.fetch shim
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => '',
    });
    try {
      // 10 calls inside the same minute window must succeed.
      for (let i = 0; i < 10; i += 1) {
        const result = await svc.lookup(TENANT_ID, USER_ID, '515208566');
        expect(result.nif).toBe('515208566');
      }

      // The 11th call throws the sentinel — the controller maps
      // this to HTTP 429.
      let thrown: Error | null = null;
      try {
        await svc.lookup(TENANT_ID, USER_ID, '515208566');
      } catch (err) {
        thrown = err as Error;
      }
      expect(thrown).not.toBeNull();
      expect(thrown!.message.startsWith('RATE_LIMIT:')).toBe(true);
    } finally {
      // @ts-expect-error
      delete (global as any).fetch;
    }
  });

  it('rate limit is per-tenant — a second tenant keeps its own budget', async () => {
    // @ts-expect-error — global.fetch shim
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => '',
    });
    try {
      const svc = makeSvc();
      svc.resetForTests();

      // Saturate tenant-A's budget.
      for (let i = 0; i < 10; i += 1) {
        await svc.lookup('tenant-A', USER_ID, '515208566');
      }
      let tenantA11th: Error | null = null;
      try {
        await svc.lookup('tenant-A', USER_ID, '515208566');
      } catch (err) {
        tenantA11th = err as Error;
      }
      expect(tenantA11th).not.toBeNull();
      expect(tenantA11th!.message.startsWith('RATE_LIMIT:')).toBe(true);

      // tenant-B is fresh — its 1st call still works.
      const b1 = await svc.lookup('tenant-B', USER_ID, '515208566');
      expect(b1.nif).toBe('515208566');
    } finally {
      // @ts-expect-error
      delete (global as any).fetch;
    }
  });
});
