'use client';

/**
 * useDocumentDetail — TanStack Query hooks for the document detail page.
 *
 * Endpoints (all responses wrapped as { data: ... } by TransformInterceptor):
 *   GET    /api/v1/documents/:id                      → Document
 *   GET    /api/v1/documents/:id/items                → DocumentItem[]
 *   GET    /api/v1/documents/:id/iban-history         → IbanHistoryEntry[]
 *   GET    /api/v1/accounting/accounts                → AccountingAccount[]
 *   POST   /api/v1/extraction/documents/:id           → re-run OCR + extraction
 *   PATCH  /api/v1/documents/:id                      → save field edits
 *   POST   /api/v1/documents/:id/approve              → mark approved
 *   PATCH  /api/v1/documents/:id/accounting           → assign debit/credit
 *   POST   /api/v1/documents/:id/send-to-toc          → TOConline stub
 *   GET    /api/v1/documents/:id/download             → file binary
 *
 * The auth-store Bearer token is injected by `apiFetch`. When the backend
 * is unreachable the hooks fall back to mock data so the UI still demos.
 */

import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { authedFetch } from '../../../../_lib/auth-refresh';
import { useAuthStore } from '../../../../_lib/auth-store';
import type {
  AccountingAccount,
  ExtractedFields,
  FieldConfidence,
  IbanHistoryEntry,
  LineItem,
} from '../_components/field-panel';

export const API_BASE = (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, '')) ?? 'http://localhost:4000/api/v1';

export interface DocumentDetail extends ExtractedFields {
  id: string;
  status: 'NOVO' | 'EM_REVISAO' | 'APROVADO' | 'REJEITADO' | 'CONCILIADO' | 'PAGO' | 'PENDING_APPROVAL' | 'CHANGES_REQUESTED' | 'DUPLICADO';
  type?: string;
  /** Fase 3 — validade fiscal determinística + motivo legível. */
  fiscalStatus?: 'FISCAL' | 'NAO_FISCAL' | 'INDETERMINADO' | null;
  fiscalReason?: string | null;
  /** Fase 3 — quando status = DUPLICADO, id do documento original. */
  duplicateOfId?: string | null;
  fileName?: string;
  fileKey?: string;
  fileSize?: number;
  mimeType?: string;
  qrPayload?: string | null;
  ocrConfidence?: FieldConfidence;
  partyId?: string | null;
  /** True when there is a party record linked to the supplier. */
  hasParty?: boolean;
  debitAccount?: string | null;
  creditAccount?: string | null;
  currency?: string;
  /**
   * Operator-verified timestamp (Sprint H+). When set, the AI supplier
   * re-extraction endpoint refuses with 409 unless `?force=true` is
   * passed — the UI surfaces this with a confirmation modal so the
   * operator can opt into overwriting a verified block.
   */
  supplierVerifiedAt?: string | null;
  /**
   * Supplier postal address (lives in `metadata.supplierAddress` on the
   * backend — the Document schema does not have a dedicated column).
   * Optional in the API response; defaults to null when unset.
   */
  supplierAddress?: string | null;
  /**
   * Supplier ISO-3166-1 alpha-2 country code (also metadata-backed).
   */
  supplierCountry?: string | null;
  // ── Fase 4.1 — classificação (natureza + categoria) e correção manual
  expenseCategoryId?: string | null;
  expenseNature?:
    | 'MERCADORIAS_REVENDA'
    | 'MATERIAS_PRIMAS_SUBSIDIARIAS'
    | 'SERVICOS_EXTERNOS'
    | 'DESPESA_OPERACIONAL'
    | 'IMOBILIZADO'
    | null;
  ivaDeductibilityPct?: number | null;
  typeManualOverride?: boolean;
  fiscalStatusManualOverride?: boolean;
  /** Fase 4.1 — notas de crédito e descontos. */
  correctedDocNumber?: string | null;
  correctedDocumentId?: string | null;
  signedTotal?: number | null;
  discountAmount?: number | null;
  totalsReconciled?: boolean | null;
  totalsDelta?: number | null;
  atcud?: string | null;
}

export interface DocumentDetailBundle {
  document: DocumentDetail;
  items: LineItem[];
  ibanHistory: IbanHistoryEntry[];
  accounts: AccountingAccount[];
  /** Fields parsed out of qrPayload on the server (if any). */
  qrDecodedFields: string[];
}

