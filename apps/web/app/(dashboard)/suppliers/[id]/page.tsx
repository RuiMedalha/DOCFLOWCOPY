'use client';

/**
 * /suppliers/[id] — supplier file.
 *
 * Sprint 1.C: a "Validar NIF" button calls the Portal das Finanças
 * base (via /api/v1/nif/:nif/validate) and renders the verdict +
 * the upstream-derived name + address when the base returned a
 * hit. The endpoint is rate-limited (10/min/tenant) so the button
 * is disabled while a lookup is in flight.
 *
 * The route accepts the Party id (from the party-detail page or
 * from the new "Abrir ficha fornecedor" link on the document
 * detail). When the lookup button is hit, the panel also reads
 * the latest supplier block on the most-recent APPROVED document
 * for this party so the operator sees what DocFlow already
 * captured.
 *
 * Editorial skin tokens.
 */

import { useCallback, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Building2,
  Check,
  X as XIcon,
  ShieldCheck,
  AlertCircle,
  Loader2,
  Mail,
  Phone,
  MapPin,
  Globe,
  Hash,
  Sparkles,
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

interface SupplierParty {
  id: string;
  name: string;
  nif: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  city: string | null;
  country: string | null;
  iban: string | null;
}

interface SupplierDocumentRow {
  id: string;
  fileName: string;
  docNumber: string | null;
  supplierNif: string | null;
  total: number | null;
  docDate: string | null;
  status: string;
}

interface SupplierFile {
  party: SupplierParty;
  documents: SupplierDocumentRow[];
}

interface NifLookup {
  nif: string;
  mod11Valid: boolean;
  baseVerified: boolean;
  reason?: string;
  name?: string;
  address?: string;
  source: 'cache' | 'upstream' | 'mod11_only';
  fetchedAt: string;
}

async function fetchSupplier(partyId: string): Promise<SupplierFile> {
  // Two cheap endpoints in series. Each one is tenant-scoped +
  // already paginated — joining the responses client-side keeps
  // the controller surface unchanged.
  const [party, docsResp] = await Promise.all([
    apiFetch<SupplierParty>(`/parties/${partyId}`),
    apiFetch<{ items?: SupplierDocumentRow[] } | SupplierDocumentRow[]>(
      `/parties/${partyId}/documents?limit=10`,
    ),
  ]);
  const docs = Array.isArray(docsResp)
    ? docsResp
    : docsResp.items ?? [];
  return { party, documents: docs };
}

async function fetchNifLookup(nif: string): Promise<NifLookup> {
  return apiFetch<NifLookup>(`/nif/${encodeURIComponent(nif)}/validate`);
}

export default function SupplierDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const partyId = params?.id ?? '';

  const fileQuery = useQuery({
    queryKey: ['supplier-file', partyId],
    queryFn: () => fetchSupplier(partyId),
    enabled: !!partyId,
  });

  const nif = fileQuery.data?.party.nif ?? '';

  const queryClient = useQueryClient();

  const lookup = useMutation({
    mutationFn: () => fetchNifLookup(nif),
    onSuccess: (data) => {
      toastBus.success(
        data.baseVerified
          ? `NIF ${nif} confirmado pela base pública.`
          : `NIF ${nif}: ${data.mod11Valid ? 'mod-11 OK' : 'mod-11 falhou'} — base pública ${data.reason ?? 'indisponível'}.`,
      );
    },
    onError: (err: any) => {
      const msg = typeof err?.message === 'string' ? err.message : 'Falha ao validar NIF.';
      toastBus.error(msg);
    },
  });

  const enrich = useMutation({
    mutationFn: () =>
      apiFetch<{ source: string; fieldsPopulated: string[]; error?: string | null }>(
        `/parties/${partyId}/enrich`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ skipCache: true }),
        },
      ),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['supplier-file', partyId] });
      queryClient.invalidateQueries({ queryKey: ['party', partyId] });
      const count = data.fieldsPopulated?.length ?? 0;
      toastBus.success(
        count > 0
          ? `Ficha 100% atualizada! ${count} campo(s) enriquecido(s) (${data.fieldsPopulated.join(', ')}).`
          : `Consulta oficial realizada (${data.source}). Ficha já se encontra totalmente preenchida.`,
      );
    },
    onError: (err: any) => {
      const msg = typeof err?.message === 'string' ? err.message : 'Falha ao enriquecer dados do fornecedor.';
      toastBus.error(msg);
    },
  });

  const onBack = useCallback(() => {
    router.back();
  }, [router]);

  const docs = useMemo(
    () => fileQuery.data?.documents ?? [],
    [fileQuery.data],
  );
  const recent = docs[0] ?? null;

  if (fileQuery.isLoading) {
    return (
      <div data-skin="editorial" className="flex items-center justify-center py-24">
        <Loader2 size={22} className="animate-spin" aria-hidden="true" style={{ color: 'var(--ed-accent-gold)' }} />
        <span className="ml-2 text-sm" style={{ color: 'var(--ed-ink-soft)' }}>
          A carregar ficha do fornecedor…
        </span>
      </div>
    );
  }

  if (fileQuery.isError || !fileQuery.data) {
    return (
      <div data-skin="editorial" className="p-8">
        <button onClick={onBack} className="btn-secondary text-sm mb-4">
          <ArrowLeft size={14} aria-hidden="true" /> Voltar
        </button>
        <div className="card p-8 text-center">
          <AlertCircle
            size={32}
            className="mx-auto mb-2"
            aria-hidden="true"
            style={{ color: 'var(--ed-status-alert)' }}
          />
          <p className="text-sm" style={{ color: 'var(--ed-ink-soft)' }}>
            Não foi possível carregar este fornecedor.
          </p>
        </div>
      </div>
    );
  }

  const party = fileQuery.data.party;
  const result = lookup.data ?? null;

  return (
    <div data-skin="editorial" className="min-h-screen">
      {/* Header */}
      <header className="border-b" style={{ borderColor: 'var(--ed-rule)' }}>
        <nav
          className="flex items-center gap-2 px-2 py-3 text-[12px] font-semibold uppercase tracking-wider"
          style={{ color: 'var(--ed-ink-faint)' }}
        >
          <button onClick={onBack} className="inline-flex items-center gap-1 hover:opacity-70">
            <ArrowLeft size={12} aria-hidden="true" /> Voltar
          </button>
          <span aria-hidden="true">/</span>
          <span className="font-mono normal-case tracking-normal" style={{ color: 'var(--ed-ink-soft)' }}>
            Ficha de fornecedor
          </span>
        </nav>

        <div className="px-2 pt-6 pb-5 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1
              className="font-mono font-bold leading-[1] tracking-tight"
              style={{ fontSize: 'clamp(28px, 3.5vw, 38px)', color: 'var(--ed-ink)', letterSpacing: '-0.02em' }}
            >
              {party.name}
            </h1>
            <p className="mt-3 text-sm" style={{ color: 'var(--ed-ink-soft)' }}>
              <span className="font-mono">NIF {party.nif ?? '—'}</span>
              {' · '}
              <span>{party.country ?? 'PT'}</span>
              {' · '}
              <span>{docs.length} documentos</span>
            </p>
          </div>
          <button
            type="button"
            onClick={() => enrich.mutate()}
            disabled={enrich.isPending}
            aria-busy={enrich.isPending}
            className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold rounded-lg shadow-sm transition-all hover:opacity-90 disabled:opacity-50"
            style={{
              background: 'var(--ed-accent-gold, #cba65a)',
              color: 'var(--ed-ink, #1f2937)',
            }}
            data-testid="supplier-enrich-ai-button"
            title="Consulta as melhores faturas extraídas deste fornecedor e os serviços oficiais VIES/NIF PT para deixar a ficha 100% preenchida"
          >
            {enrich.isPending ? (
              <Loader2 size={16} className="animate-spin" aria-hidden="true" />
            ) : (
              <Sparkles size={16} aria-hidden="true" />
            )}
            {enrich.isPending ? 'A enriquecer ficha…' : 'Enriquecer dados com IA / Faturas'}
          </button>
        </div>
      </header>

      <div className="px-2 py-8 grid grid-cols-1 xl:grid-cols-3 gap-6" style={{ padding: '32px 16px 64px' }}>
        {/* Identity card */}
        <section className="card p-6 space-y-4 xl:col-span-2" style={{ borderColor: 'var(--ed-rule)' }}>
          <h2
            className="uppercase tracking-wider font-medium text-sm"
            style={{
              fontFamily: 'var(--font-editorial), ui-serif, Georgia, serif',
              letterSpacing: '0.08em',
              color: 'var(--ed-ink-faint)',
            }}
          >
            Identidade
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
            <KV label="Nome">{party.name}</KV>
            <KV label="NIF"><span className="font-mono">{party.nif ?? '—'}</span></KV>
            <KV label="Email">{party.email ?? '—'}</KV>
            <KV label="Telefone">{party.phone ?? '—'}</KV>
            <KV label="Morada">{party.address ?? '—'}</KV>
            <KV label="Cidade">{party.city ?? '—'}</KV>
            <KV label="País">{party.country ?? '—'}</KV>
            <KV label="IBAN"><span className="font-mono text-[12px] break-all">{party.iban ?? '—'}</span></KV>
          </div>
        </section>

        {/* NIF validation & AI Enrichment card */}
        <aside className="card p-6 space-y-5" style={{ borderColor: 'var(--ed-rule)' }}>
          <div className="space-y-3">
            <h2
              className="uppercase tracking-wider font-medium text-sm flex items-center gap-2"
              style={{
                fontFamily: 'var(--font-editorial), ui-serif, Georgia, serif',
                letterSpacing: '0.08em',
                color: 'var(--ed-ink-faint)',
              }}
            >
              <Sparkles size={14} className="text-amber-500" aria-hidden="true" />
              Enriquecimento Automático
            </h2>
            <p className="text-xs" style={{ color: 'var(--ed-ink-soft)' }}>
              Consulta VIES / NIF PT oficial e extrai dados das faturas arquivadas para preencher morada, contactos e IBAN.
            </p>
            <button
              type="button"
              onClick={() => enrich.mutate()}
              disabled={enrich.isPending}
              aria-busy={enrich.isPending}
              className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 text-sm font-medium rounded shadow-sm hover:opacity-85 transition-opacity disabled:opacity-50"
              style={{
                background: 'var(--ed-accent-gold, #cba65a)',
                color: 'var(--ed-ink, #1f2937)',
              }}
            >
              {enrich.isPending ? (
                <Loader2 size={14} className="animate-spin" aria-hidden="true" />
              ) : (
                <Sparkles size={14} aria-hidden="true" />
              )}
              {enrich.isPending ? 'A enriquecer…' : 'Enriquecer dados com IA / Faturas'}
            </button>
          </div>

          <hr style={{ borderColor: 'var(--ed-rule)' }} />

          <div className="space-y-3">
            <h2
              className="uppercase tracking-wider font-medium text-sm flex items-center gap-2"
              style={{
                fontFamily: 'var(--font-editorial), ui-serif, Georgia, serif',
                letterSpacing: '0.08em',
                color: 'var(--ed-ink-faint)',
              }}
            >
              <ShieldCheck size={14} aria-hidden="true" />
              Validação NIF
            </h2>
          <button
            type="button"
            onClick={() => lookup.mutate()}
            disabled={lookup.isPending || !nif}
            aria-busy={lookup.isPending}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-sm hover:opacity-70 transition-opacity disabled:opacity-50"
            style={{
              background: 'var(--ed-accent-gold)',
              color: 'var(--ed-ink)',
              borderRadius: 'var(--ed-radius-chip)',
            }}
            data-testid="supplier-validate-nif-button"
          >
            {lookup.isPending ? (
              <Loader2 size={14} className="animate-spin" aria-hidden="true" />
            ) : (
              <ShieldCheck size={14} aria-hidden="true" />
            )}
            {lookup.isPending ? 'A consultar base…' : 'Validar NIF'}
          </button>
          {result && (
            <div
              className="mt-3 p-3 rounded text-xs"
              style={{
                background:
                  result.baseVerified
                    ? 'rgba(79, 121, 66, 0.10)'
                    : result.mod11Valid
                    ? 'rgba(203, 166, 90, 0.18)'
                    : 'rgba(139, 46, 42, 0.10)',
                color: result.baseVerified
                  ? 'var(--ed-status-ok)'
                  : result.mod11Valid
                  ? 'var(--ed-accent-gold)'
                  : 'var(--ed-status-alert)',
              }}
              data-testid="supplier-nif-verdict"
            >
              <div className="flex items-center gap-1.5 font-medium">
                {result.baseVerified ? (
                  <Check size={14} aria-hidden="true" />
                ) : (
                  <XIcon size={14} aria-hidden="true" />
                )}
                {result.baseVerified
                  ? `Base pública confirma (${result.source})`
                  : result.mod11Valid
                  ? 'Mod-11 OK — base pública indisponível'
                  : 'Mod-11 falhou'}
              </div>
              <p className="mt-1" style={{ color: 'var(--ed-ink-soft)' }}>
                Fonte: <span className="font-mono">{result.source}</span>
                {' · '}
                {new Date(result.fetchedAt).toLocaleString('pt-PT')}
              </p>
              {result.name && (
                <p className="mt-2" style={{ color: 'var(--ed-ink)' }}>
                  <strong>Nome:</strong> {result.name}
                </p>
              )}
              {result.address && (
                <p style={{ color: 'var(--ed-ink)' }}>
                  <strong>Morada:</strong> {result.address}
                </p>
              )}
              {result.reason && (
                <p style={{ color: 'var(--ed-ink-faint)' }}>
                  Motivo: {result.reason}
                </p>
              )}
            </div>
          )}
          <p className="text-[10px]" style={{ color: 'var(--ed-ink-faint)' }}>
            Limite: 10 consultas/min. LGPD: dados públicos do Portal das Finanças; DocFlow não persiste o payload além do cache TTL de 7 dias.
          </p>
          </div>
        </aside>
      </div>

      {/* Documents */}
      <section className="px-2 pb-12" style={{ paddingLeft: 16, paddingRight: 16 }}>
        <h2
          className="uppercase tracking-wider font-medium text-sm mb-3"
          style={{
            fontFamily: 'var(--font-editorial), ui-serif, Georgia, serif',
            letterSpacing: '0.08em',
            color: 'var(--ed-ink-faint)',
          }}
        >
          Documentos recentes
        </h2>
        {docs.length === 0 ? (
          <p className="text-sm" style={{ color: 'var(--ed-ink-faint)' }}>
            Sem documentos associados.
          </p>
        ) : (
          <table className="w-full text-sm" style={{ borderColor: 'var(--ed-rule)' }}>
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
                <th className="text-left py-2 px-3 font-medium">Doc</th>
                <th className="text-left py-2 px-3 font-medium">Data</th>
                <th className="text-left py-2 px-3 font-medium">Valor</th>
                <th className="text-left py-2 px-3 font-medium">Estado</th>
              </tr>
            </thead>
            <tbody>
              {docs.map((d) => (
                <tr
                  key={d.id}
                  className="align-middle"
                  style={{ borderBottom: '1px solid var(--ed-rule)' }}
                >
                  <td className="py-2 px-3 font-mono" style={{ color: 'var(--ed-ink)' }}>
                    <a
                      href={`/documents/${d.id}`}
                      className="hover:opacity-70 transition-opacity"
                      data-testid={`supplier-doc-link-${d.id}`}
                    >
                      {d.docNumber ?? d.fileName}
                    </a>
                  </td>
                  <td className="py-2 px-3 font-mono" style={{ color: 'var(--ed-ink-soft)' }}>
                    {d.docDate ? d.docDate.slice(0, 10) : '—'}
                  </td>
                  <td className="py-2 px-3 font-mono" style={{ color: 'var(--ed-ink)' }}>
                    {d.total != null
                      ? new Intl.NumberFormat('pt-PT', { style: 'currency', currency: 'EUR' }).format(d.total)
                      : '—'}
                  </td>
                  <td className="py-2 px-3" style={{ color: 'var(--ed-ink-soft)' }}>
                    {d.status}
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

function KV({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <span
        className="text-[11px] uppercase tracking-wider font-medium"
        style={{ color: 'var(--ed-ink-faint)' }}
      >
        {label}
      </span>
      <div className="mt-0.5" style={{ color: 'var(--ed-ink)' }}>
        {children}
      </div>
    </div>
  );
}
