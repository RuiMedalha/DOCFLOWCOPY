'use client';

/**
 * SupplierManualEditSection — inline manual edit form for the supplier
 * block (Sprint H+ Part 2, Part 2.2 UI).
 *
 * Renders directly under the supplier/NIF/IBAN row in the document
 * detail page so the operator can correct the AI's supplier extraction
 * without bouncing through the larger "Corrigir fornecedor" dialog.
 *
 * Behavior:
 *   - `name` is the only required field (server enforces "at least one
 *     field"; the UI keeps `name` mandatory so the Save button is
 *     never a no-op).
 *   - `nif` + `iban` are validated **client-side** with the same
 *     mod-11 + mod-97 checksums used by the backend (see
 *     `validateNifMod11` / `validateIbanMod97` below). The backend
 *     re-runs these server-side, so a stale client never persists a
 *     bad value — but the inline error keeps the operator inside the
 *     form instead of bouncing through a 400 toast.
 *   - `address` is a textarea, `country` an ISO-3166-1 alpha-2 input
 *     (capped at 2 chars; the user can leave it blank).
 *
 * When the user clicks "Guardar", we POST to
 * `/api/v1/documents/:id/supplier/update` with only the fields that
 * were touched (the backend treats undefined keys as "leave alone"
 * so editing just the IBAN does not blank the address).
 *
 * Skipped when the document is already approved (`disabled` prop) so
 * the form mirrors the "Corrigir fornecedor" button's gate.
 */

import { useEffect, useMemo, useState } from 'react';
import { Loader2, MapPin, Save, UserCheck } from 'lucide-react';
import { toastBus } from '../../../../_components/ui';
import {
  useUpdateSupplier,
  type DocumentDetail,
  type SupplierUpdateBody,
} from '../_lib/use-document-detail';

export interface SupplierManualEditSectionProps {
  documentId: string;
  supplier: DocumentDetail;
  disabled?: boolean;
}

/* ------------------------------------------------------------------ *
 * Validators — mirror the backend structural checks. The backend is
 * the source of truth, but running these inline lets us surface a
 * per-field error without a round-trip.
 *
 * `validateNifMod11` accepts raw 9-digit NIFs and `PT`-prefixed values.
 * Foreign VATs (e.g. `ES14219836`) are reported valid here because
 * the backend intentionally skips the mod-11 check for them; the
 * server still owns that decision.
 * ------------------------------------------------------------------ */

function normaliseDigits(raw: string): string {
  return raw.replace(/\s+/g, '');
}

export function validateNifMod11(nif: string): boolean {
  const trimmed = normaliseDigits(nif).toUpperCase();
  if (trimmed.length === 0) return true; // empty is OK (optional)
  const stripped = trimmed.replace(/^PT/i, '');
  if (!/^\d{9}$/.test(stripped)) {
    // Foreign VAT shapes pass through — backend handles them.
    if (/^[A-Z]{2}/.test(trimmed)) return true;
    return false;
  }
  const digits = stripped.split('').map(Number);
  const checkDigit = digits[8];
  let sum = 0;
  for (let i = 0; i < 8; i++) sum += digits[i] * (9 - i);
  const mod = sum % 11;
  const expected = mod < 2 ? 0 : 11 - mod;
  return checkDigit === expected;
}

export function validateIbanMod97(iban: string): boolean {
  const trimmed = normaliseDigits(iban).toUpperCase();
  if (trimmed.length === 0) return true; // empty is OK (optional)
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{1,30}$/.test(trimmed)) return false;
  // ISO 13616: move first 4 chars to end, letter → number (A=10).
  const reordered = trimmed.slice(4) + trimmed.slice(0, 4);
  const numeric = reordered
    .split('')
    .map((c) => (/[A-Z]/.test(c) ? (c.charCodeAt(0) - 55).toString() : c))
    .join('');
  let remainder = '';
  for (let i = 0; i < numeric.length; i++) {
    remainder = (parseInt(remainder + numeric[i], 10) % 97).toString();
  }
  return remainder === '1';
}

interface FormState {
  name: string;
  nif: string;
  iban: string;
  address: string;
  country: string;
}

function snapshotFromDoc(doc: DocumentDetail): FormState {
  return {
    name: doc.supplier ?? '',
    nif: doc.supplierNif ?? '',
    iban: doc.iban ?? '',
    address: doc.supplierAddress ?? '',
    country: doc.supplierCountry ?? '',
  };
}

