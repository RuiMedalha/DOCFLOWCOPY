/**
 * Fase 4 — categoria de despesa automática por fornecedor.
 *
 * Regra determinística: depois de >= 3 aprovações da mesma categoria para o
 * mesmo fornecedor, essa categoria é aplicada automaticamente ao próximo
 * documento (confidence = 1). Se o fornecedor tiver uma categoria por
 * defeito definida pelo operador e ainda não houver histórico suficiente,
 * ela é aplicada como proposta forte (confidence = 0.9). Sem uma coisa nem
 * outra, não se aplica nada (a IA só sugere via metadata).
 */
export const AUTO_CATEGORY_THRESHOLD = 3;

export interface PartyCategoryStatLike {
  categoryId: string;
  approvedCount: number;
}

export interface AutoCategoryDecision {
  categoryId: string;
  confidence: number;
  reason: string;
}

export function pickAutoCategory(
  stats: PartyCategoryStatLike[],
  defaultCategoryId: string | null | undefined,
  threshold = AUTO_CATEGORY_THRESHOLD,
): AutoCategoryDecision | null {
  const eligible = stats
    .filter((s) => s.approvedCount >= threshold)
    .sort((a, b) => b.approvedCount - a.approvedCount);
  if (eligible.length > 0) {
    const top = eligible[0];
    // Ambiguous history (two categories tied at the top) → don't guess.
    if (eligible.length > 1 && eligible[1].approvedCount === top.approvedCount && eligible[1].categoryId !== top.categoryId) {
      return defaultCategoryId
        ? { categoryId: defaultCategoryId, confidence: 0.9, reason: 'party_default_category_tie_break' }
        : null;
    }
    return { categoryId: top.categoryId, confidence: 1, reason: `approved_${top.approvedCount}x_for_party` };
  }
  if (defaultCategoryId) {
    return { categoryId: defaultCategoryId, confidence: 0.9, reason: 'party_default_category' };
  }
  return null;
}
