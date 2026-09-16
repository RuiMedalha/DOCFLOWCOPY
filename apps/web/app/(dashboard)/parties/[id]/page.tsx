'use client';

import { useParams } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Loader2, Repeat } from 'lucide-react';
import { PageHeader } from '../../_components/page-header';
import { PartyForm } from '../_components/party-form';
import { useParty, usePartyContacts, usePartyPayments } from '../_components/use-parties';
import { useUser } from '@/_lib/use-dashboard-queries';
import type { PartyInput } from '../_lib/types';

import { PartyTabs, usePartyTabFromUrl } from './_components/party-tabs';
import { ContactsTab } from './_components/contacts-tab';
import { AddressesTab } from './_components/addresses-tab';
import { DocumentsTab } from './_components/documents-tab';
import { PaymentsTab } from './_components/payments-tab';
import { IbanTab } from './_components/iban-tab';
import { TimelineTab } from './_components/timeline-tab';

import { PartyEnrichmentBadge } from './_components/party-enrichment-badge';
import { ViesPanel } from './_components/vies-panel';
import { ProductsTab } from './_components/products-tab';
import { PartyDetailCard } from '../_components/party-detail';
/**
 * PartyDetailPage — Sprint G 360° file. 6 tabs:
 *   - Identity   (default) — the existing PartyForm (kept as-is)
 *   - Contacts   — named contacts + add/edit/delete dialogs (ADMIN)
 *   - Documents  — recent documents (FORNECEDOR-only, reuses existing component)
 *   - Payments   — list of PaymentEvent with status badges + EUR totals
 *   - IBAN       — risk-score donut + history + verify/flag actions
 *   - Timeline   — aggregated vertical list across 4 sources
 *
 * Deep-linkable: `?tab=payments` opens the party on that tab. Default
 * is `identity` (the operator's most common entry point after creating
 * or editing a party).
 */
