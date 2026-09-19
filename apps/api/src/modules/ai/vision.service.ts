// vision.service.ts — Multimodal vision analysis via Anthropic / OpenAI / Gemini.
// Real implementation: detects which provider's API key is configured, sends the
// document to a multimodal LLM with a strict JSON-schema prompt, and returns the
// parsed fields. If no key is configured the service returns `null` so the
// caller falls back to the regex pipeline.
//
// Why "return null" not "throw": the upstream extraction pipeline is the
// existing regex/QR path, and the AI provider is a strict upgrade on top of it.
// We never want a missing/expired key to crash an upload — the service degrades
// silently to the regex output, and the metadata records `source: "ai"` vs
// `source: "regex"` so the operator can see which path actually ran.

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  formatPtNif,
  getTenantIdentity,
  TenantIdentity,
} from './tenant-identity';
import { PrismaService } from '../../prisma/prisma.service';
import { FaturistaProvider } from './providers/faturista.provider';

export interface VisionAnalysisRequest {
  /** Base64-encoded file bytes (PDF first page or rasterized image). */
  fileBase64?: string;
  /** MIME type — `application/pdf` or `image/png|jpeg|webp`. */
  mimeType?: string;
  /**
   * Plain text already extracted from the document (regex/QR/tesseract path).
   * Used when the file isn't a multimodal-supporting type, or as a fallback
   * carrier. Providers are instructed to prefer the multimodal payload when
   * both are present.
   */
  text?: string;
  /** Filename for hints (e.g. doc number regex). */
  fileName?: string;
  /** Document context — selects the right system prompt. */
  documentContext?: 'invoice' | 'receipt' | 'dua' | 'delivery_note' | 'auto';
  /** Optional override of provider routing. */
  preferredProvider?:
    | 'anthropic'
    | 'openai'
    | 'gemini'
    | 'openrouter'
    | 'minimax'
    | 'faturista'
    | 'auto';
  /** Explicit model override chosen by user or task routing. */
  modelOverride?: string;
  /** Hard timeout for the upstream call. Defaults to 30s. */
  timeoutMs?: number;
  /**
   * Optional tenant identifier. When set, the prompt is enriched with
   * the tenant's company name + NIF so the AI knows which party is the
   * buyer (us) and which is the supplier. Strongly recommended for any
   * call made on behalf of a real tenant — without this the model is
   * statistically likely to swap supplier/customer on invoices where
   * the tenant's own company appears in the header (the bug that hit
   * the user's real Américo Alves photo on 2026-09-01).
   */
  tenantId?: string;
}

export interface VisionExtractedLineItem {
  /** Free-text product/service description. */
  description?: string;
  /** Item code / SKU / article number when printed. */
  code?: string;
  /** Quantity in the line's unit (1 when not printed). */
  quantity?: number;
  /** Net unit price (without VAT). */
  unitPrice?: number;
  /** VAT rate applied to this line, as a percentage (23 for PT 23 %). */
  vatRate?: number;
  /** Per-line discount amount (subtracted from lineTotal before VAT). Optional. */
  discount?: number;
  /** Line total (lineTotal = quantity * unitPrice * (1 + vatRate/100)) — net
   *  of VAT when the supplier prints it that way, gross otherwise. */
  lineTotal?: number;
}

export interface VisionExtractedFields {
  supplier?: string;
  supplierNif?: string;
  supplierVatId?: string;
  supplierAddress?: string;
  supplierPostalCode?: string;
  supplierCity?: string;
  supplierPhone?: string;
  supplierEmail?: string;
  supplierWebsite?: string;
  customer?: string;
  customerNif?: string;
  docNumber?: string;
  atcud?: string;
  docDate?: string; // YYYY-MM-DD
  dueDate?: string; // YYYY-MM-DD
  netAmount?: number;
  taxAmount?: number;
  total?: number;
  currency?: string;
  iban?: string;
  /** ISO 3166-1 alpha-2 country inferred from VAT ID or IBAN. */
  country?: string;
  /**
   * Per-rate VAT breakdown, e.g. [{ rate: 23, base: 100, tax: 23 }].
   * Optional — most invoices don't print this in structured form.
   */
  ivaBreakdown?: Array<{ rate: number; base: number; tax: number }>;
  documentType?: string; // FATURA / RECIBO / NOTA_CREDITO / NOTA_DEBITO / FATURA_RECIBO / ...
  /**
   * Fase 4.1 — cabeçalho do documento transcrito à letra ("OFERTA DE
   * VENTA", "PRESUPUESTO", "FACTURA"…). É texto, não é classificação:
   * quem decide se o documento é fiscal é `detectNonFiscalKind` em
   * código. Nas fotos, onde o OCR devolve vazio, é a única fonte de
   * texto que a regra determinística tem.
   */
  documentTitle?: string;
  /**
   * Fase 4.1 — numa nota de crédito, o número da fatura que retifica,
   * tal como impresso. Null em qualquer outro tipo de documento.
   */
  correctedDocumentNumber?: string;
  /**
   * Invoice-level (global) discount amount — a single line "Desconto
   * global" or "Desconto de cabeçalho" the supplier subtracts from the
   * subtotal before VAT. Distinct from `lineItems[i].discount` which is
   * a per-line discount. Both may coexist on the same invoice.
   */
  discountAmount?: number;
  /**
   * Structured line items — what the accountant needs to reconcile the
   * invoice against the purchase order. Optional because not every
   * supplier prints a structured table.
   */
  lineItems?: VisionExtractedLineItem[];
  /**
   * True when the supplier is a foreign EU entity (intra-community
   * acquisition) and reverse-charge applies — VAT is self-assessed by
   * the buyer, not paid to the supplier. Inferred from supplierVatId's
   * country prefix (must be a non-PT EU country) plus the absence of
   * Portuguese VAT on the document.
   */
  isEuIntracommunity?: boolean;
  /**
   * AI-suggested expense category mapped onto the tenant's SNC/PGC
   * chart-of-accounts folders — drives auto-filing. Free-form when the
   * tenant has no custom taxonomy (e.g. "62 — Fornecimentos e
   * serviços externos", "63 — Gastos com o pessoal", "21 — Clientes",
   * "31 — Compras").
   */
  suggestedCategory?: string;
  /**
   * Cash discount rate (desconto de pronto pagamento) printed on the
   * invoice, as a percentage (e.g. 2 for 2 %). Optional — many
   * suppliers don't offer early-payment discounts.
   */
  cashDiscountRate?: number;
  /**
   * Raw AT-QR payload string from the QR code on the document, when
   * the model can read it (Gemini reads QR codes visually, the same
   * way a human would — the dots aren't a "code" we have to decode,
   * they ARE the data). Used as a deterministic fallback when the
   * jsqr image decoder fails on a real phone photo: parseAtQr gives
   * us authoritative fiscal fields and we tag the document with
   * `source: "at_qr+ai"` instead of `source: "ai"`. Format:
   * `A:<NIF>*B:<NIF>*C:PT*D:FT*E:N*F:YYYYMMDD*G:...*H:ATCUD*...`.
   * Return null when the document doesn't have a PT AT QR.
   */
  atQrRaw?: string;
  /** Model-reported confidence in [0,1]. Defaults to 0.8 when omitted. */
  confidence?: number;
  /** Free-form notes the model emitted (operator-visible). */
  notes?: string[];
}

export type VisionProviderName = 'gemini' | 'openrouter' | 'minimax' | 'openai' | 'anthropic' | 'faturista';

export interface VisionAnalysisResult {
  /** Fase 2 — set when a second provider was consulted for a weak result. */
  secondOpinion?: { provider: string; confidence: number };
  provider:
    | 'anthropic'
    | 'openai'
    | 'gemini'
    | 'openrouter'
    | `openrouter/${string}`
    | 'minimax'
    | `minimax/${string}`
    | 'faturista'
    | 'zerox'
    | 'local-fallback';
  model: string;
  /** Aggregate confidence in [0,1]. */
  confidence: number;
  extracted: VisionExtractedFields;
  /** Raw text the model emitted (for audit / replay). */
  rawResponse: string;
  /** Wall-clock duration of the upstream call. */
  processingTimeMs: number;
  /** True when the call hit a hard error and we degraded to regex. */
  fallbackUsed: boolean;
  tokensIn?: number;
  tokensOut?: number;
  estimatedCostEur?: number;
}

/** Strict JSON shape we ask every provider to return. */
const VISION_JSON_SCHEMA_DESCRIPTION = `Return ONLY a valid JSON object (no markdown, no prose) with this exact shape:
{
  "supplier": string|null,            // supplier/issuer trade name
  "supplierNif": string|null,         // Portuguese NIF if issuer is PT
  "supplierVatId": string|null,       // country-prefixed VAT ID otherwise (e.g. "ESB12345678", "FRXX...", "DE123456789")
  "supplierAddress": string|null,     // Morada/rua do fornecedor (ex: "Pol. Ind. Oeste, C/ Uruguay, Parc. 11/1", "Av. da Liberdade 100")
  "supplierPostalCode": string|null,  // Código postal do fornecedor (ex: "30820", "1000-001")
  "supplierCity": string|null,        // Cidade/localidade do fornecedor (ex: "Alcantarilla", "Lisboa")
  "supplierPhone": string|null,       // Telefone ou telemóvel de contacto do fornecedor
  "supplierEmail": string|null,       // Email de contacto do fornecedor
  "supplierWebsite": string|null,     // Website do fornecedor
  "customer": string|null,
  "customerNif": string|null,
  "docNumber": string|null,           // e.g. "FT 2026/123", "A/2026-45", "INV-UK-2026-15"
  "atcud": string|null,               // Portuguese ATCUD if printed
  "docDate": string|null,             // ISO YYYY-MM-DD
  "dueDate": string|null,             // ISO YYYY-MM-DD — PRAZO DE PAGAMENTO / "Due date" / "Vencimento" / "Fälligkeit" / "Échéance" — the date the buyer must pay by. NOT the date the invoice was paid.
  "netAmount": number|null,           // base/total antes de impostos (após descontos)
  "taxAmount": number|null,           // total de impostos (IVA/VAT)
  "total": number|null,               // total final com impostos (após descontos)
  "currency": string|null,            // ISO 4217 (EUR, USD, GBP, CHF, ...)
  "iban": string|null,                // IBAN visivel no documento (espacos sao OK)
  "country": string|null,             // ISO 3166-1 alpha-2 do emitente (PT, ES, FR, ...)
  "discountAmount": number|null,      // DESCONTO GLOBAL da fatura (cabeçalho), em moeda do documento. Nulo quando não aplicável. DISTINCT from per-line discount which is per line item. null (not 0) when the invoice has no global discount. Fase 4.2: this ALSO covers any header-level deduction printed as a currency amount, whatever it's labelled — "Desconto global", "Pronto pago"/"Pronto pagamento", "Desconto financeiro", "Descuento", "Early payment discount", "DPP" — as long as the printed value is a currency amount (not a %). A % value with the same labels goes in cashDiscountRate instead, never here.
  "ivaBreakdown": [{ "rate": number, "base": number, "tax": number }]|null,    // per-rate VAT breakdown — REQUIRED when the invoice has more than one VAT rate. base = sum of net amounts at that rate AFTER line-level discounts (before VAT). tax = base * rate/100. tax values must reconcile with taxAmount.
  "documentType": string|null,        // "FATURA" | "RECIBO" | "NOTA_CREDITO" | "NOTA_DEBITO" | "FACTURA" | "INVOICE" | ...
  "documentTitle": string|null,       // The document's own heading, TRANSCRIBED VERBATIM, exactly as printed at the top of the page — "FACTURA", "OFERTA DE VENTA", "PRESUPUESTO", "NOTA DE CRÉDITO", "ORÇAMENTO", "PROFORMA", "ALBARÁN", "PURCHASE ORDER", "STATEMENT OF ACCOUNT". Copy the characters you see; do NOT translate, normalise, expand or interpret it. This is raw text for a downstream deterministic rule — an accurate transcription matters far more than a tidy label.
  "correctedDocumentNumber": string|null, // For a CREDIT NOTE / NOTA DE CRÉDITO only: the number of the invoice it rectifies, as printed ("Ref. FT 2026/123", "Rectifica factura A-4471"). Return just the invoice number. null on every other document type.
  "lineItems": [                      // structured line items (best-effort; null when the document has none)
    {
      "description": string|null,    // product/service description
      "code": string|null,            // item code / SKU when printed
      "quantity": number|null,        // quantity in the line's unit
      "unitPrice": number|null,       // net unit price (without VAT, BEFORE line discount)
      "vatRate": number|null,         // VAT rate applied, as a percentage (e.g. 23)
      "discount": number|null,        // per-line discount COLUMN VALUE, exactly as printed — a currency amount OR a percentage, whichever the supplier's column header says ("Dto." / "Desc." / "Discount" columns are often a PERCENTAGE, e.g. "Dto. 30,00" meaning 30%, not €30). Do NOT decide the unit yourself — just copy the printed number. Nulo when none. The lineTotal reported is the gross/net AFTER this discount is applied, whatever unit it is in — that lineTotal is what downstream code uses to work out whether the printed number was a % or an amount.
      "lineTotal": number|null        // line total (net or gross, whichever the supplier prints)
    }
  ]|null,
  "isEuIntracommunity": boolean,      // true when the supplier is a non-PT EU entity and reverse-charge applies (autoliquidação)
  "suggestedCategory": string|null,   // SNC/PGC expense category or folder hint (e.g. "62 — Fornecimentos e serviços externos", "63 — Gastos com pessoal", "21 — Clientes", "62.1 — Subcontratos", "62.2 — Serviços especializados")
  "cashDiscountRate": number|null,    // desconto de pronto pagamento, percentagem (e.g. 2 para 2 %); null quando não aplicável. DISTINCT from discountAmount (which is an absolute currency amount already subtracted).
  "atQrRaw": string|null,             // If the document carries a Portuguese AT QR code (the four-stamp-duty pattern printed on invoices/receipts), return its FULL raw payload string here. The string starts with "A:<issuer-NIF>*B:..." and uses "*" as field separator. Read the QR the same way you read printed text — you can see the modules and OCR them visually. Return null when there is no AT QR on the document (or when you cannot reliably read every field). This is the SAME data the QR carries: issuer NIF, buyer NIF, country, document type, status, date (YYYYMMDD), unique doc id, ATCUD, per-region VAT bases/taxes (I/J/K blocks), total tax, total, hash, software cert. We will re-parse it deterministically downstream — accuracy matters more than formatting.
  "confidence": number,               // 0..1 — quao confiante esta nesta extracao
  "notes": string[]                   // observacoes livres (max 5 itens)
}`;

