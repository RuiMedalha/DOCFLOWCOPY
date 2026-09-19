import { NifLookupService } from '../nif-lookup.service';

/**
 * Sprint 1.C — cache behaviour.
 *
 * The service reads in-memory LRU first, then optional Redis.
 * For the unit test we use only the in-memory cache (no Redis
 * adapter bound). Two consecutive lookups against the same
 * (tenant, NIF) MUST result in exactly one upstream call —
 * the second one resolves from the cache and tags its source
 * `'cache'` instead of `'upstream'`.
 */

const TENANT_ID = 'tenant-A';
const USER_ID = 'user-1';

function buildAuditStub() {
  return { log: jest.fn(async () => undefined) };
}

describe('NifLookupService — cache hits', () => {
  it('only calls the upstream once for two consecutive lookups on the same NIF', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ nome: 'EDENOX LDA', morada: 'Rua A' }),
    });
    // @ts-expect-error — global.fetch shim
    global.fetch = fetchMock;
    try {
      const svc = new NifLookupService(buildAuditStub());
      svc.resetForTests();

      const first = await svc.lookup(TENANT_ID, USER_ID, '502782160');
      expect(first.source).toBe('upstream');
      expect(first.baseVerified).toBe(true);
      expect(first.name).toBe('EDENOX LDA');

      const second = await svc.lookup(TENANT_ID, USER_ID, '502782160');
      expect(second.source).toBe('cache');
      // Verdicts are byte-identical across cache hits so the UI
      // can compare against the audit row's payload.
      expect(second.baseVerified).toBe(first.baseVerified);
      expect(second.mod11Valid).toBe(first.mod11Valid);
      expect(second.name).toBe('EDENOX LDA');

      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      // @ts-expect-error
      delete (global as any).fetch;
    }
  });

  it('cache is per-tenant — different tenants do not share hits', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ nome: 'ACME' }),
    });
    // @ts-expect-error — global.fetch shim
    global.fetch = fetchMock;
    try {
      const svc = new NifLookupService(buildAuditStub());
      svc.resetForTests();

      const a = await svc.lookup('tenant-A', USER_ID, '515208566');
      const b = await svc.lookup('tenant-B', USER_ID, '515208566');
      // Both ran through `upstream` because the cache key includes
      // the tenant — the second tenant sees its own cache miss.
      expect(a.source).toBe('upstream');
      expect(b.source).toBe('upstream');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      // @ts-expect-error
      delete (global as any).fetch;
    }
  });

  it('cache misses when the upstream returns no hit (mod-11 only)', async () => {
    // When the upstream returns `{"valid": false}` (or any other
    // non-name-bearing payload) we still cache the negative
    // verdict — the next call resolves from cache without
    // re-hitting the base.
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ valid: false }),
    });
    // @ts-expect-error — global.fetch shim
    global.fetch = fetchMock;
    try {
      const svc = new NifLookupService(buildAuditStub());
      svc.resetForTests();

      const first = await svc.lookup(TENANT_ID, USER_ID, '515208566');
      expect(first.baseVerified).toBe(false);
      expect(first.source).toBe('mod11_only');

      const second = await svc.lookup(TENANT_ID, USER_ID, '515208566');
      expect(second.baseVerified).toBe(false);
      expect(second.source).toBe('cache');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      // @ts-expect-error
      delete (global as any).fetch;
    }
  });
});