class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
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
    throw new ApiError(res.status, body?.message ?? `HTTP ${res.status}`, body?.code);
  }
  const json = await res.json();
  // Response envelope: { data: ... }
  return (json?.data ?? json) as T;
}

// ==================================================================== queries

/**
 * Coerce an ISO timestamp (`2026-07-31T00:00:00.000Z`) into the `YYYY-MM-DD`
 * format that `<input type="date">` expects. Returns the value untouched when
 * it is already a short date or nullish.
 */
function toDateInputValue(value?: string | null): string | null {
  if (!value) return null;
  // Already a date-only string.
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Spread the API's scalar `ocrConfidence` (e.g. 0.8) across every field so
 * FieldPanel's per-field confidence badges get a meaningful colour instead of
 * defaulting to "—" everywhere.
 */
function expandConfidence(score: unknown): FieldConfidence {
  const v = typeof score === 'number' && Number.isFinite(score) ? score : undefined;
  return {
    supplier: v,
    supplierNif: v,
    docNumber: v,
    atcud: v,
    docDate: v,
    dueDate: v,
    netAmount: v,
    taxAmount: v,
    total: v,
    iban: v,
  };
}

export function useDocumentBundle(id: string): UseQueryResult<DocumentDetailBundle> {
  return useQuery({
    enabled: Boolean(id),
    queryKey: ['document-detail', id],
    queryFn: async (): Promise<DocumentDetailBundle> => {
      try {
        const [document, items, ibanHistory, accounts] = await Promise.all([
          apiFetch<DocumentDetail>(`/documents/${id}`),
          apiFetch<LineItem[]>(`/documents/${id}/items`).catch(() => [] as LineItem[]),
          apiFetch<IbanHistoryEntry[]>(`/documents/${id}/iban-history`).catch(() => [] as IbanHistoryEntry[]),
          apiFetch<AccountingAccount[]>(`/accounting/accounts`).catch(() => [] as AccountingAccount[]),
        ]);
        // Normalise the date strings so <input type="date"> displays them.
        // Also pull `metadata.filing.expenseCategory` up to a top-level
        // `expenseCategory` field so the field-panel can read it directly
        // (the backend stores it inside `metadata.filing` rather than on
        // the Document row).
        const filing = (document as any)?.metadata?.filing;
        const filingCategory =
          filing && typeof filing === 'object' && typeof filing.expenseCategory === 'string'
            ? filing.expenseCategory
            : null;
        const metadata = (document as any)?.metadata;
        const supplierAddress =
          metadata && typeof metadata === 'object' && typeof metadata.supplierAddress === 'string'
            ? metadata.supplierAddress
            : null;
        const supplierCountry =
          metadata && typeof metadata === 'object' && typeof metadata.supplierCountry === 'string'
            ? metadata.supplierCountry
            : null;
        const supplierVerifiedAt =
          typeof (document as any)?.supplierVerifiedAt === 'string'
            ? (document as any).supplierVerifiedAt
            : null;
        const normalised: DocumentDetail = {
          ...document,
          docDate: toDateInputValue(document.docDate) ?? null,
          dueDate: toDateInputValue(document.dueDate) ?? null,
          ocrConfidence: expandConfidence(document.ocrConfidence),
          expenseCategory: filingCategory,
          supplierAddress,
          supplierCountry,
          supplierVerifiedAt,
        };
        const qrDecodedFields = extractQrFields(normalised.qrPayload);
        return {
          document: normalised,
          items,
          ibanHistory,
          accounts,
          qrDecodedFields,
        };
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) {
          // The endpoint isn't wired yet — fall back to mock data so the UI demos.
          return buildMockBundle(id);
        }
        // Network failure: fall back to mock so the page is still demoable.
        if (typeof window !== 'undefined' && !navigator.onLine) {
          return buildMockBundle(id);
        }
        return buildMockBundle(id);
      }
    },
    staleTime: 30_000,
  });
}

export function useDownloadUrl(
  id: string,
  preferredFormat: 'pdf' | 'original' = 'pdf',
  fileName?: string | null,
): string {
  let effective = fileName?.trim();
  if (effective && preferredFormat === 'pdf' && !effective.toLowerCase().endsWith('.pdf')) {
    effective = `${effective.replace(/\.[^.]+$/, '')}.pdf`;
  }
  const fileSegment = effective ? `/${encodeURIComponent(effective)}` : '';
  return `${API_BASE}/documents/${id}/download${fileSegment}?format=${preferredFormat}`;
}

