'use client';

/**
 * CorrectSupplierDialog — manual correction of the supplier/customer fields
 * the AI extracted from the document.
 *
 * Editorial / Contábil · Blueprint Edition (commit 2026-09-06).
 *
 * Sprint H+ UX feedback: the dialog used to force the operator to type
 * corrections even when the AI extraction was already right. There are
 * now THREE distinct actions, surfaced through a 3-button chooser:
 *
 *   1. "Corrigir dados"       → mode='edit'     → original POST /correct-supplier form
 *   2. "Re-extrair"           → mode='re-extract' → POST /re-extract, close + toast
 *   3. "Confirmar como está"  → mode='verify'    → PATCH /verify-supplier, close + toast
 *
 * The chooser (`mode='choose'`) is the DEFAULT screen. Only after the
 * operator explicitly picks "Corrigir dados" does the form render — the
 * other two actions never expose the form, so the operator can confirm or
 * re-extract without having to type anything.
 *
 * Party autocomplete (used by the edit form) hits
 * `GET /parties?search=…&limit=10` and is bounded to a small page size —
 * the volume per tenant is low (a few hundred recurring suppliers at
 * most) so we don't bother with virtualisation.
 *
 * Validation mirrors the backend DTO (class-validator): NIF regex matches
 * the practical PT/EU surface, IBAN must start with 2 letters + 2
 * digits. We DO coerce to uppercase before sending so the regex check on
 * the server side passes regardless of how the user typed it.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Loader2, RefreshCw, Search, UserCheck, X } from 'lucide-react';
import { Dialog, toastBus } from '../../../../_components/ui';
import { authedFetch } from '../../../../_lib/auth-refresh';

const API_BASE =
  (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, '')) ||
  'http://localhost:4000/api/v1';

export interface CorrectSupplierInitial {
  supplier?: string | null;
  supplierNif?: string | null;
  iban?: string | null;
  customer?: string | null;
  customerNif?: string | null;
  /** Existing party link, surfaced so the chip shows the current selection. */
  partyId?: string | null;
  partyName?: string | null;
}

export interface CorrectSupplierDialogProps {
  open: boolean;
  documentId: string;
  initial: CorrectSupplierInitial;
  onClose: () => void;
  onSaved?: () => void;
}

interface FormState {
  supplier: string;
  supplierNif: string;
  iban: string;
  customer: string;
  customerNif: string;
  partyId: string | null;
  reason: string;
}

interface PartyLite {
  id: string;
  name: string;
  nif?: string | null;
  iban?: string | null;
}

/**
 * UX flow (Sprint H+):
 *   - `choose`     → 3 buttons (default on open).
 *   - `edit`       → the original form, set by "Corrigir dados".
 *   - `re-extract` → POST /re-extract then close (no form).
 *   - `verify`     → PATCH /verify-supplier then close (no form).
 *
 * `re-extract` and `verify` are kept in the state machine for clarity
 * even though they short-circuit to the same close + toast — keeps the
 * `submitting`/disabled flags on the chooser semantically correct while
 * the request is in flight.
 */
type DialogMode = 'choose' | 'edit' | 're-extract' | 'verify';

const EMPTY_FORM = (initial: CorrectSupplierInitial): FormState => ({
  supplier: initial.supplier ?? '',
  supplierNif: initial.supplierNif ?? '',
  iban: initial.iban ?? '',
  customer: initial.customer ?? '',
  customerNif: initial.customerNif ?? '',
  partyId: initial.partyId ?? null,
  reason: '',
});

/** PT/EU NIF regex — must mirror the backend DTO. */
const NIF_REGEX = /^[A-Z]{0,2}[A-Z0-9]{5,15}$/;
/** IBAN — 2 letter country + 2 check digits + 1–30 alnum. */
const IBAN_REGEX = /^[A-Z]{2}\d{2}[A-Z0-9]{1,30}$/;

