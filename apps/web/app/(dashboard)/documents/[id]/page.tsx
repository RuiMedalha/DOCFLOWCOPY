'use client';

/**
 * /documents/[id] — document detail page.
 *
 * Editorial / Contábil · Blueprint Edition (commit 2026-09-04).
 *   - Lógica de negócio permanece intacta (useDocumentBundle, onSave,
 *     onApprove, onSendToToc, draft state, role gating — todos preservados).
 *   - Layout: header em 3 camadas (breadcrumb fino → nº doc oversized mono
 *     48px JetBrains Mono com 2 primeiros chars em accent-gold → hero status
 *     banner Fraunces 20px), body em grid editorial 12 col (4 viewer + 8 form)
 *     separado por hairlines navy 1px.
 *   - Micro-fixes: beforeunload guard quando draft != null + ConfirmDialog
 *     em volta do DELETE de linha.
 *
 * Data flows through TanStack Query (see ./use-document-detail.ts). All
 * mutations surface to the cache; the page itself owns the optimistic
 * field edits so the user can type freely.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  AlertCircle,
  Loader2,
  ShieldCheck,
  ShieldAlert,
  Check,
  X as XIcon,
  RefreshCw,
  Save,
  UserCheck,
  Trash2,
  FileSearch,
  ExternalLink,
  Sparkles,
} from 'lucide-react';
import { DocumentViewer } from './_components/document-viewer';
import { FieldPanel } from './_components/field-panel';
import { ClassificationPanel } from './_components/classification-panel';
import { FraudWarning } from './_components/fraud-warning';
import { QrBadge } from './_components/qr-badge';
import { CorrectSupplierDialog } from './_components/correct-supplier-dialog';
import { SupplierManualEditSection } from './_components/supplier-manual-edit-section';
import { ReExtractDialog } from './_components/re-extract-dialog';
import { AiTelemetryBadge } from './_components/ai-telemetry-badge';
import { CertaintyBadge } from './_components/certainty-badge';
import { Dialog } from '../../../_components/ui';
import { toastBus } from '../../../_components/ui';
import {
  useAddLineItem,
  useApproveDocument,
  useAssignAccounting,
  useDeleteLineItem,
  useDocumentBundle,
  useDownloadUrl,
  useHardDeleteDocument,
  useReExtract,
  useReExtractSupplier,
  useSaveFields,
  useSendToToc,
  useSoftDeleteDocument,
  useUpdateLineItem,
  type DocumentDetail,
} from './_lib/use-document-detail';
import type { ExtractedFields } from './_components/field-panel';
import { useUser } from '@/_lib/use-dashboard-queries';

// Approval-workflow types + helpers (Sprint 1.B). The full data
// model lives in the approvals module — we mirror only the slice
// the detail page renders.
type ApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CHANGES_REQUESTED' | 'WITHDRAWN';

interface ApprovalListItem {
  id: string;
  documentId: string;
  status: ApprovalStatus;
  requestedById: string;
  requestedByName?: string;
  decidedById?: string | null;
  decidedByName?: string | null;
  decidedAt?: string | null;
  comment?: string | null;
  createdAt: string;
  documentLabel: string;
  supplierName?: string | null;
  totalAmount?: number | null;
}

async function approvalsApiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  // We re-derive API_BASE here to avoid widening the sibling hooks
  // file. Both halves of the dashboard share the same backend URL.
  const apiBase =
    (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, '')) ||
    'http://localhost:4000/api/v1';
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { authedFetch } = await import('../../../_lib/auth-refresh');
  const res = await authedFetch(`${apiBase}${path}`, init);
  if (!res.ok) {
    let body: any = {};
    try { body = await res.json(); } catch { /* ignore */ }
    throw new Error(body?.message ?? `HTTP ${res.status}`);
  }
  const json = await res.json();
  return (json?.data ?? json) as T;
}

/** Split "FT 2026/1234" → { "FT" (gold), "2026/1234" (navy) } for the anchor. */
function splitDocNumber(raw: string | null | undefined): { prefix: string; rest: string } {
  if (!raw) return { prefix: '', rest: '' };
  // Match leading non-digit characters as the prefix (e.g. "FT ", "NC ", "Fatura-").
  const m = raw.match(/^(\D{0,4})?(\d.*)$/);
  if (!m) return { prefix: '', rest: raw };
  return { prefix: (m[1] ?? '').trim(), rest: m[2] ?? raw };
}

/** Format a timestamp into "HH:MM" (PT locale) for the hero status banner. */
function fmtTime(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' });
}

/** Format a date as "DD MMM YYYY" (PT locale) for the hero status banner. */
function fmtDateLong(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('pt-PT', { day: '2-digit', month: 'short', year: 'numeric' });
}

