'use client';

/**
 * FraudWarning — IBAN anti-fraud banner for DocFlow documents.
 *
 * Editorial / Contábil · Blueprint Edition (commit 2026-09-04).
 *
 * Three variants rewritten with the new palette:
 *   1. match OK   → inline chip Fraunces 11px "✓ IBAN confere" com dot
 *                   status-ok (NÃO card verde silencioso).
 *   2. IBAN novo  → banner Fraunces 14px "Primeira transação com este
 *                   IBAN" com dot status-warn.
 *   3. IBAN mismatch → banner Fraunces 16px "IBAN NÃO CONFERE — possível
 *                      fraude" com dot status-alert + role=alert.
 *
 * Reads IBAN history through TanStack Query (party IBANs are cheap and
 * stable, so the cache stays warm across navigations).
 */

import { ShieldAlert, ShieldCheck, Info } from 'lucide-react';

export interface IbanHistoryEntry {
  iban: string;
  firstSeenAt: string;
  lastSeenAt?: string;
  documentCount: number;
}

export interface FraudWarningProps {
  /** IBAN extracted from the document being viewed. */
  currentIban?: string | null;
  /** All IBANs ever seen for the supplier (party history). */
  history?: IbanHistoryEntry[];
  /** Whether the supplier is linked to a party record at all. */
  hasParty?: boolean;
}

/**
 * Fase 4.2 (P0.2) — protege contra um item de histórico sem IBAN.
 *
 * Bug real: `Uncaught TypeError: Cannot read properties of undefined
 * (reading 'replace')` dentro de um `.map()` — um item de
 * `historyList` tinha `iban` undefined (registo antigo ou uma linha
 * que nunca chegou a gravar o IBAN) e `.replace` rebentava a página
 * inteira. Aceita `string | null | undefined` e nunca lança.
 */
function normalise(iban: string | null | undefined): string {
  return (iban ?? '').replace(/\s+/g, '').toUpperCase();
}

/** Small editorial dot for the status pills. */
function StatusDot({ tone }: { tone: 'ok' | 'warn' | 'alert' | 'neutral' }) {
  const color =
    tone === 'ok'
      ? 'var(--ed-status-ok)'
      : tone === 'alert'
      ? 'var(--ed-status-alert)'
      : tone === 'warn'
      ? 'var(--ed-status-warn)'
      : 'var(--ed-status-neutral)';
  return (
    <span
      className="inline-block w-1.5 h-1.5 rounded-full flex-shrink-0"
      style={{ background: color }}
      aria-hidden="true"
    />
  );
}

