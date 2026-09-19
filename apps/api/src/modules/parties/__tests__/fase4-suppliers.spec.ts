import { pickAutoCategory } from "../auto-category";
import { aggregateProducts } from "../party-products.service";
import { PartyImportService, detectDelimiter, resolveMapping } from "../party-import.service";

describe("Fase 4 — auto-category (>= 3 aprovações)", () => {
  it("applies the category approved >= 3 times with confidence 1", () => {
    expect(pickAutoCategory([{ categoryId: "c1", approvedCount: 3 }], null)).toEqual({
      categoryId: "c1", confidence: 1, reason: "approved_3x_for_party",
    });
  });
  it("2 approvals are not enough; default category is a strong proposal instead", () => {
    expect(pickAutoCategory([{ categoryId: "c1", approvedCount: 2 }], null)).toBeNull();
    expect(pickAutoCategory([{ categoryId: "c1", approvedCount: 2 }], "cdef")).toMatchObject({ categoryId: "cdef", confidence: 0.9 });
  });
  it("picks the most approved category; a tie at the top does not guess", () => {
    expect(pickAutoCategory([{ categoryId: "a", approvedCount: 3 }, { categoryId: "b", approvedCount: 5 }], null)?.categoryId).toBe("b");
    expect(pickAutoCategory([{ categoryId: "a", approvedCount: 4 }, { categoryId: "b", approvedCount: 4 }], null)).toBeNull();
    expect(pickAutoCategory([{ categoryId: "a", approvedCount: 4 }, { categoryId: "b", approvedCount: 4 }], "cdef")?.reason).toBe("party_default_category_tie_break");
  });
});

describe("Fase 4 — produtos comprados (agregação de linhas)", () => {
  it("groups by code (or description), sums quantity/spend and keeps the latest price", () => {
    const d = (s: string) => new Date(`${s}T00:00:00Z`);
    const out = aggregateProducts([
      { code: "CPC100", description: "Percolador 100 chávenas", quantity: 1, unitPrice: 87.5, total: 87.5, docDate: d("2026-01-10"), documentId: "d1" },
      { code: "CPC100", description: "Percolador 100 chávenas", quantity: 2, unitPrice: 85, total: 170, docDate: d("2026-03-01"), documentId: "d2" },
      { code: null, description: "Portes", quantity: 1, unitPrice: 14, total: 14, docDate: d("2026-01-10"), documentId: "d1" },
      { code: null, description: "  portes ", quantity: 1, unitPrice: 16, total: 16, docDate: null, documentId: "d3" },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ key: "cpc100", code: "CPC100", timesBought: 2, totalQuantity: 3, totalSpent: 257.5, lastUnitPrice: 85, lastDate: "2026-03-01", lastDocumentId: "d2" });
    expect(out[1]).toMatchObject({ code: null, timesBought: 2, totalSpent: 30 });
  });
});

describe("Fase 4 — importador CSV de fornecedores", () => {
  it("detects the delimiter and maps Moloni-style Portuguese headers without explicit mapping", () => {
    expect(detectDelimiter("Nome;NIF;Email\nA;1;x")).toBe(";");
    expect(detectDelimiter("name,vat,email")).toBe(",");
    const cols = resolveMapping(["Nome", "NIF", "E-mail", "Telefone", "Morada", "Código Postal", "Cidade", "País", "IBAN"]);
    expect(cols).toEqual({
      name: "Nome", nif: "NIF", email: "E-mail", phone: "Telefone", address: "Morada", postalCode: "Código Postal", city: "Cidade", country: "País", iban: "IBAN",
    });
    expect(resolveMapping(["Fornecedor", "Contrib"], { nif: "Contrib" })).toEqual({ name: "Fornecedor", nif: "Contrib" });
  });

  it("upserts by NIF / NIF-IVA and reports created/updated/errors; foreign VAT in the NIF column becomes vatNumber", async () => {
    const created: unknown[] = [];
    const updated: unknown[] = [];
    const parties = {
      create: jest.fn(async (_t: string, _u: string, dto: unknown) => { created.push(dto); return { id: "new" }; }),
      update: jest.fn(async (_t: string, _u: string, id: string, dto: unknown) => { updated.push({ id, dto }); return { id }; }),
    };
    const prisma = {
      party: {
        findFirst: jest.fn(async ({ where }: { where: { nif?: string; OR?: unknown[]; name?: unknown } }) =>
          where.nif === "500842019" ? { id: "existing" } : null),
      },
    };
    const svc = new PartyImportService(prisma as never, parties as never);
    const csv = [
      "Nome;NIF;Email;Prazo Pagamento;Moeda",
      "Miranda & Serra;500842019;geral@mirandaeserra.pt;30;EUR",
      "Clima Hostelería;ESB06612386;pedidos@climahosteleria.es;;",
      ";123;;;",
    ].join("\n");
    const out = await svc.importCsv("t1", "u1", Buffer.from(csv, "utf8"));
    expect(out).toMatchObject({ totalRows: 3, created: 1, updated: 1, skipped: 1, errors: [] });
    expect(updated[0]).toMatchObject({ id: "existing", dto: expect.objectContaining({ nif: "500842019", paymentTermDays: 30, currency: "EUR", vatRegime: "PT" }) });
    expect(created[0]).toMatchObject({ name: "Clima Hostelería", vatNumber: "ESB06612386", country: "ES", vatRegime: "UE_REVERSE_CHARGE" });
    expect((created[0] as { nif?: string }).nif).toBeUndefined();
  });

  it("dry-run counts without writing; a service error is reported per row", async () => {
    const parties = {
      create: jest.fn(async () => { throw new Error("NIF inválido"); }),
      update: jest.fn(),
    };
    const prisma = { party: { findFirst: jest.fn(async () => null) } };
    const svc = new PartyImportService(prisma as never, parties as never);
    const csv = "name,nif\nBad Corp,123456789\n";
    const dry = await svc.importCsv("t1", "u1", Buffer.from(csv), undefined, { dryRun: true });
    expect(dry).toMatchObject({ created: 1, updated: 0 });
    expect(parties.create).not.toHaveBeenCalled();
    const live = await svc.importCsv("t1", "u1", Buffer.from(csv));
    expect(live.errors).toEqual([{ row: 2, name: "Bad Corp", error: "NIF inválido" }]);
  });

  it("rejects a CSV without a name column with a helpful message", async () => {
    const svc = new PartyImportService({ party: { findFirst: jest.fn() } } as never, {} as never);
    await expect(svc.importCsv("t1", "u1", Buffer.from("foo;bar\n1;2\n"))).rejects.toThrow(/coluna do nome/);
  });
});
