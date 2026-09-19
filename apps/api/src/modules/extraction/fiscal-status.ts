/**
 * Fase 3 — validade fiscal determinística e chave fiscal de duplicados.
 *
 * Tudo aqui é código puro e testado: a IA nunca decide se um documento é
 * fiscal. Regras (por ordem):
 *
 *   1. QR-AT válido → FISCAL. Válido = NIF do emitente com dígito de
 *      controlo certo + ATCUD (H) + hash (Q) + nº do certificado (R).
 *      Um QR-AT só existe em documentos certificados pela AT, por isso
 *      vence qualquer palavra-chave ("Ref. orçamento nº…" numa fatura real
 *      não a torna não-fiscal).
 *   2. Palavras-chave de documento não fiscal (proforma, orçamento,
 *      quotation, aviso de pagamento, extrato de conta…) → NAO_FISCAL, com
 *      o tipo correspondente, mesmo que pareça uma fatura.
 *   3. Fatura estrangeira: NIF-IVA UE sintaticamente válido + nº documento
 *      + data → FISCAL só quando o VIES já validou o NIF-IVA (Fase 4);
 *      até lá INDETERMINADO com motivo `vies_pending`.
 *   4. Caso contrário INDETERMINADO → revisão manual.
 */
import { isValidPortugueseNif } from '../../common/validation/tax-id.validator';

export type FiscalStatusValue = 'FISCAL' | 'NAO_FISCAL' | 'INDETERMINADO' | 'NAO_APLICAVEL';
export type NonFiscalType =
  | 'PROFORMA'
  | 'ORCAMENTO'
  | 'AVISO_PAGAMENTO'
  | 'EXTRATO_FORNECEDOR'
  | 'ENCOMENDA';

export interface FiscalClassificationInput {
  /** Parsed AT-QR (from packages/shared parseAtQr), when a real payload exists. */
  qr?: {
    issuerNif?: string;
    atcud?: string;
    hash4?: string;
    softwareCert?: string;
    documentType?: string;
  } | null;
  /** Where the QR came from — an AI read-back never proves certification. */
  qrOrigin?: 'zxing' | 'pdf-text' | 'stored' | 'ai' | null;
  supplierNif?: string | null;
  supplierVatId?: string | null;
  docNumber?: string | null;
  docDate?: string | null;
  /** Text to scan for non-fiscal keywords (PDF text / OCR / AI type / file name). */
  text?: string | null;
  viesValidated?: boolean;
  tenantNif?: string | null;
  customerNif?: string | null;
}

export interface FiscalClassification {
  fiscalStatus: FiscalStatusValue;
  reason: string;
  /** Set when the document type should be overridden (non-fiscal kinds, FS, FR, NC, ND, FATURA_RECEBIDA). */
  documentType?: NonFiscalType | 'FATURA_RECEBIDA' | 'FATURA_SIMPLIFICADA' | 'FATURA_RECIBO' | 'NOTA_CREDITO' | 'NOTA_DEBITO';
}

const NON_FISCAL_RULES: Array<{ type: NonFiscalType; pattern: RegExp }> = [
  { type: 'PROFORMA', pattern: /\b(pro[\s-]?forma|pr[oó][\s-]?forma|fatura\s+pro[\s-]?forma|proforma\s+invoice)\b/i },
  // Fase 4.1 — "oferta de venta" (ES) é o cabeçalho da TEFCOLD que o
  // sistema deixou passar como fatura; "quote"/"quotation" e as formas
  // alemãs entram aqui pela mesma razão.
  { type: 'ORCAMENTO', pattern: /\b(or[çc]amento|quota(?:tion|ç[ãa]o)|quote|devis|presupuesto|oferta\s+de\s+ven[dt]a|oferta\s+comercial|preventivo|kostenvoranschlag|angebot)\b/i },
  { type: 'AVISO_PAGAMENTO', pattern: /\b(aviso\s+de\s+(?:pagamento|cobran[çc]a|vencimento|d[eé]bito|lan[çc]amento)|payment\s+(?:notice|reminder|advice)|avis\s+de\s+paiement|aviso\s+de\s+pago)\b/i },
  { type: 'EXTRATO_FORNECEDOR', pattern: /\b(extra[ct]o\s+(?:de\s+)?(?:conta|fornecedor|cliente|movimentos)|account\s+statement|statement\s+of\s+account|relev[eé]\s+de\s+compte|extracto\s+de\s+cuenta)\b/i },
  // Fase 4.1 — uma nota de encomenda / confirmação de encomenda não é documento fiscal.
  {
    type: 'ENCOMENDA',
    pattern:
      /\b(confirma[çc][ãa]o\s*(?:de\s*)?encomenda|confirma[çc][ií]on\s*(?:de\s*)?pedido|order\s*confirmation|nota\s*de\s*encomenda|ordem\s*de\s*encomenda|purchase\s+order|pedido\s+de\s+compra|bon\s+de\s+commande|bestellung|bestellbest[aä]tigung)\b/i,
  },
];

