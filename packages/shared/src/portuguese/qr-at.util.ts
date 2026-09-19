/**
 * Parser e validação do QR Code de faturas portuguesas (especificações AT).
 * Formato: campos "CODIGO:valor" separados por '*'.
 * Portado e endurecido a partir de grok-documental/apps/api/src/extraction/at-qr.parser.ts.
 */

import { isFinalConsumerNif, isValidNif } from './nif.util';
import {
  IvaLine,
  IvaRegion,
  rateForKind,
  regionFromCode,
  roundMoney,
  validateIvaBreakdown,
} from './iva.util';

export interface AtQrIvaRegion {
  region?: string;
  baseExempt?: number;
  baseReduced?: number;
  taxReduced?: number;
  baseIntermediate?: number;
  taxIntermediate?: number;
  baseNormal?: number;
  taxNormal?: number;
}

export interface AtQrParsed {
  raw: string;
  fields: Record<string, string>;
  issuerNif?: string;
  buyerNif?: string;
  buyerCountry?: string;
  documentType?: string;
  documentStatus?: string;
  documentDate?: string;
  uniqueDocId?: string;
  atcud?: string;
  total?: number;
  totalTax?: number;
  withholding?: number;
  stampDuty?: number;
  other?: number;
  hash4?: string;
  softwareCert?: string;
  ivaBreakdown?: AtQrIvaRegion[];
}

export interface AtQrValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export interface AtcudParts {
  seriesCode: string;
  sequential: string;
}

const DOC_TYPE_MAP: Record<string, string> = {
  FT: 'fatura_recebida',
  FR: 'fatura_recebida',
  FS: 'fatura_recebida',
  NC: 'outro',
  ND: 'outro',
  RC: 'recibo',
  RG: 'recibo',
  RP: 'recibo',
};

const ATCUD_RE = /^[A-Z0-9]{6,10}-\d{1,20}$/i;

function parseMoney(v?: string): number | undefined {
  if (!v) return undefined;
  const n = parseFloat(v.replace(',', '.'));
  return Number.isFinite(n) ? n : undefined;
}

