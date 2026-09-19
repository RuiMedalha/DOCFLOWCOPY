'use client';

/**
 * /documents/[id]/review — Sprint 1.A review screen.
 *
 * Renders one row per extracted field with a coloured confidence chip
 * (green / yellow / red / grey-indeterminate) and a per-validator
 * verdict icon (✓ for NIF mod-11, ✓ for IBAN mod-97). The header
 * carries the roll-up summary the brief asks for ("X/Y alta confiança
 * · 1 inválido · 1 pendente"); the footer carries the three primary
 * actions — Re-extrair com IA, Confirmar e arquivar (bulk confirm +
 * supplier-verified), Voltar.
 *
 * Per-field edits inline: each row has an "Editar" button that swaps
 * the value cell for an input. Submit calls
 * `PATCH /api/v1/documents/:id/confirm-field` which both writes the
 * value AND records a confirmation row (idempotent). The "Confirmar
 * e arquivar" footer button calls `POST /confirm-all` with the list
 * of fields the operator has reviewed.
 *
 * Editorial skin tokens (--ed-rule, --ed-accent-gold, --ed-status-ok,
 * --ed-status-warn, --ed-status-alert) keep the chips consistent with
 * the existing detail page; no new global tokens were added.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  AlertCircle,
  Loader2,
  Check as CheckIcon,
  X as XIcon,
  RefreshCw,
  Save,
  ShieldCheck,
  AlertTriangle,
  FileSearch,
} from 'lucide-react';
import { authedFetch } from '../../../../_lib/auth-refresh';
import { API_BASE } from '../_lib/use-document-detail';
import { toastBus } from '../../../../_components/ui';

// Local API wrapper. Mirrors the private `apiFetch` in
// `use-document-detail.ts` so the review screen does not need to
// import a hook from a sibling page just to read the JSON body.
// Strips the `{ data: ... }` envelope and throws an Error with the
// backend `message` on a non-2xx so the TanStack Query `error`
// surface stays useful for the UI.
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
      /* ignore — non-JSON error */
    }
    throw new ApiError(res.status, body?.message ?? `HTTP ${res.status}`);
  }
  const json = await res.json();
  return (json?.data ?? json) as T;
}

// ─── Types mirroring the backend DTO ────────────────────────────────────────

interface FieldConfidenceDto {
  value?: string | null;
  confidence?: number | null;
  valid?: boolean | null;
  confirmedAt?: string | null;
}

interface ConfidenceSummary {
  totalFields: number;
  highConfidence: number;
  mediumConfidence: number;
  lowConfidence: number;
  invalid: number;
  pending: number;
}

interface ExtractionConfidenceResponse {
  summary: ConfidenceSummary;
  supplierName?: FieldConfidenceDto;
  supplierNif?: FieldConfidenceDto;
  supplierIban?: FieldConfidenceDto;
  supplierAddress?: FieldConfidenceDto;
  supplierCountry?: FieldConfidenceDto;
  totalAmount?: FieldConfidenceDto;
  issueDate?: FieldConfidenceDto;
  dueDate?: FieldConfidenceDto;
  category?: FieldConfidenceDto;
  aiProvider?: string | null;
  aiModel?: string | null;
  ocrConfidence?: number | null;
  supplierVerifiedAt?: string | null;
}

type ReviewableField =
  | 'supplierName'
  | 'supplierNif'
  | 'supplierIban'
  | 'supplierAddress'
  | 'supplierCountry'
  | 'totalAmount'
  | 'issueDate'
  | 'dueDate'
  | 'category';

const FIELD_LABELS: Record<ReviewableField, { label: string; type: 'text' | 'date' | 'decimal' }> = {
  supplierName: { label: 'Nome do fornecedor', type: 'text' },
  supplierNif: { label: 'NIF do fornecedor', type: 'text' },
  supplierIban: { label: 'IBAN do fornecedor', type: 'text' },
  supplierAddress: { label: 'Morada do fornecedor', type: 'text' },
  supplierCountry: { label: 'País do fornecedor', type: 'text' },
  totalAmount: { label: 'Valor total', type: 'decimal' },
  issueDate: { label: 'Data de emissão', type: 'date' },
  dueDate: { label: 'Data de vencimento', type: 'date' },
  category: { label: 'Categoria de despesa', type: 'text' },
};