export default function DocumentDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params?.id ?? '';
  const qc = useQueryClient();

  const bundle = useDocumentBundle(id);
  const reExtract = useReExtract();
  const reExtractSupplier = useReExtractSupplier();
  const saveFields = useSaveFields();
  const approve = useApproveDocument();
  const assignAcc = useAssignAccounting();
  const sendToToc = useSendToToc();
  const addLine = useAddLineItem();
  const updateLine = useUpdateLineItem();
  const deleteLine = useDeleteLineItem();
  const hardDelete = useHardDeleteDocument();
  const softDelete = useSoftDeleteDocument();

  // Sprint 1.B — approval workflow hooks. Approval history is read
  // directly from the approvals endpoint so the detail page does
  // not need a new field on the Document payload. The latest
  // PENDING row (if any) drives the approve / reject / request-changes
  // action group visible to APPROVER/ADMIN.
  const approvalHistoryQuery = useQuery({
    queryKey: ['document-approval-history', id],
    queryFn: () => approvalsApiFetch<ApprovalListItem[]>(`/documents/${id}/approval-history`),
    enabled: !!id,
    refetchInterval: 30000,
  });
  const currentApproval = useMemo(() => {
    const list = approvalHistoryQuery.data ?? [];
    return list.find((a) => a.status === 'PENDING') ?? null;
  }, [approvalHistoryQuery.data]);
  const requestApproval = useMutation({
    mutationFn: (comment?: string) =>
      approvalsApiFetch<{ approvalId: string; verifiedAt: string }>(
        `/documents/${id}/request-approval`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ comment }),
        },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['document-approval-history', id] });
      qc.invalidateQueries({ queryKey: ['document-detail', id] });
      qc.invalidateQueries({ queryKey: ['approvals'] });
      toastBus.success('Pedido de aprovação enviado.');
    },
    onError: (err: any) => {
      toastBus.error(typeof err?.message === 'string' ? err.message : 'Falha ao solicitar aprovação.');
    },
  });
  const decideApproval = useMutation({
    mutationFn: ({
      approvalId,
      action,
      comment,
    }: {
      approvalId: string;
      action: 'approve' | 'reject' | 'request-changes';
      comment?: string;
    }) =>
      approvalsApiFetch(`/approvals/${approvalId}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ comment }),
      }),
    onSuccess: (_r, vars) => {
      qc.invalidateQueries({ queryKey: ['document-approval-history', id] });
      qc.invalidateQueries({ queryKey: ['approvals'] });
      qc.invalidateQueries({ queryKey: ['document-detail', id] });
      toastBus.success('Decisão registada.');
    },
    onError: (err: any) => {
      toastBus.error(typeof err?.message === 'string' ? err.message : 'Falha ao decidir.');
    },
  });

  // Role gating for line-item editing. Backend enforces the same gate
  // (Role.ADMIN / Role.OPERADOR) — we mirror it here so the UI doesn't
  // expose controls that would 403 on submit.
  const user = useUser();
  const canEditLines =
    user?.role === 'ADMIN' || user?.role === 'OPERADOR';
  // Hard-delete is ADMIN-only (matches @Roles(Role.ADMIN) on the
  // backend). OPERADOR cannot see the button; non-admin callers
  // never get the DELETE endpoint past the RBAC guard anyway.
  const canHardDelete = user?.role === 'ADMIN';

  // Track which row is mid-PATCH so the FieldPanel can disable that row's
  // inputs until the refetch lands.
  const [busyItemId, setBusyItemId] = useState<string | null>(null);
  const [deletingItemId, setDeletingItemId] = useState<string | null>(null);

  // Pending DELETE confirmation (FieldPanel asks the parent to show the dialog
  // because the parent owns the mutation lifecycle and the toastBus feedback).
  const [pendingDelete, setPendingDelete] = useState<{ itemId: string; description: string } | null>(null);

  // Pending HARD DELETE confirmation (ADMIN-only). The button lives in the
  // primary actions row; this state holds the doc id while the dialog is
  // open so the parent can orchestrate the mutation + navigation.
  const [pendingHardDelete, setPendingHardDelete] = useState(false);

  // Pending SOFT DELETE (trash) confirmation — every user of the tenant
  // can move a doc to trash; restore is ADMIN-only.
  const [pendingSoftDelete, setPendingSoftDelete] = useState(false);

  // Manual supplier correction dialog (Sprint H+). The button lives next
  // to Re-extrair in the primary actions row; the dialog itself is
  // mounted at the bottom of the page so its lifecycle is owned here.
  const [correctDialogOpen, setCorrectDialogOpen] = useState(false);

  // Pending overwrite confirmation (Sprint H+ Part 2.2). When the AI
  // supplier block has been operator-verified, "Re-extrair com IA"
  // shows a confirm modal that calls the endpoint with ?force=true.
  // `pendingReExtract` holds the doc id while the modal is open so the
  // parent can orchestrate the mutation + toastBus feedback (mirrors
  // the hard-delete / soft-delete pattern).
  const [pendingReExtract, setPendingReExtract] = useState(false);
  const [reExtractModalOpen, setReExtractModalOpen] = useState(false);

  // Sprint 1.B — pending approve decision (reject + request-changes
  // need a comment; the modal lives below the page body).
  const [pendingApprovalDecision, setPendingApprovalDecision] = useState<
    { approval: ApprovalListItem; action: 'reject' | 'request-changes'; comment: string } | null
  >(null);

  // Local optimistic field state — flushed to the server via Save.
  const doc = bundle.data?.document;
  const [draft, setDraft] = useState<ExtractedFields | null>(null);

  // Dirty-state guard: warn the browser if the user navigates away with
  // unsaved field edits. Fires only while draft != null (cleared by Save /
  // Re-extrair after a successful refetch).
  useEffect(() => {
    if (!draft) return;
    function onBeforeUnload(e: BeforeUnloadEvent) {
      e.preventDefault();
      e.returnValue = '';
      return '';
    }
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [draft]);

  // Sync draft when the bundle updates, but don't clobber unsaved edits.
  const effective: ExtractedFields | null = useMemo(() => {
    if (!doc) return draft;
    if (!draft) {
      const { id: _id, ...rest } = doc as any;
      void _id;
      return rest;
    }
    return draft;
  }, [doc, draft]);

  const effectiveFileName = useMemo(() => {
    if (draft?.fileName) return draft.fileName;
    if (doc?.fileName) return doc.fileName;
    return null;
  }, [draft?.fileName, doc?.fileName]);

  const downloadUrl = useDownloadUrl(id, 'pdf', effectiveFileName);

  const onFieldChange = useCallback((patch: Partial<ExtractedFields>) => {
    setDraft((prev) => {
      const base = prev ?? {
        fileName: doc?.fileName,
        type: doc?.type,
        supplier: doc?.supplier,
        supplierNif: doc?.supplierNif,
        customer: doc?.customer,
        customerNif: doc?.customerNif,
        docNumber: doc?.docNumber,
        atcud: doc?.atcud,
        docDate: doc?.docDate,
        dueDate: doc?.dueDate,
        netAmount: doc?.netAmount,
        taxAmount: doc?.taxAmount,
        total: doc?.total,
        iban: doc?.iban,
        currency: doc?.currency,
        expenseCategory: doc?.expenseCategory,
        paymentStatus: (doc as any)?.paymentStatus ?? 'TO_PAY',
        paymentMethod: (doc as any)?.paymentMethod ?? null,
        paymentDueDate: (doc as any)?.paymentDueDate ?? null,
      };
      return { ...base, ...patch };
    });
  }, [doc]);

  const onSave = useCallback(async () => {
    if (!id) return;
    // Build the payload from the live draft (user edits) and fall back to the
    // currently rendered fields when the user hasn't touched anything — so a
    // bare click on "Guardar" actually persists the current values instead of
    // silently no-op'ing.
    const base = (draft ?? (effective ?? {})) as Record<string, unknown>;
    // The PATCH /documents/:id DTO is built with class-validator's
    // `whitelist: true` + `forbidNonWhitelisted: true`, so any property it
    // does not know about (tenantId, fileName, ocrConfidence, atcud, iban…)
    // causes a 400. Filter to the allowed fields only.
    const allowedKeys = [
      'type',
      'status',
      'fiscalStatus',
      'expenseCategoryId',
      'expenseNature',
      'supplier',
      'supplierNif',
      'customer',
      'customerNif',
      'docNumber',
      'docDate',
      'dueDate',
      'total',
      'taxAmount',
      'netAmount',
      'currency',
      'tags',
      'folderId',
      'expenseCategory',
      'partyId',
      'paymentStatus',
      'paymentMethod',
      'paymentDueDate',
      'fileName',
    ] as const;
    const patch: Record<string, unknown> = {};
    for (const k of allowedKeys) {
      if (k in base) patch[k] = base[k];
    }
    try {
      await saveFields.mutateAsync({ id, patch });
      setDraft(null);
      qc.invalidateQueries({ queryKey: ['document-detail', id] });
      qc.invalidateQueries({ queryKey: ['documents'] });
      toastBus.success('Alterações guardadas.');
    } catch (err: any) {
      // class-validator surfaces a JSON-encoded list of offending keys; keep
      // the user-facing copy short and actionable.
      const raw = typeof err?.message === 'string' ? err.message : '';
      const friendly =
        raw.includes('should not exist') || raw.includes('whitelist')
          ? 'Há campos não editáveis no payload — recarregue a página.'
          : raw || 'Falha ao guardar alterações.';
      toastBus.error(friendly);
    }
  }, [id, draft, effective, saveFields, qc]);

  const onReExtract = useCallback(async () => {
    if (!id) return;
    try {
      await reExtract.mutateAsync(id);
      setDraft(null);
      // Backend returns 202 immediately; the actual extraction runs
      // async via the processing pipeline. The hook's onSuccess
      // already invalidated the detail cache; SSE will push the
      // processingStatus transitions (RECEIVED -> EXTRACTING ->
      // ENRICHING -> COMPLETED) as they happen, and the field
      // values land via the document-detail refetch the SSE consumer
      // triggers on terminal states.
      toastBus.success(
        'Re-extração iniciada — processamento vai completar em segundos.',
      );
    } catch (err: any) {
      const message =
        typeof err?.message === 'string' && err.message.length > 0
          ? err.message
          : 'Falha na re-extração.';
      toastBus.error(`Re-extract failed: ${message}`);
    }
  }, [id, reExtract, qc]);

  const onReExtractWithOptions = useCallback(
    async (opts: { model?: string; provider?: string }) => {
      if (!id) return;
      try {
        await reExtract.mutateAsync({ id, model: opts.model, provider: opts.provider });
        setReExtractModalOpen(false);
        setDraft(null);
        toastBus.success(
          `Re-extração com ${opts.model || 'modelo selecionado'} iniciada.`,
        );
      } catch (err: any) {
        const message =
          typeof err?.message === 'string' && err.message.length > 0
            ? err.message
            : 'Falha na re-extração.';
        toastBus.error(`Re-extract failed: ${message}`);
      }
    },
    [id, reExtract],
  );

  /**
   * Sprint H+ Part 2.2 — "Re-extrair com IA" button on the supplier block.
   *
   * Calls POST /documents/:id/supplier/re-extract which only refreshes
   * the supplier block (name / NIF / IBAN / country) without re-running
   * the entire OCR pipeline. When Document.supplierVerifiedAt is set,
   * the backend refuses with 409 unless ?force=true — the UI handles
   * this by showing a confirmation modal first.
   *
   * Two entry points:
   *   - onReExtractSupplierClick() — public handler bound to the
   *     button. Decides whether to call directly or open the modal
   *     based on the verified flag.
   *   - confirmReExtractSupplier() — wired to the modal's positive
   *     button. Forces the call with ?force=true.
   */
  const onReExtractSupplierClick = useCallback(() => {
    if (!id) return;
    if (doc?.supplierVerifiedAt) {
      setPendingReExtract(true);
      return;
    }
    // Unverified → call directly with force=false.
    void runReExtractSupplier(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, doc?.supplierVerifiedAt]);

  const runReExtractSupplier = useCallback(
    async (force: boolean) => {
      if (!id) return;
      try {
        await reExtractSupplier.mutateAsync({ id, force });
        setDraft(null);
        toastBus.success(
          force
            ? 'Fornecedor sobrescrito pela IA — auditoria registada.'
            : 'Fornecedor re-extraído pela IA.',
        );
      } catch (err: any) {
        const raw =
          typeof err?.message === 'string' && err.message.length > 0
            ? err.message
            : 'Falha na re-extração do fornecedor.';
        toastBus.error(`Re-extract failed: ${raw}`);
      }
    },
    [id, reExtractSupplier],
  );

  const confirmReExtractSupplier = useCallback(async () => {
    setPendingReExtract(false);
    await runReExtractSupplier(true);
  }, [runReExtractSupplier]);

  const onApprove = useCallback(async () => {
    if (!id) return;
    const nifVal = (doc as any)?.metadata?.extraction?.certainty?.tenantNifValidation;
    if (nifVal && !nifVal.isOfficialDocument) {
      const confirmMsg =
        nifVal.status === 'MISMATCH_THIRD_PARTY'
          ? `ALERTA FISCAL CRÍTICO:\n\nEste documento tem o NIF de adquirente ${nifVal.customerNif}, que difere do NIF da sua empresa (${nifVal.tenantNif}).\n\nTem a certeza de que deseja aprovar um documento emitido para uma entidade terceira?`
          : `AVISO FISCAL (art. 36.º CIVA):\n\nEste documento não tem o NIF da sua empresa (${nifVal.tenantNif ?? 'não configurado'}). De acordo com as regras fiscais, não pode ser deduzido como documento oficial da empresa sem verificação manual.\n\nTem a certeza de que deseja aprová-lo?`;
      if (!window.confirm(confirmMsg)) {
        return;
      }
    }
    try {
      await approve.mutateAsync(id);
      // The mutation already patches the cache to status='APROVADO' and the
      // approval badge derives from `isApproved`, so the UI flips without a
      // second round-trip. Force a refetch in the background so any
      // server-side side effects (timestamps, approverId) materialise.
      qc.invalidateQueries({ queryKey: ['document-detail', id] });
      toastBus.success('Documento aprovado.');
    } catch (err: any) {
      // Surface the API message verbatim — it's usually specific (e.g.
      // "document must be reviewed first") and helps the user unblock.
      const raw = typeof err?.message === 'string' ? err.message : '';
      toastBus.error(raw || 'Falha ao aprovar o documento.');
    }
  }, [id, approve, qc, doc]);

  const onAssignDebit = useCallback(
    (code: string) => assignAcc.mutate({ id, debit: code, credit: undefined }),
    [assignAcc, id],
  );
  const onAssignCredit = useCallback(
    (code: string) => assignAcc.mutate({ id, debit: undefined, credit: code }),
    [assignAcc, id],
  );

  const onSendToToc = useCallback(async () => {
    if (!id) return;
    await sendToToc.mutateAsync(id);
  }, [id, sendToToc]);

  const onAddLineItem = useCallback(async () => {
    if (!id) return;
    try {
      await addLine.mutateAsync({
        id,
        body: { description: 'Novo item', quantity: 1, unitPrice: 0, taxRate: 23 },
      });
      qc.invalidateQueries({ queryKey: ['document-detail', id] });
      toastBus.success('Linha adicionada.');
    } catch (err: any) {
      const raw = typeof err?.message === 'string' ? err.message : '';
      toastBus.error(raw || 'Falha ao adicionar linha.');
    }
  }, [id, addLine, qc]);

  const onUpdateLineItem = useCallback(
    async (itemId: string, patch: Record<string, number | string | null>) => {
      if (!id) return;
      setBusyItemId(itemId);
      try {
        await updateLine.mutateAsync({ id, itemId, patch });
        qc.invalidateQueries({ queryKey: ['document-detail', id] });
      } catch (err: any) {
        const raw = typeof err?.message === 'string' ? err.message : '';
        toastBus.error(raw || 'Falha ao atualizar linha.');
      } finally {
        setBusyItemId(null);
      }
    },
    [id, updateLine, qc],
  );

  // FieldPanel opens the confirmation dialog by calling this; we own the
  // actual mutation lifecycle (so the toastBus feedback stays here).
  const onDeleteLineItem = useCallback(
    async (itemId: string, description?: string) => {
      setPendingDelete({ itemId, description: description ?? '' });
    },
    [],
  );
  const confirmDeleteLineItem = useCallback(async () => {
    if (!id || !pendingDelete) return;
    const { itemId } = pendingDelete;
    setPendingDelete(null);
    setDeletingItemId(itemId);
    try {
      await deleteLine.mutateAsync({ id, itemId });
      qc.invalidateQueries({ queryKey: ['document-detail', id] });
      toastBus.success('Linha removida.');
    } catch (err: any) {
      const raw = typeof err?.message === 'string' ? err.message : '';
      toastBus.error(raw || 'Falha ao remover linha.');
    } finally {
      setDeletingItemId(null);
    }
  }, [id, pendingDelete, deleteLine, qc]);

  /**
   * Hard-delete (ADMIN only) — destructive, irreversible. The button
   * shows a confirmation dialog and only fires on the positive click.
   * On success we navigate back to the documents list (the detail page
   * would 404 on the next refetch since the row is gone) and surface
   * a toast. Failure keeps the user on the page so they can retry or
   * copy the doc id.
   *
   * Mirrors the existing soft-delete / approve / line-item patterns:
   * parent owns the mutation lifecycle + toastBus feedback, dialog is
   * just a confirm step.
   */
  const confirmHardDelete = useCallback(async () => {
    if (!id) return;
    setPendingHardDelete(false);
    try {
      await hardDelete.mutateAsync(id);
      toastBus.success('Documento apagado permanentemente.');
      // Navigate back to the list — the row no longer exists, so any
      // refetch on this id would 404. router.replace avoids adding the
      // dead id to the back stack.
      router.replace('/documents');
    } catch (err: any) {
      const raw = typeof err?.message === 'string' ? err.message : '';
      // 403 → non-admin (shouldn't happen because we gate the button,
      // but defensive: surface a friendly copy anyway).
      const friendly =
        raw.toLowerCase().includes('forbidden') || raw.toLowerCase().includes('admin')
          ? 'Sem permissões para apagar este documento.'
          : raw || 'Falha ao apagar o documento.';
      toastBus.error(friendly);
    }
  }, [id, hardDelete, router]);

  /**
   * Soft-delete (trash) — reversible. Available to every authenticated
   * user of the tenant. We navigate back to the list because the
   * detail page would refetch and 404 (the row is hidden from the
   * default `findOne` query).
   */
  const confirmSoftDelete = useCallback(async () => {
    if (!id) return;
    setPendingSoftDelete(false);
    try {
      await softDelete.mutateAsync(id);
      toastBus.success('Documento movido para a lixeira.');
      router.replace('/documents/trash');
    } catch (err: any) {
      const raw = typeof err?.message === 'string' ? err.message : '';
      toastBus.error(raw || 'Falha ao mover para a lixeira.');
    }
  }, [id, softDelete, router]);

  if (bundle.isLoading) {
    return (
      <div data-skin="editorial" className="flex items-center justify-center py-24">
        <Loader2
          size={22}
          className="animate-spin"
          aria-hidden="true"
          style={{ color: 'var(--ed-accent-gold)' }}
        />
        <span className="ml-2 text-sm" style={{ color: 'var(--ed-ink-soft)' }}>
          A carregar documento…
        </span>
      </div>
    );
  }

  if (bundle.isError || !bundle.data || !doc) {
    return (
      <div data-skin="editorial">
        <button
          type="button"
          onClick={() => router.push('/documents')}
          className="btn-secondary text-sm mb-4"
        >
          <ArrowLeft size={14} aria-hidden="true" />
          Voltar à lista
        </button>
        <div className="card p-8 text-center">
          <AlertCircle
            size={32}
            className="mx-auto mb-2"
            aria-hidden="true"
            style={{ color: 'var(--ed-status-alert)' }}
          />
          <p className="text-sm" style={{ color: 'var(--ed-ink-soft)' }}>
            Não foi possível carregar este documento.
          </p>
        </div>
      </div>
    );
  }

  const isApproved =
    doc.status === 'APROVADO' || doc.status === 'CONCILIADO' || doc.status === 'PAGO';

  // Anchor split — first 2-ish chars become the gold prefix, the digits stay navy.
  const docNumberRaw = doc.docNumber ?? doc.fileName ?? `Documento ${id.slice(0, 8)}`;
  const { prefix: docPrefix, rest: docRest } = splitDocNumber(docNumberRaw);

  // Hero status banner copy + tone. Hidden while the doc is still NOVO
  // (nothing to review / nothing to approve / nothing to reject yet).
  const heroStatusCopy: Record<string, { copy: string; tone: 'ok' | 'warn' | 'alert' | 'neutral'; icon: 'shield' | 'check' | 'x' | null }> = {
    EM_REVISAO: { copy: 'Pronto para revisar', tone: 'warn', icon: 'shield' },
    DUPLICADO: { copy: 'Duplicado · já existe um documento com esta chave fiscal', tone: 'alert', icon: 'x' },
    APROVADO: {
      copy: `Aprovado · ${fmtTime((doc as any).approvedAt) || '—'}`,
      tone: 'ok',
      icon: 'check',
    },
    REJEITADO: {
      copy: 'Rejeitado · ver motivo',
      tone: 'alert',
      icon: 'x',
    },
    CONCILIADO: { copy: 'Conciliado · ver extrato', tone: 'ok', icon: 'check' },
    PAGO: { copy: 'Pago · ver recibo', tone: 'ok', icon: 'check' },
    // Sprint 1.B — approval workflow states.
    PENDING_APPROVAL: { copy: 'A aguardar aprovação', tone: 'warn', icon: 'shield' },
    CHANGES_REQUESTED: { copy: 'Mudanças solicitadas', tone: 'alert', icon: 'x' },
  };
  const hero = heroStatusCopy[doc.status as keyof typeof heroStatusCopy];

  return (
    <div data-skin="editorial" className="min-h-screen">
      {/* ================================================================
          HEADER — 3 camadas verticais (breadcrumb / anchor / hero status)
          ================================================================ */}
      <header className="border-b" style={{ borderColor: 'var(--ed-rule)' }}>
        {/* Camada 1 — breadcrumb fino */}
        <nav
          className="flex items-center justify-between gap-2 px-2 py-3 text-[12px] font-semibold uppercase tracking-wider"
          style={{ color: 'var(--ed-ink-faint)' }}
          aria-label="Caminho"
        >
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => router.push('/documents')}
              className="inline-flex items-center gap-1 hover:opacity-70 transition-opacity"
              style={{ color: 'var(--ed-ink-faint)' }}
            >
              <ArrowLeft size={12} aria-hidden="true" />
              Documentos
            </button>
            <span aria-hidden="true" style={{ color: 'var(--ed-rule-strong)' }}>/</span>
            <span className="font-mono normal-case tracking-normal" style={{ color: 'var(--ed-ink-soft)' }}>
              {docNumberRaw}
            </span>
          </div>
          <div className="hidden md:flex items-center gap-3" style={{ color: 'var(--ed-ink-faint)' }}>
            <span><kbd className="kbd">⌘S</kbd> Guardar</span>
            <span><kbd className="kbd">⌘↵</kbd> Aprovar</span>
          </div>
        </nav>

        {/* Camada 2 — nº doc oversized mono (anchor memorável) */}
        <div className="px-2 pt-6 pb-5">
          <h1
            className="font-mono font-bold leading-[1] tracking-tight"
            style={{
              fontSize: 'clamp(40px, 5vw, 56px)',
              color: 'var(--ed-ink)',
              letterSpacing: '-0.02em',
            }}
            aria-label={`Número do documento ${docNumberRaw}`}
          >
            {docPrefix && (
              <span
                style={{
                  background: 'linear-gradient(180deg, #cba65a 0%, #a8893f 100%)',
                  WebkitBackgroundClip: 'text',
                  WebkitTextFillColor: 'transparent',
                  backgroundClip: 'text',
                  marginRight: '0.05em',
                }}
              >
                {docPrefix}
              </span>
            )}
            {docRest || docNumberRaw}
          </h1>
          {doc.supplier && (
            <p
              className="mt-3 text-lg"
              style={{
                fontFamily: 'var(--font-editorial), ui-serif, Georgia, serif',
                color: 'var(--ed-ink)',
                fontWeight: 600,
              }}
            >
              {doc.supplier}
              {doc.supplierNif && (
                <>
                  {' · '}
                  <span className="font-mono" style={{ color: 'var(--ed-ink-faint)' }}>
                    NIF {doc.supplierNif}
                  </span>
                </>
              )}
              {(doc as any).docDate && (
                <>
                  {' · '}
                  <span className="font-mono" style={{ color: 'var(--ed-ink-faint)' }}>
                    Emissão {fmtDateLong((doc as any).docDate)}
                  </span>
                </>
              )}
            </p>
          )}
        </div>

        {/* Camada 3 — Hero status banner (só renderiza se !== NOVO) */}
        {hero && (
          <div
            className="flex items-center justify-between gap-4 px-6 py-4 border-t"
            style={{
              minHeight: '56px',
              borderColor: 'var(--ed-rule)',
              background:
                hero.tone === 'ok'
                  ? 'rgba(79, 121, 66, 0.05)'
                  : hero.tone === 'alert'
                  ? 'rgba(139, 46, 42, 0.06)'
                  : hero.tone === 'warn'
                  ? 'var(--ed-accent-gold-dim)'
                  : 'transparent',
            }}
          >
            <div className="flex items-center gap-3 min-w-0">
              <span
                className="inline-block w-2 h-2 rounded-full flex-shrink-0"
                style={{
                  background:
                    hero.tone === 'ok'
                      ? 'var(--ed-status-ok)'
                      : hero.tone === 'alert'
                      ? 'var(--ed-status-alert)'
                      : 'var(--ed-accent-gold)',
                  animation: hero.tone === 'warn' ? 'edPulseGold 2.4s cubic-bezier(0.2, 0.8, 0.2, 1) infinite' : undefined,
                }}
                aria-hidden="true"
              />
              <span
                className="truncate"
                style={{
                  fontFamily: 'var(--font-editorial), ui-serif, Georgia, serif',
                  fontSize: '20px',
                  fontWeight: 700,
                  color:
                    hero.tone === 'ok'
                      ? 'var(--ed-status-ok)'
                      : hero.tone === 'alert'
                      ? 'var(--ed-status-alert)'
                      : 'var(--ed-ink)',
                }}
              >
                {hero.icon === 'shield' && <ShieldCheck size={20} className="inline mr-2 -mt-0.5" aria-hidden="true" />}
                {hero.icon === 'check' && <Check size={20} className="inline mr-2 -mt-0.5" aria-hidden="true" />}
                {hero.icon === 'x' && <XIcon size={20} className="inline mr-2 -mt-0.5" aria-hidden="true" />}
                {hero.copy}
              </span>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <button
                type="button"
                onClick={onReExtract}
                disabled={reExtract.isPending}
                aria-busy={reExtract.isPending}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm hover:opacity-70 transition-opacity"
                style={{ color: 'var(--ed-ink-soft)' }}
                title="Re-extrair (Modelo padrão)"
              >
                <RefreshCw
                  size={14}
                  className={reExtract.isPending ? 'animate-spin' : ''}
                  aria-hidden="true"
                />
                Re-extrair
              </button>
              <button
                type="button"
                onClick={() => setReExtractModalOpen(true)}
                disabled={reExtract.isPending}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm hover:opacity-70 transition-opacity"
                style={{ color: 'var(--ed-accent-gold, #0ea5e9)' }}
                title="Escolher modelo específico para re-extração"
              >
                <Sparkles size={14} aria-hidden="true" />
                Re-extrair com...
              </button>
            </div>
          </div>
        )}
      </header>

      {/* ================================================================
          BODY — grid editorial 12 col (4 viewer + 8 form)
          Separado por hairlines navy, sem cards com sombra.
          ================================================================ */}
      <div
        className="grid grid-cols-1 xl:grid-cols-12 animate-ed-fade"
        style={{ padding: '40px 16px 64px', gap: '40px' }}
      >
        {/* LEFT (col-span-4) — viewer + autenticação + IBAN */}
        <aside className="xl:col-span-4 space-y-10">
          <DocumentViewer
            src={downloadUrl}
            fileName={
              (doc as any)?.pdfKey || /^image\//i.test(doc?.mimeType ?? '')
                ? (doc?.fileName ? doc.fileName.replace(/\.[^.]+$/, '.pdf') : `${id}.pdf`)
                : (doc?.fileName ?? `${id}.pdf`)
            }
            mimeType={
              (doc as any)?.pdfKey || /^image\//i.test(doc?.mimeType ?? '')
                ? 'application/pdf'
                : doc?.mimeType
            }
            highlightFields={bundle.data.qrDecodedFields}
          />

          <section>
            <h3
              className="uppercase tracking-wider mb-3 font-medium"
              style={{
                fontFamily: 'var(--font-editorial), ui-serif, Georgia, serif',
                fontSize: '14px',
                letterSpacing: '0.08em',
                color: 'var(--ed-ink-faint)',
              }}
            >
              Autenticação AT
            </h3>
            <QrBadge qrPayload={doc.qrPayload} highlightedFields={bundle.data.qrDecodedFields} />
          </section>

          <section>
            <h3
              className="uppercase tracking-wider mb-3 font-medium"
              style={{
                fontFamily: 'var(--font-editorial), ui-serif, Georgia, serif',
                fontSize: '14px',
                letterSpacing: '0.08em',
                color: 'var(--ed-ink-faint)',
              }}
            >
              Verificação IBAN
            </h3>
            <FraudWarning
              currentIban={doc.iban}
              history={bundle.data.ibanHistory}
              hasParty={doc.hasParty}
            />
          </section>
        </aside>

        {/* RIGHT (col-span-8) — FieldPanel */}
        <section className="xl:col-span-8" style={{ borderLeft: '1px solid var(--ed-rule)', paddingLeft: '40px' }}>
          <CertaintyBadge
            certainty={(doc as any)?.metadata?.extraction?.certainty}
            certaintyScore={(doc as any)?.metadata?.extraction?.certaintyScore}
          />
          <AiTelemetryBadge ai={(doc as any)?.metadata?.aiExtraction} />
          {/* Sprint 1.B — approval status badge. Sits above the
              primary actions so the operator sees the workflow
              state at a glance. Hidden when the doc is still NOVO
              (nothing to review / nothing to decide yet). */}
          {/* Fase 3 — validade fiscal (determinística) + ligação ao original quando duplicado */}
          {(doc.fiscalStatus || doc.status === 'DUPLICADO') && (
            <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
              {doc.fiscalStatus && (
                <span
                  className={
                    doc.fiscalStatus === 'FISCAL'
                      ? 'badge-emerald'
                      : doc.fiscalStatus === 'NAO_FISCAL'
                        ? 'badge-rose'
                        : 'badge-amber'
                  }
                  title={doc.fiscalReason ?? undefined}
                >
                  {doc.fiscalStatus === 'FISCAL'
                    ? 'Documento fiscal'
                    : doc.fiscalStatus === 'NAO_FISCAL'
                      ? 'Não fiscal — não vai ao TOC nem ao IVA'
                      : 'Validade fiscal por confirmar'}
                </span>
              )}
              {doc.status === 'DUPLICADO' && doc.duplicateOfId && (
                <a className="badge-rose underline" href={`/documents/${doc.duplicateOfId}`}>
                  Duplicado — ver original
                </a>
              )}
            </div>
          )}
          {doc.status !== 'NOVO' && doc.status !== 'EM_REVISAO' && (
            <div
              className="mb-4 inline-flex items-center gap-2 px-3 py-1.5 text-xs"
              style={{
                background:
                  doc.status === 'APROVADO' || doc.status === 'CONCILIADO' || doc.status === 'PAGO'
                    ? 'rgba(79, 121, 66, 0.10)'
                    : doc.status === 'REJEITADO' || doc.status === 'CHANGES_REQUESTED'
                    ? 'rgba(139, 46, 42, 0.10)'
                    : 'var(--ed-accent-gold-dim)',
                color:
                  doc.status === 'APROVADO' || doc.status === 'CONCILIADO' || doc.status === 'PAGO'
                    ? 'var(--ed-status-ok)'
                    : doc.status === 'REJEITADO' || doc.status === 'CHANGES_REQUESTED'
                    ? 'var(--ed-status-alert)'
                    : 'var(--ed-accent-gold)',
                borderRadius: 'var(--ed-radius-chip)',
                fontFamily: 'var(--font-editorial), ui-serif, Georgia, serif',
                letterSpacing: '0.06em',
              }}
              data-testid="approval-status-badge"
              data-status={doc.status}
            >
              <ShieldCheck size={14} aria-hidden="true" />
              <span className="font-medium uppercase">{doc.status.replace(/_/g, ' ')}</span>
              {currentApproval && (doc.status as string) === 'PENDING_APPROVAL' && (
                <span className="text-[10px]" style={{ color: 'var(--ed-ink-faint)' }}>
                  · pedido #{currentApproval.id.slice(0, 6)}
                </span>
              )}
            </div>
          )}

          {/* Primary actions — pinned at the top of the right column */}
          <div className="flex items-center justify-end gap-2 mb-8">
            {/* Sprint 1.B — "Solicitar aprovação" button. Visible when
                status===NOVO + supplierVerifiedAt is set. The backend
                enforces both checks again at 400/409. */}
            {!isApproved && doc.status === 'NOVO' && doc.supplierVerifiedAt && (
              <button
                type="button"
                onClick={() => requestApproval.mutate()}
                disabled={requestApproval.isPending}
                aria-busy={requestApproval.isPending}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-sm hover:opacity-70 transition-opacity disabled:opacity-50"
                style={{
                  background: 'transparent',
                  color: 'var(--ed-status-ok)',
                  border: '1px solid var(--ed-status-ok)',
                  borderRadius: 'var(--ed-radius-chip)',
                }}
                title="Submeter este documento para aprovação de um revisor"
                data-testid="approval-request-button"
              >
                <ShieldCheck size={14} aria-hidden="true" />
                {requestApproval.isPending ? 'A enviar…' : 'Solicitar aprovação'}
              </button>
            )}

            {/* Sprint 1.B — approver action group. Visible when the
                doc has a PENDING approval AND the caller is
                ADMIN/APPROVER AND is not the requester (self-decide
                guard mirrors the backend). The approve button
                fires immediately; reject/request-changes open a
                comment modal via the state below. */}
            {currentApproval && (user?.role === 'ADMIN' || user?.role === 'APPROVER') && currentApproval.requestedById !== user?.id && (
              <>
                <button
                  type="button"
                  onClick={() => decideApproval.mutate({ approvalId: currentApproval.id, action: 'approve' })}
                  disabled={decideApproval.isPending}
                  aria-busy={decideApproval.isPending}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-sm hover:opacity-70 transition-opacity disabled:opacity-50"
                  style={{
                    background: 'transparent',
                    color: 'var(--ed-status-ok)',
                    border: '1px solid var(--ed-status-ok)',
                    borderRadius: 'var(--ed-radius-chip)',
                  }}
                  data-testid="approval-decide-approve-button"
                >
                  <Check size={14} aria-hidden="true" />
                  {decideApproval.isPending ? 'A decidir…' : 'Aprovar'}
                </button>
                <button
                  type="button"
                  onClick={() => setPendingApprovalDecision({ approval: currentApproval, action: 'reject', comment: '' })}
                  disabled={decideApproval.isPending}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-sm hover:opacity-70 transition-opacity disabled:opacity-50"
                  style={{
                    background: 'transparent',
                    color: 'var(--ed-status-alert)',
                    border: '1px solid var(--ed-status-alert)',
                    borderRadius: 'var(--ed-radius-chip)',
                  }}
                  data-testid="approval-decide-reject-button"
                >
                  <XIcon size={14} aria-hidden="true" />
                  Rejeitar
                </button>
                <button
                  type="button"
                  onClick={() => setPendingApprovalDecision({ approval: currentApproval, action: 'request-changes', comment: '' })}
                  disabled={decideApproval.isPending}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-sm hover:opacity-70 transition-opacity disabled:opacity-50"
                  style={{
                    background: 'transparent',
                    color: 'var(--ed-ink-soft)',
                    border: '1px solid var(--ed-rule-strong)',
                    borderRadius: 'var(--ed-radius-chip)',
                  }}
                  data-testid="approval-decide-request-changes-button"
                >
                  <RefreshCw size={14} aria-hidden="true" />
                  Pedir mudanças
                </button>
              </>
            )}
            {!isApproved && (
              <button
                type="button"
                onClick={() => router.push(`/documents/${id}/review`)}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-sm hover:opacity-70 transition-opacity"
                style={{
                  background: 'transparent',
                  color: 'var(--ed-ink-soft)',
                  border: '1px solid var(--ed-rule-strong)',
                  borderRadius: 'var(--ed-radius-chip)',
                }}
                title="Abrir ecrã de revisão com confiança por campo"
                data-testid="review-link-button"
              >
                <FileSearch size={14} aria-hidden="true" />
                Revisar extração
              </button>
            )}
            {!isApproved && (
              <button
                type="button"
                onClick={onApprove}
                disabled={approve.isPending}
                aria-busy={approve.isPending}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium transition-all"
                style={{
                  background: 'var(--ed-accent-gold)',
                  color: 'var(--ed-ink)',
                  borderRadius: 'var(--ed-radius-chip)',
                }}
                title="Marcar este documento como aprovado"
              >
                <Check size={14} className={approve.isPending ? 'animate-spin' : ''} aria-hidden="true" />
                {approve.isPending ? 'A aprovar…' : 'Aprovar'}
              </button>
            )}
            <button
              type="button"
              onClick={onSave}
              disabled={saveFields.isPending || !draft}
              aria-busy={saveFields.isPending}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium transition-all disabled:opacity-50"
              style={{
                background: 'transparent',
                color: 'var(--ed-ink)',
                border: '1px solid var(--ed-rule-strong)',
                borderRadius: 'var(--ed-radius-chip)',
              }}
              title="Guardar alterações (⌘S)"
            >
              <Save size={14} aria-hidden="true" />
              {saveFields.isPending ? 'A guardar…' : 'Guardar'}
            </button>
            <button
              type="button"
              onClick={onReExtract}
              disabled={reExtract.isPending}
              aria-busy={reExtract.isPending}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-sm hover:opacity-70 transition-opacity disabled:opacity-50"
              style={{
                background: 'transparent',
                color: 'var(--ed-ink-soft)',
                borderRadius: 'var(--ed-radius-chip)',
              }}
              title="Re-extrair (Gemini Vision)"
            >
              <RefreshCw
                size={14}
                className={reExtract.isPending ? 'animate-spin' : ''}
                aria-hidden="true"
              />
              Re-extrair
            </button>
            <button
              type="button"
              onClick={() => setReExtractModalOpen(true)}
              disabled={reExtract.isPending}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm hover:opacity-70 transition-opacity disabled:opacity-50"
              style={{
                background: 'transparent',
                color: 'var(--ed-accent-gold, #0ea5e9)',
                borderRadius: 'var(--ed-radius-chip)',
              }}
              title="Escolher modelo específico para re-extração"
            >
              <Sparkles size={14} aria-hidden="true" />
              Re-extrair com...
            </button>
            <button
              type="button"
              onClick={() => setCorrectDialogOpen(true)}
              disabled={isApproved}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-sm hover:opacity-70 transition-opacity disabled:opacity-50"
              style={{
                background: 'transparent',
                color: 'var(--ed-ink-soft)',
                borderRadius: 'var(--ed-radius-chip)',
              }}
              title={
                isApproved
                  ? 'Documento aprovado — corrija antes de aprovar'
                  : 'Corrigir fornecedor / cliente extraído pela IA'
              }
            >
              <UserCheck size={14} aria-hidden="true" />
              Corrigir fornecedor
            </button>
            {canHardDelete && (
              <button
                type="button"
                onClick={() => setPendingHardDelete(true)}
                aria-label="Apagar documento permanentemente"
                data-testid="hard-delete-button"
                className="inline-flex items-center gap-1.5 px-4 py-2 text-sm hover:opacity-80 transition-opacity"
                style={{
                  background: 'transparent',
                  color: 'var(--ed-status-alert, #8b2e2a)',
                  border: '1px solid var(--ed-status-alert, #8b2e2a)',
                  borderRadius: 'var(--ed-radius-chip)',
                }}
                title="Apagar definitivamente (apenas ADMIN): remove o ficheiro, a linha na base de dados e cascata para itens + eventos de pagamento"
              >
                <Trash2 size={14} aria-hidden="true" />
                Apagar
              </button>
            )}
            <button
              type="button"
              onClick={() => setPendingSoftDelete(true)}
              data-testid="soft-delete-button"
              className="inline-flex items-center gap-1.5 px-4 py-2 text-sm hover:opacity-70 transition-opacity"
              style={{
                background: 'transparent',
                color: 'var(--ed-ink-soft)',
                border: '1px solid var(--ed-rule)',
                borderRadius: 'var(--ed-radius-chip)',
              }}
              title="Mover para a lixeira (reversível por ADMIN via /documents/trash)"
            >
              <Trash2 size={14} aria-hidden="true" />
              Mover para lixo
            </button>
          </div>

          {/* Fase 4.1 — natureza + categoria, tipo e validade fiscal.
              Antes não havia forma de escolher nem guardar nenhum destes. */}
          <ClassificationPanel
            documentType={(doc.type ?? 'OUTRO') as never}
            fiscalStatus={doc.fiscalStatus ?? null}
            fiscalReason={doc.fiscalReason ?? null}
            expenseCategoryId={doc.expenseCategoryId ?? null}
            expenseNature={doc.expenseNature ?? null}
            ivaDeductibilityPct={doc.ivaDeductibilityPct ?? null}
            typeManualOverride={doc.typeManualOverride}
            fiscalStatusManualOverride={doc.fiscalStatusManualOverride}
            saving={saveFields.isPending}
            onSave={(patch) =>
              saveFields.mutate(
                { id, patch: patch as never },
                {
                  onSuccess: () => {
                    qc.invalidateQueries({ queryKey: ['document-detail', id] });
                    qc.invalidateQueries({ queryKey: ['documents'] });
                    toastBus.success('Classificação guardada.');
                  },
                  onError: (err: any) => {
                    toastBus.error(err?.message ?? 'Falha ao guardar classificação.');
                  },
                },
              )
            }
          />

          <FieldPanel
            fields={effective ?? {}}
            confidence={doc.ocrConfidence ?? {}}
            lineItems={bundle.data.items}
            currency={doc.currency ?? 'EUR'}
            accounts={bundle.data.accounts}
            selectedDebitAccount={doc.debitAccount ?? ''}
            selectedCreditAccount={doc.creditAccount ?? ''}
            saving={saveFields.isPending}
            approved={isApproved}
            reExtracting={reExtract.isPending}
            sendingToToc={sendToToc.isPending}
            approving={approve.isPending}
            documentId={id}
            partyId={doc.partyId ?? null}
            canEditLines={canEditLines}
            addingLine={addLine.isPending}
            busyItemId={busyItemId}
            deletingItemId={deletingItemId}
            onFieldChange={onFieldChange}
            onAssignDebit={onAssignDebit}
            onAssignCredit={onAssignCredit}
            onReExtract={onReExtract}
            onApprove={onApprove}
            onSave={onSave}
            onSendToToc={onSendToToc}
            onAddLineItem={onAddLineItem}
            onUpdateLineItem={onUpdateLineItem}
            onDeleteLineItem={(itemId: string, description?: string) => onDeleteLineItem(itemId, description)}
            draftActive={draft !== null}
          />

          {/* ============================================================
              Sprint H+ Part 2.2 — Fornecedor block
              ============================================================
              Two surfaces for managing the supplier block on this doc:

              1. "Re-extrair com IA" — always visible. Refreshes the
                 supplier block via Gemini Vision (lighter than the
                 full re-extract on `reExtract`). When the operator has
                 already verified the supplier (supplierVerifiedAt set),
                 the click opens a confirmation modal that re-issues
                 the request with ?force=true.
              2. <SupplierManualEditSection> — inline form for manual
                 edits with client-side NIF mod-11 + IBAN mod-97
                 validation. POSTs to /supplier/update.
              ============================================================ */}
          <section
            aria-label="Bloco de fornecedor"
            className="mt-10 space-y-4"
            style={{ borderTop: '1px solid var(--ed-rule)', paddingTop: '32px' }}
          >
            <div className="flex items-center justify-between gap-3">
              <h3
                className="uppercase font-medium"
                style={{
                  fontFamily: 'var(--font-editorial), ui-serif, Georgia, serif',
                  fontSize: '13px',
                  letterSpacing: '0.14em',
                  color: 'var(--ed-ink-faint)',
                }}
              >
                Fornecedor
              </h3>
              <button
                type="button"
                onClick={onReExtractSupplierClick}
                disabled={reExtractSupplier.isPending || isApproved}
                aria-busy={reExtractSupplier.isPending}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm hover:opacity-70 transition-opacity disabled:opacity-50"
                style={{
                  background: 'transparent',
                  color: 'var(--ed-ink-soft)',
                  border: '1px solid var(--ed-rule-strong)',
                  borderRadius: 'var(--ed-radius-chip)',
                }}
                title={
                  doc.supplierVerifiedAt
                    ? 'Re-extrair fornecedor pela IA (sobrescreve dados verificados)'
                    : 'Re-extrair fornecedor pela IA (Gemini Vision)'
                }
                data-testid="supplier-re-extract-button"
              >
                <RefreshCw
                  size={14}
                  className={reExtractSupplier.isPending ? 'animate-spin' : ''}
                  aria-hidden="true"
                />
                {reExtractSupplier.isPending ? 'A re-extrair…' : 'Re-extrair com IA'}
              </button>
              {doc.partyId && (
                <button
                  type="button"
                  onClick={() => router.push(`/suppliers/${doc.partyId}`)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm hover:opacity-70 transition-opacity"
                  style={{
                    background: 'transparent',
                    color: 'var(--ed-ink-soft)',
                    border: '1px solid var(--ed-rule-strong)',
                    borderRadius: 'var(--ed-radius-chip)',
                  }}
                  data-testid="supplier-file-link-button"
                  title="Abrir a ficha completa do fornecedor (inclui Validar NIF)"
                >
                  <ExternalLink size={14} aria-hidden="true" />
                  Ficha do fornecedor
                </button>
              )}
            </div>

            <SupplierManualEditSection
              documentId={id}
              supplier={doc}
              disabled={isApproved}
            />
          </section>

          {/* Sprint 1.B — approval timeline. Full history; the
              latest PENDING row is already exposed via
              `currentApproval`. The widget collapses to a single
              "sem pedidos ainda" line when the history is empty. */}
          <section
            aria-label="Histórico de aprovações"
            className="mt-10 space-y-4"
            style={{ borderTop: '1px solid var(--ed-rule)', paddingTop: '32px' }}
          >
            <h3
              className="uppercase font-medium"
              style={{
                fontFamily: 'var(--font-editorial), ui-serif, Georgia, serif',
                fontSize: '13px',
                letterSpacing: '0.14em',
                color: 'var(--ed-ink-faint)',
              }}
            >
              Histórico de aprovações
            </h3>
            <ApprovalTimeline
              history={approvalHistoryQuery.data ?? []}
              loading={approvalHistoryQuery.isLoading}
            />
          </section>
        </section>
      </div>

      {/* DELETE line-item confirmation dialog. */}
      <Dialog
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        title="Eliminar linha?"
        description="Esta ação remove a linha permanentemente do documento."
        size="sm"
      >
        <div className="space-y-4">
          {pendingDelete?.description && (
            <p
              className="text-sm"
              style={{ color: 'var(--ed-ink-soft)' }}
            >
              Linha: <span className="font-medium" style={{ color: 'var(--ed-ink)' }}>{pendingDelete.description}</span>
            </p>
          )}
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setPendingDelete(null)}
              className="btn-secondary text-sm"
            >
              Cancelar
            </button>
            <button
              type="button"
              onClick={confirmDeleteLineItem}
              disabled={deletingItemId === pendingDelete?.itemId}
              aria-busy={deletingItemId === pendingDelete?.itemId}
              className="btn-danger text-sm"
            >
              {deletingItemId === pendingDelete?.itemId ? (
                <>
                  <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                  A eliminar…
                </>
              ) : (
                <>
                  <XIcon size={14} aria-hidden="true" />
                  Eliminar
                </>
              )}
            </button>
          </div>
        </div>
      </Dialog>

      {/* DELETE document (ADMIN-only destructive) confirmation dialog.
          The button in the primary actions row only opens this for ADMIN
          users; the server still enforces @Roles(Role.ADMIN) as a second
          line of defense so a stale token or UI bypass is rejected. */}
      <Dialog
        open={pendingHardDelete}
        onClose={() => setPendingHardDelete(false)}
        title="Apagar documento permanentemente?"
        description="Esta ação é irreversível. Remove o ficheiro, a linha na base de dados e cascata para itens + eventos de pagamento."
        size="sm"
      >
        <div className="space-y-4">
          <p
            className="text-sm"
            style={{ color: 'var(--ed-ink-soft)' }}
          >
            Documento:{' '}
            <span className="font-medium" style={{ color: 'var(--ed-ink)' }}>
              {doc.fileName ?? id}
            </span>
          </p>
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setPendingHardDelete(false)}
              className="btn-secondary text-sm"
            >
              Cancelar
            </button>
            <button
              type="button"
              onClick={confirmHardDelete}
              disabled={hardDelete.isPending}
              aria-busy={hardDelete.isPending}
              className="btn-danger text-sm"
            >
              {hardDelete.isPending ? (
                <>
                  <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                  A apagar…
                </>
              ) : (
                <>
                  <Trash2 size={14} aria-hidden="true" />
                  Apagar definitivamente
                </>
              )}
            </button>
          </div>
        </div>
      </Dialog>

      {/* SOFT DELETE (trash) confirmation. Reversible by an ADMIN via
          POST /documents/:id/restore on the /documents/trash page. */}
      <Dialog
        open={pendingSoftDelete}
        onClose={() => setPendingSoftDelete(false)}
        title="Mover documento para a lixeira?"
        description="O documento fica disponível na Lixeira. Um ADMIN pode restaurá-lo a partir de /documents/trash."
        size="sm"
      >
        <div className="space-y-4">
          <p
            className="text-sm"
            style={{ color: 'var(--ed-ink-soft)' }}
          >
            Documento:{' '}
            <span className="font-medium" style={{ color: 'var(--ed-ink)' }}>
              {doc.fileName ?? id}
            </span>
          </p>
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setPendingSoftDelete(false)}
              className="btn-secondary text-sm"
            >
              Cancelar
            </button>
            <button
              type="button"
              onClick={confirmSoftDelete}
              disabled={softDelete.isPending}
              aria-busy={softDelete.isPending}
              className="btn-primary text-sm"
            >
              {softDelete.isPending ? (
                <>
                  <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                  A mover…
                </>
              ) : (
                <>
                  <Trash2 size={14} aria-hidden="true" />
                  Mover para lixo
                </>
              )}
            </button>
          </div>
        </div>
      </Dialog>

      {/*
        Sprint H+ Part 2.2 — Overwrite confirmation modal.
        The "Re-extrair com IA" button routes here whenever the doc has
        a supplierVerifiedAt timestamp set. The positive button calls
        POST /documents/:id/supplier/re-extract?force=true and clears
        the verified timestamp server-side as part of the extraction.
      */}
      <Dialog
        open={pendingReExtract}
        onClose={reExtractSupplier.isPending ? () => undefined : () => setPendingReExtract(false)}
        title="Sobrescrever dados verificados pelo operador?"
        description="Este documento já foi verificado manualmente — a IA vai substituir os valores confirmados."
        size="sm"
      >
        <div className="space-y-4">
          <p
            className="text-sm"
            style={{ color: 'var(--ed-ink-soft)' }}
          >
            Fornecedor atual:{' '}
            <span className="font-medium" style={{ color: 'var(--ed-ink)' }}>
              {doc.supplier || '(sem nome)'}
            </span>
            {doc.supplierNif && (
              <>
                {' · '}
                <span
                  className="font-mono"
                  style={{ color: 'var(--ed-ink-faint)' }}
                >
                  NIF {doc.supplierNif}
                </span>
              </>
            )}
          </p>
          <p
            className="text-sm"
            style={{ color: 'var(--ed-ink-soft)' }}
          >
            A re-extração com IA corre o Gemini Vision apenas sobre o bloco de fornecedor (NIF, IBAN, país) e escreve um registo de auditoria antes de sobrescrever.
          </p>
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setPendingReExtract(false)}
              disabled={reExtractSupplier.isPending}
              className="btn-secondary text-sm"
            >
              Cancelar
            </button>
            <button
              type="button"
              onClick={confirmReExtractSupplier}
              disabled={reExtractSupplier.isPending}
              aria-busy={reExtractSupplier.isPending}
              className="btn-primary text-sm"
              style={{ background: 'var(--ed-status-alert)', color: '#fff' }}
            >
              {reExtractSupplier.isPending ? (
                <>
                  <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                  A sobrescrever…
                </>
              ) : (
                <>
                  <RefreshCw size={14} aria-hidden="true" />
                  Sobrescrever
                </>
              )}
            </button>
          </div>
        </div>
      </Dialog>

      {/*
        Manual supplier/customer correction dialog. The dialog lives at
        the page root so its lifecycle is decoupled from FieldPanel and
        the bundle can refetch in the background after the POST returns.
        On a successful save we clear the optimistic draft so the FieldPanel
        picks up the server-authoritative values on the next refetch.
      */}
      <CorrectSupplierDialog
        open={correctDialogOpen}
        documentId={id}
        initial={{
          supplier: doc.supplier,
          supplierNif: doc.supplierNif,
          iban: doc.iban,
          // customer / customerNif live on the backend Document row but
          // are not surfaced on the field panel; cast through `any` so we
          // don't widen the public type for the dialog alone.
          customer: (doc as any).customer ?? null,
          customerNif: (doc as any).customerNif ?? null,
          partyId: doc.partyId ?? null,
          partyName: null,
        }}
        onClose={() => setCorrectDialogOpen(false)}
        onSaved={() => {
          // Drop any unsaved field edits — the corrected values are the
          // canonical ones now, and the bundle refetch will repopulate.
          setDraft(null);
          qc.invalidateQueries({ queryKey: ['document-detail', id] });
        }}
      />

      {/* Sprint 1.B — reject / request-changes comment modal. The
          approve action does not need a dialog (comment optional);
          reject + request-changes require a non-empty comment that
          lands in the audit row. */}
      <Dialog
        open={pendingApprovalDecision !== null}
        onClose={() => {
          if (decideApproval.isPending) return;
          setPendingApprovalDecision(null);
        }}
        title={
          pendingApprovalDecision?.action === 'reject'
            ? 'Rejeitar pedido de aprovação'
            : 'Pedir mudanças'
        }
        description="O comentário é obrigatório e fica no histórico de auditoria."
        size="sm"
      >
        {pendingApprovalDecision && (
          <div className="space-y-4">
            <p className="text-sm" style={{ color: 'var(--ed-ink-soft)' }}>
              Pedido #{pendingApprovalDecision.approval.id.slice(0, 8)} —{' '}
              <span className="font-mono" style={{ color: 'var(--ed-ink)' }}>
                {doc.fileName ?? id}
              </span>
            </p>
            <textarea
              value={pendingApprovalDecision.comment}
              onChange={(e) =>
                setPendingApprovalDecision((prev) =>
                  prev ? { ...prev, comment: e.target.value } : prev,
                )
              }
              rows={4}
              maxLength={1000}
              placeholder={
                pendingApprovalDecision.action === 'reject'
                  ? 'Porquê que este pedido está a ser rejeitado…'
                  : 'Que mudanças são necessárias no documento…'
              }
              className="w-full px-2 py-1.5 text-sm border rounded"
              style={{
                borderColor: 'var(--ed-rule-strong)',
                background: 'var(--ed-card, #fff)',
                color: 'var(--ed-ink)',
              }}
              data-testid="approval-decide-comment-input"
              autoFocus
            />
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setPendingApprovalDecision(null)}
                disabled={decideApproval.isPending}
                className="btn-secondary text-sm"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={() => {
                  const trimmed = pendingApprovalDecision.comment.trim();
                  if (!trimmed) {
                    toastBus.error('O comentário é obrigatório.');
                    return;
                  }
                  decideApproval.mutate({
                    approvalId: pendingApprovalDecision.approval.id,
                    action: pendingApprovalDecision.action,
                    comment: trimmed,
                  });
                }}
                disabled={
                  decideApproval.isPending || pendingApprovalDecision.comment.trim().length === 0
                }
                aria-busy={decideApproval.isPending}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium transition-opacity disabled:opacity-50"
                style={{
                  background:
                    pendingApprovalDecision.action === 'reject'
                      ? 'var(--ed-status-alert)'
                      : 'var(--ed-accent-gold)',
                  color: pendingApprovalDecision.action === 'reject' ? '#fff' : 'var(--ed-ink)',
                  borderRadius: 'var(--ed-radius-chip)',
                }}
                data-testid="approval-decide-comment-submit"
              >
                {decideApproval.isPending ? (
                  <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                ) : pendingApprovalDecision.action === 'reject' ? (
                  <XIcon size={14} aria-hidden="true" />
                ) : (
                  <RefreshCw size={14} aria-hidden="true" />
                )}
                {decideApproval.isPending
                  ? 'A registar…'
                  : pendingApprovalDecision.action === 'reject'
                  ? 'Rejeitar'
                  : 'Pedir mudanças'}
              </button>
            </div>
          </div>
        )}
      </Dialog>

      <ReExtractDialog
        open={reExtractModalOpen}
        onClose={() => setReExtractModalOpen(false)}
        onConfirm={onReExtractWithOptions}
        loading={reExtract.isPending}
      />
    </div>
  );
}

/**
 * ApprovalTimeline — local presentation helper for the
 * approval-history widget. Self-contained so the rest of the
 * detail page does not need to know the shape.
 */
function ApprovalTimeline({
  history,
  loading,
}: {
  history: ApprovalListItem[];
  loading: boolean;
}) {
  if (loading) {
    return (
      <p className="text-xs" style={{ color: 'var(--ed-ink-faint)' }}>
        A carregar histórico…
      </p>
    );
  }
  if (history.length === 0) {
    return (
      <p className="text-xs" style={{ color: 'var(--ed-ink-faint)' }} data-testid="approval-timeline-empty">
        Sem pedidos de aprovação ainda.
      </p>
    );
  }
  return (
    <ol className="space-y-3" data-testid="approval-timeline">
      {history.map((row) => (
        <li
          key={row.id}
          className="flex items-start gap-3 text-sm"
          style={{ borderBottom: '1px solid var(--ed-rule)', paddingBottom: '12px' }}
          data-testid={`approval-timeline-row-${row.id}`}
        >
          <span
            className="inline-block w-2 h-2 rounded-full flex-shrink-0 mt-2"
            style={{
              background:
                row.status === 'APPROVED'
                  ? 'var(--ed-status-ok)'
                  : row.status === 'REJECTED'
                  ? 'var(--ed-status-alert)'
                  : row.status === 'PENDING'
                  ? 'var(--ed-accent-gold)'
                  : 'var(--ed-ink-faint)',
            }}
            aria-hidden="true"
          />
          <div className="flex-1 min-w-0">
            <div className="flex items-baseline gap-2">
              <span
                className="text-[11px] uppercase tracking-wider font-medium"
                style={{ color: 'var(--ed-ink-soft)' }}
              >
                {row.status.replace(/_/g, ' ')}
              </span>
              <span
                className="text-[11px]"
                style={{ color: 'var(--ed-ink-faint)' }}
              >
                · {row.createdAt ? new Date(row.createdAt).toLocaleString('pt-PT') : '—'}
              </span>
            </div>
            <p className="text-sm" style={{ color: 'var(--ed-ink)' }}>
              Solicitado por{' '}
              <span className="font-medium">
                {row.requestedByName ?? row.requestedById.slice(0, 8)}
              </span>
              {row.decidedByName && (
                <>
                  {' · decidido por '}
                  <span className="font-medium">{row.decidedByName}</span>
                  {row.decidedAt && (
                    <span className="text-[11px]" style={{ color: 'var(--ed-ink-faint)' }}>
                      {' '}em {row.decidedAt ? new Date(row.decidedAt).toLocaleString('pt-PT') : '—'}
                    </span>
                  )}
                </>
              )}
            </p>
            {row.comment && (
              <p
                className="mt-1 text-[13px] italic"
                style={{ color: 'var(--ed-ink-soft)' }}
              >
                “{row.comment}”
              </p>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}