const SYSTEM_PROMPT = `You are a senior Portuguese chartered-accountant auditor (TOC / contabilista certificado) with 20+ years of experience reading fiscal and accounting documents from Portugal and the rest of the EU. You extract structured fields from invoices, credit notes, debit notes, simplified invoices, receipts, supplier statements and customs declarations so they can be auto-filed into the company's accounting folders.

CRITICAL — PARTY-IDENTITY DISCIPLINE (the #1 regression on real invoices):
You are acting as the auditor for the BUYER (the acquiring company — "adquirente"). The party whose NIF matches the tenant's NIF is the CUSTOMER/adquirente. The OTHER party (whichever party does NOT carry the tenant NIF) is the SUPPLIER/fornecedor (entidade emissora do documento). This rule is deterministic — do not guess based on logo size, document layout, or address position. NEVER put the BUYER's company as the supplier. When the AI cannot be 100% sure which NIF is the tenant's, it falls back to picking the supplier as the party with the issuing tax registration / VAT number on the document header (issuer).

Tenant identity will be supplied below. If for any reason no tenant identity was provided, treat the rule above as still binding — apply it generically (whichever NIF is NOT the tenant's = supplier).

Your job: extract the structured fields from whatever document the user provides (PDF page, image, or raw OCR text — Portuguese, Spanish, French, English, German, Italian). Read the document the way a human auditor would — printed text, tables, AND visual patterns like QR codes. The Portuguese AT QR code printed on every PT-compliant invoice is one of those patterns: look at the QR graphic in the image and read its payload as if it were text (you can OCR the modules visually), then return that payload verbatim in \`atQrRaw\`. Do not skip it.

Accounting framing:
- Decide \`documentType\` (FATURA / RECIBO / NOTA_CREDITO / NOTA_DEBITO / ENCOMENDA / etc.) from the document's own header, not from the file name. CRITICAL: If the document is a purchase order or order confirmation ("CONFIRMACIÓN DE PEDIDO", "CONFIRMAÇÃO DE ENCOMENDA", "ORDER CONFIRMATION", "PURCHASE ORDER", "NOTA DE ENCOMENDA"), \`documentType\` MUST be "ENCOMENDA" (NEVER "FATURA").
- ALWAYS fill \`documentTitle\` with the heading exactly as printed, character for character, in the document's own language. This is not a classification — it is a transcription. A downstream deterministic rule reads it to decide whether the document is fiscal at all, so a quotation whose heading reads "OFERTA DE VENTA" must come back as "OFERTA DE VENTA" and not as "FACTURA".
- A Portuguese ATCUD exists ONLY on Portuguese AT-certified documents. NEVER produce an ATCUD-shaped code for a non-Portuguese document, and never invent one: if you cannot read it from the document, the corresponding field stays null.
- NEVER invent a tax number. If the NIF / VAT / CIF is not legible, return null. A guessed identifier is far worse than a missing one.
- Map every expense onto an SNC/PGC account in \`suggestedCategory\`. Common mappings for supplier invoices (FSE — Fornecimentos e Serviços Externos): "62.2.1 — Trabalhos especializados", "62.2.2 — Publicidade e propaganda", "62.2.3 — Vigilância e segurança", "62.2.4 — Honorários", "62.2.5 — Comissões", "62.2.6 — Conservação e reparação", "62.3.1 — Ferramentas e utensílios", "62.3.2 — Livros e documentação técnica", "62.3.3 — Material de escritório", "62.4.1 — Eletricidade", "62.4.2 — Combustíveis", "62.4.3 — Água", "62.4.4 — Gás", "62.5 — Deslocações, estadas e transporte", "62.6 — Serviços diversos". Common mappings for goods (CMVMC): "31.1 — Mercadorias", "31.2 — Matérias-primas". Use the most specific code you can justify. When in doubt pick a generic parent (e.g. "62 — Fornecimentos e serviços externos"). \`suggestedCategory\` is the signal that drives auto-filing into the correct accounting folder — be precise.
- Set \`isEuIntracommunity\` to true ONLY when the supplier is a non-Portuguese EU entity (any country in the EU except Portugal), the document is a true invoice (not a simplified receipt), and Portuguese VAT is NOT being charged (reverse charge / autoliquidação). A Spanish supplier charging 21% Spanish VAT is NOT intracommunity. A Spanish supplier issuing an invoice with no VAT for an EU B2B customer IS intracommunity.
- Extract \`lineItems\` from every line of the table — description, quantity, unit price, VAT rate, line total, AND per-line discount when printed ("Desconto" / "Desc" / "Discount" / "Rabatt" / "Remise"). Cap at the most informative 30 rows when the invoice is very long, but never drop the totals rows.
- ALWAYS extract \`dueDate\` — the payment deadline / "Prazo de pagamento" / "Due date" / "Fälligkeit" / "Échéance" / "Vencimiento". Look near "Vencimento", "Vencimiento", "A pagar até", "Data limite", or the final payment-terms block. If the document states payment terms like "Forma de Pago: 30 DÍAS", "30 dias", or "Net 30" without a calendar date, compute \`dueDate\` = \`docDate\` + N days (e.g. 2026-09-15 + 30 days = 2026-10-15). If it says "Pronto pagamento" / "Contado", \`dueDate\` = \`docDate\`. Return null only when truly absent; do NOT confuse with the invoice issue date (\`docDate\`).
- ALWAYS extract \`supplierPhone\` — phone or mobile number of the issuing supplier (near "Teléfono", "Telefone", "Tel:").
- \`discountAmount\` is the INVOICE-LEVEL discount ("Desconto global", "Desconto de cabeçalho", "Total desconto") — a single amount subtracted from the subtotal before VAT. Distinct from per-line \`discount\` on each lineItem. Return null (not 0) when neither is present.
- \`cashDiscountRate\` is the "desconto de pronto pagamento" — only present on PT and ES supplier invoices; null otherwise.
- \`ivaBreakdown\` MUST be present whenever the invoice carries more than one VAT rate — group line items by \`vatRate\` and emit one entry per rate: { rate, base, tax } where base = sum of net amounts at that rate (AFTER any per-line discounts, BEFORE global discount) and tax = base * rate/100. The sum of \`tax\` across all rates MUST equal \`taxAmount\`. Emit \`ivaBreakdown\` as null when the invoice has only one rate (the UI surfaces taxAmount in that case).

Rules:
- Return ONLY a single valid JSON object matching the schema below. No markdown fences, no commentary.
- DO NOT emit any <think> or <reasoning> reasoning block. The caller has already disabled thinking via API params; do NOT prepend a reasoning trace. Return the JSON object as your FIRST and ONLY output.
- If a field is not present in the document, return null (not an empty string, not 0).
- Numbers must be JSON numbers (not strings). Use dot as decimal separator (e.g. 1234.56).
- Dates in ISO format YYYY-MM-DD.
- IBANs may include spaces; strip them when reporting.
- The supplier's country is the country of the VAT ID prefix (PT to PT, ESB... to ES, FR... to FR).
- For Portuguese documents, prefer supplierNif over supplierVatId when the issuer is domestic.
- Confidence: 1.0 when every printed field is captured exactly; lower when fields are missing or ambiguous.

${VISION_JSON_SCHEMA_DESCRIPTION}`;

@Injectable()
export class VisionService {
  private readonly logger = new Logger(VisionService.name);

  /**
   * Cache for the tenant identity used to scope the prompt. Cleared at
   * the top of every `analyze()` call. Read by `buildPrompt()` so the
   * supplier-vs-customer identity rule is bound to the actual tenant
   * (e.g. NOV OUSADO UNIPESSOAL LDA / 515208566) rather than a generic
   * "[the tenant]" placeholder. Loaded lazily on first use from the
   * DB / env fallback (see `getTenantIdentity`).
   */
  private currentTenantIdentity: TenantIdentity | null = null;

  // Provider availability — determined at boot from env vars.
  private readonly anthropicKey: string | null;
  private readonly openaiKey: string | null;
  private readonly geminiKey: string | null;
  private readonly openrouterKey: string | null;
  private readonly minimaxKey: string | null;
  private readonly anthropicModel: string;
  private readonly openaiModel: string;
  private readonly geminiModel: string;
  private readonly openrouterModel: string;
  private readonly minimaxModel: string;
  /**
   * Gateway-style endpoint URLs — read from env so the user can swap
   * provider host/token/model via .env without code changes. Defaults
   * are the canonical OpenAI-compatible chat/completions endpoints.
   */
  private readonly openrouterUrl: string;
  private readonly minimaxUrl: string;
  /**
   * Stronger OpenRouter model used as the escalation target when the
   * primary OpenRouter call returns unusable numerics (no `total` /
   * obviously-corrupt `atQrRaw`). Set via `OPENROUTER_VISION_MODEL_ESCALATE`
   * — defaults to `gemini-2.5-pro` (the model the user verified
   * correctly reads the real Américo Alves / LIZOTEL / Mastergastro
   * phone photos that the 2.5-flash primary misreads).
   */
  private readonly openrouterEscalateModel: string;
  private readonly geminiUrl: string;
  private readonly openaiUrl: string;
  private readonly anthropicUrl: string | null;
  /** Fase 2 — configurable auto-routing order (VISION_PROVIDER_ORDER). */
  private readonly providerOrder: VisionProviderName[];
  /** Fase 2 — below this confidence a second provider is consulted. */
  private readonly secondOpinionThreshold: number;

  // Gemini is reached THROUGH OpenRouter (OPENROUTER_API_KEY, model
  // google/gemini-2.5-flash) — there is no direct Google key in this
  // deployment. A direct `gemini` gateway stays supported as an optional
  // second provider.
  static readonly DEFAULT_PROVIDER_ORDER: VisionProviderName[] = [
    'openrouter',
    'gemini',
    'minimax',
    'openai',
    'anthropic',
  ];