/** Detect a non-fiscal document kind from free text. Order matters (first hit wins). */
export function detectNonFiscalKind(text: string | null | undefined): NonFiscalType | null {
  if (!text) return null;
  const t = text.normalize('NFC');
  const hasExplicitInvoiceTitle = /^\s*(?:FATURA|FACTURA|INVOICE|NOTA\s+DE\s+CR[EÉ]DITO|NOTA\s+DE\s+D[EÉ]BITO)\b/im.test(t);
  for (const rule of NON_FISCAL_RULES) {
    if (rule.type === 'ORCAMENTO' && hasExplicitInvoiceTitle) {
      const firstLine = t.split('\n')[0] || '';
      if (!rule.pattern.test(firstLine)) {
        continue;
      }
    }
    if (rule.pattern.test(t)) return rule.type;
  }
  return null;
}

/** VIES syntax check (shape only — registration is verified by the VIES service in Fase 4). */
export function isSyntacticallyValidEuVat(vat: string | null | undefined): boolean {
  if (!vat) return false;
  const v = vat.replace(/[\s.-]/g, '').toUpperCase();
  const m = v.match(/^([A-Z]{2})([A-Z0-9+*]{2,13})$/);
  if (!m) return false;
  const [, cc, rest] = m;
  const EU = new Set(['AT','BE','BG','CY','CZ','DE','DK','EE','EL','GR','ES','FI','FR','HR','HU','IE','IT','LT','LU','LV','MT','NL','PL','PT','RO','SE','SI','SK','XI']);
  if (!EU.has(cc)) return false;
  if (cc === 'PT') return isValidPortugueseNif(rest);
  return /^[A-Z0-9+*]{2,13}$/.test(rest);
}

/**
 * Formato oficial do ATCUD: `<código de validação>-<nº sequencial>`. O
 * código de validação atribuído pela AT tem 8 ou mais caracteres
 * alfanuméricos — o `ABC1234-56789` que o modelo inventou tem 7 e é
 * rejeitado por esta regra (Fase 4.1).
 */
export const ATCUD_PATTERN = /^[A-Z0-9]{8,}-\d+$/;

export function isValidAtQr(qr: FiscalClassificationInput['qr']): boolean {
  if (!qr) return false;
  if (!qr.issuerNif || !isValidPortugueseNif(qr.issuerNif)) return false;
  if (!qr.atcud || !ATCUD_PATTERN.test(qr.atcud.trim().toUpperCase())) return false;
  if (!qr.hash4 || qr.hash4.trim().length < 4) return false;
  if (!qr.softwareCert || !/^\d{1,5}$/.test(qr.softwareCert.trim())) return false;
  return true;
}

