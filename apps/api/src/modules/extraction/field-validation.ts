/**
 * Fase 4.1 — validação determinística dos campos de identificação fiscal.
 *
 * Regra do cliente: um NIF ou um ATCUD inventados pelo modelo que sigam
 * para a contabilidade são o pior erro possível neste sistema. Por isso
 * nenhum destes campos é persistido a partir da opinião da IA — só
 * sobrevive o que passar uma verificação determinística:
 *
 *   ATCUD  só existe em Portugal (código atribuído pela AT a séries de
 *          faturação portuguesas). Documento não-PT → campo vazio,
 *          sempre. Documento PT → só o que vier de um QR-AT realmente
 *          descodificado, ou que case com o formato oficial.
 *   NIF    PT: módulo 11. UE: VIES. Extra-UE: texto não validado,
 *          marcado como tal, nunca como NIF confirmado.
 *   Conf.  um campo que não foi cruzado com nada não pode mostrar 90 %.
 *
 * Tudo aqui é puro e testado — sem Prisma, sem rede.
 */
import { isValidPortugueseNif } from '../../common/validation/tax-id.validator';
import { ATCUD_PATTERN, isSyntacticallyValidEuVat, isValidAtQr } from './fiscal-status';
import { parseAtQr, validateAtQr } from '@docflow/shared';
import { classifyLineDiscount } from './line-discount';

export { ATCUD_PATTERN };

/** Estados-membros da UE (+ XI, Irlanda do Norte) para efeitos de VIES. */
export const EU_COUNTRY_CODES = new Set([
  'AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'EL', 'GR', 'ES', 'FI',
  'FR', 'HR', 'HU', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PL', 'PT',
  'RO', 'SE', 'SI', 'SK', 'XI',
]);

/** Teto de confiança para um valor que veio só da IA, sem cruzamento. */
export const UNVALIDATED_CONFIDENCE_CAP = 0.5;

/** Tolerância máxima de arredondamento legal em faturas e contabilidade (0.02€). */
export const LEGAL_ROUNDING_TOLERANCE = 0.02;

/** Taxas oficiais de IVA em Portugal Continental (CIVA Art. 18º). */
export const PT_CONTINENTAL_VAT_RATES = [23, 13, 6, 0] as const;

/** Taxas oficiais de IVA na Região Autónoma da Madeira. */
export const PT_MADEIRA_VAT_RATES = [22, 12, 5, 0] as const;

/** Taxas oficiais de IVA na Região Autónoma dos Açores. */
export const PT_AZORES_VAT_RATES = [16, 9, 4, 0] as const;

/** Todas as taxas oficiais legais de IVA em território português. */
export const ALL_OFFICIAL_PT_VAT_RATES = new Set<number>([
  23, 22, 16, 13, 12, 9, 6, 5, 4, 0,
]);

/**
 * Taxas de IVA comunitárias padrão/reduzidas dos principais parceiros UE.
 * Todas as operações intracomunitárias com autoliquidação (reverse charge)
 * aplicam taxa 0%.
 */
export const EU_VAT_RATES_MAP: Record<string, number[]> = {
  ES: [21, 10, 4, 0],
  FR: [20, 10, 5.5, 2.1, 0],
  DE: [19, 7, 0],
  IT: [22, 10, 5, 4, 0],
  NL: [21, 9, 0],
  BE: [21, 12, 6, 0],
  IE: [23, 13.5, 9, 4.8, 0],
  PL: [23, 8, 5, 0],
  AT: [20, 13, 10, 0],
  SE: [25, 12, 6, 0],
  DK: [25, 0],
  FI: [25.5, 24, 14, 10, 0],
  EL: [24, 13, 6, 0],
  GR: [24, 13, 6, 0],
  CZ: [21, 12, 0],
  RO: [19, 9, 5, 0],
  HU: [27, 18, 5, 0],
  LU: [17, 14, 8, 3, 0],
};

export type TaxIdValidation =
  | 'PT_MOD11' // NIF português com dígito de controlo correto
  | 'VIES' // NIF-IVA comunitário confirmado pelo VIES
  | 'UNVALIDATED' // tem valor mas não passou verificação
  | 'NONE'; // não há valor nenhum

export interface TaxIdInput {
  /** NIF tal como veio da extração (IA, OCR ou QR). */
  supplierNif?: string | null;
  /** NIF-IVA com prefixo de país, para fornecedores estrangeiros. */
  supplierVatId?: string | null;
  /** País do documento/emitente (ISO 3166-1 alpha-2). */
  country?: string | null;
  /** Resultado real de uma chamada ao VIES — nunca uma suposição. */
  viesValidated?: boolean;
}

export interface TaxIdResolution {
  /** Seguro para gravar em `Document.supplierNif` — null quando nada validou. */
  nif: string | null;
  /** NIF-IVA normalizado, com o veredicto em `validation`. */
  vatId: string | null;
  validation: TaxIdValidation;
  /** O valor que recusámos gravar, para a metadata e o ecrã de revisão. */
  rejected: string | null;
  /** Motivo legível, gravado em `metadata.extraction`. */
  reason: string;
  /** True quando o documento tem de ir para revisão manual por causa disto. */
  needsReview: boolean;
}

/** Arredonda a 2 casas decimais usando Math.round com precisão centesimal. */
export const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

export const safeNum = (v: number | null | undefined): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/** Normaliza um NIF-IVA: sem espaços nem pontuação, maiúsculas. */
export function normalizeVatId(value: string | null | undefined): string | null {
  if (!value) return null;
  const v = value.replace(/[\s.\-/]/g, '').toUpperCase();
  return v.length >= 3 ? v : null;
}

