'use client';

import {
  CircleCheck,
  CircleDollarSign,
  History,
  Pencil,
  ShieldCheck,
} from 'lucide-react';
import { usePartyTimeline } from '../../_components/use-parties';
import type { TimelineEvent } from '../../_lib/types';

interface TimelineTabProps {
  partyId: string;
}

/**
 * TimelineTab — vertical, icon-coloured list of events aggregated
 * across AuditLog, PaymentEvent, IbanHistory and approved Documents.
 *
 * Single page fetch for Sprint G.1 (top 20 events). Infinite scroll
 * is a follow-up — the backend already supports `?cursor=` so adding
 * `useInfiniteQuery` is a frontend-only change.
 *
 * Iconography:
 *   - audit        → Pencil
 *   - payment      → CircleDollarSign
 *   - iban_change  → ShieldCheck
 *   - document     → CircleCheck
 */
export function TimelineTab({ partyId }: TimelineTabProps) {
  const { data, isLoading } = usePartyTimeline(partyId);
  const items = data?.items ?? [];

  if (isLoading) {
    return <div className="card p-6 text-sm text-muted">A carregar…</div>;
  }

  if (items.length === 0) {
    return (
      <div className="card p-6 text-sm text-muted">
        <History size={14} className="inline mr-1.5" aria-hidden />
        Sem eventos — o histórico aparece quando há atividade na entidade.
      </div>
    );
  }

  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold">Histórico de atividade</h2>
        <p className="text-xs text-muted">
          Eventos das últimas ações em todas as fontes (auditoria, pagamentos, IBAN, aprovações).
        </p>
      </div>
      <ol className="relative border-l border-border ml-3 space-y-3">
        {items.map((e) => (
          <li key={`${e.type}-${e.id}`} className="ml-4">
            <span
              aria-hidden
              className={
                'absolute -left-[7px] flex items-center justify-center w-3.5 h-3.5 rounded-full ring-2 ring-card ' +
                colourFor(e.type)
              }
            />
            <div className="flex items-baseline justify-between gap-2">
              <div className="text-xs font-medium text-default">
                {titleFor(e)}
              </div>
              <time
                dateTime={e.at}
                className="text-[10px] text-muted whitespace-nowrap"
              >
                {new Date(e.at).toLocaleString('pt-PT')}
              </time>
            </div>
            <div className="text-xs text-muted mt-0.5">{detailFor(e)}</div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function colourFor(t: TimelineEvent['type']): string {
  switch (t) {
    case 'audit':
      return 'bg-slate-300';
    case 'payment':
      return 'bg-emerald-400';
    case 'iban_change':
      return 'bg-sky-400';
    case 'document_approved':
      return 'bg-violet-400';
  }
}

function titleFor(e: TimelineEvent): string {
  switch (e.type) {
    case 'audit':
      return 'Auditoria';
    case 'payment':
      return e.status === 'PAID' ? 'Pagamento confirmado' : 'Evento de pagamento';
    case 'iban_change':
      return e.verified ? 'IBAN verificado' : 'Mudança de IBAN';
    case 'document_approved':
      return 'Documento aprovado';
  }
}

function detailFor(e: TimelineEvent): React.ReactNode {
  const Icon =
    e.type === 'audit'
      ? Pencil
      : e.type === 'payment'
      ? CircleDollarSign
      : e.type === 'iban_change'
      ? ShieldCheck
      : CircleCheck;
  switch (e.type) {
    case 'audit':
      return (
        <span className="inline-flex items-center gap-1">
          <Icon size={11} aria-hidden /> ação: {e.action}
        </span>
      );
    case 'payment':
      return (
        <span className="inline-flex items-center gap-1">
          <Icon size={11} aria-hidden />
          {e.amount ?? '—'} · doc {e.document?.docNumber ?? e.documentId} · {e.status}
        </span>
      );
    case 'iban_change':
      return (
        <span className="inline-flex items-center gap-1">
          <Icon size={11} aria-hidden />
          {e.oldIban ? `${e.oldIban} → ${e.newIban}` : `Inicial: ${e.newIban}`}
        </span>
      );
    case 'document_approved':
      return (
        <span className="inline-flex items-center gap-1">
          <Icon size={11} aria-hidden />
          {e.fileName}
          {e.docNumber ? ` · ${e.docNumber}` : ''}
        </span>
      );
  }
}
