import { ViesProvider } from '../providers/vies.provider';

/**
 * Sprint I — VIES provider tests.
 *
 * Same pattern as SabiPtProvider tests: stub global `fetch`, assert
 * the result shape + the manual-fallback reasons.
 */
describe('ViesProvider', () => {
  const makeProvider = (): ViesProvider => new ViesProvider();

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns manual when country is missing', async () => {
    const p = makeProvider();
    const result = await p.fetch({ nif: 'B12345678', country: null, iban: null });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('unknown_country');
    }
  });

  it('returns manual when nif is missing', async () => {
    const p = makeProvider();
    const result = await p.fetch({ nif: null, country: 'ES', iban: null });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('no_nif_no_iban');
    }
  });

  it('returns success + name + address when VIES returns valid=true', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        countryCode: 'ES',
        vatNumber: 'B12345678',
        valid: true,
        name: 'EMPRESA EJEMPLO SL',
        address: 'CALLE MAYOR 1, 28013 MADRID',
        requestIdentifier: 'REQ-12345',
      }),
    });
    const p = makeProvider();
    const result = await p.fetch({ nif: 'B12345678', country: 'ES', iban: null });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.source).toBe('vies');
      expect(result.fields.address).toBe('CALLE MAYOR 1');
      expect(result.fields.postalCode).toBe('28013');
      expect(result.fields.city).toBe('MADRID');
      // VIES never exposes email/phone/mobile/website/industry — they
      // stay null so only-fill-nulls doesn't accidentally zero out a
      // manually-entered phone.
      expect(result.fields.email).toBeNull();
      expect(result.fields.phone).toBeNull();
    }
  });

  it('converts Spanish VIES "---" name into null so invoice name is preserved', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        countryCode: 'ES',
        vatNumber: 'A08242851',
        valid: true,
        name: '---',
        address: 'CARRER DEL CASTANYET, 132, 08430 LA ROCA DEL VALLES',
      }),
    });
    const p = makeProvider();
    const result = await p.fetch({ nif: 'ESA08242851', country: 'ES', iban: null });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.fields.name).toBeNull();
      expect(result.fields.city).toBe('LA ROCA DEL VALLES');
    }
  });

  it('returns manual when VIES returns valid=false', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ valid: false }),
    });
    const p = makeProvider();
    const result = await p.fetch({ nif: 'B99999999', country: 'ES', iban: null });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('vies_invalid_vat');
    }
  });

  it('falls back to manual on 5xx', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).fetch = jest.fn().mockResolvedValue({ ok: false, status: 503 });
    const p = makeProvider();
    const result = await p.fetch({ nif: 'B12345678', country: 'ES', iban: null });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('vies_http_error');
    }
  });

  it('falls back to manual on transport error', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).fetch = jest.fn().mockRejectedValue(new Error('ECONNRESET'));
    const p = makeProvider();
    const result = await p.fetch({ nif: 'B12345678', country: 'ES', iban: null });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('transport_error');
    }
  });

  it('falls back to manual on timeout (abort)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).fetch = jest.fn().mockRejectedValue(new Error('The user aborted a request.'));
    const p = makeProvider();
    const result = await p.fetch({ nif: 'B12345678', country: 'ES', iban: null });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('timeout');
    }
  });

  it('posts the correct payload shape', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ valid: true, name: 'X', address: 'Y' }),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).fetch = fetchMock;
    const p = makeProvider();
    await p.fetch({ nif: 'B12345678', country: 'es', iban: null });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const callArgs = fetchMock.mock.calls[0];
    // Fase 4.2 (P1.1) — o sufixo `-service` era o endpoint errado
    // (devolvia HTTP de erro) e causava a contradição "vies_http_error"
    // ao lado de "Estado VIES: Válido" na mesma ficha. O endpoint certo
    // é o mesmo que o `ViesService` já usa (confirmado por curl).
    expect(callArgs[0]).toBe('https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-number');
    expect(callArgs[0]).not.toContain('-service');
    expect(callArgs[1].method).toBe('POST');
    expect(JSON.parse(callArgs[1].body)).toEqual({
      countryCode: 'ES', // uppercased
      vatNumber: 'B12345678',
    });
  });
});