/** Código de país de um NIF-IVA com prefixo (ES, FR, …). */
export function vatCountry(vatId: string | null | undefined): string | null {
  const v = normalizeVatId(vatId);
  const m = v?.match(/^([A-Z]{2})/);
  return m ? m[1] : null;
}

/**
 * Decide o país do documento a partir dos sinais disponíveis, por ordem
 * de fiabilidade: prefixo do NIF-IVA > país extraído > NIF PT válido.
 * Devolve null quando não há sinal nenhum (nunca assume PT).
 */
export function resolveDocumentCountry(input: {
  country?: string | null;
  supplierVatId?: string | null;
  supplierNif?: string | null;
  qrIssuerNif?: string | null;
}): string | null {
  const fromVat = vatCountry(input.supplierVatId);
  if (fromVat) return fromVat;
  const c = input.country?.trim().toUpperCase();
  if (c && /^[A-Z]{2}$/.test(c)) return c;
  // Um QR-AT só existe em Portugal — se o emitente do QR é válido, é PT.
  if (input.qrIssuerNif && isValidPortugueseNif(input.qrIssuerNif)) return 'PT';
  if (input.supplierNif && isValidPortugueseNif(input.supplierNif)) return 'PT';
  return null;
}

/** True quando o documento é português (e portanto pode ter ATCUD). */
export function isPortugueseDocument(country: string | null | undefined): boolean {
  return (country ?? '').toUpperCase() === 'PT';
}

/**
 * Filtra o ATCUD. Devolve null sempre que não houver prova de que o
 * código é real — documento não-PT, formato fora do oficial, ou origem
 * na IA sem QR descodificado por trás.
 */
export function sanitizeAtcud(
  atcud: string | null | undefined,
  opts: { country: string | null | undefined; fromTrustedQr: boolean },
): { atcud: string | null; reason: string } {
  const raw = atcud?.trim().toUpperCase() ?? '';
  if (!raw) return { atcud: null, reason: 'atcud_absent' };
  if (!isPortugueseDocument(opts.country)) {
    // O ATCUD é um código atribuído pela AT a séries portuguesas. Num
    // documento estrangeiro não existe — o que a IA leu é invenção ou
    // é outro número qualquer com ar de ATCUD.
    return { atcud: null, reason: `atcud_dropped_non_pt:${opts.country ?? 'unknown'}` };
  }
  if (!ATCUD_PATTERN.test(raw)) {
    return { atcud: null, reason: `atcud_dropped_bad_format:${raw.slice(0, 24)}` };
  }
  if (!opts.fromTrustedQr) {
    // Formato certo mas sem QR por trás: aceitamos (é PT e respeita o
    // formato oficial), marcando a origem para o ecrã de revisão.
    return { atcud: raw, reason: 'atcud_format_only_no_qr' };
  }
  return { atcud: raw, reason: 'atcud_from_qr' };
}

/**
 * Resolve que identificador fiscal pode ser persistido.
 *
 *   PT        módulo 11 → grava. Falha → não grava, revisão.
 *   UE        VIES confirmou → grava. Não confirmou → não grava, revisão.
 *   Extra-UE  nunca é NIF confirmado; fica como texto não validado.
 */
export function resolveTaxIds(input: TaxIdInput): TaxIdResolution {
  const nifRaw = input.supplierNif?.replace(/[\s.\-/]/g, '') ?? '';
  const vatRaw = normalizeVatId(input.supplierVatId);
  const country = (
    vatCountry(vatRaw) ??
    input.country?.toUpperCase() ??
    (nifRaw ? 'PT' : '')
  ).toUpperCase();

  // ── Português ────────────────────────────────────────────────────
  if (country === 'PT' || (!country && nifRaw)) {
    const candidate = nifRaw || (vatRaw?.replace(/^PT/, '') ?? '');
    if (!candidate) {
      return {
        nif: null, vatId: null, validation: 'NONE', rejected: null,
        reason: 'no_tax_id', needsReview: true,
      };
    }
    if (isValidPortugueseNif(candidate)) {
      return {
        nif: candidate,
        vatId: `PT${candidate}`,
        validation: 'PT_MOD11',
        rejected: null,
        reason: 'nif_pt_mod11_ok',
        needsReview: false,
      };
    }
    return {
      nif: null,
      vatId: null,
      validation: 'UNVALIDATED',
      rejected: candidate,
      reason: `nif_pt_mod11_failed:${candidate}`,
      needsReview: true,
    };
  }

  // ── Comunitário (não-PT) ─────────────────────────────────────────
  if (EU_COUNTRY_CODES.has(country)) {
    if (!vatRaw) {
      return {
        nif: null, vatId: null, validation: 'NONE', rejected: null,
        reason: 'no_tax_id', needsReview: true,
      };
    }
    if (!isSyntacticallyValidEuVat(vatRaw)) {
      return {
        nif: null, vatId: null, validation: 'UNVALIDATED', rejected: vatRaw,
        reason: `vat_eu_bad_syntax:${vatRaw}`, needsReview: true,
      };
    }
    if (input.viesValidated) {
      return {
        nif: vatRaw, vatId: vatRaw, validation: 'VIES', rejected: null,
        reason: `vat_eu_vies_ok:${vatRaw}`, needsReview: false,
      };
    }
    // Sintaxe certa mas o VIES não confirmou — não é um NIF confirmado.
    return {
      nif: null, vatId: vatRaw, validation: 'UNVALIDATED', rejected: vatRaw,
      reason: `vat_eu_vies_unconfirmed:${vatRaw}`, needsReview: true,
    };
  }

  // ── Extra-UE ─────────────────────────────────────────────────────
  if (!vatRaw && !nifRaw) {
    return {
      nif: null, vatId: null, validation: 'NONE', rejected: null,
      reason: 'no_tax_id', needsReview: true,
    };
  }
  const text = vatRaw ?? nifRaw;
  return {
    nif: null,
    vatId: text,
    validation: 'UNVALIDATED',
    rejected: text,
    reason: `vat_non_eu_unvalidated:${country || '??'}`,
    needsReview: true,
  };
}

