'use client';

import { useMemo } from 'react';
import { CalendarClock, Wallet } from 'lucide-react';
import { usePartyPayments } from '../../_components/use-parties';
import type { PartyPaymentEvent } from '../../_lib/types';

interface PaymentsTabProps {
  partyId: string;
}

const STATUS_LABELS: Record<PartyPaymentEvent['status'], string> = {
  PENDING: 'Pendente',
  PAID: 'Pago',
  OVERDUE: 'Em atraso',
};

const STATUS_BADGE: Record<PartyPaymentEvent['status'], string> = {
  PENDING: 'bg-slate-100 text-slate-700',
  PAID: 'bg-emerald-100 text-emerald-700',
  OVERDUE: 'bg-rose-100 text-rose-700',
};

/**
 * PaymentsTab — list of PaymentEvent rows for the party, sorted by
 * dueDate desc (returned by the backend). Shows the EUR total at the
 * top — sums the UNPAID rows so the operator can see the open exposure
 * at a glance. PAID rows count toward the historical total separately.
 *
 * Read-only — there is no PATCH/POST on this endpoint; mutations go
 * through Document.approve and the payment-schedule module.
 */
export function PaymentsTab({ partyId }: PaymentsTabProps) {
  const { data, isLoading } = usePartyPayments(partyId);

  const items = data ?? [];

  const { openTotal, paidTotal, currency } = useMemo(() => {
    let open = 0;
    let paid = 0;
    let cur: string | null = null;
    for (const e of items) {
      const amount = Number(e.amount ?? '0') || 0;
      if (e.status === 'PAID') paid += amount;
      else open += amount;
      if (!cur && e.document?.id) cur = 'EUR'; // backend hard-codes EUR
    }
    return { openTotal: open, paidTotal: paid, currency: cur ?? 'EUR' };
  }, [items]);

  if (isLoading) {
    return <div className="card p-6 text-sm text-muted">A carregar…</div>;
  }

  return (
    <section className="space-y-4">
      <div className="grid sm:grid-cols-2 gap-3">
        <div className="card p-4">
          <div className="text-xs uppercase tracking-wide text-muted">
            Em aberto
          </div>
          <div className="text-lg font-semibold mt-1">
            {fmtEur(openTotal, currency)}
          </div>
          <div className="text-[11px] text-muted mt-0.5">
            PENDENTE + EM ATRASO
          </div>
        </div>
        <div className="card p-4">
          <div className="text-xs uppercase tracking-wide text-muted">
            Pago
          </div>
          <div className="text-lg font-semibold mt-1">
            {fmtEur(paidTotal, currency)}
          </div>
          <div className="text-[11px] text-muted mt-0.5">
            Histórico confirmado
          </div>
        </div>
      </div>

      {items.length === 0 ? (
        <div className="card p-6 text-sm text-muted">
          Sem eventos de pagamento. Eventos são criados quando uma fatura
          é aprovada.
        </div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-muted">
                <th className="px-3 py-2 font-medium">Vencimento</th>
                <th className="px-3 py-2 font-medium">Documento</th>
                <th className="px-3 py-2 font-medium text-right">Valor</th>
                <th className="px-3 py-2 font-medium">Estado</th>
              </tr>
            </thead>
            <tbody>
              {items.map((e) => (
                <tr key={e.id} className="border-t border-border">
                  <td className="px-3 py-2 whitespace-nowrap">
                    <span className="inline-flex items-center gap-1">
                      <CalendarClock size={11} aria-hidden />
                      {fmtDate(e.dueDate)}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <span className="font-mono text-[11px]">
                      {e.document?.docNumber ?? e.documentId}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {fmtEur(Number(e.amount ?? '0'), 'EUR')}
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={
                        'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium ' +
                        STATUS_BADGE[e.status]
                      }
                    >
                      <Wallet size={9} aria-hidden /> {STATUS_LABELS[e.status]}
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

function fmtEur(n: number, _currency: string) {
  return new Intl.NumberFormat('pt-PT', {
    style: 'currency',
    currency: 'EUR',
  }).format(n);
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString('pt-PT');
}
