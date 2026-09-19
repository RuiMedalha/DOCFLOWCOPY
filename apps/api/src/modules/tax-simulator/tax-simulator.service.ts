import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { AuditAction, Prisma } from '@prisma/client';
import {
  classifyIvaRate,
  regionFromCode,
  roundMoney,
  sumMoney,
  validateIvaBreakdown,
  type IvaRegion,
} from '@docflow/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import {
  IrcSimulatorQueryDto,
  IrcSimulatorResult,
  IvaRateBucket,
  IvaSimulatorQueryDto,
  IvaSimulatorResult,
} from './dto/tax-simulator.dto';

/**
 * Tax Simulator service — produces a rough, explainable estimate of the
 * tax obligations a tenant would report for a given window. It does NOT
 * replace certified software (TOConline, Moloni, Primavera) — DocFlow never
 * generates SAF-T or files the Declaração Periódica by itself; the goal is
 * to give the user a clear preview (which is why the routes sit behind
 * ADMIN + CONTABILIDADE).
 *
 * Inputs:
 *   - Document (header + DocumentItem rows): aggregated by rate for IVA.
 *   - Expense + JournalLine: aggregated by PGC account for IRC (cost base).
 *
 * Output:
 *   - /iva returns the quarterly Declaração Periódica subset (per-region
 *     buckets + summary). Uses the shared `iva.util` helpers (region, rate
 *     classification, validation) so the same rules apply everywhere.
 *   - /irc returns the IRC + autonomous-taxation headline + top PGC 6x
 *     accounts by debit (no modelo 22 / no SAF-T — purely indicative).
 *
 * Audit: every call writes a single `EXPORT` audit row (best-effort via
 * AuditService — failures don't break the response).
 */
@Injectable()
export class TaxSimulatorService {
  private readonly logger = new Logger(TaxSimulatorService.name);

  /** Default IRC rate (PME corporate rate — 21% mainland PT 2026). */
  private static readonly DEFAULT_IRC_RATE = 21;

  /** Default autonomous-taxation rate (10% — placeholder until payroll feeds in). */
  private static readonly DEFAULT_AUTONOMO_RATE = 10;

  /** Maximum number of accounts returned in the topAccounts list. */
  private static readonly TOP_ACCOUNTS_LIMIT = 10;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ════════════════════════════════════════════════════════════════════════
  //  IVA — Declaração Periódica
  // ════════════════════════════════════════════════════════════════════════

