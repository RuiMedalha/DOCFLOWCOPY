'use client';

/**
 * QrBadge — Portuguese AT QR-Code badge for DocFlow documents.
 *
 * Editorial / Contábil · Blueprint Edition (commit 2026-09-04).
 *   - Empty state: chip Fraunces 12px "Documento não traz QR-AT — verifique
 *     manualmente" (não o minimalista "Sem QR-AT").
 *   - Expanded: dl em 2-col com hairline separators, labels em Fraunces 11px
 *     uppercase tracking-wider ink-faint, valores em JetBrains Mono 13px ink.
 *   - Highlights em accent-gold-dim (não rgba(56,189,248,.12)).
 *
 * Designed to mirror the AT-spec field naming (A: emitente NIF, B: adquirente,
 * D: tipo, F: data, H: ATCUD, …). The parser is provided by @docflow/shared
 * (the same module the backend uses), so the UI shows EXACTLY what the
 * server decoded — no drift.
 */

import { useState } from 'react';
import { QrCode, CheckCircle2, AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react';
import { parseAndValidateAtQr } from '@docflow/shared';

export interface QrBadgeProps {
  /** Raw QR-AT payload string (the asterisk-separated "CODIGO:valor" pairs). */
  qrPayload?: string | null;
  /** Optional list of decoded field labels to highlight in the source document. */
  highlightedFields?: string[];
}

const FIELD_LABELS: Record<string, string> = {
  A: 'NIF emitente',
  B: 'NIF adquirente',
  C: 'País adquirente',
  D: 'Tipo doc.',
  E: 'Estado',
  F: 'Data doc.',
  G: 'ID único',
  H: 'ATCUD',
  I1: 'Região PT',
  I2: 'Base isenta',
  I3: 'Base reduzida',
  I4: 'IVA reduzido',
  I5: 'Base intermédia',
  I6: 'IVA intermédio',
  I7: 'Base normal',
  I8: 'IVA normal',
  L: 'Outros',
  M: 'Imposto selo',
  N: 'Total IVA',
  O: 'Total doc.',
  P: 'Retenção',
  Q: 'Hash (4)',
  R: 'Cert. software',
};

export function QrBadge({ qrPayload, highlightedFields = [] }: QrBadgeProps) {
  const [open, setOpen] = useState(false);

  if (!qrPayload || qrPayload.trim().length === 0) {
    return (
      <span
        className="inline-flex items-center gap-2 px-3 py-1.5"
        style={{
          fontFamily: 'var(--font-editorial), ui-serif, Georgia, serif',
          fontSize: '12px',
          color: 'var(--ed-ink-soft)',
          background: 'var(--ed-canvas-2)',
          border: '1px dashed var(--ed-rule-strong)',
          borderRadius: 'var(--ed-radius-chip)',
        }}
        title="Documento sem QR-AT — verifique manualmente."
      >
        <QrCode size={13} aria-hidden="true" style={{ color: 'var(--ed-ink-faint)' }} />
        Documento não traz QR-AT — verifique manualmente.
      </span>
    );
  }

  const { parsed, validation } = parseAndValidateAtQr(qrPayload);
  const isOk = validation.ok;

  return (
    <div
      style={{
        background: 'var(--ed-panel)',
        border: '1px solid var(--ed-rule)',
        borderRadius: 'var(--ed-radius-card)',
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-3 px-4 py-3 text-left transition-colors"
        style={{
          background: 'transparent',
        }}
        aria-expanded={open}
        aria-controls="qr-at-detail"
      >
        <span
          className="inline-flex items-center justify-center w-7 h-7"
          style={{
            background: isOk ? 'var(--ed-status-ok-dim)' : 'var(--ed-status-warn-dim)',
            borderRadius: 'var(--ed-radius-chip)',
          }}
          aria-hidden="true"
        >
          <QrCode
            size={14}
            style={{ color: isOk ? 'var(--ed-status-ok)' : 'var(--ed-status-warn)' }}
          />
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span
              className="font-medium"
              style={{
                fontFamily: 'var(--font-editorial), ui-serif, Georgia, serif',
                fontSize: '14px',
                color: 'var(--ed-ink)',
              }}
            >
              QR-AT detectável
            </span>
            {isOk ? (
              <span
                className="inline-flex items-center gap-1 px-1.5 py-0.5 font-semibold"
                style={{
                  fontFamily: 'var(--font-inter-tight), system-ui, sans-serif',
                  fontSize: '10px',
                  textTransform: 'uppercase',
                  letterSpacing: '0.12em',
                  color: 'var(--ed-status-ok)',
                  background: 'var(--ed-status-ok-dim)',
                  borderRadius: 'var(--ed-radius-chip)',
                }}
              >
                <CheckCircle2 size={10} aria-hidden="true" />
                válido
              </span>
            ) : (
              <span
                className="inline-flex items-center gap-1 px-1.5 py-0.5 font-semibold"
                style={{
                  fontFamily: 'var(--font-inter-tight), system-ui, sans-serif',
                  fontSize: '10px',
                  textTransform: 'uppercase',
                  letterSpacing: '0.12em',
                  color: 'var(--ed-status-warn)',
                  background: 'var(--ed-status-warn-dim)',
                  borderRadius: 'var(--ed-radius-chip)',
                }}
              >
                <AlertTriangle size={10} aria-hidden="true" />
                {validation.errors.length} erro{validation.errors.length === 1 ? '' : 's'}
              </span>
            )}
          </div>
          <p
            className="truncate"
            style={{
              fontFamily: '"JetBrains Mono", ui-monospace, monospace',
              fontSize: '12px',
              color: 'var(--ed-ink-soft)',
              marginTop: '2px',
            }}
          >
            {parsed?.issuerNif ? `NIF ${parsed.issuerNif}` : 'Emitente desconhecido'}
            {parsed?.uniqueDocId ? ` · ${parsed.uniqueDocId}` : ''}
            {parsed?.total != null ? ` · ${parsed.total.toFixed(2)} EUR` : ''}
          </p>
        </div>
        {open ? (
          <ChevronDown size={16} aria-hidden="true" style={{ color: 'var(--ed-ink-faint)' }} />
        ) : (
          <ChevronRight size={16} aria-hidden="true" style={{ color: 'var(--ed-ink-faint)' }} />
        )}
      </button>

      {open && parsed && (
        <div
          id="qr-at-detail"
          className="px-4 pb-4 pt-1"
          style={{ borderTop: '1px solid var(--ed-rule)' }}
        >
          {/* Validation summary */}
          {(validation.errors.length > 0 || validation.warnings.length > 0) && (
            <div className="mt-2 mb-3 space-y-1">
              {validation.errors.map((err, i) => (
                <p
                  key={`e${i}`}
                  className="text-xs flex items-start gap-1.5"
                  style={{ color: 'var(--ed-status-alert)' }}
                >
                  <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
                  <span>{err}</span>
                </p>
              ))}
              {validation.warnings.map((warn, i) => (
                <p
                  key={`w${i}`}
                  className="text-xs flex items-start gap-1.5"
                  style={{ color: 'var(--ed-status-warn)' }}
                >
                  <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
                  <span>{warn}</span>
                </p>
              ))}
            </div>
          )}

          {/* Decoded fields — dl 2-col, hairline separators, labels Fraunces
              11px uppercase tracking-wider ink-faint, valores JetBrains
              Mono 13px ink. Highlights em accent-gold-dim. */}
          <dl
            className="grid grid-cols-2 gap-x-4"
            style={{ borderTop: '1px solid var(--ed-rule)' }}
          >
            {Object.entries(parsed.fields)
              .filter(([code]) => FIELD_LABELS[code])
              .map(([code, value]) => {
                const highlighted = highlightedFields.includes(code) || highlightedFields.includes(value);
                return (
                  <div
                    key={code}
                    className={`flex items-baseline gap-2 py-2 ${highlighted ? 'px-2' : ''}`}
                    style={{
                      borderBottom: '1px solid var(--ed-rule)',
                      background: highlighted ? 'var(--ed-accent-gold-dim)' : 'transparent',
                    }}
                  >
                    <dt
                      className="uppercase tracking-wider w-12 flex-shrink-0 font-medium"
                      style={{
                        fontFamily: 'var(--font-editorial), ui-serif, Georgia, serif',
                        fontSize: '11px',
                        color: 'var(--ed-ink-faint)',
                      }}
                    >
                      {code}
                    </dt>
                    <dd
                      className="flex-1 truncate tabular-nums"
                      style={{
                        fontFamily: '"JetBrains Mono", ui-monospace, monospace',
                        fontSize: '13px',
                        color: 'var(--ed-ink)',
                      }}
                      title={value}
                    >
                      {value}
                    </dd>
                  </div>
                );
              })}
          </dl>

          {/* Raw payload */}
          <details className="mt-3">
            <summary
              className="text-xs cursor-pointer select-none uppercase tracking-wider"
              style={{
                fontFamily: 'var(--font-inter-tight), system-ui, sans-serif',
                color: 'var(--ed-ink-faint)',
              }}
            >
              payload bruto
            </summary>
            <pre
              className="mt-2 p-2 text-xs break-all whitespace-pre-wrap"
              style={{
                background: 'var(--ed-canvas-2)',
                color: 'var(--ed-ink-soft)',
                fontFamily: '"JetBrains Mono", ui-monospace, monospace',
                borderRadius: 'var(--ed-radius-chip)',
              }}
            >
              {qrPayload}
            </pre>
          </details>
        </div>
      )}
    </div>
  );
}
