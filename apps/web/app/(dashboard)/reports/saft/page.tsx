'use client';

/**
 * /reports/saft — SAF-T PT exporter.
 *
 * Operator-facing form: pick a from/to window (defaults to the
 * last 30 days), hit "Gerar SAF-T" and the browser downloads
 * `saft-pt-<tenantSlug>-<from>-<to>.xml`. The same endpoint
 * returns the XML stream regardless of size, so a 50 MB file
 * never blocks the dashboard.
 *
 * "Histórico" panel lists the most recent exports by reading
 * the audit log filtered on `entityType === 'saft_export'`.
 * The audit endpoint returns rows in reverse chronological
 * order, so the operator can see exactly what each export
 * contained (period + documentCount + hashChain head/tail).
 *
 * Editorial skin tokens — no new globals.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  Download,
  FileText,
  Loader2,
  AlertCircle,
  ShieldCheck,
  Calendar,
} from 'lucide-react';
import { authedFetch } from '../../../_lib/auth-refresh';
import { toastBus } from '../../../_components/ui';

class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await authedFetch(`${API_BASE}${path}`, init);
  if (!res.ok) {
    let body: any = {};
    try {
      body = await res.json();
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, body?.message ?? `HTTP ${res.status}`);
  }
  const json = await res.json();
  return (json?.data ?? json) as T;
}

const API_BASE =
  (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, '')) ||
  'http://localhost:4000/api/v1';

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function thirtyDaysAgoIso(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 30);
  return d.toISOString().slice(0, 10);
}

async function downloadSaft(from: string, to: string): Promise<{ fileName: string; bytes: number }> {
  // We use a raw fetch so the browser's download manager
  // receives the streamed XML with the right Content-Disposition
  // header. authedFetch() does not expose Response bodies cleanly
  // for binary download, so we re-author the Bearer token via
  // localStorage here.
  const token =
    typeof window !== 'undefined' ? window.localStorage.getItem('access_token') : null;
  const qs = `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  const res = await fetch(`${API_BASE}/saft/export${qs}`, {
    method: 'GET',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    let body: any = {};
    try {
      body = await res.json();
    } catch {
      /* ignore */
    }
    throw new Error(body?.message ?? `HTTP ${res.status}`);
  }
  const fileName =
    res.headers.get('content-disposition')?.match(/filename="?([^"]+)"?/)?.[1] ??
    `saft-pt-${from}-${to}.xml`;
  const blob = await res.blob();
  const bytes = blob.size;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  return { fileName, bytes };
}

interface AuditEntry {
  id: string;
  createdAt: string;
  metadata: {
    subAction: string;
    period: { from: string; to: string };
    documentCount: number;
    hashChainHead: string;
    hashChainTail: string;
    version: string;
  };
}

async function fetchExportHistory(): Promise<AuditEntry[]> {
  // The audit endpoint accepts a `entityType` filter; in a future
  // sprint we'll add an explicit `/audit?entityType=saft_export`
  // shortcut, but the list endpoint already serves our needs.
  return apiFetch<AuditEntry[]>(`/audit?entityType=saft_export&limit=20`);
}