export function CorrectSupplierDialog({
  open,
  documentId,
  initial,
  onClose,
  onSaved,
}: CorrectSupplierDialogProps) {
  const [form, setForm] = useState<FormState>(() => EMPTY_FORM(initial));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  // Sprint H+ UX — 3-action chooser. Default is 'choose' so the operator
  // sees the three actions explicitly instead of being dropped into a
  // form they must escape to do nothing.
  const [mode, setMode] = useState<DialogMode>('choose');

  // Party autocomplete state. The search input is bound to `partyQuery`;
  // the dropdown opens when there's text and results are non-empty.
  const [partyQuery, setPartyQuery] = useState('');
  const [partyOptions, setPartyOptions] = useState<PartyLite[]>([]);
  const [partyLoading, setPartyLoading] = useState(false);
  const [partyOpen, setPartyOpen] = useState(false);
  const partyReqId = useRef(0);

  // Reset the form whenever the dialog re-opens so reopening on a
  // different doc (or after the operator tweaks the existing values and
  // cancels) doesn't carry stale state across calls.
  useEffect(() => {
    if (open) {
      setForm(EMPTY_FORM(initial));
      setErrors({});
      setPartyQuery(initial.partyName ?? '');
      setPartyOpen(false);
      // Always start on the chooser — even if the user already picked
      // "Corrigir dados" and cancelled, the next open should re-show
      // the three actions, not silently resume the form.
      setMode('choose');
    }
  }, [open, initial]);

  // Debounced parties lookup — we cancel any in-flight request by tracking
  // an id and dropping stale responses.
  useEffect(() => {
    if (!open) return;
    if (!partyQuery || partyQuery.trim().length < 2) {
      setPartyOptions([]);
      setPartyLoading(false);
      return;
    }
    const myReq = ++partyReqId.current;
    setPartyLoading(true);
    const handle = setTimeout(async () => {
      try {
        const res = await authedFetch(
          `${API_BASE}/parties?search=${encodeURIComponent(partyQuery.trim())}&limit=10`,
        );
        if (!res.ok) {
          setPartyOptions([]);
          return;
        }
        const json = await res.json();
        const items: PartyLite[] = Array.isArray(json?.data?.items)
          ? json.data.items
          : Array.isArray(json?.data)
          ? json.data
          : Array.isArray(json?.items)
          ? json.items
          : [];
        if (partyReqId.current === myReq) {
          setPartyOptions(
            items.map((p) => ({
              id: p.id,
              name: p.name,
              nif: p.nif ?? null,
              iban: p.iban ?? null,
            })),
          );
          setPartyOpen(true);
        }
      } catch {
        if (partyReqId.current === myReq) setPartyOptions([]);
      } finally {
        if (partyReqId.current === myReq) setPartyLoading(false);
      }
    }, 250);
    return () => clearTimeout(handle);
  }, [partyQuery, open]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
  };

  const selectedPartyName = useMemo(() => {
    if (!form.partyId) return null;
    const found = partyOptions.find((p) => p.id === form.partyId);
    return found?.name ?? (initial.partyId === form.partyId ? initial.partyName ?? null : null);
  }, [form.partyId, partyOptions, initial.partyId, initial.partyName]);

  const pickParty = (p: PartyLite) => {
    setForm((f) => ({
      ...f,
      partyId: p.id,
      // Adopt the party's NIF + IBAN if the operator hasn't filled them
      // yet — saves a re-type and keeps the linked record consistent.
      supplierNif: f.supplierNif.trim() === '' ? (p.nif ?? '') : f.supplierNif,
      iban: f.iban.trim() === '' ? (p.iban ?? '') : f.iban,
      supplier: f.supplier.trim() === '' ? p.name : f.supplier,
    }));
    setPartyOpen(false);
  };

  const clearParty = () => {
    setForm((f) => ({ ...f, partyId: null }));
    setPartyQuery('');
  };

  const validate = (): boolean => {
    const next: Record<string, string> = {};
    if (!form.supplier.trim()) next.supplier = 'Fornecedor obrigatório';
    if (!form.supplierNif.trim()) {
      next.supplierNif = 'NIF do fornecedor obrigatório';
    } else if (!NIF_REGEX.test(form.supplierNif.trim().toUpperCase())) {
      next.supplierNif = 'NIF inválido (5–15 alnum, prefixo país opcional)';
    }
    if (form.iban.trim() && !IBAN_REGEX.test(form.iban.trim().toUpperCase())) {
      next.iban = 'IBAN inválido (país + 2 dígitos + corpo alfanumérico)';
    }
    if (!form.customer.trim()) next.customer = 'Cliente obrigatório';
    if (!form.customerNif.trim()) {
      next.customerNif = 'NIF do cliente obrigatório';
    } else if (!NIF_REGEX.test(form.customerNif.trim().toUpperCase())) {
      next.customerNif = 'NIF inválido';
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const submit = async () => {
    if (!validate()) return;
    setSubmitting(true);
    try {
      const payload: Record<string, unknown> = {
        supplier: form.supplier.trim(),
        supplierNif: form.supplierNif.trim().toUpperCase(),
        customer: form.customer.trim(),
        customerNif: form.customerNif.trim().toUpperCase(),
        reason: form.reason.trim() || undefined,
      };
      // Send IBAN only when non-empty so the backend stores null (matches
      // the "clear IBAN" intent) instead of an empty string.
      if (form.iban.trim()) payload.iban = form.iban.trim().toUpperCase();
      // `partyId: null` is an explicit instruction on the server to clear
      // the link. Only send when the operator changed/cleared the field.
      if (form.partyId !== initial.partyId) payload.partyId = form.partyId;

      const res = await authedFetch(
        `${API_BASE}/documents/${documentId}/correct-supplier`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        },
      );
      if (!res.ok) throw await httpError(res, 'Não foi possível corrigir o fornecedor');
      toastBus.success('Fornecedor corrigido. Pipeline a re-correr…');
      onSaved?.();
      onClose();
    } catch (err) {
      toastBus.error('Não foi possível corrigir o fornecedor', {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setSubmitting(false);
    }
  };

  /**
   * Re-extrair — Sprint H+ action #2. Resets the doc to RECEIVED and
   * re-publishes `document.uploaded`. The backend does the heavy lifting
   * asynchronously, so we just close the dialog and let the SSE channel
   * push the progress events.
   */
  const reExtract = async () => {
    setSubmitting(true);
    setMode('re-extract');
    try {
      const res = await authedFetch(
        `${API_BASE}/documents/${documentId}/re-extract`,
        { method: 'POST' },
      );
      if (!res.ok) throw await httpError(res, 'Não foi possível re-extrair');
      toastBus.success(
        'Re-extração iniciada — processamento vai completar em segundos.',
      );
      onSaved?.();
      onClose();
    } catch (err) {
      toastBus.error('Não foi possível re-extrair', {
        description: err instanceof Error ? err.message : undefined,
      });
      // Send the user back to the chooser so they can try again or pick
      // a different action — never leave them stuck on a "loading" frame
      // after an error.
      setMode('choose');
    } finally {
      setSubmitting(false);
    }
  };

  /**
   * Confirmar como está — Sprint H+ action #3. Stamps supplierVerifiedAt
   * via the new PATCH /documents/:id/verify-supplier endpoint. Distinct
   * from correct-supplier (which writes fields) and from approve (a
   * downstream gate): this is purely the "I reviewed the AI extraction
   * and it's correct as-is" decision, recorded for the audit trail.
   */
  const verifyAsIs = async () => {
    setSubmitting(true);
    setMode('verify');
    try {
      const res = await authedFetch(
        `${API_BASE}/documents/${documentId}/verify-supplier`,
        { method: 'PATCH' },
      );
      if (!res.ok) throw await httpError(res, 'Não foi possível confirmar');
      toastBus.success('Fornecedor confirmado. Registo gravado em auditoria.');
      onSaved?.();
      onClose();
    } catch (err) {
      toastBus.error('Não foi possível confirmar', {
        description: err instanceof Error ? err.message : undefined,
      });
      setMode('choose');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={submitting ? () => undefined : onClose}
      title="Corrigir fornecedor"
      description={
        mode === 'choose'
          ? 'Escolha uma das três ações abaixo — só precisa de corrigir dados quando a IA realmente errou.'
          : 'Substitui os campos extraídos pelo Gemini Vision. A correção é registada em auditoria e a pipeline é re-executada.'
      }
      size="lg"
    >
      {mode === 'choose' ? (
        <div className="space-y-3" role="group" aria-label="Ações de fornecedor">
          <ChooserButton
            tone="primary"
            icon={<UserCheck size={16} aria-hidden="true" />}
            title="Corrigir dados"
            description="Substituir fornecedor, NIF, IBAN ou cliente. A pipeline é re-executada com os valores novos."
            onClick={() => setMode('edit')}
            disabled={submitting}
          />
          <ChooserButton
            icon={<RefreshCw size={16} aria-hidden="true" />}
            title="Re-extrair"
            description="Re-correr a IA (Gemini Vision) sem mexer em nada. Útil quando o ficheiro mudou ou a primeira extração falhou."
            onClick={reExtract}
            disabled={submitting}
          />
          <ChooserButton
            icon={<Check size={16} aria-hidden="true" />}
            title="Confirmar como está"
            description="Marcar os dados extraídos como verificados sem os alterar. Regista a decisão em auditoria."
            onClick={verifyAsIs}
            disabled={submitting}
          />

          <div
            className="flex items-center justify-end gap-2 pt-4 border-t"
            style={{ borderColor: 'var(--ed-rule)' }}
          >
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="btn-secondary text-sm"
            >
              Fechar
            </button>
          </div>
        </div>
      ) : (
      <div className="space-y-5">
        {/* ─────────────── Back-to-chooser hint ─────────────── */}
        <button
          type="button"
          onClick={() => setMode('choose')}
          disabled={submitting}
          className="text-[11px] uppercase tracking-wider hover:opacity-70 disabled:opacity-50"
          style={{
            fontFamily: 'var(--font-inter-tight), system-ui, sans-serif',
            letterSpacing: '0.14em',
            color: 'var(--ed-ink-faint)',
          }}
        >
          ← Outras ações
        </button>

        {/* ─────────────── Supplier ─────────────── */}
        <fieldset
          className="space-y-4"
          disabled={submitting}
          aria-label="Dados do fornecedor"
        >
          <legend
            className="uppercase font-medium mb-2"
            style={{
              fontFamily: 'var(--font-editorial), ui-serif, Georgia, serif',
              fontSize: '12px',
              letterSpacing: '0.14em',
              color: 'var(--ed-ink-faint)',
            }}
          >
            Fornecedor (supplier)
          </legend>
          <Field label="Nome" error={errors.supplier}>
            <input
              type="text"
              value={form.supplier}
              onChange={(e) => set('supplier', e.target.value)}
              placeholder="EDENOX"
              className="ed-dialog-input"
            />
          </Field>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field label="NIF" error={errors.supplierNif}>
              <input
                type="text"
                value={form.supplierNif}
                onChange={(e) =>
                  set('supplierNif', e.target.value.toUpperCase())
                }
                placeholder="502782160"
                className="ed-dialog-input"
                style={{ fontFamily: '"JetBrains Mono", ui-monospace, monospace' }}
              />
            </Field>
            <Field label="IBAN" error={errors.iban} hint="Opcional — vazio para limpar.">
              <input
                type="text"
                value={form.iban}
                onChange={(e) => set('iban', e.target.value.toUpperCase())}
                placeholder="PT50 0033 0000 4531 2966 5500 7"
                className="ed-dialog-input"
                style={{ fontFamily: '"JetBrains Mono", ui-monospace, monospace' }}
              />
            </Field>
          </div>
        </fieldset>

        {/* ─────────────── Customer ─────────────── */}
        <fieldset
          className="space-y-4 pt-5 border-t"
          style={{ borderColor: 'var(--ed-rule)' }}
          disabled={submitting}
          aria-label="Dados do cliente"
        >
          <legend
            className="uppercase font-medium mb-2"
            style={{
              fontFamily: 'var(--font-editorial), ui-serif, Georgia, serif',
              fontSize: '12px',
              letterSpacing: '0.14em',
              color: 'var(--ed-ink-faint)',
            }}
          >
            Cliente (customer)
          </legend>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field label="Nome" error={errors.customer}>
              <input
                type="text"
                value={form.customer}
                onChange={(e) => set('customer', e.target.value)}
                placeholder="NOV OUSADO LDA"
                className="ed-dialog-input"
              />
            </Field>
            <Field label="NIF" error={errors.customerNif}>
              <input
                type="text"
                value={form.customerNif}
                onChange={(e) =>
                  set('customerNif', e.target.value.toUpperCase())
                }
                placeholder="515208566"
                className="ed-dialog-input"
                style={{ fontFamily: '"JetBrains Mono", ui-monospace, monospace' }}
              />
            </Field>
          </div>
        </fieldset>

        {/* ─────────────── Party link ─────────────── */}
        <div
          className="space-y-2 pt-5 border-t"
          style={{ borderColor: 'var(--ed-rule)' }}
        >
          <label
            className="uppercase font-medium"
            style={{
              fontFamily: 'var(--font-editorial), ui-serif, Georgia, serif',
              fontSize: '11px',
              letterSpacing: '0.14em',
              color: 'var(--ed-ink-faint)',
            }}
          >
            Vincular a uma Party existente (opcional)
          </label>

          {form.partyId ? (
            <div
              className="flex items-center justify-between gap-2 px-3 py-2"
              style={{
                background: 'var(--ed-canvas-2)',
                border: '1px solid var(--ed-rule)',
                borderRadius: 'var(--ed-radius-chip)',
              }}
            >
              <div className="min-w-0 flex-1">
                <div
                  className="text-sm font-medium truncate"
                  style={{ color: 'var(--ed-ink)' }}
                >
                  {selectedPartyName ?? `Party ${form.partyId.slice(0, 10)}…`}
                </div>
                <div
                  className="text-[10px] uppercase tracking-wider"
                  style={{ color: 'var(--ed-ink-faint)' }}
                >
                  ID {form.partyId}
                </div>
              </div>
              <button
                type="button"
                onClick={clearParty}
                disabled={submitting}
                aria-label="Remover vínculo"
                className="btn-ghost p-1"
                style={{ color: 'var(--ed-ink-faint)' }}
              >
                <X size={14} aria-hidden="true" />
              </button>
            </div>
          ) : (
            <div className="relative">
              <div className="relative">
                <Search
                  size={14}
                  className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
                  style={{ color: 'var(--ed-ink-faint)' }}
                  aria-hidden="true"
                />
                <input
                  type="text"
                  value={partyQuery}
                  onChange={(e) => {
                    setPartyQuery(e.target.value);
                    setPartyOpen(true);
                  }}
                  onFocus={() => partyOptions.length > 0 && setPartyOpen(true)}
                  placeholder="Pesquisar por nome…"
                  className="ed-dialog-input"
                  style={{ paddingLeft: '32px' }}
                />
                {partyLoading && (
                  <Loader2
                    size={14}
                    className="absolute right-3 top-1/2 -translate-y-1/2 animate-spin"
                    style={{ color: 'var(--ed-ink-faint)' }}
                    aria-hidden="true"
                  />
                )}
              </div>

              {partyOpen && partyOptions.length > 0 && (
                <ul
                  role="listbox"
                  className="absolute z-10 left-0 right-0 mt-1 max-h-56 overflow-auto"
                  style={{
                    background: 'var(--ed-canvas)',
                    border: '1px solid var(--ed-rule-strong)',
                    borderRadius: 'var(--ed-radius-chip)',
                    boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
                  }}
                >
                  {partyOptions.map((p) => (
                    <li
                      key={p.id}
                      role="option"
                      aria-selected={false}
                      onClick={() => pickParty(p)}
                      className="px-3 py-2 cursor-pointer transition-colors hover:opacity-80"
                      style={{ borderBottom: '1px solid var(--ed-rule)' }}
                    >
                      <div
                        className="text-sm font-medium"
                        style={{ color: 'var(--ed-ink)' }}
                      >
                        {p.name}
                      </div>
                      {(p.nif || p.iban) && (
                        <div
                          className="text-[10px] uppercase tracking-wider tabular-nums"
                          style={{
                            color: 'var(--ed-ink-faint)',
                            fontFamily: '"JetBrains Mono", ui-monospace, monospace',
                          }}
                        >
                          {p.nif ? `NIF ${p.nif}` : ''}
                          {p.nif && p.iban ? ' · ' : ''}
                          {p.iban ? `IBAN ${p.iban}` : ''}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        {/* ─────────────── Reason (audit) ─────────────── */}
        <Field
          label="Motivo da correção (audit log)"
          hint="Texto livre — registado na auditoria para rastreabilidade."
        >
          <textarea
            value={form.reason}
            onChange={(e) => set('reason', e.target.value)}
            placeholder="ex.: AI trocou fornecedor com cliente"
            rows={2}
            maxLength={500}
            className="ed-dialog-input"
            style={{ resize: 'vertical', minHeight: '64px' }}
          />
        </Field>

        {/* ─────────────── Footer ─────────────── */}
        <div
          className="flex items-center justify-end gap-2 pt-4 border-t"
          style={{ borderColor: 'var(--ed-rule)' }}
        >
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="btn-secondary text-sm"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={submitting}
            aria-busy={submitting}
            className="btn-primary text-sm"
          >
            {submitting ? (
              <>
                <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                A guardar…
              </>
            ) : (
              <>
                <UserCheck size={14} aria-hidden="true" />
                Salvar correção
              </>
            )}
          </button>
        </div>
      </div>
      )}
    </Dialog>
  );
}

/* ================================================================
   Local helpers — minimal primitives so the dialog doesn't depend
   on a global "Field" component the page already uses elsewhere.
   ================================================================ */

/**
 * Translate a non-2xx Response into an Error whose message is the API's
 * `message` (or "<prefix>: HTTP <status>" as a fallback). Keeps the
 * call sites readable — the catch block can just spread the error.
 */
async function httpError(res: Response, prefix: string): Promise<Error> {
  let detail = `${prefix}: HTTP ${res.status}`;
  try {
    const body = await res.json();
    if (body?.message) {
      const msg = Array.isArray(body.message)
        ? body.message.join('; ')
        : String(body.message);
      detail = `${prefix}: ${msg}`;
    }
  } catch {
    /* response was not JSON — keep the HTTP-status fallback */
  }
  return new Error(detail);
}

/**
 * Big tappable button used by the 3-action chooser. Mirrors the
 * editorial Card primitive (white surface + 1px navy rule + generous
 * padding) so the chooser visually anchors to the rest of the dialog.
 */
function ChooserButton({
  icon,
  title,
  description,
  onClick,
  disabled,
  tone,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  onClick: () => void;
  disabled?: boolean;
  /** `primary` → gold accent (default action), `ghost` → neutral. */
  tone?: 'primary' | 'ghost';
}) {
  const isPrimary = tone === 'primary';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="group flex w-full items-start gap-4 px-4 py-3 text-left transition-all hover:translate-x-0.5 disabled:opacity-50 disabled:cursor-not-allowed"
      style={{
        background: isPrimary ? 'var(--ed-canvas-2)' : 'var(--ed-canvas)',
        border: `1px solid ${isPrimary ? 'var(--ed-accent-gold)' : 'var(--ed-rule-strong)'}`,
        borderRadius: 'var(--ed-radius-chip)',
      }}
    >
      <span
        className="flex h-9 w-9 flex-shrink-0 items-center justify-center"
        style={{
          background: isPrimary ? 'var(--ed-accent-gold-dim)' : 'var(--ed-canvas-2)',
          border: `1px solid ${isPrimary ? 'var(--ed-accent-gold)' : 'var(--ed-rule)'}`,
          borderRadius: '50%',
          color: 'var(--ed-ink)',
        }}
        aria-hidden="true"
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span
          className="block font-medium"
          style={{
            fontFamily: 'var(--font-editorial), ui-serif, Georgia, serif',
            fontSize: '15px',
            color: 'var(--ed-ink)',
          }}
        >
          {title}
        </span>
        <span
          className="mt-0.5 block text-[12px] leading-snug"
          style={{ color: 'var(--ed-ink-faint)' }}
        >
          {description}
        </span>
      </span>
    </button>
  );
}
function Field({
  label,
  error,
  hint,
  children,
}: {
  label: string;
  error?: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label
        className="block uppercase font-medium mb-1.5"
        style={{
          fontFamily: 'var(--font-inter-tight), system-ui, sans-serif',
          fontSize: '11px',
          letterSpacing: '0.12em',
          color: 'var(--ed-ink-faint)',
        }}
      >
        {label}
      </label>
      {children}
      {hint && !error && (
        <p
          className="text-[10px] mt-1"
          style={{ color: 'var(--ed-ink-faint)' }}
        >
          {hint}
        </p>
      )}
      {error && (
        <p
          className="text-[10px] mt-1"
          style={{ color: 'var(--ed-status-alert)' }}
        >
          {error}
        </p>
      )}
    </div>
  );
}
