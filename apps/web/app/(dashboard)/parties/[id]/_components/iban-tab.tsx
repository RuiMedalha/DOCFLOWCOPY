'use client';

import { CircleCheck, Flag, ShieldAlert, ShieldCheck } from 'lucide-react';
import { useIbanHistory, useIbanRisk, useParty, useVerifyIban } from '../../_components/use-parties';

interface IbanTabProps {
  partyId: string;
  isAdmin: boolean;
}

/**
 * IbanTab — IBAN anti-fraud view: risk-score donut + history timeline.
 *
 * The risk-score donut is rendered as an inline SVG with stroke-dasharray
 * (no chart library needed). The IBAN history below shows oldIban →
 * newIban transitions with the verified badge for human-confirmed
 * entries.
 */
export function IbanTab({ partyId, isAdmin }: IbanTabProps) {
  const { data: party } = useParty(partyId);
  const { data: history } = useIbanHistory(partyId);
  const { data: risk } = useIbanRisk(partyId);
  const verify = useVerifyIban();

  const iban = party?.iban ?? null;

  return (
    <section className="space-y-5">
      <div className="grid lg:grid-cols-3 gap-4">
        <div className="card p-5 lg:col-span-2 space-y-2">
          <h2 className="text-sm font-semibold">IBAN atual</h2>
          {!iban ? (
            <div className="text-sm text-muted italic py-4">
              Sem IBAN registado nesta entidade.
            </div>
          ) : (
            <>
              <div className="font-mono text-sm">{iban}</div>
              <div className="text-xs text-muted">
                Máscara: {party?.ibanMasked ?? '—'}
              </div>
              <div className="flex flex-wrap gap-2 mt-2">
                {party?.ibanVerified && (
                  <span className="badge-emerald">
                    <CircleCheck size={10} aria-hidden /> Verificado
                  </span>
                )}
                {party?.ibanFlagged && (
                  <span className="badge-amber">
                    <Flag size={10} aria-hidden /> Marcado como risco
                  </span>
                )}
                {isAdmin && !party?.ibanVerified && (
                  <button
                    type="button"
                    className="btn-secondary btn-sm"
                    onClick={() => {
                      const reason =
                        prompt('Razão da verificação (opcional):') ?? '';
                      if (reason !== null) {
                        verify.mutate({ id: partyId, reason });
                      }
                    }}
                  >
                    Marcar como verificado
                  </button>
                )}
              </div>
            </>
          )}
        </div>

        <RiskDonut riskScore={risk?.riskScore} recommendation={risk?.recommendedAction} />
      </div>

      <div className="card overflow-x-auto">
        <h2 className="text-sm font-semibold px-4 pt-4">Histórico de alterações</h2>
        {history && history.length > 0 ? (
          <table className="w-full text-xs mt-2">
            <thead>
              <tr className="text-left text-muted">
                <th className="px-3 py-2 font-medium">Data</th>
                <th className="px-3 py-2 font-medium">De</th>
                <th className="px-3 py-2 font-medium">Para</th>
                <th className="px-3 py-2 font-medium">Razão</th>
                <th className="px-3 py-2 font-medium">Verificado</th>
              </tr>
            </thead>
            <tbody>
              {history.map((h) => (
                <tr key={h.id} className="border-t border-border">
                  <td className="px-3 py-2 whitespace-nowrap">
                    {new Date(h.createdAt).toLocaleString('pt-PT')}
                  </td>
                  <td className="px-3 py-2 font-mono">
                    {h.oldIban ?? <span className="italic text-muted">(inicial)</span>}
                  </td>
                  <td className="px-3 py-2 font-mono">{h.newIban}</td>
                  <td className="px-3 py-2">{h.reason ?? '—'}</td>
                  <td className="px-3 py-2">
                    {h.verified ? (
                      <span className="badge-emerald">
                        <CircleCheck size={10} aria-hidden /> Sim
                      </span>
                    ) : (
                      <span className="text-muted">Não</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="text-sm text-muted italic px-4 py-6">
            Sem histórico IBAN.
          </div>
        )}
      </div>
    </section>
  );
}

/** Compact SVG donut for the 0..100 risk score. */
function RiskDonut({
  riskScore,
  recommendation,
}: {
  riskScore: number | undefined;
  recommendation?: 'allow' | 'review' | 'block';
}) {
  const value = riskScore ?? 0;
  const C = 2 * Math.PI * 36; // circumference for r=36
  const dash = (value / 100) * C;
  const colour =
    value > 70
      ? '#e11d48' // rose-600
      : value > 30
      ? '#f59e0b' // amber-500
      : '#10b981'; // emerald-500
  const Icon =
    recommendation === 'block'
      ? ShieldAlert
      : value <= 30
      ? ShieldCheck
      : ShieldAlert;

  return (
    <div className="card p-5 flex items-center gap-4">
      <div className="relative w-24 h-24 shrink-0">
        <svg viewBox="0 0 96 96" className="w-full h-full -rotate-90">
          <circle
            cx="48"
            cy="48"
            r="36"
            fill="none"
            stroke="#e2e8f0"
            strokeWidth="10"
          />
          <circle
            cx="48"
            cy="48"
            r="36"
            fill="none"
            stroke={colour}
            strokeWidth="10"
            strokeDasharray={`${dash} ${C - dash}`}
            strokeLinecap="round"
          />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center text-sm font-semibold">
          {value}
        </div>
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-xs uppercase tracking-wide text-muted">
          Risco IBAN
        </div>
        <div className="text-sm font-semibold inline-flex items-center gap-1">
          <Icon size={14} aria-hidden />
          {recommendation === 'block'
            ? 'Bloquear'
            : recommendation === 'review'
            ? 'Rever'
            : 'Permitir'}
        </div>
        <div className="text-[11px] text-muted mt-1">
          Score calculado a partir de blacklist + frequência + país + verificação manual.
        </div>
      </div>
    </div>
  );
}
