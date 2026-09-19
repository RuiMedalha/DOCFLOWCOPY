/**
 * DocFlow — Parties module types (master Party + accounts + IBAN risk).
 */

export type PartyType = 'FORNECEDOR' | 'CLIENTE' | 'AMBOS';
export type AccountType = 'ATIVO' | 'PASSIVO' | 'CAPITAL_PROPRIO' | 'RECEITA' | 'CUSTO' | 'OUTRO';

/**
 * Sprint E: operator-defined buckets that segment the master Party list.
 * Drives the on-disk folder layout in `fornecedores/<slug>/<category>/...`.
 * Distinct from the `Category` model which classifies a Document by
 * expense type.
 */
export interface PartyCategory {
  id: string;
  slug: string;
  name: string;
  color?: string | null;
  sortOrder?: number;
}

export interface Party {
  id: string;
  type: PartyType;
  name: string;
  /**
   * Sprint E: kebab-case ASCII of `name`, persisted by the backend on
   * create / PATCH (with `<slug>-<id4>` suffix on collision). Stable
   * across renames — used in the on-disk folder path so a party rename
   * does NOT move existing files.
   */
  slug?: string | null;
  /**
   * Sprint E: PartyCategory.id — operator-assigned bucket (Estratégico,
   * Operacional, Consultor / Serviços, Recorrente). Null ⇒ unclassified.
   */
  partyCategoryId?: string | null;
  partyCategory?: PartyCategory | null;
  nif?: string | null;
  email?: string | null;
  phone?: string | null;
  mobile?: string | null;
  iban?: string | null;
  bic?: string | null;
  address?: string | null;
  city?: string | null;
  postalCode?: string | null;
  country?: string | null;
  website?: string | null;
  ibanVerified: boolean;
  ibanVerifiedAt?: string | null;
  ibanFlagged: boolean;
  ibanFlaggedReason?: string | null;
  ibanLastCheckedAt?: string | null;
  ibanRiskScore?: number | null;
  ibanMasked?: string | null;
  isActive: boolean;
  /**
    * Backend flips this true when the supplier has >=3 linked documents
    * (SupplierResolver.refreshRecurringFlag). The party page surfaces
    * it as a "Recorrente / Ocasional" badge — no UI override, the value
    * is always derived from the document count.
    */
  isRecurring?: boolean | null;
  /**
   * ADMIN-only flag that freezes `isRecurring` so the auto-flip in
   * supplier-resolver pauses. Set via PATCH /parties/:id; rendered as
   * an amber "Override ADMIN" badge in the list and header.
   */
  isRecurringManualOverride?: boolean | null;
  defaultDebitAccount?: { id: string; code: string; name: string } | null;
  defaultCreditAccount?: { id: string; code: string; name: string } | null;
  // Fase 4 — perfil fiscal/comercial + VIES
  vatNumber?: string | null;
  vatRegime?: VatRegime | null;
  currency?: string | null;
  directDebit?: boolean | null;
  billingEmail?: string | null;
  defaultCategoryId?: string | null;
  defaultCategory?: { id: string; name: string; slug: string } | null;
  paymentTermDays?: number | null;
  viesValidatedAt?: string | null;
  viesValid?: boolean | null;
  viesName?: string | null;
  viesAddress?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Fase 4 — regime de IVA do fornecedor. */
export type VatRegime = 'PT' | 'UE_REVERSE_CHARGE' | 'EXTRA_UE';

/** Fase 4 — produto comprado a um fornecedor (GET /parties/:id/products). */
export interface PartyProduct {
  key: string;
  code: string | null;
  description: string;
  timesBought: number;
  totalQuantity: number;
  totalSpent: number;
  lastUnitPrice: number | null;
  lastDate: string | null;
  lastDocumentId: string | null;
}

export interface PartyListResponse {
  items: Party[];
  meta: { total: number; page: number; limit: number; totalPages: number };
}

export interface PartyFilters {
  search: string;
  type: '' | PartyType;
  isActive: '' | 'true' | 'false';
  ibanOnly: boolean;
}

export interface Account {
  id: string;
  code: string;
  name: string;
  type: AccountType;
  parentId?: string | null;
  isActive: boolean;
  createdAt: string;
}

export interface AccountListResponse {
  items: Account[];
  meta: { total: number; page: number; limit: number; totalPages: number };
}

export interface IbanHistoryEntry {
  id: string;
  oldIban: string | null;
  newIban: string;
  changedBy: string;
  changedByName?: string;
  reason?: string | null;
  verified: boolean;
  createdAt: string;
}

export interface IbanRiskBreakdownItem {
  factor: string;
  score: number;
  reason: string;
}

export interface IbanRiskReport {
  iban: string;
  blacklistMatch: boolean;
  blacklistReason?: string;
  riskScore: number;
  recommendedAction: 'allow' | 'review' | 'block';
  breakdown: IbanRiskBreakdownItem[];
}

export interface IbanBlacklistEntry {
  id: string;
  iban: string;
  reason: string;
  source: string;
  createdAt: string;
}

/**
 * Document projected onto the party-detail page (the "Faturas recentes"
 * section). Mirrors a subset of the Document DTO so we don't have to
 * fetch the full inbox item. Status enum matches DocumentStatus on the
 * backend; the UI maps it to a coloured badge.
 */
export interface PartyDocument {
  id: string;
  docNumber?: string | null;
  supplier?: string | null;
  customer?: string | null;
  supplierNif?: string | null;
  customerNif?: string | null;
  docDate?: string | null;
  total?: number | null;
  netAmount?: number | null;
  taxAmount?: number | null;
  currency?: string | null;
  // Fase 4.2 (P0.4) — faltavam PENDING_APPROVAL/CHANGES_REQUESTED/DUPLICADO
  // (o enum real do Prisma), por isso duas em três linhas do IKEA não
  // mostravam estado nenhum: o lookup por este tipo devolvia undefined.
  status:
    | 'NOVO'
    | 'EM_REVISAO'
    | 'APROVADO'
    | 'REJEITADO'
    | 'CONCILIADO'
    | 'PAGO'
    | 'ARQUIVADO'
    | 'PENDING_APPROVAL'
    | 'CHANGES_REQUESTED'
    | 'DUPLICADO';
  type?: string | null;
  fileName?: string | null;
  partyId?: string | null;
  folder?: { id: string; name: string; pattern: string } | null;
  createdAt: string;
  updatedAt?: string;
}

export interface PartyInput {
  type: PartyType;
  name: string;
  nif?: string;
  email?: string;
  phone?: string;
  mobile?: string;
  iban?: string;
  bic?: string;
  address?: string;
  city?: string;
  postalCode?: string;
  country?: string;
  website?: string;
  defaultDebitAccountId?: string;
  defaultCreditAccountId?: string;
  /** Sprint E: PartyCategory.id, or empty string to clear. */
  partyCategoryId?: string;
  isRecurring?: boolean;
  isRecurringManualOverride?: boolean;
  // Fase 4
  vatNumber?: string;
  vatRegime?: VatRegime;
  currency?: string;
  directDebit?: boolean;
  billingEmail?: string;
  defaultCategoryId?: string;
  paymentTermDays?: number;
}

// =============================================================================
// Sprint G — Party 360° file add-ons (contacts, addresses, payments, timeline)
// =============================================================================

/**
 * Named contact on a Party. Independent of the legacy `Party.email` /
 * `Party.phone` / `Party.mobile` flatten columns — admin populates the
 * new list manually via UI (no automatic data migration in Sprint G.1).
 */
export interface PartyContact {
  id: string;
  partyId: string;
  name: string;
  role?: string | null;
  email?: string | null;
  phone?: string | null;
  notes?: string | null;
  createdAt: string;
  updatedAt: string;
}

export type PartyAddressType =
  | 'BILLING'
  | 'CORRESPONDENCE'
  | 'OPERATIONAL'
  | 'OTHER';

export interface PartyAddress {
  id: string;
  partyId: string;
  type: PartyAddressType;
  line1: string;
  line2?: string | null;
  postalCode?: string | null;
  city?: string | null;
  country: string;
  isPrimary: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Single payment event tied to a party's documents. */
export interface PartyPaymentEvent {
  id: string;
  documentId: string;
  /**
   * Sprint G review §A1 fix-up: `fileKey` intentionally OMITTED. fileKey
   * is the on-disk storage path (`tenants/<id>/<year>/<month>/<id>.pdf`)
   * — exposing it leaks the tenant's folder layout. UI uses `docNumber`
   * as the human-readable label (see payments-tab.tsx).
   */
  document: { id: string; docNumber: string | null } | null;
  dueDate: string;
  amount: string | null;
  status: 'PENDING' | 'PAID' | 'OVERDUE';
  paidAt: string | null;
  paidAmount: string | null;
  paymentMethod?: string | null;
  notes?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Discriminated union of timeline events. */
export type TimelineEventType =
  | 'audit'
  | 'payment'
  | 'iban_change'
  | 'document_approved';

export type TimelineEvent =
  | {
      id: string;
      type: 'audit';
      at: string;
      action: string;
      userId: string | null;
      metadata: unknown;
    }
  | {
      id: string;
      type: 'payment';
      at: string;
      amount: string | null;
      status: string;
      documentId: string;
      // Sprint G review §A1 fix-up: fileKey intentionally OMITTED — see
      // PartyPaymentEvent above for the rationale.
      document: { id: string; docNumber: string | null } | null;
    }
  | {
      id: string;
      type: 'iban_change';
      at: string;
      oldIban: string | null;
      newIban: string;
      verified: boolean;
      changedById: string | null;
    }
  | {
      id: string;
      type: 'document_approved';
      at: string;
      documentId: string;
      fileName: string;
      docNumber: string | null;
      approvedById: string | null;
    };

export interface TimelineListResponse {
  items: TimelineEvent[];
  nextCursor: string | null;
}

/** Attach to Party payload for the 360° file. */
export interface PartyExtras {
  contacts?: PartyContact[];
  addresses?: PartyAddress[];
}