export default function SaftReportPage() {
  const [from, setFrom] = useState(thirtyDaysAgoIso);
  const [to, setTo] = useState(todayIso);

  const exportMutation = useMutation({
    mutationFn: () => downloadSaft(from, to),
    onSuccess: ({ fileName, bytes }) => {
      const kb = (bytes / 1024).toFixed(1);
      toastBus.success(`SAF-T exportado (${kb} KB) — ${fileName}`);
    },
    onError: (err: any) => {
      const msg = typeof err?.message === 'string' ? err.message : 'Falha ao exportar SAF-T.';
      toastBus.error(msg);
    },
  });

  const historyQuery = useQuery({
    queryKey: ['saft-export-history'],
    queryFn: fetchExportHistory,
    refetchOnMount: true,
    refetchOnWindowFocus: false,
  });

  const sampleTest = useMutation({
    mutationFn: async () => {
      // The /saft/export/test endpoint returns the XML inline (no
      // attachment). We surface a small download so the operator
      // can sanity-check the shape without pulling the full window.
      return apiFetch<string>(`/saft/export/test`);
    },
    onSuccess: () => {
      toastBus.success('Sample SAF-T gerado.');
    },
    onError: (err: any) => {
      toastBus.error(typeof err?.message === 'string' ? err.message : 'Falha ao gerar sample.');
    },
  });

  const fromAfterTo = useMemo(() => from > to, [from, to]);

  // Auto-refetch history after a successful export so the new row
  // appears in the list immediately.
  useEffect(() => {
    if (exportMutation.isSuccess) {
      historyQuery.refetch();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exportMutation.isSuccess]);

  const onSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (fromAfterTo) {
        toastBus.error('Data de início deve ser anterior à data de fim.');
        return;
      }
      exportMutation.mutate();
    },
    [fromAfterTo, exportMutation],
  );

  return (
    <div data-skin="editorial" className="min-h-screen">
      {/* Header */}
      <header className="border-b" style={{ borderColor: 'var(--ed-rule)' }}>
        <div className="px-2 pt-6 pb-5">
          <h1
            className="font-mono font-bold leading-[1] tracking-tight"
            style={{ fontSize: 'clamp(32px, 4vw, 44px)', color: 'var(--ed-ink)', letterSpacing: '-0.02em' }}
          >
            Export SAF-T PT
          </h1>
          <p className="mt-3 text-sm" style={{ color: 'var(--ed-ink-soft)' }}>
            Gera um ficheiro SAF-T PT v1.04_01 (formato Autoridade Tributária) com as faturas aprovadas no período.
            O hash chain (SHA-1) é calculado linha-a-linha; cada export fica registado no log de auditoria.
          </p>
        </div>
      </header>

      <div className="px-2 py-8 grid grid-cols-1 xl:grid-cols-3 gap-6" style={{ padding: '32px 16px 64px' }}>
        {/* Form card */}
        <form
          onSubmit={onSubmit}
          className="card p-6 space-y-4 xl:col-span-2"
          style={{ borderColor: 'var(--ed-rule)' }}
          data-testid="saft-form"
        >
          <h2
            className="uppercase tracking-wider font-medium text-sm"
            style={{
              fontFamily: 'var(--font-editorial), ui-serif, Georgia, serif',
              letterSpacing: '0.08em',
              color: 'var(--ed-ink-faint)',
            }}
          >
            Parâmetros do período
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <label className="block">
              <span
                className="text-[12px] uppercase tracking-wider font-medium"
                style={{ color: 'var(--ed-ink-faint)' }}
              >
                Data de início
              </span>
              <div
                className="mt-1 flex items-center gap-2 px-3 py-2 border rounded"
                style={{ borderColor: 'var(--ed-rule-strong)' }}
              >
                <Calendar size={14} aria-hidden="true" style={{ color: 'var(--ed-ink-faint)' }} />
                <input
                  type="date"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                  max={to}
                  className="flex-1 bg-transparent text-sm font-mono focus:outline-none"
                  style={{ color: 'var(--ed-ink)' }}
                  data-testid="saft-from-input"
                  required
                />
              </div>
            </label>
            <label className="block">
              <span
                className="text-[12px] uppercase tracking-wider font-medium"
                style={{ color: 'var(--ed-ink-faint)' }}
              >
                Data de fim
              </span>
              <div
                className="mt-1 flex items-center gap-2 px-3 py-2 border rounded"
                style={{ borderColor: 'var(--ed-rule-strong)' }}
              >
                <Calendar size={14} aria-hidden="true" style={{ color: 'var(--ed-ink-faint)' }} />
                <input
                  type="date"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  min={from}
                  max={todayIso()}
                  className="flex-1 bg-transparent text-sm font-mono focus:outline-none"
                  style={{ color: 'var(--ed-ink)' }}
                  data-testid="saft-to-input"
                  required
                />
              </div>
            </label>
          </div>
          {fromAfterTo && (
            <p className="text-xs flex items-center gap-1.5" style={{ color: 'var(--ed-status-alert)' }}>
              <AlertCircle size={12} aria-hidden="true" />
              Data de início tem de ser anterior à data de fim.
            </p>
          )}
          <div className="flex items-center gap-2 pt-2">
            <button
              type="submit"
              disabled={exportMutation.isPending || fromAfterTo}
              aria-busy={exportMutation.isPending}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium transition-opacity disabled:opacity-50"
              style={{
                background: 'var(--ed-accent-gold)',
                color: 'var(--ed-ink)',
                borderRadius: 'var(--ed-radius-chip)',
              }}
              data-testid="saft-export-button"
            >
              {exportMutation.isPending ? (
                <Loader2 size={14} className="animate-spin" aria-hidden="true" />
              ) : (
                <Download size={14} aria-hidden="true" />
              )}
              {exportMutation.isPending ? 'A exportar…' : 'Gerar SAF-T'}
            </button>
            <button
              type="button"
              onClick={() => sampleTest.mutate()}
              disabled={sampleTest.isPending}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm hover:opacity-70 transition-opacity disabled:opacity-50"
              style={{
                background: 'transparent',
                color: 'var(--ed-ink-soft)',
                border: '1px solid var(--ed-rule-strong)',
                borderRadius: 'var(--ed-radius-chip)',
              }}
              data-testid="saft-sample-button"
            >
              {sampleTest.isPending ? (
                <Loader2 size={14} className="animate-spin" aria-hidden="true" />
              ) : (
                <FileText size={14} aria-hidden="true" />
              )}
              {sampleTest.isPending ? 'A gerar…' : 'Sample 24h'}
            </button>
            <p className="text-[11px] ml-auto" style={{ color: 'var(--ed-ink-faint)' }}>
              Só documentos APROVADO entram no ficheiro.
            </p>
          </div>
        </form>

        {/* LGPD / RBAC info card */}
        <aside className="card p-6 space-y-3" style={{ borderColor: 'var(--ed-rule)' }}>
          <h2
            className="uppercase tracking-wider font-medium text-sm flex items-center gap-2"
            style={{
              fontFamily: 'var(--font-editorial), ui-serif, Georgia, serif',
              letterSpacing: '0.08em',
              color: 'var(--ed-ink-faint)',
            }}
          >
            <ShieldCheck size={14} aria-hidden="true" />
            Acesso e conformidade
          </h2>
          <ul className="space-y-2 text-xs" style={{ color: 'var(--ed-ink-soft)' }}>
            <li>Apenas ADMIN ou ACCOUNTANT podem exportar.</li>
            <li>O hash chain é registado no log de auditoria com cabeça e cauda — um auditor pode re-validar a cadeia re-correndo o exporto no mesmo período.</li>
            <li>
              Os dados do exporto são confidenciais (contêm NIF, valores e endereços de clientes). Não envie o ficheiro por email sem encriptação.
            </li>
          </ul>
        </aside>
      </div>

      {/* History */}
      <section className="px-2 pb-12" style={{ paddingLeft: 16, paddingRight: 16 }}>
        <h2
          className="uppercase tracking-wider font-medium text-sm mb-3"
          style={{
            fontFamily: 'var(--font-editorial), ui-serif, Georgia, serif',
            letterSpacing: '0.08em',
            color: 'var(--ed-ink-faint)',
          }}
        >
          Histórico de exports
        </h2>
        {historyQuery.isLoading ? (
          <p className="text-sm" style={{ color: 'var(--ed-ink-soft)' }}>
            <Loader2 size={14} className="inline animate-spin mr-2" aria-hidden="true" />
            A carregar histórico…
          </p>
        ) : historyQuery.isError ? (
          <p className="text-sm" style={{ color: 'var(--ed-status-alert)' }}>
            Não foi possível carregar o histórico.
          </p>
        ) : (historyQuery.data ?? []).length === 0 ? (
          <p className="text-sm" style={{ color: 'var(--ed-ink-faint)' }}>
            Sem exports anteriores.
          </p>
        ) : (
          <table
            className="w-full text-sm"
            style={{ borderColor: 'var(--ed-rule)' }}
            data-testid="saft-history-table"
          >
            <thead>
              <tr
                className="text-[11px] uppercase tracking-wider"
                style={{
                  color: 'var(--ed-ink-faint)',
                  fontFamily: 'var(--font-editorial), ui-serif, Georgia, serif',
                  letterSpacing: '0.08em',
                  borderBottom: '1px solid var(--ed-rule)',
                }}
              >
                <th className="text-left py-2 px-3 font-medium">Quando</th>
                <th className="text-left py-2 px-3 font-medium">Período</th>
                <th className="text-left py-2 px-3 font-medium">Documentos</th>
                <th className="text-left py-2 px-3 font-medium">Hash head</th>
                <th className="text-left py-2 px-3 font-medium">Hash tail</th>
              </tr>
            </thead>
            <tbody>
              {(historyQuery.data ?? []).map((entry) => (
                <tr
                  key={entry.id}
                  style={{ borderBottom: '1px solid var(--ed-rule)' }}
                  data-testid={`saft-history-row-${entry.id}`}
                >
                  <td className="py-2 px-3 font-mono" style={{ color: 'var(--ed-ink)' }}>
                    {new Date(entry.createdAt).toLocaleString('pt-PT')}
                  </td>
                  <td className="py-2 px-3 font-mono" style={{ color: 'var(--ed-ink-soft)' }}>
                    {entry.metadata?.period?.from ?? '?'} → {entry.metadata?.period?.to ?? '?'}
                  </td>
                  <td className="py-2 px-3 font-mono" style={{ color: 'var(--ed-ink)' }}>
                    {entry.metadata?.documentCount ?? 0}
                  </td>
                  <td className="py-2 px-3 font-mono text-[11px]" style={{ color: 'var(--ed-ink-faint)' }}>
                    {(entry.metadata?.hashChainHead ?? '').slice(0, 12)}…
                  </td>
                  <td className="py-2 px-3 font-mono text-[11px]" style={{ color: 'var(--ed-ink-faint)' }}>
                    {(entry.metadata?.hashChainTail ?? '').slice(0, 12)}…
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