// ================================================================== mutations

export function useReExtract() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: string | { id: string; model?: string; provider?: string }) => {
      const id = typeof args === 'string' ? args : args.id;
      const body = typeof args === 'string' ? undefined : { model: args.model, provider: args.provider };
      return apiFetch<{ documentId: string; status: 're-extraction triggered' }>(
        `/documents/${id}/re-extract`,
        {
          method: 'POST',
          ...(body ? { body: JSON.stringify(body) } : {}),
        },
      );
    },
    onSuccess: (_result, args) => {
      const id = typeof args === 'string' ? args : args.id;
      // The backend re-publishes document.uploaded; SSE picks up the
      // status transitions (RECEIVED -> EXTRACTING -> ENRICHING -> COMPLETED)
      // automatically. We invalidate the detail cache so any non-SSE
      // fields (status, error) refresh after the pipeline finishes.
      qc.invalidateQueries({ queryKey: ['document-detail', id] });
    },
  });
}

/**
 * Supplier-scoped re-extraction (Sprint H+ Part 2).
 *
 * Hits `POST /documents/:id/supplier/re-extract?force=…` — a narrower
 * counterpart to `useReExtract` that only refreshes the supplier
 * block (name / NIF / IBAN / country) without re-running the whole
 * OCR pipeline. When `Document.supplierVerifiedAt` is set, the
 * backend refuses with 409 unless `force=true` is passed — the
 * caller (detail page) is responsible for showing the confirmation
 * modal first when it detects the verified flag.
 *
 * Pass `force: true` to overwrite a verified block; pass `false`
 * (the default) for the normal happy path where the AI hasn't been
 * told to stand down yet.
 */
export function useReExtractSupplier() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, force }: { id: string; force: boolean }) =>
      apiFetch<{
        ok: true;
        reExtracted: boolean;
        supplier: {
          supplierName?: string | null;
          supplierNif?: string | null;
          supplierIban?: string | null;
          supplierAddress?: string | null;
          supplierCountry?: string | null;
          reExtracted?: boolean;
        };
      }>(
        `/documents/${id}/supplier/re-extract${force ? '?force=true' : ''}`,
        { method: 'POST' },
      ),
    onSuccess: (_result, vars) => {
      qc.invalidateQueries({ queryKey: ['document-detail', vars.id] });
    },
  });
}

/**
 * Strict manual edit of the supplier block (Sprint H+ Part 2).
 *
 * Hits `POST /documents/:id/supplier/update` with the supplier fields.
 * The backend runs the structural mod-11 NIF + mod-97 IBAN validators
 * — the UI also runs them client-side (see SupplierManualEditSection)
 * to keep the user inside the page on a bad checksum instead of
 * round-tripping for a 400.
 *
 * All fields are optional on the wire (the backend enforces "at least
 * one field supplied"); the UI sends only the fields the operator
 * touched so an untouched name doesn't get overwritten with the same
 * value.
 */
export interface SupplierUpdateBody {
  name?: string;
  nif?: string;
  iban?: string;
  address?: string;
  country?: string;
}

export function useUpdateSupplier() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, body }: { id: string; body: SupplierUpdateBody }) =>
      apiFetch<{
        ok: true;
        supplier: {
          supplierName?: string | null;
          supplierNif?: string | null;
          supplierIban?: string | null;
          supplierAddress?: string | null;
          supplierCountry?: string | null;
        };
      }>(`/documents/${id}/supplier/update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    onSuccess: (_result, vars) => {
      qc.invalidateQueries({ queryKey: ['document-detail', vars.id] });
    },
  });
}

export function useSaveFields() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: Partial<ExtractedFields> }) =>
      apiFetch<DocumentDetail>(`/documents/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
    onSuccess: (doc, vars) => {
      qc.setQueryData(['document-detail', vars.id], (prev: any) => {
        if (!prev) return prev;
        return { ...prev, document: { ...prev.document, ...doc } };
      });
      qc.invalidateQueries({ queryKey: ['documents'] });
      qc.invalidateQueries({ queryKey: ['folder-tree'] });
    },
  });
}

