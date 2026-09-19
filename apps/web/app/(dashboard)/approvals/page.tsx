'use client';

/**
 * /approvals — Sprint 1.B queqe de aprovações pendentes.
 *
 * Lista os pedidos em status PENDING para o tenant atual, com
 * colunas documento (link), solicitante, idade e ações. Um filtro
 * por status deixa o operador ver também os pedidos decididos
 * (APPROVED / REJECTED / CHANGES_REQUESTED / WITHDRAWN) para
 * auditoria operacional.
 *
 * Botões Approve / Reject / Request Changes disparam mutações
 * PATCH no endpoint correspondente. Reject + Request Changes
 * exigem comentário — abre-se um modal com textarea obrigatório.
 *
 * Editorial skin tokens — sem novos tokens globais.
 */

import { useCallback, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Check as CheckIcon,
  X as XIcon,
  RefreshCw,
  ShieldCheck,
  Loader2,
  AlertCircle,
  MessageSquare,
  Inbox,
  Eye,
  FileText,
  AlertTriangle,
} from 'lucide-react';
import { authedFetch } from '../../_lib/auth-refresh';
import { toastBus, Dialog } from '../../_components/ui';
import { useUser } from '@/_lib/use-dashboard-queries';

const API_BASE =
  (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, '')) ||
  'http://localhost:4000/api/v1';

type ApprovalStatus =
  | 'PENDING'
  | 'APPROVED'
  | 'REJECTED'
  | 'CHANGES_REQUESTED'
  | 'WITHDRAWN';

interface ApprovalListItem {
  id: string;
  tenantId: string;
  documentId: string;
  documentLabel: string;
  status: ApprovalStatus;
  requestedById: string;
  requestedByName?: string;
  decidedById?: string | null;
  decidedByName?: string | null;
  decidedAt?: string | null;
  comment?: string | null;
  createdAt: string;
  updatedAt: string;
  supplierName?: string | null;
  totalAmount?: number | null;
}

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

async function fetchApprovals(status?: string): Promise<ApprovalListItem[]> {
  const qs = status && status !== 'ALL' ? `?status=${status}` : '';
  return apiFetch(`/approvals${qs}`);
}

