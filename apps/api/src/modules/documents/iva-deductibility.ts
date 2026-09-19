import { CategoryNature } from '@prisma/client';

/**
 * Fase 4.1 — dedutibilidade do IVA por natureza + categoria.
 *
 * A HotelEquip é revendedora: a maioria das faturas é compra de
 * mercadoria para revenda, 100 % dedutível. Antes desta fase só existia
 * "categoria de despesa", o que empurrava compras para categorias de
 * gasto e arrastava consigo as limitações legais dos gastos.
 *
 * A natureza decide primeiro; a categoria só limita dentro das naturezas
 * de gasto. Regras PT (CIVA art. 21.º):
 *   - mercadorias para revenda, matérias-primas e serviços externos
 *     usados na atividade tributada: dedução integral;
 *   - despesas de alimentação e bebidas: 50 % (art. 21.º n.º 2 d);
 *   - combustível: gasóleo/GPL 50 %, gasolina 0 % (art. 21.º n.º 1 b) —
 *     sem saber o combustível assumimos os 50 % do gasóleo, que é o caso
 *     comum, e o documento fica marcado como "a confirmar";
 *   - alojamento e deslocações: 0 % quando não estão ligados a
 *     participação em eventos/feiras; assumimos a limitação legal e
 *     deixamos o operador subir se justificar;
 *   - viaturas ligeiras de passageiros: 0 %.
 *
 * Função pura e testada. Nunca é a IA a decidir isto.
 */

export interface IvaDeductibility {
  /** Percentagem dedutível, 0–100. */
  pct: number;
  /** Motivo legível, guardado na metadata e mostrado na revisão. */
  reason: string;
  /** True quando a regra depende de um detalhe que o documento não diz. */
  needsConfirmation: boolean;
}

/** Slugs com limitação legal dentro das naturezas de gasto. */
const LIMITED_BY_SLUG: Record<string, IvaDeductibility> = {
  refeicoes: {
    pct: 50,
    reason: 'Alimentação e bebidas — dedução limitada a 50 % (art. 21.º n.º 2 d CIVA)',
    needsConfirmation: false,
  },
  combustivel: {
    pct: 50,
    reason:
      'Combustível — 50 % (gasóleo/GPL). Gasolina não é dedutível: confirmar o combustível (art. 21.º n.º 1 b CIVA)',
    needsConfirmation: true,
  },
  alojamento: {
    pct: 0,
    reason:
      'Alojamento — não dedutível salvo participação em eventos/feiras (art. 21.º n.º 1 d e n.º 2 e CIVA)',
    needsConfirmation: true,
  },
  deslocacoes: {
    pct: 0,
    reason:
      'Deslocações e estadas — não dedutível salvo exceções do art. 21.º n.º 2 CIVA',
    needsConfirmation: true,
  },
  viaturas: {
    pct: 0,
    reason: 'Viaturas ligeiras de passageiros — não dedutível (art. 21.º n.º 1 a CIVA)',
    needsConfirmation: false,
  },
};

const FULL = (reason: string): IvaDeductibility => ({
  pct: 100,
  reason,
  needsConfirmation: false,
});

export function resolveIvaDeductibility(
  nature: CategoryNature | null | undefined,
  categorySlug?: string | null,
): IvaDeductibility {
  const slug = categorySlug?.trim().toLowerCase() ?? '';

  switch (nature) {
    case 'MERCADORIAS_REVENDA':
      return FULL('Mercadoria para revenda — dedução integral');
    case 'MATERIAS_PRIMAS_SUBSIDIARIAS':
      return FULL('Matérias-primas e subsidiárias — dedução integral');
    case 'IMOBILIZADO':
      // Viaturas ligeiras de passageiros são a exceção clássica.
      return (
        LIMITED_BY_SLUG[slug] ??
        FULL('Ativo fixo afeto à atividade tributada — dedução integral')
      );
    case 'SERVICOS_EXTERNOS':
      return (
        LIMITED_BY_SLUG[slug] ??
        FULL('Fornecimentos e serviços externos — dedução integral')
      );
    case 'DESPESA_OPERACIONAL':
      return (
        LIMITED_BY_SLUG[slug] ??
        FULL('Despesa operacional afeta à atividade tributada — dedução integral')
      );
    default:
      // Sem natureza não inventamos uma percentagem: fica a 100 % (o
      // caso mais comum) mas marcado para confirmação.
      return {
        pct: 100,
        reason: 'Sem natureza definida — confirmar a classificação',
        needsConfirmation: true,
      };
  }
}

/** Etiquetas em português para a interface. */
export const CATEGORY_NATURE_LABEL: Record<CategoryNature, string> = {
  MERCADORIAS_REVENDA: 'Mercadorias para revenda',
  MATERIAS_PRIMAS_SUBSIDIARIAS: 'Matérias-primas e subsidiárias',
  SERVICOS_EXTERNOS: 'Serviços externos (FSE)',
  DESPESA_OPERACIONAL: 'Despesa operacional',
  IMOBILIZADO: 'Imobilizado',
};