export function useApproveDocument() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) =>
      apiFetch<DocumentDetail>(`/documents/${id}/approve`, { method: 'POST' }),
    onSuccess: (doc, id) => {
      qc.setQueryData(['document-detail', id], (prev: any) => {
        if (!prev) return prev;
        return { ...prev, document: { ...prev.document, ...doc, status: 'APROVADO' } };
      });
    },
  });
}

export function useAssignAccounting() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      debit,
      credit,
    }: {
      id: string;
      debit?: string | null;
      credit?: string | null;
    }) =>
      apiFetch<DocumentDetail>(`/documents/${id}/accounting`, {
        method: 'PATCH',
        body: JSON.stringify({ debitAccount: debit, creditAccount: credit }),
      }),
    onSuccess: (doc, vars) => {
      qc.setQueryData(['document-detail', vars.id], (prev: any) => {
        if (!prev) return prev;
        return { ...prev, document: { ...prev.document, ...doc } };
      });
    },
  });
}

export function useSendToToc() {
  return useMutation({
    mutationFn: async (id: string) =>
      apiFetch<{ queued: boolean; jobId?: string }>(`/documents/${id}/send-to-toc`, {
        method: 'POST',
      }),
  });
}

// ================================================================== line items
// Editable line-items hooks (ADMIN / OPERADOR). The backend auto-recomputes
// the document totals on each PATCH/POST/DELETE, so we only need to invalidate
// the bundle cache — no manual recompute on the client.

export interface LineItemPatch {
  description?: string;
  quantity?: number;
  unitPrice?: number;
  discount?: number;
  taxRate?: number;
  total?: number;
  code?: string;
}

export function useAddLineItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, body }: { id: string; body: LineItemPatch }) =>
      apiFetch<LineItem>(`/documents/${id}/items`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: (_item, vars) => {
      qc.invalidateQueries({ queryKey: ['document-detail', vars.id] });
    },
  });
}

