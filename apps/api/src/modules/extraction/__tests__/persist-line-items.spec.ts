import { ExtractionService } from "../extraction.service";

/**
 * Fase 4 — persistLineItems(): without this, DocumentItem stayed forever
 * empty (confirmed in production: 0 rows across the whole table), so
 * "produtos comprados" (party-products.service) had nothing to aggregate.
 */
function svcWith() {
  const deleteMany = jest.fn(async () => ({ count: 0 }));
  const createMany = jest.fn(async () => ({ count: 0 }));
  const svc = new ExtractionService({ documentItem: { deleteMany, createMany } } as any, null, null);
  return { svc, deleteMany, createMany };
}

describe("ExtractionService.persistLineItems() — Fase 4", () => {
  it("clears old rows then inserts the mapped line items", async () => {
    const { svc, deleteMany, createMany } = svcWith();
    await (svc as any).persistLineItems("doc-1", [
      { description: "Percolador 100 chávenas", code: "CPC100", quantity: 1, unitPrice: 87.5, vatRate: 23, lineTotal: 87.5 },
      { description: "Portes", quantity: 1, unitPrice: 14, lineTotal: 14, discount: 0 },
    ]);
    expect(deleteMany).toHaveBeenCalledWith({ where: { documentId: "doc-1" } });
    expect(createMany).toHaveBeenCalledWith({
      data: [
        { documentId: "doc-1", code: "CPC100", description: "Percolador 100 chávenas", quantity: 1, unitPrice: 87.5, discount: 0, discountPercent: null, taxRate: 23, total: 87.5 },
        { documentId: "doc-1", code: null, description: "Portes", quantity: 1, unitPrice: 14, discount: 0, discountPercent: null, taxRate: 23, total: 14 },
      ],
    });
  });

  // Fase 4.2 (P0.3) — a SAMMIC imprime "Dto. 30,00" numa linha, que são
  // 30% (2 × 24,10 = 48,20; − 30% = 33,74), não 30€. `discount` fica com
  // o valor resolvido em euros; `discountPercent` guarda a percentagem.
  it("classifica o desconto por linha (percentagem vs. valor) antes de gravar", async () => {
    const { svc, createMany } = svcWith();
    await (svc as any).persistLineItems("doc-sammic", [
      { description: "Resistência", quantity: 2, unitPrice: 24.1, discount: 30, lineTotal: 33.74 },
    ]);
    expect(createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          discount: 14.46,
          discountPercent: 30,
          total: 33.74,
        }),
      ],
    });
  });

  it("derives unitPrice from total/quantity when the AI only gave a line total", async () => {
    const { svc, createMany } = svcWith();
    await (svc as any).persistLineItems("doc-2", [
      { description: "Caixa de 12 garrafas", quantity: 12, lineTotal: 60 },
    ]);
    expect(createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ description: "Caixa de 12 garrafas", unitPrice: 5, total: 60 })],
    });
  });

  it("skips items with no description or no derivable total; clears rows and skips createMany when nothing survives", async () => {
    const { svc, deleteMany, createMany } = svcWith();
    await (svc as any).persistLineItems("doc-3", [{ description: "  " }, { quantity: 1 }, { description: "Sem preço nem total" }]);
    expect(deleteMany).toHaveBeenCalledTimes(1);
    expect(createMany).not.toHaveBeenCalled();
  });

  it("re-extraction is idempotent: no duplicate rows across two runs", async () => {
    const { svc, createMany } = svcWith();
    const items = [{ description: "Artigo A", quantity: 2, unitPrice: 10, lineTotal: 20 }];
    await (svc as any).persistLineItems("doc-4", items);
    await (svc as any).persistLineItems("doc-4", items);
    expect(createMany).toHaveBeenCalledTimes(2);
    expect(createMany.mock.calls[0]).toEqual(createMany.mock.calls[1]);
  });

  it("never throws — tolerates missing documentItem model (test doubles) and a failing call", async () => {
    const bare = new ExtractionService({} as any, null, null);
    await expect((bare as any).persistLineItems("doc-5", [{ description: "x", unitPrice: 1, lineTotal: 1 }])).resolves.toBeUndefined();
    const throwing = new ExtractionService(
      { documentItem: { deleteMany: jest.fn(async () => { throw new Error("db down"); }), createMany: jest.fn() } } as any,
      null,
      null,
    );
    await expect((throwing as any).persistLineItems("doc-6", [])).resolves.toBeUndefined();
  });

  it("handles undefined/empty lineItems without calling createMany", async () => {
    const { svc, deleteMany, createMany } = svcWith();
    await (svc as any).persistLineItems("doc-7", undefined);
    await (svc as any).persistLineItems("doc-7", []);
    expect(deleteMany).toHaveBeenCalledTimes(2);
    expect(createMany).not.toHaveBeenCalled();
  });
});