async function decideApproval(
  approvalId: string,
  action: 'approve' | 'reject' | 'request-changes',
  comment?: string,
): Promise<{ approvalId: string; documentId: string; decidedAt: string }> {
  return apiFetch(`/approvals/${approvalId}/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ comment }),
  });
}

const STATUS_OPTIONS: { value: 'ALL' | ApprovalStatus; label: string }[] = [
  { value: 'ALL', label: 'Todos' },
  { value: 'PENDING', label: 'Pendentes' },
  { value: 'APPROVED', label: 'Aprovados' },
  { value: 'REJECTED', label: 'Rejeitados' },
  { value: 'CHANGES_REQUESTED', label: 'Mudanças solicitadas' },
  { value: 'WITHDRAWN', label: 'Retirados' },
];

function fmtAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h`;
  const days = Math.floor(hours / 24);
  return `${days} d`;
}

function fmtCurrency(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return new Intl.NumberFormat('pt-PT', { style: 'currency', currency: 'EUR' }).format(value);
}

export default function ApprovalsPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const user = useUser();

  const canDecide =
    user?.role === 'ADMIN' || user?.role === 'APPROVER';

  const [mainSection, setMainSection] = useState<'docs' | 'requests'>('docs');
  const [docFilter, setDocFilter] = useState<'ALL' | 'EM_REVISAO' | 'PROCESSADO'>('ALL');

  const docsReviewQuery = useQuery({
    queryKey: ['approvals', 'docs-review', docFilter],
    queryFn: async () => {
      if (docFilter === 'ALL') {
        const [revRes, procRes] = await Promise.all([
          apiFetch<{ items: any[] }>(`/documents?status=EM_REVISAO&limit=50`).catch(() => ({ items: [] })),
          apiFetch<{ items: any[] }>(`/documents?status=PROCESSADO&limit=50`).catch(() => ({ items: [] })),
        ]);
        const items = [...(revRes?.items || []), ...(procRes?.items || [])];
        return items;
      }
      const res = await apiFetch<{ items: any[] }>(`/documents?status=${docFilter}&limit=50`).catch(() => ({ items: [] }));
      return res?.items || [];
    },
    refetchInterval: 30000,
  });

  const quickApproveDoc = useMutation({
    mutationFn: async (docId: string) => {
      return apiFetch(`/documents/${docId}/approve`, { method: 'POST' });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['approvals'] });
      qc.invalidateQueries({ queryKey: ['documents'] });
      toastBus.success('Fatura aprovada e arquivada com sucesso.');
    },
    onError: (err: any) => {
      toastBus.error(err?.message || 'Falha ao aprovar fatura.');
    },
  });

  const [statusFilter, setStatusFilter] = useState<'ALL' | ApprovalStatus>('PENDING');

  const listQuery = useQuery({
    queryKey: ['approvals', statusFilter],
    queryFn: () => fetchApprovals(statusFilter),
    refetchInterval: 30000, // poll every 30s — keeps the badge aligned with the rest of the inbox
  });

  const [commentFor, setCommentFor] = useState<{
    approval: ApprovalListItem;
    action: 'reject' | 'request-changes';
  } | null>(null);
  const [commentDraft, setCommentDraft] = useState('');

  const decide = useMutation({
    mutationFn: ({
      approvalId,
      action,
      comment,
    }: {
      approvalId: string;
      action: 'approve' | 'reject' | 'request-changes';
      comment?: string;
    }) => decideApproval(approvalId, action, comment),
    onSuccess: (_result, vars) => {
      qc.invalidateQueries({ queryKey: ['approvals'] });
      qc.invalidateQueries({ queryKey: ['document-detail', vars.approvalId] });
      // Some decision endpoints invalidate the document-detail by
      // documentId rather than approvalId — best-effort invalidation
      // for the obvious keys.
      const target = listQuery.data?.find((a) => a.id === vars.approvalId);
      if (target) {
        qc.invalidateQueries({ queryKey: ['document-detail', target.documentId] });
      }
      toastBus.success('Decisão registada.');
      setCommentFor(null);
      setCommentDraft('');
    },
    onError: (err: any) => {
      const msg = typeof err?.message === 'string' ? err.message : 'Falha ao registar a decisão.';
      toastBus.error(msg);
    },
  });

  const onApprove = useCallback(
    (a: ApprovalListItem) => {
      decide.mutate({ approvalId: a.id, action: 'approve' });
    },
    [decide],
  );

  const onAskComment = useCallback(
    (a: ApprovalListItem, action: 'reject' | 'request-changes') => {
      setCommentFor({ approval: a, action });
      setCommentDraft('');
    },
    [],
  );

  const onSubmitComment = useCallback(() => {
    if (!commentFor) return;
    const trimmed = commentDraft.trim();
    if (trimmed.length === 0) {
      toastBus.error('O comentário é obrigatório.');
      return;
    }
    decide.mutate({
      approvalId: commentFor.approval.id,
      action: commentFor.action,
      comment: trimmed,
    });
  }, [commentFor, commentDraft, decide]);

  const rows = listQuery.data ?? [];
  const pendingCount = useMemo(
    () => rows.filter((r) => r.status === 'PENDING').length,
    [rows],
  );
  const docsList = docsReviewQuery.data ?? [];
  const pendingDocsCount = docsList.length;

  return (
    <div data-skin="editorial" className="min-h-screen">
      {/* Header */}
      <header className="border-b" style={{ borderColor: 'var(--ed-rule)' }}>
        <div className="px-2 pt-6 pb-5">
          <h1
            className="font-mono font-bold leading-[1] tracking-tight"
            style={{ fontSize: 'clamp(32px, 4vw, 44px)', color: 'var(--ed-ink)', letterSpacing: '-0.02em' }}
          >
            Aprovações & Validações
          </h1>
          <p className="mt-3 text-sm" style={{ color: 'var(--ed-ink-soft)' }}>
            Fila de faturas a aguardar validação e histórico de pedidos de aprovação.
          </p>
        </div>

        {/* Top Section Tabs */}
        <div className="flex items-center gap-6 px-4 border-t" style={{ borderColor: 'var(--ed-rule)' }}>
          <button
            type="button"
            onClick={() => setMainSection('docs')}
            className="py-3 text-sm font-medium transition-colors inline-flex items-center gap-2 border-b-2"
            style={{
              borderColor: mainSection === 'docs' ? 'var(--ed-accent-gold)' : 'transparent',
              color: mainSection === 'docs' ? 'var(--ed-ink)' : 'var(--ed-ink-soft)',
              fontWeight: mainSection === 'docs' ? 600 : 400,
            }}
          >
            <FileText size={16} />
            Faturas a Aguardar Validação
            {pendingDocsCount > 0 && (
              <span
                className="px-2 py-0.5 text-xs font-mono rounded-full font-bold"
                style={{
                  background: 'rgba(203, 166, 90, 0.20)',
                  color: 'var(--ed-ink)',
                }}
              >
                {pendingDocsCount}
              </span>
            )}
          </button>
          <button
            type="button"
            onClick={() => setMainSection('requests')}
            className="py-3 text-sm font-medium transition-colors inline-flex items-center gap-2 border-b-2"
            style={{
              borderColor: mainSection === 'requests' ? 'var(--ed-accent-gold)' : 'transparent',
              color: mainSection === 'requests' ? 'var(--ed-ink)' : 'var(--ed-ink-soft)',
              fontWeight: mainSection === 'requests' ? 600 : 400,
            }}
          >
            <ShieldCheck size={16} />
            Pedidos Formais de Aprovação
            {pendingCount > 0 && (
              <span
                className="px-2 py-0.5 text-xs font-mono rounded-full font-bold"
                style={{
                  background: 'rgba(203, 166, 90, 0.20)',
                  color: 'var(--ed-ink)',
                }}
              >
                {pendingCount}
              </span>
            )}
          </button>
        </div>

        {/* Filter bar - contextual */}
        {mainSection === 'requests' ? (
          <div
            className="flex items-center gap-2 px-6 py-3 border-t flex-wrap"
            style={{ borderColor: 'var(--ed-rule)' }}
            role="tablist"
            aria-label="Filtro por estado"
          >
            {STATUS_OPTIONS.map((opt) => {
              const active = statusFilter === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setStatusFilter(opt.value)}
                  className="px-3 py-1.5 text-xs font-medium transition-opacity"
                  style={{
                    borderRadius: 'var(--ed-radius-chip)',
                    background: active ? 'var(--ed-accent-gold)' : 'transparent',
                    color: active ? 'var(--ed-ink)' : 'var(--ed-ink-soft)',
                    border: `1px solid ${active ? 'var(--ed-accent-gold)' : 'var(--ed-rule-strong)'}`,
                  }}
                  data-testid={`approvals-filter-${opt.value}`}
                >
                  {opt.label}
                  {opt.value === 'PENDING' && pendingCount > 0 && (
                    <span className="ml-1.5 font-mono">({pendingCount})</span>
                  )}
                </button>
              );
            })}
          </div>
        ) : (
          <div
            className="flex items-center gap-2 px-6 py-3 border-t flex-wrap"
            style={{ borderColor: 'var(--ed-rule)' }}
          >
            {[
              { value: 'ALL', label: 'Todas a Aguardar' },
              { value: 'EM_REVISAO', label: 'Em Revisão' },
              { value: 'PROCESSADO', label: 'Processadas' },
            ].map((opt) => {
              const active = docFilter === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setDocFilter(opt.value as any)}
                  className="px-3 py-1.5 text-xs font-medium transition-opacity"
                  style={{
                    borderRadius: 'var(--ed-radius-chip)',
                    background: active ? 'var(--ed-accent-gold)' : 'transparent',
                    color: active ? 'var(--ed-ink)' : 'var(--ed-ink-soft)',
                    border: `1px solid ${active ? 'var(--ed-accent-gold)' : 'var(--ed-rule-strong)'}`,
                  }}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        )}
      </header>

      {/* Body */}
      <div className="px-2 py-8" style={{ padding: '32px 16px 64px' }}>
        {mainSection === 'docs' ? (
          docsReviewQuery.isLoading ? (
            <div className="flex items-center justify-center py-12" style={{ color: 'var(--ed-ink-soft)' }}>
              <Loader2 size={18} className="animate-spin" aria-hidden="true" />
              <span className="ml-2 text-sm">A carregar faturas a validar…</span>
            </div>
          ) : docsReviewQuery.isError ? (
            <div className="card p-8 text-center" style={{ borderColor: 'var(--ed-rule)' }}>
              <AlertCircle size={28} className="mx-auto mb-2" style={{ color: 'var(--ed-status-alert)' }} aria-hidden="true" />
              <p className="text-sm" style={{ color: 'var(--ed-ink-soft)' }}>
                Não foi possível carregar a lista de faturas a validar.
              </p>
            </div>
          ) : docsList.length === 0 ? (
            <div className="card p-12 text-center" style={{ borderColor: 'var(--ed-rule)' }}>
              <Inbox size={32} className="mx-auto mb-3" style={{ color: 'var(--ed-ink-faint)' }} aria-hidden="true" />
              <p className="text-sm" style={{ color: 'var(--ed-ink-soft)' }}>
                Sem faturas a aguardar validação {docFilter !== 'ALL' ? 'neste filtro' : ''}.
              </p>
            </div>
          ) : (
            <table
              className="w-full text-sm"
              style={{ borderColor: 'var(--ed-rule)' }}
              data-testid="docs-validation-table"
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
                  <th className="text-left py-3 px-4 font-medium">Documento</th>
                  <th className="text-left py-3 px-4 font-medium">Fornecedor</th>
                  <th className="text-left py-3 px-4 font-medium">NIF</th>
                  <th className="text-left py-3 px-4 font-medium">Data</th>
                  <th className="text-left py-3 px-4 font-medium">Valor Total</th>
                  <th className="text-left py-3 px-4 font-medium">Estado</th>
                  <th className="text-right py-3 px-4 font-medium">Ações</th>
                </tr>
              </thead>
              <tbody>
                {docsList.map((doc: any) => {
                  const hasMissingNif = !doc.supplierNif;
                  const isNonFiscal = doc.fiscalStatus === 'NAO_FISCAL';
                  const hasAlert = hasMissingNif || isNonFiscal;

                  return (
                    <tr
                      key={doc.id}
                      className="align-middle transition-colors"
                      style={{
                        borderBottom: '1px solid var(--ed-rule)',
                        borderLeft: hasAlert ? '3px solid #F43F5E' : '3px solid transparent',
                        background: hasAlert ? 'rgba(244, 63, 94, 0.03)' : undefined,
                      }}
                      data-testid={`doc-validation-row-${doc.id}`}
                    >
                      <td className="py-3 px-4">
                        <button
                          type="button"
                          onClick={() => router.push(`/documents/${doc.id}`)}
                          className="font-mono text-sm hover:opacity-70 transition-opacity font-medium inline-flex items-center gap-1.5 text-left"
                          style={{ color: 'var(--ed-ink)' }}
                        >
                          <FileText size={14} className="text-stone-400 shrink-0" />
                          <span className="truncate max-w-[220px]">{doc.fileName}</span>
                        </button>
                      </td>
                      <td className="py-3 px-4 font-medium" style={{ color: 'var(--ed-ink)' }}>
                        {doc.supplier || '—'}
                      </td>
                      <td className="py-3 px-4">
                        {doc.supplierNif ? (
                          <span className="font-mono text-xs" style={{ color: 'var(--ed-ink)' }}>
                            {doc.supplierNif}
                          </span>
                        ) : (
                          <span className="text-xs font-semibold text-rose-600 bg-rose-50 border border-rose-200 px-2 py-0.5 rounded">
                            ⚠️ Em falta
                          </span>
                        )}
                      </td>
                      <td className="py-3 px-4 text-xs font-mono" style={{ color: 'var(--ed-ink-soft)' }}>
                        {doc.docDate ? new Date(doc.docDate).toLocaleDateString('pt-PT') : '—'}
                      </td>
                      <td className="py-3 px-4 font-mono font-medium" style={{ color: 'var(--ed-ink)' }}>
                        {fmtCurrency(doc.total)}
                      </td>
                      <td className="py-3 px-4">
                        {isNonFiscal ? (
                          <span className="badge-rose text-xs inline-flex items-center gap-1">
                            🔴 Não fiscal
                          </span>
                        ) : hasMissingNif ? (
                          <span className="badge-rose text-xs inline-flex items-center gap-1">
                            🔴 Atenção: Sem NIF
                          </span>
                        ) : doc.status === 'EM_REVISAO' ? (
                          <span className="badge-amber text-xs">
                            Em revisão
                          </span>
                        ) : (
                          <span className="badge-sky text-xs">
                            Processado
                          </span>
                        )}
                      </td>
                      <td className="py-3 px-4 text-right">
                        <div className="inline-flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => router.push(`/documents/${doc.id}`)}
                            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs hover:opacity-70 transition-opacity"
                            style={{
                              background: 'transparent',
                              color: 'var(--ed-ink)',
                              border: '1px solid var(--ed-rule-strong)',
                              borderRadius: 'var(--ed-radius-chip)',
                            }}
                          >
                            <Eye size={12} />
                            Ver Detalhes
                          </button>
                          {canDecide && (
                            <button
                              type="button"
                              onClick={() => quickApproveDoc.mutate(doc.id)}
                              disabled={quickApproveDoc.isPending}
                              aria-busy={quickApproveDoc.isPending}
                              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs hover:opacity-70 transition-opacity disabled:opacity-50"
                              style={{
                                background: 'transparent',
                                color: 'var(--ed-status-ok)',
                                border: '1px solid var(--ed-status-ok)',
                                borderRadius: 'var(--ed-radius-chip)',
                              }}
                            >
                              <CheckIcon size={12} className={quickApproveDoc.isPending ? 'animate-spin' : ''} />
                              {quickApproveDoc.isPending ? 'A aprovar…' : 'Aprovar'}
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )
        ) : listQuery.isLoading ? (
          <div className="flex items-center justify-center py-12" style={{ color: 'var(--ed-ink-soft)' }}>
            <Loader2 size={18} className="animate-spin" aria-hidden="true" />
            <span className="ml-2 text-sm">A carregar aprovações…</span>
          </div>
        ) : listQuery.isError ? (
          <div className="card p-8 text-center" style={{ borderColor: 'var(--ed-rule)' }}>
            <AlertCircle size={28} className="mx-auto mb-2" style={{ color: 'var(--ed-status-alert)' }} aria-hidden="true" />
            <p className="text-sm" style={{ color: 'var(--ed-ink-soft)' }}>
              Não foi possível carregar a lista de aprovações.
            </p>
          </div>
        ) : rows.length === 0 ? (
          <div className="card p-12 text-center" style={{ borderColor: 'var(--ed-rule)' }}>
            <Inbox size={32} className="mx-auto mb-3" style={{ color: 'var(--ed-ink-faint)' }} aria-hidden="true" />
            <p className="text-sm" style={{ color: 'var(--ed-ink-soft)' }}>
              Sem aprovações {statusFilter === 'PENDING' ? 'pendentes' : 'neste filtro'}.
            </p>
          </div>
        ) : (
          <table
            className="w-full text-sm"
            style={{ borderColor: 'var(--ed-rule)' }}
            data-testid="approvals-table"
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
                <th className="text-left py-3 px-4 font-medium">Documento</th>
                <th className="text-left py-3 px-4 font-medium">Fornecedor</th>
                <th className="text-left py-3 px-4 font-medium">Valor</th>
                <th className="text-left py-3 px-4 font-medium">Solicitante</th>
                <th className="text-left py-3 px-4 font-medium">Idade</th>
                <th className="text-left py-3 px-4 font-medium">Estado</th>
                <th className="text-right py-3 px-4 font-medium">Ações</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const isPending = row.status === 'PENDING';
                const isOwnRequest = user?.id && row.requestedById === user.id;
                const canActOnThis = canDecide && isPending && !isOwnRequest;
                return (
                  <tr
                    key={row.id}
                    className="align-middle"
                    style={{ borderBottom: '1px solid var(--ed-rule)' }}
                    data-testid={`approvals-row-${row.id}`}
                  >
                    <td className="py-3 px-4">
                      <button
                        type="button"
                        onClick={() => router.push(`/documents/${row.documentId}`)}
                        className="font-mono text-sm hover:opacity-70 transition-opacity"
                        style={{ color: 'var(--ed-ink)' }}
                      >
                        {row.documentLabel}
                      </button>
                    </td>
                    <td className="py-3 px-4" style={{ color: 'var(--ed-ink-soft)' }}>
                      {row.supplierName ?? '—'}
                    </td>
                    <td className="py-3 px-4 font-mono" style={{ color: 'var(--ed-ink)' }}>
                      {fmtCurrency(row.totalAmount)}
                    </td>
                    <td className="py-3 px-4" style={{ color: 'var(--ed-ink-soft)' }}>
                      {row.requestedByName ?? row.requestedById.slice(0, 8)}
                    </td>
                    <td className="py-3 px-4 font-mono" style={{ color: 'var(--ed-ink-soft)' }}>
                      {fmtAge(row.createdAt)}
                    </td>
                    <td className="py-3 px-4">
                      <StatusBadge status={row.status} />
                    </td>
                    <td className="py-3 px-4 text-right">
                      {isPending ? (
                        canActOnThis ? (
                          <div className="inline-flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => onApprove(row)}
                              disabled={decide.isPending}
                              aria-busy={decide.isPending}
                              className="inline-flex items-center gap-1 px-2 py-1 text-xs hover:opacity-70 transition-opacity disabled:opacity-50"
                              style={{
                                background: 'transparent',
                                color: 'var(--ed-status-ok)',
                                border: '1px solid var(--ed-status-ok)',
                                borderRadius: 'var(--ed-radius-chip)',
                              }}
                              data-testid={`approvals-approve-${row.id}`}
                            >
                              <CheckIcon size={12} aria-hidden="true" />
                              Aprovar
                            </button>
                            <button
                              type="button"
                              onClick={() => onAskComment(row, 'reject')}
                              disabled={decide.isPending}
                              className="inline-flex items-center gap-1 px-2 py-1 text-xs hover:opacity-70 transition-opacity disabled:opacity-50"
                              style={{
                                background: 'transparent',
                                color: 'var(--ed-status-alert)',
                                border: '1px solid var(--ed-status-alert)',
                                borderRadius: 'var(--ed-radius-chip)',
                              }}
                              data-testid={`approvals-reject-${row.id}`}
                            >
                              <XIcon size={12} aria-hidden="true" />
                              Rejeitar
                            </button>
                            <button
                              type="button"
                              onClick={() => onAskComment(row, 'request-changes')}
                              disabled={decide.isPending}
                              className="inline-flex items-center gap-1 px-2 py-1 text-xs hover:opacity-70 transition-opacity disabled:opacity-50"
                              style={{
                                background: 'transparent',
                                color: 'var(--ed-ink-soft)',
                                border: '1px solid var(--ed-rule-strong)',
                                borderRadius: 'var(--ed-radius-chip)',
                              }}
                              data-testid={`approvals-request-changes-${row.id}`}
                            >
                              <RefreshCw size={12} aria-hidden="true" />
                              Pedir mudanças
                            </button>
                          </div>
                        ) : isOwnRequest ? (
                          <span
                            className="text-[11px]"
                            style={{ color: 'var(--ed-ink-faint)' }}
                            data-testid={`approvals-own-${row.id}`}
                          >
                            seu pedido
                          </span>
                        ) : (
                          <span className="text-[11px]" style={{ color: 'var(--ed-ink-faint)' }}>
                            — aguarda decisão —
                          </span>
                        )
                      ) : (
                        <span className="text-[11px]" style={{ color: 'var(--ed-ink-faint)' }}>
                          {row.decidedByName ?? '—'} · {row.decidedAt ? new Date(row.decidedAt).toLocaleDateString('pt-PT') : ''}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        {/* Self-decide explanation footer */}
        {mainSection === 'requests' && canDecide && rows.some((r) => r.status === 'PENDING' && r.requestedById === user?.id) && (
          <p className="mt-4 text-[11px]" style={{ color: 'var(--ed-ink-faint)' }}>
            Linhas marcadas «seu pedido» não podem ser decididas pelo próprio solicitante —
            aguarda um segundo aprovador.
          </p>
        )}
      </div>

      {/* Comment modal for reject / request-changes */}
      <Dialog
        open={commentFor !== null}
        onClose={() => {
          if (decide.isPending) return;
          setCommentFor(null);
          setCommentDraft('');
        }}
        title={
          commentFor?.action === 'reject'
            ? 'Rejeitar pedido de aprovação'
            : 'Pedir mudanças'
        }
        description="O comentário é obrigatório e fica no histórico de auditoria."
        size="sm"
      >
        {commentFor && (
          <div className="space-y-4">
            <div className="text-sm" style={{ color: 'var(--ed-ink-soft)' }}>
              Documento:{' '}
              <span className="font-mono" style={{ color: 'var(--ed-ink)' }}>
                {commentFor.approval.documentLabel}
              </span>
            </div>
            <label className="block">
              <span
                className="text-[12px] uppercase tracking-wider font-medium"
                style={{ color: 'var(--ed-ink-faint)' }}
              >
                Comentário (obrigatório)
              </span>
              <textarea
                value={commentDraft}
                onChange={(e) => setCommentDraft(e.target.value)}
                rows={4}
                maxLength={1000}
                placeholder={
                  commentFor.action === 'reject'
                    ? 'Porquê que este pedido está a ser rejeitado…'
                    : 'Que mudanças são necessárias no documento…'
                }
                className="mt-1 w-full px-2 py-1.5 text-sm border rounded"
                style={{
                  borderColor: 'var(--ed-rule-strong)',
                  background: 'var(--ed-card, #fff)',
                  color: 'var(--ed-ink)',
                }}
                data-testid={`approvals-comment-input-${commentFor.approval.id}`}
                autoFocus
              />
            </label>
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setCommentFor(null);
                  setCommentDraft('');
                }}
                disabled={decide.isPending}
                className="btn-secondary text-sm"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={onSubmitComment}
                disabled={decide.isPending || commentDraft.trim().length === 0}
                aria-busy={decide.isPending}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium transition-opacity disabled:opacity-50"
                style={{
                  background:
                    commentFor.action === 'reject' ? 'var(--ed-status-alert)' : 'var(--ed-accent-gold)',
                  color: commentFor.action === 'reject' ? '#fff' : 'var(--ed-ink)',
                  borderRadius: 'var(--ed-radius-chip)',
                }}
                data-testid={`approvals-comment-submit-${commentFor.approval.id}`}
              >
                {decide.isPending ? (
                  <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                ) : commentFor.action === 'reject' ? (
                  <XIcon size={14} aria-hidden="true" />
                ) : (
                  <MessageSquare size={14} aria-hidden="true" />
                )}
                {decide.isPending ? 'A registar…' : commentFor.action === 'reject' ? 'Rejeitar' : 'Pedir mudanças'}
              </button>
            </div>
          </div>
        )}
      </Dialog>
    </div>
  );
}

function StatusBadge({ status }: { status: ApprovalStatus }) {
  const palette: Record<ApprovalStatus, { bg: string; color: string; label: string; Icon: typeof ShieldCheck }> = {
    PENDING: {
      bg: 'rgba(203, 166, 90, 0.18)',
      color: 'var(--ed-accent-gold)',
      label: 'pendente',
      Icon: ShieldCheck,
    },
    APPROVED: {
      bg: 'rgba(79, 121, 66, 0.12)',
      color: 'var(--ed-status-ok)',
      label: 'aprovado',
      Icon: CheckIcon,
    },
    REJECTED: {
      bg: 'rgba(139, 46, 42, 0.12)',
      color: 'var(--ed-status-alert)',
      label: 'rejeitado',
      Icon: XIcon,
    },
    CHANGES_REQUESTED: {
      bg: 'rgba(120, 120, 120, 0.10)',
      color: 'var(--ed-ink-soft)',
      label: 'mudanças',
      Icon: RefreshCw,
    },
    WITHDRAWN: {
      bg: 'rgba(120, 120, 120, 0.10)',
      color: 'var(--ed-ink-faint)',
      label: 'retirado',
      Icon: RefreshCw,
    },
  };
  const p = palette[status];
  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium whitespace-nowrap"
      style={{
        background: p.bg,
        color: p.color,
        borderRadius: 'var(--ed-radius-chip)',
        fontFamily: 'var(--font-editorial), ui-serif, Georgia, serif',
        letterSpacing: '0.04em',
      }}
      data-status={status}
    >
      <p.Icon size={12} aria-hidden="true" />
      {p.label}
    </span>
  );
}
