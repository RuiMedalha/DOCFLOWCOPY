/**
 * buildDocumentPath — deterministic storage-key builder for the
 * party/category-aware folder layout that Sprint E introduces.
 *
 * Folder shape:
 *   fornecedores/<slug>/<YYYY-MM>/<docNum>-<fileId8>.<ext>
 *   clientes/<slug>/<YYYY-MM>/...
 *   despesas/<YYYY-MM>/<docNum>-<fileId8>.<ext>           (no party)
 *
 * Notes:
 *   - The function is PURE — same input always yields the same output. This
 *     is the contract callers rely on for dedup and idempotency.
 *   - AMBOS (a party flagged as both supplier and customer) is routed to
 *     `fornecedores/` per the explicit product decision (Sprint E brief).
 *   - partySlug is required when partyType is set; missing slug falls back
 *     to `despesas/` so the file is never orphaned at the storage root.
 *   - documentNumber is sanitized to kebab-case (no `/`, no spaces).
 *   - extension is normalised: lowercase, no leading dot.
 *   - fileId is sliced to 8 chars (UUID v4 prefix) — short enough for URLs
 *     and still collision-resistant in any single tenant.
 */

import {
  generateStandardFileName,
  StandardFileNameInput,
} from './filename-standardizer';

export type PartyTypeInput = 'FORNECEDOR' | 'CLIENTE' | 'AMBOS' | null;

export interface BuildPathInput {
  /** PartyType from the master Party record. `null` ⇒ no party. */
  partyType: PartyTypeInput;
  /** slug of the party (kebab-case ASCII). `null` ⇒ fall back to despesas/. */
  partySlug: string | null;
  /**
   * Optional category slug to nest under the party folder. When `null` the
   * category segment is omitted (file lives at fornecedores/<slug>/<YYYY-MM>/).
   */
  partyCategorySlug: string | null;
  /** Date used to bucket the file into YYYY-MM (UTC). */
  documentDate: Date;
  /** Document number — sanitized to kebab-case. */
  documentNumber: string;
  /** UUID-like stable identifier for this file (sliced to 8 chars). */
  fileId: string;
  /** File extension without leading dot, e.g. 'pdf', 'jpg'. */
  extension: string;
  /** Optional explicit standard filename {TIPO}_{FORNECEDOR}_{NUMERO}_{DATA}.pdf */
  standardFileName?: string;
  /** Optional document type to generate standard filename */
  docType?: string | null;
  /** Optional supplier name for standard filename */
  supplierName?: string | null;
  /** When true, bucket by year only (YYYY) instead of (YYYY-MM) */
  yearOnly?: boolean;
}

function formatYear(d: Date): string {
  const safe = d instanceof Date && !Number.isNaN(d.getTime()) ? d : new Date();
  return String(safe.getUTCFullYear());
}

function formatMonth(d: Date): string {
  const safe = d instanceof Date && !Number.isNaN(d.getTime()) ? d : new Date();
  const yyyy = String(safe.getUTCFullYear());
  const mm = String(safe.getUTCMonth() + 1).padStart(2, '0');
  return `${yyyy}-${mm}`;
}

function sanitizeDocNumber(input: string | null | undefined): string {
  if (!input) return 'unnumbered';
  return (
    input
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'unnumbered'
  );
}

function sanitizeExtension(input: string | null | undefined): string {
  if (!input) return '';
  return input.replace(/^\.+/, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function buildDocumentPath(input: BuildPathInput): string {
  const dateFolder = input.yearOnly
    ? formatYear(input.documentDate)
    : formatMonth(input.documentDate);

  let filename: string;
  if (input.standardFileName) {
    filename = input.standardFileName;
  } else if (input.docType) {
    filename = generateStandardFileName({
      type: input.docType,
      supplier: input.supplierName ?? input.partySlug,
      docNumber: input.documentNumber,
      docDate: input.documentDate,
      extension: input.extension,
    });
  } else {
    const uuid8 = (input.fileId ?? '').slice(0, 8) || 'no-id';
    const docNum = sanitizeDocNumber(input.documentNumber);
    const ext = sanitizeExtension(input.extension);
    filename = ext ? `${docNum}-${uuid8}.${ext}` : `${docNum}-${uuid8}`;
  }

  // No party OR missing slug ⇒ despesas/ bucket.
  if (!input.partyType || !input.partySlug) {
    return `despesas/${dateFolder}/${filename}`;
  }

  // AMBOS routes to fornecedores/ per the Sprint E product decision.
  const root = input.partyType === 'CLIENTE' ? 'clientes' : 'fornecedores';
  const categorySegment = input.partyCategorySlug
    ? `${input.partyCategorySlug}/`
    : '';
  return `${root}/${input.partySlug}/${categorySegment}${dateFolder}/${filename}`;
}
