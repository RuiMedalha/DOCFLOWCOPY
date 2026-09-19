'use client';

/**
 * Fase 4.1 (P1.1 + P2.2) — Classificação.
 *
 * O teste real do Rui: "só existe Categoria da despesa e, no detalhe,
 * não deixa escolher nem guardar". A HotelEquip é revendedora — a
 * maioria das faturas é compra de mercadoria para revenda, não despesa.
 *
 * Este painel resolve as duas coisas:
 *   - escolher e GUARDAR natureza + categoria (pré-requisito para a
 *     auto-categoria após 3 aprovações do mesmo fornecedor funcionar);
 *   - corrigir à mão o tipo de documento e a validade fiscal, que fica
 *     registado na auditoria e não é revertido por uma re-extração.
 */

import { useMemo, useState } from 'react';
import { Check, Loader2, ShieldCheck } from 'lucide-react';
import { useCategories } from '../../../categories/use-categories';
import {
  DOCUMENT_TYPE_LABEL,
  FISCAL_STATUS_LABEL,
  type DocumentType,
  type FiscalStatus,
} from '../../_components/types';

export type CategoryNature =
  | 'MERCADORIAS_REVENDA'
  | 'MATERIAS_PRIMAS_SUBSIDIARIAS'
  | 'SERVICOS_EXTERNOS'
  | 'DESPESA_OPERACIONAL'
  | 'IMOBILIZADO';

export const CATEGORY_NATURE_LABEL: Record<CategoryNature, string> = {
  MERCADORIAS_REVENDA: 'Mercadorias para revenda',
  MATERIAS_PRIMAS_SUBSIDIARIAS: 'Matérias-primas e subsidiárias',
  SERVICOS_EXTERNOS: 'Serviços externos (FSE)',
  DESPESA_OPERACIONAL: 'Despesa operacional',
  IMOBILIZADO: 'Imobilizado',
};

const NATURE_ORDER: CategoryNature[] = [
  'MERCADORIAS_REVENDA',
  'MATERIAS_PRIMAS_SUBSIDIARIAS',
  'SERVICOS_EXTERNOS',
  'DESPESA_OPERACIONAL',
  'IMOBILIZADO',
];

const TYPE_OPTIONS: DocumentType[] = [
  'FATURA_RECEBIDA',
  'FATURA_SIMPLIFICADA',
  'RECIBO',
  'NOTA_CREDITO',
  'NOTA_DEBITO',
  'PROFORMA',
  'ORCAMENTO',
  'ENCOMENDA',
  'AVISO_PAGAMENTO',
  'EXTRATO_FORNECEDOR',
  'GUIA_TRANSPORTE',
  'OUTRO',
];

const FISCAL_OPTIONS: FiscalStatus[] = ['FISCAL', 'NAO_FISCAL', 'INDETERMINADO'];

export interface ClassificationPatch {
  expenseCategoryId?: string;
  expenseNature?: CategoryNature;
  type?: DocumentType;
  fiscalStatus?: FiscalStatus;
}

