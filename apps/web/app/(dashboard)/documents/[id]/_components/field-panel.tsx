'use client';

/**
 * FieldPanel — editable extracted-fields panel for DocFlow documents.
 *
 * Editorial / Contábil · Blueprint Edition (commit 2026-09-04).
 *
 * Layout restructure: 8 fieldsets empilhados → 3 GRUPOS HORIZONTAIS
 *   · "Identidade" (Fornecedor, NIF, Nº doc, ATCUD) — 2-col grid
 *   · "Calendário & Validação" (Data doc, Vencimento, IBAN) — 2-col grid
 *   · "Montantes" (Base, IVA, Total) — 3-col grid + reconciliation como
 *     diagrama de equação [Base] + [IVA] = [Total] em mono tabular com
 *     gold underline no Total.
 *
 * Separadores entre grupos: hairline 1px navy 0.12 opacity.
 * Headers de grupo em Fraunces 14px uppercase tracking-wide ink-faint.
 * Field primitive: label Inter Tight 11px uppercase tracking-wider
 *   ink-faint, input com border-bottom navy 0.12, focus border-bottom
 *   navy + accent-gold underline 2px. Conf badge: dot + percent mono
 *   tabular, cor baseada em threshold.
 *
 * Linhas table editorial: header small caps Fraunces 11px tracking-widest,
 *   cells JetBrains Mono 14px tabular-nums, tfoot gold com right-rule
 *   1px gold 0.3 opacity. DELETE agora chama o pai que abre um Dialog
 *   confirmando (risco real — ver page.tsx).
 *
 * Numbers are formatted with tabular-nums; dates use the user's locale
 * (defaults to pt-PT).
 */

import { useEffect, useMemo, useState } from 'react';
import { Send, CheckCircle2, Plus, X, Loader2, Trash2, ShieldCheck } from 'lucide-react';
import { useCategories } from '../../../categories/use-categories';
import { useParty, useVerifyIban } from '../../../parties/_components/use-parties';
import Link from 'next/link';

export interface ExtractedFields {
  fileName?: string | null;
  type?: string | null;
  supplier?: string | null;
  supplierNif?: string | null;
  customer?: string | null;
  customerNif?: string | null;
  docNumber?: string | null;
  atcud?: string | null;
  docDate?: string | null;
  dueDate?: string | null;
  netAmount?: number | null;
  taxAmount?: number | null;
  total?: number | null;
  iban?: string | null;
  currency?: string | null;
  /**
   * Resolved expense category (one of EXPENSE_CATEGORIES — PT bucket slug
   * like 'Refeições', 'Combustível', …). Persisted server-side in
   * `metadata.filing.expenseCategory` via PATCH /documents/:id. Surfaced
   * by useDocumentBundle from `document.metadata.filing.expenseCategory`.
   */
  expenseCategory?: string | null;
  /** Fase 4.2 (P0.3) — desconto global resolvido pelo backend (euros), incl. pronto pagamento derivado de cashDiscountRate. */
  discountAmount?: number | null;
  /** Fase 4.2 (P0.3) — true quando soma(linhas) − desconto global + IVA = total ao cêntimo. */
  totalsReconciled?: boolean | null;
  /** Fase 4.2 (P0.3) — diferença residual calculada pelo backend. */
  totalsDelta?: number | null;
  /** Tesouraria & Pagamento */
  paymentStatus?: 'DRAFT' | 'TO_PAY' | 'SCHEDULED' | 'PAID' | 'OVERDUE' | 'CANCELLED' | null;
  paymentMethod?: string | null;
  paymentDueDate?: string | null;
}

export interface FieldConfidence {
  supplier?: number;
  supplierNif?: number;
  docNumber?: number;
  atcud?: number;
  docDate?: number;
  dueDate?: number;
  netAmount?: number;
  taxAmount?: number;
  total?: number;
  iban?: number;
}

export interface AccountingAccount {
  code: string;
  label: string;
}

export interface LineItem {
  id: string;
  description: string;
  /** Product/service code when the document carries one (e.g. EAN, internal SKU). */
  code?: string | null;
  quantity: number;
  unitPrice: number;
  /** Per-line discount, resolved to a currency amount. Optional — many documents don't apply one. */
  discount?: number | null;
  /**
   * Fase 4.2 (P0.3) — percentagem quando a extração conseguiu confirmar
   * pela aritmética que o valor impresso na coluna era uma percentagem
   * (ex.: SAMMIC "Dto. 30,00" = 30%, não 30€). `discount` guarda sempre
   * o valor resolvido em euros; isto é só para a etiqueta correta.
   */
  discountPercent?: number | null;
  taxRate?: number;
  total: number;
}

/** Single IBAN ever seen for a supplier — used by the fraud-warning banner. */
export interface IbanHistoryEntry {
  iban: string;
  firstSeenAt: string;
  lastSeenAt?: string;
  documentCount: number;
}

export interface FieldPanelProps {
  fields: ExtractedFields;
  /** Sprint I — link to Party detail page (when supplier is linked). */
  partyId?: string | null;
  confidence: FieldConfidence;
  lineItems?: LineItem[];
  /** Currency display code — used in the totals row only. */
  currency?: string;
  /** Available accounting accounts, surfaced as native <select>s. */
  accounts?: AccountingAccount[];
  selectedDebitAccount?: string;
  selectedCreditAccount?: string;
  /** True while a PATCH is in flight. */
  saving?: boolean;
  /** True when the document has been approved (locks inputs). */
  approved?: boolean;
  /** True while a re-run extraction mutation is queued. */
  reExtracting?: boolean;
  /** True while sending to TOConline (stub). */
  sendingToToc?: boolean;
  /** True while the approve mutation is in flight. */
  approving?: boolean;
  /** True while the user has unsaved field edits (drives Save enable/disable). */
  draftActive?: boolean;

  // ── Line-items editing (ADMIN/OPERADOR only) ─────────────────────────
  /** Document id — used to scope the add/update/delete calls. */
  documentId?: string;
  /** True when the current user is allowed to edit line items. */
  canEditLines?: boolean;
  /** True while a POST /items is in flight (adds the spinner). */
  addingLine?: boolean;
  /** Id of the line item currently being PATCH-ed (disables that row's inputs). */
  busyItemId?: string | null;
  /** Id of the line item currently being DELETE-d (disables that row's delete button). */
  deletingItemId?: string | null;