export function FraudWarning({ currentIban, history = [], hasParty }: FraudWarningProps) {
  // Normalise: backend may wrap the array in an envelope (e.g. { data: [...] }
  // or { items: [...] }). Always coerce to an array so `.map()` and `.length`
  // never throw on a response shape change.
  const historyList: IbanHistoryEntry[] = Array.isArray(history)
    ? history
    : Array.isArray((history as any)?.items)
    ? ((history as any).items as IbanHistoryEntry[])
    : Array.isArray((history as any)?.data)
    ? ((history as any).data as IbanHistoryEntry[])
    : [];

  // No IBAN extracted → nothing to verify.
  if (!currentIban) return null;

  // No history yet (new supplier or first invoice) → advisory chip only.
  if (historyList.length === 0) {
    return (
      <div
        role="status"
        className="flex items-start gap-3 px-4 py-3"
        style={{
          background: 'var(--ed-status-warn-dim)',
          border: '1px solid rgba(184, 134, 11, 0.35)',
          borderLeft: '3px solid var(--ed-status-warn)',
          borderRadius: 'var(--ed-radius-chip)',
        }}
      >
        <Info size={16} className="mt-0.5 flex-shrink-0" aria-hidden="true" style={{ color: 'var(--ed-status-warn)' }} />
        <div>
          <p
            className="flex items-center gap-2 font-semibold"
            style={{
              fontFamily: 'var(--font-editorial), ui-serif, Georgia, serif',
              fontSize: '14px',
              color: 'var(--ed-status-warn)',
            }}
          >
            Primeira transação com este IBAN.
          </p>
          <p
            className="mt-1"
            style={{
              fontFamily: 'var(--font-inter-tight), system-ui, sans-serif',
              fontSize: '12px',
              color: 'var(--ed-ink-soft)',
            }}
          >
            <span className="font-mono" style={{ color: 'var(--ed-ink)' }}>{currentIban}</span>
            {' '}
            {hasParty ? '(fornecedor conhecido)' : '(sem fornecedor associado)'}. Verifique
            manualmente antes de pagar.
          </p>
        </div>
      </div>
    );
  }

  const current = normalise(currentIban);
  // Filtramos entradas sem IBAN antes de normalizar — não é um valor
  // "diferente" do atual, é um registo sem dado nenhum para comparar.
  const knownIbans = new Set(
    historyList.filter((h) => h.iban).map((h) => normalise(h.iban)),
  );
  const matches = knownIbans.has(current);

  if (matches) {
    // Match OK — minimal inline chip, NÃO card verde silencioso.
    return (
      <div
        role="status"
        className="inline-flex items-center gap-1.5 px-2.5 py-1 font-semibold"
        style={{
          fontFamily: 'var(--font-editorial), ui-serif, Georgia, serif',
          fontSize: '11px',
          color: 'var(--ed-status-ok)',
          background: 'var(--ed-status-ok-dim)',
          borderRadius: 'var(--ed-radius-chip)',
        }}
      >
        <ShieldCheck size={12} aria-hidden="true" />
        <StatusDot tone="ok" />
        IBAN confere com o histórico do fornecedor.
      </div>
    );
  }

  // Mismatch — red warning, full evidence.
  const knownList = historyList
    .filter((h) => h.iban)
    .map((h) => `${h.iban} (${h.documentCount}× desde ${h.firstSeenAt ? h.firstSeenAt.slice(0, 10) : '?'})`)
    .join(' · ');

  return (
    <div
      role="alert"
      className="flex items-start gap-3 px-4 py-3"
      style={{
        background: 'var(--ed-status-alert-dim)',
        border: '1px solid rgba(139, 46, 42, 0.45)',
        borderLeft: '3px solid var(--ed-status-alert)',
        borderRadius: 'var(--ed-radius-chip)',
      }}
    >
      <ShieldAlert
        size={18}
        className="mt-0.5 flex-shrink-0"
        aria-hidden="true"
        style={{ color: 'var(--ed-status-alert)' }}
      />
      <div className="flex-1 min-w-0">
        <p
          className="flex items-center gap-2"
          style={{
            fontFamily: 'var(--font-editorial), ui-serif, Georgia, serif',
            fontSize: '16px',
            fontWeight: 700,
            color: 'var(--ed-status-alert)',
          }}
        >
          IBAN NÃO CONFERE — possível fraude.
        </p>
        <p
          className="mt-1"
          style={{
            fontFamily: 'var(--font-inter-tight), system-ui, sans-serif',
            fontSize: '12px',
            color: 'var(--ed-ink-soft)',
          }}
        >
          <span style={{ color: 'var(--ed-ink)' }}>Neste documento:</span>{' '}
          <span className="font-mono">{currentIban}</span>
        </p>
        <p
          className="mt-0.5 truncate"
          style={{
            fontFamily: 'var(--font-inter-tight), system-ui, sans-serif',
            fontSize: '12px',
            color: 'var(--ed-ink-soft)',
          }}
          title={knownList}
        >
          <span style={{ color: 'var(--ed-ink)' }}>Histórico conhecido:</span>{' '}
          {knownList}
        </p>
        <p
          className="mt-2"
          style={{
            fontFamily: 'var(--font-inter-tight), system-ui, sans-serif',
            fontSize: '12px',
            color: 'var(--ed-ink-soft)',
          }}
        >
          ⚠ Possível fraude ou troca de IBAN — confirme com o fornecedor antes de pagar.
        </p>
      </div>
    </div>
  );
}
