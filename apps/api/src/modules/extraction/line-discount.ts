/**
 * Fase 4.2 (P0.3) — descontos por linha: percentagem vs. valor.
 *
 * Bug real: a SAMMIC imprime "Dto. 30,00" numa linha — é 30%, não 30 €
 * (2 × 24,10 = 48,20; menos 30% = 33,74). A extração devolve o número
 * impresso na coluna de desconto sem saber a que unidade pertence; o
 * sistema assumia sempre euros, mostrava "DESC. 30,00 EUR" e, em
 * qualquer sítio que recalculasse a partir do desconto em vez do total
 * da linha, chegava a 18,20 em vez de 33,74.
 *
 * Esta função nunca confia no que a IA "acha" que é — deduz o tipo pela
 * aritmética, usando o total da linha (que a IA também devolve) como
 * prova:
 *
 *   qtd × preço × (1 − d/100) = total-da-linha  → é percentagem
 *   qtd × preço − d           = total-da-linha  → é valor
 *
 * Sem um total de linha para verificar, não há como confirmar — fica
 * como "unknown" e o valor impresso é tratado como euros (o
 * comportamento anterior, para não regredir faturas já corretas).
 *
 * Função pura e testada — sem Prisma, sem rede.
 */

export type LineDiscountKind = 'percent' | 'amount' | 'unknown' | 'none';

export interface LineDiscountInput {
  quantity?: number | null;
  unitPrice?: number | null;
  /** Valor impresso na coluna de desconto — pode ser € ou %, não se sabe à partida. */
  discount?: number | null;
  /** Total da linha, tal como a IA o devolveu — é a prova aritmética. */
  lineTotal?: number | null;
}

export interface LineDiscountResolution {
  kind: LineDiscountKind;
  /** Percentagem 0–100, quando determinável. */
  discountPercent: number | null;
  /** Valor em euros, sempre preenchido quando há desconto (derivado ou impresso). */
  discountAmount: number | null;
}

/** Tolerância de arredondamento: 2 cêntimos (dois fatores multiplicados acumulam mais erro que uma soma simples). */
const TOLERANCE = 0.02;

const round2 = (n: number): number => Math.round(n * 100) / 100;

const num = (v: number | null | undefined): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

export function classifyLineDiscount(item: LineDiscountInput): LineDiscountResolution {
  const discount = num(item.discount);
  if (discount == null || discount === 0) {
    return { kind: 'none', discountPercent: null, discountAmount: null };
  }

  const qty = num(item.quantity) ?? 1;
  const unit = num(item.unitPrice);
  const lineTotal = num(item.lineTotal);
  const gross = unit != null ? round2(unit * qty) : null;

  if (gross != null && lineTotal != null) {
    const asAmount = round2(gross - discount);
    const asPercent = round2(gross * (1 - discount / 100));

    const amountDelta = Math.abs(asAmount - lineTotal);
    const percentDelta = Math.abs(asPercent - lineTotal);

    if (percentDelta <= TOLERANCE && percentDelta <= amountDelta) {
      return {
        kind: 'percent',
        discountPercent: discount,
        discountAmount: round2(gross * (discount / 100)),
      };
    }
    if (amountDelta <= TOLERANCE) {
      return {
        kind: 'amount',
        discountPercent: gross > 0 ? round2((discount / gross) * 100) : null,
        discountAmount: discount,
      };
    }
    // Nenhuma das duas bate certo ao cêntimo — ficamos com a
    // interpretação que menos se afasta do total impresso, para o
    // operador ter algo plausível a rever em vez de um número às cegas.
    if (percentDelta < amountDelta) {
      return {
        kind: 'percent',
        discountPercent: discount,
        discountAmount: round2(gross * (discount / 100)),
      };
    }
    return {
      kind: 'amount',
      discountPercent: gross > 0 ? round2((discount / gross) * 100) : null,
      discountAmount: discount,
    };
  }

  // Sem total de linha (ou sem preço unitário) para verificar — não há
  // prova. Mantemos o comportamento anterior (tratar como euros) para
  // não regredir as faturas que já estavam corretas.
  return { kind: 'unknown', discountPercent: null, discountAmount: discount };
}