  onFieldChange: (patch: Partial<ExtractedFields>) => void;
  onAssignDebit?: (code: string) => void;
  onAssignCredit?: (code: string) => void;
  onReExtract?: () => void;
  onApprove?: () => void;
  onSave?: () => void;
  onSendToToc?: () => void;
  /** Fired with a partial patch (e.g. { quantity: 3 }) on cell blur. */
  onUpdateLineItem?: (itemId: string, patch: Record<string, number | string | null>) => void;
  /** Fired by the "+ Adicionar linha" button. */
  onAddLineItem?: () => void;
  /**
   * Fired by the per-row X button. The parent owns the actual DELETE
   * lifecycle and shows a native ConfirmDialog — risk-on-button-click
   * is too easy to misfire, so the dialog mirrors the rest of the app.
   */
  onDeleteLineItem?: (itemId: string, description?: string) => void;
}

// ── Confidence badge — editorial tones (forest / mustard / wine / muted) ──
function confColor(c?: number): 'ok' | 'warn' | 'alert' | 'neutral' {
  if (c == null) return 'neutral';
  if (c >= 0.85) return 'ok';
  if (c >= 0.6) return 'warn';
  return 'alert';
}

function confBadge(c?: number) {
  const tone = confColor(c);
  const pct = c != null ? `${Math.round(c * 100)}%` : '—';
  const map = {
    ok: { dot: 'var(--ed-status-ok)', fg: 'var(--ed-status-ok)', bg: 'var(--ed-status-ok-dim)' },
    warn: { dot: 'var(--ed-status-warn)', fg: 'var(--ed-status-warn)', bg: 'var(--ed-status-warn-dim)' },
    alert: { dot: 'var(--ed-status-alert)', fg: 'var(--ed-status-alert)', bg: 'var(--ed-status-alert-dim)' },
    neutral: { dot: 'var(--ed-status-neutral)', fg: 'var(--ed-status-neutral)', bg: 'var(--ed-status-neutral-dim)' },
  } as const;
  const { dot, fg, bg } = map[tone];
  return (
    <span
      className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums"
      style={{ background: bg, color: fg, borderRadius: 'var(--ed-radius-chip)' }}
      title={`Confiança OCR ${pct}`}
    >
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: dot }} aria-hidden="true" />
      {pct}
    </span>
  );
}

const fmtMoney = (v?: number | null, ccy = 'EUR') =>
  v == null ? '—' : `${v.toLocaleString('pt-PT', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${ccy}`;

const fmtDate = (v?: string | null) => {
  if (!v) return '—';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toLocaleDateString('pt-PT');
};

/* ================================================================
   Group primitive — header Fraunces small-caps + hairline separator.
   Used to bracket the 3 horizontal groups (Identidade, Calendário,
   Montantes) without resorting to boxed cards.
   ================================================================ */
function Group({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <header
        className="flex items-center gap-3 pb-3 mb-6 border-b"
        style={{ borderColor: 'var(--ed-rule)' }}
      >
        <h3
          className="uppercase font-medium"
          style={{
            fontFamily: 'var(--font-editorial), ui-serif, Georgia, serif',
            fontSize: '14px',
            letterSpacing: '0.14em',
            color: 'var(--ed-ink-faint)',
          }}
        >
          {title}
        </h3>
        <span
          className="flex-1 h-px"
          style={{ background: 'var(--ed-rule-strong)' }}
          aria-hidden="true"
        />
      </header>
      {children}
    </section>
  );
}

/* ================================================================
   Field primitive — editorial underline input. Border-bottom navy
   0.12, focus border-bottom navy + accent-gold underline 2px.
   ================================================================ */
function Field({
  label,
  confidence,
  children,
  right,
  hint,
  hasValue = true,
}: {
  label: string;
  confidence?: number;
  children: React.ReactNode;
  right?: React.ReactNode;
  hint?: React.ReactNode;
  /**
   * Fase 4.2 (P1.4) — um campo vazio não tem confiança nenhuma. Um
   * badge "95%" ao lado de um placeholder com ar de dado real parecia
   * um valor extraído; era só o exemplo. Por omissão `true` (chamadores
   * antigos que não passam isto mantêm o comportamento de sempre); os
   * campos com placeholder passam explicitamente o valor real.
   */
  hasValue?: boolean;
}) {
  return (
    <div className="field-group">
      <div className="flex items-center justify-between mb-1.5">
        <label
          className="block uppercase font-medium"
          style={{
            fontFamily: 'var(--font-inter-tight), system-ui, sans-serif',
            fontSize: '11px',
            letterSpacing: '0.12em',
            color: 'var(--ed-ink-faint)',
          }}
        >
          {label}
        </label>
        <div className="flex items-center gap-1.5">
          {right && (
            <span
              className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] uppercase tracking-wider"
              style={{
                color: 'var(--ed-status-warn)',
                background: 'var(--ed-status-warn-dim)',
                borderRadius: 'var(--ed-radius-chip)',
              }}
            >
              {right}
            </span>
          )}
          {confidence !== undefined && hasValue && confBadge(confidence)}
        </div>
      </div>
      {children}
      {hint && (
        <p
          className="text-[10px] mt-1"
          style={{ color: 'var(--ed-ink-faint)' }}
        >
          {hint}
        </p>
      )}
    </div>
  );
}