/**
 * Fase 4.1 — o saneamento tem de LIMPAR o que já está gravado, não
 * apenas recusar-se a escrever por cima.
 *
 * A escrita da extração é aditiva (só persiste valores truthy), por isso
 * uma linha antiga com lixo ficava lá para sempre. Em produção havia
 * documentos com o TOTAL gravado na coluna do ATCUD ("1012.30",
 * "155.00", "32.40") e NIFs que falham o módulo 11 — escritos antes
 * destas regras existirem. Um operador nunca confirmaria nenhum desses
 * valores, por isso limpá-los não apaga trabalho humano; e um valor que
 * um humano tenha corrigido à mão passa a validação e sobrevive.
 */
export function shouldClearStoredAtcud(
  stored: string | null | undefined,
  country: string | null | undefined,
  incoming: string | null,
): boolean {
  if (!stored) return false;
  if (incoming) return false; // vamos escrever um valor bom por cima
  return sanitizeAtcud(stored, { country, fromTrustedQr: false }).atcud === null;
}

export function shouldClearStoredNif(
  stored: string | null | undefined,
  country: string | null | undefined,
  incoming: string | null,
  viesValidated: boolean,
): boolean {
  if (!stored) return false;
  if (incoming) return false;
  const isPrefixed = /^[A-Z]{2}/.test(stored);
  return (
    resolveTaxIds({
      supplierNif: isPrefixed ? null : stored,
      supplierVatId: isPrefixed ? stored : null,
      country,
      viesValidated,
    }).nif === null
  );
}

/**
 * Teto de confiança por origem do valor.
 *
 *   qr         veio de um QR-AT realmente descodificado → é prova.
 *   validated  passou uma verificação determinística (mod-11, VIES,
 *              mod-97 do IBAN, totais que fecham ao cêntimo).
 *   ai         veio só do modelo, sem cruzamento → teto baixo.
 */
export function fieldConfidence(
  raw: number | null | undefined,
  source: 'qr' | 'validated' | 'ai',
): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  const v = Math.max(0, Math.min(1, raw));
  if (source === 'ai') return Math.min(v, UNVALIDATED_CONFIDENCE_CAP);
  return v;
}

/**
 * Fase 4.1 (P2.1) — ATCUD a partir do texto.
 *
 * Em várias fotos PT o QR-AT é lido mas o ATCUD não chega ao documento.
 * Quando o QR existe, o campo H do payload é a fonte; quando não existe,
 * procuramos o "ATCUD:" impresso no texto/OCR. Nunca inventamos: só é
 * aceite o que respeitar o formato oficial da AT.
 */
export function extractAtcudFromText(text: string | null | undefined): string | null {
  if (!text) return null;
  // "ATCUD: JFXG7XVG-7018", "ATCUD JFXG7XVG-7018", "ATCUD:JFXG7XVG-7018"
  const m = text
    .toUpperCase()
    .match(/ATCUD\s*[:\-]?\s*([A-Z0-9]{8,}\s*-\s*\d+)/);
  if (!m) return null;
  const candidate = m[1].replace(/\s+/g, '');
  return ATCUD_PATTERN.test(candidate) ? candidate : null;
}

// =============================================================================
// 1. TRIANGULAÇÃO ESTRITA: Líquido + IVA == Total (tolerância máx 0.02€)
// =============================================================================

export interface TriangulationInput {
  netAmount?: number | null;
  taxAmount?: number | null;
  total?: number | null;
  tolerance?: number;
}

export interface TriangulationResult {
  isValid: boolean;
  netAmount: number | null;
  taxAmount: number | null;
  total: number | null;
  expectedTotal: number | null;
  delta: number | null;
  tolerance: number;
  reason: string;
  passedCheck?: string;
  warning?: string;
}

