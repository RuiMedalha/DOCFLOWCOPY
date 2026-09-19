import { SupplierResolver } from "./supplier-resolver";

/**
 * In-memory Prisma stub scoped to the models SupplierResolver touches.
 * Mirrors the pattern used in parties.service.spec.ts — the unit tests
 * prove the resolver's logic (lookup → create → recurring bump) without
 * spinning up a real Postgres client.
 */

type PartyRow = {
  id: string;
  tenantId: string;
  type: string;
  name: string;
  nif: string | null;
  iban: string | null;
  address?: string | null;
  postalCode?: string | null;
  city?: string | null;
  phone?: string | null;
  email?: string | null;
  website?: string | null;
  country: string;
  isActive: boolean;
  isRecurring: boolean;
  isRecurringManualOverride: boolean;
  createdAt: Date;
  updatedAt: Date;
};

type DocumentRow = {
  id: string;
  tenantId: string;
  partyId: string | null;
};

const TENANT_ID = "tenant-resolver";

function buildPrismaStub() {
  const dbParties = new Map<string, PartyRow>();
  const dbDocuments = new Map<string, DocumentRow>();
  let partyCounter = 0;
  let docCounter = 0;

  const partyModel = {
    findFirst: jest.fn(async ({ where, select }: any) => {
      for (const p of dbParties.values()) {
        if (
          (!where?.tenantId || p.tenantId === where.tenantId) &&
          (!where?.id || p.id === where.id) &&
          (!where?.nif ||
            (where.nif.contains
              ? (p.nif ?? "").includes(where.nif.contains)
              : p.nif === where.nif)) &&
          (!where?.country || p.country === where.country) &&
          (!where?.iban || p.iban === where.iban) &&
          (!where?.type || p.type === where.type)
        ) {
          if (select) {
            const out: any = {};
            for (const k of Object.keys(select)) out[k] = (p as any)[k];
            return out;
          }
          return { ...p };
        }
      }
      return null;
    }),
    /**
     * Fase 4.1 — o resolver passou a procurar por nome normalizado
     * quando não há NIF validado (fallback que evita as três
     * `CreateInfor` que apareceram em produção).
     */
    findMany: jest.fn(async ({ where }: any) => {
      const out: any[] = [];
      for (const p of dbParties.values()) {
        if (
          (!where?.tenantId || p.tenantId === where.tenantId) &&
          (!where?.country || p.country === where.country) &&
          (!where?.type || p.type === where.type)
        ) {
          out.push({ id: p.id, name: p.name, nif: p.nif, isRecurring: p.isRecurring });
        }
      }
      return out;
    }),
    create: jest.fn(async ({ data }: any) => {
      const id = `party-${++partyCounter}`;
      const now = new Date();
      const row: any = {
        id,
        ...data,
        nif: data.nif ?? null,
        iban: data.iban ?? null,
        country: data.country ?? "PT",
        isActive: data.isActive ?? true,
        isRecurring: data.isRecurring ?? false,
        isRecurringManualOverride:
          data.isRecurringManualOverride ?? false,
        createdAt: now,
        updatedAt: now,
      };
      dbParties.set(id, row);
      return { ...row };
    }),
    update: jest.fn(async ({ where, data }: any) => {
      const row = dbParties.get(where.id);
      if (!row) throw new Error("party not found");
      Object.assign(row, data);
      row.updatedAt = new Date();
      return { ...row };
    }),
    /**
     * Audit §3 TOCTOU fix: refreshRecurringFlag now uses updateMany keyed
     * on `isRecurringManualOverride: false` for an atomic conditional
     * write. The in-memory stub mirrors real semantics — only update rows
     * that match ALL where-clause predicates, return { count }.
     */
    updateMany: jest.fn(async ({ where, data }: any) => {
      let count = 0;
      for (const p of dbParties.values()) {
        if (
          (!where?.id || p.id === where.id) &&
          (where?.isRecurringManualOverride === undefined ||
            (p as any).isRecurringManualOverride ===
              where.isRecurringManualOverride)
        ) {
          Object.assign(p, data);
          p.updatedAt = new Date();
          count++;
        }
      }
      return { count };
    }),
  };

  const documentModel = {
    count: jest.fn(async ({ where }: any) => {
      let n = 0;
      for (const d of dbDocuments.values()) {
        if (
          (!where?.tenantId || d.tenantId === where.tenantId) &&
          (!where?.partyId || d.partyId === where.partyId)
        )
          n++;
      }
      return n;
    }),
    create: jest.fn(async ({ data }: any) => {
      const id = `doc-${++docCounter}`;
      const row: DocumentRow = {
        id,
        tenantId: data.tenantId,
        partyId: data.partyId ?? null,
      };
      dbDocuments.set(id, row);
      return { ...row };
    }),
  };

  return {
    party: partyModel,
    document: documentModel,
    dbParties,
    dbDocuments,
  };
}