const REVIEWABLE_FIELDS: ReviewableField[] = [
  'supplierName',
  'supplierNif',
  'supplierIban',
  'supplierAddress',
  'supplierCountry',
  'totalAmount',
  'issueDate',
  'dueDate',
  'category',
];

// ─── API helpers ────────────────────────────────────────────────────────────

async function fetchExtractionConfidence(id: string): Promise<ExtractionConfidenceResponse> {
  return apiFetch<ExtractionConfidenceResponse>(
    `/documents/${id}/extraction-confidence`,
  );
}

async function patchConfirmField(
  id: string,
  field: ReviewableField,
  value: string | undefined,
): Promise<{ ok: true; field: string; confirmedAt: string }> {
  return apiFetch(`/documents/${id}/confirm-field`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ field, value }),
  });
}

async function postConfirmAll(
  id: string,
  confirmedFields: ReviewableField[],
): Promise<{ ok: true; verifiedAt: string; confirmedFields: string[] }> {
  return apiFetch(`/documents/${id}/confirm-all`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirmedFields }),
  });
}

async function postReExtract(id: string): Promise<{ documentId: string; status: string }> {
  return apiFetch(`/extraction/documents/${id}`, { method: 'POST' });
}

// ─── Pure helper for chip classification (mirrors backend thresholds) ──────

type ConfidenceBand = 'high' | 'medium' | 'low' | 'indeterminate';

function band(c: number | null | undefined): ConfidenceBand {
  if (c === null || c === undefined || Number.isNaN(c)) return 'indeterminate';
  if (c >= 0.85) return 'high';
  if (c >= 0.5) return 'medium';
  return 'low';
}

// ─── Component ──────────────────────────────────────────────────────────────