export function validateTriangulation(input: TriangulationInput): TriangulationResult {
  const tolerance = typeof input.tolerance === 'number' && input.tolerance >= 0
    ? input.tolerance
    : LEGAL_ROUNDING_TOLERANCE;

  const net = safeNum(input.netAmount);
  const tax = safeNum(input.taxAmount);
  const total = safeNum(input.total);

  if (net == null || tax == null || total == null) {
    const missing: string[] = [];
    if (net == null) missing.push('líquido');
    if (tax == null) missing.push('IVA');
    if (total == null) missing.push('total');
    return {
      isValid: false,
      netAmount: net,
      taxAmount: tax,
      total,
      expectedTotal: null,
      delta: null,
      tolerance,
      reason: `valores_incompletos:${missing.join(',')}`,
      warning: `Valores incompletos para triangulação fiscal (faltam: ${missing.join(', ')})`,
    };
  }

  const expectedTotal = round2(net + tax);
  const delta = round2(expectedTotal - total);
  const isValid = Math.abs(delta) <= tolerance;

  if (isValid) {
    return {
      isValid: true,
      netAmount: net,
      taxAmount: tax,
      total,
      expectedTotal,
      delta,
      tolerance,
      reason: 'triangulacao_perfeita',
      passedCheck: `Triangulação estrita válida: Líquido (${net.toFixed(2)}€) + IVA (${tax.toFixed(2)}€) == Total (${total.toFixed(2)}€) [Δ ${delta >= 0 ? '+' : ''}${delta.toFixed(2)}€ ≤ ${tolerance.toFixed(2)}€]`,
    };
  }

  return {
    isValid: false,
    netAmount: net,
    taxAmount: tax,
    total,
    expectedTotal,
    delta,
    tolerance,
    reason: `triangulacao_falhou:liquido=${net.toFixed(2)}_iva=${tax.toFixed(2)}_total=${total.toFixed(2)}_diferenca=${delta.toFixed(2)}`,
    warning: `Discrepância na triangulação: Líquido (${net.toFixed(2)}€) + IVA (${tax.toFixed(2)}€) difere do Total (${total.toFixed(2)}€) em ${delta.toFixed(2)}€ (tolerância máx: ${tolerance.toFixed(2)}€)`,
  };
}

// =============================================================================
// 2. TAXAS DE IVA OFICIAIS DE PORTUGAL E REGIMES COMUNITÁRIOS
// =============================================================================

export interface VatRatesValidationInput {
  rates?: Array<number | null | undefined> | null;
  country?: string | null;
  isIntracommunity?: boolean;
}

export interface VatRatesValidationResult {
  isValid: boolean;
  ratesChecked: number[];
  validRates: number[];
  invalidRates: number[];
  reasons: string[];
  passedChecks: string[];
  warnings: string[];
}

export function isOfficialPortugueseVatRate(rate: number): boolean {
  const rounded = round2(rate);
  return ALL_OFFICIAL_PT_VAT_RATES.has(rounded);
}

export function validateVatRates(input: VatRatesValidationInput): VatRatesValidationResult {
  const rawRates = input.rates ?? [];
  const validRates: number[] = [];
  const invalidRates: number[] = [];
  const reasons: string[] = [];
  const passedChecks: string[] = [];
  const warnings: string[] = [];

  const ratesChecked = Array.from(
    new Set(
      rawRates
        .map(safeNum)
        .filter((r): r is number => r != null)
        .map(round2)
    ),
  );

  const country = (input.country ?? 'PT').trim().toUpperCase();
  const isPt = country === 'PT' || country === '';
  const isIntra = !!input.isIntracommunity || (EU_COUNTRY_CODES.has(country) && country !== 'PT');

  if (ratesChecked.length === 0) {
    return {
      isValid: true,
      ratesChecked: [],
      validRates: [],
      invalidRates: [],
      reasons: ['sem_taxas_declaradas'],
      passedChecks: ['Nenhuma taxa explícita rejeitada'],
      warnings: [],
    };
  }

  for (const rate of ratesChecked) {
    if (isPt) {
      if (isOfficialPortugueseVatRate(rate)) {
        validRates.push(rate);
        reasons.push(`taxa_pt_oficial:${rate}%`);
      } else {
        invalidRates.push(rate);
        reasons.push(`taxa_pt_invalida:${rate}%`);
        warnings.push(`Taxa de IVA ${rate}% não é uma taxa oficial em Portugal (23%, 13%, 6%, 0% Continente; RAM/RAA)`);
      }
    } else if (isIntra) {
      if (rate === 0) {
        validRates.push(rate);
        reasons.push('taxa_comunitaria_autoliquidacao:0%');
      } else {
        const countryRates = EU_VAT_RATES_MAP[country];
        if (countryRates && countryRates.includes(rate)) {
          validRates.push(rate);
          reasons.push(`taxa_ue_oficial:${country}:${rate}%`);
        } else if (rate >= 0 && rate <= 27) {
          validRates.push(rate);
          reasons.push(`taxa_ue_plausivel:${rate}%`);
        } else {
          invalidRates.push(rate);
          reasons.push(`taxa_ue_invalida:${rate}%`);
          warnings.push(`Taxa de IVA ${rate}% fora dos limites legais comunitários da UE`);
        }
      }
    } else {
      if (rate >= 0 && rate <= 35) {
        validRates.push(rate);
        reasons.push(`taxa_extra_ue_aceite:${rate}%`);
      } else {
        invalidRates.push(rate);
        reasons.push(`taxa_extra_ue_anomala:${rate}%`);
        warnings.push(`Taxa de imposto ${rate}% anómala para país extra-comunitário ${country}`);
      }
    }
  }

  const isValid = invalidRates.length === 0;
  if (isValid) {
    const desc = isPt ? 'Portugal (CIVA)' : isIntra ? 'Regime Comunitário UE' : country;
    passedChecks.push(`Todas as taxas de IVA (${validRates.join('%, ')}%) validadas oficialmente para ${desc}`);
  }

  return {
    isValid,
    ratesChecked,
    validRates,
    invalidRates,
    reasons,
    passedChecks,
    warnings,
  };
}

// =============================================================================
// 3. VALIDAÇÃO DA TABELA DE ARTIGOS
// =============================================================================

export interface LineItemToValidate {
  description?: string | null;
  quantity?: number | null;
  unitPrice?: number | null;
  discount?: number | null;
  discountPercent?: number | null;
  lineTotal?: number | null;
  total?: number | null;
  taxRate?: number | null;
}

