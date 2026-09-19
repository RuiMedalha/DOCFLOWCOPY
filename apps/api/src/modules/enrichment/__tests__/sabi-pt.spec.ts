import { ConfigService } from '@nestjs/config';
import { SabiPtProvider } from '../providers/sabi-pt.provider';

/**
 * Sprint I — Sabi PT provider tests.
 *
 * `fetch` is a global — we stub it per-test so the provider never
 * actually hits the public Sabi API. The ConfigService is faked
 * inline; we only need `SABI_PT_API_KEY` for these tests.
 */
describe('SabiPtProvider', () => {
  const makeProvider = (apiKey: string | null = 'test-key'): SabiPtProvider => {
    const config = {
      get: (k: string) => (k === 'SABI_PT_API_KEY' ? apiKey : null),
    } as unknown as ConfigService;
    return new SabiPtProvider(config);
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns manual_required when SABI_PT_API_KEY is unset', async () => {
    const p = makeProvider(null);
    const result = await p.fetch({ nif: '500000001', country: 'PT', iban: null });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('sabi_api_key_missing');
      expect(result.source).toBe('manual');
    }
  });

  it('returns manual_required when nif is missing', async () => {
    const p = makeProvider();
    const result = await p.fetch({ nif: null, country: 'PT', iban: 'PT50...' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('no_nif_no_iban');
    }
  });

  it('returns success + mapped fields when API returns 200', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        name: 'EMPRESA TESTE LDA',
        address: 'RUA DAS FLORES 1',
        postalCode: '1050-070',
        city: 'LISBOA',
        phone: '+351 210 000 000',
        mobile: '+351 910 000 000',
        email: 'info@teste.pt',
        website: 'https://teste.pt',
        cae: '62010',
        industry: 'Consultoria informática',
        status: 'active',
      }),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).fetch = fetchMock;
    const p = makeProvider();
    const result = await p.fetch({ nif: '500000001', country: 'PT', iban: null });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.source).toBe('sabi-pt');
      expect(result.fields.email).toBe('info@teste.pt');
      expect(result.fields.phone).toBe('+351 210 000 000');
      expect(result.fields.address).toBe('RUA DAS FLORES 1');
      expect(result.fields.postalCode).toBe('1050-070');
      expect(result.fields.city).toBe('LISBOA');
      expect(result.fields.website).toBe('https://teste.pt');
      expect(result.fields.industry).toBe('Consultoria informática');
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calledUrl = fetchMock.mock.calls[0][0];
    expect(calledUrl).toContain('/companies/500000001');
  });

  it('falls back to manual when the API returns 404', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).fetch = jest.fn().mockResolvedValue({ ok: false, status: 404 });
    const p = makeProvider();
    const result = await p.fetch({ nif: '999999999', country: 'PT', iban: null });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('sabi_404');
    }
  });

  it('falls back to manual on 5xx', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).fetch = jest.fn().mockResolvedValue({ ok: false, status: 503 });
    const p = makeProvider();
    const result = await p.fetch({ nif: '500000001', country: 'PT', iban: null });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('sabi_http_error');
    }
  });

  it('falls back to manual on transport error', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const p = makeProvider();
    const result = await p.fetch({ nif: '500000001', country: 'PT', iban: null });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('transport_error');
    }
  });

  it('falls back to manual on timeout (abort)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).fetch = jest.fn().mockRejectedValue(new Error('The user aborted a request.'));
    const p = makeProvider();
    const result = await p.fetch({ nif: '500000001', country: 'PT', iban: null });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('timeout');
    }
  });

  it('does not throw on partial response (missing fields → null)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        name: 'INCOMPLETA LDA',
        // email/phone/address missing entirely
      }),
    });
    const p = makeProvider();
    const result = await p.fetch({ nif: '500000001', country: 'PT', iban: null });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.fields.email).toBeNull();
      expect(result.fields.phone).toBeNull();
      expect(result.fields.address).toBeNull();
    }
  });
});
