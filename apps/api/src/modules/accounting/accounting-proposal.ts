/**
 * Fase 4.2 (P2) — proposta de lançamento contabilístico.
 *
 * Determinística: natureza da despesa (Fase 4.1) + regime de IVA do
 * fornecedor (Fase 4) decidem as contas SNC a debitar/creditar. Nunca é
 * a IA a decidir isto, e nunca inventamos um lançamento quando falta um
 * dos dois — nesse caso não propomos nada e assinalamos porquê.
 *
 * A proposta é sempre editável pelo operador; isto só poupa o trabalho
 * de escrever o óbvio.
 *
 * Função pura e testada — sem Prisma, sem rede.
 */

export type AccountingNature =
  | 'MERCADORIAS_REVENDA'
  | 'MATERIAS_PRIMAS_SUBSIDIARIAS'
  | 'SERVICOS_EXTERNOS'
  | 'DESPESA_OPERACIONAL'
  | 'IMOBILIZADO';

export type AccountingVatRegime = 'PT' | 'UE_REVERSE_CHARGE' | 'EXTRA_UE';

export interface AccountingLine {
  /** Código da conta SNC. */
  code: string;
  /** Rótulo curto para a interface. */
  label: string;
  /** A que montante do documento esta linha corresponde. */
  amount: 'net' | 'tax' | 'total';
}

export interface AccountingProposal {
  debit: AccountingLine[];
  credit: AccountingLine[];
  reason: string;
}

const NIF_FORNECEDOR_NACIONAL = { code: '2211', label: 'Fornecedores c/c — nacionais' };
const NIF_FORNECEDOR_ESTRANGEIRO = { code: '2212', label: 'Fornecedores c/c — estrangeiros' };
const IVA_DEDUTIVEL = { code: '2432', label: 'IVA dedutível' };
const IVA_LIQUIDADO_AUTOLIQUIDACAO = { code: '2433', label: 'IVA liquidado — autoliquidação' };

/** Conta 31.x da natureza — 312 para mercadorias, 313 para matérias-primas. */
function purchaseAccount(nature: AccountingNature): AccountingLine | null {
  if (nature === 'MERCADORIAS_REVENDA') return { code: '312', label: 'Compras — mercadorias', amount: 'net' };
  if (nature === 'MATERIAS_PRIMAS_SUBSIDIARIAS') return { code: '313', label: 'Compras — matérias-primas e subsidiárias', amount: 'net' };
  return null;
}

/**
 * Propõe o lançamento para um documento de compra. Devolve `null` (sem
 * `debit`/`credit`, só `reason`) quando não há dados suficientes — a
 * natureza não está definida, ou o regime de IVA não é um dos três
 * conhecidos. Nunca inventa uma conta.
 */
export function proposeAccountingEntry(
  nature: AccountingNature | null | undefined,
  vatRegime: AccountingVatRegime | null | undefined,
  documentType?: string | null,
): AccountingProposal {
  const base = proposeAccountingEntryBase(nature, vatRegime);
  if (documentType === 'NOTA_CREDITO') {
    if (base.debit.length === 0 && base.credit.length === 0) return base;
    return {
      debit: base.credit,
      credit: base.debit,
      reason: `${base.reason}_nc`,
    };
  }
  return base;
}

