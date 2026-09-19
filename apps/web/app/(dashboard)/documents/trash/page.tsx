'use client';

/**
 * DocFlow — `/documents/trash` page (Sprint I+ soft-delete recovery).
 *
 * Lists soft-deleted documents (rows with `deletedAt != null`) for the
 * current tenant. Each row exposes a "Restaurar" button — calls
 * `POST /api/v1/documents/:id/restore` which is ADMIN-only on the backend.
 * Non-ADMIN viewers can SEE the list but the action button stays disabled
 * with a friendly tooltip explaining the RBAC constraint.
 *
 * The list uses the same `{ items, meta }` envelope as the inbox so the
 * backend pagination handler is identical — `DocumentsService.findInTrash`.
 */

import { useState } from 'react';
import { Loader2, RotateCcw, AlertCircle, RefreshCw, Lock } from 'lucide-react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { PageHeader } from '../../_components/page-header';
import { toastBus } from '../../../_components/ui';
import { authedFetch } from '../../../_lib/auth-refresh';
import { useUser } from '@/_lib/use-dashboard-queries';

const API_BASE =
  (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, '')) ||
  'http://localhost:4000/api/v1';

interface TrashItem {
  id: string;
  fileName: string;
  supplier?: string | null;
  supplierNif?: string | null;
  status: string;
  deletedAt?: string | null;
  createdAt: string;
  mimeType?: string;
  origin?: string;
  total?: number | null;
}

interface TrashResponse {
  items: TrashItem[];
  meta: { total: number; page: number; limit: number; totalPages: number };
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await authedFetch(`${API_BASE}${path}`, init);
  if (!res.ok) {
    let body: any = {};
    try {
      body = await res.json();
    } catch {
      /* ignore */
    }
    throw new Error(body?.message ?? `HTTP ${res.status}`);
  }
  const json = await res.json();
  return (json?.data ?? json) as T;
}

