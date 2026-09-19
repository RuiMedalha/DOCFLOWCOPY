'use client';

import { useState } from 'react';
import { ShieldCheck, ShieldAlert, ShieldQuestion, Loader2 } from 'lucide-react';
import { useIbanRisk, useIbanHistory, useVerifyIban, useFlagIban, useParty } from './use-parties';

export function PartyIbanPanel({ partyId }: { partyId: string }) {
  const { data: party } = useParty(partyId);
  const { data: history, isLoading: histLoading } = useIbanHistory(partyId);
  const { data: risk, isLoading: riskLoading, refetch } = useIbanRisk(partyId);
  const verify = useVerifyIban();
  const flag = useFlagIban();
  const [reason, setReason] = useState('');

  if (!party?.iban) {
    return (
      <div className="card p-5 text-center text-xs" style={{ color: 'var(--text-muted)' }}>
        Sem IBAN registado.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div
        className="card p-5"
        style={{
          background:
            risk?.recommendedAction === 'block' ? 'rgba(248,113,113,0.05)'
            : risk?.recommendedAction === 'review' ? 'rgba(245,158,11,0.05)'
            : undefined,
        }}
      >
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold flex items-center gap-2">
              {risk?.recommendedAction === 'block' ? <ShieldAlert size={16} className="text-red-500" />
                : risk?.recommendedAction === 'review' ? <ShieldQuestion size={16} className="text-amber-500" />
                : <ShieldCheck size={16} className="text-emerald-500" />}
              Anti-fraude IBAN
            </h3>
            <p className="font-mono text-xs mt-1" style={{ color: 'var(--text-muted)' }}>{party.iban}</p>
            {party.bic && <p className="text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>BIC: {party.bic}</p>}
          </div>
          <div className="text-right">
            {riskLoading ? (
              <Loader2 size={14} className="animate-spin" />
            ) : risk ? (
              <>
                <div className="text-3xl font-bold" style={{ color: risk.riskScore > 70 ? '#ef4444' : risk.riskScore > 30 ? '#f59e0b' : '#10b981' }}>
                  {risk.riskScore}
                </div>
                <div className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>Risco · {risk.recommendedAction}</div>
              </>
            ) : null}
          </div>
        </div>

        {risk?.breakdown && risk.breakdown.length > 0 && (
          <ul className="mt-4 space-y-1.5">
            {risk.breakdown.map((b) => (
              <li key={b.factor} className="text-xs flex items-start gap-2">
                <span className="font-mono text-[10px] w-8 text-right" style={{ color: b.score > 0 ? '#f59e0b' : '#10b981' }}>
                  {b.score > 0 ? `+${b.score}` : b.score}
                </span>
                <span><span className="font-medium">{b.factor}</span> · {b.reason}</span>
              </li>
            ))}
          </ul>
        )}

        <div className="flex items-center gap-2 mt-4 pt-3 border-t" style={{ borderColor: 'var(--border)' }}>
          <input
            className="input text-xs flex-1"
            placeholder="Motivo (auditado)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <button
            type="button"
            className="btn-secondary text-xs px-3 py-1.5"
            disabled={verify.isPending || !reason.trim()}
            onClick={() => verify.mutate({ id: partyId, reason }, { onSuccess: () => { setReason(''); void refetch(); } })}
          >
            Marcar verificado
          </button>
          <button
            type="button"
            className="text-xs px-3 py-1.5 rounded-md text-red-500 hover:bg-red-500/10"
            style={{ border: '1px solid rgba(248,113,113,0.30)' }}
            disabled={flag.isPending || !reason.trim()}
            onClick={() => flag.mutate({ id: partyId, reason }, { onSuccess: () => { setReason(''); void refetch(); } })}
          >
            Sinalizar + blacklist
          </button>
        </div>
      </div>

      <div className="card p-5">
        <h3 className="text-sm font-semibold mb-3">Histórico de IBAN</h3>
        {histLoading && <p className="text-xs" style={{ color: 'var(--text-muted)' }}>A carregar…</p>}
        {(history ?? []).length === 0 && !histLoading && (
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Sem alterações.</p>
        )}
        <ul className="space-y-2">
          {(history ?? []).map((h) => (
            <li key={h.id} className="text-xs border-l-2 pl-3" style={{ borderColor: h.verified ? 'rgba(34,197,94,0.50)' : 'rgba(245,158,11,0.50)' }}>
              <div className="font-mono">
                {h.oldIban ? `${h.oldIban} → ` : ''}<span className="font-semibold">{h.newIban}</span>
              </div>
              <div style={{ color: 'var(--text-muted)' }}>
                {new Date(h.createdAt).toLocaleString('pt-PT')} · {h.changedByName ?? h.changedBy}
                {h.verified && ' · ✓ verificado'}
                {h.reason && ` · ${h.reason}`}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function formatWebsiteUrl(raw?: string | null): string | null {
  if (!raw || !raw.trim()) return null;
  const trimmed = raw.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  return `https://${trimmed}`;
}

export function PartyDetailCard({
  party,
}: {
  party: any;
}) {
  if (!party) return null;

  const websiteUrl = formatWebsiteUrl(party.website);
  const formattedAddress = [party.address, party.postalCode, party.city, party.country]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="card p-5 mb-4 space-y-4" data-testid="party-detail-card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b pb-3" style={{ borderColor: 'var(--border)' }}>
        <div>
          <h3 className="text-base font-semibold" style={{ color: 'var(--text)' }}>
            {party.name}
          </h3>
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
            {party.type} {party.nif ? `· NIF: ${party.nif}` : '· Sem NIF'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {party.ibanVerified && (
            <span className="badge-emerald inline-flex items-center gap-1 text-xs">
              <ShieldCheck size={13} /> NIB Verificado
            </span>
          )}
          {party.vatRegime && (
            <span className="badge-sky text-xs">
              {party.vatRegime === 'PT' ? 'IVA Normal (PT)' : 'Autoliquidação UE'}
            </span>
          )}
        </div>
      </div>

      <div className="grid sm:grid-cols-2 md:grid-cols-3 gap-3 text-xs">
        {websiteUrl ? (
          <div>
            <span className="block text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>Página Web:</span>
            <a
              href={websiteUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sky-600 hover:underline inline-flex items-center gap-1 font-medium mt-0.5"
            >
              {party.website} ↗
            </a>
          </div>
        ) : null}

        {party.email ? (
          <div>
            <span className="block text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>Email Geral:</span>
            <a href={`mailto:${party.email}`} className="text-sky-600 hover:underline font-medium mt-0.5 block">
              {party.email}
            </a>
          </div>
        ) : null}

        {party.billingEmail ? (
          <div>
            <span className="block text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>Email de Faturação:</span>
            <a href={`mailto:${party.billingEmail}`} className="text-sky-600 hover:underline font-medium mt-0.5 block">
              {party.billingEmail}
            </a>
          </div>
        ) : null}

        {party.phone ? (
          <div>
            <span className="block text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>Telefone:</span>
            <a href={`tel:${party.phone.replace(/\s+/g, '')}`} className="text-sky-600 hover:underline font-medium mt-0.5 block">
              {party.phone}
            </a>
          </div>
        ) : null}

        {party.mobile ? (
          <div>
            <span className="block text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>Telemóvel:</span>
            <a href={`tel:${party.mobile.replace(/\s+/g, '')}`} className="text-sky-600 hover:underline font-medium mt-0.5 block">
              {party.mobile}
            </a>
          </div>
        ) : null}

        {party.iban ? (
          <div>
            <span className="block text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>NIB / IBAN:</span>
            <span className="font-mono mt-0.5 block" style={{ color: 'var(--text)' }}>
              {party.iban}
            </span>
          </div>
        ) : null}
      </div>

      {formattedAddress ? (
        <div className="pt-2 border-t text-xs" style={{ borderColor: 'var(--border)', color: 'var(--text-muted)' }}>
          <span className="font-medium" style={{ color: 'var(--text)' }}>Morada: </span>
          {formattedAddress}
        </div>
      ) : null}
    </div>
  );
}