function proposeAccountingEntryBase(
  nature: AccountingNature | null | undefined,
  vatRegime: AccountingVatRegime | null | undefined,
): AccountingProposal {
  if (!nature) {
    return { debit: [], credit: [], reason: 'sem_natureza_definida' };
  }
  if (!vatRegime) {
    return { debit: [], credit: [], reason: 'sem_regime_iva_definido' };
  }

  const fornecedor = vatRegime === 'PT' ? NIF_FORNECEDOR_NACIONAL : NIF_FORNECEDOR_ESTRANGEIRO;

  // ── Mercadorias / matérias-primas (CMVMC) ─────────────────────────
  const purchase = purchaseAccount(nature);
  if (purchase) {
    if (vatRegime === 'PT') {
      return {
        debit: [purchase, { ...IVA_DEDUTIVEL, amount: 'tax' }],
        credit: [{ ...fornecedor, amount: 'total' }],
        reason: `${nature.toLowerCase()}_pt`,
      };
    }
    if (vatRegime === 'UE_REVERSE_CHARGE') {
      // Autoliquidação: o IVA entra dos dois lados pelo mesmo montante
      // — o efeito líquido no IVA a pagar é nulo, mas a obrigação fica
      // registada em 2432 (dedutível) e 2433 (liquidado).
      return {
        debit: [purchase, { ...IVA_DEDUTIVEL, amount: 'tax' }],
        credit: [
          { ...fornecedor, amount: 'net' },
          { ...IVA_LIQUIDADO_AUTOLIQUIDACAO, amount: 'tax' },
        ],
        reason: `${nature.toLowerCase()}_ue_autoliquidacao`,
      };
    }
    // Extra-UE: o IVA não se autoliquida — é pago na importação (DUA) e
    // pode incluir direitos aduaneiros. Sem o valor do DUA não há como
    // propor a conta com confiança — fica por preencher.
    return {
      debit: [],
      credit: [],
      reason: 'extra_ue_precisa_dua',
    };
  }

  // ── Serviços externos (FSE) ────────────────────────────────────────
  if (nature === 'SERVICOS_EXTERNOS') {
    if (vatRegime === 'EXTRA_UE') {
      return { debit: [], credit: [], reason: 'extra_ue_precisa_dua' };
    }
    const debit: AccountingLine[] = [{ code: '62', label: 'Fornecimentos e serviços externos', amount: 'net' }];
    if (vatRegime === 'PT') {
      debit.push({ ...IVA_DEDUTIVEL, amount: 'tax' });
      return {
        debit,
        credit: [{ ...fornecedor, amount: 'total' }],
        reason: 'servicos_externos_pt',
      };
    }
    // UE_REVERSE_CHARGE
    debit.push({ ...IVA_DEDUTIVEL, amount: 'tax' });
    return {
      debit,
      credit: [
        { ...fornecedor, amount: 'net' },
        { ...IVA_LIQUIDADO_AUTOLIQUIDACAO, amount: 'tax' },
      ],
      reason: 'servicos_externos_ue_autoliquidacao',
    };
  }

  // ── Imobilizado ──────────────────────────────────────────────────
  if (nature === 'IMOBILIZADO') {
    if (vatRegime === 'EXTRA_UE') {
      return { debit: [], credit: [], reason: 'extra_ue_precisa_dua' };
    }
    const debit: AccountingLine[] = [{ code: '43', label: 'Ativos fixos tangíveis', amount: 'net' }];
    if (vatRegime === 'PT') {
      debit.push({ ...IVA_DEDUTIVEL, amount: 'tax' });
      return { debit, credit: [{ ...fornecedor, amount: 'total' }], reason: 'imobilizado_pt' };
    }
    debit.push({ ...IVA_DEDUTIVEL, amount: 'tax' });
    return {
      debit,
      credit: [
        { ...fornecedor, amount: 'net' },
        { ...IVA_LIQUIDADO_AUTOLIQUIDACAO, amount: 'tax' },
      ],
      reason: 'imobilizado_ue_autoliquidacao',
    };
  }

  // ── Despesa operacional (o resto) ──────────────────────────────────
  if (vatRegime === 'EXTRA_UE') {
    return { debit: [], credit: [], reason: 'extra_ue_precisa_dua' };
  }
  const debit: AccountingLine[] = [{ code: '62', label: 'Fornecimentos e serviços externos', amount: 'net' }];
  if (vatRegime === 'PT') {
    debit.push({ ...IVA_DEDUTIVEL, amount: 'tax' });
    return { debit, credit: [{ ...fornecedor, amount: 'total' }], reason: 'despesa_operacional_pt' };
  }
  debit.push({ ...IVA_DEDUTIVEL, amount: 'tax' });
  return {
    debit,
    credit: [
      { ...fornecedor, amount: 'net' },
      { ...IVA_LIQUIDADO_AUTOLIQUIDACAO, amount: 'tax' },
    ],
    reason: 'despesa_operacional_ue_autoliquidacao',
  };
}
