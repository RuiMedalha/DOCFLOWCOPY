'use client';

/**
 * PartyRecentDocuments — "Faturas recentes" section on `/parties/:id`.
 *
 * Shows the most recent N documents linked to the party (default 10),
 * with status badge, total and a quick link to the detail page. The
 * "Ver todas" button just redirects to the inbox with the `partyId`
 * filter — `GET /documents?partyId=...` already supports it.
 *
 * Renders only when the parent passes `partyId` and the party type is
 * FORNECEDOR (callers should gate on this so the section doesn't show
 * on customer/ambos cards where the supplier history is irrelevant).
 */

import Link from 'next/link';
import { Loader2, FileText, ChevronRight } from 'lucide-react';
import { usePartyDocuments } from '../../_hooks/use-party-documents';
import type { PartyDocument as PartyDocumentType } from '../../_lib/types';

// Fase 4.2 (P0.4) — em produção duas em três linhas do IKEA não
// mostravam estado nenhum: faltavam PENDING_APPROVAL, CHANGES_REQUESTED
// e DUPLICADO neste mapa, por isso o lookup devolvia `undefined` (sem
// className, sem texto) para qualquer documento nesses estados.
const STATUS_TONE: Record<PartyDocumentType['status'], string> = {
  NOVO: 'badge-sky',
  EM_REVISAO: 'badge-amber',
  APROVADO: 'badge-emerald',
  REJEITADO: 'badge-rose',
  CONCILIADO: 'badge-violet',
  PAGO: 'badge-neutral',
  ARQUIVADO: 'badge-neutral',
  PENDING_APPROVAL: 'badge-amber',
  CHANGES_REQUESTED: 'badge-amber',
  DUPLICADO: 'badge-rose',
};

const STATUS_LABEL: Record<PartyDocumentType['status'], string> = {
  NOVO: 'NOVO',
  EM_REVISAO: 'PENDENTE',
  APROVADO: 'APROVADO',
  REJEITADO: 'REJEITADO',
  CONCILIADO: 'CONCILIADO',
  PAGO: 'PAGO',
  ARQUIVADO: 'ARQUIVADO',
  PENDING_APPROVAL: 'POR APROVAR',
  CHANGES_REQUESTED: 'CORREÇÕES PEDIDAS',
  DUPLICADO: 'DUPLICADO',
};

const fmtMoney = (v: number | null | undefined, ccy = 'EUR') =>
  v == null
    ? '—'
    : `${v.toLocaleString('pt-PT', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${ccy}`;

const fmtDate = (v?: string | null) => {
  if (!v) return '—';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toLocaleDateString('pt-PT');
};

export function PartyRecentDocuments({ partyId }: { partyId: string }) {
  const { data, isLoading, isError } = usePartyDocuments(partyId, 10);
  const items = data?.items ?? [];

  return (
    <section className="card p-4 space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h3 className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-subtle)' }}>
          Faturas recentes
        </h3>
        <Link
          href={`/documents?partyId=${encodeURIComponent(partyId)}`}
          className="text-xs inline-flex items-center gap-1 hover:underline"
          style={{ color: 'var(--accent)' }}
        >
          Ver todas <ChevronRight size={12} aria-hidden="true" />
        </Link>
      </div>

      {isLoading && (
        <div className="flex items-center gap-2 text-xs py-6" style={{ color: 'var(--text-muted)' }}>
          <Loader2 size={14} className="animate-spin" aria-hidden="true" />
          A carregar faturas…
        </div>
      )}

      {isError && (
        <div className="text-xs py-4" style={{ color: 'var(--danger)' }}>
          Não foi possível carregar as faturas deste fornecedor.
        </div>
      )}

      {!isLoading && !isError && items.length === 0 && (
        <div
          className="flex items-center gap-2 text-xs py-6"
          style={{ color: 'var(--text-muted)' }}
        >
          <FileText size={14} aria-hidden="true" />
          Sem faturas associadas a este fornecedor.
        </div>
      )}

      {!isLoading && !isError && items.length > 0 && (
        <div className="overflow-x-auto -mx-2 px-2">
          <table className="w-full text-xs">
            <thead>
              <tr style={{ color: 'var(--text-subtle)' }}>
                <th className="text-left font-medium pb-2">Nº documento</th>
                <th className="text-left font-medium pb-2">Data</th>
                <th className="text-right font-medium pb-2 tabular-nums">Total</th>
                <th className="text-center font-medium pb-2">Estado</th>
              </tr>
            </thead>
            <tbody>
              {items.map((doc) => (
                <tr key={doc.id} className="border-t border-border">
                  <td className="py-2 pr-3 font-mono" style={{ color: 'var(--text)' }}>
                    <Link
                      href={`/documents/${doc.id}`}
                      className="hover:underline inline-flex items-center gap-1"
                    >
                      {doc.docNumber ?? `doc-${doc.id.slice(0, 6)}`}
                    </Link>
                  </td>
                  <td className="py-2 pr-3 tabular-nums" style={{ color: 'var(--text-muted)' }}>
                    {fmtDate(doc.docDate ?? doc.createdAt)}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums" style={{ color: 'var(--text)' }}>
                    {fmtMoney(doc.total, doc.currency ?? 'EUR')}
                  </td>
                  <td className="py-2 text-center">
                    <span
                      className={STATUS_TONE[doc.status] ?? 'badge-neutral'}
                      title={`Estado: ${doc.status}`}
                    >
                      {STATUS_LABEL[doc.status] ?? doc.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}