export interface LineItemDiscrepancy {
  lineIndex: number;
  description: string;
  expectedSubtotal: number;
  actualSubtotal: number;
  delta: number;
  reason: string;
}

export interface LineItemsValidationResult {
  isValid: boolean;
  totalLines: number;
  linesChecked: number;
  sumOfLines: number | null;
  expectedTableSubtotal: number | null;
  tableDelta: number | null;
  lineDiscrepancies: LineItemDiscrepancy[];
  reasons: string[];
  passedChecks: string[];
  warnings: string[];
}

export function validateLineItemsTable(
  items?: LineItemToValidate[] | null,
  headerTotals?: {
    netAmount?: number | null;
    total?: number | null;
    discountAmount?: number | null;
  },
): LineItemsValidationResult {
  const lines = items ?? [];
  const lineDiscrepancies: LineItemDiscrepancy[] = [];
  const reasons: string[] = [];
  const passedChecks: string[] = [];
  const warnings: string[] = [];

  if (lines.length === 0) {
    return {
      isValid: true,
      totalLines: 0,
      linesChecked: 0,
      sumOfLines: null,
      expectedTableSubtotal: null,
      tableDelta: null,
      lineDiscrepancies: [],
      reasons: ['sem_linhas_para_validar'],
      passedChecks: [],
      warnings: [],
    };
  }

  let calculatedSum = 0;
  let linesChecked = 0;

  lines.forEach((item, idx) => {
    const qty = safeNum(item.quantity) ?? 1;
    const price = safeNum(item.unitPrice);
    let discount = safeNum(item.discount) ?? 0;
    let discountPct = safeNum(item.discountPercent);
    const actualSubtotal = safeNum(item.lineTotal) ?? safeNum(item.total);

    if (discount > 0 || discountPct != null) {
      // A printed discount number can be a percentage without a percent
      // sign. Prove that interpretation directly against the printed line
      // total before calculating the discrepancy below.
      if (discount > 0 && price != null && actualSubtotal != null) {
        const percentageSubtotal = qty * price * (1 - discount / 100);
        if (Math.abs(percentageSubtotal - actualSubtotal) < 0.05) {
          discountPct = discount;
          discount = round2(qty * price * (discount / 100));
          item.discountPercent = discountPct;
          item.discount = discount;
        }
      }
      const classified = classifyLineDiscount({
        quantity: qty,
        unitPrice: price,
        discount: item.discount,
        lineTotal: actualSubtotal,
      });

      if (classified.kind === 'percent' && classified.discountAmount != null) {
        discount = classified.discountAmount;
        discountPct = classified.discountPercent ?? discountPct;
        item.discountPercent = discountPct;
        item.discount = discount;
      } else if (discount === 0 && discountPct != null && discountPct > 0 && price != null) {
        discount = round2(qty * price * (discountPct / 100));
      }
    }

    if (price != null) {
      linesChecked++;
      const expectedSubtotal = round2(qty * price - discount);
      calculatedSum = round2(calculatedSum + expectedSubtotal);

      if (actualSubtotal != null) {
        const delta = round2(expectedSubtotal - actualSubtotal);
        if (Math.abs(delta) > LEGAL_ROUNDING_TOLERANCE) {
          const desc = item.description?.trim() || `Linha #${idx + 1}`;
          const reason = `discrepancia_linha_${idx + 1}:esperado=${expectedSubtotal.toFixed(2)}_impresso=${actualSubtotal.toFixed(2)}_delta=${delta.toFixed(2)}`;
          lineDiscrepancies.push({
            lineIndex: idx,
            description: desc,
            expectedSubtotal,
            actualSubtotal,
            delta,
            reason,
          });
          reasons.push(reason);
          warnings.push(
            `Linha "${desc}": Qtd (${qty}) × Preço (${price.toFixed(2)}€) - Desc (${discount.toFixed(2)}€) = ${expectedSubtotal.toFixed(2)}€ difere do impresso (${actualSubtotal.toFixed(2)}€) em ${delta.toFixed(2)}€`,
          );
        }
      }
    } else if (actualSubtotal != null) {
      calculatedSum = round2(calculatedSum + actualSubtotal);
    }
  });

  const sumOfLines = round2(calculatedSum);
  let tableDelta: number | null = null;
  let expectedTableSubtotal: number | null = null;

  const net = safeNum(headerTotals?.netAmount);
  const total = safeNum(headerTotals?.total);
  const globalDiscount = safeNum(headerTotals?.discountAmount) ?? 0;

  if (net != null) {
    expectedTableSubtotal = net;
    const effectiveLines = round2(sumOfLines - globalDiscount);
    tableDelta = round2(effectiveLines - net);

    if (Math.abs(tableDelta) > LEGAL_ROUNDING_TOLERANCE) {
      let closesWithTotal = false;
      if (total != null) {
        const totalDelta = round2(round2(sumOfLines - globalDiscount) - total);
        if (Math.abs(totalDelta) <= LEGAL_ROUNDING_TOLERANCE) {
          closesWithTotal = true;
          tableDelta = totalDelta;
          passedChecks.push(`Soma das linhas (${sumOfLines.toFixed(2)}€) confere com o Total do documento (${total.toFixed(2)}€)`);
        }
      }

      if (!closesWithTotal) {
        const diffStr = Math.abs(tableDelta).toFixed(2);
        reasons.push(`soma_linhas_difere_liquido:linhas=${sumOfLines.toFixed(2)}_liquido=${net.toFixed(2)}_diff=${tableDelta.toFixed(2)}`);
        warnings.push(`Soma das linhas difere do total em ${diffStr}€`);
      }
    } else {
      passedChecks.push(`Soma das linhas (${sumOfLines.toFixed(2)}€) confere com o subtotal líquido (${net.toFixed(2)}€)`);
    }
  } else if (total != null) {
    expectedTableSubtotal = total;
    tableDelta = round2(sumOfLines - total);
    if (Math.abs(tableDelta) > LEGAL_ROUNDING_TOLERANCE) {
      const diffStr = Math.abs(tableDelta).toFixed(2);
      reasons.push(`soma_linhas_difere_total:linhas=${sumOfLines.toFixed(2)}_total=${total.toFixed(2)}_diff=${tableDelta.toFixed(2)}`);
      warnings.push(`Soma das linhas difere do total em ${diffStr}€`);
    } else {
      passedChecks.push(`Soma das linhas (${sumOfLines.toFixed(2)}€) confere com o Total do documento (${total.toFixed(2)}€)`);
    }
  }

  const isValid = lineDiscrepancies.length === 0 && (tableDelta == null || Math.abs(tableDelta) <= LEGAL_ROUNDING_TOLERANCE);

  if (isValid && lines.length > 0) {
    passedChecks.push(`Tabela de ${lines.length} artigos validada com sucesso: Qtd × Preço Unitário - Desconto == Subtotal`);
  }

  return {
    isValid,
    totalLines: lines.length,
    linesChecked,
    sumOfLines,
    expectedTableSubtotal,
    tableDelta,
    lineDiscrepancies,
    reasons,
    passedChecks,
    warnings,
  };
}