  /**
   * Aggregate the tenant's documents for `year`/`quarter` into the
   * Declaração Periódica subset. Sales (FACTURA_EMITIDA + NOTA_DEBITO)
   * contribute to `liquidado`; purchases/expenses (FACTURA_RECEBIDA +
   * NOTA_CREDITO) contribute to `deductivel`.
   *
   * Notes:
   *   - Document rows without `docDate` are skipped (cannot be placed in a
   *     quarter window). DocumentItem rows carry the per-line rate; the
   *     header row is only used as a fallback when no items exist.
   *   - Intracommunity documents (isIntracommunity=true) are surfaced but
   *     not auto-classified — they live in the Q5/Q6 "operações
   *     intracomunitárias" cells of the DP and need a separate report.
   *   - Validation: each per-rate bucket is run through
   *     `validateIvaBreakdown` so we surface a "tax ≠ base*rate" warning if
   *     an item is malformed.
   */
  async simulateIva(
    tenantId: string,
    userId: string,
    query: IvaSimulatorQueryDto,
  ): Promise<IvaSimulatorResult> {
    const region: IvaRegion = regionFromCode(query.region ?? 'PT');
    const { year, quarter } = query;

    const { windowStart, windowEnd } = this.quarterWindow(year, quarter);

    // Pull every relevant document header for the window. We filter on
    // tenantId + docDate between window start (inclusive) and end
    // (exclusive). Pulling items separately avoids the N+1 cost of
    // re-reading DocumentItem per row.
    const documents = await this.prisma.document.findMany({
      where: {
        tenantId,
        docDate: { gte: windowStart, lt: windowEnd },
        // Excluded: drafts/archives that never had tax extracted.
        // Fase 3 — documentos não fiscais e duplicados nunca entram no IVA.
        status: { notIn: ['ARQUIVADO', 'DUPLICADO'] as never[] },
        fiscalStatus: { not: 'NAO_FISCAL' as never },
      },
      select: {
        id: true,
        type: true,
        isIntracommunity: true,
        netAmount: true,
        taxAmount: true,
        total: true,
        supplierNif: true,
        correctedDocument: {
          select: { id: true, type: true },
        },
        items: {
          select: {
            total: true,
            taxRate: true,
          },
        },
      },
    });

    // Sale / purchase classification. NOTA_CREDITO flips direction (it
    // cancels a sale or a purchase), so it has to negate the originating
    // document.
    const isSale = (type: string) =>
      type === 'FATURA_EMITIDA' ||
      type === 'NOTA_DEBITO';
    const isPurchase = (type: string) =>
      type === 'FATURA_RECEBIDA' ||
      type === 'RECIBO' ||
      type === 'COMPROVATIVO';

    const buckets: Record<string, IvaRateBucket> = {};
    let totalLiquidado = 0;
    let totalDeductivel = 0;
    let totalBase = 0;
    let documentCount = 0;
    let intracomunitarias = 0;

    for (const doc of documents) {
      documentCount++;
      if (doc.isIntracommunity) intracomunitarias++;

      const isNc = doc.type === 'NOTA_CREDITO';
      const isPurchaseNc =
        isNc &&
        (doc.correctedDocument?.type === 'FATURA_RECEBIDA' ||
          doc.correctedDocument?.type === 'RECIBO' ||
          doc.correctedDocument?.type === 'COMPROVATIVO' ||
          (Boolean(doc.supplierNif) && !doc.correctedDocument));
      const isSaleNc =
        isNc &&
        (doc.correctedDocument?.type === 'FATURA_EMITIDA' || !isPurchaseNc);

      const sign = isNc ? -1 : 1;
      const liquidadoDoc = isSale(doc.type) || isSaleNc;
      const deductivelDoc = isPurchase(doc.type) || isPurchaseNc;

      // Per-line buckets first (most accurate). If a doc has no items, fall
      // back to header totals with a synthetic rate derived from
      // netAmount/taxAmount.
      if (doc.items.length > 0) {
        for (const item of doc.items) {
          const rate = Number(item.taxRate);
          const lineTotalAbs = Math.abs(Number(item.total));
          const tax = lineTotalAbs * (rate / (100 + rate)) * sign;
          const base = (lineTotalAbs - lineTotalAbs * (rate / (100 + rate))) * sign;
          this.addToBucket(buckets, rate, {
            baseLiquidado: liquidadoDoc ? base : 0,
            taxLiquidado: liquidadoDoc ? tax : 0,
            baseDeductivel: deductivelDoc ? base : 0,
            taxDeductivel: deductivelDoc ? tax : 0,
            documentCount: 1,
          });
        }
      } else if (doc.netAmount != null && doc.taxAmount != null) {
        const base = Math.abs(Number(doc.netAmount)) * sign;
        const tax = Math.abs(Number(doc.taxAmount)) * sign;
        // Derive a synthetic rate so the bucket exists for the validation
        // pass. Fall back to 0 (exempt) when the math doesn't work out.
        const syntheticRate =
          Math.abs(base) > 0 ? roundMoney((Math.abs(tax) / Math.abs(base)) * 100) : 0;
        this.addToBucket(buckets, syntheticRate, {
          baseLiquidado: liquidadoDoc ? base : 0,
          taxLiquidado: liquidadoDoc ? tax : 0,
          baseDeductivel: deductivelDoc ? base : 0,
          taxDeductivel: deductivelDoc ? tax : 0,
          documentCount: 1,
        });
      }
    }

    // Finalise totals from the buckets.
    for (const key of Object.keys(buckets)) {
      const b = buckets[key]!;
      totalLiquidado = roundMoney(totalLiquidado + b.taxLiquidado);
      totalDeductivel = roundMoney(totalDeductivel + b.taxDeductivel);
      totalBase = roundMoney(
        totalBase + b.baseLiquidado + b.baseDeductivel,
      );
    }

    // Per-bucket sanity check using the shared utility. We surface issues
    // in `notes` rather than throwing — DocFlow's simulator must never
    // refuse to render a preview because one item is malformed.
    const notes: string[] = [
      'Estimativa indicativa — não substitui software certificado (TOConline/Moloni/Primavera).',
      `Região fiscal aplicada: ${region}.`,
      `Janela: ${windowStart.toISOString().slice(0, 10)} → ${windowEnd
        .toISOString()
        .slice(0, 10)} (exclusive).`,
    ];
    if (intracomunitarias > 0) {
      notes.push(
        `${intracomunitarias} documento(s) intracomunitário(s) detetado(s) — células Q5/Q6 da DP não são preenchidas automaticamente; verifique o Modelo P.`,
      );
    }
    for (const key of Object.keys(buckets)) {
      const b = buckets[key]!;
      const lines = [
        {
          base: roundMoney(b.baseLiquidado + b.baseDeductivel),
          rate: b.rate,
          tax: roundMoney(b.taxLiquidado + b.taxDeductivel),
          region,
        },
      ];
      const check = validateIvaBreakdown(lines, { region });
      if (!check.ok) {
        for (const e of check.errors) {
          notes.push(`Taxa ${b.rate}%: ${e}`);
        }
      }
    }

    const result: IvaSimulatorResult = {
      tenantId,
      year,
      quarter,
      region,
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      buckets,
      totalLiquidado,
      totalDeductivel,
      ivaAPagar: roundMoney(totalLiquidado - totalDeductivel),
      totalBase,
      documentCount,
      notes,
    };

    // Audit (best-effort, never blocks the response).
    await this.audit.log({
      tenantId,
      userId,
      action: AuditAction.EXPORT,
      entityType: 'TaxSimulator.Iva',
      metadata: {
        year,
        quarter,
        region,
        documentCount,
        totalLiquidado,
        totalDeductivel,
        ivaAPagar: result.ivaAPagar,
      } as Prisma.InputJsonValue,
    });

    return result;
  }

