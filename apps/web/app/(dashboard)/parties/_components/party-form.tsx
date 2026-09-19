'use client';

import { useRouter } from 'next/navigation';
import { useState, useEffect } from 'react';
import { Save, Loader2 } from 'lucide-react';
import {
  useCreateParty,
  useUpdateParty,
  useSeedAccounts,
  usePartyCategories,
} from './use-parties';
import type { PartyInput, Account, PartyCategory } from '../_lib/types';
import { useCategories } from '../../categories/use-categories';

export function PartyForm({ initial, partyId, isAdmin }: { initial?: PartyInput; partyId?: string; isAdmin?: boolean }) {
  const router = useRouter();
  const create = useCreateParty();
  const update = useUpdateParty();
  const seedAccountsData = useSeedAccounts().data;
  const seedAccounts: Account[] = Array.isArray(seedAccountsData)
    ? seedAccountsData
    : (seedAccountsData && (seedAccountsData as any).items) || [];
  const partyCategories = usePartyCategories().data ?? [];
  const expenseCategories = useCategories().categories;
  const [form, setForm] = useState<PartyInput>(initial ?? {
    type: 'FORNECEDOR',
    name: '',
    nif: '',
    email: '',
    website: '',
    phone: '',
    mobile: '',
    iban: '',
    bic: '',
    address: '',
    city: '',
    postalCode: '',
    country: 'Portugal',
    partyCategoryId: '',
    isRecurring: false,
    isRecurringManualOverride: false,
  });

  useEffect(() => {
    if (initial) {
      setForm(initial);
    }
  }, [initial]);

  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    try {
      const cleaned: PartyInput = {
        type: form.type,
        name: form.name,
        nif: form.nif?.trim() || undefined,
        email: form.email?.trim() || undefined,
        website: form.website?.trim() || undefined,
        phone: form.phone?.trim() || undefined,
        mobile: form.mobile?.trim() || undefined,
        iban: form.iban?.trim() || undefined,
        bic: form.bic?.trim() || undefined,
        address: form.address?.trim() || undefined,
        city: form.city?.trim() || undefined,
        postalCode: form.postalCode?.trim() || undefined,
        country: form.country?.trim() || undefined,
        defaultDebitAccountId: form.defaultDebitAccountId,
        defaultCreditAccountId: form.defaultCreditAccountId,
        // Sprint E: empty string clears the category — server treats it
        // as null in the Prisma update path.
        partyCategoryId: form.partyCategoryId || undefined,
        // Fase 4 — perfil fiscal/comercial
        vatNumber: form.vatNumber?.trim() || undefined,
        vatRegime: form.vatRegime || undefined,
        currency: form.currency?.trim().toUpperCase() || undefined,
        directDebit: form.directDebit ?? undefined,
        billingEmail: form.billingEmail?.trim() || undefined,
        defaultCategoryId: form.defaultCategoryId === undefined ? undefined : form.defaultCategoryId,
        paymentTermDays: form.paymentTermDays === undefined || form.paymentTermDays === null ? undefined : Number(form.paymentTermDays),
        // ADMIN-only fields: server rejects (403) if non-ADMIN tries to send these.
        isRecurring: isAdmin ? form.isRecurring : undefined,
        isRecurringManualOverride: isAdmin ? form.isRecurringManualOverride : undefined,
      };
      const res = partyId
        ? await update.mutateAsync({ id: partyId, ...cleaned })
        : await create.mutateAsync(cleaned);
      router.push(`/parties/${res.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro desconhecido');
    }
  }

  return (
    <form onSubmit={onSubmit} className="card p-6 space-y-5 max-w-3xl">
      <div className="grid sm:grid-cols-2 gap-3">
        <Field label="Tipo">
          <select className="select" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as 'FORNECEDOR' | 'CLIENTE' | 'AMBOS' })}>
            <option value="FORNECEDOR">Fornecedor</option>
            <option value="CLIENTE">Cliente</option>
            <option value="AMBOS">Ambos</option>
          </select>
        </Field>
        <Field label="Nome *">
          <input className="input" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label="Classificação do Parceiro">
          <select
            className="select"
            value={form.partyCategoryId ?? ''}
            onChange={(e) => setForm({ ...form, partyCategoryId: e.target.value })}
          >
            <option value="">— Sem classificação definida —</option>
            {partyCategories.map((c: PartyCategory) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </Field>
        <Field label="NIF (9 dígitos)">
          <input className="input font-mono" maxLength={9} value={form.nif ?? ''} onChange={(e) => setForm({ ...form, nif: e.target.value })} />
        </Field>
        <Field label="Email">
          <input type="email" className="input" value={form.email ?? ''} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </Field>
        <Field label="Website / Página Web">
          <input
            type="url"
            className="input"
            placeholder="https://empresa.pt"
            value={form.website ?? ''}
            onChange={(e) => setForm({ ...form, website: e.target.value })}
          />
        </Field>
        <Field label="Telefone">
          <input className="input" value={form.phone ?? ''} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        </Field>
        <Field label="Telemóvel">
          <input className="input" value={form.mobile ?? ''} onChange={(e) => setForm({ ...form, mobile: e.target.value })} />
        </Field>
        <Field label="IBAN">
          <input className="input font-mono" maxLength={34} value={form.iban ?? ''} onChange={(e) => setForm({ ...form, iban: e.target.value })} placeholder="por preencher" />
        </Field>
        <Field label="BIC / SWIFT">
          <input className="input font-mono" maxLength={11} value={form.bic ?? ''} onChange={(e) => setForm({ ...form, bic: e.target.value })} />
        </Field>
        <Field label="Morada" full>
          <input className="input" value={form.address ?? ''} onChange={(e) => setForm({ ...form, address: e.target.value })} />
        </Field>
        <Field label="Código postal">
          <input className="input" value={form.postalCode ?? ''} onChange={(e) => setForm({ ...form, postalCode: e.target.value })} />
        </Field>
        <Field label="Cidade">
          <input className="input" value={form.city ?? ''} onChange={(e) => setForm({ ...form, city: e.target.value })} />
        </Field>
        <Field label="País">
          <input
            className="input"
            value={form.country ?? 'Portugal'}
            onChange={(e) => {
              const newCountry = e.target.value;
              const isNonPt = newCountry.trim().toUpperCase() !== 'PT' && !/^portugal$/i.test(newCountry.trim());
              const newRegime = isNonPt && (form.vatRegime === 'PT' || !form.vatRegime) ? 'UE_REVERSE_CHARGE' : form.vatRegime;
              setForm({ ...form, country: newCountry, vatRegime: newRegime });
            }}
          />
        </Field>
        {/* Fase 4 — perfil fiscal/comercial */}
        <Field label="NIF-IVA UE (estrangeiros)">
          <input className="input font-mono" placeholder="por preencher" value={form.vatNumber ?? ''} onChange={(e) => setForm({ ...form, vatNumber: e.target.value })} />
        </Field>
        <Field label="Regime de IVA">
          <select
            className="select"
            value={form.vatRegime ?? (form.country && form.country.trim().toUpperCase() !== 'PT' && !/^portugal$/i.test(form.country.trim()) ? 'UE_REVERSE_CHARGE' : 'PT')}
            onChange={(e) => setForm({ ...form, vatRegime: e.target.value as PartyInput['vatRegime'] })}
          >
            <option value="PT">Portugal (IVA normal)</option>
            <option value="UE_REVERSE_CHARGE">Intra-UE — autoliquidação (reverse charge)</option>
            <option value="EXTRA_UE">Fora da UE (importação)</option>
          </select>
        </Field>
        <Field label="Moeda das faturas">
          <input className="input" maxLength={3} placeholder="EUR" value={form.currency ?? 'EUR'} onChange={(e) => setForm({ ...form, currency: e.target.value.toUpperCase() })} />
        </Field>
        <Field label="Prazo de pagamento (dias)">
          <input className="input" type="number" min={0} max={365} value={form.paymentTermDays ?? ''} onChange={(e) => setForm({ ...form, paymentTermDays: e.target.value === '' ? undefined : Number(e.target.value) })} />
        </Field>
        <Field label="Email de faturação">
          <input className="input" type="email" placeholder="faturas@fornecedor.pt" value={form.billingEmail ?? ''} onChange={(e) => setForm({ ...form, billingEmail: e.target.value })} />
        </Field>
        <Field label="Categoria de despesa por defeito (SNC)">
          <select className="select" value={form.defaultCategoryId ?? ''} onChange={(e) => setForm({ ...form, defaultCategoryId: e.target.value })}>
            <option value="">— Automática (após 3 aprovações ou extração) —</option>
            {expenseCategories.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </Field>
        <Field label="Débito direto">
          <label className="inline-flex items-center gap-2 text-sm">
            <input type="checkbox" checked={!!form.directDebit} onChange={(e) => setForm({ ...form, directDebit: e.target.checked })} />
            Pago por débito direto (SEPA DD)
          </label>
        </Field>
        <Field label="Conta Débito default">
          <select className="select" value={form.defaultDebitAccountId ?? ''} onChange={(e) => setForm({ ...form, defaultDebitAccountId: e.target.value || undefined })}>
            <option value="">—</option>
            {seedAccounts?.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
          </select>
        </Field>
        <Field label="Conta Crédito default">
          <select className="select" value={form.defaultCreditAccountId ?? ''} onChange={(e) => setForm({ ...form, defaultCreditAccountId: e.target.value || undefined })}>
            <option value="">—</option>
            {seedAccounts?.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
          </select>
        </Field>
      </div>

      {isAdmin === true && (
        <div className="sm:col-span-2 mt-4 pt-4 border-t space-y-2" style={{ borderColor: 'var(--border)' }}>
          <div className="text-xs font-medium uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
            Flags de recorrência (ADMIN)
          </div>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={form.isRecurring === true}
              disabled={!isAdmin}
              onChange={(e) => setForm({ ...form, isRecurring: e.target.checked })}
            />
            <span>
              <span className="font-medium">Recorrente</span>
              <span className="block text-xs" style={{ color: 'var(--text-muted)' }}>
                Marca esta entidade como fornecedor recorrente. A flag é normalmente
                atualizada pelo auto-flip quando ≥3 faturas estão associadas.
              </span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={form.isRecurringManualOverride === true}
              disabled={!isAdmin}
              onChange={(e) =>
                setForm({ ...form, isRecurringManualOverride: e.target.checked })
              }
            />
            <span>
              <span className="font-medium">Override ADMIN</span>
              <span className="block text-xs" style={{ color: 'var(--text-muted)' }}>
                Quando ativo, pausa o auto-flip em supplier-resolver — o valor de
                <code className="mx-1 px-1 rounded" style={{ background: 'var(--surface-2)' }}>isRecurring</code>
                permanece travado até ser desligado.
              </span>
            </span>
          </label>
        </div>
      )}

      {error && (
        <div className="rounded-md p-3 text-xs" style={{ background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.30)', color: 'var(--danger-fg)' }}>
          {error}
        </div>
      )}

      <div className="flex items-center justify-end gap-2">
        <button type="button" className="btn-secondary text-xs" onClick={() => router.back()}>Cancelar</button>
        <button type="submit" className="btn-primary text-sm" disabled={create.isPending || update.isPending}>
          {create.isPending || update.isPending ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
          Guardar
        </button>
      </div>
    </form>
  );
}

function Field({ label, children, full }: { label: string; children: React.ReactNode; full?: boolean }) {
  return (
    <div className={full ? 'sm:col-span-2' : ''}>
      <label className="text-xs font-medium uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>{label}</label>
      <div className="mt-1">{children}</div>
    </div>
  );
}