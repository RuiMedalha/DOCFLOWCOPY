'use client';

import { Loader2, ShieldCheck, ShieldAlert, ShieldQuestion } from 'lucide-react';
import { useParty, useValidateVies } from '../../_components/use-parties';

const REGIME_LABEL: Record<string, string> = {
  PT: 'Portugal (IVA normal)',
  UE_REVERSE_CHARGE: 'Intra-UE — autoliquidação',
  EXTRA_UE: 'Fora da UE',
};

/**
 * Fase 4 — estado VIES + regime de IVA do fornecedor. O botão chama
 * `POST /parties/:id/vies` (REST oficial da Comissão Europeia, cache de
 * 30 dias no backend). Para fornecedores PT valida `PT<NIF>`.
 */
export function ViesPanel({ partyId }: { partyId: string }) {
  const { data: party, refetch } = useParty(partyId);
  const validate = useValidateVies();
  if (!party) return null;
  const vat = party.vatNumber ?? (party.nif && (party.country ?? 'PT').toUpperCase().startsWith('PT') ? `PT${party.nif}` : null);
  const status = party.viesValid === true ? 'ok' : party.viesValid === false ? 'invalid' : 'unknown';
  const Icon = status === 'ok' ? ShieldCheck : status === 'invalid' ? ShieldAlert : ShieldQuestion;
  const color = status === 'ok' ? 'text-emerald-500' : status === 'invalid' ? 'text-red-500' : 'text-amber-500';

  return (
    <div className="card p-5 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold flex items-center gap-2">
          <Icon size={16} className={color} aria-hidden="true" />
          VIES / regime de IVA
        </h3>
        <button
          type="button"
          className="btn-secondary text-xs px-3 py-1.5"
          disabled={validate.isPending || !vat}
          onClick={() => validate.mutate({ id: partyId, force: true }, { onSuccess: () => void refetch() })}
          title={vat ? `Validar ${vat} no VIES` : 'Sem NIF / NIF-IVA para validar'}
        >
          {validate.isPending ? <Loader2 size={12} className="animate-spin" /> : 'Validar no VIES'}
        </button>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
        <dt style={{ color: 'var(--text-muted)' }}>NIF-IVA</dt>
        <dd className="font-mono">{vat ?? '—'}</dd>
        <dt style={{ color: 'var(--text-muted)' }}>Regime</dt>
        <dd>{REGIME_LABEL[party.vatRegime ?? 'PT'] ?? party.vatRegime}</dd>
        <dt style={{ color: 'var(--text-muted)' }}>Estado VIES</dt>
        <dd>
          {status === 'ok' && 'Válido'}
          {status === 'invalid' && 'Inválido / não registado'}
          {status === 'unknown' && 'Não validado'}
          {party.viesValidatedAt && (
            <span style={{ color: 'var(--text-muted)' }}> · {new Date(party.viesValidatedAt).toLocaleDateString('pt-PT')}</span>
          )}
        </dd>
        {party.viesName && (
          <>
            <dt style={{ color: 'var(--text-muted)' }}>Nome (VIES)</dt>
            <dd>{party.viesName}</dd>
          </>
        )}
        {party.viesAddress && (
          <>
            <dt style={{ color: 'var(--text-muted)' }}>Morada (VIES)</dt>
            <dd>{party.viesAddress}</dd>
          </>
        )}
        <dt style={{ color: 'var(--text-muted)' }}>Moeda</dt>
        <dd>{party.currency ?? 'EUR'}{party.directDebit ? ' · débito direto' : ''}</dd>
        {party.defaultCategory && (
          <>
            <dt style={{ color: 'var(--text-muted)' }}>Categoria default</dt>
            <dd>{party.defaultCategory.name}</dd>
          </>
        )}
      </dl>
      {validate.isError && (
        <p className="text-xs text-red-500">{(validate.error as Error).message}</p>
      )}
    </div>
  );
}