  static parseProviderOrder(raw: string | undefined): VisionProviderName[] {
    const valid = new Set<string>(VisionService.DEFAULT_PROVIDER_ORDER);
    const parsed = (raw ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s): s is VisionProviderName => valid.has(s));
    const unique = parsed.filter((p, i) => parsed.indexOf(p) === i);
    // Providers not mentioned keep their default relative order after the
    // explicit ones, so a partial list like "openrouter" still falls back.
    for (const p of VisionService.DEFAULT_PROVIDER_ORDER) {
      if (!unique.includes(p)) unique.push(p);
    }
    return unique;
  }

  static parseThreshold(raw: string | undefined): number {
    const n = Number(raw);
    if (!raw || !Number.isFinite(n) || n < 0 || n > 1) return 0.7;
    return n;
  }

  /** ConfigService.get that treats "" as unset (docker-compose passes unset vars as ""). */
  private cfg(name: string): string | undefined {
    const v = this.config.get<string>(name);
    return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
  }

  constructor(
    private config: ConfigService,
    @Optional()
    private readonly prisma?: PrismaService,
    @Optional()
    private readonly faturista?: FaturistaProvider,
  ) {
    // Fase 2 — every provider is a gateway {URL, TOKEN, MODEL}. The
    // `<PROVIDER>_TOKEN` / `<PROVIDER>_MODEL` / `<PROVIDER>_URL` names are
    // canonical (docs/LLM_GATEWAY_PLAN.md); the older `*_API_KEY` /
    // `*_VISION_MODEL` names stay as aliases so no deployment breaks.
    // Empty strings (docker-compose passes unset vars as "") count as unset.
    this.anthropicKey = this.readKey(['ANTHROPIC_TOKEN', 'ANTHROPIC_API_KEY']);
    this.openaiKey = this.readKey(['OPENAI_TOKEN', 'OPENAI_API_KEY']);
    this.geminiKey = this.readKey(['GEMINI_TOKEN', 'GOOGLE_API_KEY', 'GEMINI_API_KEY']);
    this.openrouterKey = this.readKey(['OPENROUTER_TOKEN', 'OPENROUTER_API_KEY']);
    this.minimaxKey = this.readKey(['MINIMAX_TOKEN', 'MINIMAX_API_KEY']);
    this.anthropicModel =
      this.cfg('ANTHROPIC_MODEL') ??
      this.cfg('ANTHROPIC_VISION_MODEL') ??
      'claude-3-5-sonnet-20241022';
    this.openaiModel =
      this.cfg('OPENAI_MODEL') ?? this.cfg('OPENAI_VISION_MODEL') ?? 'gpt-4o';
    this.geminiModel =
      this.cfg('GEMINI_MODEL') ?? this.cfg('GEMINI_VISION_MODEL') ?? 'gemini-3.6-flash';
    this.openrouterModel =
      this.cfg('OPENROUTER_MODEL') ??
      this.cfg('OPENROUTER_VISION_MODEL') ??
      'google/gemini-2.5-flash';
    this.minimaxModel =
      this.cfg('MINIMAX_MODEL') ?? this.cfg('MINIMAX_VISION_MODEL') ?? 'MiniMax-M3';
    this.openrouterUrl =
      this.cfg('OPENROUTER_URL') ??
      'https://openrouter.ai/api/v1/chat/completions';
    this.minimaxUrl =
      this.cfg('MINIMAX_URL') ??
      'https://api.minimax.io/v1/chat/completions';
    this.geminiUrl = (
      this.cfg('GEMINI_URL') ??
      'https://generativelanguage.googleapis.com/v1beta'
    ).replace(/\/+$/, '');
    this.openaiUrl =
      this.cfg('OPENAI_URL') ?? 'https://api.openai.com/v1/chat/completions';
    this.anthropicUrl = this.cfg('ANTHROPIC_URL') ?? null;
    this.openrouterEscalateModel =
      this.cfg('OPENROUTER_MODEL_ESCALATE') ??
      this.cfg('OPENROUTER_VISION_MODEL_ESCALATE') ??
      'google/gemini-2.5-pro';
    this.providerOrder = VisionService.parseProviderOrder(
      this.cfg('VISION_PROVIDER_ORDER'),
    );
    this.secondOpinionThreshold = VisionService.parseThreshold(
      this.cfg('VISION_SECOND_OPINION_CONFIDENCE'),
    );

    if (this.liveProviderAvailable) {
      this.logger.log(
        `Vision providers — anthropic:${this.hasAnthropic} openai:${this.hasOpenAI} ` +
          `gemini:${this.hasGemini} openrouter:${this.hasOpenrouter} ` +
          `minimax:${this.hasMinimax}`,
      );
    } else {
      this.logger.log(
        'Vision: no provider key configured (ANTHROPIC_API_KEY / OPENAI_API_KEY / GOOGLE_API_KEY / OPENROUTER_API_KEY / MINIMAX_API_KEY). ' +
          'Returning null so the regex pipeline can take over.',
      );
    }
  }

  /** True when at least one vision-capable provider is configured. */
  get liveProviderAvailable(): boolean {
    return (
      this.hasAnthropic ||
      this.hasOpenAI ||
      this.hasGemini ||
      this.hasOpenrouter ||
      this.hasMinimax ||
      Boolean(this.faturista?.isAvailable)
    );
  }

  get hasAnthropic(): boolean {
    return !!this.anthropicKey;
  }
  get hasOpenAI(): boolean {
    return !!this.openaiKey;
  }
  get hasGemini(): boolean {
    return !!this.geminiKey;
  }
  get hasOpenrouter(): boolean {
    return !!this.openrouterKey;
  }
  get hasMinimax(): boolean {
    return !!this.minimaxKey;
  }
  hasProvider(p: VisionProviderName): boolean {
    switch (p) {
      case 'gemini':
        return this.hasGemini;
      case 'openrouter':
        return this.hasOpenrouter;
      case 'minimax':
        return this.hasMinimax;
      case 'openai':
        return this.hasOpenAI;
      case 'anthropic':
        return this.hasAnthropic;
      case 'faturista':
        return Boolean(this.faturista?.isAvailable);
      default:
        return false;
    }
  }

  /**
   * Which provider we'd use by default given the keys configured.
   *
   * Provider priority (2026-09-01):
   *   1. **MiniMax** PRIMARY — OpenAI-compatible chat/completions at
   *      `MINIMAX_URL` with `MINIMAX_VISION_MODEL` (default `MiniMax-M3`).
   *      Verified end-to-end on the user's real Américo Alves phone
   *      photo with `MINIMAX_API_KEY` set. OpenAI-compatible response
   *      shape; tolerates a <think> block before the JSON.
   *   2. **OpenRouter** FALLBACK — `google/gemini-2.5-flash` via
   *      OpenRouter. Free, multimodal, fast, returns in 3-8s.
   *   3. **Direct Gemini** COLD BACKUP — used only when BOTH
   *      MiniMax and OpenRouter are unreachable AND a direct Gemini
   *      key is configured. Direct keys have been quota-exhausted
   *      recently; this is the cold backup.
   *
   * The user wanted MiniMax primary because it's the only provider
   * that returns COMPLETE JSON on every retry on the real Américo
   * Alves phone photo (no truncation, no rate limits).
   */
  resolveProvider(
    preferred: VisionAnalysisRequest['preferredProvider'] = 'auto',
  ): VisionProviderName | null {
    if (preferred === 'anthropic' && this.hasAnthropic) return 'anthropic';
    if (preferred === 'openai' && this.hasOpenAI) return 'openai';
    if (preferred === 'gemini' && this.hasGemini) return 'gemini';
    if (preferred === 'openrouter' && this.hasOpenrouter) return 'openrouter';
    if (preferred === 'minimax' && this.hasMinimax) return 'minimax';
    if (preferred === 'faturista' && this.faturista?.isAvailable) return 'faturista';
    if (preferred !== 'auto') return null;
    // Fase 2 — OpenRouter (Gemini 2.5 Flash via OpenRouter) is the primary
    // vision provider; the rest follow VISION_PROVIDER_ORDER.
    for (const p of this.providerOrder) {
      if (this.hasProvider(p)) return p;
    }
    return null;
  }

  /**
   * Analyse a document with multimodal AI. Returns `null` when no provider
   * is configured (so the caller falls back to regex). Returns
   * `{ fallbackUsed: true, ... }` when the provider was contacted but the
   * response could not be parsed; the caller still falls back to regex but
   * can log the partial payload.
   *
   * Hard cap on wall-clock: `timeoutMs` (default 30s). Anything slower is
   * treated as a failure and the regex path runs.
   *
   * Retry contract (OpenRouter / Gemini only): when the first call returns
   * a parse failure (`fallbackUsed: true`), retry ONCE with `temperature:
   * 0.0` and a stripped prompt that asks for top-level fields only (omit
   * `lineItems`). This turns the most common Gemini 2.5-flash failure mode
   * (token-cap truncation on long documents) into a clean second-chance.
   * After the retry, if it still fails we keep the FIRST failure result
   * so the caller can still log a `fallbackUsed` warning — the retry is
   * best-effort, never a silent fallback to the regex.
   */
  async analyze(
    request: VisionAnalysisRequest,
  ): Promise<VisionAnalysisResult | null> {
    // Refresh the tenant identity block so the prompt always names the
    // correct owning-company. The caller may pass the tenant id via
    // `request.tenantId` (optional, falls back to env/default).
    const tenantHint =
      (request as VisionAnalysisRequest & { tenantId?: string }).tenantId;
    await this.setTenantIdentity(tenantHint);

    const provider = this.resolveProvider(request.preferredProvider);
    if (!provider) {
      return null;
    }

    if (provider === 'faturista') {
      return this.faturista?.extract(request) ?? null;
    }

    // If we got neither a multimodal payload nor text, refuse — the caller
    // should not invoke vision on empty input.
    if (!request.fileBase64 && !request.text) {
      this.logger.debug(
        'vision.analyze called with no payload — returning null',
      );
      return null;
    }

    // Fase 4.6 (P3): Encadeamento Faturista para faturas portuguesas com fallback suave para generalista
    if (this.faturista?.isAvailable && this.isLikelyPortugueseInvoice(request)) {
      try {
        const faturistaResult = await this.faturista.extract(request);
        if (faturistaResult && isUsableForFallback(faturistaResult) && faturistaResult.confidence >= 0.70) {
          this.logger.log(
            `[vision.analyze] Faturista especializado PT processou com sucesso: conf=${faturistaResult.confidence.toFixed(2)}`,
          );
          return faturistaResult;
        }
        this.logger.log(
          '[vision.analyze] Faturista com confiança baixa ou campos insuficientes — caindo para provider generalista',
        );
      } catch (faturistaErr) {
        this.logger.warn(
          `[vision.analyze] Faturista falhou: ${(faturistaErr as Error).message} — caindo para provider generalista`,
        );
      }
    }

    const timeoutMs = request.timeoutMs ?? 30_000;
    const started = Date.now();

    // ── FALLBACK CHAIN ────────────────────────────────────────────
    // 2026-09-01 (gap-fix iteration): previously the fallback chain
    // only lived in the CATCH block — when the primary provider
    // returned an empty / parseable-but-useless result, the code
    // returned that weak result and the caller (extraction service)
    // wrote a `needs_review` row with no supplier / no total. The
    // user wanted: when MiniMax underperforms, fall through to
    // OpenRouter BEFORE giving up, and when OpenRouter also
    // underperforms, fall through to direct Gemini. Only after every
    // configured provider fails to return a usable result do we
    // return null so the caller marks `needs_review`.
    //
    // The chain order is fixed: primary → OpenRouter → Gemini.
    // `anthropic` / `openai` are NOT in the chain — they're opt-in via
    // `preferredProvider` only.
    const chain = this.buildProviderChain(provider);

    let lastError: Error | null = null;
    let lastWeakResult: VisionAnalysisResult | null = null;
    for (let i = 0; i < chain.length; i++) {
      const current = chain[i];
      let result: VisionAnalysisResult | null;
      try {
        result = await this.tryProvider(current, request, timeoutMs);
      } catch (err) {
        lastError = err as Error;
        this.logger.warn(
          `Vision: provider '${current}' failed after ${Date.now() - started}ms: ` +
            `${(err as Error).message}. ` +
            (i < chain.length - 1
              ? `Falling through to '${chain[i + 1]}'.`
              : 'No more providers — chain exhausted.'),
        );
        continue;
      }

      result.processingTimeMs = Date.now() - started;

      // First-time success — keep the existing escalation gate for
      // openrouter / MiniMax primaries (the gemini-2.5-pro retry that
      // rescues corrupt `O:` blocks). The escalation runs BEFORE the
      // `isUsableForFallback` check so a primary OpenRouter result
      // with corrupt QR data still gets one shot at the stronger
      // model before we fall through to direct Gemini.
      if (i === 0) {
        const escalated = await this.maybeEscalate(
          current,
          request,
          result,
          timeoutMs,
          started,
        );
        if (escalated) result = escalated;
      }

      // USABILITY GATE — accept the result only when it carries at
      // least one authoritative fiscal signal AND confidence > 0.
      // Empty results (`fallbackUsed: true` after all 3 retries),
      // null payloads, or low-confidence guesses are treated as a
      // failure and we fall through to the next provider in the chain.
      if (isUsableForFallback(result)) {
        // Fase 2 — second opinion: when the winning result is weak
        // (confidence < VISION_SECOND_OPINION_CONFIDENCE, default 0.7) and
        // another provider is configured, ask it too and keep the more
        // confident answer. Bounded to ONE extra call.
        if (
          result.confidence < this.secondOpinionThreshold &&
          i + 1 < chain.length &&
          !result.secondOpinion
        ) {
          const next = chain[i + 1];
          this.logger.warn(
            `Vision: '${current}' returned confidence=${result.confidence.toFixed(2)} ` +
              `< ${this.secondOpinionThreshold} — asking '${next}' for a second opinion.`,
          );
          try {
            const second = await this.tryProvider(next, request, timeoutMs);
            second.processingTimeMs = Date.now() - started;
            if (isUsableForFallback(second) && second.confidence > result.confidence) {
              this.logger.log(
                `Vision: second opinion from '${next}' wins ` +
                  `(${second.confidence.toFixed(2)} > ${result.confidence.toFixed(2)}).`,
              );
              second.secondOpinion = { provider: current, confidence: result.confidence };
              result = second;
            } else {
              result.secondOpinion = { provider: next, confidence: second.confidence };
            }
          } catch (err) {
            this.logger.warn(
              `Vision: second opinion from '${next}' failed: ${(err as Error).message}`,
            );
          }
        }
        if (current !== provider) {
          this.logger.log(
            `Vision: primary '${provider}' returned no usable data; ` +
              `provider '${current}' succeeded ` +
              `(provider=${result.provider}/${result.model}, ` +
              `total=${String(result.extracted.total)}, ` +
              `supplier=${String(result.extracted.supplier ?? null)}). ` +
              `Returning the fallback result.`,
          );
        }
        return result;
      }

      // Result returned but unusable — fall through.
      this.logger.warn(
        `Vision: provider '${current}' returned UNUSABLE result ` +
          `(fallbackUsed=${result.fallbackUsed}, ` +
          `hasSupplier=${typeof result.extracted.supplier === 'string'}, ` +
          `hasTotal=${typeof result.extracted.total === 'number'}, ` +
          `hasNet=${typeof result.extracted.netAmount === 'number'}, ` +
          `hasSupplierNif=${typeof result.extracted.supplierNif === 'string'}, ` +
          `hasDocNumber=${typeof result.extracted.docNumber === 'string'}, ` +
          `hasAtQrRaw=${typeof result.extracted.atQrRaw === 'string'}, ` +
          `confidence=${result.confidence.toFixed(2)}). ` +
          (i < chain.length - 1
            ? `Falling through to '${chain[i + 1]}'.`
            : 'No more providers — chain exhausted.'),
      );
      lastWeakResult = result;
    }

    // Chain exhausted — every provider either threw or returned an
    // unusable result. Per the user's 2026-09-01 gap-fix: return null
    // so the caller (`runAiOrRegexPath` in extraction service) marks
    // the document `needs_review` for image-only sources. Returning
    // a weak-but-non-null result here would silently emit
    // `aiProvider: <weak>` and let the regex path promote an empty
    // confidence, which is exactly the bug the gap-fix is meant to
    // close.
    this.logger.warn(
      `Vision: chain exhausted with no usable result ` +
        `(tried ${chain.length} provider(s); ` +
        `${lastWeakResult ? `last weak result had fallbackUsed=${lastWeakResult.fallbackUsed}, ` : ''}` +
        `${lastError ? `last error: ${lastError.message}` : 'no provider errored'}). ` +
        `Returning null so caller marks needs_review.`,
    );
    return null;
  }

  /**
   * Deteta se o documento apresenta fortes sinais fiscais portugueses
   * (ATCUD, formato de QR-AT, NIF PT de 9 dígitos ou terminologia fiscal PT).
   */
  private isLikelyPortugueseInvoice(request: VisionAnalysisRequest): boolean {
    const text = (request.text ?? '').toLowerCase();
    const name = (request.fileName ?? '').toLowerCase();

    if (text.includes('atcud') || /\b[a-z0-9]+-[0-9]+\b/i.test(text)) return true;
    if (/a:\d{9}\*b:/i.test(text)) return true;
    if (/(fatura|fatura-recibo|recibo|nota de crédito|contribuinte|iva)/i.test(text)) return true;
    if (/(\bpt\d{9}\b|\b\d{9}\b)/i.test(text) && /(iva|total|retencao|continente|madeira|acores)/i.test(text)) return true;
    if (name.includes('pt') || name.includes('fatura') || name.includes('recibo')) return true;
    return false;
  }

  /**
   * Build the ordered provider chain for `analyze()`. The first
   * element is always the resolved primary; the rest are the
   * configured fallbacks in canonical order. Anthropic / OpenAI are
   * NEVER in the chain — they're opt-in via `preferredProvider`.
   *
   * When the primary IS already one of the canonical fallback
   * providers (e.g. the user pinned `preferredProvider=openrouter`),
   * the chain dedupes so we don't call the same provider twice.
   */
  private buildProviderChain(
    primary: 'anthropic' | 'openai' | 'gemini' | 'openrouter' | 'minimax',
  ): Array<'gemini' | 'openrouter' | 'minimax' | 'anthropic' | 'openai'> {
    const canonical: Array<'minimax' | 'openrouter' | 'gemini'> = [];
    for (const p of this.providerOrder) {
      if ((p === 'gemini' || p === 'openrouter' || p === 'minimax') && this.hasProvider(p)) {
        canonical.push(p);
      }
    }

    // For the canonical primaries, dedupe so we don't call the same
    // provider twice when the user pinned a fallback as primary.
    const filteredCanonical = canonical.filter((p) => p !== primary);

    if (primary === 'anthropic' || primary === 'openai') {
      // Off-chain primary sits at position 0, canonical chain after.
      return [primary, ...canonical];
    }
    return [primary, ...filteredCanonical];
  }

  /**
   * Run a single provider's vision call and tag the result with the
   * canonical composite provider string the operator sees in
   * `metadata.extraction.aiProvider`. Throws on transport / parse
   * failure so the chain can decide whether to fall through.
   *
   * The retry loop lives INSIDE each provider's call* method (e.g.
   * `callMinimax` makes 2 attempts, `callOpenRouterWithModel` makes 3).
   * A throw here means every in-call retry already failed.
   */
  private async tryProvider(
    provider: 'gemini' | 'openrouter' | 'minimax' | 'anthropic' | 'openai',
    request: VisionAnalysisRequest,
    timeoutMs: number,
  ): Promise<VisionAnalysisResult> {
    switch (provider) {
      case 'anthropic': {
        const r = await this.callAnthropic(request, timeoutMs);
        return r;
      }
      case 'openai': {
        const r = await this.callOpenAI(request, timeoutMs);
        return r;
      }
      case 'gemini': {
        const r = await this.callGemini(request, timeoutMs);
        r.provider = 'gemini';
        return r;
      }
      case 'openrouter': {
        const r = await this.callOpenRouter(request, timeoutMs);
        r.provider = `openrouter/${r.model}`;
        return r;
      }
      case 'minimax': {
        const r = await this.callMinimax(request, timeoutMs);
        r.provider = `minimax/${r.model}`;
        return r;
      }
    }
  }

  /**
   * Optional second-chance escalation for openrouter / MiniMax
   * primaries whose extracted numerics are corrupt (the
   * `O:20250217.37005` / `total:31082026` patterns on real phone
   * photos). When the primary is one of those and the result is
   * parseable but `isVisionResultUsable` returns false, retry ONCE on
   * the stronger OpenRouter escalation model. Returns the escalated
   * result when it carries usable numerics; returns null otherwise.
   *
   * This is the same gate that existed before the gap-fix; it runs
   * once for the primary slot BEFORE the chain's `isUsableForFallback`
   * check, so a primary with corrupt QR data gets one shot at
   * gemini-2.5-pro before the chain falls through to direct Gemini.
   *
   * 2026-09-01 gap-fix: this gate is intentionally scoped to the
   * OPENROUTER primary only. When the primary is MiniMax, an empty /
   * incomplete result goes straight to the chain (no gemini-2.5-pro
   * detour) — the chain's next slot is already an OpenRouter call
   * (`gemini-2.5-flash`), and burning an extra escalation call before
   * that would just delay the chain's natural progression without
   * changing which OpenRouter model wins. For an OpenRouter primary,
   * the escalation still runs because the corrupt-QR problem is
   * specific to `gemini-2.5-flash` and the stronger `gemini-2.5-pro`
   * is the documented fix.
   */
  private async maybeEscalate(
    primary: 'gemini' | 'openrouter' | 'minimax' | 'anthropic' | 'openai',
    request: VisionAnalysisRequest,
    result: VisionAnalysisResult,
    timeoutMs: number,
    started: number,
  ): Promise<VisionAnalysisResult | null> {
    if (
      !result ||
      result.fallbackUsed ||
      !request.fileBase64 ||
      primary !== 'openrouter' ||
      !this.openrouterEscalateModel ||
      this.openrouterEscalateModel === this.openrouterModel ||
      isVisionResultUsable(result)
    ) {
      return null;
    }
    const before = Date.now();
    const overallBudgetMs = timeoutMs * 2;
    const elapsed = Date.now() - started;
    const escalateTimeoutMs = Math.max(
      5_000,
      Math.min(50_000, overallBudgetMs - elapsed),
    );
    this.logger.warn(
      `Vision: ${result.provider}/${result.model} returned unusable numerics ` +
        `(total=${String(result.extracted.total)}, atQrRaw.O preview=${previewAtQrOField(result.extracted.atQrRaw)}). ` +
        `Escalating to ${this.openrouterEscalateModel} (timeout=${escalateTimeoutMs}ms).`,
    );
    try {
      const escalated = await this.callOpenRouterEscalation(
        request,
        escalateTimeoutMs,
      );
      if (!escalated.fallbackUsed && isVisionResultUsable(escalated)) {
        escalated.processingTimeMs = Date.now() - started;
        escalated.provider = `openrouter/${stripVendorPrefix(this.openrouterEscalateModel)}`;
        this.logger.log(
          `Vision: escalation to ${this.openrouterEscalateModel} succeeded ` +
            `after ${Date.now() - before}ms — total=${escalated.extracted.total}, ` +
            `supplier=${escalated.extracted.supplier ?? '?'}.`,
        );
        return escalated;
      }
      this.logger.warn(
        `Vision: escalation returned fallbackUsed=${escalated.fallbackUsed} ` +
          `or still-unusable numerics after ${Date.now() - before}ms. ` +
          `Keeping primary result.`,
      );
    } catch (escErr) {
      this.logger.warn(
        `Vision: escalation threw after ${Date.now() - before}ms: ` +
          `${(escErr as Error).message}. Keeping primary result.`,
      );
    }
    return null;
  }

  // NOTE: the original `analyze()` returned a chain that only
  // triggered on transport errors (the catch block). That chain is
  // now expressed via `buildProviderChain` + `tryProvider` +
  // `maybeEscalate` above; the rest of the file (the
  // 3-attempt-retry call* methods, the extraction prompt, the JSON
  // parser) is unchanged.

  /**
   * Same shape as `callOpenRouter` / `callGemini` but with a stripped-down
   * prompt (no `lineItems`, `ivaBreakdown`, `cashDiscountRate`, etc.) and
   * `temperature: 0.0`. Used by `analyze()` for the retry-once path when
   * the first response was truncated by the output-token cap.
   */
  private async callWithStrippedPrompt(
    provider: 'openrouter' | 'gemini',
    request: VisionAnalysisRequest,
    timeoutMs: number,
  ): Promise<VisionAnalysisResult> {
    const strippedText =
      `${SYSTEM_PROMPT}\n\n` +
      'IMPORTANT — this is a retry because the previous response was truncated. ' +
      'Return ONLY the top-level JSON object. OMIT `lineItems` entirely. ' +
      'Keep `ivaBreakdown` to AT MOST one entry (the dominant rate). ' +
      'Numbers must be JSON numbers (not strings). No markdown fences, no commentary.';
    const request2: VisionAnalysisRequest = {
      ...request,
      documentContext: 'invoice',
    };
    // Override the prompt by re-using the underlying call but with a
    // monkey-patched `buildPrompt` result. The cheapest path is to inline
    // the request change via a small switch — keeping it simple.
    const userContent: Array<Record<string, unknown>> = [];
    if (request2.fileBase64 && request2.mimeType) {
      if (provider === 'openrouter') {
        userContent.push({
          type: 'image_url',
          image_url: { url: `data:${request2.mimeType};base64,${request2.fileBase64}` },
        });
      } else {
        userContent.push({
          inline_data: { mime_type: request2.mimeType, data: request2.fileBase64 },
        });
      }
    }
    userContent.push({
      text:
        (request2.fileName ? `File: ${request2.fileName}\n\n` : '') +
        (request2.text ?? 'Extract the invoice fields from the attached document.'),
    });

    if (provider === 'openrouter') {
      return this.callOpenRouterRaw(userContent, strippedText, timeoutMs, request2.modelOverride);
    }
    return this.callGeminiRaw(userContent, strippedText, timeoutMs, request2.modelOverride);
  }

  /**
   * Raw OpenRouter call with an overridden prompt + temperature. Mirrors
   * the body shape of `callOpenRouter` but skips the schema-block in the
   * system prompt (the retry prompt embeds the trim instruction itself).
   */
  private async callOpenRouterRaw(
    userContent: Array<Record<string, unknown>>,
    systemPrompt: string,
    timeoutMs: number,
    modelOverride?: string,
  ): Promise<VisionAnalysisResult> {
    if (!this.openrouterKey) throw new Error('OPENROUTER_API_KEY not set');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const f = (globalThis as any).fetch as typeof fetch;
    if (typeof f !== 'function') {
      throw new Error('global fetch() is not available');
    }
    const model = modelOverride || this.openrouterModel;
    const body = {
      model,
      temperature: 0.0,
      max_tokens: 2048,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await f(this.openrouterUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.openrouterKey}`,
          'http-referer': 'https://docflow.local',
          'x-title': 'DocFlow',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(`openrouter ${resp.status} ${resp.statusText}: ${text.slice(0, 200)}`);
      }
      const json = (await resp.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
        model?: string;
      };
      const raw = json.choices?.[0]?.message?.content ?? '';
      const reportedModel = json.model ?? model;
      const modelForResult = stripVendorPrefix(reportedModel);
      return this.shapeResult('openrouter', modelForResult, raw, json.usage?.prompt_tokens, json.usage?.completion_tokens);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Raw direct-Gemini call with an overridden prompt + temperature. Mirror
   * of `callGemini` used by the retry-once path. The retry never goes via
   * the OpenRouter-tagged provider so this only runs when the primary
   * OpenRouter path already failed AND the user has a direct Gemini key
   * AND the original OpenRouter call returned fallbackUsed (NOT threw).
   */
  private async callGeminiRaw(
    userContent: Array<Record<string, unknown>>,
    systemPrompt: string,
    timeoutMs: number,
    modelOverride?: string,
  ): Promise<VisionAnalysisResult> {
    if (!this.geminiKey) throw new Error('GOOGLE_API_KEY/GEMINI_API_KEY not set');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const f = (globalThis as any).fetch as typeof fetch;
    if (typeof f !== 'function') {
      throw new Error('global fetch() is not available');
    }
    const model = modelOverride || this.geminiModel;
    const url =
      `${this.geminiUrl}/models/` +
      `${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(this.geminiKey)}`;
    const body = {
      contents: [{ role: 'user', parts: userContent }],
      systemInstruction: { parts: [{ text: systemPrompt }] },
      generationConfig: {
        temperature: 0.0,
        maxOutputTokens: 2048,
        responseMimeType: 'application/json',
      },
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await f(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(`gemini ${resp.status} ${resp.statusText}: ${text.slice(0, 200)}`);
      }
      const json = (await resp.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
      };
      const raw =
        json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
      return this.shapeResult('gemini', model, raw, json.usageMetadata?.promptTokenCount, json.usageMetadata?.candidatesTokenCount);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Build the vision extraction prompt for a given document context.
   * Always appends the OWN-company identity block so the model knows
   * which party is the buyer vs the supplier — without this, the AI
   * will sometimes guess wrong on invoices where the tenant's own
   * company appears in the header (real bug from the user's
   * Américo Alves photo on 2026-09-01).
   */
  buildPrompt(context: VisionAnalysisRequest['documentContext'] = 'invoice'): string {
    const tenantBlock = this.formatTenantIdentityBlock();
    if (context === 'receipt') {
      return (
        `${SYSTEM_PROMPT}\n\n${tenantBlock}\n\n` +
        'This document is a sales RECEIPT (recibo / quittung / receipt). ' +
        'If `documentType` is ambiguous, lean toward "RECIBO".'
      );
    }
    if (context === 'dua') {
      return (
        `${SYSTEM_PROMPT}\n\n${tenantBlock}\n\n` +
        'This document is a Portuguese customs declaration (DUA). ' +
        'Capture the full duty/VAT breakdown in `ivaBreakdown` and the customs reference number in `docNumber`.'
      );
    }
    if (context === 'delivery_note') {
      return (
        `${SYSTEM_PROMPT}\n\n${tenantBlock}\n\n` +
        'This document is a delivery note (guia de remessa / CMR / packing slip). ' +
        'If a monetary total is not present, set total/taxAmount/netAmount to null.'
      );
    }
    return `${SYSTEM_PROMPT}\n\n${tenantBlock}`;
  }

  /**
   * Format the tenant identity block that gets appended to every
   * prompt. Returns an empty string when no tenant identity is
   * available (e.g. test fixture without a DB) — in that case the
   * generic rule from `SYSTEM_PROMPT` ("whichever NIF is NOT the
   * tenant's = supplier") still applies. The extraction service's
   * `ensureSupplierCustomerSanity()` post-process is the second
   * safety net.
   */
  private formatTenantIdentityBlock(): string {
    const id = this.currentTenantIdentity;
    if (!id || !id.tenantNif || id.tenantNif.length === 0) return '';
    const nifFmt = formatPtNif(id.tenantNif);
    const name = (id.tenantName ?? '').trim() || 'the acquiring company';
    return (
      `TENANT IDENTITY (acquirer / cliente / buyer):\n` +
      `- Company name: ${name}\n` +
      `- Tax ID (NIF): ${nifFmt}\n\n` +
      `When extracting supplier vs customer from this document:\n` +
      `- The party whose NIF matches ${nifFmt} is the CUSTOMER/adquirente (us).\n` +
      `- The OTHER party is the SUPPLIER/fornecedor (entidade emissora).\n` +
      `- Never put our own company as the supplier — even if the document layout looks ambiguous.\n` +
      `- If the document does not carry ${nifFmt} as either party's NIF, still classify by issuer vs acquirer semantics: the issuer (the company issuing the document / charging for goods or services) is the SUPPLIER; the acquirer (the company being billed) is the CUSTOMER.`
    );
  }

  /**
   * Inject the tenant identity for the current vision call. Called by
   * `analyze()` (and by the retry/escalation paths) so the prompt
   * always carries the right owning-company block.
   *
   * Accepts the tenant id when known (preferred) and falls back to the
   * demo slug / env / hard-coded default via `getTenantIdentity`.
   * Never throws — returns the fallback identity on any DB error so
   * the call proceeds with at least the safety-net prompt block.
   */
  async setTenantIdentity(tenantId?: string): Promise<TenantIdentity> {
    if (!this.prisma) {
      this.currentTenantIdentity = {
        tenantName: process.env.DOCFLOW_OWN_NAME ?? 'NOV OUSADO UNIPESSOAL LDA',
        tenantNif: process.env.DOCFLOW_OWN_NIF ?? '515208566',
      };
      return this.currentTenantIdentity;
    }
    try {
      this.currentTenantIdentity = await getTenantIdentity(this.prisma, tenantId);
    } catch (err) {
      this.logger.warn(
        `VisionService.setTenantIdentity: DB lookup failed (${(err as Error).message}); ` +
          `falling back to env/default.`,
      );
      this.currentTenantIdentity = {
        tenantName: process.env.DOCFLOW_OWN_NAME ?? 'NOV OUSADO UNIPESSOAL LDA',
        tenantNif: process.env.DOCFLOW_OWN_NIF ?? '515208566',
      };
    }
    return this.currentTenantIdentity;
  }

  /** Skip vision when the QR/regex pipeline already captured the key fields. */
  canSkipVision(extracted: Record<string, unknown>): boolean {
    return !!(
      extracted['nif'] &&
      extracted['totalAmount'] &&
      extracted['atcud']
    );
  }

  // ---------------------------------------------------------------------------
  // Provider calls
  // ---------------------------------------------------------------------------

  private async callAnthropic(
    request: VisionAnalysisRequest,
    timeoutMs: number,
  ): Promise<VisionAnalysisResult> {
    if (!this.anthropicKey) throw new Error('ANTHROPIC_API_KEY not set');

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Anthropic = require('@anthropic-ai/sdk').default;
    const client = new Anthropic({
      apiKey: this.anthropicKey,
      ...(this.anthropicUrl ? { baseURL: this.anthropicUrl } : {}),
    });

    const userContent: Array<Record<string, unknown>> = [];
    if (request.fileBase64 && request.mimeType) {
      if (request.mimeType === 'application/pdf') {
        userContent.push({
          type: 'document',
          source: {
            type: 'base64',
            media_type: 'application/pdf',
            data: request.fileBase64,
          },
        });
      } else if (/^image\//.test(request.mimeType)) {
        userContent.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: request.mimeType,
            data: request.fileBase64,
          },
        });
      }
    }
    userContent.push({
      type: 'text',
      text:
        (request.fileName ? `File: ${request.fileName}\n\n` : '') +
        (request.text ?? 'Extract the invoice fields from the attached document.'),
    });

    const model = request.modelOverride || this.anthropicModel;
    const resp = (await this.withTimeout(
      client.messages.create({
        model,
        max_tokens: 2048,
        temperature: 0.1,
        system: this.buildPrompt(request.documentContext),
        messages: [{ role: 'user', content: userContent }],
      }),
      timeoutMs,
      'anthropic',
    )) as {
      content?: Array<{ type: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };

    const raw = (resp.content ?? [])
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('')
      .trim();

    return this.shapeResult(
      'anthropic',
      model,
      raw,
      resp.usage?.input_tokens,
      resp.usage?.output_tokens,
    );
  }

  private async callOpenAI(
    request: VisionAnalysisRequest,
    timeoutMs: number,
  ): Promise<VisionAnalysisResult> {
    if (!this.openaiKey) throw new Error('OPENAI_API_KEY not set');

    // We use the Chat Completions endpoint with the `response_format`
    // JSON-schema hint — works with gpt-4o and gpt-4o-mini.
    // Node 18+ exposes fetch on globalThis; older runtimes would need
    // a node-fetch polyfill, which we don't add here (the API requires
    // Node 18 per package.json engines).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const f = (globalThis as any).fetch as typeof fetch;
    if (typeof f !== 'function') {
      throw new Error(
        'global fetch() is not available — OpenAI call requires Node 18+',
      );
    }

    const userContent: Array<Record<string, unknown>> = [];
    if (request.fileBase64 && request.mimeType) {
      const dataUrl = `data:${request.mimeType};base64,${request.fileBase64}`;
      if (request.mimeType === 'application/pdf') {
        userContent.push({ type: 'image_url', image_url: { url: dataUrl } });
      } else {
        userContent.push({ type: 'image_url', image_url: { url: dataUrl } });
      }
    }
    userContent.push({
      type: 'text',
      text:
        (request.fileName ? `File: ${request.fileName}\n\n` : '') +
        (request.text ?? 'Extract the invoice fields from the attached document.'),
    });

    const model = request.modelOverride || this.openaiModel;
    const body = {
      model,
      temperature: 0.1,
      max_tokens: 4096,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: this.buildPrompt(request.documentContext) },
        { role: 'user', content: userContent },
      ],
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await f(this.openaiUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.openaiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(
          `openai ${resp.status} ${resp.statusText}: ${text.slice(0, 200)}`,
        );
      }
      const json = (await resp.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const raw = json.choices?.[0]?.message?.content ?? '';
      return this.shapeResult(
        'openai',
        model,
        raw,
        json.usage?.prompt_tokens,
        json.usage?.completion_tokens,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private async callGemini(
    request: VisionAnalysisRequest,
    timeoutMs: number,
  ): Promise<VisionAnalysisResult> {
    if (!this.geminiKey) throw new Error('GOOGLE_API_KEY/GEMINI_API_KEY not set');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const f = (globalThis as any).fetch as typeof fetch;
    if (typeof f !== 'function') {
      throw new Error(
        'global fetch() is not available — Gemini call requires Node 18+',
      );
    }

    const parts: Array<Record<string, unknown>> = [];
    if (request.fileBase64 && request.mimeType) {
      parts.push({
        inline_data: {
          mime_type: request.mimeType,
          data: request.fileBase64,
        },
      });
    }
    parts.push({
      text:
        (request.fileName ? `File: ${request.fileName}\n\n` : '') +
        (request.text ?? 'Extract the invoice fields from the attached document.'),
    });

    const model = request.modelOverride || this.geminiModel;
    const url =
      `${this.geminiUrl}/models/` +
      `${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(this.geminiKey)}`;

    const body = {
      contents: [{ role: 'user', parts }],
      systemInstruction: { parts: [{ text: this.buildPrompt(request.documentContext) }] },
      generationConfig: {
        temperature: 0.1,
        responseMimeType: 'application/json',
      },
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await f(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(
          `gemini ${resp.status} ${resp.statusText}: ${text.slice(0, 200)}`,
        );
      }
      const json = (await resp.json()) as {
        candidates?: Array<{
          content?: { parts?: Array<{ text?: string }> };
        }>;
        usageMetadata?: {
          promptTokenCount?: number;
          candidatesTokenCount?: number;
        };
      };
      const raw =
        json.candidates?.[0]?.content?.parts
          ?.map((p) => p.text ?? '')
          .join('') ?? '';
      return this.shapeResult(
        'gemini',
        model,
        raw,
        json.usageMetadata?.promptTokenCount,
        json.usageMetadata?.candidatesTokenCount,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Gemini via OpenRouter — OpenAI-compatible chat/completions at
   * https://openrouter.ai/api/v1/chat/completions with the
   * `google/gemini-2.5-flash` vision model. Multimodal content goes as a
   * {type:'image_url', image_url:{url:'data:<mime>;base64,...'}} part,
   * exactly the same shape as OpenAI's gpt-4o family.
   *
   * This is the PRIMARY vision provider as of 2026-08-31 — the direct
   * Gemini key is currently quota-exhausted and `gemini-2.5-flash` is 404
   * on Google's API (only `gemini-3.6-flash` is offered and that is also
   * out of quota). OpenRouter still routes `google/gemini-2.5-flash`
   * with capacity.
   */
  private async callOpenRouter(
    request: VisionAnalysisRequest,
    timeoutMs: number,
  ): Promise<VisionAnalysisResult> {
    const model = request.modelOverride || this.openrouterModel;
    return this.callOpenRouterWithModel(request, timeoutMs, model);
  }

  /**
   * OpenRouter chat/completions with an explicit model id. Reused by the
   * primary `callOpenRouter` path and by the escalation path
   * (`analyze()` retries on a stronger model when the primary returns
   * unusable numerics). Returns the same shape regardless of which
   * model produced it — `result.provider` is set by the caller.
   */
  private async callOpenRouterWithModel(
    request: VisionAnalysisRequest,
    timeoutMs: number,
    model: string,
  ): Promise<VisionAnalysisResult> {
    if (!this.openrouterKey) throw new Error('OPENROUTER_API_KEY not set');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const f = (globalThis as any).fetch as typeof fetch;
    if (typeof f !== 'function') {
      throw new Error(
        'global fetch() is not available — OpenRouter call requires Node 18+',
      );
    }

    const userContent: Array<Record<string, unknown>> = [];
    if (request.fileBase64 && request.mimeType) {
      const dataUrl = `data:${request.mimeType};base64,${request.fileBase64}`;
      userContent.push({ type: 'image_url', image_url: { url: dataUrl } });
    }
    userContent.push({
      type: 'text',
      text:
        (request.fileName ? `File: ${request.fileName}\n\n` : '') +
        (request.text ?? 'Extract the invoice fields from the attached document.'),
    });

    // OpenRouter accepts response_format=json_object for Gemini vision
    // models (the prompt explicitly instructs "return only JSON" too —
    // belt and suspenders for models that ignore response_format).
    //
    // max_tokens: 6000 — a full Portuguese invoice JSON with 20+ line
    // items, ivaBreakdown, discount, cash discount, AT-QR payload and
    // confidence fields is ~3500-4500 chars. The previous 4096 cap
    // truncated Gemini 2.5 Flash mid-JSON on real phone photos
    // ~2 out of 3 times; 6000 gives enough headroom to finish the
    // payload without hitting the 8192 cap that the model silently
    // rounds down to. Truncating mid-JSON is the #1 cause of
    // `fallbackUsed: true` results — paired with the 3-attempt retry
    // below, this is what makes the path deterministic.
    //
    // RETRY LOOP — Gemini 2.5 Flash on OpenRouter is unreliable: same
    // photo, same prompt, same temperature returns COMPLETE JSON on
    // some attempts and TRUNCATED MID-ARRAY on others (~2/3 rate).
    // This wrapper retries up to 3 times when the response is
    // unparseable or missing required fiscal fields. Each attempt uses
    // the SAME max_tokens + temperature + image — the variance is in
    // the upstream sampler. We log every attempt at warn level so the
    // operator can see the success / failure mix. Only the FIRST
    // successful COMPLETE response wins; on full failure the caller
    // routes the document to needs_review (never silently to regex).
    const baseBody = {
      model,
      temperature: 0.1,
      max_tokens: 6000,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: this.buildPrompt(request.documentContext) },
        { role: 'user', content: userContent },
      ],
    };
    const maxAttempts = 3;

    let lastResult: VisionAnalysisResult | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // Each attempt gets its own AbortController so an abort doesn't
      // poison the next attempt's timer.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const resp = await f(this.openrouterUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.openrouterKey}`,
            // OpenRouter recommends an identifying User-Agent and an
            // optional referer for their analytics — both safe to set.
            'http-referer': 'https://docflow.local',
            'x-title': 'DocFlow',
          },
          body: JSON.stringify(baseBody),
          signal: controller.signal,
        });
        if (!resp.ok) {
          const text = await resp.text().catch(() => '');
          throw new Error(
            `openrouter ${resp.status} ${resp.statusText}: ${text.slice(0, 200)}`,
          );
        }
        const json = (await resp.json()) as {
          choices?: Array<{
            message?: { content?: string };
            finish_reason?: string;
          }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
          model?: string;
        };
        const raw = json.choices?.[0]?.message?.content ?? '';
        // Strip the vendor prefix from the OpenRouter-reported model name
        // (`google/gemini-2.5-flash`) so the downstream `ai:<provider>/<model>`
        // hint carries just the leaf model (`gemini-2.5-flash`). The provider
        // string `openrouter/gemini-2.5-flash` lives in `result.provider` and
        // the parser in `composeMetadata` takes the LAST `/`-segment as the
        // model — so a hint of `ai:openrouter/gemini-2.5-flash/gemini-2.5-flash`
        // resolves to provider=`openrouter/gemini-2.5-flash`, model=`gemini-2.5-flash`.
        const reportedModel = json.model ?? model;
        const modelForResult = stripVendorPrefix(reportedModel);
        const finishReason = json.choices?.[0]?.finish_reason;
        const shaped = this.shapeResult(
          'openrouter',
          modelForResult,
          raw,
          json.usage?.prompt_tokens,
          json.usage?.completion_tokens,
        );

        // Hard gates — accept this attempt only when the JSON is
        // COMPLETE: parses AND has at least one authoritative fiscal
        // field. Truncated / parsed-but-empty results are rejected and
        // retried. The 4 anchors cover every invoice shape the model
        // returns: AT-QR path, AI-only path, supplier + total at
        // minimum, doc number alone.
        const fields = shaped.extracted;
        const hasAuthoritative =
          typeof fields.total === 'number' ||
          typeof fields.netAmount === 'number' ||
          typeof fields.supplierNif === 'string' ||
          typeof fields.docNumber === 'string' ||
          typeof fields.atQrRaw === 'string' ||
          typeof fields.supplier === 'string';

        // `finish_reason === 'length'` is the smoking-gun for token-cap
        // truncation — accept that signal too so we can retry
        // deterministically instead of relying on JSON-shape heuristics
        // alone.
        const truncatedByLength = finishReason === 'length';

        if (!shaped.fallbackUsed && hasAuthoritative && !truncatedByLength) {
          if (attempt > 1) {
            this.logger.log(
              `Vision: OpenRouter/${modelForResult} attempt ${attempt}/${maxAttempts} ` +
                `returned COMPLETE JSON (${raw.length} chars, total=${String(fields.total)}). ` +
                `Accepting.`,
            );
          }
          return shaped;
        }

        // Incomplete — log + retry. Keep the last failure so the final
        // return surfaces the latest diagnostic.
        this.logger.warn(
          `Vision: OpenRouter/${modelForResult} attempt ${attempt}/${maxAttempts} ` +
            `INCOMPLETE (chars=${raw.length}, fallbackUsed=${shaped.fallbackUsed}, ` +
            `hasAuthoritative=${hasAuthoritative}, finishReason=${String(finishReason)}, ` +
            `total=${String(fields.total)}, supplier=${String(fields.supplier ?? null)}). ` +
            `${attempt < maxAttempts ? 'Retrying.' : 'No more retries — caller will mark needs_review.'}`,
        );
        lastResult = shaped;
      } catch (err) {
        this.logger.warn(
          `Vision: OpenRouter/${model} attempt ${attempt}/${maxAttempts} THREW: ` +
            `${(err as Error).message}. ${attempt < maxAttempts ? 'Retrying.' : 'Giving up.'}`,
        );
        if (attempt === maxAttempts) {
          throw err;
        }
      } finally {
        clearTimeout(timer);
      }
    }

    // All 3 attempts failed — return the last (incomplete) result with
    // `fallbackUsed: true`. The caller (`analyze()` → `runAiOrRegexPath`)
    // will NOT promote this to source='regex' on an image (the
    // textSource='none' check in extraction.service.ts routes it to
    // needs_review instead).
    if (lastResult) {
      return lastResult;
    }
    // No result recorded at all (every attempt threw). Build a
    // diagnostic result so the caller still has something to log.
    return {
      provider: 'openrouter',
      model: stripVendorPrefix(model),
      confidence: 0,
      extracted: {},
      rawResponse: '',
      processingTimeMs: 0,
      fallbackUsed: true,
    };
  }

  /**
   * Shorter-prompt OpenRouter call used by the escalation path.
   *
   * The primary call uses the full 5K+ char `SYSTEM_PROMPT` (PT-accountant
   * role + schema description). gemini-2.5-pro on a 2.6 MB photo with
   * that prompt eats ~3900 of the 4096 max_tokens budget on internal
   * reasoning and only emits ~150 chars of JSON before truncation.
   * A short, focused prompt WITHOUT the schema document / role
   * descriptions avoids reasoning tokens and produces the correct
   * fields in ~400 chars — verified end-to-end on the Américo Alves /
   * LIZOTEL / Mastergastro phone photos.
   *
   * The prompt is the bare minimum needed: define the role + ask for
   * the top-level JSON object. The escalation model is a STRONGER
   * multimodal that doesn't need the schema-explainer to produce
   * correct output.
   */
  private async callOpenRouterEscalation(
    request: VisionAnalysisRequest,
    timeoutMs: number,
  ): Promise<VisionAnalysisResult> {
    if (!this.openrouterKey) throw new Error('OPENROUTER_API_KEY not set');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const f = (globalThis as any).fetch as typeof fetch;
    if (typeof f !== 'function') {
      throw new Error('global fetch() is not available');
    }
    const shortSystemPrompt =
      `You are a Portuguese chartered-accountant auditor extracting fields ` +
      `from a fiscal invoice photo. Return ONLY a valid JSON object with: ` +
      `supplier, supplierNif, customer, customerNif, docNumber, atcud, ` +
      `docDate, dueDate, total, taxAmount, netAmount, iban, currency. ` +
      `Numbers in EUR. No markdown, no commentary.`;

    const userContent: Array<Record<string, unknown>> = [];
    if (request.fileBase64 && request.mimeType) {
      const dataUrl = `data:${request.mimeType};base64,${request.fileBase64}`;
      userContent.push({ type: 'image_url', image_url: { url: dataUrl } });
    }
    userContent.push({
      type: 'text',
      text: 'Extract the invoice fields from this document.',
    });

    const body = {
      model: this.openrouterEscalateModel,
      temperature: 0.0,
      max_tokens: 2048,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: shortSystemPrompt },
        { role: 'user', content: userContent },
      ],
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await f(this.openrouterUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.openrouterKey}`,
          'http-referer': 'https://docflow.local',
          'x-title': 'DocFlow',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(
          `openrouter ${resp.status} ${resp.statusText}: ${text.slice(0, 200)}`,
        );
      }
      const json = (await resp.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
        model?: string;
      };
      const raw = json.choices?.[0]?.message?.content ?? '';
      const reportedModel = json.model ?? this.openrouterEscalateModel;
      const modelForResult = stripVendorPrefix(reportedModel);
      return this.shapeResult(
        'openrouter',
        modelForResult,
        raw,
        json.usage?.prompt_tokens,
        json.usage?.completion_tokens,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  // ---------------------------------------------------------------------------
  // MiniMax provider (PRIMARY as of 2026-09-01)
  // ---------------------------------------------------------------------------

  /**
   * MiniMax multimodal vision — OpenAI-compatible chat/completions at
   * `MINIMAX_URL` (default `https://api.minimax.io/v1/chat/completions`)
   * with `MINIMAX_VISION_MODEL` (default `MiniMax-M3`). Bearer auth via
   * `MINIMAX_API_KEY`.
   *
   * Image goes as a `data:<mime>;base64,<b64>` `image_url` part — same
   * shape OpenAI / OpenRouter use. No `response_format: json_object`
   * parameter (MiniMax ignores it; the prompt does the work and the
   * JSON parser strips any <think> block + markdown fences).
   *
   * max_tokens: 8000 — MiniMax-M3 emits a <think> reasoning block BEFORE
   * the JSON, and that block easily eats 1500-2500 tokens on a phone
   * photo of a Portuguese invoice. 8000 is enough headroom for the full
   * JSON after the think block (verified on the user's real Américo
   * Alves photo — JSON fits in ~3500-4500 chars ≈ 1300 tokens).
   *
   * temperature: 0.1 — same as the other providers; deterministic
   * enough on real phone photos that 3 retries weren't needed in
   * testing.
   *
   * RETRY LOOP: 2 attempts. MiniMax has been reliable in the user's
   * testing but we keep a single retry for hard-5xx safety. Truncated
   * responses (no JSON object found) trigger a retry at the same
   * temperature; 4xx / 429 throw and bubble to the fallback chain in
   * `analyze()`.
   *
   * Output: the same `VisionAnalysisResult` shape every provider emits,
   * with `provider: 'minimax'` and `model: 'MiniMax-M3'` (the
   * caller in `analyze()` re-tags the composite provider string
   * `minimax/MiniMax-M3`).
   */
  private async callMinimax(
    request: VisionAnalysisRequest,
    timeoutMs: number,
  ): Promise<VisionAnalysisResult> {
    if (!this.minimaxKey) throw new Error('MINIMAX_API_KEY not set');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const f = (globalThis as any).fetch as typeof fetch;
    if (typeof f !== 'function') {
      throw new Error('global fetch() is not available — MiniMax call requires Node 18+');
    }

    // MiniMax-M3 on a real phone photo of a Portuguese invoice reliably
    // returns in 25-40s once the image is downscaled to 1500px (the
    // extraction service's `downscaleForVision` step). The default
    // 30s ceiling is too tight — bump the per-attempt timeout to 60s
    // so a single retry attempt has headroom to finish. Total worst
    // case: 2 attempts × 60s = 120s, vs the original 60s with
    // truncations. Net effect: more attempts succeed, fewer calls
    // fall back to OpenRouter (whose quota is currently exhausted).
    //
    // HARDENED 2026-09-01: with `thinking: { type: 'disabled' }` set
    // (see baseBody below) the model skips its reasoning pass entirely
    // and the real-phone latency drops from ~40-60s to ~15-25s in
    // testing — `reasoning_tokens` goes from ~239 down to 0. The
    // 60s per-attempt ceiling is still kept so a slow network path
    // doesn't false-positive.
    const effectiveTimeoutMs = Math.max(timeoutMs, 60_000);

    const userContent: Array<Record<string, unknown>> = [];
    if (request.fileBase64 && request.mimeType) {
      const dataUrl = `data:${request.mimeType};base64,${request.fileBase64}`;
      userContent.push({ type: 'image_url', image_url: { url: dataUrl } });
    }
    userContent.push({
      type: 'text',
      text:
        (request.fileName ? `File: ${request.fileName}\n\n` : '') +
        (request.text ?? 'Extract the invoice fields from the attached document.'),
    });

    // Body shape: identical to the OpenAI / OpenRouter chat/completions
    // payload, minus `response_format` (MiniMax does not honour it and
    // would just return the same JSON anyway). We DO set high
    // `max_tokens` so the model doesn't truncate after its <think> block.
    //
    // HARDENED 2026-09-01: send `thinking: { type: 'disabled' }` so
    // Opus 5 skips its reasoning pass entirely. Without this, Opus 5
    // emits a `<think>...</think>` block that consumes ~200-250
    // reasoning tokens per call (~30s on a real phone photo). With
    // thinking disabled the call drops to ~3-15s on the same image and
    // emits the JSON directly. We KEEP the <think>-stripping parser in
    // `stripThinkBlock` as a defensive safety net in case Opus 5 ever
    // reintroduces the reasoning block. Verified live against the
    // Américo Alves / 144.22 real-photo fixture.
    const model = request.modelOverride || this.minimaxModel;
    const baseBody = {
      model,
      temperature: 0.1,
      max_tokens: 8000,
      // Reasoning control — Opus 5 supports `thinking: { type:
      // 'disabled' }` to suppress the internal reasoning pass. Cast to
      // `any` because this parameter is MiniMax-specific (not part of
      // the public OpenAI ChatCompletionRequest type).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      thinking: { type: 'disabled' } as any,
      messages: [
        { role: 'system', content: this.buildPrompt(request.documentContext) },
        { role: 'user', content: userContent },
      ],
    };
    const maxAttempts = 2;

    let lastResult: VisionAnalysisResult | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), effectiveTimeoutMs);
      try {
        const resp = await f(this.minimaxUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.minimaxKey}`,
          },
          body: JSON.stringify(baseBody),
          signal: controller.signal,
        });
        if (!resp.ok) {
          const text = await resp.text().catch(() => '');
          throw new Error(
            `minimax ${resp.status} ${resp.statusText}: ${text.slice(0, 200)}`,
          );
        }
        const json = (await resp.json()) as {
          choices?: Array<{
            message?: { content?: string };
            finish_reason?: string;
          }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
          model?: string;
        };
        const raw = json.choices?.[0]?.message?.content ?? '';
        const reportedModel = json.model ?? model;
        const finishReason = json.choices?.[0]?.finish_reason;
        const shaped = this.shapeResult(
          'minimax',
          reportedModel,
          raw,
          json.usage?.prompt_tokens,
          json.usage?.completion_tokens,
        );

        // Hard gates — accept this attempt only when the JSON parses
        // AND has at least one authoritative fiscal field. Truncated /
        // parsed-but-empty results are rejected and retried.
        const fields = shaped.extracted;
        const hasAuthoritative =
          typeof fields.total === 'number' ||
          typeof fields.netAmount === 'number' ||
          typeof fields.supplierNif === 'string' ||
          typeof fields.docNumber === 'string' ||
          typeof fields.atQrRaw === 'string' ||
          typeof fields.supplier === 'string';

        const truncatedByLength = finishReason === 'length';

        if (!shaped.fallbackUsed && hasAuthoritative && !truncatedByLength) {
          if (attempt > 1) {
            this.logger.log(
              `Vision: MiniMax/${reportedModel} attempt ${attempt}/${maxAttempts} ` +
                `returned COMPLETE JSON (${raw.length} chars, total=${String(fields.total)}). ` +
                `Accepting.`,
            );
          }
          return shaped;
        }

        this.logger.warn(
          `Vision: MiniMax/${reportedModel} attempt ${attempt}/${maxAttempts} ` +
            `INCOMPLETE (chars=${raw.length}, fallbackUsed=${shaped.fallbackUsed}, ` +
            `hasAuthoritative=${hasAuthoritative}, finishReason=${String(finishReason)}, ` +
            `total=${String(fields.total)}, supplier=${String(fields.supplier ?? null)}). ` +
            `${attempt < maxAttempts ? 'Retrying.' : 'No more retries — caller will fall back.'}`,
        );
        lastResult = shaped;
      } catch (err) {
        this.logger.warn(
          `Vision: MiniMax/${model} attempt ${attempt}/${maxAttempts} THREW: ` +
            `${(err as Error).message}. ${attempt < maxAttempts ? 'Retrying.' : 'Giving up.'}`,
        );
        if (attempt === maxAttempts) {
          throw err;
        }
      } finally {
        clearTimeout(timer);
      }
    }

    if (lastResult) {
      return lastResult;
    }
    return {
      provider: 'minimax',
      model,
      confidence: 0,
      extracted: {},
      rawResponse: '',
      processingTimeMs: 0,
      fallbackUsed: true,
    };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private readKey(name: string | string[]): string | null {
    const names = Array.isArray(name) ? name : [name];
    for (const n of names) {
      const v = this.config.get<string>(n);
      if (v && v.length > 0) return v;
    }
    return null;
  }

  /**
   * Race the upstream call against a timeout. Resolves with the original
   * value on success, rejects with a timeout error after `ms` if the call
   * is still pending.
   */
  private async withTimeout<T>(
    promise: Promise<T>,
    ms: number,
    label: string,
  ): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} timed out after ${ms}ms`)),
        ms,
      );
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Parse the model's raw text output into a structured result. Tolerant
   * to models that emit markdown fences or surrounding prose — we look
   * for the first balanced JSON object in the response.
   */
  private shapeResult(
    provider: VisionAnalysisResult['provider'],
    model: string,
    raw: string,
    tokensIn?: number,
    tokensOut?: number,
  ): VisionAnalysisResult {
    const jsonText = extractFirstJsonObject(raw);
    let extracted: VisionExtractedFields = {};
    let fallbackUsed = false;

    if (!jsonText) {
      this.logger.warn(
        `${provider}/${model}: no JSON object in response (${raw.length} chars)`,
      );
      fallbackUsed = true;
    } else {
      try {
        const parsed = JSON.parse(jsonText) as Record<string, unknown>;
        extracted = normalizeExtractedFields(parsed);
      } catch (err) {
        this.logger.warn(
          `${provider}/${model}: JSON parse failed: ${(err as Error).message}`,
        );
        fallbackUsed = true;
      }
    }

    const confidence =
      typeof extracted.confidence === 'number' &&
      Number.isFinite(extracted.confidence)
        ? clamp01(extracted.confidence)
        : 0.8;

    const inTokens = tokensIn ?? 0;
    const outTokens = tokensOut ?? 0;
    let inRate = 0.2;
    let outRate = 1.0;

    const lowerModel = model.toLowerCase();
    if (lowerModel.includes('sonnet')) {
      inRate = 2.8; outRate = 14.0;
    } else if (lowerModel.includes('haiku')) {
      inRate = 0.75; outRate = 3.75;
    } else if (lowerModel.includes('gpt-4o-mini')) {
      inRate = 0.14; outRate = 0.56;
    } else if (lowerModel.includes('gpt-4o')) {
      inRate = 2.3; outRate = 9.2;
    } else if (lowerModel.includes('flash')) {
      inRate = 0.15; outRate = 0.6;
    } else if (lowerModel.includes('pro')) {
      inRate = 1.2; outRate = 4.8;
    }

    const estimatedCostEur = Number(((inTokens * inRate + outTokens * outRate) / 1_000_000).toFixed(6));

    return {
      provider,
      model,
      confidence,
      extracted,
      rawResponse: raw,
      processingTimeMs: 0, // overwritten by analyze() once the call returns
      fallbackUsed,
      tokensIn: inTokens,
      tokensOut: outTokens,
      estimatedCostEur,
    };
  }
}