export function ClassificationPanel({
  documentType,
  fiscalStatus,
  fiscalReason,
  expenseCategoryId,
  expenseNature,
  ivaDeductibilityPct,
  typeManualOverride,
  fiscalStatusManualOverride,
  onSave,
  saving,
}: {
  documentType: DocumentType;
  fiscalStatus?: FiscalStatus | null;
  fiscalReason?: string | null;
  expenseCategoryId?: string | null;
  expenseNature?: CategoryNature | null;
  ivaDeductibilityPct?: number | null;
  typeManualOverride?: boolean;
  fiscalStatusManualOverride?: boolean;
  onSave: (patch: ClassificationPatch) => void;
  saving?: boolean;
}) {
  const { categories, loading } = useCategories();
  const [draft, setDraft] = useState<ClassificationPatch>({});

  const current = {
    expenseCategoryId: draft.expenseCategoryId ?? expenseCategoryId ?? '',
    expenseNature: draft.expenseNature ?? expenseNature ?? '',
    type: draft.type ?? documentType,
    fiscalStatus: draft.fiscalStatus ?? fiscalStatus ?? 'INDETERMINADO',
  };

  // Agrupamos as categorias pela natureza para o operador ver de
  // imediato que "Mercadorias para revenda" não é uma despesa.
  const grouped = useMemo(() => {
    const byNature = new Map<string, typeof categories>();
    for (const c of categories) {
      const n = (c as { nature?: string }).nature ?? 'DESPESA_OPERACIONAL';
      byNature.set(n, [...(byNature.get(n) ?? []), c]);
    }
    return NATURE_ORDER.filter((n) => byNature.has(n)).map((n) => ({
      nature: n,
      items: byNature.get(n) ?? [],
    }));
  }, [categories]);

  const dirty = Object.keys(draft).length > 0;

  return (
    <section className="card p-4 space-y-3" data-testid="classification-panel">
      <header className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold" style={{ color: 'var(--text)' }}>
          Classificação
        </h3>
        {typeof ivaDeductibilityPct === 'number' && (
          <span className="badge-sky" title="Dedutibilidade do IVA resultante da natureza + categoria">
            IVA dedutível {ivaDeductibilityPct}%
          </span>
        )}
      </header>

      <label className="block">
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
          Natureza e categoria
        </span>
        <select
          className="input mt-1"
          disabled={loading}
          value={current.expenseCategoryId}
          onChange={(e) => {
            const id = e.target.value;
            const row = categories.find((c) => c.id === id) as
              | { id: string; nature?: CategoryNature }
              | undefined;
            setDraft((d) => ({
              ...d,
              expenseCategoryId: id,
              // A natureza vem com a categoria — o operador não tem de
              // escolher duas vezes.
              ...(row?.nature ? { expenseNature: row.nature } : {}),
            }));
          }}
        >
          <option value="">— por classificar —</option>
          {grouped.map((g) => (
            <optgroup key={g.nature} label={CATEGORY_NATURE_LABEL[g.nature]}>
              {g.items.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>

      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
            Tipo de documento
            {typeManualOverride && ' (corrigido à mão)'}
          </span>
          <select
            className="input mt-1"
            value={current.type}
            onChange={(e) => setDraft((d) => ({ ...d, type: e.target.value as DocumentType }))}
          >
            {TYPE_OPTIONS.map((t) => (
              <option key={t} value={t}>
                {DOCUMENT_TYPE_LABEL[t]}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
            Validade fiscal
            {fiscalStatusManualOverride && ' (corrigida à mão)'}
          </span>
          <select
            className="input mt-1"
            value={current.fiscalStatus}
            onChange={(e) =>
              setDraft((d) => ({ ...d, fiscalStatus: e.target.value as FiscalStatus }))
            }
          >
            {FISCAL_OPTIONS.map((f) => (
              <option key={f} value={f}>
                {FISCAL_STATUS_LABEL[f]}
              </option>
            ))}
          </select>
        </label>
      </div>

      {fiscalReason && (
        <p className="text-xs" style={{ color: 'var(--text-subtle)' }}>
          <ShieldCheck size={11} className="inline mr-1" aria-hidden="true" />
          {fiscalReason.startsWith('manual:')
            ? 'Definido manualmente por um operador — a re-extração não altera isto.'
            : `Decidido em código: ${fiscalReason}`}
        </p>
      )}

      <button
        type="button"
        className="btn-primary w-full"
        disabled={!dirty || saving}
        onClick={() => {
          onSave(draft);
          setDraft({});
        }}
        data-testid="classification-save"
      >
        {saving ? (
          <Loader2 size={14} className="inline animate-spin mr-1.5" aria-hidden="true" />
        ) : (
          <Check size={14} className="inline mr-1.5" aria-hidden="true" />
        )}
        Guardar classificação
      </button>
    </section>
  );
}