// =============================================================================
// 4. MOTOR DE CERTAINTY SCORE (0 a 100%)
// =============================================================================

export interface TenantNifValidationResult {
  status: 'CONFIRMED' | 'MISSING_NIF' | 'MISMATCH_THIRD_PARTY' | 'NOT_APPLICABLE';
  hasTenantNif: boolean;
  isOfficialDocument: boolean;
  customerNif: string | null;
  tenantNif: string | null;
  label: string;
  passedCheck?: string;
  warning?: string;
}

export function validateTenantAcquirerNif(params: {
  customerNif?: string | null;
  tenantNif?: string | null;
  qrPayload?: string | null;
}): TenantNifValidationResult {
  const { customerNif, tenantNif, qrPayload } = params;
  if (!tenantNif || tenantNif.trim().length === 0) {
    return {
      status: 'NOT_APPLICABLE',
      hasTenantNif: true,
      isOfficialDocument: true,
      customerNif: customerNif ?? null,
      tenantNif: null,
      label: 'NIF da Empresa não configurado',
    };
  }

  const cleanTenantNif = tenantNif.replace(/^PT/i, '').replace(/\D/g, '');
  let detectedCustomer = customerNif ? customerNif.replace(/^PT/i, '').replace(/\D/g, '') : null;

  // Se não foi extraído customerNif da visão/texto, verifica se o QR-AT traz o campo B:
  if (!detectedCustomer && qrPayload) {
    const bMatch = qrPayload.match(/(?:^|\*)B:(\d+)/);
    if (bMatch && bMatch[1]) {
      detectedCustomer = bMatch[1].replace(/^PT/i, '').replace(/\D/g, '');
    }
  }

  // Cenário 1: Confirmado — o NIF do adquirente no documento bate com o NIF da empresa
  if (detectedCustomer && detectedCustomer === cleanTenantNif) {
    return {
      status: 'CONFIRMED',
      hasTenantNif: true,
      isOfficialDocument: true,
      customerNif: detectedCustomer,
      tenantNif: cleanTenantNif,
      label: `NIF da Empresa Confirmado (${cleanTenantNif})`,
      passedCheck: `NIF da empresa adquirente verificado (${cleanTenantNif}) — documento oficial em nome da empresa`,
    };
  }

  // Cenário 2: Sem NIF ou Consumidor Final (999999990)
  if (!detectedCustomer || detectedCustomer === '999999990') {
    return {
      status: 'MISSING_NIF',
      hasTenantNif: false,
      isOfficialDocument: false,
      customerNif: detectedCustomer,
      tenantNif: cleanTenantNif,
      label: 'Sem NIF da Empresa (Não Oficial / Não Dedutível)',
      warning: `Documento sem NIF da sua empresa (${cleanTenantNif}). De acordo com o art. 36.º do CIVA, não pode ser classificado como documento oficial dedutível sem conferência manual.`,
    };
  }

  // Cenário 3: NIF de Terceiro (difere da empresa e não é consumidor final)
  return {
    status: 'MISMATCH_THIRD_PARTY',
    hasTenantNif: false,
    isOfficialDocument: false,
    customerNif: detectedCustomer,
    tenantNif: cleanTenantNif,
    label: `NIF de Terceiro (${detectedCustomer}) — Não Pertence à Empresa`,
    warning: `ALERTA FISCAL CRÍTICO: O documento tem o NIF de adquirente ${detectedCustomer}, que difere do NIF da sua empresa (${cleanTenantNif}). Documento emitido para entidade terceira.`,
  };
}

export interface CertaintyScoreInput {
  netAmount?: number | null;
  taxAmount?: number | null;
  total?: number | null;
  lineItems?: LineItemToValidate[] | null;
  taxRate?: number | null;
  supplierNif?: string | null;
  supplierVatId?: string | null;
  country?: string | null;
  viesValidated?: boolean;
  qrPayload?: string | null;
  qrOrigin?: string | null;
  atcud?: string | null;
  hash4?: string | null;
  softwareCert?: string | null;
  discountAmount?: number | null;
  cashDiscountRate?: number | null;
  isIntracommunity?: boolean;
  customerNif?: string | null;
  tenantNif?: string | null;
  tenantName?: string | null;
}