function parseDateAt(v?: string): string | undefined {
  if (!v || !/^\d{8}$/.test(v)) return undefined;
  return `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
}

export function isLikelyAtQr(text: string): boolean {
  if (!text || text.length < 10) return false;
  return /(?:^|\*)A:\d{9}/.test(text) || (text.includes('A:') && text.includes('*'));
}

export function parseAtcud(value?: string | null): AtcudParts | null {
  if (!value) return null;
  const v = value.trim();
  if (!ATCUD_RE.test(v)) return null;
  const idx = v.lastIndexOf('-');
  return { seriesCode: v.slice(0, idx).toUpperCase(), sequential: v.slice(idx + 1) };
}

export function parseAtQr(raw: string): AtQrParsed | null {
  if (!raw?.trim()) return null;
  const text = raw.trim();

  const fields: Record<string, string> = {};
  for (const part of text.split('*')) {
    const idx = part.indexOf(':');
    if (idx <= 0) continue;
    const code = part.slice(0, idx).trim().toUpperCase();
    const value = part.slice(idx + 1).trim();
    if (code) fields[code] = value;
  }

  if (!fields['A'] && !fields['O'] && !fields['H']) {
    return null;
  }

  const regions: AtQrIvaRegion[] = [];
  for (const prefix of ['I', 'J', 'K'] as const) {
    if (!fields[`${prefix}1`] && !fields[`${prefix}7`] && !fields[`${prefix}2`]) continue;
    regions.push({
      region: fields[`${prefix}1`],
      baseExempt: parseMoney(fields[`${prefix}2`]),
      baseReduced: parseMoney(fields[`${prefix}3`]),
      taxReduced: parseMoney(fields[`${prefix}4`]),
      baseIntermediate: parseMoney(fields[`${prefix}5`]),
      taxIntermediate: parseMoney(fields[`${prefix}6`]),
      baseNormal: parseMoney(fields[`${prefix}7`]),
      taxNormal: parseMoney(fields[`${prefix}8`]),
    });
  }

  const taxFromRegions = regions.reduce((s, r) => {
    return s + (r.taxReduced || 0) + (r.taxIntermediate || 0) + (r.taxNormal || 0);
  }, 0);

  const buyerRaw = fields['B'];
  return {
    raw: text,
    fields,
    issuerNif: fields['A'],
    buyerNif: buyerRaw && !isFinalConsumerNif(buyerRaw) ? buyerRaw : undefined,
    buyerCountry: fields['C'],
    documentType: fields['D'],
    documentStatus: fields['E'],
    documentDate: parseDateAt(fields['F']),
    uniqueDocId: fields['G'],
    atcud: fields['H'],
    total:
      parseMoney(fields['O']) ??
      parseMoney(fields['L']) ??
      parseMoney(fields['J']) ??
      parseMoney(fields['P']),
    totalTax:
      parseMoney(fields['N']) ??
      parseMoney(fields['K']) ??
      (taxFromRegions || undefined),
    withholding: parseMoney(fields['P']),
    stampDuty: parseMoney(fields['M']),
    other: parseMoney(fields['L']),
    hash4: fields['Q'],
    softwareCert: fields['R'],
    ivaBreakdown: regions.length ? regions : undefined,
  };
}

function regionToLines(block: AtQrIvaRegion): IvaLine[] {
  const region: IvaRegion = regionFromCode(block.region);
  const lines: IvaLine[] = [];
  const push = (
    base: number | undefined,
    tax: number | undefined,
    kind: NonNullable<IvaLine['kind']>,
  ) => {
    if (base == null && (tax == null || tax === 0) && kind !== 'exempt') return;
    if (kind === 'exempt' && (base == null || base === 0)) return;
    const rate = rateForKind(kind, region);
    lines.push({
      base: base ?? 0,
      tax: kind === 'exempt' ? 0 : (tax ?? 0),
      rate,
      kind,
      region,
      exemptionCode: kind === 'exempt' ? 'M99' : undefined,
    });
  };
  push(block.baseExempt, 0, 'exempt');
  push(block.baseReduced, block.taxReduced, 'reduced');
  push(block.baseIntermediate, block.taxIntermediate, 'intermediate');
  push(block.baseNormal, block.taxNormal, 'normal');
  return lines;
}

export function validateAtQr(parsed: AtQrParsed): AtQrValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!parsed.issuerNif || !isValidNif(parsed.issuerNif)) {
    errors.push(`NIF emitente inválido (${parsed.issuerNif ?? 'ausente'})`);
  }
  if (parsed.buyerNif && !isValidNif(parsed.buyerNif)) {
    errors.push(`NIF adquirente inválido (${parsed.buyerNif})`);
  }
  if (!parsed.documentType) errors.push('tipo de documento (D) ausente');
  if (!parsed.documentDate) errors.push('data (F) ausente ou inválida — esperado YYYYMMDD');
  if (!parsed.uniqueDocId) warnings.push('identificador único (G) ausente');
  if (!parsed.atcud) {
    errors.push('ATCUD (H) ausente');
  } else if (!parseAtcud(parsed.atcud)) {
    errors.push(`ATCUD inválido (${parsed.atcud})`);
  }
  if (parsed.total == null) errors.push('total (O) ausente');
  if (parsed.hash4 && !/^[A-Z0-9]{4}$/i.test(parsed.hash4)) {
    warnings.push('hash Q deve ter 4 caracteres [A-Z0-9]');
  }
  if (!parsed.softwareCert) warnings.push('certificado software (R) ausente');

  const lines: IvaLine[] = (parsed.ivaBreakdown ?? []).flatMap(regionToLines);
  if (lines.length) {
    const check = validateIvaBreakdown(lines, {
      totalTax: parsed.totalTax,
    });
    if (!check.ok) errors.push(...check.errors.map((e) => `IVA: ${e}`));
    if (parsed.total != null) {
      const reconstructed = roundMoney(
        check.summedGross + (parsed.stampDuty || 0) + (parsed.other || 0) - (parsed.withholding || 0),
      );
      if (Math.abs(reconstructed - parsed.total) > 0.05) {
        warnings.push(`total O=${parsed.total} ≠ bases+IVA+selo-retenção ${reconstructed}`);
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

export function parseAndValidateAtQr(raw: string): {
  parsed: AtQrParsed | null;
  validation: AtQrValidation;
} {
  const parsed = parseAtQr(raw);
  if (!parsed) {
    return { parsed: null, validation: { ok: false, errors: ['payload QR-AT irreconhecível'], warnings: [] } };
  }
  return { parsed, validation: validateAtQr(parsed) };
}

export function atQrToDocumentFields(parsed: AtQrParsed) {
  const mappedType = parsed.documentType
    ? DOC_TYPE_MAP[parsed.documentType.toUpperCase()] || 'fatura_recebida'
    : 'fatura_recebida';

  return {
    nif: parsed.issuerNif,
    supplierNif: parsed.issuerNif,
    customerNif: parsed.buyerNif,
    docNumber: parsed.uniqueDocId || parsed.atcud,
    atcud: parsed.atcud,
    docDate: parsed.documentDate,
    total: parsed.total,
    iva: parsed.totalTax,
    type: mappedType,
    currency: 'EUR' as const,
    hash4: parsed.hash4,
    softwareCert: parsed.softwareCert,
  };
}

export function buildAtQr(fields: Record<string, string | number | undefined | null>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v == null || v === '') continue;
    parts.push(`${k.toUpperCase()}:${v}`);
  }
  return parts.join('*');
}
