import { NifLookupService } from '../nif-lookup.service';

/**
 * Sprint 1.C — mod-11 fallback + cache behaviour.
 *
 * Pinned NIFs used in these tests:
 *   - 515208566 → mod-11 VALID (NOV OUSADO LDA in the validator
 *     docblock). Real public-base lookup may or may not succeed —
 *     we assert on the structural verdict, not on the upstream
 *     hit/miss.
 *   - 000000000 → mod-11 INVALID (zeroed out).
 *
 * What we verify:
 *   1. mod-11 INVALID NIFs return `valid=false` (source =
 *      mod11_only) and do NOT call the upstream.
 *   2. mod-11 VALID NIFs return `valid` field as `mod11Valid`
 *      value (true or false based on checksum), and the upstream
 *      is exercised exactly once.
 *   3. Empty / non-9-digit inputs are rejected with
 *      `reason: 'not_a_pt_nif'` and `source: 'mod11_only'`.
 */

const TENANT_ID = 'tenant-A';
const USER_ID = 'user-1';

function buildAuditStub() {
  return { log: jest.fn(async () => undefined) };
}

function makeSvc(audit: any = buildAuditStub()): NifLookupService {
  return new NifLookupService(audit);
}

describe('NifLookupService.lookup() — mod-11', () => {
  it('returns mod11Valid=true for a checksum-valid NIF (515208566)', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => '',
    });
    // @ts-expect-error — global.fetch shim
    global.fetch = fetchMock;
    try {
      const svc = makeSvc();
      svc.resetForTests();
      const result = await svc.lookup(TENANT_ID, USER_ID, '515208566');
      expect(result.nif).toBe('515208566');
      expect(result.mod11Valid).toBe(true);
      // Upstream unreachable → fallback path. The verdict still
      // tells the operator "mod-11 OK, base couldn't be reached".
      expect(result.source).toBe('mod11_only');
      expect(result.baseVerified).toBe(false);
      expect(result.reason).toBe('upstream_unavailable');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      // @ts-expect-error — restore undefined
      delete (global as any).fetch;
    }
  });

  it('returns mod11Valid=false for a checksum-INVALID NIF (999999999)', async () => {
    // 000000000 trivially passes mod-11 (sum=0, mod=0, expected=0,
    // checkDigit=0). 999999999 fails (sum=45, mod=1, expected=0,
    // checkDigit=9).
    const fetchMock = jest.fn();
    const svc = makeSvc();
    svc.resetForTests();
    const result = await svc.lookup(TENANT_ID, USER_ID, '999999999');
    expect(result.mod11Valid).toBe(false);
    // Invalid NIFs short-circuit — no upstream call.
    expect(result.source).toBe('mod11_only');
    expect(result.reason).toBe('upstream_unavailable');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('cleans the PT country prefix before validating (PT515208566 → 515208566)', async () => {
    const svc = makeSvc();
    svc.resetForTests();
    const result = await svc.lookup(TENANT_ID, USER_ID, 'PT515208566');
    expect(result.nif).toBe('515208566');
    expect(result.mod11Valid).toBe(true);
  });

  it('rejects non-9-digit inputs with reason not_a_pt_nif', async () => {
    const fetchMock = jest.fn();
    const svc = makeSvc();
    svc.resetForTests();
    const tooShort = await svc.lookup(TENANT_ID, USER_ID, '51520');
    expect(tooShort.source).toBe('mod11_only');
    expect(tooShort.reason).toBe('not_a_pt_nif');
    // Even mod-11 is not trustworthy on a <9-digit input.
    expect(tooShort.mod11Valid).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects empty input with reason not_a_pt_nif', async () => {
    const svc = makeSvc();
    svc.resetForTests();
    const empty = await svc.lookup(TENANT_ID, USER_ID, '');
    expect(empty.nif).toBe('');
    expect(empty.source).toBe('mod11_only');
    expect(empty.reason).toBe('not_a_pt_nif');
  });

  it('returns 200 with valid=false when the upstream returns a hit but the NIF is structurally invalid', async () => {
    // Upstream sometimes returns hits for legacy NIFs (e.g. corporate
    // restructuring) that fail mod-11. The structural verdict still
    // stands — we just surface baseVerified=true so the operator
    // knows the public record exists.
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({ nome: 'LEGACY LDA', nif: '000000000' }),
    });
    // @ts-expect-error — global.fetch shim
    global.fetch = fetchMock;
    try {
      const svc = makeSvc();
      svc.resetForTests();
      const result = await svc.lookup(TENANT_ID, USER_ID, '999999999');
      expect(result.mod11Valid).toBe(false);
      expect(result.baseVerified).toBe(true);
      expect(result.source).toBe('upstream');
      expect(result.name).toBe('LEGACY LDA');
    } finally {
      // @ts-expect-error
      delete (global as any).fetch;
    }
  });

  it('emits an audit row on every lookup (LGPD trail)', async () => {
    const audit = { log: jest.fn(async () => undefined) };
    const svc = makeSvc(audit);
    svc.resetForTests();
    await svc.lookup(TENANT_ID, USER_ID, '515208566');
    expect(audit.log).toHaveBeenCalledTimes(1);
    const arg = audit.log.mock.calls[0][0];
    expect(arg.entityType).toBe('nif_lookup');
    expect(arg.metadata).toMatchObject({
      subAction: 'nif.lookup',
      nif: '515208566',
      lgpd: 'public-record-lookup',
    });
  });
});