export default function DocumentReviewPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params?.id ?? '';
  const qc = useQueryClient();

  const confidenceQuery = useQuery({
    queryKey: ['extraction-confidence', id],
    queryFn: () => fetchExtractionConfidence(id),
    enabled: !!id,
  });

  // Local edit state — key = field name, value = the in-progress text.
  // Empty object means "no field is being edited right now".
  const [editing, setEditing] = useState<Partial<Record<ReviewableField, string>>>({});
  const [editingField, setEditingField] = useState<ReviewableField | null>(null);

  // Reset edit state when the underlying data changes (e.g. after a
  // successful PATCH / re-extract). Keeps the UI in sync.
  useEffect(() => {
    setEditing({});
    setEditingField(null);
  }, [confidenceQuery.data?.supplierVerifiedAt]);

  const confirmField = useMutation({
    mutationFn: ({ field, value }: { field: ReviewableField; value?: string }) =>
      patchConfirmField(id, field, value),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['extraction-confidence', id] });
      qc.invalidateQueries({ queryKey: ['document-detail', id] });
      setEditing({});
      setEditingField(null);
      toastBus.success('Campo confirmado.');
    },
    onError: (err: any) => {
      const msg = typeof err?.message === 'string' ? err.message : 'Falha ao confirmar campo.';
      toastBus.error(msg);
    },
  });

  const confirmAll = useMutation({
    mutationFn: (confirmedFields: ReviewableField[]) => postConfirmAll(id, confirmedFields),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['extraction-confidence', id] });
      qc.invalidateQueries({ queryKey: ['document-detail', id] });
      toastBus.success('Documento confirmado e arquivado.');
    },
    onError: (err: any) => {
      const msg = typeof err?.message === 'string' ? err.message : 'Falha ao confirmar documento.';
      toastBus.error(msg);
    },
  });

  const reExtract = useMutation({
    mutationFn: () => postReExtract(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['extraction-confidence', id] });
      qc.invalidateQueries({ queryKey: ['document-detail', id] });
      toastBus.success('Re-extração iniciada — processamento vai completar em segundos.');
    },
    onError: (err: any) => {
      const msg = typeof err?.message === 'string' ? err.message : 'Falha na re-extração.';
      toastBus.error(msg);
    },
  });

  const onEditStart = useCallback(
    (field: ReviewableField, current: string | null | undefined) => {
      setEditingField(field);
      setEditing({ [field]: current ?? '' });
    },
    [],
  );

  const onEditCancel = useCallback(() => {
    setEditingField(null);
    setEditing({});
  }, []);

  const onEditSubmit = useCallback(
    (field: ReviewableField) => {
      const draft = editing[field];
      // undefined → no edit (treated as confirmation with no value change).
      confirmField.mutate({ field, value: draft });
    },
    [editing, confirmField],
  );

  const onConfirmAll = useCallback(() => {
    // We pass the full list of fields the server considers reviewable,
    // regardless of which the operator actively edited. The
    // confirmation is a verb the operator applies to "all fields on
    // this page", which matches the brief's "Confirmar e arquivar"
    // CTA. Field-level edits (if any) were already written through
    // `PATCH /confirm-field` ahead of this call.
    confirmAll.mutate(REVIEWABLE_FIELDS);
  }, [confirmAll]);

  const onReExtract = useCallback(() => {
    reExtract.mutate();
  }, [reExtract]);

  // Field rows in render order. Memoised so the JSX does not allocate
  // per paint.
  const rows = useMemo(() => {
    if (!confidenceQuery.data) return [];
    const data = confidenceQuery.data;
    return REVIEWABLE_FIELDS.map((field) => {
      const entry = data[field];
      return {
        field,
        label: FIELD_LABELS[field].label,
        type: FIELD_LABELS[field].type,
        value: entry?.value ?? null,
        confidence: entry?.confidence ?? null,
        valid: entry?.valid ?? null,
        confirmedAt: entry?.confirmedAt ?? null,
        // NIF + IBAN get an extra "validator" icon; the rest do not.
        hasValidator: field === 'supplierNif' || field === 'supplierIban',
      };
    });
  }, [confidenceQuery.data]);

  if (confidenceQuery.isLoading) {
    return (
      <div data-skin="editorial" className="flex items-center justify-center py-24">
        <Loader2
          size={22}
          className="animate-spin"
          aria-hidden="true"
          style={{ color: 'var(--ed-accent-gold)' }}
        />
        <span className="ml-2 text-sm" style={{ color: 'var(--ed-ink-soft)' }}>
          A carregar confiança…
        </span>
      </div>
    );
  }

  if (confidenceQuery.isError || !confidenceQuery.data) {
    return (
      <div data-skin="editorial" className="p-8">
        <button
          type="button"
          onClick={() => router.push(`/documents/${id}`)}
          className="btn-secondary text-sm mb-4"
        >
          <ArrowLeft size={14} aria-hidden="true" />
          Voltar ao detalhe
        </button>
        <div className="card p-8 text-center">
          <AlertCircle
            size={32}
            className="mx-auto mb-2"
            aria-hidden="true"
            style={{ color: 'var(--ed-status-alert)' }}
          />
          <p className="text-sm" style={{ color: 'var(--ed-ink-soft)' }}>
            Não foi possível carregar a revisão deste documento.
          </p>
        </div>
      </div>
    );
  }

  const data = confidenceQuery.data;
  const summary = data.summary;

  return (
    <div data-skin="editorial" className="min-h-screen">
      {/* Header ────────────────────────────────────────────────────── */}
      <header
        className="border-b"
        style={{ borderColor: 'var(--ed-rule)' }}
      >
        <nav
          className="flex items-center justify-between gap-2 px-2 py-3 text-[12px] font-semibold uppercase tracking-wider"
          style={{ color: 'var(--ed-ink-faint)' }}
        >
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => router.push(`/documents/${id}`)}
              className="inline-flex items-center gap-1 hover:opacity-70 transition-opacity"
              style={{ color: 'var(--ed-ink-faint)' }}
            >
              <ArrowLeft size={12} aria-hidden="true" />
              Documento
            </button>
            <span aria-hidden="true" style={{ color: 'var(--ed-rule-strong)' }}>/</span>
            <span
              className="font-mono normal-case tracking-normal"
              style={{ color: 'var(--ed-ink-soft)' }}
            >
              Rever extração
            </span>
          </div>
          {(data.aiProvider || data.aiModel) && (
            <span style={{ color: 'var(--ed-ink-faint)' }}>
              Extraído por{' '}
              <span className="font-mono normal-case tracking-normal">
                {data.aiProvider}
                {data.aiModel ? ` · ${data.aiModel}` : ''}
              </span>
            </span>
          )}
        </nav>

        <div className="px-2 pt-6 pb-5">
          <h1
            className="font-mono font-bold leading-[1] tracking-tight"
            style={{
              fontSize: 'clamp(32px, 4vw, 44px)',
              color: 'var(--ed-ink)',
              letterSpacing: '-0.02em',
            }}
          >
            Rever extração
          </h1>
          <p className="mt-3 text-sm" style={{ color: 'var(--ed-ink-soft)' }}>
            Cada campo mostra o valor lido pela IA, a confiança devolvida
            pelo modelo e o verificador estrutural quando aplicável
            (NIF mod-11, IBAN mod-97).
          </p>
        </div>

        {/* Summary strip ─────────────────────────────────────────── */}
        <div
          className="flex flex-wrap items-center gap-x-6 gap-y-2 px-6 py-3 border-t text-sm"
          style={{
            borderColor: 'var(--ed-rule)',
            background: 'rgba(0, 0, 0, 0.015)',
          }}
        >
          <SummaryStat
            value={`${summary.highConfidence}/${summary.totalFields}`}
            label="alta confiança"
            tone="ok"
          />
          {summary.mediumConfidence > 0 && (
            <SummaryStat
              value={`${summary.mediumConfidence}`}
              label="rever"
              tone="warn"
            />
          )}
          {summary.lowConfidence > 0 && (
            <SummaryStat
              value={`${summary.lowConfidence}`}
              label="baixa"
              tone="alert"
            />
          )}
          {summary.invalid > 0 && (
            <SummaryStat
              value={`${summary.invalid}`}
              label="inválido(s)"
              tone="alert"
            />
          )}
          {summary.pending > 0 && (
            <SummaryStat
              value={`${summary.pending}`}
              label="pendente(s)"
              tone="warn"
            />
          )}
        </div>
      </header>

      {/* Body ─────────────────────────────────────────────────────── */}
      <div className="px-2 py-8 animate-ed-fade" style={{ padding: '32px 16px 64px' }}>
        <ul
          className="card divide-y"
          style={{ borderColor: 'var(--ed-rule)' }}
          data-testid="review-field-list"
        >
          {rows.map((row) => (
            <li
              key={row.field}
              className="px-4 py-3 grid grid-cols-1 md:grid-cols-[1fr_minmax(0,2fr)_auto_auto] items-center gap-3"
              data-testid={`review-row-${row.field}`}
            >
              <span
                className="text-[12px] uppercase tracking-wider font-medium"
                style={{
                  color: 'var(--ed-ink-faint)',
                  fontFamily: 'var(--font-editorial), ui-serif, Georgia, serif',
                  letterSpacing: '0.08em',
                }}
              >
                {row.label}
              </span>

              {/* Value cell — input when editing, plain text otherwise */}
              <div className="min-w-0">
                {editingField === row.field ? (
                  <input
                    type={row.type === 'date' ? 'date' : 'text'}
                    className="w-full px-2 py-1 text-sm border rounded"
                    style={{
                      borderColor: 'var(--ed-rule-strong)',
                      background: 'var(--ed-card, #fff)',
                      color: 'var(--ed-ink)',
                    }}
                    value={editing[row.field] ?? ''}
                    onChange={(e) =>
                      setEditing((prev) => ({ ...prev, [row.field]: e.target.value }))
                    }
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') onEditSubmit(row.field);
                      if (e.key === 'Escape') onEditCancel();
                    }}
                    autoFocus
                    data-testid={`review-input-${row.field}`}
                  />
                ) : (
                  <span
                    className="font-mono text-sm break-words"
                    style={{ color: row.value ? 'var(--ed-ink)' : 'var(--ed-ink-faint)' }}
                    data-testid={`review-value-${row.field}`}
                  >
                    {row.value || '(vazio)'}
                  </span>
                )}
                {row.confirmedAt && (
                  <span
                    className="block text-[11px] mt-0.5"
                    style={{ color: 'var(--ed-status-ok)' }}
                    data-testid={`review-confirmed-${row.field}`}
                  >
                    ✓ confirmado
                  </span>
                )}
              </div>

              {/* Confidence chip */}
              <ConfidenceChip
                band={band(row.confidence)}
                value={row.confidence}
              />

              {/* Validator + actions */}
              <div className="flex items-center gap-2">
                {row.hasValidator && (
                  <ValidatorIcon
                    label={row.field === 'supplierNif' ? 'NIF mod-11' : 'IBAN mod-97'}
                    valid={row.valid}
                  />
                )}
                {editingField === row.field ? (
                  <>
                    <button
                      type="button"
                      onClick={() => onEditSubmit(row.field)}
                      disabled={confirmField.isPending}
                      aria-busy={confirmField.isPending}
                      className="inline-flex items-center gap-1 px-2 py-1 text-xs hover:opacity-70 transition-opacity disabled:opacity-50"
                      style={{ color: 'var(--ed-status-ok)' }}
                      data-testid={`review-save-${row.field}`}
                    >
                      <Save size={12} aria-hidden="true" />
                      Guardar
                    </button>
                    <button
                      type="button"
                      onClick={onEditCancel}
                      className="inline-flex items-center gap-1 px-2 py-1 text-xs hover:opacity-70 transition-opacity"
                      style={{ color: 'var(--ed-ink-soft)' }}
                    >
                      Cancelar
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => onEditStart(row.field, row.value)}
                    className="inline-flex items-center gap-1 px-2 py-1 text-xs hover:opacity-70 transition-opacity"
                    style={{ color: 'var(--ed-ink-soft)' }}
                    data-testid={`review-edit-${row.field}`}
                  >
                    Editar
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>

        {/* Footer actions */}
        <div
          className="flex flex-wrap items-center justify-end gap-3 mt-8 pt-6 border-t"
          style={{ borderColor: 'var(--ed-rule)' }}
        >
          <button
            type="button"
            onClick={onReExtract}
            disabled={reExtract.isPending}
            aria-busy={reExtract.isPending}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-sm hover:opacity-70 transition-opacity disabled:opacity-50"
            style={{
              background: 'transparent',
              color: 'var(--ed-ink-soft)',
              border: '1px solid var(--ed-rule-strong)',
              borderRadius: 'var(--ed-radius-chip)',
            }}
            data-testid="review-reextract-button"
          >
            <RefreshCw
              size={14}
              className={reExtract.isPending ? 'animate-spin' : ''}
              aria-hidden="true"
            />
            {reExtract.isPending ? 'A re-extrair…' : 'Re-extrair com IA'}
          </button>
          <button
            type="button"
            onClick={() => router.push(`/documents/${id}`)}
            className="btn-secondary text-sm"
          >
            Voltar ao detalhe
          </button>
          <button
            type="button"
            onClick={onConfirmAll}
            disabled={confirmAll.isPending}
            aria-busy={confirmAll.isPending}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium transition-all disabled:opacity-50"
            style={{
              background: 'var(--ed-accent-gold)',
              color: 'var(--ed-ink)',
              borderRadius: 'var(--ed-radius-chip)',
            }}
            data-testid="review-confirm-all-button"
          >
            <ShieldCheck
              size={14}
              className={confirmAll.isPending ? 'animate-spin' : ''}
              aria-hidden="true"
            />
            {confirmAll.isPending ? 'A confirmar…' : 'Confirmar e arquivar'}
          </button>
        </div>

        {/* Provenance footer */}
        {(data.ocrConfidence !== null || data.supplierVerifiedAt) && (
          <p
            className="mt-4 text-[11px] text-right"
            style={{ color: 'var(--ed-ink-faint)' }}
          >
            {data.ocrConfidence !== null && data.ocrConfidence !== undefined && (
              <span>
                Confiança global: {Math.round(data.ocrConfidence * 100)}% ·{' '}
              </span>
            )}
            {data.supplierVerifiedAt ? (
              <span style={{ color: 'var(--ed-status-ok)' }}>
                fornecedor verificado em {data.supplierVerifiedAt ? new Date(data.supplierVerifiedAt).toLocaleString('pt-PT') : '—'}
              </span>
            ) : (
              <span style={{ color: 'var(--ed-ink-faint)' }}>
                fornecedor ainda não verificado
              </span>
            )}
          </p>
        )}
      </div>
    </div>
  );
}