describe("SupplierResolver", () => {
  /**
   * Fase 4.2 (P0.1) — invariante duro: nunca criamos/ligamos um Party
   * FORNECEDOR com o NIF do próprio tenant (515208566, o fallback de
   * identidade quando a base não tem tenant configurado — o mesmo
   * usado em todos estes testes). Defesa em profundidade: mesmo que
   * `ensureSupplierCustomerSanity` deixe passar algo, esta é a última
   * linha antes de escrever na base.
   */
  it("Fase 4.2 (P0.1): BLOQUEIA a criação de um fornecedor com o NIF do próprio tenant", async () => {
    const prisma = buildPrismaStub();
    const resolver = new SupplierResolver(prisma as any);

    const result = await resolver.resolve({
      tenantId: TENANT_ID,
      country: "PT",
      supplierName: "NOV OUSADO UNIPESSOAL LDA",
      supplierNif: "515208566", // o nosso próprio NIF
      aiConfidence: 0.95,
    });

    expect(prisma.dbParties.size).toBe(0); // nada foi criado
    expect(result.party).toBeNull();
    expect(result.supplierReview).toBe(true);
    expect(result.reason).toBe("blocked_tenant_nif_as_supplier");
  });

  /**
   * Fase 4.2 (P0.4.5) — último recurso de identificação: um IBAN já
   * visto identifica o mesmo fornecedor mesmo quando não há NIF válido
   * nem um nome que normalize de forma reconhecível.
   */
  it("Fase 4.2 (P0.4.5): liga pelo IBAN já conhecido quando NIF e nome falham", async () => {
    const prisma = buildPrismaStub();
    const resolver = new SupplierResolver(prisma as any);

    // 1º documento: cria a Party com IBAN válido.
    const first = await resolver.resolve({
      tenantId: TENANT_ID,
      country: "PT",
      supplierName: "Fornecedor Genuino Lda",
      supplierNif: "502757191",
      iban: "PT50000201231234567890154",
      aiConfidence: 0.95,
    });
    expect(prisma.dbParties.size).toBe(1);

    // 2º documento: NIF ilegível (falha mod-11) e nome tão diferente
    // que a normalização não casa — só o IBAN sobrevive como sinal.
    const second = await resolver.resolve({
      tenantId: TENANT_ID,
      country: "PT",
      supplierName: "Nome Completamente Diferente Distribuicao",
      supplierNif: "999999999", // inválido
      iban: "PT50 0002 0123 1234 5678 9015 4",
      aiConfidence: 0.5,
    });

    expect(prisma.dbParties.size).toBe(1); // não criou uma segunda entidade
    expect(second.party?.id).toBe(first.party?.id);
  });

  it("creates a new Party on first supplier extraction with high confidence + valid PT NIF", async () => {
    const prisma = buildPrismaStub();
    const resolver = new SupplierResolver(prisma as any);

    const result = await resolver.resolve({
      tenantId: TENANT_ID,
      country: "PT",
      supplierName: "Empresa XPTO",
      supplierNif: "500697256",
      iban: "PT50 0002 0123 1234 5678 9015 4",
      aiConfidence: 0.92,
    });

    // Party was created (no duplicates).
    expect(prisma.dbParties.size).toBe(1);
    const party = Array.from(prisma.dbParties.values())[0];
    expect(party.tenantId).toBe(TENANT_ID);
    expect(party.country).toBe("PT");
    expect(party.nif).toBe("500697256");
    expect(party.isRecurring).toBe(false); // < 3 documents so far
    // Result linked the new party and signed off on it (no review needed).
    expect(result.party?.id).toBe(party.id);
    expect(result.party?.isRecurring).toBe(false);
    expect(result.supplierReview).toBe(false);
    expect(result.reason).toBe("created");
  });

  it("links to the SAME party on a re-upload with the same NIF (no duplicate created)", async () => {
    const prisma = buildPrismaStub();
    const resolver = new SupplierResolver(prisma as any);

    // First upload — creates the Party.
    const first = await resolver.resolve({
      tenantId: TENANT_ID,
      country: "PT",
      supplierName: "Empresa XPTO",
      supplierNif: "500697256",
      aiConfidence: 0.92,
    });
    expect(prisma.dbParties.size).toBe(1);
    expect(prisma.party.create).toHaveBeenCalledTimes(1);

    // Second upload with the same NIF — must NOT create a second Party.
    const second = await resolver.resolve({
      tenantId: TENANT_ID,
      country: "PT",
      supplierName: "Empresa XPTO (outra denominação)",
      supplierNif: "500697256",
      aiConfidence: 0.85,
    });
    expect(prisma.dbParties.size).toBe(1); // still just one party
    expect(prisma.party.create).toHaveBeenCalledTimes(1); // no extra create
    expect(second.party?.id).toBe(first.party?.id);
    expect(second.supplierReview).toBe(false);
    expect(second.reason).toBe("found");
  });

  it("flips isRecurring=true on the third upload for the same NIF", async () => {
    const prisma = buildPrismaStub();
    const resolver = new SupplierResolver(prisma as any);

    // Three uploads of the same supplier. Each call counts documents
    // attached to the party AFTER the link is set, so:
    //   - upload 1 → creates party, docCount=0 → not recurring
    //   - upload 2 → finds party, docCount=1 → not recurring
    //   - upload 3 → finds party, docCount=2 → not recurring (threshold = 3 docs)
    //
    // The Document.count() reads tenant-scoped documents linked to the
    // party. Because the helper itself does NOT create Document rows
    // (the caller — processDocumentAsync — does that after linking),
    // we simulate the side-effect by inserting Document rows in lockstep
    // with each resolver call to mirror the real pipeline.
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const result = await resolver.resolve({
        tenantId: TENANT_ID,
        country: "PT",
        supplierName: "Empresa XPTO",
        supplierNif: "500697256",
        aiConfidence: 0.9,
      });
      ids.push(result.party!.id);
      // Mirror what processDocumentAsync does — persist the Document row
      // linked to the resolved party. The resolver reads this count on
      // the NEXT call to decide whether to flip isRecurring.
      await prisma.document.create({
        data: {
          tenantId: TENANT_ID,
          partyId: result.party!.id,
        },
      });
    }

    expect(ids[0]).toBe(ids[1]);
    expect(ids[1]).toBe(ids[2]);
    const party = Array.from(prisma.dbParties.values())[0];
    expect(party.isRecurring).toBe(true);
    // Audit §3 TOCTOU fix: the auto-flip now uses updateMany keyed on
    // `isRecurringManualOverride: false` — NOT a naive party.update. A
    // regression to the old SELECT+UPDATE pair would re-open the TOCTOU
    // window audited 2026-09-03.
    expect(prisma.party.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: party.id,
          isRecurringManualOverride: false,
        },
        data: { isRecurring: true },
      }),
    );
    expect(prisma.party.update).not.toHaveBeenCalled();
  });

  it("sets supplierReview=true and still creates the Party when AI confidence < 0.8", async () => {
    const prisma = buildPrismaStub();
    const resolver = new SupplierResolver(prisma as any);

    const result = await resolver.resolve({
      tenantId: TENANT_ID,
      country: "PT",
      supplierName: "Fornecedor Baixa Confiança",
      supplierNif: "500697256", // valid PT NIF — confidence is the gate here
      aiConfidence: 0.6,
    });

    // Party still created — user rule: "EVERY supplier gets a Party".
    expect(prisma.dbParties.size).toBe(1);
    // But the result flagged review because confidence is below the floor.
    expect(result.supplierReview).toBe(true);
    expect(result.reason).toBe("created_review");
  });

  it("sets supplierReview=true and still creates the Party when NIF is invalid (mod-11 fail)", async () => {
    const prisma = buildPrismaStub();
    const resolver = new SupplierResolver(prisma as any);

    const result = await resolver.resolve({
      tenantId: TENANT_ID,
      country: "PT",
      supplierName: "Fornecedor NIF Inválido",
      // 999999999 — starts with 9 (irregular/other) so mod-11 still
      // checks out, but the leading-digit classifier marks it as an
      // irregular NIF and rejects it as a valid supplier identifier.
      supplierNif: "999999999",
      aiConfidence: 0.95,
    });

    expect(prisma.dbParties.size).toBe(1); // still created
    expect(result.supplierReview).toBe(true);
    // Invalid NIFs are stored as null on the row (validator refuses).
    const party = Array.from(prisma.dbParties.values())[0];
    expect(party.nif).toBeNull();
  });

  /**
   * Fase 4.1 — um NIF-IVA estrangeiro deixou de se tornar a identidade
   * do fornecedor só por ter a sintaxe certa. Sem confirmação do VIES
   * fica em `vatNumber` como texto não validado (`viesValid: null`) e a
   * coluna `nif` — que é a chave de identificação — não é preenchida.
   */
  it("keeps a foreign VAT as unvalidated text until VIES confirms it", async () => {
    const prisma = buildPrismaStub();
    const resolver = new SupplierResolver(prisma as any);

    const result = await resolver.resolve({
      tenantId: TENANT_ID,
      country: "FR",
      supplierName: "Société Française SARL",
      supplierVatId: "FR12345678901",
      aiConfidence: 0.91,
    });

    expect(prisma.dbParties.size).toBe(1);
    const party: any = Array.from(prisma.dbParties.values())[0];
    expect(party.country).toBe("FR");
    expect(party.nif).toBeNull();
    expect(party.vatNumber).toBe("FR12345678901");
    expect(party.viesValid).toBeNull();
    expect(result.party).not.toBeNull();
  });

  it("promotes a foreign VAT to the identity column once VIES returns official data", async () => {
    const prisma = buildPrismaStub();
    const viesProvider = {
      fetch: jest.fn(async () => ({
        ok: true,
        fields: { name: "SOCIETE FRANCAISE SARL", address: "1 Rue de Paris", city: "Paris", postalCode: "75001" },
      })),
    };
    const resolver = new SupplierResolver(prisma as any, undefined, viesProvider as any);

    await resolver.resolve({
      tenantId: TENANT_ID,
      country: "FR",
      supplierName: "Société Française SARL",
      supplierVatId: "FR12345678901",
      aiConfidence: 0.91,
    });

    const party: any = Array.from(prisma.dbParties.values())[0];
    expect(party.nif).toBe("FR12345678901");
    expect(party.vatNumber).toBe("FR12345678901");
    expect(party.viesValid).toBe(true);
  });

  /**
   * Fase 4.1 — a causa das três `CreateInfor` em produção: a IA trocou
   * um dígito do NIF, o módulo 11 falhou, não se gravou NIF nenhum e a
   * procura seguinte criou outra entidade. Agora o nome normalizado
   * apanha-a.
   */
  it("links to the existing party by normalized name when the AI's NIF fails mod-11", async () => {
    const prisma = buildPrismaStub();
    const resolver = new SupplierResolver(prisma as any);

    // 1º documento: NIF válido → cria a Party com NIF.
    await resolver.resolve({
      tenantId: TENANT_ID,
      country: "PT",
      supplierName: "CreateInfor",
      supplierNif: "507298608",
      aiConfidence: 0.95,
    });
    expect(prisma.dbParties.size).toBe(1);

    // 2º documento: mesma empresa, NIF mal lido (507290608 falha mod-11)
    // e nome com a forma jurídica — tem de ligar à MESMA Party.
    const again = await resolver.resolve({
      tenantId: TENANT_ID,
      country: "PT",
      supplierName: "CreateInfor, Lda",
      supplierNif: "507290608",
      aiConfidence: 0.95,
    });

    expect(prisma.dbParties.size).toBe(1);
    const party: any = Array.from(prisma.dbParties.values())[0];
    expect(again.party?.id).toBe(party.id);
    expect(party.nif).toBe("507298608");
    expect(again.supplierReview).toBe(true); // o NIF inválido continua a pedir revisão
  });

  /**
   * Fase 4.1 — o smoke em produção mostrou entidades estrangeiras com o
   * NIF-IVA na coluna `nif` mas `viesValid` nulo e regime PT: o resolver
   * só gravava a prova do VIES ao CRIAR a entidade, nunca ao reencontrar
   * uma já existente. Sem a prova, o identificador era inverificável.
   */
  it("records the VIES proof on an EXISTING party, not only when creating it", async () => {
    const prisma = buildPrismaStub();
    const viesProvider = {
      fetch: jest.fn(async () => ({ ok: true, fields: { name: "TEFCOLD ES SL" } })),
    };
    const resolver = new SupplierResolver(prisma as any, undefined, viesProvider as any);
    const input = {
      tenantId: TENANT_ID,
      country: "ES",
      supplierName: "TEFCOLD ES, S.L.",
      supplierVatId: "ESB09802059",
      aiConfidence: 0.95,
    };
    await resolver.resolve(input);
    // Simula a linha antiga: NIF-IVA gravado sem prova nenhuma.
    const party: any = Array.from(prisma.dbParties.values())[0];
    party.viesValid = null;
    party.vatNumber = null;
    party.vatRegime = "PT";

    await resolver.resolve(input); // segundo documento do mesmo fornecedor

    expect(prisma.dbParties.size).toBe(1);
    const after: any = Array.from(prisma.dbParties.values())[0];
    expect(after.viesValid).toBe(true);
    expect(after.vatNumber).toBe("ESB09802059");
    expect(after.vatRegime).toBe("UE_REVERSE_CHARGE");
    expect(after.viesValidatedAt).toBeInstanceOf(Date);
  });

  it("returns { party: null, supplierReview: true } on DB failure (no crash)", async () => {
    const prisma = buildPrismaStub();
    // Force every Party.create to throw — simulates a transient DB blip.
    prisma.party.create.mockRejectedValue(new Error("simulated db down"));
    // lookupParty also fails on findFirst — keep that working so the
    // helper reaches the create path.
    const resolver = new SupplierResolver(prisma as any);

    const result = await resolver.resolve({
      tenantId: TENANT_ID,
      country: "PT",
      supplierName: "Fornecedor com DB em baixo",
      supplierNif: "500697256",
      aiConfidence: 0.95,
    });

    // MUST NOT throw. MUST surface the failure safely.
    expect(result.party).toBeNull();
    expect(result.supplierReview).toBe(true);
    expect(result.reason).toMatch(/party_create_failed|resolve_threw/);
  });

  it("respects multi-tenant scoping: a party for tenant A is invisible to tenant B", async () => {
    const prisma = buildPrismaStub();
    const resolver = new SupplierResolver(prisma as any);

    // Create on tenant A.
    const a = await resolver.resolve({
      tenantId: "tenant-A",
      country: "PT",
      supplierName: "Fornecedor A",
      supplierNif: "500697256",
      aiConfidence: 0.9,
    });
    expect(a.party?.id).toBeDefined();

    // Tenant B looking up the same NIF must NOT find tenant A's row.
    const b = await resolver.resolve({
      tenantId: "tenant-B",
      country: "PT",
      supplierName: "Fornecedor B",
      supplierNif: "500697256",
      aiConfidence: 0.9,
    });
    expect(b.party?.id).not.toBe(a.party?.id);
    expect(prisma.dbParties.size).toBe(2);
  });

  it("auto-enriches PT supplier with official name and address from NifLookupService", async () => {
    const prisma = buildPrismaStub();
    const mockNifLookup = {
      lookup: jest.fn().mockResolvedValue({
        nif: "500697256",
        mod11Valid: true,
        baseVerified: true,
        name: "EDP Comercial - Comercialização de Energia, S.A.",
        address: "Av. 24 de Julho 12, 1200-480 Lisboa",
        source: "upstream",
        fetchedAt: new Date().toISOString(),
      }),
    };

    const resolver = new SupplierResolver(prisma as any, mockNifLookup as any);

    const result = await resolver.resolve({
      tenantId: TENANT_ID,
      country: "PT",
      supplierName: "EDP",
      supplierNif: "500697256",
      aiConfidence: 0.95,
    });

    expect(mockNifLookup.lookup).toHaveBeenCalledWith(TENANT_ID, "system", "500697256");
    expect(result.party).toBeDefined();
    const party = Array.from(prisma.dbParties.values())[0];
    expect(party.name).toBe("EDP Comercial - Comercialização de Energia, S.A.");
    expect(party.address).toBe("Av. 24 de Julho 12");
    expect((party as any).postalCode).toBe("1200-480");
    expect((party as any).city).toBe("Lisboa");
  });

  it("auto-enriches existing supplier filling empty address and official name", async () => {
    const prisma = buildPrismaStub();
    // Existing party with provisional name and empty address
    await prisma.party.create({
      data: {
        tenantId: TENANT_ID,
        type: "FORNECEDOR",
        name: "Fornecedor por identificar",
        nif: "500697256",
        country: "PT",
      },
    });

    const mockNifLookup = {
      lookup: jest.fn().mockResolvedValue({
        nif: "500697256",
        mod11Valid: true,
        baseVerified: true,
        name: "Razão Social Oficial Lda",
        address: "Rua Central 100, 4000-001 Porto",
        source: "upstream",
        fetchedAt: new Date().toISOString(),
      }),
    };

    const resolver = new SupplierResolver(prisma as any, mockNifLookup as any);

    const result = await resolver.resolve({
      tenantId: TENANT_ID,
      country: "PT",
      supplierName: "Fornecedor por identificar",
      supplierNif: "500697256",
      aiConfidence: 0.9,
    });

    expect(result.reason).toBe("found");
    expect(prisma.party.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          name: "Razão Social Oficial Lda",
          address: "Rua Central 100",
          postalCode: "4000-001",
          city: "Porto",
        }),
      }),
    );
  });

  it("auto-enriches EU supplier using ViesProvider", async () => {
    const prisma = buildPrismaStub();
    const mockVies = {
      fetch: jest.fn().mockResolvedValue({
        ok: true,
        source: "vies",
        fields: {
          name: "Acme Europe SL",
          address: "Calle Mayor 1, 28013 Madrid",
          city: "Madrid",
          postalCode: "28013",
        },
      }),
    };

    const resolver = new SupplierResolver(prisma as any, undefined, mockVies as any);

    const result = await resolver.resolve({
      tenantId: TENANT_ID,
      country: "ES",
      supplierName: "Acme",
      supplierVatId: "ESB12345678",
      aiConfidence: 0.95,
    });

    expect(mockVies.fetch).toHaveBeenCalledWith(
      expect.objectContaining({
        country: "ES",
        nif: "B12345678",
      }),
    );
    expect(result.party).toBeDefined();
    const party = Array.from(prisma.dbParties.values())[0];
    expect(party.name).toBe("Acme Europe SL");
    expect(party.address).toBe("Calle Mayor 1");
    expect((party as any).city).toBe("Madrid");
    expect((party as any).postalCode).toBe("28013");
  });

  it("preserves invoice supplierName when Spanish VIES returns no name ('---')", async () => {
    const prisma = buildPrismaStub();
    const mockVies = {
      fetch: jest.fn().mockResolvedValue({
        ok: true,
        source: "vies",
        fields: {
          name: null, // VIES Spain suppresses trader name
          address: "Carrer del Castanyet, 132, 08430 Santa Coloma de Farners",
          city: "Santa Coloma de Farners",
          postalCode: "08430",
        },
      }),
    };

    const resolver = new SupplierResolver(prisma as any, undefined, mockVies as any);

    const result = await resolver.resolve({
      tenantId: TENANT_ID,
      country: "ES",
      supplierName: "GARCIA DE POU S.A.",
      supplierVatId: "ESA08242851",
      aiConfidence: 0.95,
    });

    expect(result.party).toBeDefined();
    const party = Array.from(prisma.dbParties.values())[0];
    expect(party.name).toBe("GARCIA DE POU S.A.");
    expect(party.address).toBe("Carrer del Castanyet, 132");
    expect((party as any).city).toBe("Santa Coloma de Farners");
  });
});