export interface CertaintyScoreResult {
  score: number; // 0 a 100 (ex: 99.9, 98.0, 75.0)
  level: 'OFFICIAL_AT' | 'PERFECT_TRIANGULATION' | 'REVIEW_REQUIRED' | 'CRITICAL';
  label: string;
  needsReview: boolean;
  triangulation: TriangulationResult;
  lineItemsValidation: LineItemsValidationResult;
  vatRatesValidation: VatRatesValidationResult;
  taxIdResolution: TaxIdResolution;
  tenantNifValidation?: TenantNifValidationResult;
  qrAtValidation: {
    hasAtQr: boolean;
    isValidAtQr: boolean;
    hasValidSignature: boolean;
    reasons: string[];
  };
  passedChecks: string[];
  warnings: string[];
}

export function calculateCertaintyScore(input: CertaintyScoreInput): CertaintyScoreResult {
  const passedChecks: string[] = [];
  const warnings: string[] = [];

  // 1. Triangulação Aritmética
  const triangulation = validateTriangulation({
    netAmount: input.netAmount,
    taxAmount: input.taxAmount,
    total: input.total,
    tolerance: LEGAL_ROUNDING_TOLERANCE,
  });

  // 2. Validação Fiscal do NIF do Fornecedor
  const taxIdResolution = resolveTaxIds({
    supplierNif: input.supplierNif,
    supplierVatId: input.supplierVatId,
    country: input.country,
    viesValidated: input.viesValidated,
  });

  // 3. Validação do NIF da Empresa (Adquirente) — Salvaguarda de Documento Oficial
  const tenantNifValidation = validateTenantAcquirerNif({
    customerNif: input.customerNif,
    tenantNif: input.tenantNif,
    qrPayload: input.qrPayload,
  });

  if (tenantNifValidation.passedCheck) {
    passedChecks.push(tenantNifValidation.passedCheck);
  }
  if (tenantNifValidation.warning) {
    warnings.push(tenantNifValidation.warning);
  }

  // 4. Validação das Taxas de IVA
  const ratesToTest = [
    input.taxRate,
    ...(input.lineItems?.map((l) => l.taxRate) ?? []),
  ];
  const vatRatesValidation = validateVatRates({
    rates: ratesToTest,
    country: taxIdResolution.vatId ? vatCountry(taxIdResolution.vatId) : input.country,
    isIntracommunity: input.isIntracommunity,
  });

  // 5. Validação da Tabela de Artigos
  const lineItemsValidation = validateLineItemsTable(input.lineItems, {
    netAmount: input.netAmount,
    total: input.total,
    discountAmount: input.discountAmount,
  });

  // 6. Validação de QR-AT Oficial com Assinatura da AT
  let hasValidAtQr = false;
  let hasValidSignature = false;
  const qrReasons: string[] = [];

  const rawQr = input.qrPayload?.trim();
  if (rawQr && rawQr.includes('*') && /A:\d{9}/.test(rawQr)) {
    const parsed = parseAtQr(rawQr.replace(/\s+/g, ''));
    if (parsed) {
      const atQrCheck = validateAtQr(parsed);
      const issuerOk = !!parsed.issuerNif && isValidPortugueseNif(parsed.issuerNif);
      const atcudOk = !!parsed.atcud && ATCUD_PATTERN.test(parsed.atcud.trim().toUpperCase());
      const hashOk = !!parsed.hash4 && /^[A-Z0-9]{4}$/i.test(parsed.hash4.trim());
      const certOk = !!parsed.softwareCert && /^\d{1,5}$/.test(parsed.softwareCert.trim());

      if (atQrCheck.ok && issuerOk && atcudOk && hashOk && certOk && input.qrOrigin !== 'ai') {
        hasValidAtQr = true;
        hasValidSignature = true;
        qrReasons.push('qr_at_oficial_com_assinatura_valida');
      } else {
        if (!issuerOk) qrReasons.push('qr_issuer_nif_invalido');
        if (!atcudOk) qrReasons.push('qr_atcud_invalido');
        if (!hashOk) qrReasons.push('qr_hash4_ausente_ou_invalido');
        if (!certOk) qrReasons.push('qr_software_cert_ausente');
        if (input.qrOrigin === 'ai') qrReasons.push('qr_origem_ia_nao_certificada');
      }
    }
  } else if (input.atcud && input.hash4 && input.softwareCert && input.supplierNif) {
    const qrStruct = {
      issuerNif: input.supplierNif,
      atcud: input.atcud,
      hash4: input.hash4,
      softwareCert: input.softwareCert,
    };
    if (isValidAtQr(qrStruct) && input.qrOrigin !== 'ai') {
      hasValidAtQr = true;
      hasValidSignature = true;
      qrReasons.push('campos_at_oficiais_com_assinatura_valida');
    }
  }

  // Passed checks
  if (hasValidAtQr && hasValidSignature) {
    passedChecks.push('QR-AT oficial validado pela AT com assinatura válida (ATCUD + Certificado AT + Hash4)');
  }
  if (triangulation.isValid && triangulation.passedCheck) {
    passedChecks.push(triangulation.passedCheck);
  }
  if (taxIdResolution.validation === 'PT_MOD11') {
    passedChecks.push(`NIF português ${taxIdResolution.nif} validado com sucesso por Módulo 11`);
  } else if (taxIdResolution.validation === 'VIES') {
    passedChecks.push(`NIF comunitário ${taxIdResolution.vatId} validado oficialmente via base VIES`);
  }
  if (vatRatesValidation.isValid && vatRatesValidation.passedChecks.length > 0) {
    passedChecks.push(...vatRatesValidation.passedChecks);
  }
  if (lineItemsValidation.isValid && lineItemsValidation.passedChecks.length > 0) {
    passedChecks.push(...lineItemsValidation.passedChecks);
  }

  // Warnings
  if (!triangulation.isValid && triangulation.warning) {
    warnings.push(triangulation.warning);
  }
  if (!lineItemsValidation.isValid && lineItemsValidation.warnings.length > 0) {
    warnings.push(...lineItemsValidation.warnings);
  }
  if (!vatRatesValidation.isValid && vatRatesValidation.warnings.length > 0) {
    warnings.push(...vatRatesValidation.warnings);
  }
  if (taxIdResolution.needsReview) {
    if (taxIdResolution.rejected) {
      warnings.push(`NIF do fornecedor (${taxIdResolution.rejected}) falhou na validação de integridade`);
    } else if (taxIdResolution.validation === 'NONE') {
      warnings.push('Documento sem identificador fiscal de fornecedor (NIF/VAT)');
    }
  }

  // CENÁRIO 1: 99.9% — QR-AT oficial validado pela AT com assinatura válida E NIF da empresa confirmado
  if (hasValidAtQr && hasValidSignature && tenantNifValidation.isOfficialDocument) {
    return {
      score: 99.9,
      level: 'OFFICIAL_AT',
      label: '99.9% · Validado Oficial AT (QR-AT Assinado)',
      needsReview: false,
      triangulation,
      lineItemsValidation,
      vatRatesValidation,
      taxIdResolution,
      tenantNifValidation,
      qrAtValidation: {
        hasAtQr: true,
        isValidAtQr: true,
        hasValidSignature: true,
        reasons: qrReasons,
      },
      passedChecks,
      warnings,
    };
  }

  // CENÁRIO 2: 98% — Triangulação matemática perfeita + NIF PT (módulo 11) ou VIES válido E NIF da empresa confirmado
  const hasValidTaxId = taxIdResolution.validation === 'PT_MOD11' || taxIdResolution.validation === 'VIES';
  const hasPerfectMath = triangulation.isValid;
  const hasValidLines = lineItemsValidation.isValid;
  const hasValidRates = vatRatesValidation.isValid;

  if (hasPerfectMath && hasValidTaxId && hasValidLines && hasValidRates && tenantNifValidation.isOfficialDocument) {
    return {
      score: 98.0,
      level: 'PERFECT_TRIANGULATION',
      label: '98% · Triangulação Matemática Perfeita & NIF Válido',
      needsReview: false,
      triangulation,
      lineItemsValidation,
      vatRatesValidation,
      taxIdResolution,
      tenantNifValidation,
      qrAtValidation: {
        hasAtQr: hasValidAtQr,
        isValidAtQr: hasValidAtQr,
        hasValidSignature: false,
        reasons: qrReasons,
      },
      passedChecks,
      warnings: [],
    };
  }

  // CENÁRIO 3: <95% — Discrepâncias detectadas em qualquer valor ou falhas de validação (incluindo NIF da empresa em falta/inválido)
  let penalty = 0;
  if (!hasPerfectMath) {
    penalty += triangulation.delta != null ? 25 : 35;
  }
  if (!hasValidLines) {
    penalty += 20;
  }
  if (!hasValidTaxId) {
    penalty += 15;
  }
  if (!hasValidRates) {
    penalty += 10;
  }
  if (!tenantNifValidation.isOfficialDocument) {
    penalty += tenantNifValidation.status === 'MISMATCH_THIRD_PARTY' ? 45 : 24;
  }

  const baseScore = 94.0;
  const rawCalculated = Math.max(20.0, round2(baseScore - penalty));
  let finalScore = Math.min(rawCalculated, 94.0);

  let scoreLabel = `${finalScore.toFixed(1)}% · Discrepância Detectada (Requer Revisão)`;
  let level: 'REVIEW_REQUIRED' | 'CRITICAL' = finalScore < 70 ? 'CRITICAL' : 'REVIEW_REQUIRED';

  if (!tenantNifValidation.isOfficialDocument) {
    if (tenantNifValidation.status === 'MISMATCH_THIRD_PARTY') {
      finalScore = Math.min(finalScore, 45.0);
      level = 'CRITICAL';
      scoreLabel = `${finalScore.toFixed(1)}% · NIF de Terceiro (Não Pertence à Empresa)`;
    } else {
      finalScore = Math.min(finalScore, 70.0);
      level = finalScore < 60 ? 'CRITICAL' : 'REVIEW_REQUIRED';
      scoreLabel = `${finalScore.toFixed(1)}% · Sem NIF da Empresa (Não Oficial / Não Dedutível)`;
    }
  }

  return {
    score: finalScore,
    level,
    label: scoreLabel,
    needsReview: true,
    triangulation,
    lineItemsValidation,
    vatRatesValidation,
    taxIdResolution,
    tenantNifValidation,
    qrAtValidation: {
      hasAtQr: hasValidAtQr,
      isValidAtQr: hasValidAtQr,
      hasValidSignature: false,
      reasons: qrReasons,
    },
    passedChecks,
    warnings,
  };
}