  // ════════════════════════════════════════════════════════════════════════
  //  IRC — IRC + autonomous taxation (rough)
  // ════════════════════════════════════════════════════════════════════════

  /**
   * Rough IRC estimate: aggregate expenses on PGC 6x accounts (cost of
   * goods sold + external services + other operating) into a deductible
   * total. Apply a flat 21% rate. Autonomous-taxation = 10% on the same
   * base as a placeholder until payroll integration ships its own
   * breakdown. Returns top-N accounts by debit so the user can sanity-check
   * the number.
   *
   * Caveats surfaced in `notes`:
   *   - Ignores revenues, depreciation, financial income/expense.
   *   - Ignores prejuízos fiscais de anos anteriores (carry-forward).
   *   - Does not split micro / PME / geral regimes.
   */
  async simulateIrc(
    tenantId: string,
    userId: string,
    query: IrcSimulatorQueryDto,
  ): Promise<IrcSimulatorResult> {
    const { year } = query;
    const windowStart = new Date(Date.UTC(year, 0, 1));
    const windowEnd = new Date(Date.UTC(year + 1, 0, 1));

    // Pull PGC 6x accounts (EXPENSE type). AccountType is a fixed enum,
    // so we filter on the column directly — `code: { startsWith: '6' }` is
    // a defensive extra since the seed only inserts 6x rows in EXPENSE.
    const expenseAccounts = await this.prisma.account.findMany({
      where: {
        tenantId,
        type: 'EXPENSE',
        code: { startsWith: '6' },
        isActive: true,
      },
      select: { id: true, code: true, name: true },
    });

    // Sum debits per account in the year window. We aggregate via groupBy
    // because pulling every JournalLine row would be O(N) and unbounded.
    const accountIds = expenseAccounts.map((a) => a.id);
    const grouped = accountIds.length
      ? await this.prisma.journalLine.groupBy({
          by: ['accountId'],
          where: {
            tenantId,
            accountId: { in: accountIds },
            date: { gte: windowStart, lt: windowEnd },
          },
          _sum: { debit: true, credit: true },
        })
      : [];

    const totals = new Map<string, { debit: number; credit: number }>();
    for (const row of grouped) {
      totals.set(row.accountId, {
        debit: Number(row._sum.debit ?? 0),
        credit: Number(row._sum.credit ?? 0),
      });
    }

    // Cross-check against the Expense table for diagnostic purposes. We
    // only sum status='aprovado' expenses (paid or pending — the simulator
    // treats both as incurred) so users can see if their Expense rows
    // cover the same base as the JournalLines.
    const expenseTotal = await this.prisma.expense.aggregate({
      where: {
        tenantId,
        date: { gte: windowStart, lt: windowEnd },
        status: { not: 'rejeitado' },
      },
      _sum: { amount: true },
    });

    // Build the bucket list (top-N by debit) and the headline total.
    const buckets = expenseAccounts
      .map((a) => {
        const t = totals.get(a.id) ?? { debit: 0, credit: 0 };
        const net = roundMoney(t.debit - t.credit);
        return {
          accountId: a.id,
          accountCode: a.code,
          accountName: a.name,
          debit: roundMoney(t.debit),
          credit: roundMoney(t.credit),
          net,
        };
      })
      .filter((b) => b.debit > 0)
      .sort((a, b) => b.debit - a.debit);

    const topAccounts = buckets.slice(
      0,
      TaxSimulatorService.TOP_ACCOUNTS_LIMIT,
    );

    const totalExpenses = roundMoney(
      buckets.reduce((s, b) => s + Math.max(0, b.net), 0),
    );
    const ircRate = TaxSimulatorService.DEFAULT_IRC_RATE;
    const autonomoRate = TaxSimulatorService.DEFAULT_AUTONOMO_RATE;
    const ircEstimado = roundMoney((totalExpenses * ircRate) / 100);
    // Autonomous-taxation flat base = 10% of total expenses (placeholder).
    const tributacaoAutonoma = roundMoney(
      (totalExpenses * autonomoRate) / 100,
    );

    const expenseTotalValue = roundMoney(Number(expenseTotal._sum.amount ?? 0));

    const notes: string[] = [
      'Estimativa indicativa — não substitui o Modelo 22 / contabilista certificado.',
      `Taxa IRC aplicada: ${ircRate}% (regime geral PME).`,
      `Taxa autónoma aplicada: ${autonomoRate}% (placeholder até integração payroll).`,
      'Não considera: receitas, depreciações, gastos financeiros, prejuízos fiscais transitados.',
      `Total agregado da tabela Expense (status ≠ rejeitado): ${expenseTotalValue.toFixed(
        2,
      )} € (somente diagnóstico — pode divergir dos lançamentos).`,
    ];

    const result: IrcSimulatorResult = {
      tenantId,
      year,
      totalExpenses,
      ircEstimado,
      tributacaoAutonoma,
      totalEstado: roundMoney(ircEstimado + tributacaoAutonoma),
      ircRate,
      autonomoRate,
      topAccounts,
      notes,
    };

    await this.audit.log({
      tenantId,
      userId,
      action: AuditAction.EXPORT,
      entityType: 'TaxSimulator.Irc',
      metadata: {
        year,
        totalExpenses,
        ircEstimado,
        tributacaoAutonoma,
        ircRate,
        autonomoRate,
        accountCount: buckets.length,
      } as Prisma.InputJsonValue,
    });

    return result;
  }