export function classifyFiscalStatus(input: FiscalClassificationInput): FiscalClassification {
  const kind = detectNonFiscalKind(input.text);
  const qrTrusted = input.qrOrigin !== 'ai' && isValidAtQr(input.qr);

  // P0.2 — Se o NIF da empresa (ex: 515208566) for o emitente/vendedor:
  // trata-se de documento interno/emitido ou encomenda de cliente destinada a nós -> NAO_APLICAVEL,
  // A MENOS que seja uma fatura simplificada / talão de despesa onde a empresa é o cliente adquirente!
  const tenantNifClean = (input.tenantNif || '').replace(/\D/g, '');
  const issuerNifClean = (input.qr?.issuerNif || input.supplierNif || '').replace(/\D/g, '');

  const rawQrType = (input.qr?.documentType ?? '').toUpperCase();
  const isSimplified =
    rawQrType === 'FS' ||
    rawQrType === 'FR' ||
    /\b(?:fatura\s+simplificada|factura\s+simplificada|\bFS\b|\bFR\b|fatura[\s/-]?recibo)\b/i.test(input.text || '');

  if (tenantNifClean && issuerNifClean && tenantNifClean === issuerNifClean) {
    if (isSimplified) {
      return {
        fiscalStatus: 'FISCAL',
        reason: 'simplified_invoice_expense',
        documentType: rawQrType === 'FR' ? 'FATURA_RECIBO' : 'FATURA_SIMPLIFICADA',
      };
    }
    const isExplicitInvoice =
      rawQrType === 'FT' ||
      rawQrType === 'NC' ||
      rawQrType === 'ND' ||
      /\b(?:fatura|factura|invoice|nota\s+de\s+cr[eé]dito)\b/i.test(input.text || '');
    if (isExplicitInvoice && !kind) {
      return {
        fiscalStatus: 'INDETERMINADO',
        reason: 'invoice_tenant_is_buyer_pending_supplier_review',
        documentType: rawQrType === 'NC' ? 'NOTA_CREDITO' : rawQrType === 'ND' ? 'NOTA_DEBITO' : 'FATURA_RECEBIDA',
      };
    }
    const nonFiscalType = kind ?? 'ENCOMENDA';
    return {
      fiscalStatus: 'NAO_APLICAVEL',
      reason: `own_company_is_issuer:${tenantNifClean}`,
      documentType: nonFiscalType,
    };
  }

  if (qrTrusted) {
    const rawDt = (input.qr?.documentType ?? '').toUpperCase();
    const fs = rawDt === 'FS';
    const fr = rawDt === 'FR';
    const nc = rawDt === 'NC';
    const nd = rawDt === 'ND';
    let docType: 'FATURA_SIMPLIFICADA' | 'FATURA_RECIBO' | 'NOTA_CREDITO' | 'NOTA_DEBITO' | undefined = undefined;
    if (fs) docType = 'FATURA_SIMPLIFICADA';
    else if (fr) docType = 'FATURA_RECIBO';
    else if (nc) docType = 'NOTA_CREDITO';
    else if (nd) docType = 'NOTA_DEBITO';

    return {
      fiscalStatus: 'FISCAL',
      reason: `qr_at_valid:atcud=${input.qr!.atcud},cert=${input.qr!.softwareCert}`,
      ...(docType ? { documentType: docType } : {}),
    };
  }
  if (kind) {
    return { fiscalStatus: 'NAO_FISCAL', reason: `keyword:${kind.toLowerCase()}`, documentType: kind };
  }
  const vat = input.supplierVatId ?? null;
  const foreign = vat && !/^PT/i.test(vat) && isSyntacticallyValidEuVat(vat);
  if (foreign && input.docNumber && input.docDate) {
    if (input.viesValidated) {
      return { fiscalStatus: 'FISCAL', reason: `foreign_vies_validated:${vat}` };
    }
    return { fiscalStatus: 'INDETERMINADO', reason: `vies_pending:${vat}` };
  }
  if (input.qr && !qrTrusted) {
    return {
      fiscalStatus: 'INDETERMINADO',
      reason: input.qrOrigin === 'ai' ? 'qr_from_ai_readback_not_certified' : 'qr_at_incomplete',
    };
  }
  if (input.supplierNif && isValidPortugueseNif(input.supplierNif)) {
    return { fiscalStatus: 'INDETERMINADO', reason: 'no_qr_at' };
  }
  return { fiscalStatus: 'INDETERMINADO', reason: 'insufficient_data' };
}

/**
 * Normalised document number for the fiscal key: upper-case, separators
 * removed, leading type token (FT/FR/FS/FA/FAC/FAT/NC/ND/RC/RG/VD/FTS)
 * dropped so "FT 2026A92/6384", "FT2026A92/6384" and "2026A92/6384" all
 * collide. Returns null when nothing meaningful remains.
 */
export function normalizeDocNumber(docNumber: string | null | undefined): string | null {
  if (!docNumber) return null;
  let v = docNumber.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
  v = v.replace(/[^A-Z0-9]/g, '');
  if (/^(FTS|FAC|FAT|FT|FR|FS|FA|NC|ND|RC|RG|RP|VD)$/.test(v)) return null; // bare type token
  v = v.replace(/^(FTS|FAC|FAT|FT|FR|FS|FA|NC|ND|RC|RG|RP|VD)(?=[A-Z0-9])/, '');
  return v.length >= 2 ? v : null;
}