function diff(original: FormState, current: FormState): SupplierUpdateBody {
  const out: SupplierUpdateBody = {};
  if (current.name !== original.name) out.name = current.name.trim();
  if (current.nif !== original.nif) out.nif = current.nif.trim().toUpperCase() || undefined;
  if (current.iban !== original.iban) out.iban = current.iban.trim().toUpperCase() || undefined;
  if (current.address !== original.address) out.address = current.address.trim() || undefined;
  if (current.country !== original.country) out.country = current.country.trim().toUpperCase() || undefined;
  return out;
}

export function SupplierManualEditSection({
  documentId,
  supplier,
  disabled = false,
}: SupplierManualEditSectionProps) {
  const update = useUpdateSupplier();
  const [baseline, setBaseline] = useState<FormState>(() => snapshotFromDoc(supplier));
  const [form, setForm] = useState<FormState>(() => snapshotFromDoc(supplier));
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Re-snapshot when the upstream document refreshes (post-save / SSE
  // refetch) so the form doesn't drift away from the server state.
  // We compare field-by-field to avoid clobbering an unsaved edit.
  useEffect(() => {
    setBaseline((prev) => {
      const incoming = snapshotFromDoc(supplier);
      // Only swap baseline/form when the server values diverge from
      // what we last knew — preserves in-progress typing.
      const drifted =
        incoming.name !== prev.name ||
        incoming.nif !== prev.nif ||
        incoming.iban !== prev.iban ||
        incoming.address !== prev.address ||
        incoming.country !== prev.country;
      if (!drifted) return prev;
      return incoming;
    });
  }, [supplier]);

  // When the baseline changes (server snapshot moved), mirror it into
  // the live form ONLY when there are no unsaved edits. Otherwise the
  // operator loses their typing the moment SSE pushes new fields.
  const dirty = useMemo(
    () =>
      form.name !== baseline.name ||
      form.nif !== baseline.nif ||
      form.iban !== baseline.iban ||
      form.address !== baseline.address ||
      form.country !== baseline.country,
    [form, baseline],
  );

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const nifError = form.nif.trim() && !validateNifMod11(form.nif)
    ? 'NIF inválido (verifique o check digit mod-11)'
    : '';
  const ibanError = form.iban.trim() && !validateIbanMod97(form.iban)
    ? 'IBAN inválido (verifique o check digits mod-97)'
    : '';
  const nameError =
    !form.name.trim() && dirty ? 'Nome do fornecedor é obrigatório' : '';

  const blockReason = (disabled && 'Documento aprovado — edição bloqueada') || '';
  const hasErrors = Boolean(nifError || ibanError || nameError);
  const canSave =
    !disabled &&
    dirty &&
    form.name.trim().length > 0 &&
    !nifError &&
    !ibanError &&
    (form.country === '' || form.country.trim().length <= 2);

  const submit = async () => {
    if (!canSave) return;
    const body = diff(baseline, form);
    if (Object.keys(body).length === 0) {
      toastBus.info('Nenhuma alteração para guardar.');
      return;
    }
    try {
      await update.mutateAsync({ id: documentId, body });
      toastBus.success('Fornecedor atualizado. Pipeline a re-correr…');
      // The hook already invalidates the detail cache; we reflect the
      // new baseline once the refetch lands (the snapshot effect).
    } catch (err) {
      const raw = err instanceof Error ? err.message : '';
      toastBus.error('Não foi possível atualizar o fornecedor', {
        description: raw || undefined,
      });
    }
  };

  const reset = () => setForm({ ...baseline });

  return (
    <section
      aria-label="Edição manual de fornecedor"
      className="rounded-md border p-4 space-y-3"
      style={{
        background: 'var(--ed-canvas-2)',
        borderColor: 'var(--ed-rule)',
      }}
    >
      <header className="flex items-center justify-between gap-2">
        <h4
          className="uppercase font-medium"
          style={{
            fontFamily: 'var(--font-editorial), ui-serif, Georgia, serif',
            fontSize: '11px',
            letterSpacing: '0.14em',
            color: 'var(--ed-ink-faint)',
          }}
        >
          Editar fornecedor (manual)
        </h4>
        {dirty && !disabled && (
          <button
            type="button"
            onClick={reset}
            className="text-[10px] uppercase tracking-wider hover:opacity-70"
            style={{ color: 'var(--ed-ink-faint)' }}
          >
            Reverter
          </button>
        )}
      </header>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Field label="Nome" error={nameError} required disabled={disabled || update.isPending}>
          <input
            type="text"
            value={form.name}
            onChange={(e) => set('name', e.target.value)}
            placeholder="EDENOX"
            className="ed-dialog-input"
            disabled={disabled || update.isPending}
            data-testid="supplier-name-input"
          />
        </Field>

        <Field label="NIF" error={nifError} disabled={disabled || update.isPending}>
          <input
            type="text"
            value={form.nif}
            onChange={(e) => set('nif', e.target.value.toUpperCase())}
            placeholder="502782160"
            className="ed-dialog-input"
            disabled={disabled || update.isPending}
            style={{ fontFamily: '"JetBrains Mono", ui-monospace, monospace' }}
            data-testid="supplier-nif-input"
          />
        </Field>

        <Field label="IBAN" error={ibanError} disabled={disabled || update.isPending}>
          <input
            type="text"
            value={form.iban}
            onChange={(e) => set('iban', e.target.value.toUpperCase())}
            placeholder="PT50 0033 0000 4531 2966 5500 7"
            className="ed-dialog-input"
            disabled={disabled || update.isPending}
            style={{ fontFamily: '"JetBrains Mono", ui-monospace, monospace' }}
            data-testid="supplier-iban-input"
          />
        </Field>

        <Field label="País (ISO-2)" hint="Opcional — ex.: PT, ES, FR." disabled={disabled || update.isPending}>
          <input
            type="text"
            value={form.country}
            onChange={(e) =>
              set(
                'country',
                e.target.value.toUpperCase().slice(0, 2),
              )
            }
            placeholder="PT"
            maxLength={2}
            className="ed-dialog-input"
            disabled={disabled || update.isPending}
            style={{ fontFamily: '"JetBrains Mono", ui-monospace, monospace' }}
            data-testid="supplier-country-input"
          />
        </Field>
      </div>

      <button
        type="button"
        onClick={() => setShowAdvanced((s) => !s)}
        disabled={disabled}
        className="text-[11px] uppercase tracking-wider hover:opacity-70 disabled:opacity-40"
        style={{ color: 'var(--ed-ink-faint)' }}
      >
        {showAdvanced ? '− Ocultar' : '+ Mostrar'} morada completa
      </button>

      {showAdvanced && (
        <Field label="Morada" disabled={disabled || update.isPending}>
          <textarea
            value={form.address}
            onChange={(e) => set('address', e.target.value)}
            placeholder="Rua das Indústrias 123, 4400-001 Vila Nova de Gaia"
            rows={3}
            maxLength={500}
            className="ed-dialog-input"
            disabled={disabled || update.isPending}
            style={{ resize: 'vertical', minHeight: '64px' }}
            data-testid="supplier-address-input"
          />
        </Field>
      )}

      <div className="flex items-center justify-end gap-2 pt-2">
        {blockReason && (
          <span
            className="text-[10px] uppercase tracking-wider mr-auto"
            style={{ color: 'var(--ed-ink-faint)' }}
          >
            {blockReason}
          </span>
        )}
        <button
          type="button"
          onClick={submit}
          disabled={!canSave || update.isPending || hasErrors}
          aria-busy={update.isPending}
          className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium transition-all disabled:opacity-40"
          style={{
            background: 'var(--ed-accent-gold)',
            color: 'var(--ed-ink)',
            borderRadius: 'var(--ed-radius-chip)',
          }}
          data-testid="supplier-save-button"
        >
          {update.isPending ? (
            <Loader2 size={14} className="animate-spin" aria-hidden="true" />
          ) : (
            <Save size={14} aria-hidden="true" />
          )}
          {update.isPending ? 'A guardar…' : 'Guardar'}
        </button>
      </div>

      {hasErrors && (
        <p
          className="text-[10px] uppercase tracking-wider flex items-center gap-1"
          style={{ color: 'var(--ed-status-alert)' }}
        >
          <MapPin size={10} aria-hidden="true" />
          Corrija os campos acima antes de guardar.
        </p>
      )}

      <p
        className="text-[10px] flex items-center gap-1"
        style={{ color: 'var(--ed-ink-faint)' }}
      >
        <UserCheck size={10} aria-hidden="true" />
        Para correções mais profundas (vincular a uma Party existente, mudar cliente, motivo de auditoria) use
        o botão &quot;Corrigir fornecedor&quot;.
      </p>
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * Local Field wrapper — matches the dialog's variant so the inline
 * form visually anchors to the rest of the page without dragging in a
 * global "Field" component.
 * ------------------------------------------------------------------ */
function Field({
  label,
  error,
  hint,
  required,
  disabled,
  children,
}: {
  label: string;
  error?: string;
  hint?: string;
  required?: boolean;
  disabled?: boolean;
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
        {required && (
          <span aria-hidden="true" style={{ color: 'var(--ed-status-alert)' }}>
            {' '}*
          </span>
        )}
      </label>
      <div className={disabled ? 'pointer-events-none opacity-60' : ''}>{children}</div>
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

// Re-export validators for unit tests / Storybook etc.
export const suppliersHelpers = { validateNifMod11, validateIbanMod97 };
