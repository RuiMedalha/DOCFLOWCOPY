import { ViesService, splitVat, resolvePartyVat, VIES_CACHE_TTL_MS } from "../vies.service";

/**
 * Fase 4 — VIES service: request shape, response mapping, 30-day cache,
 * error handling. `fetch` is stubbed; the real endpoint was verified with
 * curl on 2026-09-11 (ES B06612386 → valid).
 */
describe("ViesService (Fase 4)", () => {
  const realFetch = global.fetch;
  let calls: Array<{ url: string; body: unknown }>;
  const stub = (payload: unknown, status = 200) => {
    global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(init.body as string) : null });
      return { ok: status === 200, status, json: async () => payload } as Response;
    }) as unknown as typeof fetch;
  };
  beforeEach(() => { calls = []; });
  afterEach(() => { global.fetch = realFetch; });

  it("splitVat normalises spacing/case and maps GR→EL; rejects non-EU", () => {
    expect(splitVat(" es b06612386 ")).toEqual({ countryCode: "ES", vatNumber: "B06612386" });
    expect(splitVat("GR123456789")).toEqual({ countryCode: "EL", vatNumber: "123456789" });
    expect(splitVat("GB123456789")).toBeNull();
    expect(splitVat("500842019")).toBeNull();
  });

  it("calls the EC REST endpoint with {countryCode, vatNumber} and maps the answer", async () => {
    stub({ countryCode: "ES", vatNumber: "B06612386", valid: true, name: "CLIMA HOSTELERIA SL", address: "---" });
    const svc = new ViesService();
    const r = await svc.check("ESB06612386");
    expect(calls[0].url).toContain("/vies/rest-api/check-vat-number");
    expect(calls[0].body).toEqual({ countryCode: "ES", vatNumber: "B06612386" });
    expect(r).toMatchObject({ valid: true, name: "CLIMA HOSTELERIA SL", address: null, source: "vies" });
    expect(await svc.isValidated("ESB06612386")).toBe(true);
  });

  it("serves the second call from the 30-day memory cache (no network)", async () => {
    stub({ valid: true, name: "X", address: "Y" });
    const svc = new ViesService();
    await svc.check("FR04540090727");
    const again = await svc.check("FR 04540090727");
    expect(again?.source).toBe("cache");
    expect(calls).toHaveLength(1);
    expect(VIES_CACHE_TTL_MS).toBe(30 * 24 * 3600 * 1000);
  });

  it("force=true bypasses the cache", async () => {
    stub({ valid: true });
    const svc = new ViesService();
    await svc.check("DE123456789");
    await svc.check("DE123456789", { force: true });
    expect(calls).toHaveLength(2);
  });

  it("invalid VAT → valid=false, not cached as validated", async () => {
    stub({ valid: false });
    const svc = new ViesService();
    expect(await svc.isValidated("ESB00000000")).toBe(false);
  });

  it("HTTP/transport errors never throw and are not cached", async () => {
    stub({}, 503);
    const svc = new ViesService();
    const r = await svc.check("ESB06612386");
    expect(r?.source).toBe("error");
    expect(await svc.isValidated("ESB06612386")).toBe(false);
    expect(calls).toHaveLength(2); // error responses are retried, not cached
    global.fetch = jest.fn(async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch;
    const r2 = await svc.check("ESB06612386");
    expect(r2).toMatchObject({ source: "error", error: "transport" });
  });

  it("validateParty persists the answer and the VAT regime on the party", async () => {
    stub({ valid: true, name: "ARILEX SL", address: "BADAJOZ" });
    const update = jest.fn(async () => ({}));
    const updateMany = jest.fn(async () => ({ count: 0 }));
    const prisma = {
      party: {
        findFirst: jest.fn(async () => ({ id: "p1", vatNumber: "ESB06700785", nif: null, country: "ES" })),
        update,
        updateMany,
      },
    };
    const svc = new ViesService(prisma as never);
    const out = await svc.validateParty("t1", "p1");
    expect(out?.result?.valid).toBe(true);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "p1" },
        data: expect.objectContaining({ viesValid: true, viesName: "ARILEX SL", viesAddress: "BADAJOZ", vatRegime: "UE_REVERSE_CHARGE" }),
      }),
    );
  });

  /**
   * Fase 4.2 (P1.1) — bug real: a ficha do IKEA mostrava "Nome (VIES)"
   * e "Morada (VIES)" corretos, e a entidade continuava
   * "Fornecedor por identificar" com nome, morada, código postal e
   * cidade vazios. O VIES respondia; ninguém escrevia a resposta nos
   * campos que a ficha realmente mostra.
   */
  it("Fase 4.2 (P1.1): preenche nome + morada a partir do VIES quando o nome é genérico", async () => {
    stub({
      valid: true,
      name: "IKEA PORTUGAL MOVEIS E DECORAÇÃO LDA",
      address: "RUA 28 DE SETEMBRO, EN 250\nFRIELAS\n2660-001 FRIELAS",
    });
    const update = jest.fn(async () => ({}));
    const prisma = {
      party: {
        findFirst: jest.fn(async () => ({
          id: "p-ikea",
          vatNumber: "PT505416654",
          nif: "505416654",
          country: "PT",
          name: "Fornecedor por identificar",
          address: null,
          city: null,
          postalCode: null,
        })),
        update,
        updateMany: jest.fn(async () => ({ count: 0 })),
      },
    };
    const svc = new ViesService(prisma as never);
    await svc.validateParty("t1", "p-ikea");
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          name: "IKEA PORTUGAL MOVEIS E DECORAÇÃO LDA",
          postalCode: "2660-001",
          city: "FRIELAS",
        }),
      }),
    );
    const data = update.mock.calls[0][0].data;
    expect(data.address).toContain("RUA 28 DE SETEMBRO");
  });

  it("Fase 4.2 (P1.1): nunca sobrepõe um nome ou morada já confirmados", async () => {
    stub({ valid: true, name: "NOME OFICIAL DIFERENTE", address: "OUTRA MORADA\n1000-001 LISBOA" });
    const update = jest.fn(async () => ({}));
    const prisma = {
      party: {
        findFirst: jest.fn(async () => ({
          id: "p-confirmado",
          vatNumber: "PT500842019",
          nif: "500842019",
          country: "PT",
          name: "Miranda & Serra, SA", // já confirmado — nada genérico
          address: "Rua Real 1",
          city: "Porto",
          postalCode: "4000-001",
        })),
        update,
        updateMany: jest.fn(async () => ({ count: 0 })),
      },
    };
    const svc = new ViesService(prisma as never);
    await svc.validateParty("t1", "p-confirmado");
    const data = update.mock.calls[0][0].data;
    expect(data.name).toBeUndefined();
    expect(data.address).toBeUndefined();
    expect(data.city).toBeUndefined();
    expect(data.postalCode).toBeUndefined();
  });

  it("validateParty derives PT<nif> for a Portuguese party without vatNumber", async () => {
    stub({ valid: true, name: "MIRANDA & SERRA" });
    const prisma = {
      party: {
        findFirst: jest.fn(async () => ({ id: "p2", vatNumber: null, nif: "500842019", country: "PT" })),
        update: jest.fn(async () => ({})),
        updateMany: jest.fn(async () => ({ count: 0 })),
      },
    };
    const svc = new ViesService(prisma as never);
    await svc.validateParty("t1", "p2");
    expect(calls[0].body).toEqual({ countryCode: "PT", vatNumber: "500842019" });
    expect(prisma.party.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ vatRegime: "PT", vatNumber: "PT500842019" }) }),
    );
  });
});