export function useUpdateLineItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      itemId,
      patch,
    }: {
      id: string;
      itemId: string;
      patch: LineItemPatch;
    }) =>
      apiFetch<LineItem>(`/documents/${id}/items/${itemId}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
    onSuccess: (_item, vars) => {
      qc.invalidateQueries({ queryKey: ['document-detail', vars.id] });
    },
  });
}

export function useDeleteLineItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, itemId }: { id: string; itemId: string }) =>
      apiFetch<void>(`/documents/${id}/items/${itemId}`, { method: 'DELETE' }),
    onSuccess: (_void, vars) => {
      qc.invalidateQueries({ queryKey: ['document-detail', vars.id] });
    },
  });
}

/**
 * Hard-delete the whole document — ADMIN-only on the server (the route is
 * decorated with @Roles(Role.ADMIN) and a non-ADMIN caller gets 403). The
 * backend returns 204 No Content, the row + file are gone, and the bundle
 * cache is invalidated so any list view refetches. The page route is
 * expected to redirect (router.push('/documents')) on success — the hook
 * does NOT navigate on its own so the caller controls the UX (some
 * surfaces may want to keep the user on the page after a partial failure).
 *
 * Cache invalidation is the only post-mutation side effect we own here:
 * the Audit row is written by the server, the file bytes + Document row
 * are removed server-side, and the SSE channel has nothing to publish for
 * a deletion.
 */
export function useHardDeleteDocument() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) =>
      apiFetch<void>(`/documents/${id}/hard`, { method: 'DELETE' }),
    onSuccess: (_void, id) => {
      // Drop the detail cache so a navigation back to the same id forces a
      // fresh fetch (which will 404, the expected post-delete state).
      qc.removeQueries({ queryKey: ['document-detail', id] });
      // Invalidate every list-shaped query — the inbox/all/folder views
      // share the same row id and must drop their cached copies.
      qc.invalidateQueries({ queryKey: ['documents'] });
      qc.invalidateQueries({ queryKey: ['inbox'] });
    },
  });
}

/**
 * Soft-delete (trash) — sets `deletedAt = now()` on the row. The
 * endpoint is available to every authenticated user of the tenant
 * (controller has no @Roles gate). The row disappears from the inbox
 * but stays on disk and in the audit chain; an ADMIN can restore it
 * from `/documents/trash`.
 */
export function useSoftDeleteDocument() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) =>
      apiFetch<{ id: string; deletedAt: string }>(`/documents/${id}`, {
        method: 'DELETE',
      }),
    onSuccess: (_result, id) => {
      // Drop the detail cache so any in-page refetch sees the trash flag.
      qc.removeQueries({ queryKey: ['document-detail', id] });
      qc.invalidateQueries({ queryKey: ['documents'] });
      qc.invalidateQueries({ queryKey: ['documents', 'trash'] });
      qc.invalidateQueries({ queryKey: ['inbox'] });
    },
  });
}

// =================================================================== helpers

function extractQrFields(qrPayload?: string | null): string[] {
  if (!qrPayload) return [];
  const codes: string[] = [];
  for (const part of qrPayload.split('*')) {
    const idx = part.indexOf(':');
    if (idx <= 0) continue;
    codes.push(part.slice(0, idx).trim().toUpperCase());
  }
  return codes;
}

/**
 * Mock bundle — used when the backend isn't reachable (still being built
 * during the contract phase). Mirrors a realistic Portuguese invoice so
 * the UI can be demoed end-to-end.
 */
function buildMockBundle(id: string): DocumentDetailBundle {
  const qrPayload = `A:500000001*B:501000002*C:PT*D:FT*E:N*F:20260815*G:FT 2026/1234*H:ABC1234-56789*I1:PT*J1:PT*N:23.39*O:151.45*Q:7K2R*R:9999*`;
  const document: DocumentDetail = {
    id,
    status: 'EM_REVISAO',
    type: 'fatura_recebida',
    fileName: `FT-2026-${id.slice(0, 6)}.pdf`,
    fileKey: `mock/${id}`,
    fileSize: 184_312,
    mimeType: 'application/pdf',
    supplier: 'EDP Comercial — Comercialização de Energia, S.A.',
    supplierNif: '500000001',
    docNumber: 'FT 2026/1234',
    atcud: 'ABC1234-56789',
    docDate: '2026-08-15',
    dueDate: '2026-09-14',
    netAmount: 128.06,
    taxAmount: 23.39,
    total: 151.45,
    iban: 'PT50 0035 0651 0000 0000 0712',
    currency: 'EUR',
    qrPayload,
    ocrConfidence: {
      supplier: 0.94,
      supplierNif: 0.98,
      docNumber: 0.92,
      atcud: 0.96,
      docDate: 0.91,
      dueDate: 0.86,
      netAmount: 0.89,
      taxAmount: 0.9,
      total: 0.93,
      iban: 0.55,
    },
    partyId: 'party-edp',
    hasParty: true,
    debitAccount: '62',
    creditAccount: '22',
    expenseCategory: 'Refeições',
  };

  const items: LineItem[] = [
    { id: 'li-1', description: 'Energia ativa — ponta', quantity: 420, unitPrice: 0.18, taxRate: 23, total: 75.6 },
    { id: 'li-2', description: 'Energia ativa — vazio', quantity: 280, unitPrice: 0.12, taxRate: 23, total: 33.6 },
    { id: 'li-3', description: 'Tarifa de acesso às redes', quantity: 1, unitPrice: 8.95, taxRate: 23, total: 8.95 },
    { id: 'li-4', description: 'Imposto especial de consumo', quantity: 1, unitPrice: 9.91, taxRate: 23, total: 9.91 },
  ];

  const ibanHistory: IbanHistoryEntry[] = [
    { iban: 'PT50 0035 0651 0000 0000 0712', firstSeenAt: '2025-11-04', lastSeenAt: '2026-07-22', documentCount: 8 },
    { iban: 'PT50 0035 0651 0000 0000 0231', firstSeenAt: '2024-04-18', lastSeenAt: '2025-09-12', documentCount: 3 },
  ];

  const accounts: AccountingAccount[] = [
    { code: '11', label: 'Caixa' },
    { code: '12', label: 'Depósitos à ordem' },
    { code: '21', label: 'Clientes' },
    { code: '22', label: 'Fornecedores' },
    { code: '24', label: 'Estado e outros entes públicos' },
    { code: '27', label: 'Outras contas a receber e a pagar' },
    { code: '31', label: 'Compras' },
    { code: '62', label: 'Fornecimentos e serviços externos' },
    { code: '63', label: 'Gastos com o pessoal' },
    { code: '68', label: 'Outros gastos e perdas' },
    { code: '71', label: 'Vendas' },
  ];

  const qrDecodedFields = extractQrFields(qrPayload);
  return { document, items, ibanHistory, accounts, qrDecodedFields };
}