export default function PartyDetailPage() {
  const params = useParams<{ id: string }>();
  const { data: party, isLoading } = useParty(params.id);
  const user = useUser();
  const isAdmin = user?.role === 'ADMIN';
  const activeTab = usePartyTabFromUrl();

  // Per-tab counts for the badge in the tab nav. Each query is cheap
  // (the backend caps at 50) so we fire all of them up front to avoid a
  // waterfall of re-renders as the user clicks through tabs.
  const contacts = usePartyContacts(params.id);
  const payments = usePartyPayments(params.id);

  if (isLoading) {
    return (
      <div className="card p-6 text-sm" style={{ color: 'var(--text-muted)' }}>
        <Loader2 size={14} className="inline animate-spin mr-2" /> A carregar…
      </div>
    );
  }
  if (!party) {
    return <div className="card p-6 text-sm text-red-500">Entidade não encontrada.</div>;
  }

  // Fase 4.2 (P1.2) — o formulário nunca recebia `vatNumber`/`vatRegime`,
  // por isso "NIF-IVA UE" aparecia sempre vazio (mostrando o placeholder
  // com ar de dado real) e "Regime de IVA" caía sempre no valor por
  // omissão ("Portugal") mesmo quando o VIES já tinha confirmado
  // autoliquidação. E `party.nif` guarda, internamente, o NIF-IVA
  // completo com prefixo de país para fornecedores estrangeiros já
  // validados (é a chave de identidade usada nas procuras) — mostrá-lo
  // tal e qual no campo "NIF (9 dígitos)" é enganador, por isso só o
  // populamos quando é mesmo um NIF português de 9 dígitos.
  const nifLooksPortuguese = /^\d{9}$/.test(party.nif ?? '');
  const initial: PartyInput = {
    type: party.type,
    name: party.name,
    nif: nifLooksPortuguese ? party.nif ?? '' : '',
    vatNumber: party.vatNumber || (!nifLooksPortuguese && party.nif ? party.nif : ''),
    vatRegime: party.vatRegime ?? 'PT',
    email: party.email ?? '',
    website: (party as any).website ?? '',
    billingEmail: party.billingEmail ?? '',
    phone: party.phone ?? '',
    mobile: party.mobile ?? '',
    iban: party.iban ?? '',
    bic: party.bic ?? '',
    address: party.address ?? '',
    city: party.city ?? '',
    postalCode: party.postalCode ?? '',
    country: party.country ?? 'Portugal',
    defaultDebitAccountId: party.defaultDebitAccount?.id,
    defaultCreditAccountId: party.defaultCreditAccount?.id,
    defaultCategoryId: party.defaultCategoryId ?? '',
    paymentTermDays: party.paymentTermDays ?? 30,
    directDebit: party.directDebit === true,
    isRecurring: party.isRecurring === true,
    isRecurringManualOverride: party.isRecurringManualOverride === true,
  };

  const hasOverride = party.isRecurringManualOverride === true;
  const isRecurring = party.isRecurring === true;
  const showRecentDocs = party.type === 'FORNECEDOR';

  return (
    <>
      <Link href="/parties" className="text-xs inline-flex items-center gap-1 mb-3" style={{ color: 'var(--text-muted)' }}>
        <ArrowLeft size={12} /> Voltar
      </Link>
      <PageHeader
        title={party.name}
        subtitle={`NIF ${party.nif ?? '—'} · ${party.type}`}
        actions={
          <>
          <span
            className={
              hasOverride
                ? 'badge-amber'
                : isRecurring
                ? 'badge-emerald'
                : 'badge-neutral'
            }
            title={
              hasOverride
                ? 'Override ADMIN — isRecurring travado, auto-flip pausado'
                : isRecurring
                ? 'Fornecedor recorrente — ≥3 faturas associadas'
                : 'Fornecedor ocasional'
            }
          >
            <Repeat size={10} className="mr-0.5" aria-hidden="true" />
            {hasOverride ? 'Override ADMIN' : isRecurring ? 'Recorrente' : 'Ocasional'}
          </span>
          <PartyEnrichmentBadge partyId={params.id} isAdmin={isAdmin} />
          </>
        }
      />

      <div className="mb-4">
        <PartyTabs
          partyId={params.id}
          active={activeTab}
          counts={{
            contacts: contacts.data?.items.length ?? 0,
            payments: payments.data?.length ?? 0,
          }}
        />
      </div>

      {activeTab === 'identity' && (
        <div className="space-y-5">
          <PartyDetailCard party={party} />
          <div className="grid lg:grid-cols-3 gap-5">
            <div className="lg:col-span-2 space-y-5">
              <PartyForm key={`${party.id}-${party.updatedAt ?? ''}`} initial={initial} partyId={params.id} isAdmin={isAdmin} />
            </div>
            {/* The PartyIbanPanel previously lived here on the Identity tab.
                Sprint G moves it into the IBAN tab to avoid duplication. */}
            <div className="space-y-5">
              {/* Fase 4 — VIES / regime de IVA */}
              <ViesPanel partyId={params.id} />
            </div>
          </div>
        </div>
      )}

      {activeTab === 'products' && (
        <ProductsTab partyId={params.id} />
      )}

      {activeTab === 'contacts' && (
        <ContactsTab partyId={params.id} isAdmin={isAdmin} />
      )}

      {activeTab === 'documents' && showRecentDocs && (
        <DocumentsTab partyId={params.id} />
      )}

      {activeTab === 'documents' && !showRecentDocs && (
        <div className="card p-6 text-sm text-muted">
          Documentos recentes só são listados para fornecedores
          (clientes e fornecedores-clientes têm faturas em volumes diferentes).
        </div>
      )}

      {activeTab === 'payments' && (
        <PaymentsTab partyId={params.id} />
      )}

      {activeTab === 'iban' && (
        <IbanTab partyId={params.id} isAdmin={isAdmin} />
      )}

      {activeTab === 'timeline' && (
        <TimelineTab partyId={params.id} />
      )}
    </>
  );
}