/**
 * Fase 4.1 — bug real apanhado no smoke de produção: TODOS os
 * fornecedores estrangeiros apareciam como inválidos no VIES porque o
 * país era colado a um NIF-IVA que já o trazia (`ES` + `ESB09802059` =
 * `ESESB09802059`), e o valor corrompido ainda ficava gravado em
 * `vatNumber`.
 */
describe('resolvePartyVat() — Fase 4.1', () => {
  it('não duplica o prefixo de país num NIF-IVA que já o traz', () => {
    expect(resolvePartyVat({ nif: 'ESB09802059', country: 'ES' })).toBe('ESB09802059');
    expect(resolvePartyVat({ nif: 'FR04540090727', country: 'FR' })).toBe('FR04540090727');
    expect(resolvePartyVat({ nif: 'ESB20869152', country: 'PT' })).toBe('ESB20869152');
  });

  it('acrescenta o prefixo quando o NIF não o tem', () => {
    expect(resolvePartyVat({ nif: 'B09802059', country: 'ES' })).toBe('ESB09802059');
  });

  it('trata o NIF português de 9 dígitos', () => {
    expect(resolvePartyVat({ nif: '500842019', country: 'PT' })).toBe('PT500842019');
    expect(resolvePartyVat({ nif: '500842019' })).toBe('PT500842019');
  });

  it('prefere o vatNumber quando existe, normalizando-o', () => {
    expect(resolvePartyVat({ vatNumber: 'es-b098 020 59', nif: '999' })).toBe('ESB09802059');
  });

  it('devolve null quando não há por onde pegar', () => {
    expect(resolvePartyVat({})).toBeNull();
    expect(resolvePartyVat({ nif: 'ABC', country: 'US' })).toBeNull();
  });
});