/**
 * Find the first balanced `{...}` JSON object in `text`. Returns the slice
 * (inclusive) or `null` if no balanced object exists.
 *
 * Used because some providers occasionally prepend/append prose even when
 * instructed not to. We never modify the JSON inside — only locate it.
 */
export function extractFirstJsonObject(text: string): string | null {
  if (!text) return null;
  // Strip markdown fences if present.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced && fenced[1]) {
    const inside = extractFirstJsonObject(fenced[1]);
    if (inside) return inside;
  }
  // Strip any <think>...</think> reasoning block BEFORE the JSON.
  // MiniMax-M3 emits this prefix on every response — without stripping,
  // `text.indexOf('{')` lands inside the think block (which never has
  // balanced JSON), JSON.parse fails, and the result is useless. Strip
  // the closing </think> and any trailing whitespace so the JSON
  // parser sees only the structured output.
  const stripped = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  const start = stripped.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < stripped.length; i++) {
    const ch = stripped[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\') {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return stripped.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Coerce a free-form JSON payload into the strict shape `ExtractedFields`
 * expects. Drops unknown fields, converts types where it can, and leaves
 * everything else as-is for the merge step to compare.
 */
export function normalizeExtractedFields(
  raw: Record<string, unknown>,
): VisionExtractedFields {
  const out: VisionExtractedFields = {};
  const stringKeys = [
    'supplier',
    'customer',
    'supplierNif',
    'customerNif',
    'supplierVatId',
    'supplierAddress',
    'supplierPostalCode',
    'supplierCity',
    'supplierPhone',
    'supplierEmail',
    'supplierWebsite',
    'docNumber',
    'atcud',
    'docDate',
    'dueDate',
    'currency',
    'iban',
    'country',
    'documentType',
    'atQrRaw',
  ];
  for (const k of stringKeys) {
    const v = raw[k];
    if (typeof v === 'string' && v.trim().length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (out as any)[k] = v.trim();
    } else if (v && typeof v !== 'object') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (out as any)[k] = String(v).trim();
    }
  }
  for (const k of ['netAmount', 'taxAmount', 'total']) {
    const v = raw[k];
    if (typeof v === 'number' && Number.isFinite(v)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (out as any)[k] = v;
    } else if (typeof v === 'string') {
      // Strip spaces and currency symbols; normalize European ("1.234,56")
      // and US ("1,234.56") number formats.
      const cleaned = v
        .replace(/[\s€$£]/g, '')
        .replace(/EUR|USD|GBP|CHF/gi, '')
        .trim();
      const lastComma = cleaned.lastIndexOf(',');
      const lastDot = cleaned.lastIndexOf('.');
      let normalized = cleaned;
      if (lastComma !== -1 && lastDot !== -1) {
        const decimal = lastComma > lastDot ? ',' : '.';
        normalized = cleaned
          .replace(decimal === ',' ? /\./g : /,/g, '')
          .replace(decimal, '.');
      } else if (lastComma !== -1) {
        // Single comma: treat as decimal when there are exactly 2 digits
        // after it; otherwise treat as thousands separator.
        const digitsAfter = cleaned.length - lastComma - 1;
        normalized =
          digitsAfter === 2
            ? cleaned.replace(',', '.')
            : cleaned.replace(/,/g, '');
      } else if (lastDot !== -1) {
        const digitsAfter = cleaned.length - lastDot - 1;
        normalized =
          digitsAfter === 2
            ? cleaned
            : cleaned.replace(/\./g, '');
      }
      const n = Number(normalized);
      if (Number.isFinite(n)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (out as any)[k] = n;
      }
    }
  }
  if (Array.isArray(raw['ivaBreakdown'])) {
    out.ivaBreakdown = (raw['ivaBreakdown'] as unknown[])
      .map((row) => {
        if (row && typeof row === 'object') {
          const r = row as Record<string, unknown>;
          const rate = numberOrUndefined(r.rate);
          const base = numberOrUndefined(r.base);
          const tax = numberOrUndefined(r.tax);
          if (rate != null && base != null && tax != null) {
            return { rate, base, tax };
          }
        }
        return null;
      })
      .filter((x): x is { rate: number; base: number; tax: number } => !!x);
    if (out.ivaBreakdown.length === 0) delete out.ivaBreakdown;
  }
  if (typeof raw['confidence'] === 'number') {
    out.confidence = clamp01(raw['confidence']);
  }
  if (Array.isArray(raw['notes'])) {
    out.notes = (raw['notes'] as unknown[])
      .filter((n): n is string => typeof n === 'string')
      .slice(0, 5);
  }
  // isEuIntracommunity — only set when the model emitted an explicit boolean.
  if (typeof raw['isEuIntracommunity'] === 'boolean') {
    out.isEuIntracommunity = raw['isEuIntracommunity'];
  }
  // Fase 4.1 — documentTitle: transcrição literal do cabeçalho. Só texto
  // (a decisão fiscal/não-fiscal é tomada por código a jusante).
  if (typeof raw['documentTitle'] === 'string') {
    const title = raw['documentTitle'].trim();
    if (title.length > 0) out.documentTitle = title.slice(0, 200);
  }
  // Fase 4.1 — correctedDocumentNumber: a fatura que uma nota de crédito
  // retifica, tal como impressa no documento.
  if (typeof raw['correctedDocumentNumber'] === 'string') {
    const ref = raw['correctedDocumentNumber'].trim();
    if (ref.length > 0) out.correctedDocumentNumber = ref.slice(0, 100);
  }
  // suggestedCategory — single free-form string. Trim and length-cap so a
  // chatty model can't bloat the metadata blob.
  if (typeof raw['suggestedCategory'] === 'string') {
    const cat = raw['suggestedCategory'].trim();
    if (cat.length > 0) out.suggestedCategory = cat.slice(0, 200);
  } else if (raw['suggestedCategory'] != null && typeof raw['suggestedCategory'] !== 'object') {
    const cat = String(raw['suggestedCategory']).trim();
    if (cat.length > 0) out.suggestedCategory = cat.slice(0, 200);
  }
  // cashDiscountRate — small non-negative number, expressed as a percentage.
  // Bypass the locale-aware numberOrUndefined() because cash discount
  // values like "1.5" (one and a half percent) would otherwise be
  // misread as "15" by the thousands-separator heuristic. The raw value
  // is a JSON number from a well-behaved model — accept it directly.
  const cdrRaw = raw['cashDiscountRate'];
  let cdr: number | undefined;
  if (typeof cdrRaw === 'number' && Number.isFinite(cdrRaw)) {
    cdr = cdrRaw;
  } else if (typeof cdrRaw === 'string') {
    const cleaned = cdrRaw.replace(/[\s%]/g, '').replace(',', '.');
    const parsed = Number.parseFloat(cleaned);
    if (Number.isFinite(parsed)) cdr = parsed;
  }
  if (cdr != null && cdr >= 0 && cdr <= 100) {
    out.cashDiscountRate = cdr;
  }
  // lineItems — array of structured rows. Drop rows that have NO signal at
  // all (everything null) but keep partial rows so the AI can still surface
  // descriptions even when prices are missing.
  if (Array.isArray(raw['lineItems'])) {
    const rows = (raw['lineItems'] as unknown[])
      .map((row): VisionExtractedLineItem | null => {
        if (!row || typeof row !== 'object') return null;
        const r = row as Record<string, unknown>;
        const description =
          typeof r.description === 'string'
            ? r.description.trim().slice(0, 500)
            : typeof r.description === 'number' || typeof r.description === 'boolean'
              ? String(r.description).trim().slice(0, 500)
              : undefined;
        const code =
          typeof r.code === 'string'
            ? r.code.trim().slice(0, 80)
            : typeof r.code === 'number' || typeof r.code === 'boolean'
              ? String(r.code).trim().slice(0, 80)
              : undefined;
        const quantity = numberOrUndefined(r.quantity);
        const unitPrice = numberOrUndefined(r.unitPrice);
        const vatRate = numberOrUndefined(r.vatRate);
        const discount = numberOrUndefined(r.discount);
        const lineTotal = numberOrUndefined(r.lineTotal);
        if (!description && !code && quantity == null && unitPrice == null && vatRate == null && lineTotal == null && discount == null) {
          return null;
        }
        return { description, code, quantity, unitPrice, vatRate, discount, lineTotal };
      })
      .filter((x): x is VisionExtractedLineItem => x !== null);
    if (rows.length > 0) {
      out.lineItems = rows.slice(0, 50);
    }
  }
  // discountAmount — invoice-level discount. Use the locale-aware
  // numberOrUndefined so "1.234,56" / "10 % discount" parse correctly.
  // Guarded against negatives — a credit-note discount sign is the AI's
  // problem to model via `documentType`, not via negative numbers here.
  const invoiceDiscount = numberOrUndefined(raw['discountAmount']);
  if (invoiceDiscount != null && invoiceDiscount >= 0 && Number.isFinite(invoiceDiscount)) {
    out.discountAmount = invoiceDiscount;
  }
  return out;
}

function numberOrUndefined(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const cleaned = v.replace(/[\s€$£]/g, '').trim();
    const lastComma = cleaned.lastIndexOf(',');
    const lastDot = cleaned.lastIndexOf('.');
    let normalized = cleaned;
    if (lastComma !== -1 && lastDot !== -1) {
      const decimal = lastComma > lastDot ? ',' : '.';
      normalized = cleaned
        .replace(decimal === ',' ? /\./g : /,/g, '')
        .replace(decimal, '.');
    } else if (lastComma !== -1) {
      const digitsAfter = cleaned.length - lastComma - 1;
      normalized =
        digitsAfter === 2
          ? cleaned.replace(',', '.')
          : cleaned.replace(/,/g, '');
    } else if (lastDot !== -1) {
      const digitsAfter = cleaned.length - lastDot - 1;
      normalized = digitsAfter === 2 ? cleaned : cleaned.replace(/\./g, '');
    }
    const n = Number(normalized);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0.8;
  return Math.max(0, Math.min(1, n));
}

/**
 * Recognise a Gemini / OpenAI upstream quota-exhaustion error from its
 * thrown message (`callGemini` throws `gemini 429 ... : <body>`,
 * `callOpenAI` throws `openai 429 ... : <body>`). The message from
 * Google usually contains `RESOURCE_EXHAUSTED`; OpenAI uses
 * `insufficient_quota`. We treat both as a signal to fall back to the
 * proxy when one is available.
 */
function isQuotaError(err: unknown): boolean {
  const msg = (err as Error | undefined)?.message ?? '';
  if (!msg) return false;
  if (/\b429\b/.test(msg)) return true;
  if (/RESOURCE_EXHAUSTED/i.test(msg)) return true;
  if (/insufficient_quota/i.test(msg)) return true;
  if (/quota[_ ]?exceeded/i.test(msg)) return true;
  return false;
}

/**
 * Drop the `vendor/` prefix from an OpenRouter-reported model name so the
 * downstream parser can split `ai:<provider>/<model>` on `/` without
 * pulling the vendor into the provider field. OpenRouter returns names
 * like `google/gemini-2.5-flash`; we keep only `gemini-2.5-flash`.
 */
function stripVendorPrefix(model: string): string {
  const i = model.indexOf('/');
  return i >= 0 ? model.slice(i + 1) : model;
}

/**
 * Decide whether a `VisionAnalysisResult` carries usable numerics for
 * downstream extraction. The escalation path in `analyze()` consults
 * this — when the primary OpenRouter call returns parseable JSON but
 * `total` is missing AND the AI's `atQrRaw` carries an obviously
 * corrupt `O:` block (a date-shaped string mangled into a number, e.g.
 * `20250217.37005` instead of `144.22`), we know the primary model
 * misread the QR / numbers and the result would corrupt the document.
 * A stronger model gets a second chance.
 *
 * Rules (any of these makes the result NOT usable — escalate):
 *   - `total` is missing/null, OR
 *   - `total` is non-finite, OR
 *   - `total > 1_000_000` (the original `31082026` corruption pattern
 *     + the `20250217.37` AI-misread pattern), OR
 *   - the AI-returned `atQrRaw` `O:` block looks like a YYYYMMDD date
 *     (8 digits with year ≥ 2000 — the AI OCR'd the wrong row).
 */
export function isVisionResultUsable(
  result: Pick<VisionAnalysisResult, 'extracted' | 'fallbackUsed'>,
): boolean {
  if (result.fallbackUsed) return true; // partial-JSON is handled elsewhere
  const ex = result.extracted;
  const total = ex?.total;
  if (typeof total !== 'number' || !Number.isFinite(total)) {
    return false; // missing → escalate to read it visually
  }
  if (total > 1_000_000) {
    return false; // the date-corruption / misread-O-block pattern
  }
  // Detect the specific "O:20250217.37005" misread. The AT-QR `O:`
  // field is a decimal amount in euros — a string that STARTS with an
  // 8-digit YYYYMMDD date (year ≥ 2010) means the AI OCR'd the wrong
  // row (e.g. it read the invoice date as the total). Match either
  // the bare 8-digit form or `20250217.37005` where the model
  // misread the date as the total.
  const o = extractAtQrField(ex?.atQrRaw, 'O');
  if (o && /^\d{8}(?:\.|$)/.test(o) && Number(o.slice(0, 4)) >= 2010) {
    return false;
  }
  return true;
}

/**
 * Pull a single field out of an AT-QR payload string by letter (e.g.
 * `extractAtQrField("A:1*B:2*C:PT*...", "O")` → undefined). Returns
 * the raw value (still stringified) — caller decides how to coerce.
 */
function extractAtQrField(
  payload: string | null | undefined,
  letter: string,
): string | undefined {
  if (!payload || typeof payload !== 'string') return undefined;
  const re = new RegExp(`(?:^|\\*)${letter}:([^\\*]+)`);
  const m = payload.match(re);
  return m ? m[1] : undefined;
}

/** Short preview of the AI-returned atQrRaw `O:` value (or 'null'/'absent'). */
function previewAtQrOField(payload: string | null | undefined): string {
  const o = extractAtQrField(payload, 'O');
  if (o === undefined) return 'absent';
  return o.length > 24 ? `${o.slice(0, 24)}…` : o;
}

/**
 * Decide whether a `VisionAnalysisResult` carries enough authoritative
 * signal to be USABLE as a final answer (as opposed to the stricter
 * `isVisionResultUsable` escalation gate above). When the result is
 * NOT usable, the chain in `analyze()` falls through to the next
 * provider instead of returning it.
 *
 * Rules (any one authoritative signal + non-zero confidence = usable):
 *   - `supplier` (string) — supplier / issuer name
 *   - `total` (number, finite, ≤ 1_000_000) — invoice total
 *   - `netAmount` (number, finite, > 0) — net base amount
 *   - `supplierNif` (string) — Portuguese issuer NIF
 *   - `supplierVatId` (string) — country-prefixed VAT ID (non-PT)
 *   - `customerNif` (string) — buyer NIF (we know which party is us)
 *   - `docNumber` (string) — printed invoice number
 *   - `atcud` (string) — Portuguese ATCUD code (very authoritative)
 *   - `atQrRaw` (string with ≥ 3 fields) — AT-QR payload present
 *   - `iban` (string with ≥ 5 chars) — IBAN on the document
 *
 * Negative cases (any of these makes the result NOT usable — fall
 * through to next provider):
 *   - `fallbackUsed` is true (the 3-attempt retry loop gave up)
 *   - `confidence` is 0 (default for the diagnostic empty result)
 *   - No field above has any signal at all
 *   - `total` is the date-corruption pattern (> 1_000_000 OR matches
 *     `^\d{8}(?:\.|$)` with year ≥ 2010 in the AI-returned
 *     `atQrRaw.O` block)
 */
export function isUsableForFallback(
  result: VisionAnalysisResult | null | undefined,
): boolean {
  if (!result) return false;
  if (result.fallbackUsed) return false;
  if (!result.extracted) return false;
  if (result.confidence <= 0) return false;
  const ex = result.extracted;
  // Date-corruption / YYYYMMDD-misread pattern → unusable.
  const total = ex.total;
  if (typeof total === 'number' && Number.isFinite(total) && total > 1_000_000) {
    return false;
  }
  const o = extractAtQrField(ex.atQrRaw, 'O');
  if (o && /^\d{8}(?:\.|$)/.test(o) && Number(o.slice(0, 4)) >= 2010) {
    return false;
  }
  // At least one authoritative signal must be present.
  if (typeof ex.supplier === 'string' && ex.supplier.trim().length > 0) return true;
  if (typeof total === 'number' && Number.isFinite(total) && total > 0) return true;
  if (typeof ex.netAmount === 'number' && Number.isFinite(ex.netAmount) && ex.netAmount > 0) return true;
  if (typeof ex.supplierNif === 'string' && ex.supplierNif.trim().length > 0) return true;
  if (typeof ex.supplierVatId === 'string' && ex.supplierVatId.trim().length > 0) return true;
  if (typeof ex.customerNif === 'string' && ex.customerNif.trim().length > 0) return true;
  if (typeof ex.docNumber === 'string' && ex.docNumber.trim().length > 0) return true;
  if (typeof ex.atcud === 'string' && ex.atcud.trim().length > 0) return true;
  if (typeof ex.iban === 'string' && ex.iban.trim().length >= 5) return true;
  if (
    typeof ex.atQrRaw === 'string' &&
    ex.atQrRaw.length > 0 &&
    (ex.atQrRaw.match(/\*/g) ?? []).length >= 3
  ) {
    return true;
  }
  return false;
}