/** Editorial underline input — replaces the boxed `.input`. */
function EdInput({
  className = '',
  mono = false,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & { mono?: boolean }) {
  return (
    <input
      {...props}
      className={`w-full bg-transparent transition-colors ${className}`}
      style={{
        color: 'var(--ed-ink)',
        fontFamily: mono ? '"JetBrains Mono", ui-monospace, monospace' : 'var(--font-inter-tight), system-ui, sans-serif',
        fontSize: '14px',
        border: 'none',
        borderBottom: '1px solid var(--ed-rule)',
        padding: '8px 0',
        outline: 'none',
        ...(props.style ?? {}),
      }}
      onFocus={(e) => {
        e.currentTarget.style.borderBottom = '2px solid var(--ed-accent-gold)';
        props.onFocus?.(e);
      }}
      onBlur={(e) => {
        e.currentTarget.style.borderBottom = '1px solid var(--ed-rule)';
        props.onBlur?.(e);
      }}
    />
  );
}

function EdSelect({
  children,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className="w-full bg-transparent transition-colors appearance-none"
      style={{
        color: 'var(--ed-ink)',
        fontFamily: 'var(--font-inter-tight), system-ui, sans-serif',
        fontSize: '14px',
        border: 'none',
        borderBottom: '1px solid var(--ed-rule)',
        padding: '8px 24px 8px 0',
        outline: 'none',
        backgroundImage:
          "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 10 10'%3E%3Cpath fill='%238a93a6' d='M5 7L1 3h8z'/%3E%3C/svg%3E\")",
        backgroundRepeat: 'no-repeat',
        backgroundPosition: 'right 4px center',
        ...(props.style ?? {}),
      }}
      onFocus={(e) => {
        e.currentTarget.style.borderBottom = '2px solid var(--ed-accent-gold)';
        props.onFocus?.(e);
      }}
      onBlur={(e) => {
        e.currentTarget.style.borderBottom = '1px solid var(--ed-rule)';
        props.onBlur?.(e);
      }}
    >
      {children}
    </select>
  );
}

function MoneyInput({
  value,
  onChange,
  ccy,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  ccy: string;
}) {
  return (
    <div className="relative">
      <input
        type="number"
        inputMode="decimal"
        step="0.01"
        className="w-full bg-transparent tabular-nums"
        style={{
          color: 'var(--ed-ink)',
          fontFamily: '"JetBrains Mono", ui-monospace, monospace',
          fontSize: '20px',
          fontWeight: 500,
          letterSpacing: '-0.01em',
          border: 'none',
          borderBottom: '1px solid var(--ed-rule)',
          padding: '8px 36px 8px 0',
          outline: 'none',
        }}
        value={value ?? ''}
        onChange={(e) => {
          const v = e.target.value;
          onChange(v === '' ? null : Number(v));
        }}
        placeholder="0,00"
        onFocus={(e) => {
          e.currentTarget.style.borderBottom = '2px solid var(--ed-accent-gold)';
        }}
        onBlur={(e) => {
          e.currentTarget.style.borderBottom = '1px solid var(--ed-rule)';
        }}
      />
      <span
        className="absolute right-1 top-1/2 -translate-y-1/2 text-[10px] uppercase tracking-wider pointer-events-none"
        style={{
          color: 'var(--ed-ink-faint)',
          fontFamily: '"JetBrains Mono", ui-monospace, monospace',
        }}
      >
        {ccy}
      </span>
    </div>
  );
}

/**
 * NumberCell — compact numeric input for the line-items table.
 * Local state holds the in-flight text so the user can type freely;
 * on blur we coerce to number and fire `onCommit` ONLY if it changed
 * (avoids spurious PATCH round-trips on focus shifts).
 */
function NumberCell({
  value,
  step,
  disabled,
  onCommit,
}: {
  value: number | null | undefined;
  step?: string;
  disabled?: boolean;
  onCommit: (v: number) => void;
}) {
  const [text, setText] = useState<string>(
    value == null || !Number.isFinite(value) ? '' : String(value),
  );
  useEffect(() => {
    setText(value == null || !Number.isFinite(value) ? '' : String(value));
  }, [value]);
  return (
    <input
      type="number"
      inputMode="decimal"
      step={step ?? '0.01'}
      className="bg-transparent tabular-nums text-right w-full max-w-[7rem] ml-auto outline-none"
      style={{
        color: 'var(--ed-ink)',
        fontFamily: '"JetBrains Mono", ui-monospace, monospace',
        fontSize: '14px',
        border: 'none',
        borderBottom: '1px solid transparent',
        padding: '4px 0',
      }}
      value={text}
      disabled={disabled}
      onChange={(e) => setText(e.target.value)}
      onFocus={(e) => {
        e.currentTarget.style.borderBottom = '1px solid var(--ed-accent-gold)';
      }}
      onBlur={(e) => {
        e.currentTarget.style.borderBottom = '1px solid transparent';
        if (text === '') return;
        const n = Number(text);
        if (!Number.isFinite(n)) {
          // Revert to the last good value.
          setText(value == null || !Number.isFinite(value) ? '' : String(value));
          return;
        }
        const current = value == null || !Number.isFinite(value) ? null : value;
        if (current === n) return;
        onCommit(n);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
        if (e.key === 'Escape') {
          setText(value == null || !Number.isFinite(value) ? '' : String(value));
          (e.currentTarget as HTMLInputElement).blur();
        }
      }}
    />
  );
}

/* ================================================================
   Main panel
   ================================================================ */

export function FieldPanel(props: FieldPanelProps) {
  const { fields, confidence, lineItems = [], currency = 'EUR' } = props;
  // Normalize the `accounts` prop. The /accounting/accounts stub may return
  // either a flat array or an envelope ({ items: [...] } / { data: [...] }
  // / { accounts: [...] }). Older Sprint-I code paths also passed the raw
  // envelope through, which crashed field-panel with
  // "TypeError: accounts.map is not a function" on the render of the debit
  // and credit account <select>s.
  const accountsList: AccountingAccount[] = useMemo(() => {
    const raw = props.accounts;
    if (Array.isArray(raw)) return raw;
    if (raw && typeof raw === 'object') {
      const envelope = raw as { items?: unknown; data?: unknown; accounts?: unknown };
      if (Array.isArray(envelope.items)) return envelope.items as AccountingAccount[];
      if (Array.isArray(envelope.data)) return envelope.data as AccountingAccount[];
      if (Array.isArray(envelope.accounts)) return envelope.accounts as AccountingAccount[];
    }
    return [];
  }, [props.accounts]);
  const accounts = accountsList;
  const { categories } = useCategories();
  // Resolve the selected category record so the header badge can show the
  // descriptive name + IVA deductibility percent (rather than the raw slug).
  const selectedCategory = useMemo(
    () => categories.find((c) => c.name === fields.expenseCategory) ?? null,
    [categories, fields.expenseCategory],
  );

  // Render-time date would mismatch between server and client; capture after mount.
  const [todayLabel, setTodayLabel] = useState<string>('');
  useEffect(() => {
    setTodayLabel(fmtDate(new Date().toISOString()));
  }, []);

  const partyQuery = useParty(props.partyId ?? '');
  const verifyIbanMutation = useVerifyIban();
  const party = partyQuery.data;
  const isIbanVerified =
    Boolean(party?.ibanVerified) &&
    Boolean(party?.iban) &&
    Boolean(fields.iban) &&
    party!.iban!.replace(/\s+/g, '').toUpperCase() === fields.iban!.replace(/\s+/g, '').toUpperCase();

  const handleVerifyIban = async () => {
    if (!props.partyId) return;
    try {
      await verifyIbanMutation.mutateAsync({
        id: props.partyId,
        reason: 'Validado diretamente a partir da fatura ' + (fields.docNumber ?? ''),
      });
    } catch {
      // handled by query client
    }
  };

  const lineSum = useMemo(
    () => lineItems.reduce((acc, li) => acc + (Number.isFinite(li.total) ? li.total : 0), 0),
    [lineItems],
  );

  // Sum of per-line discounts (currency). Optional column — only counts when set.
  const lineDiscountTotal = useMemo(
    () =>
      lineItems.reduce(
        (acc, li) => acc + (Number.isFinite(li.discount as number) ? (li.discount as number) : 0),
        0,
      ),
    [lineItems],
  );

  const hasDiscount = lineItems.some(
    (li) =>
      (Number.isFinite(li.discount as number) && (li.discount as number) > 0) ||
      Number.isFinite(li.discountPercent as number),
  );
  const hasCode = lineItems.some((li) => li.code != null && String(li.code).trim() !== '');

  const netAmount = fields.netAmount ?? 0;
  const taxAmount = fields.taxAmount ?? 0;
  const totalAmount = fields.total ?? 0;
  const netVatTotal = netAmount + taxAmount;
  // Fase 4.2 (P0.3) — quando o backend já reconciliou os totais
  // (soma linhas − desconto global + IVA = total), usamos o veredicto
  // dele em vez de recalcular ingenuamente no frontend. O recálculo
  // ingénuo (`totalAmount - lineSum`) ignora qualquer desconto global
  // e mostrava a SAMMIC como "diferença de 0,81" quando é exactamente
  // o desconto de pronto pagamento, já resolvido pelo backend.
  const backendReconciled = fields.totalsReconciled;
  const totalDelta =
    backendReconciled != null && fields.totalsDelta != null
      ? fields.totalsDelta
      : totalAmount - lineSum;
  const deltaMatch = backendReconciled != null ? backendReconciled : Math.abs(totalDelta) <= 0.005;

  return (
    <div className="space-y-12">
      {/* === Category badge (só se houver) ============================== */}
      {(fields.expenseCategory || props.approved) && (
        <div className="flex items-center gap-2 flex-wrap">
          {selectedCategory && (
            <span
              className="inline-flex items-center gap-1 px-2 py-1 text-[11px] uppercase tracking-wider"
              style={{
                fontFamily: 'var(--font-inter-tight), system-ui, sans-serif',
                background: 'var(--ed-canvas-2)',
                color: 'var(--ed-ink)',
                borderRadius: 'var(--ed-radius-chip)',
              }}
              title={
                selectedCategory.defaultIvaDeductibilityPct != null
                  ? `Dedução IVA ${selectedCategory.defaultIvaDeductibilityPct}%`
                  : `Categoria: ${selectedCategory.name}`
              }
            >
              <span
                className="inline-block w-1.5 h-1.5 rounded-full"
                style={{ background: selectedCategory.color ?? 'var(--ed-accent-gold)' }}
                aria-hidden="true"
              />
              {selectedCategory.name}
              {selectedCategory.defaultIvaDeductibilityPct != null && (
                <span className="tabular-nums" style={{ color: 'var(--ed-ink-faint)' }}>
                  {' '}— dedução {selectedCategory.defaultIvaDeductibilityPct}%
                </span>
              )}
            </span>
          )}
          {props.approved && (
            <span
              className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] uppercase tracking-wider"
              style={{
                fontFamily: 'var(--font-inter-tight), system-ui, sans-serif',
                background: 'var(--ed-status-ok-dim)',
                color: 'var(--ed-status-ok)',
                borderRadius: 'var(--ed-radius-chip)',
              }}
            >
              <CheckCircle2 size={11} aria-hidden="true" />
              Aprovado
            </span>
          )}
          {props.draftActive && !props.approved && (
            <span
              className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] uppercase tracking-wider"
              style={{
                fontFamily: 'var(--font-inter-tight), system-ui, sans-serif',
                color: 'var(--ed-status-warn)',
                background: 'var(--ed-status-warn-dim)',
                borderRadius: 'var(--ed-radius-chip)',
              }}
              title="Tem alterações por guardar"
            >
              ● alterações por guardar
            </span>
          )}
        </div>
      )}

      {/* ================================================================
          GRUPO 1 — IDENTIDADE
          ================================================================ */}
      <Group title="Identidade">
        <fieldset disabled={props.approved} className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-6">
            <Field label="Tipo de Documento">
              <EdSelect
                value={fields.type ?? 'FATURA_RECEBIDA'}
                onChange={(e) => props.onFieldChange({ type: e.target.value })}
              >
                <option value="FATURA_RECEBIDA">Fatura de Fornecedor</option>
                <option value="FATURA_SIMPLIFICADA">Fatura Simplificada (FS / Talão)</option>
                <option value="RECIBO">Recibo / Fatura-Recibo</option>
                <option value="NOTA_CREDITO">Nota de Crédito</option>
                <option value="NOTA_DEBITO">Nota de Débito</option>
                <option value="ENCOMENDA">Confirmação de Encomenda</option>
                <option value="PROFORMA">Fatura Proforma</option>
                <option value="ORCAMENTO">Orçamento</option>
                <option value="GUIA_TRANSPORTE">Guia de Transporte</option>
                <option value="AVISO_PAGAMENTO">Aviso de Pagamento</option>
                <option value="EXTRATO_FORNECEDOR">Extrato de Conta</option>
                <option value="OUTRO">Outro Documento</option>
              </EdSelect>
            </Field>

            <Field label="Categoria da despesa">
              <EdSelect
                value={fields.expenseCategory ?? ''}
                onChange={(e) =>
                  props.onFieldChange({ expenseCategory: e.target.value || null })
                }
              >
                <option value="">— Selecionar —</option>
                {categories.map((c, idx) => (
                  <option key={c.id ?? `cat-${idx}`} value={c.name}>
                    {c.name}
                    {c.defaultIvaDeductibilityPct != null
                      ? ` — dedução ${c.defaultIvaDeductibilityPct}%`
                      : ''}
                  </option>
                ))}
              </EdSelect>
            </Field>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-6">
            <Field label="Fornecedor / Emitente" confidence={confidence.supplier} hasValue={Boolean(fields.supplier)}>
              <EdInput
                type="text"
                value={fields.supplier ?? ''}
                onChange={(e) => props.onFieldChange({ supplier: e.target.value })}
                placeholder="Nome do emitente"
              />
            </Field>

            <Field label="NIF do Fornecedor" confidence={confidence.supplierNif} hasValue={Boolean(fields.supplierNif)}>
              <EdInput
                type="text"
                mono
                maxLength={20}
                value={fields.supplierNif ?? ''}
                onChange={(e) => props.onFieldChange({ supplierNif: e.target.value })}
                placeholder="NIF / NIPC do fornecedor"
              />
            </Field>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-6">
            <Field label="Cliente / Destinatário" hasValue={Boolean(fields.customer)}>
              <EdInput
                type="text"
                value={fields.customer ?? ''}
                onChange={(e) => props.onFieldChange({ customer: e.target.value })}
                placeholder="Nome do cliente (nossa empresa)"
              />
            </Field>

            <Field label="NIF do Cliente" hasValue={Boolean(fields.customerNif)}>
              <EdInput
                type="text"
                mono
                maxLength={20}
                value={fields.customerNif ?? ''}
                onChange={(e) => props.onFieldChange({ customerNif: e.target.value })}
                placeholder="NIF do cliente (515208566)"
              />
            </Field>
          </div>

          {props.partyId ? (
            <div className="mt-1 mb-2">
              <Link
                href={`/parties/${props.partyId}`}
                className="text-xs underline inline-flex items-center gap-1"
                style={{ color: 'var(--accent)' }}
              >
                Ver ficha completa do fornecedor →
              </Link>
            </div>
          ) : null}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-6">
            <Field label="Nº documento" confidence={confidence.docNumber} hasValue={Boolean(fields.docNumber)}>
              <EdInput
                type="text"
                mono
                value={fields.docNumber ?? ''}
                onChange={(e) => props.onFieldChange({ docNumber: e.target.value })}
                placeholder="por preencher"
              />
            </Field>
            <Field label="ATCUD" confidence={confidence.atcud} hasValue={Boolean(fields.atcud)}>
              <EdInput
                type="text"
                mono
                value={fields.atcud ?? ''}
                onChange={(e) => props.onFieldChange({ atcud: e.target.value })}
                placeholder="por preencher"
              />
            </Field>
          </div>

          <div className="grid grid-cols-1 gap-y-6">
            <Field label="Nome do Ficheiro" hasValue={Boolean(fields.fileName)}>
              <EdInput
                type="text"
                mono
                value={fields.fileName ?? ''}
                onChange={(e) => props.onFieldChange({ fileName: e.target.value })}
                placeholder="ex: FORNECEDOR_2026-05-12_FT123.pdf"
              />
            </Field>
          </div>
        </fieldset>
      </Group>

      {/* ================================================================
          GRUPO 2 — CALENDÁRIO & VALIDAÇÃO
          ================================================================ */}
      <Group title="Calendário & Validação">
        <fieldset disabled={props.approved} className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-6">
            <Field label="Data do documento" confidence={confidence.docDate} hasValue={Boolean(fields.docDate)}>
              <EdInput
                type="date"
                value={fields.docDate ? fields.docDate.slice(0, 10) : ''}
                onChange={(e) => props.onFieldChange({ docDate: e.target.value })}
              />
            </Field>
            <Field label="Vencimento" confidence={confidence.dueDate} hasValue={Boolean(fields.dueDate)}>
              <EdInput
                type="date"
                value={fields.dueDate ? fields.dueDate.slice(0, 10) : ''}
                onChange={(e) => props.onFieldChange({ dueDate: e.target.value })}
              />
            </Field>
          </div>
          <Field
            label="IBAN"
            confidence={confidence.iban}
            hasValue={Boolean(fields.iban)}
            right={todayLabel ? `hoje · ${todayLabel}` : undefined}
            hint="IBAN destinatário — verificar com o histórico do fornecedor antes de pagar."
          >
            <div className="space-y-2">
              <EdInput
                type="text"
                mono
                value={fields.iban ?? ''}
                onChange={(e) => props.onFieldChange({ iban: e.target.value.toUpperCase() })}
                placeholder="por preencher"
              />
              {fields.iban && props.partyId ? (
                <div className="flex items-center gap-2 pt-1">
                  {isIbanVerified ? (
                    <span className="badge-emerald inline-flex items-center gap-1.5 text-xs py-1 px-2.5">
                      <ShieldCheck size={14} className="text-emerald-500" />
                      NIB / IBAN Verificado e Seguro
                    </span>
                  ) : (
                    <button
                      type="button"
                      disabled={verifyIbanMutation.isPending}
                      onClick={handleVerifyIban}
                      className="btn btn-secondary text-xs inline-flex items-center gap-1.5 py-1 px-2.5 hover:bg-emerald-50 hover:text-emerald-700 hover:border-emerald-300"
                      title="Marca o NIB/IBAN como fidedigno e confirmado"
                    >
                      {verifyIbanMutation.isPending ? (
                        <Loader2 size={13} className="animate-spin" />
                      ) : (
                        <ShieldCheck size={13} className="text-emerald-600" />
                      )}
                      Confirmar NIB como Correto
                    </button>
                  )}
                </div>
              ) : null}
            </div>
          </Field>
        </fieldset>
      </Group>

      {/* ================================================================
          GRUPO 2.5 — TESOURARIA & PAGAMENTO
          ================================================================ */}
      <Group title="Tesouraria & Pagamento">
        <fieldset disabled={props.approved} className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-6">
            <Field label="Estado do Pagamento">
              <EdSelect
                value={fields.paymentStatus ?? 'TO_PAY'}
                onChange={(e) => props.onFieldChange({ paymentStatus: e.target.value as any })}
              >
                <option value="TO_PAY">A Pagar (Pendente)</option>
                <option value="PAID">✓ Paga (Liquidada)</option>
                <option value="SCHEDULED">Agendada</option>
                <option value="OVERDUE">Vencida</option>
                <option value="DRAFT">Rascunho</option>
              </EdSelect>
            </Field>

            <Field label="Forma de Pagamento">
              <EdSelect
                value={fields.paymentMethod ?? ''}
                onChange={(e) => props.onFieldChange({ paymentMethod: e.target.value })}
              >
                <option value="">— Selecionar método —</option>
                <option value="debito_direto">Débito Direto (SEPA DD)</option>
                <option value="transferencia">Transferência Bancária</option>
                <option value="multibanco">Referência Multibanco</option>
                <option value="cartao">Cartão de Crédito / Débito</option>
                <option value="dinheiro">Dinheiro / Pronto Pagamento</option>
                <option value="mbway">MBWay</option>
                <option value="outro">Outro</option>
              </EdSelect>
            </Field>
          </div>
        </fieldset>
      </Group>

      {/* ================================================================
          GRUPO 3 — MONTANTES (com reconciliation como equação)
          ================================================================ */}
      <Group title="Montantes">
        <fieldset disabled={props.approved} className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-x-8 gap-y-6">
            <Field label="Base" confidence={confidence.netAmount} hasValue={fields.netAmount != null}>
              <MoneyInput
                value={fields.netAmount ?? null}
                onChange={(v) => props.onFieldChange({ netAmount: v })}
                ccy={currency}
              />
            </Field>
            <Field label="IVA" confidence={confidence.taxAmount} hasValue={fields.taxAmount != null}>
              <MoneyInput
                value={fields.taxAmount ?? null}
                onChange={(v) => props.onFieldChange({ taxAmount: v })}
                ccy={currency}
              />
            </Field>
            <Field label="Total" confidence={confidence.total} hasValue={fields.total != null}>
              <MoneyInput
                value={fields.total ?? null}
                onChange={(v) => props.onFieldChange({ total: v })}
                ccy={currency}
              />
            </Field>
          </div>

          {/* Reconciliation footer — diagrama de equação.
              "Linhas: 128,06 EUR" + "IVA: 23,39 EUR" = "Total: 151,45 EUR" */}
          <div
            className="flex flex-wrap items-center justify-between gap-y-3 gap-x-6 px-5 py-4 mt-2"
            style={{
              background: 'var(--ed-canvas-2)',
              border: '1px solid var(--ed-rule)',
              borderRadius: 'var(--ed-radius-card)',
            }}
            aria-label="Reconciliação"
          >
            <div className="flex items-baseline gap-2 text-sm">
              <span
                className="uppercase tracking-wider"
                style={{
                  fontFamily: 'var(--font-inter-tight), system-ui, sans-serif',
                  fontSize: '10px',
                  color: 'var(--ed-ink-faint)',
                }}
              >
                Soma linhas
              </span>
              <span
                className="tabular-nums"
                style={{
                  fontFamily: '"JetBrains Mono", ui-monospace, monospace',
                  color: 'var(--ed-ink-soft)',
                }}
              >
                {fmtMoney(lineSum, currency)}
              </span>
            </div>
            <span
              aria-hidden="true"
              style={{
                color: 'var(--ed-accent-gold)',
                fontFamily: '"JetBrains Mono", ui-monospace, monospace',
                fontSize: '14px',
              }}
            >
              +
            </span>
            {/* Fase 4.2 (P0.3) — o desconto global (ex.: pronto pagamento)
                é uma linha própria da equação, não uma "diferença" por
                explicar. Só aparece quando a extração o resolveu. */}
            {Boolean(fields.discountAmount) && (
              <>
                <div className="flex items-baseline gap-2 text-sm">
                  <span
                    className="uppercase tracking-wider"
                    style={{
                      fontFamily: 'var(--font-inter-tight), system-ui, sans-serif',
                      fontSize: '10px',
                      color: 'var(--ed-ink-faint)',
                    }}
                  >
                    Desconto global
                  </span>
                  <span
                    className="tabular-nums"
                    style={{
                      fontFamily: '"JetBrains Mono", ui-monospace, monospace',
                      color: 'var(--ed-ink-soft)',
                    }}
                  >
                    − {fmtMoney(fields.discountAmount ?? 0, currency)}
                  </span>
                </div>
                <span
                  aria-hidden="true"
                  style={{
                    color: 'var(--ed-accent-gold)',
                    fontFamily: '"JetBrains Mono", ui-monospace, monospace',
                    fontSize: '14px',
                  }}
                >
                  +
                </span>
              </>
            )}
            <div className="flex items-baseline gap-2 text-sm">
              <span
                className="uppercase tracking-wider"
                style={{
                  fontFamily: 'var(--font-inter-tight), system-ui, sans-serif',
                  fontSize: '10px',
                  color: 'var(--ed-ink-faint)',
                }}
              >
                IVA
              </span>
              <span
                className="tabular-nums"
                style={{
                  fontFamily: '"JetBrains Mono", ui-monospace, monospace',
                  color: 'var(--ed-ink-soft)',
                }}
              >
                {fmtMoney(taxAmount, currency)}
              </span>
            </div>
            <span
              aria-hidden="true"
              style={{
                color: 'var(--ed-accent-gold)',
                fontFamily: '"JetBrains Mono", ui-monospace, monospace',
                fontSize: '14px',
              }}
            >
              =
            </span>
            <div className="flex items-baseline gap-2 text-sm ml-auto">
              <span
                className="uppercase tracking-wider"
                style={{
                  fontFamily: 'var(--font-inter-tight), system-ui, sans-serif',
                  fontSize: '10px',
                  color: 'var(--ed-ink-faint)',
                }}
              >
                Total
              </span>
              <span
                className="tabular-nums"
                style={{
                  fontFamily: '"JetBrains Mono", ui-monospace, monospace',
                  fontSize: '20px',
                  fontWeight: 600,
                  color: 'var(--ed-ink)',
                  borderBottom: '2px solid var(--ed-accent-gold)',
                  paddingBottom: '2px',
                }}
              >
                {fmtMoney(netVatTotal, currency)}
              </span>
            </div>
          </div>

          {/* Fase 4.2 (P0.3) — quando o backend já reconciliou (soma
              linhas − desconto global + IVA = total), mostramos o
              veredicto dele; sem isso, mantemos o recálculo simples de
              sempre. Nunca rotulamos um desconto global já explicado
              como "diferença". */}
          <p
            className="text-[11px] uppercase tracking-wider flex items-center gap-1.5"
            style={{ color: 'var(--ed-ink-faint)' }}
          >
            {backendReconciled != null ? 'Δ residual (após desconto global)' : 'Δ Total documento − soma linhas'}:
            <span
              className="tabular-nums"
              style={{
                color: deltaMatch ? 'var(--ed-accent-gold-strong)' : 'var(--ed-status-warn)',
                fontFamily: '"JetBrains Mono", ui-monospace, monospace',
                fontWeight: 600,
              }}
            >
              {fmtMoney(totalDelta, currency)}
            </span>
            {deltaMatch ? (
              <span style={{ color: 'var(--ed-status-ok)' }}>✓ confere</span>
            ) : (
              <span style={{ color: 'var(--ed-status-warn)' }}>diferença</span>
            )}
          </p>
        </fieldset>
      </Group>

      {/* ================================================================
          LINHAS DO DOCUMENTO (tabela editorial)
          ================================================================ */}
      {(lineItems.length > 0 || props.canEditLines) && (
        <section>
          <Group title={`Linhas do documento (${lineItems.length})`}>
            <div className="overflow-x-auto -mx-2 px-2">
              <table className="w-full">
                <thead>
                  <tr
                    style={{
                      color: 'var(--ed-ink-faint)',
                      borderBottom: '2px solid var(--ed-rule-strong)',
                    }}
                  >
                    <th
                      className="text-left pb-2 uppercase font-semibold"
                      style={{
                        fontFamily: 'var(--font-editorial), ui-serif, Georgia, serif',
                        fontSize: '11px',
                        letterSpacing: '0.14em',
                        color: 'var(--ed-ink-faint)',
                      }}
                    >
                      Descrição
                    </th>
                    {hasCode && (
                      <th
                        className="text-left pb-2 uppercase font-semibold"
                        style={{
                          fontFamily: 'var(--font-editorial), ui-serif, Georgia, serif',
                          fontSize: '11px',
                          letterSpacing: '0.14em',
                          color: 'var(--ed-ink-faint)',
                        }}
                      >
                        Cód.
                      </th>
                    )}
                    <th
                      className="text-right pb-2 uppercase tabular-nums font-semibold"
                      style={{
                        fontFamily: 'var(--font-editorial), ui-serif, Georgia, serif',
                        fontSize: '11px',
                        letterSpacing: '0.14em',
                        color: 'var(--ed-ink-faint)',
                      }}
                    >
                      Qtd.
                    </th>
                    <th
                      className="text-right pb-2 uppercase tabular-nums font-semibold"
                      style={{
                        fontFamily: 'var(--font-editorial), ui-serif, Georgia, serif',
                        fontSize: '11px',
                        letterSpacing: '0.14em',
                        color: 'var(--ed-ink-faint)',
                      }}
                    >
                      Preço un.
                    </th>
                    {hasDiscount && (
                      <th
                        className="text-right pb-2 uppercase tabular-nums font-semibold"
                        style={{
                          fontFamily: 'var(--font-editorial), ui-serif, Georgia, serif',
                          fontSize: '11px',
                          letterSpacing: '0.14em',
                          color: 'var(--ed-ink-faint)',
                        }}
                      >
                        Desc.
                      </th>
                    )}
                    <th
                      className="text-right pb-2 uppercase tabular-nums font-semibold"
                      style={{
                        fontFamily: 'var(--font-editorial), ui-serif, Georgia, serif',
                        fontSize: '11px',
                        letterSpacing: '0.14em',
                        color: 'var(--ed-ink-faint)',
                      }}
                    >
                      IVA
                    </th>
                    <th
                      className="text-right pb-2 uppercase tabular-nums font-semibold"
                      style={{
                        fontFamily: 'var(--font-editorial), ui-serif, Georgia, serif',
                        fontSize: '11px',
                        letterSpacing: '0.14em',
                        color: 'var(--ed-ink-faint)',
                      }}
                    >
                      Total
                    </th>
                    {props.canEditLines && !props.approved && (
                      <th className="w-8" aria-label="Ações" />
                    )}
                  </tr>
                </thead>
                <tbody>
                  {lineItems.map((li) => {
                    const editable = Boolean(
                      props.canEditLines &&
                        !props.approved &&
                        props.onUpdateLineItem,
                    );
                    const rowBusy = props.busyItemId === li.id;
                    return (
                      <tr
                        key={li.id}
                        style={{ borderTop: '1px solid var(--ed-rule)' }}
                      >
                        <td
                          className="py-2 pr-4"
                          style={{
                            color: 'var(--ed-ink)',
                            fontFamily: 'var(--font-inter-tight), system-ui, sans-serif',
                            fontSize: '14px',
                          }}
                        >
                          {editable && props.onUpdateLineItem ? (
                            <EdInput
                              type="text"
                              value={li.description}
                              disabled={rowBusy}
                              onChange={() => {
                                /* keep controlled via onBlur only */
                              }}
                              onBlur={(e) => {
                                const v = e.target.value.trim();
                                if (v && v !== li.description) {
                                  props.onUpdateLineItem!(li.id, { description: v });
                                }
                              }}
                            />
                          ) : (
                            <span>{li.description}</span>
                          )}
                        </td>
                        {hasCode && (
                          <td
                            className="py-2 pr-4"
                            style={{
                              color: 'var(--ed-ink-soft)',
                              fontFamily: '"JetBrains Mono", ui-monospace, monospace',
                              fontSize: '13px',
                            }}
                          >
                            {li.code ? (
                              <span
                                className="inline-block px-1.5 py-0.5"
                                style={{
                                  background: 'var(--ed-canvas-2)',
                                  borderRadius: 'var(--ed-radius-chip)',
                                  fontSize: '11px',
                                }}
                              >
                                {li.code}
                              </span>
                            ) : (
                              <span style={{ color: 'var(--ed-ink-faint)' }}>—</span>
                            )}
                          </td>
                        )}
                        <td
                          className="py-2 text-right tabular-nums"
                          style={{
                            color: 'var(--ed-ink-soft)',
                            fontFamily: '"JetBrains Mono", ui-monospace, monospace',
                            fontSize: '14px',
                          }}
                        >
                          {editable ? (
                            <NumberCell
                              value={li.quantity}
                              step="any"
                              disabled={rowBusy}
                              onCommit={(v) => props.onUpdateLineItem!(li.id, { quantity: v })}
                            />
                          ) : (
                            li.quantity != null ? li.quantity.toLocaleString('pt-PT') : '—'
                          )}
                        </td>
                        <td
                          className="py-2 text-right tabular-nums"
                          style={{
                            color: 'var(--ed-ink-soft)',
                            fontFamily: '"JetBrains Mono", ui-monospace, monospace',
                            fontSize: '14px',
                          }}
                        >
                          {editable ? (
                            <NumberCell
                              value={li.unitPrice}
                              step="0.01"
                              disabled={rowBusy}
                              onCommit={(v) => props.onUpdateLineItem!(li.id, { unitPrice: v })}
                            />
                          ) : (
                            fmtMoney(li.unitPrice, currency)
                          )}
                        </td>
                        {hasDiscount && (
                          <td
                            className="py-2 text-right tabular-nums"
                            style={{
                              color: 'var(--ed-ink-soft)',
                              fontFamily: '"JetBrains Mono", ui-monospace, monospace',
                              fontSize: '14px',
                            }}
                          >
                            {editable ? (
                              <NumberCell
                                value={li.discount as number}
                                step="0.01"
                                disabled={rowBusy}
                                onCommit={(v) => props.onUpdateLineItem!(li.id, { discount: v })}
                              />
                            ) : Number.isFinite(li.discountPercent as number) ? (
                              // Fase 4.2 (P0.3) — mostra a percentagem quando
                              // a extração a confirmou pela aritmética
                              // (nunca "30,00 EUR" para um desconto de 30%).
                              <span title={`= ${fmtMoney(li.discount as number, currency)}`}>
                                {(li.discountPercent as number).toLocaleString('pt-PT', { maximumFractionDigits: 2 })}%
                              </span>
                            ) : Number.isFinite(li.discount as number) ? (
                              fmtMoney(li.discount as number, currency)
                            ) : (
                              '—'
                            )}
                          </td>
                        )}
                        <td
                          className="py-2 text-right tabular-nums"
                          style={{
                            color: 'var(--ed-ink-soft)',
                            fontFamily: '"JetBrains Mono", ui-monospace, monospace',
                            fontSize: '14px',
                          }}
                        >
                          {editable ? (
                            <NumberCell
                              value={li.taxRate as number}
                              step="0.1"
                              disabled={rowBusy}
                              onCommit={(v) => props.onUpdateLineItem!(li.id, { taxRate: v })}
                            />
                          ) : (
                            li.taxRate != null ? `${li.taxRate}%` : '—'
                          )}
                        </td>
                        <td
                          className="py-2 text-right tabular-nums"
                          style={{
                            color: 'var(--ed-ink)',
                            fontFamily: '"JetBrains Mono", ui-monospace, monospace',
                            fontSize: '14px',
                            fontWeight: 600,
                          }}
                        >
                          {editable ? (
                            <NumberCell
                              value={li.total}
                              step="0.01"
                              disabled={rowBusy}
                              onCommit={(v) => props.onUpdateLineItem!(li.id, { total: v })}
                            />
                          ) : (
                            fmtMoney(li.total, currency)
                          )}
                        </td>
                        {props.canEditLines && !props.approved && (
                          <td className="py-2 pl-2">
                            {props.onDeleteLineItem && (
                              <button
                                type="button"
                                onClick={() => props.onDeleteLineItem!(li.id, li.description)}
                                disabled={rowBusy || props.deletingItemId === li.id}
                                aria-label={`Eliminar linha ${li.description}`}
                                title="Eliminar linha (abre diálogo de confirmação)"
                                className="inline-flex items-center justify-center w-7 h-7 transition-opacity hover:opacity-70"
                                style={{
                                  color: 'var(--ed-status-alert)',
                                  background: 'transparent',
                                  borderRadius: 'var(--ed-radius-chip)',
                                }}
                              >
                                {props.deletingItemId === li.id ? (
                                  <Loader2
                                    size={12}
                                    className="animate-spin"
                                    aria-hidden="true"
                                  />
                                ) : (
                                  <X size={14} aria-hidden="true" />
                                )}
                              </button>
                            )}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr style={{ borderTop: '2px solid var(--ed-rule-strong)' }}>
                    <td
                      colSpan={hasCode ? 2 : 1}
                      className="pt-3 pr-4 uppercase tracking-wider font-semibold"
                      style={{
                        fontFamily: 'var(--font-editorial), ui-serif, Georgia, serif',
                        fontSize: '11px',
                        letterSpacing: '0.14em',
                        color: 'var(--ed-ink-faint)',
                      }}
                    >
                      Totais
                    </td>
                    <td
                      className="pt-3 text-right tabular-nums"
                      style={{
                        color: 'var(--ed-ink-faint)',
                        fontFamily: '"JetBrains Mono", ui-monospace, monospace',
                        fontSize: '12px',
                      }}
                      aria-label="Quantidade total"
                    >
                      —
                    </td>
                    <td aria-hidden="true" />
                    {hasDiscount && (
                      <td
                        className="pt-3 text-right tabular-nums"
                        style={{
                          color: 'var(--ed-ink-soft)',
                          fontFamily: '"JetBrains Mono", ui-monospace, monospace',
                          fontSize: '13px',
                        }}
                        aria-label="Desconto total"
                      >
                        {lineDiscountTotal > 0
                          ? `− ${fmtMoney(lineDiscountTotal, currency)}`
                          : '—'}
                      </td>
                    )}
                    <td aria-hidden="true" />
                    <td
                      className="pt-3 text-right tabular-nums"
                      style={{
                        color: 'var(--ed-accent-gold-strong)',
                        fontFamily: '"JetBrains Mono", ui-monospace, monospace',
                        fontSize: '16px',
                        fontWeight: 500,
                        borderRight: '1px solid rgba(203, 166, 90, 0.3)',
                      }}
                      aria-label="Total documento"
                    >
                      {fmtMoney(lineSum, currency)}
                    </td>
                    {props.canEditLines && !props.approved && (
                      <td aria-hidden="true" />
                    )}
                  </tr>
                </tfoot>
              </table>
            </div>

            {props.canEditLines && !props.approved && props.onAddLineItem && (
              <div className="mt-4 flex justify-end">
                <button
                  type="button"
                  onClick={props.onAddLineItem}
                  disabled={props.addingLine}
                  aria-busy={props.addingLine}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm hover:opacity-70 transition-opacity disabled:opacity-50"
                  style={{
                    background: 'transparent',
                    color: 'var(--ed-ink)',
                    border: '1px dashed var(--ed-rule-strong)',
                    borderRadius: 'var(--ed-radius-chip)',
                  }}
                  title="Adicionar nova linha (POST /items)"
                >
                  {props.addingLine ? (
                    <Loader2 size={12} className="animate-spin" aria-hidden="true" />
                  ) : (
                    <Plus size={12} aria-hidden="true" />
                  )}
                  Adicionar linha
                </button>
              </div>
            )}
          </Group>
        </section>
      )}

      {/* ================================================================
          CONTABILIZAÇÃO + TOCONLINE
          ================================================================ */}
      <Group title="Contabilização">
        <fieldset disabled={props.approved} className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-6">
            <Field label="Conta débito">
              <EdSelect
                value={props.selectedDebitAccount ?? ''}
                onChange={(e) => props.onAssignDebit?.(e.target.value)}
              >
                <option value="">— Selecionar —</option>
                {accounts.map((a, idx) => (
                  <option key={`d-${a.code ?? `idx-${idx}`}`} value={a.code ?? ''}>
                    {(a.code ?? 'N/A')} · {(a.label ?? 'Sem nome')}
                  </option>
                ))}
              </EdSelect>
            </Field>
            <Field label="Conta crédito">
              <EdSelect
                value={props.selectedCreditAccount ?? ''}
                onChange={(e) => props.onAssignCredit?.(e.target.value)}
              >
                <option value="">— Selecionar —</option>
                {accounts.map((a, idx) => (
                  <option key={`c-${a.code ?? `idx-${idx}`}`} value={a.code ?? ''}>
                    {(a.code ?? 'N/A')} · {(a.label ?? 'Sem nome')}
                  </option>
                ))}
              </EdSelect>
            </Field>
          </div>
        </fieldset>

        {/* TOConline stub — botão à direita */}
        <div className="flex items-center justify-between gap-4 mt-6 pt-6 border-t" style={{ borderColor: 'var(--ed-rule)' }}>
          <div className="min-w-0">
            <p
              className="uppercase tracking-wider font-semibold"
              style={{
                fontFamily: 'var(--font-editorial), ui-serif, Georgia, serif',
                fontSize: '12px',
                color: 'var(--ed-ink)',
              }}
            >
              Enviar para TOConline
            </p>
            <p
              className="text-xs mt-1"
              style={{ color: 'var(--ed-ink-faint)' }}
            >
              Stub — gera payload SAF-T e coloca na fila de exportação.
            </p>
          </div>
          <button
            type="button"
            onClick={props.onSendToToc}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm hover:opacity-70 transition-opacity disabled:opacity-50"
            disabled={props.sendingToToc || !props.approved}
            style={{
              background: 'transparent',
              color: 'var(--ed-ink)',
              border: '1px solid var(--ed-rule-strong)',
              borderRadius: 'var(--ed-radius-chip)',
            }}
            title={!props.approved ? 'Aprovar primeiro' : 'Enviar para TOConline'}
          >
            {props.sendingToToc ? (
              <>
                <Loader2 size={12} className="animate-spin" aria-hidden="true" />
                A enviar…
              </>
            ) : (
              <>
                <Send size={12} aria-hidden="true" />
                Enviar
              </>
            )}
          </button>
        </div>
      </Group>
    </div>
  );
}

// Re-export the trash icon import path so it doesn't get tree-shaken unused elsewhere.
export const __unused_Trash2 = Trash2;