// ─── Subcomponents ──────────────────────────────────────────────────────────

function SummaryStat({
  value,
  label,
  tone,
}: {
  value: string;
  label: string;
  tone: 'ok' | 'warn' | 'alert';
}) {
  const color =
    tone === 'ok'
      ? 'var(--ed-status-ok)'
      : tone === 'warn'
      ? 'var(--ed-accent-gold)'
      : 'var(--ed-status-alert)';
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span
        className="font-mono font-bold"
        style={{ color, fontSize: '18px' }}
        data-testid={`review-summary-${label.replace(/\s/g, '-')}`}
      >
        {value}
      </span>
      <span className="text-[12px]" style={{ color: 'var(--ed-ink-soft)' }}>
        {label}
      </span>
    </span>
  );
}

function ConfidenceChip({
  band,
  value,
}: {
  band: ConfidenceBand;
  value: number | null | undefined;
}) {
  const palette: Record<
    ConfidenceBand,
    { bg: string; color: string; label: string; Icon: typeof ShieldCheck }
  > = {
    high: {
      bg: 'rgba(79, 121, 66, 0.12)',
      color: 'var(--ed-status-ok)',
      label: 'alta',
      Icon: ShieldCheck,
    },
    medium: {
      bg: 'rgba(203, 166, 90, 0.18)',
      color: 'var(--ed-accent-gold)',
      label: 'rever',
      Icon: AlertTriangle,
    },
    low: {
      bg: 'rgba(139, 46, 42, 0.12)',
      color: 'var(--ed-status-alert)',
      label: 'baixa',
      Icon: AlertTriangle,
    },
    indeterminate: {
      bg: 'rgba(120, 120, 120, 0.10)',
      color: 'var(--ed-ink-faint)',
      label: 's/ score',
      Icon: FileSearch,
    },
  };
  const p = palette[band];
  const display =
    value !== null && value !== undefined
      ? `${Math.round(value * 100)}% · ${p.label}`
      : p.label;
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
      data-testid={`review-confidence-${band}`}
      data-band={band}
    >
      <p.Icon size={12} aria-hidden="true" />
      {display}
    </span>
  );
}

function ValidatorIcon({
  label,
  valid,
}: {
  label: string;
  valid: boolean | null | undefined;
}) {
  if (valid === null || valid === undefined) {
    return (
      <span
        className="inline-flex items-center gap-1 text-[11px]"
        style={{ color: 'var(--ed-ink-faint)' }}
        title={`${label}: sem validador aplicável`}
      >
        —
      </span>
    );
  }
  if (valid) {
    return (
      <span
        className="inline-flex items-center gap-1 text-[11px]"
        style={{ color: 'var(--ed-status-ok)' }}
        title={`${label}: válido`}
        data-testid={`review-validator-ok`}
      >
        <CheckIcon size={14} aria-hidden="true" /> {label}
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 text-[11px]"
      style={{ color: 'var(--ed-status-alert)' }}
      title={`${label}: inválido`}
      data-testid={`review-validator-fail`}
    >
      <XIcon size={14} aria-hidden="true" /> {label}
    </span>
  );
}