  // ════════════════════════════════════════════════════════════════════════
  //  internals
  // ════════════════════════════════════════════════════════════════════════

  /** Add an aggregated contribution to the right bucket (keyed by rate). */
  private addToBucket(
    buckets: Record<string, IvaRateBucket>,
    rate: number,
    contribution: {
      baseLiquidado: number;
      taxLiquidado: number;
      baseDeductivel: number;
      taxDeductivel: number;
      documentCount: number;
    },
  ): void {
    const kind = this.classifyBucketKind(rate);
    const key = String(rate);
    const existing: IvaRateBucket =
      buckets[key] ?? {
        rate,
        kind,
        baseLiquidado: 0,
        taxLiquidado: 0,
        baseDeductivel: 0,
        taxDeductivel: 0,
        documentCount: 0,
      };
    existing.baseLiquidado = roundMoney(existing.baseLiquidado + contribution.baseLiquidado);
    existing.taxLiquidado = roundMoney(existing.taxLiquidado + contribution.taxLiquidado);
    existing.baseDeductivel = roundMoney(
      existing.baseDeductivel + contribution.baseDeductivel,
    );
    existing.taxDeductivel = roundMoney(
      existing.taxDeductivel + contribution.taxDeductivel,
    );
    existing.documentCount += contribution.documentCount;
    buckets[key] = existing;
  }

  /** Choose the bucket kind for a rate. Falls back to 'other' for non-table rates. */
  private classifyBucketKind(rate: number): IvaRateBucket['kind'] {
    if (rate === 0) return 'exempt';
    const k = classifyIvaRate(rate, 'PT');
    if (k) return k;
    // AC/MA rates differ — try both so a PT-AC doc doesn't end up 'other'.
    if (classifyIvaRate(rate, 'PT-AC')) return 'normal';
    if (classifyIvaRate(rate, 'PT-MA')) return 'normal';
    return 'other';
  }

  /** Build the [start, end) window for a year+quarter. */
  private quarterWindow(
    year: number,
    quarter: number,
  ): { windowStart: Date; windowEnd: Date } {
    if (quarter < 1 || quarter > 4) {
      throw new BadRequestException('quarter must be 1, 2, 3 or 4');
    }
    const startMonth = (quarter - 1) * 3;
    return {
      windowStart: new Date(Date.UTC(year, startMonth, 1)),
      windowEnd: new Date(Date.UTC(year, startMonth + 3, 1)),
    };
  }
}
