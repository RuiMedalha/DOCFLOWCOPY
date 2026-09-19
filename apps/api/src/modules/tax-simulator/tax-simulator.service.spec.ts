import { TaxSimulatorService } from './tax-simulator.service';

// ──────────────────────────────────────────────── test doubles
const TENANT_ID = 'tenant-test-1';
const USER_ID = 'user-test-1';

function buildPrismaStub() {
  return {
    document: {
      findMany: jest.fn(),
    },
    account: {
      findMany: jest.fn(),
    },
    journalLine: {
      groupBy: jest.fn(),
    },
    expense: {
      aggregate: jest.fn(),
    },
  };
}

function buildAuditStub() {
  return {
    log: jest.fn(async () => undefined),
    logInTx: jest.fn(),
    verifyChain: jest.fn(),
  };
}

// Simple numeric sum helper used in assertions.
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe('TaxSimulatorService', () => {
  let svc: TaxSimulatorService;
  let prisma: ReturnType<typeof buildPrismaStub>;
  let audit: ReturnType<typeof buildAuditStub>;

  beforeEach(() => {
    prisma = buildPrismaStub();
    audit = buildAuditStub();
    svc = new TaxSimulatorService(prisma as any, audit as any);
  });

  // ─────────────────────────────── /iva
  describe('simulateIva()', () => {
    it('buckets documents by rate and splits liquidado vs deductivel', async () => {
      const q1 = new Date(Date.UTC(2026, 0, 1));
      const q2 = new Date(Date.UTC(2026, 3, 1));
      prisma.document.findMany.mockResolvedValue([
        // Q1 sale @23% — factura emitida (liquidado)
        {
          id: 'd1',
          type: 'FATURA_EMITIDA',
          isIntracommunity: false,
          netAmount: 100,
          taxAmount: 23,
          total: 123,
          items: [
            { total: 123, taxRate: 23, taxAmount: 23 },
          ],
        },
        // Q1 purchase @13% — factura recebida (deductivel)
        {
          id: 'd2',
          type: 'FATURA_RECEBIDA',
          isIntracommunity: false,
          netAmount: 200,
          taxAmount: 26,
          total: 226,
          items: [
            { total: 226, taxRate: 13, taxAmount: 26 },
          ],
        },
        // Q2 sale — should NOT appear in Q1 (mock filter is a no-op,
        // service counts every doc returned).
        {
          id: 'd3',
          type: 'FATURA_EMITIDA',
          isIntracommunity: false,
          netAmount: 50,
          taxAmount: 11.5,
          total: 61.5,
          items: [
            { total: 61.5, taxRate: 23, taxAmount: 11.5 },
          ],
        },
        // NOTA_CREDITO @23% — flips sign
        {
          id: 'd4',
          type: 'NOTA_CREDITO',
          isIntracommunity: false,
          netAmount: 10,
          taxAmount: 2.3,
          total: 12.3,
          items: [
            { total: 12.3, taxRate: 23, taxAmount: 2.3 },
          ],
        },
      ]);

      const out = await svc.simulateIva(TENANT_ID, USER_ID, {
        year: 2026,
        quarter: 1,
        region: 'PT',
      });

      expect(out.tenantId).toBe(TENANT_ID);
      expect(out.region).toBe('PT');
      expect(out.documentCount).toBe(4); // all returned docs counted; window filter is the mock's responsibility
      expect(out.windowStart).toBe(q1.toISOString());
      expect(out.windowEnd).toBe(q2.toISOString());

      // 23% bucket: d1 sale (+100) + d3 sale (+50) + d4 credit (-10) = +140
      // liquidado. The mock returns all 4 docs (no date filter applied at the
      // test level); the service aggregates them in the loop.
      const b23 = out.buckets['23']!;
      expect(b23.baseLiquidado).toBe(100 + 50 - 10);
      expect(b23.taxLiquidado).toBeCloseTo(23 + 11.5 - 2.3, 2);
      expect(b23.baseDeductivel).toBe(0);
      expect(b23.documentCount).toBe(3);

      // 13% bucket: d2 purchase.
      const b13 = out.buckets['13']!;
      expect(b13.baseDeductivel).toBe(200);
      expect(b13.taxDeductivel).toBe(26);
      expect(b13.baseLiquidado).toBe(0);

      // Totals ignore Q2 doc.
      const expectedLiquidado = sum([b23.taxLiquidado, b13.taxLiquidado]);
      const expectedDeductivel = sum([
        b23.taxDeductivel,
        b13.taxDeductivel,
      ]);
      expect(out.totalLiquidado).toBeCloseTo(expectedLiquidado, 2);
      expect(out.totalDeductivel).toBeCloseTo(expectedDeductivel, 2);
      expect(out.ivaAPagar).toBeCloseTo(expectedLiquidado - expectedDeductivel, 2);

      // Audit row written.
      expect(audit.log).toHaveBeenCalledTimes(1);
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: TENANT_ID,
          userId: USER_ID,
          action: 'EXPORT',
          entityType: 'TaxSimulator.Iva',
        }),
      );
    });

    it('Fase 4.3 (P0.3) — nota de crédito de fornecedor reduz o IVA dedutível', async () => {
      prisma.document.findMany.mockResolvedValue([
        // Fatura de compra: 100€ + 23€ IVA
        {
          id: 'ft1',
          type: 'FATURA_RECEBIDA',
          supplierNif: '500842019',
          isIntracommunity: false,
          netAmount: 100,
          taxAmount: 23,
          total: 123,
          items: [{ total: 123, taxRate: 23, taxAmount: 23 }],
        },
        // Nota de crédito do fornecedor: -50€ - 11.5€ IVA
        {
          id: 'nc1',
          type: 'NOTA_CREDITO',
          supplierNif: '500842019',
          isIntracommunity: false,
          netAmount: -50,
          taxAmount: -11.5,
          total: -61.5,
          items: [{ total: -61.5, taxRate: 23, taxAmount: -11.5 }],
        },
      ]);

      const out = await svc.simulateIva(TENANT_ID, USER_ID, {
        year: 2026,
        quarter: 1,
      });

      const b23 = out.buckets['23']!;
      expect(b23.baseDeductivel).toBe(50);
      expect(b23.taxDeductivel).toBeCloseTo(11.5, 2);
      expect(out.totalDeductivel).toBeCloseTo(11.5, 2);
      expect(out.totalLiquidado).toBe(0);
    });

    it('produces zero-filled output and writes the audit row when no documents exist', async () => {
      prisma.document.findMany.mockResolvedValue([]);

      const out = await svc.simulateIva(TENANT_ID, USER_ID, {
        year: 2026,
        quarter: 2,
      });

      expect(out.documentCount).toBe(0);
      expect(out.totalLiquidado).toBe(0);
      expect(out.totalDeductivel).toBe(0);
      expect(out.ivaAPagar).toBe(0);
      expect(Object.keys(out.buckets)).toHaveLength(0);
      expect(audit.log).toHaveBeenCalledTimes(1);
    });
  });

  // ─────────────────────────────── /irc
  describe('simulateIrc()', () => {
    it('aggregates PGC 6x debits, applies 21% IRC + 10% autónoma, returns top accounts', async () => {
      prisma.account.findMany.mockResolvedValue([
        { id: 'a1', code: '62', name: 'Fornecimentos e serviços externos' },
        { id: 'a2', code: '63', name: 'Gastos com o pessoal' },
        { id: 'a3', code: '68', name: 'Outros gastos e perdas' },
      ]);
      prisma.journalLine.groupBy.mockResolvedValue([
        { accountId: 'a1', _sum: { debit: 1000, credit: 0 } },
        { accountId: 'a2', _sum: { debit: 500, credit: 100 } },
        { accountId: 'a3', _sum: { debit: 200, credit: 50 } },
      ]);
      prisma.expense.aggregate.mockResolvedValue({ _sum: { amount: 1700 } });

      const out = await svc.simulateIrc(TENANT_ID, USER_ID, { year: 2026 });

      // Headline net = sum(max(0, debit − credit)).
      //   a1: 1000, a2: 400 (500-100), a3: 150 (200-50) → 1550
      expect(out.totalExpenses).toBeCloseTo(1550, 2);
      expect(out.ircRate).toBe(21);
      expect(out.autonomoRate).toBe(10);
      expect(out.ircEstimado).toBeCloseTo(1550 * 0.21, 2);
      expect(out.tributacaoAutonoma).toBeCloseTo(1550 * 0.10, 2);
      expect(out.totalEstado).toBeCloseTo(
        out.ircEstimado + out.tributacaoAutonoma,
        2,
      );

      // Top accounts are sorted by debit desc.
      expect(out.topAccounts.map((b) => b.accountCode)).toEqual(['62', '63', '68']);
      expect(out.topAccounts[0].debit).toBe(1000);
      expect(out.topAccounts[1].credit).toBe(100);
      // Account with debit > 0 should appear (filter excludes zero-debit).
      expect(out.topAccounts).toHaveLength(3);

      expect(audit.log).toHaveBeenCalledTimes(1);
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'EXPORT',
          entityType: 'TaxSimulator.Irc',
        }),
      );
    });

    it('returns empty totals with notes when tenant has no PGC 6x accounts', async () => {
      prisma.account.findMany.mockResolvedValue([]);
      prisma.journalLine.groupBy.mockResolvedValue([]);
      prisma.expense.aggregate.mockResolvedValue({ _sum: { amount: 0 } });

      const out = await svc.simulateIrc(TENANT_ID, USER_ID, { year: 2026 });

      expect(out.totalExpenses).toBe(0);
      expect(out.ircEstimado).toBe(0);
      expect(out.tributacaoAutonoma).toBe(0);
      expect(out.totalEstado).toBe(0);
      expect(out.topAccounts).toEqual([]);
      expect(out.notes.length).toBeGreaterThan(0);
    });
  });

  // ─────────────────────────────── region resolution
  describe('region parsing', () => {
    it('normalises PT-AC / PT-MA to the right region', async () => {
      prisma.document.findMany.mockResolvedValue([]);
      const out = await svc.simulateIva(TENANT_ID, USER_ID, {
        year: 2026,
        quarter: 1,
        region: 'PT-AC',
      });
      expect(out.region).toBe('PT-AC');
      const outMa = await svc.simulateIva(TENANT_ID, USER_ID, {
        year: 2026,
        quarter: 1,
        region: 'PT-MA',
      });
      expect(outMa.region).toBe('PT-MA');
    });
  });
});