export default function TrashPage() {
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 20;
  const qc = useQueryClient();
  // Restore is ADMIN-only on the backend (POST /:id/restore). Mirror the
  // gate in the UI so non-ADMIN viewers see the list but the action button
  // is disabled with an explanatory tooltip — the server still enforces the
  // RBAC as a second line of defence.
  const user = useUser();
  const canRestore = user?.role === 'ADMIN';

  const { data, isLoading, isError, refetch, isFetching } = useQuery<TrashResponse>({
    queryKey: ['documents', 'trash', page, PAGE_SIZE],
    queryFn: () =>
      fetchJson<TrashResponse>(
        `/documents/trash?page=${page}&limit=${PAGE_SIZE}`,
      ),
    placeholderData: (prev) => prev as TrashResponse | undefined,
    staleTime: 30_000,
  });

  const restore = useMutation({
    mutationFn: async (id: string) =>
      fetchJson<{ id: string; restored: boolean }>(`/documents/${id}/restore`, {
        method: 'POST',
      }),
    onSuccess: (result, id) => {
      void qc.invalidateQueries({ queryKey: ['documents', 'trash'] });
      void qc.invalidateQueries({ queryKey: ['documents'] });
      toastBus.success(
        result.restored
          ? 'Documento restaurado.'
          : 'Documento já estava ativo.',
      );
    },
    onError: (err: any) => {
      const message =
        typeof err?.message === 'string' && err.message.length > 0
          ? err.message
          : 'Falha ao restaurar.';
      toastBus.error(message);
    },
  });

  const items = data?.items ?? [];
  const total = data?.meta?.total ?? 0;
  const totalPages = data?.meta?.totalPages ?? 1;

  const fmtDate = (iso?: string | null) => {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleString('pt-PT', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const fmtEur = (n?: number | null) =>
    typeof n === 'number' && Number.isFinite(n)
      ? new Intl.NumberFormat('pt-PT', { style: 'currency', currency: 'EUR' }).format(n)
      : '—';

  return (
    <>
      <PageHeader
        title="Lixeira"
        subtitle={
          canRestore
            ? 'Documentos soft-deleted. Apenas ADMIN pode restaurar.'
            : 'Documentos soft-deleted. Apenas ADMIN pode restaurar — visualize somente.'
        }
        actions={
          <button
            type="button"
            className="btn-secondary text-sm"
            onClick={() => refetch()}
            disabled={isFetching}
            aria-label="Atualizar lista"
          >
            <RefreshCw size={14} className={isFetching ? 'animate-spin' : ''} />
            Atualizar
          </button>
        }
      />

      <div className="space-y-4">
        {isError ? (
          <div
            className="card p-6 flex items-start gap-3"
            role="alert"
            style={{
              background: 'rgba(248,113,113,0.08)',
              borderColor: 'rgba(248,113,113,0.30)',
            }}
          >
            <AlertCircle size={18} style={{ color: 'var(--danger)' }} className="flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="text-sm font-medium" style={{ color: 'var(--danger-fg)' }}>
                Não foi possível carregar a lixeira.
              </p>
              <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                Verifique a sua ligação ou tente novamente.
              </p>
            </div>
            <button type="button" className="btn-secondary text-xs px-3 py-1.5" onClick={() => refetch()}>
              Tentar novamente
            </button>
          </div>
        ) : isLoading ? (
          <div className="card p-8 text-center">
            <Loader2 size={22} className="inline animate-spin mr-2" />
            <span className="text-sm">A carregar…</span>
          </div>
        ) : items.length === 0 ? (
          <div className="card p-8 text-center">
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
              Sua lixeira está vazia.
            </p>
          </div>
        ) : (
          <>
            <ul className="card divide-y" style={{ borderColor: 'var(--border)' }}>
              {items.map((it) => (
                <li
                  key={it.id}
                  className="flex items-center justify-between gap-3 px-4 py-3"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="font-medium truncate" style={{ color: 'var(--text)' }}>
                        {it.fileName}
                      </span>
                      <span className="badge badge-violet text-xs">Removido</span>
                    </div>
                    <div className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                      {(it.supplier || 'Sem fornecedor') +
                        (it.supplierNif ? ` · NIF ${it.supplierNif}` : '')}
                    </div>
                    <div className="text-xs" style={{ color: 'var(--text-subtle)' }}>
                      Apagado em {fmtDate(it.deletedAt)} ·{' '}
                      Criado em {fmtDate(it.createdAt)} · Total: {fmtEur(it.total)}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => restore.mutate(it.id)}
                    disabled={restore.isPending || !canRestore}
                    aria-busy={restore.isPending}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium border disabled:opacity-50"
                    style={{
                      background: 'transparent',
                      color: canRestore ? 'var(--accent)' : 'var(--text-muted)',
                      borderColor: canRestore ? 'var(--accent)' : 'var(--border)',
                      borderRadius: 'var(--radius-chip, 999px)',
                      cursor: canRestore ? 'pointer' : 'not-allowed',
                    }}
                    title={
                      canRestore
                        ? 'Restaurar documento (ADMIN)'
                        : 'Apenas ADMIN pode restaurar documentos da lixeira.'
                    }
                  >
                    {canRestore ? (
                      <RotateCcw size={14} className={restore.isPending ? 'animate-spin' : ''} />
                    ) : (
                      <Lock size={14} aria-hidden="true" />
                    )}
                    {canRestore ? 'Restaurar' : 'Restrito'}
                  </button>
                </li>
              ))}
            </ul>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="flex items-center justify-between gap-2 px-1">
                <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  {total} documento{total === 1 ? '' : 's'} na lixeira
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="btn-secondary text-sm px-3 py-1.5"
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={page <= 1}
                    aria-label="Página anterior"
                  >
                    Anterior
                  </button>
                  <span className="text-xs px-2" style={{ color: 'var(--text-muted)' }}>
                    Página {page} de {totalPages}
                  </span>
                  <button
                    type="button"
                    className="btn-secondary text-sm px-3 py-1.5"
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                    disabled={page >= totalPages}
                    aria-label="Próxima página"
                  >
                    Seguinte
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}
