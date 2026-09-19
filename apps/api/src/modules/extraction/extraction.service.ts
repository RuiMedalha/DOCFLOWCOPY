import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  Optional,
  forwardRef,
} from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import {
  AtQrParsed,
  isFinalConsumerNif,
  isValidIban,
  isValidNif,
  normalizeIban,
  normalizeNif,
  parseAtQr,
  validateAtQr,
} from "@docflow/shared";
import {
  formatPtNif,
  getTenantIdentity,
  normalizeNif as normalizeTenantNif,
  TenantIdentity,
} from "../ai/tenant-identity";
import { Prisma, DocumentType, DocumentStatus } from "@prisma/client";
import { PDFParse } from "pdf-parse";
import { PrismaService } from "../../prisma/prisma.service";
import { StorageService } from "../documents/storage/storage-service.interface";
import { VisionService } from "../ai/vision.service";
import { ZeroxService } from "../ai/zerox.service";
import { FolderRulesEngine } from "../documents/folder-rules/folder-rules.engine";
import {
  ExpenseCategory,
  isExpenseCategory,
  mapToExpenseCategory,
  VAT_DEDUCTIBILITY_HINTS,
} from "../documents/folder-rules/folder-rules.types";
import { DocumentsService } from "../documents/documents.service";
import { SupplierResolver } from "./supplier-resolver";
import {
  EXTRACTION_QUEUE,
  EXTRACTION_QUEUE_OPTIONS,
  ExtractionJob,
  ExtractionJobResult,
} from "./extraction.constants";
import { autoOrientImage } from "./qr-decode/qr-decoder";
import { classifyFiscalStatus, isValidAtQr, normalizeDocNumber } from "./fiscal-status";
import { reconcileTotals, signedAmounts } from "./totals-reconciliation";
import { classifyLineDiscount } from "./line-discount";
import {
  calculateCertaintyScore,
  CertaintyScoreResult,
  extractAtcudFromText,
  fieldConfidence,
  resolveDocumentCountry,
  resolveTaxIds,
  sanitizeAtcud,
  shouldClearStoredAtcud,
  shouldClearStoredNif,
} from "./field-validation";
import { ViesService } from "../vies/vies.service";
import { EcbFxService } from "../../common/fx/ecb-fx.service";
import { pickAutoCategory } from "../parties/auto-category";
import { decodeAtQrOffThread as decodeAtQr } from "./qr-decode/qr-decode-offthread";

/** Remove postal code/city fragments duplicated in an extracted address. */
function sanitizeExtractedSupplierAddress(
  address: string,
  postalCode?: string,
  city?: string,
): string {
  let cleaned = address.trim();
  for (const fragment of [postalCode, city]) {
    const value = fragment?.trim();
    if (!value) continue;
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    cleaned = cleaned.replace(new RegExp(`(?:^|[\\s,;|-])${escaped}(?=$|[\\s,;|-])`, "giu"), " ");
  }
  return cleaned
    .replace(/\s*[,;|-]\s*(?=[,;|-]|$)/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/^[,;|-]+|[,;|-]+$/g, "")
    .trim();
}
// Fase 4.1 — estes dois eram importados com `import type`, que apaga a
// classe em tempo de execução: o `design:paramtypes` ficava `Object`,
// o Nest não resolvia nada e o `@Optional()` escondia a falha. O
// derivado PDF NUNCA era reconstruído — era por isso que as fotos
// continuavam deitadas e com 3 MB no arquivo. Ambos os ficheiros são
// folhas (só dependem de pdf-lib / jimp), por isso importá-los por
// valor não cria ciclo de módulos.
import { ImageToPdfService } from "../documents/image-to-pdf/image-to-pdf.service";
import { ArchiveImageService } from "../documents/image-to-pdf/archive-image.service";
import { OcrmypdfService } from "./ocrmypdf.service";
import { ImageEnhancerService } from "./image-enhancer.service";
// Sprint I — publish `document.extracted` so the processing pipeline's
// EXTRACTING → ENRICHING handler runs. Previously the extraction service
// returned its result but never told the pipeline to advance — documents
// were stuck in EXTRACTING until manual intervention. QueueAdapter is
// global (QueueModule.forRoot() in app.module.ts) so this resolves even
// when ExtractionModule is the boot path.
import { QUEUE_ADAPTER, type QueueAdapter } from "../../common/queue/queue-adapter.interface";
// Sprint H+ extraction-fix-3 — structural NIF/IBAN validators used by
// the filename-heuristic guard + the AI-vs-QR disagreement logger below.
// The validator never throws on malformed input, so importing it is
// safe in this hot path. `isValidIban` is already imported from
// @docflow/shared at the top of the file — only `isValidPortugueseNif`
// is new (the shared helper validates PT NIFs differently and is used
// in different parts of the pipeline).
import { isValidPortugueseNif } from "../../common/validation/tax-id.validator";

/**
 * Where the text fed into the regex/QR pipeline came from. Recorded on
 * `metadata.extraction.textSource` so the operator can see why a doc
 * produced the result it did (and so we can alert on `needs_manual_ocr`).
 *
 * - `pdf-text`   : parsed the embedded text layer via pdf-parse.
 * - `ocr`        : tesseract ran (image/*  or rasterized scan).
 * - `none`       : nothing extractable — broken/encrypted/empty file.
 * - `filename`   : only the file name was available (storage offline).
 * - `preloaded`  : a QR payload was passed in by the caller.
 */
export type TextSource = "pdf-text" | "ocr" | "none" | "filename" | "preloaded";

export interface LoadedText {
  text: string;
  source: TextSource;
  /** True when the file looks like a scanned/image-only PDF. */
  needsManualOcr: boolean;
  /** Number of pages, when we successfully parsed the PDF structure. */
  pageCount?: number;
  /** Free-form reason when source === 'none'. */
  reason?: string;
}

/**
 * Heuristic field shape extracted from a Document's text/QR/OCR output.
 * The service writes these into the Document header and stores the raw
 * payload + heuristics inside `metadata.extraction` for auditability.
 */
export interface ExtractedFields {
  supplierNif?: string;
  /** Country-prefixed VAT identifier when the issuer is outside Portugal. */
  supplierVatId?: string;
  supplierAddress?: string;
  supplierPostalCode?: string;
  supplierCity?: string;
  supplierPhone?: string;
  supplierEmail?: string;
  supplierWebsite?: string;
  customerNif?: string;
  supplier?: string;
  customer?: string;
  docNumber?: string;
  atcud?: string;
  docDate?: string;
  dueDate?: string;
  total?: number;
  taxAmount?: number;
  netAmount?: number;
  iban?: string;
  currency: string;
  /** ISO 3166-1 alpha-2 country inferred from VAT ID or IBAN. */
  country?: string;
  /** BCP 47 display hint kept in metadata; no schema migration required. */
  documentLocale?: string;
  ibanCountry?: string;
  taxRate?: number;
  /**
   * Document type from the classifier. Only set when the classifier
   * had a strong signal (one of the recognised keywords in the
   * extracted text, or a QR-AT D field that maps to a known type).
   * Undefined means "leave the existing doc.type alone" — the user
   * might have set it manually at upload, and we shouldn't override
   * that without evidence.
   */
  documentType?: DocumentType;
  /**
   * Fase 4.1 — cabeçalho do documento transcrito à letra pelo modelo
   * ("OFERTA DE VENTA", "PRESUPUESTO", "FACTURA", "NOTA DE CRÉDITO"…).
   * É só texto: a decisão de fiscal/não-fiscal continua a ser tomada
   * em código por `detectNonFiscalKind`. Indispensável para as fotos,
   * onde o OCR devolve vazio e não há mais nada para a regra ler.
   */
  documentTitle?: string;
  /**
   * Fase 4.1 — numa nota de crédito, o número da fatura que retifica
   * (campo "documento retificado"). Usado para ligar a NC à fatura.
   */
  correctedDocumentNumber?: string;
  /**
   * Fase 4.1 — true quando soma(linhas) − descontos + IVA = total ao
   * cêntimo. Só então os totais podem mostrar confiança alta.
   */
  totalsReconciled?: boolean;
  confidence: number;
  /**
   * Origin of the fields:
   *   - "at_qr"  — only the QR-AT path produced a result (Gemini never ran)
   *   - "ai"     — only the AI/Gemini path produced a result (no QR)
   *   - "at_qr+ai" — both ran: QR won on its authoritative fiscal fields
   *                  and the AI filled the gaps the QR doesn't carry
   *                  (lineItems, iban, full supplier name, etc.). The
   *                  merge is non-destructive — the QR's NIF, total,
   *                  tax, docType, ATCUD and date never get overwritten.
   *   - "ocr" / "regex" / "none" — no QR, AI didn't run / no provider key
   */
  source: "at_qr" | "at_qr+ai" | "ocr" | "regex" | "ai" | "none";
  hints: string[];
  warnings: string[];
  /**
   * Every IBAN candidate the regex matched against `text`, with the
   * raw form, the normalised form (whitespace + dots + dashes
   * stripped), and whether it passed MOD-97. The first `valid: true`
   * entry is the IBAN we stored; the rest are noise that landed
   * inside the regex's {10,30} window. Surfaced in metadata so the
   * operator can see what was tried.
   */
  ibanCandidates?: Array<{
    raw: string;
    normalized: string;
    valid: boolean;
  }>;
  /**
   * Structured line items captured by the AI vision path. Always
   * undefined on the regex / OCR-only path — those paths can't
   * recover line items reliably, and persisting noise would mislead
   * the operator.
   */
  lineItems?: Array<{
    description?: string;
    code?: string;
    quantity?: number;
    unitPrice?: number;
    vatRate?: number;
    /** Per-line discount amount (currency). Optional. */
    discount?: number;
    lineTotal?: number;
  }>;
  /**
   * Invoice-level (global) discount amount in the document currency,
   * subtracted from the subtotal before VAT. Optional. Persisted into
   * `metadata.extraction.discountAmount` and (when no per-row column
   * is required) stays as metadata — the operator can still see the
   * figure and the total reconciles after the discount.
   */
  discountAmount?: number;
  /**
   * Per-rate VAT breakdown computed either by the AI directly or by
   * aggregating the lineItems post-merge in `processDocumentAsync`.
   * Persisted into `metadata.extraction.ivaBreakdown`. Each entry is
   * { rate, base, tax } — base = sum of net at that rate (after line
   * discounts, before the global one); tax = base * rate/100.
   */
  ivaBreakdown?: Array<{ rate: number; base: number; tax: number }>;
  /**
   * True when the AI believes this is an intra-community acquisition
   * (foreign EU supplier + reverse charge). Carried through from the
   * vision payload, surfaced in metadata, never persisted on the row
   * (the operator decides and confirms).
   */
  isEuIntracommunity?: boolean;
  /**
   * AI-suggested SNC/PGC category for the expense — drives auto-filing.
   * When set and the AI path produced it (source === "ai"), the
   * folder-rules engine is re-evaluated with this category as a keyword
   * hint so the document is parked in the right accounting folder.
   */
  suggestedCategory?: string;
  /**
   * Cash discount rate (desconto de pronto pagamento), as a percentage
   * (e.g. 2 for 2 %). Optional — most invoices don't offer early-payment
   * discounts.
   */
  cashDiscountRate?: number;
}

export interface IbanCheckResult {
  ok: boolean;
  iban: string;
  isValidIban: boolean;
  matchesPartyIban: boolean;
  knownIbanForParty: boolean;
  flagged: boolean;
  reasons: string[];
  historyCount: number;
}

/**
 * ExtractionService — owns AT-QR decode and OCR/regex fallback for
 * uploaded Documents. Designed to be invoked either:
 *
 *   - directly from the controller (sync path; useful for tiny QR-only
 *     payloads and tests); or
 *   - via the BullMQ `extraction` queue (default path; the controller
 *     enqueues and returns 202, the worker calls `processDocumentAsync`).
 *
 * Redis at localhost:6379 may be unavailable in dev/CI. The BullMQ
 * Queue is registered with `lazyConnect` so the worker boots even if
 * Redis is down — enqueue() catches the connection error and falls back
 * to synchronous execution.
 */
@Injectable()
export class ExtractionService implements OnModuleDestroy {
  private readonly logger = new Logger(ExtractionService.name);
  /**
   * Sidecar — the raw vision `extracted` payload from the most
   * recent `tryVisionAnalysis` call. Set by `tryVisionAnalysis` just
   * before returning, read by `mergeQrWithAi` after
   * `runAiOrRegexPath` returns so the QR+AI merge can pull
   * supplier / IBAN / lineItems out of a partial AI response
   * even when the inner `mergeVisionWithRegex` gated out the
   * numerics. Reset at the top of each `mergeQrWithAi` call so a
   * stale value from a prior request can't leak across documents.
   *
   * We deliberately keep this in the service instance (not in
   * `loaded` / `doc`) because the helper is called from many
   * call-sites and threading a new field through every signature
   * would be noisy. The single-flight pattern is safe as long as
   * extraction runs sequentially per tenant (which the BullMQ
   * worker honours — see `extraction.processor.ts`).
   */
  private lastVisionExtracted:
    | import("../ai/vision.service").VisionExtractedFields
    | null = null;
  private lastAiExtraction: Record<string, any> | null = null;

  /**
   * HARDENED 2026-09-01: serial sync-fallback queue.
   *
   * Bug: when Redis/BullMQ is down, `enqueue()` falls back to running
   * `processDocumentAsync(input)` directly inside the request handler.
   * If two uploads arrive ~seconds apart, both awaits start at the same
   * tick and run concurrently. The two requests then collide on the
   * shared `lastVisionExtracted` instance field (read by the QR+AI merge
   * in `mergeQrWithAi`), and on the shared Prisma connection pool. In
   * practice the second job silently died (stuck NOVO with no
   * `aiProvider` recorded) while the first finished normally.
   *
   * Fix: chain every sync-fallback execution through a SINGLE in-memory
   * promise. Each enqueue appends `.then(...)` to the tail; jobs run
   * strictly FIFO, one at a time. Never dropped — if the head is busy
   * (e.g. processing a slow Opus 5 call), the new job waits its turn.
   * The tail is reset on error so a poison job does not block the
   * queue (its `.catch()` runs the `writeNeedsReviewMarker` path that
   * `processDocumentAsync` already provides).
   *
   * BullMQ path is unaffected — the BullMQ worker is already
   * single-flight (one job at a time per worker).
   */
  private syncQueueTail: Promise<void> = Promise.resolve();
  /** Number of jobs currently queued (waiting + active). Diagnostic only. */
  private syncQueueDepth = 0;
  /** Soft cap so a runaway burst (loop uploading the same doc) is visible. */
  private static readonly SYNC_QUEUE_SOFT_CAP = 100;

  constructor(
    private readonly prisma: PrismaService,
    @Optional()
    @InjectQueue(EXTRACTION_QUEUE)
    private readonly queue: Queue<ExtractionJob, ExtractionJobResult> | null,
    @Optional()
    @Inject(StorageService)
    private readonly storage: StoragePort | null,
    @Optional()
    private readonly vision?: VisionService,
    // FolderRulesEngine lives in DocumentsModule — wiring it via forwardRef
    // lets us re-suggest the folder AFTER extraction completes (so the
    // AI's `suggestedCategory` from metadata.extraction flows into the
    // rules engine). Kept @Optional because some test paths build the
    // service without modules wired — the auto-filing step simply skips.
    @Optional()
    @Inject(forwardRef(() => FolderRulesEngine))
    private readonly rulesEngine?: FolderRulesEngine,
    // SupplierResolver — auto-links/creates the Party row after
    // extraction. Optional so the legacy test fixture (which builds
    // ExtractionService without DI) keeps compiling; the step simply
    // becomes a no-op.
    @Optional()
    private readonly supplierResolver?: SupplierResolver,
    // ImageToPdfService — used by the orientation-fix step to rebuild
    // the PDF derivative against upright bytes so the viewer doesn't
    // show a sideways document. @Optional because the service is also
    // instantiated in unit tests that don't wire the documents module.
    @Optional()
    private readonly imageToPdf?: ImageToPdfService,
    // DocumentsService — owns the post-extraction rename hook that
    // swaps the upload-time filename for a `<SUPPLIER>_<DATE>_<NUMBER>`
    // slug. Optional so the unit-test harness (which builds the
    // service without DocumentsModule) keeps compiling — the rename
    // simply becomes a no-op when the dependency is absent.
    @Optional()
    @Inject(forwardRef(() => DocumentsService))
    private readonly documents?: DocumentsService,
    // QueueAdapter — Sprint I wiring. Published `document.extracted`
    // at the end of a successful processDocumentAsync so the
    // processing pipeline's handleExtracted advances the doc from
    // EXTRACTING → ENRICHING. Marked @Optional because the existing
    // unit-test harness constructs ExtractionService without DI; the
    // publish becomes a no-op (logs a warning) so the tests still pass.
    @Optional()
    @Inject(QUEUE_ADAPTER)
    private readonly queueAdapter?: QueueAdapter,
    @Optional()
    private readonly vies?: ViesService,
    @Optional()
    private readonly fx?: EcbFxService,
    // Fase 4.1 (P1.4) — endireita pelo conteúdo e comprime a imagem
    // antes de a embeber no PDF de arquivo. @Optional pela mesma razão
    // que o ImageToPdfService: o harness de testes não liga o módulo.
    @Optional()
    private readonly archiveImage?: ArchiveImageService,
    // OCRmyPDF — conversão e enriquecimento PDF/A legal (art. 52.º CIVA) com OCR
    @Optional()
    private readonly ocrmypdf?: OcrmypdfService,
    // Zerox — extração e particionamento de PDFs/fotos com visão IA e Markdown estruturado
    @Optional()
    private readonly zerox?: ZeroxService,
    // Sharp — auto-rotação, recorte de borda de suporte (trim/crop), contraste e nitidez
    @Optional()
    private readonly imageEnhancer?: ImageEnhancerService,
  ) {}

  /**
   * Enqueue an extraction job. Falls back to in-process execution if
   * Redis is unreachable or the queue isn't wired (graceful dev/CI mode).
   */
  async enqueue(input: ExtractionJob): Promise<ExtractionJobResult> {
    // HARDENED 2026-09-01: log at the very first line so the operator
    // can ALWAYS see that the trigger reached the extraction service,
    // regardless of whether Redis is up, the queue is wired, or the
    // path falls back to in-process.
    this.logger.log(
      `[enqueue] received document=${input.documentId} tenant=${input.tenantId} ` +
        `at=${new Date().toISOString()}`,
    );
    if (this.queue) {
      try {
        // `connection` may be lazy; a connect failure surfaces as `Error` here.
        // Race the enqueue against a short timeout: when Redis is down, ioredis
        // retries with backoff and `queue.add()` can hang for many seconds
        // (blocking the upload's fire-and-forget). Cap it at 2s, then fall
        // back to in-process execution.
        await Promise.race([
          this.queue.add(EXTRACTION_QUEUE_OPTIONS.jobName, input, {
            attempts: 2,
            backoff: { type: "exponential", delay: 2_000 },
            removeOnComplete: 200,
            removeOnFail: 200,
          }),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error("enqueue timeout (Redis unreachable)")),
              2_000,
            ),
          ),
        ]);
        return { queued: true, documentId: input.documentId, ok: true };
      } catch (err) {
        // FULL stack — never let a Redis failure silently swallow the
        // real reason the sync path might fail downstream.
        this.logger.warn(
          `[enqueue] BullMQ enqueue failed for document=${input.documentId}, ` +
            `running sync in-process. Reason: ${(err as Error).message}`,
        );
        this.logger.debug(
          `[enqueue] BullMQ enqueue stack: ${(err as Error).stack ?? "(no stack)"}`,
        );
      }
    }
    // FALLBACK — run in-process, but SERIALIZED through the in-memory
    // FIFO queue. Concurrent uploads (Redis down → every request
    // takes this path) used to collide on shared state (the
    // `lastVisionExtracted` instance field, the Prisma pool) and the
    // loser died silently. We chain each sync execution onto a single
    // tail promise so jobs run strictly one at a time, FIFO. A crash
    // mid-job resets the tail via the inner `.catch()` so the next
    // upload isn't poisoned, AND the `processDocumentAsync` top-level
    // catch already writes a `needs_review` marker on the Document
    // row so the operator sees what happened.
    this.syncQueueDepth += 1;
    if (this.syncQueueDepth > ExtractionService.SYNC_QUEUE_SOFT_CAP) {
      this.logger.warn(
        `[enqueue] sync queue depth=${this.syncQueueDepth} ` +
          `(soft cap=${ExtractionService.SYNC_QUEUE_SOFT_CAP}) — burst, check uploads`,
      );
    }
    this.logger.log(
      `[enqueue] sync extraction QUEUED for document=${input.documentId} ` +
        `(queue depth=${this.syncQueueDepth})`,
    );

    const tail = this.syncQueueTail.then(async () => {
      this.logger.log(
        `[enqueue] sync extraction STARTING for document=${input.documentId} ` +
          `(queue depth=${this.syncQueueDepth})`,
      );
      try {
        const result = await this.processDocumentAsync(input);
        this.logger.log(
          `[enqueue] sync extraction COMPLETED for document=${input.documentId} ` +
            `(ok=${result.ok}, source=${result.source ?? "?"}, ` +
            `confidence=${result.confidence ?? "?"})`,
        );
        return result;
      } catch (err) {
        this.logger.error(
          `[enqueue] sync extraction THREW for document=${input.documentId}. ` +
            `Reason: ${(err as Error).message}`,
        );
        this.logger.error(
          `[enqueue] sync extraction stack: ${(err as Error).stack ?? "(no stack)"}`,
        );
        // Re-throw so the caller's `.catch()` in DocumentsService sees
        // it — and `processDocumentAsync`'s own top-level catch has
        // already written the needs_review marker to the row.
        throw err;
      } finally {
        this.syncQueueDepth = Math.max(0, this.syncQueueDepth - 1);
      }
    });

    // Reset the tail even if THIS job throws so the next upload is not
    // poisoned. The tail is only the `await`-able portion; the depth
    // counter lives on `this`.
    this.syncQueueTail = tail.then(
      () => undefined,
      () => undefined,
    );

    return tail;
  }

  /**
   * Worker entry point — pulls the Document, runs QR/OCR/regex, writes
   * fields back, performs the IBAN anti-fraud check, and returns a
   * compact result for the queue job log.
   *
   * NEVER throws — any unexpected error during OCR / AI / parsing is
   * caught and recorded, so the caller's fire-and-forget `.catch()`
   * doesn't have to do forensics on a silent no-op. The Document
   * remains in whatever state it was before — the operator can re-run
   * via the manual trigger after they look at the logs.
   */
  async processDocumentAsync(
    input: ExtractionJob,
  ): Promise<ExtractionJobResult> {
    const job = input;
    const { tenantId, documentId, userId, modelOverride, providerOverride, forceReextract } = input;
    this.lastAiExtraction = null;
    this.logger.log(
      `[processDocumentAsync] start document=${documentId} tenant=${tenantId}`,
    );

    try {
    const doc = await this.prisma.document.findFirst({
      where: { id: documentId, tenantId },
      include: { party: true },
    });
    if (!doc) {
      this.logger.warn(
        `Document ${documentId} not found for tenant ${tenantId}`,
      );
      return {
        queued: false,
        documentId,
        ok: false,
        reason: "document_not_found",
      };
    }

    // Sprint H+ extraction-fix-3 — Operator-Verified Guard.
    //
    // If the operator has explicitly confirmed the supplier block via
    // PATCH /documents/:id/verify-supplier (writes supplierVerifiedAt)
    // OR has corrected it via POST /documents/:id/correct-supplier (the
    // endpoint resets processingStatus back to RECEIVED so the pipeline
    // re-runs the enrichment), we MUST NOT overwrite the supplier
    // fields with freshly-AI-extracted values. The real bug from
    // 2026-09-06 cmtoag5il: operator corrected supplier to ONNERA
    // REFRIGERATION S.A., correct-supplier re-published document.uploaded,
    // the pipeline re-extracted, and AI Vision — reading the filename
    // "NOV-OUSADO-LDA_*.pdf" — overwrote the row back to "NOV OUSADO LDA".
    //
    // We honour the operator's decision by:
    //   1) Skipping the supplier-side extraction entirely (no QR/AI merge
    //      for supplier fields, no party re-resolve, no IBAN re-check).
    //   2) Still writing metadata + ocrConfidence so the audit trail
    //      shows the re-run happened but nothing was destroyed.
    //   3) Returning ok:true so the pipeline can advance to ENRICHING.
    //
    // This is a behaviour change from the previous "AI always wins on
    // re-run" stance, and the only way the operator's correction survives
    // a pipeline re-trigger. The trade-off: if the operator is wrong, the
    // wrong values stick until they re-verify or re-correct. That's
    // intentional — the verify-supplier UX triad already requires an
    // explicit "Confirmar como está" gesture for exactly this reason.
    // Fase 4.3 (P0.1) — se for re-extração completa forçada, reprocessar de raiz
    if (doc.supplierVerifiedAt && !job?.forceReextract) {
      this.logger.warn(
        `[processDocumentAsync] document=${documentId} supplierVerifiedAt=${doc.supplierVerifiedAt.toISOString()} ` +
          `— skipping supplier-side extraction to preserve operator-verified ` +
          `supplier block (supplier="${doc.supplier ?? "?"}", supplierNif="${doc.supplierNif ?? "?"}"). ` +
          `Re-run is harmless (metadata/ocrConfidence will refresh) but won't ` +
          `overwrite the operator's decision.`,
      );
      // Touch only metadata + ocrConfidence so the pipeline can advance.
      // Status is left as-is — the operator already decided the row's fate.
      const refreshed = await this.prisma.document.update({
        where: { id: documentId },
        data: {
          metadata: {
            ...((doc.metadata && typeof doc.metadata === "object" && !Array.isArray(doc.metadata)
              ? (doc.metadata as Record<string, unknown>)
              : {}) as Record<string, unknown>),
            extraction: {
              ...((doc.metadata &&
                typeof doc.metadata === "object" &&
                "extraction" in (doc.metadata as Record<string, unknown>) &&
                (doc.metadata as Record<string, unknown>).extraction &&
                typeof (doc.metadata as Record<string, unknown>).extraction === "object" &&
                !Array.isArray((doc.metadata as Record<string, unknown>).extraction)
                ? ((doc.metadata as Record<string, unknown>).extraction as Record<string, unknown>)
                : {}) as Record<string, unknown>),
              reRunSkippedSupplier: true,
              reRunSkippedAt: new Date().toISOString(),
              reRunSkippedReason: "supplierVerifiedAt_set",
            },
          } as Prisma.InputJsonValue,
        },
      });
      return {
        queued: false,
        documentId,
        ok: true,
        source: "none",
        confidence: 0,
        reason: "supplier_verified_skip",
        document: { id: refreshed.id, status: refreshed.status },
      };
    }

    const loaded = await this.loadDocumentText(doc);
    // ── IMAGE-ORIENT FIX + ZXING QR DECODE (deterministic) ────────────
    // For image/* uploads: phone photos carry EXIF Orientation that
    // makes them render rotated in viewers/ZXing. We (a) auto-rotate
    // the bytes to upright and PERSIST them so the PDF derivative and
    // the stored image show correct orientation, then (b) try to
    // decode the QR with ZXing on the upright pixels. ZXing's
    // hybrid-binarizer pipeline is the only decoder that reliably
    // reads real phone photos (jsQR is abandon-ware now).
    //
    // Failure modes (graceful — never aborts):
    //   - storage.read throws                  → falls back to storedQr
    //   - jimp/ZXing import unavailable        → falls back to vision
    //   - autoOrient threw                     → use the original bytes
    //   - ZXing could not lock onto a QR       → source='ai' as before
    let zxingQr: string | null = null;
    if (
      /^image\//i.test(doc.mimeType) &&
      this.storage
    ) {
      try {
        const obj = await this.storage.getBuffer(doc.fileKey);
        let oriented = obj.buffer;
        let enhancedMime = doc.mimeType;

        if (this.imageEnhancer && this.imageEnhancer.isAvailable()) {
          oriented = await this.imageEnhancer.processDocumentImage(obj.buffer, doc.mimeType);
          enhancedMime = 'image/jpeg';
        } else {
          oriented = await autoOrientImage(obj.buffer, doc.mimeType, this.logger);
        }

        // If enhanced/oriented rewrote the bytes, persist them
        if (oriented !== obj.buffer) {
          try {
            if (!this.storage.put) {
              throw new Error("storage.put not available");
            }
            await this.storage.put(doc.fileKey, oriented, {
              contentType: enhancedMime,
            });
            this.logger.log(
              `[processDocumentAsync] enhanced/auto-rotated ${doc.fileName} ` +
                `(original ${obj.buffer.length}B → enhanced ${oriented.length}B) ` +
                `and persisted enhanced bytes`,
            );
          } catch (putErr) {
            this.logger.warn(
              `[processDocumentAsync] storage.put enhanced image failed for ${doc.fileName}: ` +
                `${(putErr as Error).message}`,
            );
          }
        }

        // Always ensure A4 PDF derivative exists for image uploads
        try {
          const docRecord = await this.prisma.document.findFirst({
            where: { id: documentId },
            select: { pdfKey: true },
          });
          const targetPdfKey = docRecord?.pdfKey || doc.fileKey.replace(/\.[^.]+$/, '.pdf');
          if (this.ocrmypdf || (this.imageToPdf && this.imageToPdf.supports(enhancedMime))) {
            const newPdf = this.ocrmypdf
              ? await this.ocrmypdf.processImageOrPdf(oriented, enhancedMime)
              : await this.imageToPdf!.convert(oriented, enhancedMime);
            if (this.storage.put) {
              await this.storage.put(targetPdfKey, newPdf, {
                contentType: 'application/pdf',
              });
              if (!docRecord?.pdfKey) {
                await this.prisma.document.update({
                  where: { id: documentId },
                  data: { pdfKey: targetPdfKey },
                });
                doc.pdfKey = targetPdfKey;
              }
              this.logger.log(
                `[processDocumentAsync] built/rebuilt pdf derivative ` +
                  `${targetPdfKey} from enhanced bytes`,
              );
            }
          }
        } catch (pdfErr) {
          this.logger.warn(
            `[processDocumentAsync] pdf derivative creation failed ` +
              `for ${doc.fileName}: ${(pdfErr as Error).message}`,
          );
        }
        // ── Fase 4.1 (P1.4) — PDF de arquivo: direito e ≤ 500 KB ───────
        // O arquivo fiscal é de 10 anos: um JPEG de 3 MB por documento
        // não é sustentável, e as fotos apareciam deitadas porque muitas
        // não trazem etiqueta EXIF (a rotação EXIF acima só resolve as
        // que trazem). Aqui endireitamos pelo conteúdo e comprimimos. O
        // original fica intacto no MinIO; é o PDF que vai para arquivo.
        await this.rebuildArchivePdf(documentId, doc, oriented);

        // Now try the QR decode on the upright bytes (always prefer the
        // rotated version when present — even when the persist step
        // failed, `oriented` is local and correct).
        zxingQr = await decodeAtQr(oriented, doc.mimeType, this.logger);
        // Stash the ZXing-decoded QR as a hint so it survives the merge
        // path and is used in preference to the AI's atQrRaw when the
        // AI's vision decode disagrees with the deterministic decode.
        if (zxingQr) {
          // We attach the hint to fields.hints indirectly — easier to
          // do it at the qrCandidate lookup below where we already have
          // zxingQr in scope.
        }
        if (zxingQr) {
          const validated = this.findAtQrInText(zxingQr);
          if (validated) {
            this.logger.log(
              `[processDocumentAsync] ZXing decoded AT-QR from ` +
                `${doc.fileName} (${zxingQr.length} chars)`,
            );
            zxingQr = validated;
          } else {
            this.logger.log(
              `[processDocumentAsync] ZXing found a QR but payload is ` +
                `not AT-QR (preview=${zxingQr.slice(0, 60)}…)`,
            );
            zxingQr = null;
          }
        } else {
          this.logger.log(
            `[processDocumentAsync] ZXing found no QR in ${doc.fileName}`,
          );
        }
      } catch (err) {
        this.logger.warn(
          `[processDocumentAsync] image-orient/ZXing step failed for ` +
            `${doc.fileName}: ${(err as Error).message}. Falling back to ` +
            `vision path.`,
        );
      }
    }
    // Prefer a previously-stored QR payload (set when the user pastes a
    // camera capture) OVER everything; then a freshly ZXing-decoded QR
    // from this image; then the text layer of the PDF (which can carry
    // the QR string on a digital PDF export).
    // Fase 3 — a stored payload is only trusted when it is a complete AT-QR
    // (valid issuer NIF, ATCUD, Q hash, R certificate). Rows written before
    // the Fase 2 cross-check may hold an LLM-mangled read-back; those are
    // ignored so the deterministic decoders run again.
    const storedParsed = doc.qrPayload ? parseAtQr(doc.qrPayload) : null;
    const storedQrTrusted = isValidAtQr(storedParsed);
    if (doc.qrPayload && !storedQrTrusted) {
      this.logger.warn(
        `[processDocumentAsync] stored qrPayload for document=${documentId} is not a complete AT-QR ` +
          `(missing Q/R/ATCUD or invalid NIF) — ignoring it and re-decoding`,
      );
    }
    const storedQr = storedQrTrusted && doc.qrPayload ? this.findAtQrInText(doc.qrPayload) : null;
    let zxingCandidate = storedQr ? null : (zxingQr ? this.findAtQrInText(zxingQr) : null);
    const textQr = storedQr || zxingCandidate ? null : this.findAtQrInText(loaded.text);
    // Fase 2 — deterministic QR for PDFs: when neither the stored payload
    // nor the PDF text layer carries an AT-QR (scanned PDFs, or digital PDFs
    // that draw the QR as an image), rasterise the first and last page and
    // run the same ZXing/jsQR cascade used for photos. This runs BEFORE any
    // vision call so NIF/total/ATCUD come from the QR, never from the LLM.
    if (
      !storedQr &&
      !zxingCandidate &&
      !textQr &&
      /^application\/pdf/i.test(doc.mimeType) &&
      this.storage
    ) {
      try {
        const fromRaster = await this.decodeQrFromPdfRaster(doc, loaded.pageCount);
        if (fromRaster) {
          zxingQr = fromRaster;
          zxingCandidate = fromRaster;
          this.logger.log(
            `[processDocumentAsync] ZXing decoded AT-QR from rasterised PDF page of ${doc.fileName}`,
          );
        }
      } catch (err) {
        this.logger.warn(
          `[processDocumentAsync] PDF raster QR step failed for ${doc.fileName}: ${(err as Error).message}`,
        );
      }
    }
    const qrCandidate = storedQr ?? zxingCandidate ?? textQr;

    let fields: ExtractedFields;
    const aiOverrides =
      modelOverride || providerOverride
        ? { model: modelOverride, provider: providerOverride }
        : undefined;

    if (qrCandidate) {
      // QR-AT + Gemini merge — the QR is AUTHORITATIVE for the fiscal
      // fields it carries (issuer NIF, doc type, total, tax, date,
      // ATCUD, ivaBreakdown) but does NOT carry the supplier name,
      // IBAN, line items, suggested category, customer or due date.
      // We run Gemini anyway and merge: QR wins on its fields, AI
      // fills the gaps. If Gemini fails or times out we keep the QR
      // fields alone — never worse than today.
      const qrFields = this.extractFromQr(qrCandidate, doc);
      fields = await this.mergeQrWithAi(
        qrFields,
        doc,
        loaded,
        tenantId,
        undefined,
        aiOverrides,
      );
    } else {
      fields = await this.runAiOrRegexPath(doc, loaded, tenantId, aiOverrides);
      // Gemini-assisted QR fallback: when the jsqr image decoder failed
      // on a real phone photo (small, angled, low-contrast QR) but
      // Gemini vision DID read the AT-QR string visually, treat that as
      // a QR candidate and re-run the QR-merge path. This is the key
      // fix for the real-photo case — Gemini reads the QR modules the
      // way a human would; we just have to notice and re-parse what
      // it returned. The result keeps the QR-authoritative fiscal
      // fields and gets the AI's supplier/IBAN/line-items for free.
      const aiQrRaw = fields.hints
        ?.find((h) => h.startsWith("aiQrRaw:"))
        ?.split(":")
        .slice(1)
        .join(":");
      if (aiQrRaw && this.findAtQrInText(aiQrRaw)) {
        const validated = this.findAtQrInText(aiQrRaw);
        if (validated) {
          const qrFields = this.extractFromQr(validated, doc);
          // Fase 2 — an LLM "reading" a QR is NOT a QR decode: the Fase 2
          // benchmark caught a hallucinated NIF (valid check digit!) and a
          // total of 5.20 on a 38.10 receipt. The read-back is only trusted
          // when it agrees with the fields the same model extracted from the
          // visible text (NIF, total, date). Otherwise the structured AI
          // fields stay and the document is flagged for review.
          const check = this.isAiQrConsistent(qrFields, fields);
          if (check.ok) {
            this.logger.log(
              `[processDocumentAsync] using AI-returned atQrRaw as QR candidate ` +
                `(document=${documentId}, payload len=${validated.length}, cross-checked with AI fields)`,
            );
            const mergedFromAiQr = await this.mergeQrWithAi(
              qrFields,
              doc,
              loaded,
              tenantId,
              fields,
              aiOverrides,
            );
            mergedFromAiQr.hints = [
              ...(mergedFromAiQr.hints ?? []),
              "qrOrigin:ai_vision_readback",
            ];
            fields = mergedFromAiQr;
          } else {
            this.logger.warn(
              `[processDocumentAsync] AI-returned atQrRaw REJECTED for document=${documentId}: ` +
                `${check.reasons.join(", ")} — keeping AI structured fields, flagging review`,
            );
            fields = {
              ...fields,
              hints: [...(fields.hints ?? []), "qrOrigin:ai_vision_readback_rejected"],
              warnings: [
                ...(fields.warnings ?? []),
                `ai_qr_inconsistent_with_ai_fields:${check.reasons.join("|")}`,
              ],
            };
          }
        }
      }
    }

    // ── POST-PROCESS SAFETY NET ────────────────────────────────────
    // Ensure supplier is NOT our own company. When the AI gets it wrong
    // (real bug from 2026-09-01 Américo Alves photo: supplier='NOV OUSADO',
    // customer='Américo Alves'), we swap supplier/customer back. The
    // QR's `A:` field is authoritative for supplier NIF — when we have
    // it, use it; otherwise fall back to the tenant identity helper.
    // The QR payload priority: stored (on the row) > aiQrRaw (the AI
    // just decoded it visually) > null (AI didn't find a QR).
    const aiQrForSanity = (fields.hints ?? [])
      .find((h) => h.startsWith("aiQrRaw:"))
      ?.split(":")
      .slice(1)
      .join(":");
    // Sanity check: prefer the deterministic ZXing decode, then the
    // stored qrPayload, then the AI's vision read. The supplier-swap
    // safety net uses the most trustworthy QR string available.
    const qrForSanity = zxingQr ?? doc.qrPayload ?? aiQrForSanity ?? undefined;
    fields = await this.ensureSupplierCustomerSanity(
      tenantId,
      fields,
      qrForSanity,
      doc.fileName,
    );

    // ── Party-resolve-by-NIF fallback (DIAGNOSTIC-2 §5 item 7) ──────
    // When the AI's supplier NIF is structurally invalid AND the customer
    // NIF is structurally valid AND resolves to an existing Party in
    // this tenant, the customer Party is almost certainly the actual
    // supplier (AI swapped the slots). We rewrite the fields with the
    // trusted Party's name + NIF and capture the resolved partyId on
    // `resolvedPartyFromNif` so the SupplierResolver branch below links
    // to the trusted Party instead of creating a brand-new (wrong)
    // supplier row. Skipped when the document is already linked to a
    // Party — that means the operator verified/corrected earlier and
    // we MUST NOT overwrite.
    let resolvedPartyFromNif: { id: string; isRecurring: boolean; name?: string } | null = null;
    if (!doc.partyId) {
      try {
        const resolved = await this.resolveSupplierByNif(
          tenantId,
          documentId,
          fields,
        );
        if (resolved) {
          fields = {
            ...fields,
            supplier: resolved.supplier,
            supplierNif: resolved.supplierNif,
            customerNif: undefined, // clear — the buyer NIF was the supplier all along
            hints: [
              ...(fields.hints ?? []),
              `partySwap:reason=${resolved.reason}`,
              `partySwap:partyId=${resolved.partyId ?? "null"}`,
            ],
          };
          if (resolved.partyId) {
            resolvedPartyFromNif = { id: resolved.partyId, isRecurring: false, name: resolved.supplier };
          }
        }
      } catch (err) {
        // Belt + braces — never let the NIF-resolve fallback abort
        // extraction. The supplier-resolver below still runs against
        // the un-swapped fields and may still produce a useful link.
        this.logger.warn(
          `[processDocumentAsync] resolveSupplierByNif threw for document=${documentId}: ${(err as Error).message}`,
        );
      }
    }

    const aiQrRawForRow = (fields.hints ?? [])
      .find((h) => h.startsWith("aiQrRaw:"))
      ?.split(":")
      .slice(1)
      .join(":");
    // The deterministic ZXing decode wins over the AI's vision decode
    // when both exist — the user explicitly asked for "QR first for
    // certainty of fiscal data". Only fall back to aiQrRaw when ZXing
    // didn't decode anything.
    // Fase 2 — an AI read-back is only persisted as the row's qrPayload when
    // it passed the cross-check (see isAiQrConsistent). A rejected read-back
    // must never become the "stored QR" that short-circuits future re-runs.
    const aiQrAccepted = (fields.hints ?? []).includes("qrOrigin:ai_vision_readback");
    const qrPayloadOverride =
      zxingQr ?? (aiQrAccepted ? aiQrRawForRow : undefined) ?? undefined;

    const qrOriginForFiscal: "zxing" | "stored" | "pdf-text" | "ai" | null = zxingQr
      ? "zxing"
      : storedQr
        ? "stored"
        : textQr
          ? "pdf-text"
          : aiQrAccepted
            ? "ai"
            : null;
    const qrForFiscal = qrPayloadOverride ?? (storedQrTrusted ? doc.qrPayload : null) ?? null;
    // An ATCUD is authoritative only when it came from a real QR decode; an
    // LLM read-back can flip a character (JJY2HD8C vs JJY2HD80 on the same
    // IKEA receipt), so it may confirm a duplicate but never veto one.
    const atcudTrusted = qrOriginForFiscal !== null && qrOriginForFiscal !== "ai";
    const parsedForFiscal = qrForFiscal ? parseAtQr(qrForFiscal) : null;
    // Fase 4 — VIES: a foreign EU VAT id validated by the Commission's
    // service upgrades the document from INDETERMINADO to FISCAL.
    let viesValidatedForDoc = false;
    if (fields.supplierVatId && !/^PT/i.test(fields.supplierVatId) && this.vies) {
      try {
        viesValidatedForDoc = await this.vies.isValidated(fields.supplierVatId, tenantId);
      } catch (err) {
        this.logger.warn(`[processDocumentAsync] VIES check failed: ${(err as Error).message}`);
      }
    }

    // ── Fase 4.1 — saneamento determinístico de NIF e ATCUD ──────────
    // Um NIF ou um ATCUD inventados pelo modelo que sigam para a
    // contabilidade são o pior erro possível neste sistema. Nada do que
    // a IA leu nestes dois campos é persistido sem passar por código:
    //   ATCUD  só existe em Portugal e só com o formato oficial da AT;
    //   NIF    PT → módulo 11; UE → VIES; extra-UE → nunca confirmado.
    const docCountry = resolveDocumentCountry({
      country: fields.country,
      supplierVatId: fields.supplierVatId,
      supplierNif: fields.supplierNif,
      qrIssuerNif: parsedForFiscal?.issuerNif,
    });
    const taxIds = resolveTaxIds({
      supplierNif: fields.supplierNif ?? null,
      supplierVatId: fields.supplierVatId ?? null,
      country: docCountry,
      viesValidated: viesValidatedForDoc,
    });
    // Fase 4.1 (P2.1) — o ATCUD chega, por esta ordem: campo H de um
    // QR-AT realmente descodificado > "ATCUD:" impresso no texto/OCR >
    // o que a IA disse. Em várias fotos o QR lia-se mas o ATCUD não
    // chegava ao documento.
    const atcudFromQr = atcudTrusted ? (parsedForFiscal?.atcud ?? null) : null;
    const atcudFromText = extractAtcudFromText(loaded.text);
    const atcudCandidate = atcudFromQr ?? atcudFromText ?? fields.atcud ?? null;
    if (!fields.atcud && atcudCandidate) {
      fields.hints = [
        ...(fields.hints ?? []),
        `atcudSource:${atcudFromQr ? "qr_field_h" : "ocr_text"}`,
      ];
    }
    const atcudSan = sanitizeAtcud(atcudCandidate, {
      country: docCountry,
      fromTrustedQr: Boolean(atcudFromQr),
    });
    if (taxIds.rejected) {
      this.logger.warn(
        `[processDocumentAsync] document=${documentId} tax id rejected ` +
          `(${taxIds.reason}) — NOT persisted, document goes to review`,
      );
    }
    if (fields.atcud && !atcudSan.atcud) {
      this.logger.warn(
        `[processDocumentAsync] document=${documentId} ATCUD dropped (${atcudSan.reason})`,
      );
    }
    fields = {
      ...fields,
      supplierNif: taxIds.nif ?? undefined,
      atcud: atcudSan.atcud ?? undefined,
      hints: [
        ...(fields.hints ?? []),
        `taxId:${taxIds.validation}:${taxIds.reason}`,
        `atcud:${atcudSan.reason}`,
      ],
    };

    // Scan loaded.text for supplier contacts fallback if not yet extracted by AI
    if (loaded?.text) {
      if (!fields.supplierEmail) {
        const emailMatch = loaded.text.match(/\b([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\b/);
        if (emailMatch && !/example\.com|domain\.com/i.test(emailMatch[1])) {
          fields.supplierEmail = emailMatch[1].trim();
        }
      }
      if (!fields.supplierWebsite) {
        const webMatch = loaded.text.match(/\b((?:https?:\/\/)?(?:www\.)[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}(?:\/[^\s]*)?)\b/i);
        if (webMatch) {
          fields.supplierWebsite = webMatch[1].trim();
        }
      }
      if (!fields.supplierPhone) {
        const phoneMatch = loaded.text.match(
          /(?:Tel[eé]fon[oe]|Tel(?:ef|f|\.)?|Contacto|Phone|Mobile|Tlm)[:\s]*([+0-9\s()./-]{9,20})\b/i,
        );
        if (phoneMatch) {
          const cleanPhone = phoneMatch[1].replace(/\s+/g, ' ').trim();
          if (cleanPhone.replace(/\D/g, '').length >= 9) {
            fields.supplierPhone = cleanPhone;
          }
        }
      }
    }

    // Só um valor cruzado com algo (QR-AT, módulo 11, VIES) pode mostrar
    // confiança alta. O que vem só do modelo fica com teto baixo.
    const identityValidated = taxIds.validation === 'PT_MOD11' || taxIds.validation === 'VIES';
    const updateDataPreClean: Record<string, unknown> = {};
    // O saneamento tem de LIMPAR o que já está gravado, não apenas
    // recusar-se a escrever por cima. O `buildUpdateData` é aditivo (só
    // escreve valores truthy), por isso uma linha antiga com lixo ficava
    // lá para sempre: em produção havia documentos com o TOTAL gravado
    // na coluna do ATCUD ("1012.30", "155.00") e NIFs que falham o
    // módulo 11, escritos antes destas regras existirem. Um operador
    // nunca confirmaria nenhum desses valores, por isso limpá-los não
    // apaga trabalho humano.
    if (shouldClearStoredAtcud(doc.atcud, docCountry, atcudSan.atcud)) {
      updateDataPreClean.atcud = null;
      this.logger.warn(
        `[processDocumentAsync] document=${documentId} clearing stored ATCUD ` +
          `"${doc.atcud}" — fails the AT format or the document is not PT`,
      );
    }
    if (shouldClearStoredNif(doc.supplierNif, docCountry, taxIds.nif, viesValidatedForDoc)) {
      updateDataPreClean.supplierNif = null;
      updateDataPreClean.nifValid = false;
      this.logger.warn(
        `[processDocumentAsync] document=${documentId} clearing stored supplier NIF ` +
          `"${doc.supplierNif}" — did not pass mod-11 / VIES`,
      );
    }

    const confidenceSources = {
      nif: (atcudTrusted && parsedForFiscal?.issuerNif === taxIds.nif
        ? 'qr'
        : identityValidated
          ? 'validated'
          : 'ai') as 'qr' | 'validated' | 'ai',
      qrBacked: (atcudTrusted && Boolean(parsedForFiscal) ? 'qr' : 'ai') as 'qr' | 'ai',
    };

    const updateData = this.buildUpdateData(fields, {
      confidenceSources,
      // Persist the freshly-decoded payload to the row so re-runs don't
      // re-prompt Gemini. Existing doc.qrPayload (already on the row)
      // is preserved by NOT passing an override — the field stays
      // untouched when we trusted the stored value. ZXing-decode
      // takes priority over the AI-returned atQrRaw because the
      // deterministic decoder is more reliable than the vision
      // model's attempt at reading QR modules visually.
      qrPayloadOverride,
    });
    // As limpezas explícitas (null) entram DEPOIS do buildUpdateData,
    // que é aditivo e nunca escreve null por si.
    Object.assign(updateData, updateDataPreClean);
    // ── Fase 3 — validade fiscal determinística + chave fiscal ──────────
    // The classifier is pure code (extraction/fiscal-status.ts). The AI
    // only contributed the *inputs* (supplier NIF/VAT, doc number, date,
    // raw document type); whether the document is FISCAL is decided by the
    // QR-AT (real decode only) and by deterministic keyword rules.
    let tenantIdentity: TenantIdentity | undefined;
    try {
      tenantIdentity = await getTenantIdentity(this.prisma, tenantId);
    } catch (err) {
      this.logger.warn(
        `[processDocumentAsync] getTenantIdentity failed for tenant=${tenantId}: ${(err as Error).message}`,
      );
    }

    const fiscal = classifyFiscalStatus({
      qr: parsedForFiscal
        ? {
            issuerNif: parsedForFiscal.issuerNif,
            atcud: parsedForFiscal.atcud,
            hash4: parsedForFiscal.hash4,
            softwareCert: parsedForFiscal.softwareCert,
            documentType: parsedForFiscal.documentType,
          }
        : null,
      qrOrigin: qrOriginForFiscal,
      supplierNif: fields.supplierNif ?? null,
      supplierVatId: fields.supplierVatId ?? null,
      docNumber: fields.docNumber ?? null,
      docDate: fields.docDate ?? null,
      // Fase 4.1 — nas fotos o OCR devolve vazio (`textSource: none`), e
      // era por isso que a regra de palavras-chave corria às cegas e uma
      // "oferta de venta" espanhola passava por fatura. O `documentTitle`
      // é o cabeçalho transcrito à letra pelo modelo: dá texto à regra
      // sem lhe dar a decisão, que continua a ser tomada aqui em código.
      text: [
        loaded.text,
        fields.documentTitle ?? "",
        doc.fileName,
        fields.documentType ?? "",
        ...(fields.hints ?? []).filter((h) => /^(aiDocType|documentType|aiDocumentType|aiDocTitle):/i.test(h)),
      ].join(String.fromCharCode(10)),
      viesValidated: viesValidatedForDoc,
      tenantNif: tenantIdentity?.tenantNif,
      customerNif: fields.customerNif ?? null,
    });
    // ── Fase 4.1 (P2.2) — a correção manual do operador manda ────────
    // Quem marcou um documento como não fiscal (ou lhe corrigiu o tipo)
    // não pode ver a decisão desfeita pela re-extração seguinte.
    const hasAuthoritativeQr = !!(parsedForFiscal && isValidAtQr(parsedForFiscal));
    const isExplicitReextract = !!forceReextract || !!modelOverride || !!providerOverride;
    // Quando o operador pede explicitamente uma re-extração (ou com modelo diferente),
    // ou quando o documento tem QR-AT oficial autêntico, não mantemos o bloqueio antigo.
    const fiscalLocked = doc.fiscalStatusManualOverride === true && !isExplicitReextract && !hasAuthoritativeQr;
    const typeLocked = doc.typeManualOverride === true && !isExplicitReextract && !hasAuthoritativeQr;
    if (fiscalLocked) {
      fields.hints = [...(fields.hints ?? []), `fiscalStatus:manual_override_kept:${doc.fiscalStatus}`];
      this.logger.log(
        `[processDocumentAsync] document=${documentId} keeping operator's fiscalStatus ` +
          `${doc.fiscalStatus} (classifier said ${fiscal.fiscalStatus})`,
      );
    } else {
      (updateData as Record<string, unknown>).fiscalStatus = fiscal.fiscalStatus;
      (updateData as Record<string, unknown>).fiscalReason = fiscal.reason;
      (updateData as Record<string, unknown>).isNonFiscalDoc =
        fiscal.fiscalStatus === "NAO_FISCAL" || fiscal.fiscalStatus === "NAO_APLICAVEL";
      if (isExplicitReextract || hasAuthoritativeQr) {
        (updateData as Record<string, unknown>).fiscalStatusManualOverride = false;
      }
    }
    if (typeLocked) {
      delete (updateData as Record<string, unknown>).type;
      fields.hints = [...(fields.hints ?? []), `documentType:manual_override_kept:${doc.type}`];
    } else {
      if (fiscal.documentType) {
        updateData.type = fiscal.documentType as DocumentType;
      } else if (fields.documentType) {
        updateData.type = fields.documentType as DocumentType;
      } else if (hasAuthoritativeQr) {
        updateData.type = DocumentType.FATURA_RECEBIDA;
      }
      if (isExplicitReextract || hasAuthoritativeQr) {
        (updateData as Record<string, unknown>).typeManualOverride = false;
      }
    }
    const docNumberNorm = normalizeDocNumber(fields.docNumber);
    if (docNumberNorm) (updateData as Record<string, unknown>).docNumberNorm = docNumberNorm;
    fields.hints = [...(fields.hints ?? []), `fiscalStatus:${fiscal.fiscalStatus}:${fiscal.reason}`];

    // Duplicate by fiscal key (tenant + supplier NIF + normalised number
    // [+ ATCUD when both sides have one]). The partial unique index
    // documents_fiscal_key_unique is the race-proof backstop (P2002 below).
    let duplicateOfDoc: { id: string; fileName: string } | null = null;
    if ((fields.supplierNif && docNumberNorm) || fields.atcud) {
      duplicateOfDoc = await this.findFiscalKeyOriginal(
        tenantId,
        documentId,
        fields.supplierNif ?? null,
        docNumberNorm,
        fields.atcud ?? null,
        atcudTrusted,
      );
      if (duplicateOfDoc) {
        this.logger.warn(
          `[processDocumentAsync] document=${documentId} is a DUPLICATE of ${duplicateOfDoc.id} ` +
            `(${duplicateOfDoc.fileName}) by fiscal key nif=${fields.supplierNif} nr=${docNumberNorm}`,
        );
        fields.warnings = [...(fields.warnings ?? []), `duplicate_fiscal_key:${duplicateOfDoc.id}`];
      }
    }
    let ibanCheck: IbanCheckResult | null = null;

    if (fields.iban && doc.partyId) {
      ibanCheck = await this.checkIbanAgainstParty(
        tenantId,
        doc.partyId,
        fields.iban,
        userId,
        doc.iban,
      );
      if (ibanCheck.flagged) {
        updateData.party = undefined; // type narrowing — see below
      }
    }

    // ── Auto-resolve supplier (Party link/create) ──────────────────
    // Runs AFTER `updateData` is composed so the resolver result lands
    // in the same Document write below. Wrapped in try/catch — a DB
    // hiccup on the Party side must NEVER abort the extraction; the
    // helper already catches its own errors and returns
    // `{ party: null, supplierReview: true }` on failure. We capture
    // the result so `composeMetadata` can surface `supplierReview`
    // and a `supplierResolve` block for the audit trail.
    let supplierReviewFlag = false;
    let supplierResolveReason: string | undefined;
    if (resolvedPartyFromNif) {
      // NIF-resolve fallback already picked a trusted Party — wire it
      // directly and skip SupplierResolver (avoids creating a duplicate
      // row keyed on the swapped-out fields).
      updateData.party = { connect: { id: resolvedPartyFromNif.id } };
      if (resolvedPartyFromNif.name && (!updateData.supplier || !String(updateData.supplier).trim())) {
        updateData.supplier = resolvedPartyFromNif.name;
        fields.supplier = resolvedPartyFromNif.name;
      }
      supplierReviewFlag = false;
      supplierResolveReason = "party-resolved-by-nif";
    } else if (this.supplierResolver && !doc.partyId) {
      try {
        const aiConfidence = Number(
          (fields.hints ?? [])
            .find((h) => h.startsWith("aiConfidence:"))
            ?.split(":")[1],
        ) || undefined;
        const resolved = await this.supplierResolver.resolve({
          tenantId,
          country: fields.country,
          supplierName: fields.supplier,
          supplierNif: fields.supplierNif,
          supplierVatId: fields.supplierVatId,
          supplierAddress: fields.supplierAddress,
          supplierPostalCode: fields.supplierPostalCode,
          supplierCity: fields.supplierCity,
          supplierPhone: fields.supplierPhone,
          supplierEmail: fields.supplierEmail,
          supplierWebsite: fields.supplierWebsite,
          iban: fields.iban,
          aiConfidence: Number.isFinite(aiConfidence) ? aiConfidence : fields.confidence,
          suggestedCategory: fields.suggestedCategory,
        });
        if (resolved.party) {
          updateData.party = { connect: { id: resolved.party.id } };
          if (resolved.party.name && (!updateData.supplier || !String(updateData.supplier).trim())) {
            updateData.supplier = resolved.party.name;
            fields.supplier = resolved.party.name;
          }
          // For foreign EU suppliers, trigger VIES validateParty in background to ensure Party has official VIES data
          if (this.vies && (fields.country && fields.country !== 'PT' || fields.supplierVatId && !/^PT/i.test(fields.supplierVatId))) {
            this.vies.validateParty(tenantId, resolved.party.id).catch((viesErr) => {
              this.logger.warn(`[processDocumentAsync] background VIES validateParty failed: ${(viesErr as Error).message}`);
            });
          }
        }
        supplierReviewFlag = resolved.supplierReview;
        supplierResolveReason = resolved.reason;
      } catch (err) {
        // Belt + braces — SupplierResolver.resolve already catches its
        // own errors, but if anything inside the wrapping call itself
        // throws, we still don't want to lose the document row.
        this.logger.warn(
          `[processDocumentAsync] supplier-resolver threw for document=${documentId}: ${(err as Error).message}`,
        );
        supplierReviewFlag = true;
        supplierResolveReason = `resolve_threw:${(err as Error).message?.slice(0, 120)}`;
      }
    }

    // Se o documento estiver associado a um fornecedor, preencher campos em falta na ficha a partir da fatura
    const targetPartyId =
      (updateData.party as { connect?: { id?: string } } | undefined)?.connect?.id ??
      resolvedPartyFromNif?.id ??
      doc.partyId ??
      null;
    if (targetPartyId) {
      try {
        const existingParty = await this.prisma.party.findUnique({
          where: { id: targetPartyId },
          select: { name: true, address: true, city: true, postalCode: true, phone: true, email: true, website: true },
        });
        if (existingParty) {
          if (existingParty.name && (!updateData.supplier || !String(updateData.supplier).trim())) {
            updateData.supplier = existingParty.name;
            fields.supplier = existingParty.name;
          }
          const partyUpdates: Record<string, string> = {};
          if (
            (!existingParty.address || /^[-–—\s/.]+$/.test(existingParty.address.trim())) &&
            fields.supplierAddress
          ) {
            partyUpdates.address = sanitizeExtractedSupplierAddress(
              fields.supplierAddress,
              fields.supplierPostalCode,
              fields.supplierCity,
            );
          }
          if (!existingParty.city && fields.supplierCity) partyUpdates.city = fields.supplierCity;
          if (!existingParty.postalCode && fields.supplierPostalCode) partyUpdates.postalCode = fields.supplierPostalCode;
          if (!(existingParty as any).phone && fields.supplierPhone) partyUpdates.phone = fields.supplierPhone;
          if (!(existingParty as any).email && fields.supplierEmail) partyUpdates.email = fields.supplierEmail;
          if (!(existingParty as any).website && fields.supplierWebsite) partyUpdates.website = fields.supplierWebsite;
          if (Object.keys(partyUpdates).length > 0) {
            await this.prisma.party.update({
              where: { id: targetPartyId },
              data: partyUpdates,
            });
            this.logger.log(
              `[processDocumentAsync] updated party=${targetPartyId} with extracted fields: ${Object.keys(partyUpdates).join(', ')}`,
            );
          }
        }
      } catch (partyErr) {
        this.logger.warn(
          `[processDocumentAsync] failed to update party ${targetPartyId} fields: ${(partyErr as Error).message}`,
        );
      }
    }

    // ── Auto-file from AI category ──────────────────────────────────
    // When the AI supplied an SNC category AND a rules engine is wired
    // AND the AI actually produced this row's documentType / supplier
    // (so we have something to match against), re-run the folder-rules
    // engine with the category in the keyword bag. If the rules engine
    // matches a category-aware rule, the new folder wins; otherwise we
    // keep the upload-time suggestion untouched (rules remain the
    // fallback for documents the AI couldn't categorise).
    //
    // In the same branch we also resolve the AI's free-text
    // `suggestedCategory` onto a PT bucket (one of EXPENSE_CATEGORIES)
    // and stash it on `metadata.filing.expenseCategory` with source
    // 'ai'. The PATCH /documents/:id path remains the canonical way
    // for the user to override the AI pick (source='user'); see
    // DocumentsService.update.
    let aiFiledFolder: string | undefined;
    let aiFiledExpenseCategory: ExpenseCategory | null = null;
    if (
      fields.suggestedCategory &&
      (fields.source === "ai" || fields.source === "at_qr+ai")
    ) {
      // Resolve the AI suggestion onto one of the EXPENSE_CATEGORIES
      // slugs. mapToExpenseCategory returns null when nothing matches,
      // in which case we leave the filing untouched — the user can
      // still pick a category manually via PATCH.
      aiFiledExpenseCategory = mapToExpenseCategory(fields.suggestedCategory);
      if (aiFiledExpenseCategory) {
        this.logger.log(
          `[processDocumentAsync] AI-resolved expenseCategory for document=${documentId}: ` +
            `${fields.suggestedCategory} → ${aiFiledExpenseCategory}`,
        );
      }
    }
    if (
      fields.suggestedCategory &&
      (fields.source === "ai" || fields.source === "at_qr+ai") &&
      this.rulesEngine
    ) {
      try {
        const candidate = await this.rulesEngine.suggest(
          tenantId,
          {
            type: (fields.documentType ?? doc.type) as DocumentType,
            supplier: fields.supplier ?? doc.supplier,
            supplierNif: fields.supplierNif ?? doc.supplierNif,
            customer: fields.customer ?? doc.customer,
            suggestedCategory: fields.suggestedCategory,
          },
          loaded.pageCount ? new Date() : new Date(),
        );
        // Only override the upload-time suggestion when the engine
        // actually produced a different path — i.e. a rule matched the
        // AI category. Otherwise leave it alone so the existing folder
        // rule (if any) keeps working unchanged.
        if (candidate && candidate !== doc.suggestedFolder) {
          aiFiledFolder = candidate;
          updateData.suggestedFolder = candidate;
          updateData.finalFolder = candidate;
          fields.hints = [
            ...(fields.hints ?? []),
            `aiCategory:${fields.suggestedCategory}`,
            `aiFolder:${candidate}`,
          ];
        }
      } catch (err) {
        this.logger.warn(
          `AI-driven folder re-suggest failed for document=${documentId}: ` +
            `${(err as Error).message}`,
        );
      }
    }

    // ── STATUS DECISION ─────────────────────────────────────────
    // HARDENED 2026-09-01: previously when extraction produced no
    // useful fields (confidence < 0.4), the Document row stayed in
    // NOVO with NO status change, NO warning, and NO metadata marker
    // — operators could not tell whether extraction was still
    // running, had failed silently, or simply found nothing. We now
    // decide between EM_REVISAO (success-with-data) and EM_REVISAO
    // with a needs_review warning (extraction ran but produced no
    // signal). NOVO is reserved for the brief upload window before
    // extraction has run; once processDocumentAsync has written to
    // the row, the status MUST reflect that fact.
    const noSignal =
      fields.confidence < 0.4 &&
      !fields.supplier &&
      !fields.supplierNif &&
      !fields.docNumber &&
      (fields.total == null || fields.total === 0);
    let finalStatus: DocumentStatus;
    if (fields.confidence >= 0.4) {
      finalStatus = DocumentStatus.EM_REVISAO;
    } else if (noSignal) {
      // Extraction completed but produced no usable signal — flag the
      // document for manual review instead of leaving it silent at
      // NOVO. The UI surfaces needsReview from metadata.extraction and
      // status=EM_REVISAO with a flag is the convention.
      this.logger.warn(
        `[processDocumentAsync] document=${documentId} produced no signal ` +
          `(confidence=${fields.confidence}, source=${fields.source}, ` +
          `textSource=${loaded.source}, needsManualOcr=${loaded.needsManualOcr}). ` +
          `Writing needs_review marker.`,
      );
      // Make sure the operator sees the reason in metadata. The
      // composeMetadata path will write the warnings[] as-is.
      if (!(fields.warnings ?? []).some((w) =>
        ["no_signal_needs_review", "ai_all_providers_returned_null"].some((tag) =>
          w.includes(tag),
        ),
      )) {
        fields.warnings = [
          ...(fields.warnings ?? []),
          `no_signal_needs_review:conf=${fields.confidence},src=${fields.source}`,
        ];
      }
      finalStatus = DocumentStatus.EM_REVISAO;
    } else {
      // Low confidence but SOME signal (e.g. supplier name without a
      // total). Still flag for review but don't suppress the row.
      finalStatus = DocumentStatus.EM_REVISAO;
    }

    // ── Fase 4 — contravalor em EUR (BCE) ──────────────────────────
    if (fields.total != null && Number.isFinite(fields.total)) {
      const cur = (fields.currency || "EUR").toUpperCase();
      if (cur === "EUR") {
        (updateData as Record<string, unknown>).amountEur = fields.total;
      } else if (this.fx) {
        try {
          const fxDate = fields.docDate ?? new Date().toISOString().slice(0, 10);
          const conv = await this.fx.toEur(fields.total, cur, fxDate);
          if (conv) {
            (updateData as Record<string, unknown>).amountEur = conv.amountEur;
            (updateData as Record<string, unknown>).exchangeRate = conv.rate.rate;
            (updateData as Record<string, unknown>).exchangeRateDate = new Date(`${conv.rate.rateDate}T00:00:00Z`);
            fields.hints = [...(fields.hints ?? []), `fx:${cur}→EUR@${conv.rate.rate}(${conv.rate.rateDate})`];
          } else {
            fields.warnings = [...(fields.warnings ?? []), `fx_rate_unavailable:${cur}`];
          }
        } catch (err) {
          this.logger.warn(`[processDocumentAsync] FX conversion failed: ${(err as Error).message}`);
        }
      }
    }

    // ── Fase 4.1 (P1.3) — descontos e fecho dos totais ao cêntimo ────
    // Antes, um desconto aparecia como "diferença" e ficava gravado em
    // silêncio. Agora a conta é explícita — soma(linhas) − descontos +
    // IVA = total, com tolerância de 1 cêntimo — e quando não fecha o
    // documento vai para revisão com o motivo.
    const recon = reconcileTotals({
      lineItems: fields.lineItems,
      discountAmount: fields.discountAmount,
      // Fase 4.2 (P0.3) — "Pronto pago", "desconto financeiro",
      // "descuento", "DPP"... quando não há um valor em euros explícito
      // no cabeçalho, o desconto de pronto pagamento em percentagem é o
      // fallback. Sem isto, a SAMMIC (2% sobre 40,74 = 0,81€) aparecia
      // como uma diferença por explicar em vez de um desconto global.
      cashDiscountRate: fields.cashDiscountRate,
      taxAmount: fields.taxAmount,
      netAmount: fields.netAmount,
      total: fields.total,
    });
    fields.totalsReconciled = recon.reconciled;
    if (recon.discountAmount != null) {
      (updateData as Record<string, unknown>).discountAmount = recon.discountAmount;
    }
    (updateData as Record<string, unknown>).lineDiscountTotal = recon.lineDiscountTotal;
    (updateData as Record<string, unknown>).totalsReconciled = recon.reconciled;
    (updateData as Record<string, unknown>).totalsDelta = recon.delta;
    fields.hints = [...(fields.hints ?? []), `totals:${recon.reconciled ? "ok" : "mismatch"}:${recon.reason}`];
    if (!recon.reconciled && recon.delta != null) {
      fields.warnings = [...(fields.warnings ?? []), recon.reason];
      finalStatus = DocumentStatus.EM_REVISAO;
    }

    // ── Fase 4.1 (P1.2) — notas de crédito ───────────────────────────
    // Uma NC entra negativa no saldo do fornecedor e no IVA, e liga-se à
    // fatura que retifica. O valor impresso fica intacto em `total`.
    const effectiveType =
      ((updateData as Record<string, unknown>).type as DocumentType | undefined) ?? doc.type;
    const signed = signedAmounts(effectiveType, {
      total: fields.total ?? (doc.total != null ? Number(doc.total) : null),
      taxAmount: fields.taxAmount ?? (doc.taxAmount != null ? Number(doc.taxAmount) : null),
      netAmount: fields.netAmount ?? (doc.netAmount != null ? Number(doc.netAmount) : null),
    });
    (updateData as Record<string, unknown>).signedTotal = signed.signedTotal;
    (updateData as Record<string, unknown>).signedTaxAmount = signed.signedTaxAmount;
    (updateData as Record<string, unknown>).signedNetAmount = signed.signedNetAmount;

    // Fase 4.3 (P0.3) — uma Nota de Crédito tem de guardar total, base e IVA negativos
    if (effectiveType === "NOTA_CREDITO") {
      const curTotal = updateData.total != null ? Number(updateData.total) : doc.total != null ? Number(doc.total) : null;
      if (curTotal != null) updateData.total = -Math.abs(curTotal);
      const curNet = updateData.netAmount != null ? Number(updateData.netAmount) : doc.netAmount != null ? Number(doc.netAmount) : null;
      if (curNet != null) updateData.netAmount = -Math.abs(curNet);
      const curTax = updateData.taxAmount != null ? Number(updateData.taxAmount) : doc.taxAmount != null ? Number(doc.taxAmount) : null;
      if (curTax != null) updateData.taxAmount = -Math.abs(curTax);
      if ((updateData as Record<string, unknown>).amountEur != null) {
        (updateData as Record<string, unknown>).amountEur = -Math.abs(Number((updateData as Record<string, unknown>).amountEur));
      }
      (updateData as Record<string, unknown>).signedTotal = -Math.abs(Number(signed.signedTotal ?? curTotal ?? 0));
      (updateData as Record<string, unknown>).signedTaxAmount = -Math.abs(Number(signed.signedTaxAmount ?? curTax ?? 0));
      (updateData as Record<string, unknown>).signedNetAmount = -Math.abs(Number(signed.signedNetAmount ?? curNet ?? 0));
    }
    if (effectiveType === "NOTA_CREDITO" && fields.correctedDocumentNumber) {
      (updateData as Record<string, unknown>).correctedDocNumber = fields.correctedDocumentNumber;
      const original = await this.findCorrectedDocument(
        tenantId,
        documentId,
        fields.correctedDocumentNumber,
        taxIds.nif,
      );
      if (original) {
        // `Prisma.DocumentUpdateInput` é a variante *checked*: uma chave
        // estrangeira escreve-se pela relação, não pela coluna. Escrever
        // `correctedDocumentId` directamente rebentava a extração — e só
        // quando a fatura retificada era mesmo encontrada, que é o único
        // caso que interessa.
        updateData.correctedDocument = { connect: { id: original.id } };
        fields.hints = [...(fields.hints ?? []), `creditNote:corrects=${original.id}:${original.docNumber ?? "?"}`];
      } else {
        fields.hints = [
          ...(fields.hints ?? []),
          `creditNote:corrected_doc_not_found:${fields.correctedDocumentNumber}`,
        ];
      }
    }

    // ── Fase 4 — categoria automática por fornecedor ────────────────
    const linkedPartyId =
      (updateData.party as { connect?: { id?: string } } | undefined)?.connect?.id ?? doc.partyId ?? null;
    let categoryApplied = false;
    if (linkedPartyId) {
      const auto = await this.resolveAutoCategory(tenantId, linkedPartyId);
      if (auto) {
        updateData.expenseCategory = { connect: { id: auto.categoryId } };
        (updateData as Record<string, unknown>).categoryConfidence = auto.confidence;
        fields.hints = [...(fields.hints ?? []), `autoCategory:${auto.categoryId}:${auto.reason}`];
        // The review screen reads `metadata.filing.expenseCategory` (Category.name);
        // mirror the automatic choice there so the badge and IVA deduction follow.
        const catName = await this.categoryNameById(tenantId, auto.categoryId);
        if (catName && isExpenseCategory(catName)) aiFiledExpenseCategory = catName;
        categoryApplied = true;
      }
    }
    if (!categoryApplied && fields.suggestedCategory) {
      const matched = await this.matchCategoryBySuggestion(tenantId, fields.suggestedCategory);
      if (matched) {
        updateData.expenseCategory = { connect: { id: matched.id } };
        (updateData as Record<string, unknown>).categoryConfidence = 0.85;
        fields.hints = [...(fields.hints ?? []), `suggestedCategoryMatched:${matched.id}:${matched.name}`];
        if (isExpenseCategory(matched.name)) aiFiledExpenseCategory = matched.name as ExpenseCategory;
      }
    }

    if (!tenantIdentity) {
      try {
        tenantIdentity = await getTenantIdentity(this.prisma, tenantId);
      } catch (err) {
        this.logger.warn(
          `[processDocumentAsync] getTenantIdentity failed for tenant=${tenantId}: ${(err as Error).message}`,
        );
      }
    }

    // ── Validação Aritmética, Fiscal e Motor de Certainty Score (Fase 5) ──
    const certaintyResult = calculateCertaintyScore({
      netAmount: fields.netAmount,
      taxAmount: fields.taxAmount,
      total: fields.total,
      lineItems: fields.lineItems,
      taxRate: fields.taxRate,
      supplierNif: taxIds.nif ?? fields.supplierNif,
      supplierVatId: taxIds.vatId ?? fields.supplierVatId,
      customerNif: fields.customerNif,
      tenantNif: tenantIdentity?.tenantNif,
      tenantName: tenantIdentity?.tenantName,
      country: docCountry,
      viesValidated: viesValidatedForDoc,
      qrPayload: qrForFiscal ?? doc.qrPayload,
      qrOrigin: qrOriginForFiscal,
      atcud: atcudSan.atcud ?? fields.atcud,
      hash4: parsedForFiscal?.hash4,
      softwareCert: parsedForFiscal?.softwareCert,
      discountAmount: fields.discountAmount,
      cashDiscountRate: fields.cashDiscountRate,
      isIntracommunity: fields.isEuIntracommunity ?? doc.isIntracommunity,
    });

    fields.hints = [
      ...(fields.hints ?? []),
      `certaintyScore:${certaintyResult.score}%`,
      `certaintyLevel:${certaintyResult.level}`,
      ...(certaintyResult.tenantNifValidation
        ? [`tenantNifValidation:${certaintyResult.tenantNifValidation.status}`]
        : []),
    ];

    if (
      certaintyResult.needsReview ||
      (certaintyResult.tenantNifValidation && !certaintyResult.tenantNifValidation.isOfficialDocument)
    ) {
      finalStatus = DocumentStatus.EM_REVISAO;

      // Salvaguarda fiscal (art. 36.º CIVA): documento sem NIF da empresa adquirente
      // nunca pode ser gravado como documento fiscal oficial dedutível.
      if (certaintyResult.tenantNifValidation && !certaintyResult.tenantNifValidation.isOfficialDocument) {
        if (certaintyResult.tenantNifValidation.status === 'MISMATCH_THIRD_PARTY') {
          (updateData as Record<string, unknown>).fiscalStatus = 'NAO_FISCAL';
          (updateData as Record<string, unknown>).fiscalReason = certaintyResult.tenantNifValidation.warning;
          (updateData as Record<string, unknown>).isNonFiscalDoc = true;
        } else if (certaintyResult.tenantNifValidation.status === 'MISSING_NIF') {
          (updateData as Record<string, unknown>).fiscalStatus = 'DUVIDOSO';
          (updateData as Record<string, unknown>).fiscalReason = certaintyResult.tenantNifValidation.warning;
        }
      }

      const existingWarns = new Set(fields.warnings ?? []);
      for (const w of certaintyResult.warnings) {
        if (!existingWarns.has(w)) {
          fields.warnings = [...(fields.warnings ?? []), w];
          existingWarns.add(w);
        }
      }
    }

    const composeFinalMetadata = () =>
      this.composeMetadata(
        doc.metadata,
        fields,
        ibanCheck,
        undefined,
        loaded,
        { supplierReview: supplierReviewFlag, supplierReason: supplierResolveReason },
        aiFiledExpenseCategory,
        certaintyResult,
      );
    if (duplicateOfDoc) finalStatus = DocumentStatus.DUPLICADO;
    let updated;
    try {
      updated = await this.runFinalUpdate(
        documentId,
        {
          ...updateData,
          ...(duplicateOfDoc ? { duplicateOf: { connect: { id: duplicateOfDoc.id } } } : {}),
        },
        finalStatus,
        composeFinalMetadata,
        fields.confidence,
      );
    } catch (err) {
      // Race: two uploads of the same invoice extracted concurrently — the
      // partial unique index documents_fiscal_key_unique rejected this one.
      // Re-resolve the original and store this row as DUPLICADO instead of
      // failing the pipeline.
      const code = (err as { code?: string }).code;
      if (code !== "P2002" || duplicateOfDoc || !((fields.supplierNif && docNumberNorm) || fields.atcud)) throw err;
      const original = await this.findFiscalKeyOriginal(
        tenantId,
        documentId,
        fields.supplierNif ?? null,
        docNumberNorm,
        fields.atcud ?? null,
        atcudTrusted,
      );
      if (!original) throw err;
      this.logger.warn(
        `[processDocumentAsync] P2002 on fiscal key — document=${documentId} stored as DUPLICATE of ${original.id}`,
      );
      fields.warnings = [...(fields.warnings ?? []), `duplicate_fiscal_key:${original.id}`];
      duplicateOfDoc = original;
      finalStatus = DocumentStatus.DUPLICADO;
      updated = await this.runFinalUpdate(
        documentId,
        { ...updateData, duplicateOf: { connect: { id: original.id } } },
        finalStatus,
        composeFinalMetadata,
        fields.confidence,
      );
    }

    // Fase 4 — persist the AI-extracted line items as DocumentItem rows.
    // Without this, the "produtos comprados" feature (party-products.service)
    // and the manual line-item editor both stay empty forever — the AI's
    // lineItems only ever lived in metadata.extraction JSON. Idempotent
    // re-extraction: replace the set rather than append. Never throws —
    // a line-item write failure must not fail the extraction pipeline.
    await this.persistLineItems(documentId, fields.lineItems);

    // Post-extraction rename: swap the upload-time filename (e.g.
    // `image.jpg`, `<hash>.pdf`) for a human-friendly slug like
    // `AMERICO-ALVES_2026-07-31_FT-2026-1751.pdf`. We do this AFTER the
    // main write so the row has the freshly-extracted supplier /
    // docNumber / docDate. The rename is idempotent — if the fields
    // are missing or the slug already matches, this is a no-op.
    //
    // Wrapped in try/catch + log-only: a rename failure must NEVER
    // fail extraction. The user-visible slug is cosmetic; the row's
    // extracted fields (the real win) are already persisted above.
    if (this.documents) {
      try {
        const renamed = await this.documents.renameAfterExtraction(
          tenantId,
          documentId,
          {
            supplier: fields.supplier ?? null,
            docNumber: fields.docNumber ?? null,
            docDate: fields.docDate ? new Date(fields.docDate) : null,
          },
        );
        if (renamed) {
          // Re-read the row so the caller sees the new slug in the
          // returned document. Cheap — single-row, indexed lookup.
          const afterRename = await this.prisma.document.findFirst({
            where: { id: documentId, tenantId },
            select: { id: true, status: true, fileName: true },
          });
          if (afterRename) {
            // Sprint I: also publish when the rename path returns early,
            // using the post-rename row id so handleExtracted observes
            // the same document state we hand back to the caller.
            await this.publishExtracted(tenantId, documentId, userId, {
              ...fields,
              ibanCheck: ibanCheck ?? undefined,
            }, afterRename.id);
            return {
              queued: false,
              documentId,
              ok: true,
              source: fields.source,
              confidence: fields.confidence,
              ibanCheck: ibanCheck ?? undefined,
              fieldsPopulated: Object.keys(updateData),
              textSource: loaded.source,
              needsManualOcr: loaded.needsManualOcr,
              pageCount: loaded.pageCount,
              aiFiledFolder,
              suggestedCategory: fields.suggestedCategory,
              fileName: renamed,
              document: { id: afterRename.id, status: afterRename.status, fileName: afterRename.fileName },
            };
          }
        }
      } catch (err) {
        this.logger.warn(
          `[processDocumentAsync] rename hook threw for document=${documentId}: ` +
            `${(err as Error).message}`,
        );
      }
    }

    // ── Sprint I — publish `document.extracted` so the processing
    // pipeline's handleExtracted advances the doc from EXTRACTING →
    // ENRICHING. The publish is the critical missing link identified
    // by the Sprint I scout report: without it the pipeline stops at
    // EXTRACTING forever. Wrapped in try/catch so any adapter failure
    // (Redis down, adapter swallowed the publish) NEVER re-throws into
    // the extraction path — the row is already persisted at this
    // point, so the foregone enrichment is recoverable via the manual
    // "Re-extrair dados" button in the Party detail page.
    await this.publishExtracted(tenantId, documentId, userId, {
      ...fields,
      ibanCheck: ibanCheck ?? undefined,
    }, updated.id);

    return {
      queued: false,
      documentId,
      ok: true,
      source: fields.source,
      confidence: fields.confidence,
      ibanCheck: ibanCheck ?? undefined,
      fieldsPopulated: Object.keys(updateData),
      textSource: loaded.source,
      needsManualOcr: loaded.needsManualOcr,
      pageCount: loaded.pageCount,
      aiFiledFolder,
      suggestedCategory: fields.suggestedCategory,
      document: { id: updated.id, status: updated.status },
    };
    } catch (err) {
      // Top-level safety net: log the full error AND write a
      // needs_review marker to the Document so the row is never
      // left silently at NOVO.
      //
      // HARDENED 2026-09-01: previously this branch logged the error
      // but did NOT touch the Document row. The row stayed in NOVO
      // with NO audit trail (no metadata.extraction entry, no
      // warnings, no failureReason). Operators could not tell
      // whether extraction was still in flight, had crashed, or
      // simply found nothing. We now always:
      //   1) Log the full error + stack (operator visibility).
      //   2) Write a status=EM_REVISAO with a needs_review flag
      //      inside metadata.extraction so the row reflects that
      //      extraction DID run but errored out.
      //   3) Record the error reason in metadata.extraction.failureReason
      //      so it can be inspected from the UI without grepping logs.
      const reason = (err as Error).message?.slice(0, 200) ?? "unknown";
      this.logger.error(
        `[processDocumentAsync] FAILED for document=${documentId}. ` +
          `Reason: ${reason}`,
      );
      this.logger.error(
        `[processDocumentAsync] stack: ${(err as Error).stack ?? "(no stack)"}`,
      );
      try {
        await this.writeNeedsReviewMarker(
          documentId,
          `process_threw:${reason}`,
        );
      } catch (writeErr) {
        // Even the marker write failed (DB down, etc.) — log loudly
        // so the operator sees we have nothing on the row at all.
        this.logger.error(
          `[processDocumentAsync] marker write also FAILED for document=${documentId}: ` +
            `${(writeErr as Error).message}`,
        );
      }
      return {
        queued: false,
        documentId,
        ok: false,
        reason: `process_threw:${reason}`,
      };
    }
  }

  /**
   * Write a needs_review marker to the Document row. Used by the
   * top-level catch in `processDocumentAsync` to ensure that any
   * extraction error leaves a trace in the row — the operator can see
   * `status: EM_REVISAO`, `metadata.extraction.failureReason: "..."`,
   * and `metadata.extraction.needsReview: true` from the UI without
   * having to grep logs.
   *
   * Always attempts the write; never throws (the catch block has its
   * own error logging for the case where even THIS fails).
   */
  private async writeNeedsReviewMarker(
    documentId: string,
    reason: string,
  ): Promise<void> {
    const doc = await this.prisma.document.findFirst({
      where: { id: documentId },
      select: { id: true, metadata: true },
    });
    if (!doc) return;
    const baseMeta =
      doc.metadata && typeof doc.metadata === "object" && !Array.isArray(doc.metadata)
        ? (doc.metadata as Record<string, unknown>)
        : {};
    const extractionMeta =
      baseMeta.extraction && typeof baseMeta.extraction === "object" && !Array.isArray(baseMeta.extraction)
        ? (baseMeta.extraction as Record<string, unknown>)
        : {};
    const nextExtraction = {
      ...extractionMeta,
      source: "none",
      confidence: 0,
      needsReview: true,
      failureReason: reason.slice(0, 500),
      warnings: Array.from(
        new Set([
          ...((extractionMeta.warnings as string[] | undefined) ?? []),
          `extraction_error:${reason.slice(0, 120)}`,
        ]),
      ),
      hints: [
        ...((extractionMeta.hints as string[] | undefined) ?? []),
        `failureAt:${new Date().toISOString()}`,
      ],
    };
    await this.prisma.document.update({
      where: { id: documentId },
      data: {
        status: DocumentStatus.EM_REVISAO,
        metadata: {
          ...baseMeta,
          extraction: nextExtraction,
        } as Prisma.InputJsonValue,
      },
    });
    this.logger.warn(
      `[writeNeedsReviewMarker] wrote needs_review for document=${documentId} ` +
        `reason=${reason.slice(0, 100)}`,
    );
  }

  /**
   * Sprint I — publish `document.extracted` so the processing pipeline's
   * `handleExtracted` advances the doc from EXTRACTING → ENRICHING.
   *
   * Best-effort: any adapter failure is logged and swallowed so it
   * cannot fail the extraction path. The row is already persisted at
   * this point, so a missed publish can be compensated by the manual
   * "Re-extrair dados" button in the Party detail page or by a
   * future re-trigger via `POST /extraction/documents/:id/reprocess`.
   *
   * The shape mirrors the `DocumentExtractedEvent` documented in
   * `processing.service.ts:58-65` so the handler can map directly.
   */
  private async publishExtracted(
    tenantId: string,
    documentId: string,
    userId: string | null,
    fields: Record<string, unknown> & { ibanCheck?: unknown },
    persistedDocumentId: string,
  ): Promise<void> {
    if (!this.queueAdapter) {
      this.logger.warn(
        `[publishExtracted] no QueueAdapter wired for document=${documentId} ` +
          `— skipping publish; pipeline will stay at EXTRACTING ` +
          `(manual re-trigger required)`,
      );
      return;
    }
    try {
      await this.queueAdapter.publish("document.extracted", {
        topic: "document.extracted",
        documentId: persistedDocumentId,
        tenantId,
        userId,
        confidence:
          typeof fields.confidence === "number" ? fields.confidence : 0,
        source:
          typeof fields.source === "string"
            ? fields.source
            : "none",
        extractedFields: this.extractPublicFields(fields),
      });
      this.logger.log(
        `[publishExtracted] published document.extracted for ` +
          `document=${persistedDocumentId} tenant=${tenantId}`,
      );
    } catch (err) {
      this.logger.error(
        `[publishExtracted] publish FAILED for document=${persistedDocumentId}: ` +
          `${(err as Error).message}`,
      );
      // Do NOT re-throw: extraction is already persisted to disk.
    }
  }

  /**
   * Build a flat, JSON-safe payload of the extracted fields for the
   * pipeline event. Keeps the queue event small (no nested PdfParse
   * buffers / BigInt values). Mirrors the shape of DocumentExtractedEvent
   * in processing.service.ts:58-65.
   */
  private extractPublicFields(fields: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const allowed = [
      "supplier",
      "supplierNif",
      "supplierVatId",
      "customer",
      "customerNif",
      "docNumber",
      "atcud",
      "docDate",
      "dueDate",
      "total",
      "taxAmount",
      "netAmount",
      "iban",
      "currency",
      "country",
      "ibanCountry",
      "taxRate",
      "ivaBreakdown",
      "suggestedCategory",
      "cashDiscountRate",
      "discountAmount",
      "isEuIntracommunity",
      "documentLocale",
      "documentTitle",
      "correctedDocumentNumber",
      "totalsReconciled",
    ];
    for (const k of allowed) {
      const v = fields[k];
      if (v !== undefined && v !== null) out[k] = v;
    }
    return out;
  }

  /**
   * Manual trigger from POST /extraction/documents/:id — synchronous
   * path. Useful for tiny QR-only documents where async overhead is
   * wasteful, and for ad-hoc re-runs after metadata edits.
   */
  async triggerForDocument(
    tenantId: string,
    userId: string,
    documentId: string,
    options: { async?: boolean } = {},
  ): Promise<ExtractionJobResult> {
    if (options.async) {
      return this.enqueue({ tenantId, userId, documentId });
    }
    return this.processDocumentAsync({ tenantId, userId, documentId });
  }

  /**
   * Apply a raw AT-QR payload to a Document — populates the QR fields
   * directly (no OCR) and runs the IBAN check if a Party is linked.
   * Used by the scanner/camera workflow.
   */
  async applyAtQrPayload(
    tenantId: string,
    userId: string,
    documentId: string,
    qrText: string,
  ): Promise<ExtractionJobResult> {
    const trimmed = (qrText ?? "").replace(/\s+/g, "");
    const parsed = parseAtQr(trimmed);
    const validation = validateAtQr(parsed ?? ({} as AtQrParsed));
    if (!parsed) {
      throw new Error("QR Code AT inválido ou não reconhecido");
    }

    const doc = await this.prisma.document.findFirst({
      where: { id: documentId, tenantId },
    });
    if (!doc) throw new Error("Documento não encontrado");

    const fields = this.extractFromQr(trimmed, doc);
    const updateData = this.buildUpdateData(fields);
    let ibanCheck: IbanCheckResult | null = null;

    if (fields.iban && doc.partyId) {
      ibanCheck = await this.checkIbanAgainstParty(
        tenantId,
        doc.partyId,
        fields.iban,
        userId,
        doc.iban,
      );
    }

    const updated = await this.prisma.document.update({
      where: { id: documentId },
      data: {
        ...updateData,
        qrPayload: parsed.raw,
        metadata: this.composeMetadata(
          doc.metadata,
          fields,
          ibanCheck,
          validation,
        ),
        ocrConfidence: Math.max(fields.confidence, 0.95),
        status: "EM_REVISAO",
      },
    });

    // Post-extraction rename — same hook as processDocumentAsync. The
    // QR-only path always yields supplier/docNumber/docDate, so the
    // rename should succeed in nearly every call. Wrapped in try/catch
    // so a rename failure never breaks the QR scan response.
    if (this.documents) {
      try {
        const renamed = await this.documents.renameAfterExtraction(
          tenantId,
          documentId,
          {
            supplier: fields.supplier ?? null,
            docNumber: fields.docNumber ?? null,
            docDate: fields.docDate ? new Date(fields.docDate) : null,
          },
        );
        if (renamed) {
          return {
            queued: false,
            documentId,
            ok: validation.ok || validation.warnings.length === 0,
            source: "at_qr",
            confidence: 0.95,
            validation,
            ibanCheck: ibanCheck ?? undefined,
            fieldsPopulated: Object.keys(updateData),
            fileName: renamed,
            document: { id: updated.id, status: updated.status, fileName: renamed },
          };
        }
      } catch (err) {
        this.logger.warn(
          `[applyAtQrPayload] rename hook threw for document=${documentId}: ` +
            `${(err as Error).message}`,
        );
      }
    }

    return {
      queued: false,
      documentId,
      ok: validation.ok || validation.warnings.length === 0,
      source: "at_qr",
      confidence: 0.95,
      validation,
      ibanCheck: ibanCheck ?? undefined,
      fieldsPopulated: Object.keys(updateData),
      document: { id: updated.id, status: updated.status },
    };
  }

  // -------------------------------------------------------------------------
  // Field extraction
  // -------------------------------------------------------------------------

  /**
   * New routing entry point — replaces the previous
   * `extractWithOcrFallback` direct call from `processDocumentAsync`.
   *
   * Routing (the "best PDF + AI tools, not regex" requirement):
   *   1. AT-QR already won in `processDocumentAsync` — we never reach here
   *      with a QR payload.
   *   2. If a vision provider is configured AND we have a multimodal
   *      payload (PDF/image bytes OR substantial extracted text), call
   *      the LLM and MERGE its JSON with the regex output. AI wins on
   *      fields it is confident about (>= 0.6); regex fills gaps.
   *   3. Otherwise → run the existing regex path unchanged.
   *
   * Failure modes (all degrade to regex, never throw):
   *   - Vision disabled (no key)         → regex
   *   - Vision call timeout (>30s)       → regex + warning
   *   - Vision call error / bad JSON     → regex + warning
   *   - Storage unavailable              → regex on empty text + warning
   *
   * Recorded in `metadata.extraction`:
   *   - source: "ai" | "regex" | "ocr"
   *   - aiProvider: string | null (when source === "ai")
   *   - aiModel:    string | null
   *   - aiConfidence: number
   *   - aiMerge: { regexConfidence, aiConfidence, fieldsFromAi, fieldsFromRegex }
   */
  async runAiOrRegexPath(
    doc: { fileKey: string; mimeType: string; fileName: string },
    loaded: LoadedText,
    tenantId?: string,
    overrides?: { model?: string; provider?: string },
  ): Promise<ExtractedFields> {
    // Top-level safety net: a vision failure must NEVER abort the regex
    // extraction. This is the canary that fires whenever something in
    // tryVisionAnalysis / mergeVisionWithRegex throws unexpectedly — the
    // regex path runs unconditionally and returns.
    try {
      // 1) Try the AI provider first — when we have at least something to
      //    feed it AND a key is configured. Empty inputs still hit regex so
      //    the operator sees the same fields they did before.
      const visionResult = await this.tryVisionAnalysis(doc, loaded, tenantId, overrides);

      // 2) Always run regex in parallel-ish — it fills gaps the LLM missed.
      //    Cheap, deterministic, and stays in metadata so we can audit which
      //    fields came from which source.
      const regexFields = await this.extractWithOcrFallback(doc, loaded.text);

      if (!visionResult) {
        // No AI ran (no key, OR the call returned null because every
        // provider in the chain aborted / rate-limited / errored out).
        //
        // HARDENED 2026-09-01: previously this branch silently returned
        // the regex result, which on an image-only document with no
        // tesseract text was a `confidence < 0.4, source: 'regex', no
        // fields` record — that gets written to the Document row with
        // NO warnings and NO extraction_error marker, so the doc stays
        // silently at NOVO with no audit trail. We now detect this case
        // explicitly and emit an `ai_all_providers_failed` warning +
        // an explicit source='none' record so the operator can SEE the
        // difference between "vision succeeded with bad data" and
        // "vision never answered at all".
        if (loaded.source === "none" && !doc.mimeType.startsWith("text/")) {
          this.logger.warn(
            `[runAiOrRegexPath] AI vision returned null on image-only doc ` +
              `(${doc.fileName}, mime=${doc.mimeType}, textSource=${loaded.source}). ` +
              `All providers failed silently. Writing needs_review marker.`,
          );
          return {
            currency: "EUR",
            confidence: 0,
            source: "none",
            hints: [
              `textSource:${loaded.source}`,
              `mime:${doc.mimeType}`,
              `visionReturnedNull:true`,
            ],
            warnings: [
              "ai_all_providers_returned_null_on_image",
              "needs_manual_review_no_ai_or_ocr_text",
            ],
          };
        }
        // For non-image sources (PDFs with no text layer, empty file
        // names, etc.) — still surface a warning so the row is never
        // silent, even though regex may have caught something.
        const warnings = regexFields.warnings
          ? [...regexFields.warnings]
          : [];
        if (!warnings.includes("ai_all_providers_returned_null")) {
          warnings.push("ai_all_providers_returned_null");
        }
        return {
          ...regexFields,
          warnings,
        };
      }

      // ── IMAGE-ONLY HARD GUARD ─────────────────────────────────────
      // When the file is a real photo / scan (textSource === 'none' —
      // no PDF text layer AND tesseract returned nothing) AND the AI
      // vision path failed on all 3 retries (fallbackUsed === true),
      // we MUST NOT promote a regex pass into the result. The regex
      // would scan an empty string and emit nothing but noise; even
      // worse, the previous `mergeVisionWithRegex` would clamp
      // confidence to 0.39 and tag `source: 'regex'` on the row,
      // which the operator reads as "we got something". Instead we
      // return an empty record with source='none' and a clear
      // `ai_all_retries_failed_on_image_needs_review` warning — the
      // composeMetadata gate then surfaces `needsReview: true` and the
      // Document stays flagged for manual review. Same path applies to
      // images that DID yield some tesseract text (textSource === 'ocr'):
      // when AI failed too we still allow the OCR text into the regex
      // path because at least there's a real string to scan.
      if (
        visionResult.fallbackUsed &&
        loaded.source === "none" &&
        !doc.mimeType.startsWith("text/")
      ) {
        this.logger.warn(
          `[runAiOrRegexPath] AI failed (fallbackUsed=true) on image-only doc ` +
            `(${doc.fileName}, mime=${doc.mimeType}, textSource=${loaded.source}) ` +
            `after 3 retries. NOT falling back to regex — needs_review.`,
        );
        const empty: ExtractedFields = {
          currency: "EUR",
          confidence: 0,
          source: "none",
          hints: [
            `ai:${visionResult.provider}/${visionResult.model}`,
            `aiConfidence:${visionResult.confidence.toFixed(2)}`,
            `aiAllRetriesFailed:true`,
            `textSource:${loaded.source}`,
            `mime:${doc.mimeType}`,
          ],
          warnings: [
            "ai_all_retries_failed_on_image_needs_review",
            "vision_partial_no_regex_fallback_on_image",
          ],
        };
        if (typeof visionResult.extracted.atQrRaw === "string") {
          empty.hints!.push(`aiQrRaw:${visionResult.extracted.atQrRaw}`);
        }
        return empty;
      }

      // 3) Merge — AI wins on every field it returned with confidence ≥ 0.6;
      //    regex fills the gaps.
      const merged = this.mergeVisionWithRegex(visionResult, regexFields);

      // Stash the AI diagnostics in metadata so the operator can see what
      // happened even if they later reset the document fields.
      const aiHints: string[] = [
        `ai:${visionResult.provider}/${visionResult.model}`,
        `aiConfidence:${visionResult.confidence.toFixed(2)}`,
      ];
      // Surface the AI-returned AT-QR payload (if any) as a hint so
      // processDocumentAsync can re-route the document through the
      // QR-authoritative merge path. Stays harmless when the AI
      // didn't emit one — findAtQrInText returns null and we skip.
      const aiQrRaw = visionResult.extracted.atQrRaw;
      if (typeof aiQrRaw === "string" && aiQrRaw.length > 0) {
        aiHints.push(`aiQrRaw:${aiQrRaw}`);
      }
      merged.hints = [...(merged.hints ?? []), ...aiHints];
      if (visionResult.fallbackUsed) {
        merged.warnings = [
          ...(merged.warnings ?? []),
          'ai_partial_response_used_regex_fallback',
        ];
      }
      return merged;
    } catch (err) {
      // Catch-all so a vision merge bug, a regex bug, or a structural
      // issue inside this function can NEVER leave a Document in NOVO.
      this.logger.error(
        `[runAiOrRegexPath] unexpected throw — falling back to regex. ` +
          `Reason: ${(err as Error).message}`,
      );
      this.logger.error(
        `[runAiOrRegexPath] stack: ${(err as Error).stack ?? "(no stack)"}`,
      );
      try {
        return await this.extractWithOcrFallback(doc, loaded.text);
      } catch (innerErr) {
        // Last-ditch: regex itself blew up (e.g. text was undefined and
        // a code path used .match on it). Return an empty record so
        // the caller can still emit "fields not populated" metadata
        // instead of an unhandled rejection.
        this.logger.error(
          `[runAiOrRegexPath] regex fallback ALSO threw: ${(innerErr as Error).message}. ` +
            `Returning empty record so the Document update can proceed.`,
        );
        return {
          currency: "EUR",
          confidence: 0,
          source: "regex",
          hints: [`fallback:${(innerErr as Error).message?.slice(0, 80)}`],
          warnings: [`fallback_threw:${(innerErr as Error).message?.slice(0, 80)}`],
        };
      }
    }
  }

  /**
   * Invoke the vision service with a hard timeout. Returns the result on
   * success or `null` on any failure / timeout. NEVER throws.
   *
   * Routing for the multimodal payload (in priority order):
   *   1. image/* mimetype → re-read bytes → base64 + image mime. Gemini
   *      reads images natively and far better than tesseract — phones
   *      and scanners should NEVER go through OCR when a vision key
   *      is present.
   *   2. PDF with text layer (loaded.source === 'pdf-text') → re-read the
   *      PDF bytes and send them as application/pdf. The text layer is
   *      also passed alongside as `text` so the model can cross-check.
   *   3. PDF without a text layer (loaded.source === 'none' and
   *      loaded.needsManualOcr === true — i.e. a scanned / image-only
   *      PDF) → rasterise page 1 to PNG via pdf-parse's getScreenshot()
   *      and send THAT image. Gemini can't OCR a raw image-only PDF
   *      as text, but it reads a rasterised page image well.
   *   4. Anything else (no storage, failed read, no text) → text-only
   *      prompt. Falls back to regex via the caller.
   *
   * Vision failure / timeout (capped at 30s) is non-fatal — the caller
   * still runs the regex path and the Document moves to EM_REVISAO.
   */
  private async tryVisionAnalysis(
    doc: { fileKey: string; mimeType: string; fileName: string },
    loaded: LoadedText,
    tenantId?: string,
    overrides?: { model?: string; provider?: string },
  ): Promise<import("../ai/vision.service").VisionAnalysisResult | null> {
    // Defensive: `this.vision` may be undefined when the AI module is
    // not wired (e.g. unit tests, or a future code-path that bypasses
    // AiModule). Use optional chaining — never throw a TypeError that
    // the caller would have to dig through stack traces to diagnose.
    if (!this.vision?.liveProviderAvailable && !this.zerox?.isAvailable()) {
      return null;
    }
    try {
      // Build the multimodal payload: image bytes for photos/scans,
      // PDF bytes for digital PDFs, or a rasterised page PNG for
      // image-only PDFs (the #1 reading gap before this fix).
      let fileBase64: string | undefined;
      let mimeType: string | undefined;
      let payloadNote = "text-only";
      if (this.storage) {
        try {
          // 1) Image uploads — phone photos, scanner output, screenshots.
          if (/^image\//i.test(doc.mimeType)) {
            const obj = await this.storage.getBuffer(doc.fileKey);
            fileBase64 = obj.buffer.toString("base64");
            mimeType = obj.contentType ?? doc.mimeType;
            payloadNote = `image:${mimeType}`;
          } else if (/^application\/pdf/i.test(doc.mimeType)) {
            // 2) PDF with a text layer — send raw bytes; Gemini reads
            //    application/pdf inline parts directly.
            // 3) PDF without a text layer (scanned / image-only) —
            //    rasterise the first page to PNG and send THAT.
            const obj = await this.storage.getBuffer(doc.fileKey);
            if (loaded.source === "pdf-text") {
              fileBase64 = obj.buffer.toString("base64");
              mimeType = obj.contentType ?? "application/pdf";
              payloadNote = "pdf:application/pdf";
            } else if (
              loaded.source === "none" &&
              loaded.needsManualOcr
            ) {
              try {
                const png = await this.rasterizeFirstPage(
                  obj.buffer,
                  doc.fileName,
                );
                fileBase64 = png.toString("base64");
                mimeType = "image/png";
                payloadNote = "pdf:image/png(rasterised)";
              } catch (rasterErr) {
                this.logger.warn(
                  `vision: PDF rasterisation failed for ${doc.fileName}: ` +
                    `${(rasterErr as Error).message}. ` +
                    `Falling back to sending the raw PDF bytes — ` +
                    `Gemini may still extract useful fields from an image-only PDF.`,
                );
                fileBase64 = obj.buffer.toString("base64");
                mimeType = "application/pdf";
                payloadNote = "pdf:application/pdf(fallback)";
              }
            }
          }
        } catch (err) {
          this.logger.warn(
            `vision: could not re-read file for vision analysis (${doc.fileName}): ` +
              `${(err as Error).message}. Falling back to text-only prompt.`,
          );
        }
      }
      this.logger.debug(
        `vision: routing doc=${doc.fileName} mime=${doc.mimeType} ` +
          `textSource=${loaded.source} needsManualOcr=${loaded.needsManualOcr} → ${payloadNote}`,
      );
      // Downscale large image copies for the vision API. Real phone
      // photos (2.6 MB / 3000×4000) blow out the prompt-token budget
      // and routinely trigger output-token-cap truncation — the model
      // returns a partial JSON, the merge logic invents numbers from
      // the garbage (the `total: 31082026` bug from a date string on a
      // 2.6 MB Américo Alves photo). Capping at 2000px shrinks the
      // payload ~5× without losing any text the model needs to read.
      // PDFs already go through `rasterizeFirstPage`; only `image/*`
      // uploads need this step.
      if (fileBase64 && mimeType && /^image\//i.test(mimeType)) {
        const downscaled = await this.downscaleForVision(fileBase64, mimeType);
        if (downscaled.base64 !== fileBase64) {
          this.logger.debug(
            `vision: downscaled ${doc.fileName} for vision API ` +
              `(mime=${mimeType} → ${downscaled.mime})`,
          );
        }
        fileBase64 = downscaled.base64;
        mimeType = downscaled.mime;
      }
      // 30s hard cap per upstream call. The retry-once path inside
      // `vision.analyze()` is a SEPARATE call (its own 30s); the
      // escalation to gemini-2.5-pro is also a separate call (its
      // own 50s). The overall analyze() ceiling is the SUM of those
      // — ~110s in the worst case — but a flaky upstream never blocks
      // one call longer than 30s.
      // Zerox integration: if provider override is zerox, or as high-res markdown table extractor
      if (overrides?.provider === "zerox" && this.zerox?.isAvailable()) {
        const zBuffer = fileBase64 ? Buffer.from(fileBase64, "base64") : undefined;
        if (zBuffer) {
          const zRes = await this.tryZeroxAnalysis(doc, zBuffer, overrides);
          if (zRes) return zRes;
        }
      }

      const visionResult = this.vision?.liveProviderAvailable ? await this.vision.analyze({
        fileBase64,
        mimeType,
        text: loaded.text || undefined,
        fileName: doc.fileName,
        documentContext: "invoice",
        timeoutMs: 30_000,
        tenantId: tenantId,
        preferredProvider: (overrides?.provider as any) ?? "auto",
        modelOverride: overrides?.model,
      }) : null;
      // Sidecar — capture the raw extracted payload so
      // `mergeQrWithAi` can pull supplier / IBAN / lineItems out of
      // a partial AI response (where `mergeVisionWithRegex` gated
      // out the numeric fields but the supplier name is still
      // trustworthy). Reset in `mergeQrWithAi` before each call so
      // a stale value from a prior document can't leak across.
      if (visionResult) {
        this.lastVisionExtracted = visionResult.extracted;
        this.lastAiExtraction = {
          provider: visionResult.provider,
          model: visionResult.model,
          processingTimeMs: visionResult.processingTimeMs,
          tokens: {
            prompt: visionResult.tokensIn ?? 0,
            completion: visionResult.tokensOut ?? 0,
            total: (visionResult.tokensIn ?? 0) + (visionResult.tokensOut ?? 0),
          },
          tokensIn: visionResult.tokensIn ?? 0,
          tokensOut: visionResult.tokensOut ?? 0,
          estimatedCostEur: visionResult.estimatedCostEur ?? 0,
          confidence: visionResult.confidence,
          fallbackUsed: visionResult.fallbackUsed,
          timestamp: new Date().toISOString(),
        };
      }
      return visionResult;
    } catch (err) {
      this.logger.warn(
        `vision: unexpected error calling provider: ${(err as Error).message}. ` +
          `Falling back to regex.`,
      );
      this.logger.debug(
        `vision: stack: ${(err as Error).stack ?? "(no stack)"}`,
      );
      return null;
    }
  }

  /**
   * Process document using Zerox to split high-resolution PDFs and photos,
   * returning structured Markdown and extracted invoice fields.
   */
  async tryZeroxAnalysis(
    doc: { fileKey: string; mimeType: string; fileName: string },
    buffer: Buffer,
    overrides?: { model?: string; provider?: string },
  ): Promise<import("../ai/vision.service").VisionAnalysisResult | null> {
    if (!this.zerox?.isAvailable()) return null;
    try {
      this.logger.log(`[tryZeroxAnalysis] Processing ${doc.fileName} with zerox`);
      const res = await this.zerox.processDocument({
        buffer,
        mimeType: doc.mimeType,
        fileName: doc.fileName,
        preferredProvider: (overrides?.provider as any) ?? "auto",
        modelOverride: overrides?.model,
      });
      if (res.success) {
        const visionRes: import("../ai/vision.service").VisionAnalysisResult = {
          provider: "zerox",
          model: res.model,
          confidence: res.extracted.confidence,
          extracted: res.visionExtracted,
          rawResponse: res.markdown,
          processingTimeMs: res.completionTimeMs,
          fallbackUsed: false,
          tokensIn: res.inputTokens,
          tokensOut: res.outputTokens,
        };
        this.lastVisionExtracted = res.visionExtracted;
        this.lastAiExtraction = {
          provider: "zerox",
          model: res.model,
          processingTimeMs: res.completionTimeMs,
          tokens: {
            prompt: res.inputTokens,
            completion: res.outputTokens,
            total: res.inputTokens + res.outputTokens,
          },
          tokensIn: res.inputTokens,
          tokensOut: res.outputTokens,
          estimatedCostEur: 0,
          confidence: res.extracted.confidence,
          fallbackUsed: false,
          timestamp: new Date().toISOString(),
        };
        return visionRes;
      }
    } catch (err) {
      this.logger.warn(`[tryZeroxAnalysis] error: ${(err as Error).message}`);
    }
    return null;
  }

  /**
   * Rasterise the first page of a PDF to a PNG buffer. Used by
   * `tryVisionAnalysis` when the PDF has no text layer (scanned /
   * image-only PDF) and we want to feed the page as an image to Gemini.
   *
   * Uses pdf-parse 2.x's `getScreenshot()` API (which wraps pdfjs-dist's
   * page renderer). On any failure the caller falls back to sending
   * the raw PDF bytes — Gemini may still extract useful fields from an
   * image-only PDF inline.
   */
  /**
   * Fase 2 — rasterise page 1 (and the last page when the document has
   * more than one) and try the AT-QR decoder cascade on each. Returns the
   * validated payload or null. Kept separate from `rasterizeFirstPage()`
   * because it needs page selection and a higher scale (QR modules must be
   * ≥ 3 px to decode reliably; scale 2 on A4 gives ~1190 px width).
   */
  async decodeQrFromPdfRaster(
    doc: { fileKey: string; fileName: string },
    pageCount?: number,
  ): Promise<string | null> {
    if (!this.storage) return null;
    const obj = await this.storage.getBuffer(doc.fileKey);
    // Scale 2 (~1190 px on A4) decodes most; scale 3 recovered a
    // vector-drawn QR that scale 2 missed (Fase 2 benchmark, Miranda 6384).
    // Order: page 1 @2 → last page @2 → page 1 @3 (the @3 pass is the
    // slowest, so it runs only after the cheap ones failed).
    const attempts: Array<{ pageNo: number; scale: number }> = [{ pageNo: 1, scale: 2 }];
    if (pageCount && pageCount > 1) attempts.push({ pageNo: pageCount, scale: 2 });
    attempts.push({ pageNo: 1, scale: 3 });
    for (const { pageNo, scale } of attempts) {
      const parser = new PDFParse({ data: obj.buffer });
      let png: Buffer | null = null;
      try {
        const shot = await parser.getScreenshot({
          partial: [pageNo],
          scale,
          imageBuffer: true,
        });
        const page = shot?.pages?.[0];
        if (page?.data) png = Buffer.from(page.data);
      } finally {
        try {
          await parser.destroy?.();
        } catch {
          /* ignore */
        }
      }
      if (!png) continue;
      const raw = await decodeAtQr(png, "image/png", this.logger);
      const validated = raw ? this.findAtQrInText(raw) : null;
      if (validated) return validated;
    }
    return null;
  }

  private async rasterizeFirstPage(
    buffer: Buffer,
    fileName: string,
  ): Promise<Buffer> {
    const parser = new PDFParse({ data: buffer });
    try {
      // Scale 2.0 → ~144 DPI, plenty for OCR-quality text recognition
      // without blowing up payload size (typical A4 page ≈ 1650×2339).
      const screenshot = await parser.getScreenshot({
        first: 1,
        scale: 2,
        imageBuffer: true,
      });
      const page = screenshot?.pages?.[0];
      if (!page?.data) {
        throw new Error("pdf-parse returned no page data");
      }
      return Buffer.from(page.data);
    } finally {
      try {
        await parser.destroy?.();
      } catch {
        /* ignore — pdf-parse may already be torn down */
      }
    }
  }

  /**
   * Downscale an image payload to cap the longest side at `maxLongSidePx`
   * (default 1500px) and re-encode as JPEG quality 80. Returns
   * `{ base64, mime }` — the original bytes (kept on disk / in S3 / on the
   * Document row) are NOT touched. This is the copy sent to the vision
   * provider.
   *
   * Why: a 2.6 MB phone photo ballooned into ~7k prompt tokens at the
   * OpenRouter/Gemini 2.5 Flash endpoint — the JSON response truncated
   * mid-array, the AI returned a partial payload, and the regex/merge
   * step invented totals from the garbage (`total: 31082026` from the
   * OCR'd date "31/08/2026"). Capping at 1500px keeps the QR + printed
   * fields legibly readable for the model while shrinking the prompt by
   * ~7× and dramatically reducing the truncation failure rate.
   *
   * The 1500px cap (down from 2000) was chosen after 2026-09-01
   * acceptance testing showed 2/3 of gemini-2.5-flash responses
   * truncated on a 2.6 MB Américo Alves phone photo. Below 1500px the
   * QR modules stay legible to the model; below that, they smear.
   *
   * Resilience: uses jimp for image downscale. On any failure the helper
   * returns the ORIGINAL base64 + mime so the caller still has something
   * to send. Failure is logged at warn level; vision failures downstream
   * are non-fatal.
   */
  private async downscaleForVision(
    fileBase64: string,
    mimeType: string,
    maxLongSidePx = 1500,
    jpegQuality = 80,
  ): Promise<{ base64: string; mime: string }> {
    if (!/^image\//i.test(mimeType)) {
      // PDF downscaling is handled by `rasterizeFirstPage`. SVG / BMP /
      // other formats are uncommon on this path; skip them.
      return { base64: fileBase64, mime: mimeType };
    }
    try {
      // Runtime require to dodge a phantom-default-export type issue
      // (jimp 1.x's TS types are pinned to an older shape and a plain
      // `import { Jimp } from "jimp"` produces a phantom default export
      // that breaks at runtime).
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const jimpMod = require("jimp") as { Jimp: { read: (b: Buffer) => Promise<unknown> } };
      const Jimp = jimpMod.Jimp;
      const buf = Buffer.from(fileBase64, "base64");
      const img = (await Jimp.read(buf)) as {
        bitmap: { width: number; height: number };
        scaleToFit: (opts: { w: number; h: number }) => {
          bitmap: { width: number; height: number; data: Buffer };
          getBuffer: (mime: string, opts?: Record<string, unknown>) => Promise<Buffer>;
        };
      };
      const { width, height } = img.bitmap;
      if (width <= maxLongSidePx && height <= maxLongSidePx) {
        // Already small enough — keep the original bytes verbatim so we
        // don't lose any quality on a phone screenshot that's already
        // under the cap.
        return { base64: fileBase64, mime: mimeType };
      }
      const scaled = img.scaleToFit({ w: maxLongSidePx, h: maxLongSidePx });
      // Re-encode as JPEG quality 80 (down from 85) — smaller payload
      // with no visible loss of OCR-relevant detail. The model doesn't
      // care about the exact codec — what matters is that the file is
      // smaller and that any artefacts from the re-encode are bounded.
      // 80 is the sweet spot for document photos (above ~90 the file
      // size balloons, below ~70 the QR modules start to smear).
      const outMime = mimeType === "image/png" ? "image/png" : "image/jpeg";
      const outBuf: Buffer = await scaled.getBuffer(
        outMime === "image/png" ? "image/png" : "image/jpeg",
        outMime === "image/jpeg" ? { quality: jpegQuality } : undefined,
      );
      return { base64: outBuf.toString("base64"), mime: outMime };
    } catch (err) {
      this.logger.warn(
        `vision: image downscaling failed (${mimeType}): ${(err as Error).message}. ` +
          `Sending the original bytes — Gemini may still extract useful fields.`,
      );
      return { base64: fileBase64, mime: mimeType };
    }
  }

  /**
   * Merge the vision service's structured output into the regex-extracted
   * fields. AI wins on every field it returned with confidence ≥ 0.6;
   * regex fills the gaps. The merged result also carries provenance so
   * the operator can tell which source supplied each field.
   *
   * Critical: when `vision.fallbackUsed === true` (the AI call returned
   * truncated / unparseable JSON — `normalizeExtractedFields` may still
   * have produced a partial `extracted.total` from the garbage, e.g.
   * `31082026` from a date string in a 2.6 MB phone photo), we MUST NOT
   * trust the AI numeric fields. The most likely behaviour of writing
   * `merged.total = 31082026` here is to invent a confidently-wrong
   * fiscal total. We still surface the AI's `atQrRaw` (re-parsed
   * downstream by `extractFromQr` via the processDocumentAsync branch)
   * and the diagnostic hints, but every numeric / string field that the
   * AI produced from broken JSON stays out of the merged result.
   */
    /**
   * POST-PROCESS SAFETY NET — the deterministic fallback that
   * guarantees supplier != our own company even when the AI guesses
   * wrong. Mirrors the proven pattern from the user's reference app
   * (`gemini-documental/apps/api/src/app.service.ts`).
   *
   * Inputs:
   *   - `tenantId` — the current tenant; used to fetch the tenant's
   *     own NIF (which is the buyer's NIF).
   *   - `fields`   — the merged extraction result (from QR / AI / regex).
   *   - `qrPayloadOverride` — the AT-QR payload string the AI just
   *     returned (or undefined). When present, field `A:` (issuer NIF)
   *     is authoritative for supplier — use it instead of comparing
   *     to the tenant NIF.
   *
   * Algorithm (deterministic, never throws):
   *   1. Resolve the tenant NIF (DB / env / hard-coded demo fallback).
   *   2. Resolve the "authoritative supplier NIF" — prefer QR field A,
   *      fall back to AI/regex supplierNif.
   *   3. If the authoritative supplier NIF equals the tenant NIF, the
   *      AI got it wrong — swap supplier ↔ customer (NIF, name, vatId).
   *      Add a `partySwap` hint so the operator sees the correction.
   *   4. If the supplier NAME matches the tenant name (and the names
   *      are non-trivial — at least 5 chars of overlap), swap too.
   *      This catches the case where both NIFs are present but the
   *      AI put the wrong name in the wrong slot.
   *   5. If neither swap applies, return the fields untouched.
   *
   * Returns the (possibly modified) `ExtractedFields`.
   */
  private async ensureSupplierCustomerSanity(
    tenantId: string,
    fields: ExtractedFields,
    qrPayloadOverride?: string,
    fileName?: string,
  ): Promise<ExtractedFields> {
    try {
      const id = await getTenantIdentity(this.prisma, tenantId);
      const tenantNif = normalizeTenantNif(id.tenantNif);
      if (!tenantNif) return fields;

      // Authoritative supplier NIF — prefer QR `A:` field. When present
      // and not a "final consumer" placeholder, it is THE source of truth.
      // Also extract the QR's B: (buyer NIF) — when it matches the tenant
      // NIF, the AI must put the buyer in the CUSTOMER slot (not supplier).
      let authoritativeSupplierNif: string | undefined;
      let authoritativeBuyerNif: string | undefined;
      const qrStr =
        qrPayloadOverride ??
        fields.hints
          ?.find((h) => h.startsWith("aiQrRaw:"))
          ?.split(":")
          .slice(1)
          .join(":") ??
        undefined;
      if (qrStr) {
        const qrSupplierMatch = qrStr.match(/(?:^|\*)A:(\d+)/);
        if (qrSupplierMatch && qrSupplierMatch[1]) {
          authoritativeSupplierNif = normalizeTenantNif(qrSupplierMatch[1]);
        }
        const qrBuyerMatch = qrStr.match(/(?:^|\*)B:(\d+)/);
        if (qrBuyerMatch && qrBuyerMatch[1]) {
          const buyer = normalizeTenantNif(qrBuyerMatch[1]);
          // Skip the QR-spec "final consumer" placeholder (`999999990`)
          // so the safety net doesn't trip on retail invoices.
          if (buyer !== "999999990" && buyer.length === 9) {
            authoritativeBuyerNif = buyer;
          }
        }
      }
      authoritativeSupplierNif =
        authoritativeSupplierNif ?? normalizeTenantNif(fields.supplierNif);

      // ── SWAP CONDITION 1: authoritative supplier NIF == tenant NIF
      // The model put us as the supplier — swap. Only when there's
      // actually something in the customer slot to swap into.
      const customerNif = normalizeTenantNif(fields.customerNif);
      const hasCustomerData =
        !!fields.customer || customerNif.length > 0;
      const tenantName = (id.tenantName ?? "").toLowerCase().trim();
      const supplierName = (fields.supplier ?? "").toLowerCase().trim();
      const customerName = (fields.customer ?? "").toLowerCase().trim();
      const supplierNifNorm = normalizeTenantNif(fields.supplierNif);

      const customerMatchesTenant =
        tenantName.length >= 5 &&
        customerName.length >= 5 &&
        (tenantName === customerName ||
          (tenantName.includes(customerName) && customerName.length >= 8) ||
          (customerName.includes(tenantName) && tenantName.length >= 8));

      const supplierMatchesTenant =
        tenantName.length >= 5 &&
        supplierName.length >= 5 &&
        (tenantName === supplierName ||
          (tenantName.includes(supplierName) && supplierName.length >= 8) ||
          (supplierName.includes(tenantName) && tenantName.length >= 8));

      // ── Fase 4.2 (P0.1) — nome de um bloco colado ao NIF de outro ────
      // Bug real: ONNERA/Edenox (fatura espanhola) ficou com
      // supplier="NOV OUSADO LDA" (o NOSSO nome — o comprador) e
      // supplierNif="ESA14219836" (o CIF real do vendedor). Nenhuma
      // das condições de swap abaixo dispara porque `hasCustomerData`
      // é falso — a IA nem sequer devolveu um bloco de cliente
      // distinto, por isso não há para onde "trocar". A IA colou o
      // nome do bloco do destinatário ao número do bloco do emitente.
      //
      // Regra determinística: o nosso nome NUNCA é o do fornecedor.
      // Quando o nome do fornecedor bate com o nosso e não há dados
      // de cliente para trocar, o nome está errado por definição —
      // descartamo-lo. O NIF só sobrevive se for demonstravelmente de
      // outra entidade (diferente do nosso); caso contrário também é
      // descartado. Nunca inventamos um par nome+NIF — o que não
      // pertence comprovadamente ao mesmo bloco fica por confirmar.
      if (
        !hasCustomerData &&
        tenantName.length >= 5 &&
        supplierName.length >= 5 &&
        (tenantName === supplierName ||
          (tenantName.includes(supplierName) && supplierName.length >= 8) ||
          (supplierName.includes(tenantName) && tenantName.length >= 8))
      ) {
        const nifIsOurs = supplierNifNorm === tenantNif || authoritativeSupplierNif === tenantNif;
        this.logger.warn(
          `[ensureSupplierCustomerSanity] supplier name "${fields.supplier}" matches ` +
            `tenant name but no customer block was extracted — nome de um bloco colado ` +
            `ao NIF de outro. Descartando o nome (nunca somos o fornecedor)` +
            (nifIsOurs ? ` e o NIF (também é o nosso).` : `; mantendo o NIF "${fields.supplierNif}" para reresolução.`),
        );
        const fixed: ExtractedFields = {
          ...fields,
          supplier: undefined,
          supplierNif: nifIsOurs ? undefined : fields.supplierNif,
          supplierVatId: nifIsOurs ? undefined : fields.supplierVatId,
        };
        fixed.hints = [
          ...(fixed.hints ?? []),
          `partySwap:name_nif_mismatch_discarded`,
          `partySwap:reason=supplier_name_eq_tenant_no_customer_block`,
        ];
        return fixed;
      }

      // ── Fase 4.3 (P0.6) — ONNERA/Edenox: customer is ALREADY the tenant!
      // If customer is already the tenant name, NEVER swap customer into supplier.
      // That would make our tenant the supplier! Keep the supplier name intact.
      if (
        authoritativeSupplierNif &&
        authoritativeSupplierNif === tenantNif &&
        customerMatchesTenant
      ) {
        this.logger.warn(
          `[ensureSupplierCustomerSanity] tenant NIF (${formatPtNif(tenantNif)}) was in supplierNif, ` +
            `but customer "${fields.customer}" is ALREADY tenant — preserving supplier "${fields.supplier}" ` +
            `and moving tenant NIF to customerNif.`,
        );
        const fixed: ExtractedFields = {
          ...fields,
          customerNif: tenantNif,
          supplierNif: supplierNifNorm === tenantNif ? undefined : fields.supplierNif,
        };
        fixed.hints = [
          ...(fixed.hints ?? []),
          `partySwap:retained_supplier_customer_already_tenant`,
          `partySwap:reason=customer_matches_tenant_name`,
        ];
        return fixed;
      }

      if (
        authoritativeSupplierNif &&
        authoritativeSupplierNif === tenantNif &&
        hasCustomerData &&
        !customerMatchesTenant &&
        (supplierMatchesTenant || (customerNif && customerNif !== tenantNif))
      ) {
        this.logger.warn(
          `[ensureSupplierCustomerSanity] supplier NIF matches tenant NIF ` +
            `(${formatPtNif(tenantNif)}) — swapping supplier/customer. ` +
            `document had supplier="${fields.supplier ?? "?"}" → ` +
            `customer="${fields.customer ?? "?"}" (post-swap).`,
        );
        const swapped: ExtractedFields = {
          ...fields,
          supplier: fields.customer,
          customer: fields.supplier,
          supplierNif: customerNif || undefined,
          customerNif: authoritativeSupplierNif || fields.supplierNif,
        };
        swapped.hints = [
          ...(swapped.hints ?? []),
          `partySwap:ai-swapped-supplier-customer`,
          `partySwap:reason=supplier_nif_eq_tenant_nif`,
        ];
        return swapped;
      }

      // ── SWAP CONDITION 3: QR's B: (buyer NIF) equals the tenant's NIF
      // AND the AI put the tenant's NIF (or name) in the supplier slot.
      if (
        authoritativeBuyerNif === tenantNif &&
        !customerMatchesTenant &&
        (supplierNifNorm === tenantNif || supplierMatchesTenant) &&
        hasCustomerData
      ) {
        this.logger.warn(
          `[ensureSupplierCustomerSanity] QR's B: field matches tenant NIF ` +
            `(${formatPtNif(tenantNif)}) and AI swapped — fixing.`,
        );
        const swapped: ExtractedFields = {
          ...fields,
          supplier: fields.customer,
          customer: fields.supplier,
          supplierNif: fields.customerNif,
          customerNif: fields.supplierNif,
        };
        swapped.hints = [
          ...(swapped.hints ?? []),
          `partySwap:ai-swapped-supplier-customer`,
          `partySwap:reason=qr_b_matches_tenant_nif`,
        ];
        return swapped;
      }

      // ── SWAP CONDITION 2: supplier name matches tenant name
      if (
        supplierMatchesTenant &&
        !customerMatchesTenant &&
        hasCustomerData
      ) {
        this.logger.warn(
          `[ensureSupplierCustomerSanity] supplier name matches tenant name ` +
            `("${fields.supplier}") — swapping supplier/customer.`,
        );
        const swapped: ExtractedFields = {
          ...fields,
          supplier: fields.customer,
          customer: fields.supplier,
          supplierNif: fields.customerNif,
          customerNif: fields.supplierNif,
        };
        swapped.hints = [
          ...(swapped.hints ?? []),
          `partySwap:ai-swapped-supplier-customer`,
          `partySwap:reason=supplier_name_eq_tenant_name`,
        ];
        return swapped;
      }

      // ── CONDITION 5: QR's A: field (issuer NIF) overrides AI supplier NIF
      // The QR's A: is the legal source of truth for the supplier's NIF —
      // when present and well-formed, ANY AI-returned supplier NIF that
      // disagrees must be discarded. This is the primary fix for the
      // bug where Gemini infers the supplier NAME from the filename (e.g.
      // `NOV-OUSADO-LDA_*.pdf` looks like a NOV OUSADO supplier but the
      // QR A: says 502782160 = EDENOX, which is actually the supplier).
      // We DO NOT swap blindly because we don't have the supplier NAME in
      // the QR — we set qrAuthoritativeSupplierNif so downstream code can
      // re-resolve the supplier via NIF lookup after this returns.
      //
      // `qrAuthoritativeSupplierNif` here means: the NIF we resolved from
      // the QR payload (NOT the AI fallback `fields.supplierNif`). We
      // detect that by re-reading the QR string explicitly.
      const qrSoleNif = qrStr ? qrStr.match(/(?:^|\*)A:(\d+)/)?.[1] : undefined;
      const qrNifNormalized = qrSoleNif ? normalizeTenantNif(qrSoleNif) : undefined;
      if (
        qrNifNormalized &&
        qrNifNormalized.length === 9 &&
        // differs from what the AI put in the supplier slot
        supplierNifNorm !== qrNifNormalized &&
        // AND the QR NIF doesn't match the tenant (otherwise CONDITION 1 already handled it)
        qrNifNormalized !== tenantNif
      ) {
        const trustedNif = qrNifNormalized;
        const aiNifWas = supplierNifNorm || "none";
        this.logger.warn(
          `[ensureSupplierCustomerSanity] QR A: NIF (${formatPtNif(trustedNif)}) ` +
            `overrides AI supplier NIF (${aiNifWas === "none" ? "(empty)" : formatPtNif(aiNifWas)}). ` +
            `Discarding AI supplier NAME so it can be re-resolved from the trusted NIF. ` +
            `document=${fileName ?? "?"}, aiSupplier="${fields.supplier ?? "?"}".`,
        );
        const corrected: ExtractedFields = {
          ...fields,
          // Overwrite NIF with QR truth. Clear NAME so the supplier-resolver
          // fills it from a Party lookup keyed on the trusted NIF.
          supplierNif: trustedNif,
          supplier: undefined,
          supplierVatId: undefined,
        };
        corrected.hints = [
          ...(corrected.hints ?? []),
          `qrAuthoritativeSupplierNif:${trustedNif}`,
          `aiSupplierDiscarded:reason=qr_a_overrides_ai_supplier_nif`,
        ];
        return corrected;
      }

      // ── CONDITION 4: AI supplier name matches the upload filename
      // (heurística errada: o modelo leu o filename e colocou como
      // emitente). Quando o customer slot tem dados E o customer NIF
      // difere do tenant NIF, descartamos o supplier do AI e fazemos o
      // swap — o nome real do supplier está provavelmente no customer
      // (a fatura tem DOIS nomes e o AI escolheu o errado baseado no
      // filename). Marcamos qrAuthoritativeSupplierNif:none + um hint
      // para auditoria. Real bug medido em 2026-09-06 no doc
      // `cmtoag5il000ng59oor229cb3` (NOV-OUSADO-LDA_2026-03-19_*.pdf):
      // Gemini leu o filename como supplier, e o QR não foi captado
      // pelo pipeline nesse doc, então cai nesse caminho.
      if (
        fileName &&
        supplierName.length >= 5 &&
        hasCustomerData &&
        // Customer NIF é presente E não é o tenant NIF (= não é o comprador)
        customerNif.length > 0 &&
        customerNif !== tenantNif
      ) {
        // Heurística: limpar o filename e ver se o supplier name aparece
        // como prefixo. DocFlow uploads usam `<NAME>_<DATE>_<NUMBER>.pdf`,
        // então o nome do CUSTOMER é tipicamente o prefixo. Se o supplier
        // do AI casa com esse prefixo, é forte sinal de que o AI inverteu.
        const fileNameNorm = fileName
          .replace(/\.pdf$/i, "")
          .replace(/_[0-9]{4}-[0-9]{2}-[0-9]{2}_.*$/, "")
          .replace(/_[0-9]{8,}.*$/, "")
          // Treat dashes/spaces/underscores as interchangeable — uploads
          // often use `NOV-OUSADO-LDA` while the AI extracted `NOV OUSADO
          // LDA`. Without this normalisation the substring check misses
          // both directions on every DocFlow upload (the real bug from
          // 2026-09-06 EDENOX invoice).
          .replace(/[-_\s]+/g, " ")
          .toLowerCase()
          .trim();
        const supplierNameNorm = supplierName.replace(/[-_\s]+/g, " ");
        const filenameSuspiciousMatch =
          fileNameNorm.length >= 5 &&
          (fileNameNorm.includes(supplierNameNorm) ||
            supplierNameNorm.includes(fileNameNorm) ||
            (supplierNameNorm.length >= 8 &&
              fileNameNorm.startsWith(supplierNameNorm.slice(0, 8))));
        // Sprint H+ extraction-fix-3 — structural cross-check on the
        // supplier NIF. When AI Vision returns a supplier NIF that fails
        // the mod-11 checksum AND a customer NIF that passes, the AI
        // almost certainly swapped the two — the filename heuristic
        // alone misses cases where the AI returned a NIF-looking-but-
        // invalid string in the supplier slot (e.g. the EDENOX NIF
        // 502782160 which has a wrong check digit). The structural
        // check is independent of the filename, so it catches both
        // real-bug cases: wrong NIF for the actual supplier (AI
        // hallucinated) AND AI swapped customer→supplier (and the
        // customer NIF is the structurally-valid one).
        const supplierNifRaw = fields.supplierNif;
        const customerNifRaw = fields.customerNif;
        const supplierNifStructurallyInvalid =
          !!supplierNifRaw &&
          // strip "PT" prefix before checking — the helper already does
          // this but we want the explicit predicate here so the
          // intent is clear.
          !isValidPortugueseNif(supplierNifRaw) &&
          // don't fire on foreign NIFs (ES/FR/...) where the helper
          // intentionally returns false because it's PT-specific.
          !/^[A-Z]{2}/.test(supplierNifRaw);
        const customerNifStructurallyValid =
          !!customerNifRaw && isValidPortugueseNif(customerNifRaw);
        const structuralNifMismatch =
          supplierNifStructurallyInvalid && customerNifStructurallyValid;
        // Root-cause fix (DIAGNOSTIC-2 §5 item 6): the structural NIF check
        // is now the primary signal. The filename heuristic used to gate
        // the swap behind `&& filenameSuspiciousMatch`, which meant every
        // case where the AI hallucinated a supplier name NOT present in
        // the filename would silently escape the safety net — the user's
        // "10x the same PDF" pattern. We now swap whenever the supplier
        // NIF fails mod-11 AND the customer NIF passes it, regardless of
        // whether the filename heuristic also matches.
        const shouldSwap = structuralNifMismatch;
        if (shouldSwap) {
          if (filenameSuspiciousMatch) {
            this.logger.warn(
              `[ensureSupplierCustomerSanity] AI supplier name "${fields.supplier}" ` +
                `matches filename prefix (${fileName}); likely swapped with customer. ` +
                `Real bug from 2026-09-06 EDENOX invoice. Structural NIF check confirmed: ` +
                `supplierNif="${supplierNifRaw}" fails mod-11 checksum, customerNif="${customerNifRaw}" ` +
                `passes — AI swapped the slots.`,
            );
          } else {
            this.logger.warn(
              `[extraction] partySwap triggered by structural NIF mismatch (no filename anchor) ` +
                `doc=${fileName ?? "?"} supplierNif="${supplierNifRaw}" customerNif="${customerNifRaw}". ` +
                `Filename heuristic did not match — swap is NIF-anchored only.`,
            );
          }
          const swapped: ExtractedFields = {
            ...fields,
            supplier: fields.customer,
            customer: fields.supplier,
            supplierNif: fields.customerNif,
            customerNif: fields.supplierNif,
          };
          swapped.hints = [
            ...(swapped.hints ?? []),
            `partySwap:ai-swapped-supplier-customer`,
            `partySwap:reason=ai_supplier_name_matches_filename_prefix`,
          ];
          return swapped;
        }
      }

      // ── CONDITION 6: Tenant's own NIF was assigned to supplierNif
      // If supplierNif matches our tenant NIF: we are the BUYER / CUSTOMER, not the supplier!
      // In Portugal, on simplified invoices (FS/FR) or retail receipts, the customer gives their NIF (our tenant NIF).
      // If the extractor assigned our tenant NIF to supplierNif:
      // 1) Search hints or customerNif for an alternative valid NIF that is NOT tenantNif.
      //    If found: supplierNif = altSupplierNif, customerNif = tenantNif.
      // 2) If no alternative NIF was found, but doc is clearly an incoming invoice/expense/simplified invoice:
      //    customerNif = tenantNif, supplierNif = undefined, supplier = supplierMatchesTenant ? undefined : fields.supplier.
      //    If document hints/text or type suggest simplified invoice/receipt, ensure documentType is 'FATURA_SIMPLIFICADA'.
      if (
        (supplierNifNorm === tenantNif || authoritativeSupplierNif === tenantNif) &&
        !customerMatchesTenant
      ) {
        const candidateNifs: string[] = [];
        if (customerNif && customerNif !== tenantNif && isValidPortugueseNif(customerNif)) {
          candidateNifs.push(customerNif);
        }
        if (fields.hints) {
          for (const h of fields.hints) {
            const m = h.match(/^(?:nif|customerNif|vat|qrAuthoritativeSupplierNif):([A-Z0-9]+)/i);
            if (m && m[1]) {
              const norm = normalizeTenantNif(m[1]);
              if (norm && norm !== tenantNif && isValidPortugueseNif(norm) && !candidateNifs.includes(norm)) {
                candidateNifs.push(norm);
              }
            }
          }
        }

        const altSupplierNif = candidateNifs[0];
        this.logger.warn(
          `[ensureSupplierCustomerSanity] CONDITION 6: supplierNif is tenant's own NIF (${tenantNif}). ` +
            `Tenant is the buyer/customer. Setting customerNif = ${tenantNif}, ` +
            `supplierNif = ${altSupplierNif ?? "undefined"}.`,
        );

        const isSimplifiedOrExpense =
          fields.documentType === "FATURA_SIMPLIFICADA" ||
          fields.documentType === "RECIBO" ||
          (fields.hints ?? []).some((h) =>
            /simplificada|recibo|cup[aã]o|restaurante/i.test(h),
          ) ||
          (fields.docNumber &&
            /^(?:FS|FR|Simplificada)/i.test(fields.docNumber));

        const updated: ExtractedFields = {
          ...fields,
          supplierNif: altSupplierNif ?? undefined,
          supplierVatId: altSupplierNif ?? undefined,
          customerNif: tenantNif,
          supplier: supplierMatchesTenant
            ? altSupplierNif
              ? undefined
              : fields.customer
            : fields.supplier,
          customer: supplierMatchesTenant
            ? fields.supplier
            : fields.customer || id.tenantName || undefined,
          documentType:
            isSimplifiedOrExpense &&
            (!fields.documentType ||
              fields.documentType === "OUTRO" ||
              fields.documentType === "ENCOMENDA")
              ? "FATURA_SIMPLIFICADA"
              : fields.documentType,
        };
        updated.hints = [
          ...(updated.hints ?? []),
          `partySwap:tenant_nif_in_supplier_fixed`,
          `partySwap:customerNif=${tenantNif}`,
          ...(altSupplierNif ? [`partySwap:supplierNif=${altSupplierNif}`] : []),
        ];
        return updated;
      }

      return fields;
    } catch (err) {
      this.logger.warn(
        `[ensureSupplierCustomerSanity] unexpected throw — skipping safety net. ` +
          `Reason: ${(err as Error).message}`,
      );
      return fields;
    }
  }

  /**
   * Root-cause fix (DIAGNOSTIC-2 §5 item 7): when the AI's supplier NIF
   * fails mod-11 BUT the customer NIF is structurally valid AND resolves
   * to an existing Party in this tenant, the customer Party is almost
   * certainly the actual supplier (AI swapped the slots). We swap the
   * supplier/customer fields and link to the resolved Party.
   *
   * This is the NIF-anchored counterpart to `shouldSwap`'s filename
   * heuristic: the heuristic misses every hallucination where the
   * AI invented a supplier name NOT present in the upload filename.
   * A Party lookup on (tenantId, nif) is structural and never lies.
   *
   * Tenant scoping is mandatory — never let a Party from another tenant
   * leak into this document. Cross-tenant NIF matches are silently
   * rejected (returns null) and logged at WARN.
   *
   * Returns the resolved swap payload (or null when no swap applies).
   * The caller applies the swap to `ExtractedFields` and writes the
   * resulting `partyId` onto `Document.partyId` so the link is the
   * trusted Party row, not a freshly-created wrong-supplier Party.
   */
  async resolveSupplierByNif(
    tenantId: string,
    documentId: string,
    fields: ExtractedFields,
  ): Promise<{
    supplier: string;
    supplierNif: string;
    partyId: string | null;
    reason: string;
  } | null> {
    const supplierNifRaw = (fields.supplierNif ?? "").toString().trim();
    const customerNifRaw = (fields.customerNif ?? "").toString().trim();

    // Guard: only fire when the AI's supplier NIF is structurally invalid
    // AND the customer NIF passes mod-11 — the same precondition as the
    // `structuralNifMismatch` branch of `shouldSwap`. Skipping a valid
    // supplier NIF here keeps AI-confidence flows untouched.
    if (!supplierNifRaw || isValidPortugueseNif(supplierNifRaw)) {
      return null;
    }
    if (!customerNifRaw || !isValidPortugueseNif(customerNifRaw)) {
      return null;
    }

    let party: { id: string; name: string; nif: string | null } | null = null;
    try {
      party = await this.prisma.party.findFirst({
        where: { tenantId, nif: customerNifRaw },
        select: { id: true, name: true, nif: true },
      });
    } catch (err) {
      // Tenant scoping / DB hiccup — never abort extraction on this path.
      this.logger.warn(
        `[resolveSupplierByNif] party lookup failed for tenant=${tenantId} ` +
          `customerNif=${customerNifRaw}: ${(err as Error).message}. ` +
          `Skipping NIF-resolve fallback.`,
      );
      return null;
    }
    if (!party) {
      // No Party in this tenant for the customer NIF — no swap to apply.
      return null;
    }
    // Prisma `where: { tenantId }` already enforces tenant scoping on the
    // lookup; no extra cross-tenant check needed (and the helper is a
    // helper, not an audit point).

    this.logger.warn(
      `[resolveSupplierByNif] AI supplier NIF (${supplierNifRaw}) fails mod-11 ` +
        `but customer NIF (${customerNifRaw}) resolves Party "${party.name}" ` +
        `(${party.id}) in tenant=${tenantId} doc=${documentId}. ` +
        `Swapping supplier/customer — Party lookup is the trusted anchor.`,
    );
    return {
      supplier: party.name,
      supplierNif: party.nif ?? customerNifRaw,
      partyId: party.id,
      reason: "customer-nif-resolves-existing-party",
    };
  }
  private mergeVisionWithRegex(
    vision: import("../ai/vision.service").VisionAnalysisResult,
    regex: ExtractedFields,
  ): ExtractedFields {
    const AI_CONFIDENCE_FLOOR = 0.6;
    // Hard gate: the AI must (a) hit the confidence floor AND (b) not be
    // in fallback mode. The fallback flag is the single source of truth
    // for "the JSON we got back was truncated or unparseable" — better to
    // skip the AI merge entirely than to risk inventing numbers from
    // partial data on an image with no text layer (the bug we just fixed:
    // real-photo extraction returned total=31082026 from a date string).
    const used = !vision.fallbackUsed && vision.confidence >= AI_CONFIDENCE_FLOOR;
    const pick = <T extends keyof import("../ai/vision.service").VisionExtractedFields>(
      key: T,
    ): import("../ai/vision.service").VisionExtractedFields[T] | undefined =>
      vision.extracted[key];

    const merged: ExtractedFields = { ...regex };

    // When we don't trust the AI, preserve its raw atQrRaw (parsed
    // downstream by extractFromQr, which is the authoritative path) but
    // emit a confidence lower than 0.4 so the upstream status setter keeps
    // the document flagged for manual review instead of promoting it to
    // EM_REVISAO with bogus amounts. The AI's hints + the partial-JSON
    // warning are still attached for the audit trail.
    if (!used) {
      merged.hints = [
        ...(merged.hints ?? []),
        `ai:${vision.provider}/${vision.model}`,
        `aiSkipped:${vision.fallbackUsed ? "fallback_used" : "low_confidence"}`,
      ];
      if (vision.fallbackUsed) {
        merged.warnings = [
          ...(merged.warnings ?? []),
          "ai_partial_response_used_regex_fallback",
        ];
      }
      // Clamp confidence so processDocumentAsync's `>= 0.4` gate keeps
      // the document in NOVO when no other source supplied enough signal.
      const regexConfidence = merged.confidence ?? 0;
      merged.confidence = Math.min(
        Math.max(regexConfidence, vision.confidence ?? 0),
        0.39,
      );
      merged.source = "regex";
      return merged;
    }

    if (used) {
      if (pick("supplier")) merged.supplier = pick("supplier") as string | undefined;
      if (pick("customer")) merged.customer = pick("customer") as string | undefined;
      if (pick("supplierNif"))
        merged.supplierNif = pick("supplierNif") as string | undefined;
      if (pick("customerNif"))
        merged.customerNif = pick("customerNif") as string | undefined;
      if (pick("supplierVatId"))
        merged.supplierVatId = pick("supplierVatId") as string | undefined;
      if (pick("supplierAddress"))
        merged.supplierAddress = pick("supplierAddress") as string | undefined;
      if (pick("supplierPostalCode"))
        merged.supplierPostalCode = pick("supplierPostalCode") as string | undefined;
      if (pick("supplierCity"))
        merged.supplierCity = pick("supplierCity") as string | undefined;
      if (pick("supplierPhone"))
        merged.supplierPhone = pick("supplierPhone") as string | undefined;
      if (pick("supplierEmail"))
        merged.supplierEmail = pick("supplierEmail") as string | undefined;
      if (pick("supplierWebsite"))
        merged.supplierWebsite = pick("supplierWebsite") as string | undefined;
      if (pick("docNumber"))
        merged.docNumber = pick("docNumber") as string | undefined;
      if (pick("atcud")) merged.atcud = pick("atcud") as string | undefined;
      if (pick("docDate")) merged.docDate = pick("docDate") as string | undefined;
      if (pick("dueDate")) merged.dueDate = pick("dueDate") as string | undefined;
      if (pick("netAmount"))
        merged.netAmount = pick("netAmount") as number | undefined;
      if (pick("taxAmount"))
        merged.taxAmount = pick("taxAmount") as number | undefined;
      if (pick("total")) merged.total = pick("total") as number | undefined;
      if (pick("currency"))
        merged.currency = (pick("currency") as string | undefined) ?? merged.currency;
      if (pick("iban")) merged.iban = pick("iban") as string | undefined;
      if (pick("country")) {
        const country = pick("country") as string | undefined;
        if (country) {
          merged.country = country;
          merged.documentLocale = this.documentLocaleFor(country);
        }
      }
      if (pick("documentType")) {
        // The AI returns a free-form label like "FATURA", "Fatura",
        // "Invoice", "Recibo", "Nota de crédito" or even the exact enum
        // value "FATURA_RECEBIDA". Map it onto the Prisma DocumentType
        // enum DIRECTLY — the previous slice-and-feed-to-QR heuristic
        // took the first 2-3 letters ("FAT") and tried to match them
        // against QR-AT codes (FT/FR/NC), which silently dropped every
        // well-formed AI classification.
        const mapped = this.aiDocumentTypeToEnum(
          pick("documentType") as string | undefined,
        );
        if (mapped) merged.documentType = mapped;
      }
      // AI-only fields — line items, intracommunity flag, SNC category,
      // cash discount. These never come from the regex/QR path, so there's
      // nothing to merge against: when the AI emits them, we pass them
      // through. Always gated on `used` so a low-confidence AI call can't
      // silently rewrite these fields.
      const lineItems = pick("lineItems") as
        | import("../ai/vision.service").VisionExtractedLineItem[]
        | undefined;
      if (lineItems && lineItems.length > 0) {
        merged.lineItems = lineItems.map((row) => ({
          description: row.description,
          code: row.code,
          quantity: row.quantity,
          unitPrice: row.unitPrice,
          vatRate: row.vatRate,
          discount: row.discount,
          lineTotal: row.lineTotal,
        }));
      }
      if (typeof pick("isEuIntracommunity") === "boolean") {
        merged.isEuIntracommunity = pick("isEuIntracommunity");
      }
      // Fase 4.1 — cabeçalho literal + referência da fatura retificada.
      const docTitle = pick("documentTitle") as string | undefined;
      if (docTitle && docTitle.trim().length > 0) {
        merged.documentTitle = docTitle.trim().slice(0, 200);
      }
      const correctedRef = pick("correctedDocumentNumber") as string | undefined;
      if (correctedRef && correctedRef.trim().length > 0) {
        merged.correctedDocumentNumber = correctedRef.trim().slice(0, 100);
      }
      const suggestedCategory = pick("suggestedCategory") as string | undefined;
      if (suggestedCategory && suggestedCategory.trim().length > 0) {
        merged.suggestedCategory = suggestedCategory.trim().slice(0, 200);
      }
      const cdr = pick("cashDiscountRate") as number | undefined;
      if (typeof cdr === "number" && Number.isFinite(cdr) && cdr >= 0 && cdr <= 100) {
        merged.cashDiscountRate = cdr;
      }
      // Invoice-level discount — pass through when present. Net/total are
      // the AI's responsibility; we only persist + reconcile downstream.
      const aiDiscount = pick("discountAmount") as number | undefined;
      if (typeof aiDiscount === "number" && Number.isFinite(aiDiscount) && aiDiscount >= 0) {
        merged.discountAmount = aiDiscount;
      }
      // Per-rate VAT breakdown — prefer the AI's explicit list. If the AI
      // didn't produce one but we now have them, we synthesise it below in
      // `composeMetadata` from the line items + vatRate distribution.
      const aiIvaBreakdown = pick("ivaBreakdown") as
        | Array<{ rate: number; base: number; tax: number }>
        | undefined;
      if (aiIvaBreakdown && aiIvaBreakdown.length > 0) {
        merged.ivaBreakdown = aiIvaBreakdown
          .map((row) => ({
            rate: Number(row.rate),
            base: Number(row.base),
            tax: Number(row.tax),
          }))
          .filter(
            (row) =>
              Number.isFinite(row.rate) &&
              Number.isFinite(row.base) &&
              Number.isFinite(row.tax) &&
              row.rate >= 0 &&
              row.base >= 0 &&
              row.tax >= 0,
          );
      }
    }

    // Compute a final confidence: max(ai, regex) but biased upward when
    // both agree on a high-importance field (total + at least one of
    // supplier / docNumber / docDate).
    const agree =
      regex.total != null &&
      merged.total != null &&
      Math.abs((regex.total ?? 0) - (merged.total ?? 0)) < 0.01;
    let confidence = Math.max(merged.confidence ?? 0, vision.confidence);
    if (agree && (merged.supplierNif || merged.docNumber) && merged.docDate) {
      confidence = Math.max(confidence, 0.9);
    }
    merged.confidence = Math.min(confidence, 0.95);
    merged.source = "ai";

    // ── Money-trio reconciliation (the root-cause fix) ──────────────
    // Apply the same invariant as everywhere else: total ≈ net + tax
    // (±0.05). The AI sometimes writes the total into taxAmount (or
    // leaves total=0 when it has tax=144.22) — that's the photo-1 bug
    // we keep regressing on. The reconciler normalises all three
    // fields to a single self-consistent trio before the row is written.
    const reconciled = this.reconcileMoneyTrio({
      total: merged.total,
      taxAmount: merged.taxAmount,
      netAmount: merged.netAmount,
      ivaBreakdown: merged.ivaBreakdown,
    });
    merged.total = reconciled.total;
    merged.taxAmount = reconciled.taxAmount;
    merged.netAmount = reconciled.netAmount;
    if (reconciled.reconciliationHint) {
      merged.hints = [
        ...(merged.hints ?? []),
        `moneyTrio:${reconciled.reconciliationHint}`,
      ];
    }

    return merged;
  }

  /**
   * Fase 3 — find the "live" original for a fiscal key. Excludes soft-deleted
   * rows and rows already marked DUPLICADO; when both sides carry an ATCUD
   * they must match (different ATCUD = different certified document even if
   * the human-readable number collides across series). Tolerates prisma
   * test doubles without `findMany`.
   */
  async findFiscalKeyOriginal(
    tenantId: string,
    documentId: string,
    supplierNif: string | null,
    docNumberNorm: string | null,
    atcud: string | null,
    atcudTrusted = true,
  ): Promise<{ id: string; fileName: string } | null> {
    const finder = (this.prisma.document as unknown as { findMany?: unknown }).findMany;
    if (typeof finder !== "function") return null;
    const keys: Prisma.DocumentWhereInput[] = [];
    if (supplierNif && docNumberNorm) keys.push({ supplierNif, docNumberNorm });
    // The ATCUD alone identifies a certified document (series code + number),
    // so two rows sharing it are the same invoice even when the human-readable
    // number was read differently (photo vs scan).
    if (atcud) keys.push({ atcud });
    if (keys.length === 0) return null;
    try {
      const rows = await this.prisma.document.findMany({
        where: {
          tenantId,
          deletedAt: null,
          id: { not: documentId },
          status: { not: DocumentStatus.DUPLICADO },
          OR: keys,
        },
        select: { id: true, fileName: true, atcud: true },
        orderBy: { createdAt: "asc" },
        take: 10,
      });
      const hit =
        rows.find((r) => atcud && r.atcud === atcud) ??
        rows.find((r) => !r.atcud || !atcud || !atcudTrusted);
      return hit ? { id: hit.id, fileName: hit.fileName } : null;
    } catch (err) {
      this.logger.warn(
        `[findFiscalKeyOriginal] lookup failed for document=${documentId}: ${(err as Error).message}`,
      );
      return null;
    }
  }

  /**
   * Fase 4 — categoria de despesa automática: >= 3 aprovações da mesma
   * categoria para o fornecedor (PartyCategoryStat) ou a categoria por
   * defeito do fornecedor. Tolera prisma sem o modelo (test doubles).
   */
  private async resolveAutoCategory(
    tenantId: string,
    partyId: string,
  ): Promise<{ categoryId: string; confidence: number; reason: string } | null> {
    const client = this.prisma as unknown as {
      partyCategoryStat?: { findMany: (args: unknown) => Promise<Array<{ categoryId: string; approvedCount: number }>> };
      party?: { findFirst: (args: unknown) => Promise<{ defaultCategoryId: string | null } | null> };
    };
    if (typeof client.partyCategoryStat?.findMany !== "function" || typeof client.party?.findFirst !== "function") {
      return null;
    }
    try {
      const [stats, party] = await Promise.all([
        client.partyCategoryStat.findMany({
          where: { tenantId, partyId },
          select: { categoryId: true, approvedCount: true },
        }),
        client.party.findFirst({ where: { id: partyId, tenantId }, select: { defaultCategoryId: true } }),
      ]);
      return pickAutoCategory(stats ?? [], party?.defaultCategoryId ?? null);
    } catch (err) {
      this.logger.warn(`[resolveAutoCategory] failed for party=${partyId}: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Fase 4 — replace this document's DocumentItem rows with the
   * AI-extracted line items. Skips items with no description or no
   * derivable total (garbage in, nothing written). Tolerates prisma test
   * doubles without `documentItem` (same pattern as the other Fase 3/4
   * optional-model helpers in this file).
   */
  private async persistLineItems(
    documentId: string,
    lineItems: ExtractedFields["lineItems"] | undefined,
  ): Promise<void> {
    const client = this.prisma as unknown as {
      documentItem?: {
        deleteMany: (args: unknown) => Promise<unknown>;
        createMany: (args: unknown) => Promise<unknown>;
      };
    };
    if (typeof client.documentItem?.deleteMany !== "function") return;
    try {
      await client.documentItem.deleteMany({ where: { documentId } });
      const rows = (lineItems ?? [])
        .map((it) => {
          const description = it.description?.trim();
          const quantity = it.quantity ?? 1;
          const unitPrice = it.unitPrice;
          const total =
            it.lineTotal ??
            (unitPrice != null ? Math.round(unitPrice * quantity * 100) / 100 : undefined);
          if (!description || total == null || !Number.isFinite(total)) return null;
          // Fase 4.2 (P0.3) — o valor impresso na coluna de desconto
          // pode ser uma percentagem (a SAMMIC imprime "Dto. 30,00" =
          // 30%, não 30€). Classificamos pela aritmética antes de
          // gravar: `discount` guarda sempre o VALOR em euros (a soma
          // das linhas continua correta); `discountPercent` guarda a
          // percentagem quando a classificação a confirmou, para a
          // interface mostrar "30%" em vez de "30,00 EUR".
          const classified = classifyLineDiscount({
            quantity,
            unitPrice,
            discount: it.discount,
            lineTotal: it.lineTotal,
          });
          return {
            documentId,
            code: it.code ?? null,
            description,
            quantity,
            unitPrice: unitPrice ?? total / (quantity || 1),
            discount: classified.discountAmount ?? 0,
            discountPercent: classified.kind === 'percent' ? classified.discountPercent : null,
            taxRate: it.vatRate ?? 23,
            total,
          };
        })
        .filter((r): r is NonNullable<typeof r> => r !== null);
      if (rows.length > 0) {
        await client.documentItem.createMany({ data: rows });
      }
    } catch (err) {
      this.logger.warn(
        `[persistLineItems] failed for document=${documentId}: ${(err as Error).message}`,
      );
    }
  }

  private async categoryNameById(tenantId: string, id: string): Promise<string | null> {
    const client = this.prisma as unknown as { category?: { findFirst: (args: unknown) => Promise<{ name: string } | null> } };
    if (typeof client.category?.findFirst !== "function") return null;
    try {
      const row = await client.category.findFirst({ where: { id, tenantId }, select: { name: true } });
      return row?.name ?? null;
    } catch {
      return null;
    }
  }

  private async matchCategoryBySuggestion(
    tenantId: string,
    suggestedCategory: string,
  ): Promise<{ id: string; name: string } | null> {
    const client = this.prisma as unknown as { category?: { findMany: (args: unknown) => Promise<Array<{ id: string; name: string; slug: string }>> } };
    if (typeof client.category?.findMany !== "function") return null;
    try {
      const categories = await client.category.findMany({
        where: { tenantId },
        select: { id: true, name: true, slug: true },
      });
      if (!categories || categories.length === 0) return null;

      const mappedSlug = mapToExpenseCategory(suggestedCategory);
      if (mappedSlug) {
        const byName = categories.find((c) => c.name.toLowerCase() === mappedSlug.toLowerCase());
        if (byName) return byName;
      }

      const clean = suggestedCategory.toLowerCase();
      if (clean.includes('31.') || clean.includes('mercadoria')) {
        const revenda = categories.find((c) => c.slug === 'mercadorias-revenda' || c.name.toLowerCase().includes('revenda'));
        if (revenda) return revenda;
      }
      if (clean.includes('43.') || clean.includes('imobilizado') || clean.includes('equipamento')) {
        const imob = categories.find((c) => c.slug === 'imobilizado' || c.name.toLowerCase().includes('imobilizado'));
        if (imob) return imob;
      }
      if (clean.includes('62.2.') || clean.includes('62.1.') || clean.includes('62.6.') || clean.includes('serviços') || clean.includes('servicos') || clean.includes('fse') || clean.includes('limpeza')) {
        const fse = categories.find((c) => c.slug === 'servicos-fse' || c.name.toLowerCase().includes('serviços'));
        if (fse) return fse;
      }
      if (clean.includes('62.3.3') || clean.includes('escritório') || clean.includes('escritorio')) {
        const esc = categories.find((c) => c.slug === 'material-escritorio');
        if (esc) return esc;
      }
      if (clean.includes('62.4.2') || clean.includes('combust')) {
        const comb = categories.find((c) => c.slug === 'combustivel');
        if (comb) return comb;
      }
      if (clean.includes('refei') || clean.includes('restaur')) {
        const ref = categories.find((c) => c.slug === 'refeicoes');
        if (ref) return ref;
      }

      const matched = categories.find((c) => clean.includes(c.name.toLowerCase()));
      if (matched) return matched;

      return null;
    } catch {
      return null;
    }
  }

  /** Fase 3 — the single place that writes the extraction result row. */
  /**
   * Fase 4.1 (P1.2) — encontra a fatura que uma nota de crédito
   * retifica. Procuramos pelo nº normalizado do documento retificado,
   * dentro do mesmo tenant e, quando o sabemos, do mesmo fornecedor. Uma
   * NC nunca se liga a si própria nem a outra nota de crédito.
   */
  private async findCorrectedDocument(
    tenantId: string,
    selfId: string,
    correctedNumber: string,
    supplierNif: string | null,
  ): Promise<{ id: string; docNumber: string | null } | null> {
    const norm = normalizeDocNumber(correctedNumber);
    if (!norm) return null;
    try {
      const rows = await this.prisma.document.findMany({
        where: {
          tenantId,
          id: { not: selfId },
          docNumberNorm: norm,
          type: { not: DocumentType.NOTA_CREDITO },
          deletedAt: null,
          ...(supplierNif ? { supplierNif } : {}),
        },
        select: { id: true, docNumber: true, supplierNif: true },
        orderBy: { createdAt: "asc" },
        take: 5,
      });
      // Com NIF conhecido, o filtro já garantiu o fornecedor certo; sem
      // ele, só aceitamos quando não há ambiguidade.
      if (rows.length === 1) return rows[0];
      if (supplierNif && rows.length > 0) return rows[0];
      return null;
    } catch (err) {
      this.logger.warn(
        `[findCorrectedDocument] lookup failed for "${correctedNumber}": ${(err as Error).message}`,
      );
      return null;
    }
  }

  /**
   * Fase 4.1 (P1.4) — reconstrói o derivado PDF a partir da imagem
   * endireitada pelo conteúdo e comprimida para ≤ 500 KB, e confirma
   * que o QR-AT continua legível depois da compressão.
   *
   * Best-effort de ponta a ponta: qualquer falha deixa o documento
   * exactamente como estava. O original nunca é tocado.
   */
  private async rebuildArchivePdf(
    documentId: string,
    doc: { mimeType: string; fileName: string },
    uprightBytes: Buffer,
  ): Promise<void> {
    if (!this.archiveImage || !this.imageToPdf || !this.storage?.put) {
      // Alto e bom som: um silêncio aqui custou fotos de 3 MB deitadas
      // no arquivo sem ninguém dar por isso.
      this.logger.warn(
        `[archive] skipped for ${doc.fileName} — archiveImage=${Boolean(this.archiveImage)} ` +
          `imageToPdf=${Boolean(this.imageToPdf)} storage.put=${Boolean(this.storage?.put)}`,
      );
      return;
    }
    if (!this.imageToPdf.supports(doc.mimeType)) return;
    try {
      const prepared = await this.archiveImage.prepare(uprightBytes, doc.mimeType);
      if (!prepared) return;

      // O QR tem de continuar a ler-se depois da compressão — é o que
      // sustenta toda a validade fiscal do documento. Se a versão
      // comprimida perdeu o QR que o original tinha, ficamos com o
      // original: um ficheiro maior é melhor do que um ilegível.
      const qrBefore = await decodeAtQr(uprightBytes, doc.mimeType, this.logger);
      let bytesForPdf = prepared.buffer;
      if (qrBefore) {
        const qrAfter = await decodeAtQr(prepared.buffer, "image/jpeg", this.logger);
        if (!qrAfter) {
          this.logger.warn(
            `[archive] compression cost the QR on ${doc.fileName} — keeping the uncompressed image`,
          );
          bytesForPdf = uprightBytes;
        }
      }

      const pdf = this.ocrmypdf
        ? await this.ocrmypdf.processImageOrPdf(
            bytesForPdf,
            bytesForPdf === prepared.buffer ? "image/jpeg" : doc.mimeType,
          )
        : await this.imageToPdf.convert(
            bytesForPdf,
            bytesForPdf === prepared.buffer ? "image/jpeg" : doc.mimeType,
          );
      const row = await this.prisma.document.findFirst({
        where: { id: documentId },
        select: { pdfKey: true, fileKey: true },
      });
      const pdfKey = row?.pdfKey ?? `${row?.fileKey ?? documentId}.pdf`;
      await this.storage.put(pdfKey, pdf, { contentType: "application/pdf" });
      await this.prisma.document.update({
        where: { id: documentId },
        data: {
          pdfKey,
          fileSize: pdf.length,
        },
      });
      this.logger.log(
        `[archive] ${doc.fileName}: rotated ${prepared.rotation}° (${prepared.rotationReason}), ` +
          `${(prepared.originalBytes / 1024).toFixed(0)}KB → ${(prepared.buffer.length / 1024).toFixed(0)}KB ` +
          `@q${prepared.quality}, pdf ${(pdf.length / 1024).toFixed(0)}KB` +
          (prepared.withinBudget ? "" : " (ACIMA do orçamento de 500KB)"),
      );
    } catch (err) {
      this.logger.warn(`[archive] rebuild failed for ${doc.fileName}: ${(err as Error).message}`);
    }
  }

  private runFinalUpdate(
    documentId: string,
    data: Prisma.DocumentUpdateInput,
    status: DocumentStatus,
    metadata: () => Prisma.InputJsonValue,
    ocrConfidence: number,
  ) {
    return this.prisma.document.update({
      where: { id: documentId },
      data: { ...data, metadata: metadata(), ocrConfidence, status },
    });
  }

  /**
   * Fase 2 — cross-check an LLM-read QR payload against the structured
   * fields the same LLM extracted from the document. Both come from the
   * model, so agreement is evidence the read-back is real; disagreement
   * means at least one of them is a hallucination and the QR must not be
   * promoted to "at_qr" authority. Requires NIF + total in the QR.
   */
  isAiQrConsistent(
    qr: Pick<ExtractedFields, "supplierNif" | "total" | "docDate">,
    ai: Pick<ExtractedFields, "supplierNif" | "total" | "docDate">,
  ): { ok: boolean; reasons: string[] } {
    const reasons: string[] = [];
    const norm = (v?: string) => (v ?? "").replace(/^PT/i, "").replace(/\s/g, "");
    if (!qr.supplierNif || qr.total == null) reasons.push("qr_missing_nif_or_total");
    if (qr.supplierNif && ai.supplierNif && norm(qr.supplierNif) !== norm(ai.supplierNif)) {
      reasons.push(`nif:${norm(qr.supplierNif)}!=${norm(ai.supplierNif)}`);
    }
    if (qr.total != null && ai.total != null && Math.abs(qr.total - ai.total) >= 0.01) {
      reasons.push(`total:${qr.total}!=${ai.total}`);
    }
    if (qr.docDate && ai.docDate && qr.docDate !== ai.docDate) {
      reasons.push(`date:${qr.docDate}!=${ai.docDate}`);
    }
    return { ok: reasons.length === 0, reasons };
  }

  /** Parse a known-AT-QR payload string into Document fields. */
  extractFromQr(qrText: string, doc: { type: string }): ExtractedFields {
    const cleaned = (qrText ?? "").replace(/\s+/g, "");
    const parsed = parseAtQr(cleaned);
    if (!parsed) {
      this.logger.warn(
        "extractFromQr called with non-AT payload; falling back to regex",
      );
      return this.regexExtraction(cleaned, ["fallback:qr_parse_failed"]);
    }

    const hints: string[] = [`source:at_qr`];
    const warnings: string[] = [];
    if (parsed.atcud) hints.push(`atcud:${parsed.atcud}`);
    if (parsed.documentDate) hints.push(`docDate:${parsed.documentDate}`);

    const supplierNif = parsed.issuerNif;
    const customerNif = !isFinalConsumerNif(parsed.buyerNif)
      ? parsed.buyerNif
      : undefined;

    return {
      supplierNif,
      customerNif,
      supplier: undefined, // QR payload does not carry the supplier name
      customer: undefined,
      // Fase 3 — the ATCUD is NOT a document number; when G: is missing the
      // AI/regex docNumber fills in during the merge instead.
      docNumber: parsed.uniqueDocId,
      atcud: parsed.atcud,
      docDate: parsed.documentDate,
      dueDate: undefined,
      total: parsed.total,
      taxAmount: parsed.totalTax,
      netAmount: this.computeNet(parsed.total, parsed.totalTax),
      iban: undefined, // QR-AT does not include the IBAN — caller wires that later
      currency: "EUR",
      // The QR-AT doc-type code (parsed.documentType) is authoritative
      // when present — we map the AT codes onto the Prisma enum so the
      // classification matches what the operator expects.
      documentType: this.qrCodeToDocumentType(parsed.documentType),
      confidence: 0.95,
      source: "at_qr",
      hints,
      warnings,
      // Persist the parsed per-region breakdown on the QR-only path so
      // `reconcileMoneyTrio` can use it as the authoritative source
      // (Σ base = net, Σ tax = tax) — the QR's parsed.ivaBreakdown is
      // structured by region (I/J/K blocks), so we normalise it to the
      // flat {rate, base, tax} shape used elsewhere.
      ivaBreakdown: this.normaliseQrRegionsToBreakdown(parsed.ivaBreakdown),
    };
  }

  /**
   * Flatten the QR-AT per-region breakdown into the shape used by
   * `reconcileMoneyTrio` and `composeMetadata`. Each region carries
   * base/tax at reduced (4%), intermediate (12%) and normal (23%) rates;
   * we map those onto a flat list with the actual rate from the
   * Portuguese IVA table.
   *
   * Drops entries with no tax AND no base (empty region blocks). Returns
   * `undefined` when no usable breakdown is present so the reconciler
   * falls back to the O/N pair.
   */
  private normaliseQrRegionsToBreakdown(
    regions:
      | Array<{
          region?: string;
          baseReduced?: number;
          taxReduced?: number;
          baseIntermediate?: number;
          taxIntermediate?: number;
          baseNormal?: number;
          taxNormal?: number;
        }>
      | undefined,
  ): Array<{ rate: number; base: number; tax: number }> | undefined {
    if (!regions || regions.length === 0) return undefined;
    const out: Array<{ rate: number; base: number; tax: number }> = [];
    for (const block of regions) {
      const region = block.region ?? "PT";
      const push = (
        base: number | undefined,
        tax: number | undefined,
        rate: number,
      ) => {
        if (base == null && tax == null) return;
        const b = base ?? 0;
        const t = tax ?? 0;
        out.push({ rate, base: b, tax: t });
      };
      // PT mainland default rates (other regions use different rates —
      // we deliberately use the most common ones here; the breakdown is
      // an audit hint, the per-row total is the authoritative number).
      push(block.baseReduced, block.taxReduced, region === "PT" ? 4 : 5);
      push(block.baseIntermediate, block.taxIntermediate, region === "PT" ? 12 : 12);
      push(block.baseNormal, block.taxNormal, region === "PT" ? 23 : 23);
    }
    return out.length > 0 ? out : undefined;
  }

  /**
   * Merge QR-AT fields with the AI/regex path. The QR is authoritative
   * on the fields it carries (issuer NIF, doc type, total, tax, date,
   * ATCUD, ivaBreakdown); the AI fills the gaps the QR doesn't have
   * (supplier name, IBAN, line items, customer, due date, suggested
   * category, country/locale).
   *
   * Resilient — if the AI call fails or times out we keep the QR
   * fields alone and tag `source: "at_qr"` WITH a `needs_review`
   * warning so the operator can see WHY the supplier is missing —
   * never silently leave supplier null.
   *
   * The AI ALWAYS runs whenever a vision provider is available —
   * the user has decided QR + AI is the default for every photo.
   * Even when the AI returns a partial / low-confidence JSON
   * (fallback used, confidence < 0.6), we still pull the AI's
   * `supplier`, `iban`, `customer`, `lineItems`, `suggestedCategory`
   * from the raw payload — those fields are read off printed text
   * the model is still confident about even when its OCR'd numbers
   * are corrupt. Source stays `at_qr+ai`, with `warnings[]` set
   * to flag the partial contribution.
   */
  async mergeQrWithAi(
    qrFields: ExtractedFields,
    doc: { fileKey: string; mimeType: string; fileName: string },
    loaded: LoadedText,
    tenantId?: string,
    precomputedAi?: ExtractedFields,
    overrides?: { model?: string; provider?: string },
  ): Promise<ExtractedFields> {
    // No vision provider configured → the QR is the only signal we
    // have. Tag the warning so the operator sees WHY supplier is
    // null. This is the only path that keeps source=`at_qr` per the
    // user's 2026-09-01 decision: vision provider unavailable is the
    // only acceptable reason for a QR-only outcome.
    if (!this.vision?.liveProviderAvailable) {
      this.logger.warn(
        `[mergeQrWithAi] no vision provider available for ${doc.fileName} — ` +
          `returning QR-only fields with supplier_may_be_null warning.`,
      );
      return {
        ...qrFields,
        warnings: [
          ...(qrFields.warnings ?? []),
          "qr_only_ai_unavailable_supplier_may_be_null",
        ],
      };
    }

    // Run the AI path. We use the regex-merged form for the MONEY
    // trio reconciliation below (it gates on `used` / `fallbackUsed`
    // to avoid the date-as-total corruption bug) but for the
    // supplier / IBAN / line-items merge we ALSO need access to the
    // raw vision `extracted` payload — captured via a sidecar hook
    // on the tryVisionAnalysis call.
    let aiFields: ExtractedFields | null = null;
    if (precomputedAi && this.lastVisionExtracted != null) {
      // Fase 2 — the caller already ran the AI path for this document;
      // reuse it instead of paying for a second vision call.
      aiFields = precomputedAi;
    } else {
      this.lastVisionExtracted = null;
    }
    try {
      if (!aiFields) aiFields = await this.runAiOrRegexPath(doc, loaded, tenantId, overrides);
    } catch (err) {
      this.logger.warn(
        `[mergeQrWithAi] AI path threw for document=${doc.fileName}: ` +
          `${(err as Error).message}. Keeping QR fields alone.`,
      );
      aiFields = null;
    }

    // AI was attempted but produced no record at all (catastrophic
    // error in runAiOrRegexPath that bypassed the inner try/catch).
    // The QR is still authoritative; tag a warning so the operator
    // sees WHY supplier is null. The vision catch path is handled
    // below via the `aiRaw == null` check — `tryVisionAnalysis` already
    // swallows its own throws and returns null, which leaves
    // `lastVisionExtracted` unset (it's only set on a successful
    // analyze() return). So we additionally detect "vision attempted,
    // returned null" here.
    //
    // Source stays `at_qr+ai` — the AI WAS attempted, the user wants
    // every QR-decoded doc to flow through this merge path. The
    // `qr_only_ai_failed_supplier_may_be_null` warning flags the
    // missing supplier/IBAN/line-items explicitly so the operator
    // sees why those fields are null.
    if (!aiFields || this.lastVisionExtracted == null) {
      return {
        ...qrFields,
        source: "at_qr+ai",
        warnings: [
          ...(qrFields.warnings ?? []),
          "qr_only_ai_failed_supplier_may_be_null",
        ],
      };
    }

    // The raw vision payload — the AI's own JSON before the inner
    // `mergeVisionWithRegex` gated out low-confidence / fallback
    // numerics. When the AI DID return parseable JSON (even at low
    // confidence or with `fallbackUsed: true`), the supplier name /
    // IBAN / line-items / customer / suggestedCategory are usually
    // correct — we merge them in even when we trust the QR for the
    // fiscal numbers. This is the fix for the inconsistent QR+AI
    // merge where some photos got supplier=null and others got the
    // supplier filled: the AI always runs, even partial.
    //
    // Captured into a non-null local for TypeScript narrowing — the
    // class-field `lastVisionExtracted` would otherwise be typed as
    // `VisionExtractedFields | null` and `.supplier` would not type-
    // check below.
    const aiRaw: import("../ai/vision.service").VisionExtractedFields =
      this.lastVisionExtracted as import("../ai/vision.service").VisionExtractedFields;

    // Start from the QR's authoritative fields. For each one the QR
    // supplied (non-undefined / non-empty AND sane) keep the QR value;
    // for each one the QR left empty OR the AI supplied a saner value,
    // take the AI value.
    const merged: ExtractedFields = { ...qrFields };
    const aiHints: string[] = [];
    const aiWarnings: string[] = [];

    // ── QR-authoritative non-money fields ────────────────────────────
    // `supplierNif`, `customerNif`, `atcud`, `docDate`, `documentType`,
    // `currency` — QR is authoritative. The AI rarely disagrees on
    // these and even when it does the QR is the legal source of truth.
    // The money fields are reconciled in one deterministic pass below
    // (`reconcileMoneyTrio`), so the per-field branchy logic that used
    // to live here is gone.
    //
    // The previous "QR total untrusted → fall through to AI" branch
    // was the recurring source of the shuffled-fields bug: it would
    // take the AI's number for ONE of the trio (e.g. taxAmount=144.22)
    // while keeping the QR's `undefined` for the others (total=0,
    // net=0), leaving the row inconsistent. Now the reconciler takes
    // the union of all sources and enforces total ≈ net + tax in one
    // shot — no per-field assignment that can mis-shuffle.

    // ── AI-fills-the-gap fields ────────────────────────────────────
    // Prefer the raw vision payload over the regex-merged aiFields
    // for non-numeric fields (supplier / IBAN / lineItems / customer
    // / category / country). The inner `mergeVisionWithRegex` gates
    // these out when AI confidence < 0.6 or fallbackUsed is true, but
    // a partial AI response still produces correct supplier names
    // most of the time — the QR never carries supplier names, so we
    // MUST get them from somewhere. aiRaw is null when AI never
    // produced parseable JSON (no payload at all).
    const aiSupplier = aiRaw?.supplier ?? aiFields.supplier;
    const aiCustomer = aiRaw?.customer ?? aiFields.customer;
    const aiIban = aiRaw?.iban ?? aiFields.iban;
    const aiLineItems = aiRaw?.lineItems ?? aiFields.lineItems;
    const aiSuggestedCategory =
      aiRaw?.suggestedCategory ?? aiFields.suggestedCategory;
    const aiCashDiscountRate =
      aiRaw?.cashDiscountRate ?? aiFields.cashDiscountRate;
    const aiDiscountAmount =
      aiRaw?.discountAmount ?? aiFields.discountAmount;
    const aiCountry = aiRaw?.country ?? aiFields.country;
    const aiDueDate = aiRaw?.dueDate ?? aiFields.dueDate;
    const aiDocNumber = aiRaw?.docNumber ?? aiFields.docNumber;
    const aiIsEuIntracommunity =
      typeof aiRaw?.isEuIntracommunity === "boolean"
        ? aiRaw.isEuIntracommunity
        : aiFields.isEuIntracommunity;

    if (!merged.supplier && aiSupplier) {
      merged.supplier = aiSupplier;
      aiHints.push(`aiSupplier:${aiSupplier}`);
    }
    // ── AI-vs-QR mismatch logger (Sprint H+ extraction-fix-3) ────────
    // When the QR-A-field carries an authoritative issuer name that
    // disagrees with what AI Vision produced, emit a structured warning
    // so the operator can see the disagreement in the extraction log
    // even when no error fires. The 2026-09-06 ONNERA vs EDENOX bug
    // showed: AI reads the FILENAME (`NOV-OUSADO-LDA_*.pdf`) and
    // assumes that string is the supplier. The QR (when present)
    // would have said `ONNERA REFRIGERATION S.A.` — but the QR was
    // missing from that particular PDF so the safety net had to fire
    // from the filename heuristic instead. This logger is the
    // audit-trail hook that lets ops alert on recurring mismatch.
    const qrSupplierName = qrFields.supplier;
    if (
      qrSupplierName &&
      aiSupplier &&
      qrSupplierName.trim().toLowerCase() !== aiSupplier.trim().toLowerCase()
    ) {
      this.logger.warn(
        `[mergeQrWithAi] AI-vs-QR supplier name disagreement for document=${doc.fileName}: ` +
          `qr="${qrSupplierName}" vs ai="${aiSupplier}". ` +
          `QR is authoritative for fiscal data; AI wins on supplier name when QR has none. ` +
          `Both recorded in metadata.extraction.aiVsQrMismatch for the audit trail.`,
      );
      aiWarnings.push(
        `aiVsQrMismatch:supplier_name:qr=${qrSupplierName}:ai=${aiSupplier}`,
      );
    }
    // Also detect: AI supplier NIF == tenant NIF (the supplier slot is
    // pointing at the buyer / our own company). This is the same
    // wrong-side-up bug the filename heuristic catches, but here we
    // catch it from the structural side: if AI's supplier NIF matches
    // the tenant identity helper, the AI swapped the parties in its
    // own JSON. The downstream `ensureSupplierCustomerSanity` will
    // also catch this and swap, but logging it here gives us a
    // pre-emptive signal that runs even when the safety net short-
    // circuits (e.g. on a foreign-tenant NIF match).
    const aiSupplierNifRaw =
      aiRaw?.supplierNif ?? aiFields.supplierNif ?? undefined;
    if (aiSupplierNifRaw && tenantId) {
      try {
        const id = await getTenantIdentity(this.prisma, tenantId);
        const tenantNifNorm = normalizeTenantNif(id.tenantNif);
        const aiNifNorm = normalizeTenantNif(aiSupplierNifRaw);
        if (
          tenantNifNorm &&
          aiNifNorm &&
          tenantNifNorm === aiNifNorm
        ) {
          this.logger.warn(
            `[mergeQrWithAi] AI supplier NIF (${formatPtNif(aiNifNorm)}) matches tenant NIF — ` +
              `AI swapped supplier/customer in its own JSON. document=${doc.fileName}, ` +
              `aiSupplier="${aiSupplier ?? "?"}". Will be corrected by ensureSupplierCustomerSanity.`,
          );
          aiWarnings.push(
            `aiSupplierNifEqualsTenantNif:${aiNifNorm}`,
          );
        }
      } catch (err) {
        // Identity lookup is best-effort — never fail the extraction
        // because we couldn't read tenant NIF here.
        this.logger.debug(
          `[mergeQrWithAi] tenant identity lookup failed for tenant=${tenantId}: ` +
            `${(err as Error).message}. Skipping structural tenant-NIF check.`,
        );
      }
    }
    if (!merged.customer && aiCustomer) {
      merged.customer = aiCustomer;
    }
    // Fase 2 — an AI-read IBAN is only accepted when MOD-97 validates it;
    // a mistranscribed IBAN is worse than none (payment to the wrong account).
    if (!merged.iban && aiIban) {
      if (this.isValidIbanLocal(aiIban)) {
        merged.iban = aiIban;
      } else {
        aiWarnings.push(`ai_iban_rejected_mod97:${aiIban}`);
      }
      aiHints.push(`aiIban:${aiIban}`);
    }
    if (!merged.dueDate && aiDueDate) {
      merged.dueDate = aiDueDate;
    }
    // Doc number — the QR carries a parsed docNumber, but if the
    // AI saw a more complete label in the rendered text we keep
    // both in metadata and prefer the QR's on the row. No override.
    if (!merged.docNumber && aiDocNumber) {
      merged.docNumber = aiDocNumber;
    }
    // Line items — never on the QR path, AI is the only source.
    if (aiLineItems && aiLineItems.length > 0) {
      merged.lineItems = aiLineItems;
      aiHints.push(`aiLineItems:${aiLineItems.length}`);
    }
    if (typeof aiIsEuIntracommunity === "boolean") {
      merged.isEuIntracommunity = aiIsEuIntracommunity;
    }
    if (aiSuggestedCategory) {
      merged.suggestedCategory = aiSuggestedCategory;
      aiHints.push(`aiCategory:${aiSuggestedCategory}`);
    }
    if (typeof aiCashDiscountRate === "number") {
      merged.cashDiscountRate = aiCashDiscountRate;
    }
    if (typeof aiDiscountAmount === "number") {
      merged.discountAmount = aiDiscountAmount;
    }
    // Country / locale — QR doesn't carry these; take the AI's when
    // it has one. Useful for cross-border PT suppliers.
    if (!merged.country && aiCountry) {
      merged.country = aiCountry;
      merged.documentLocale = this.documentLocaleFor(aiCountry);
    }
    if (!merged.ibanCountry && aiFields.ibanCountry) {
      merged.ibanCountry = aiFields.ibanCountry;
    }

    // When the AI returned JSON but the inner merge gated out the
    // numeric fields (fallbackUsed=true → low confidence OR date-
    // shaped corruption), we want the operator to see that the
    // supplier / IBAN / line-items came from a partial AI pass —
    // not silently as if everything was perfect. The QR's fiscal
    // numbers stay authoritative; only the non-fiscal AI fields
    // are partial. needs_review is surfaced in composeMetadata.
    const aiPartial = !!aiRaw && (aiFields.source === "regex" || aiFields.source === "ocr");
    if (aiPartial) {
      aiWarnings.push(
        "ai_partial_response_used_for_supplier_iban_lines_qr_fiscal_authoritative",
      );
    }

    // Confidence — biased upward when AI agrees with QR on total,
    // or up to the AI's confidence when AI didn't get a chance to
    // disagree (since the QR confidence is 0.95 we never go below
    // that for QR+AI).
    const agreeTotal =
      merged.total != null &&
      aiFields.total != null &&
      Math.abs((aiFields.total ?? 0) - merged.total) < 0.01;
    const confidence = Math.min(
      0.99,
      Math.max(qrFields.confidence, aiFields.confidence ?? 0, agreeTotal ? 0.95 : 0),
    );

    // ── Money-trio reconciliation (the root-cause fix) ──────────────
    // Gather candidate values from BOTH the QR-authoritative merge
    // (qrFields) and the AI's own JSON extraction (aiFields). The
    // reconciler uses the union: it picks the pair with the smallest
    // reconciliation error, or — when present — the ivaBreakdown as the
    // ground truth (Σ base = net, Σ tax = tax, total = net + tax). This
    // is the single source of truth that prevents the photo-1 bug
    // (total=0 / net=0 / taxAmount=144.22) from regressing.
    //
    // We pass QR values where present, falling back to AI values where
    // QR left them missing. The reconciler's plausibility filter then
    // discards the implausible ones (0 / 1 / >1M / date-shaped) before
    // picking the best available pair. The result is always a single
    // self-consistent trio.
    const reconciled = this.reconcileMoneyTrio({
      total: qrFields.total ?? aiFields.total,
      taxAmount: qrFields.taxAmount ?? aiFields.taxAmount,
      netAmount: qrFields.netAmount ?? aiFields.netAmount,
      ivaBreakdown: qrFields.ivaBreakdown ?? aiFields.ivaBreakdown,
    });
    merged.total = reconciled.total;
    merged.taxAmount = reconciled.taxAmount;
    merged.netAmount = reconciled.netAmount;
    if (reconciled.reconciliationHint) {
      aiHints.push(`moneyTrio:${reconciled.reconciliationHint}`);
    }

    merged.confidence = confidence;
    merged.source = "at_qr+ai";

    // Provenance — preserve QR hints, append AI hints + warnings.
    merged.hints = [
      ...(qrFields.hints ?? []),
      ...(aiFields.hints ?? []),
      ...aiHints,
    ];
    merged.warnings = [
      ...(qrFields.warnings ?? []),
      ...(aiFields.warnings ?? []),
      ...aiWarnings,
    ];

    return merged;
  }

  /**
   * Map a QR-AT `D:` doc-type code onto the Prisma `DocumentType` enum.
   *
   * AT codes (per the AT-QR spec):
   *   FT / FR / FS  – fatura (issued/received, simplified)
   *   NC            – nota de crédito
   *   ND            – nota de débito
   *   RC / RG / RP  – recibo
   *
   * Unknown codes leave documentType undefined so the classifier can
   * still try the keyword path on the rest of the text.
   */
  private qrCodeToDocumentType(
    code: string | undefined,
  ): DocumentType | undefined {
    if (!code) return undefined;
    switch (code.toUpperCase()) {
      case "FT":
      case "FR":
      case "FS":
        return "FATURA_RECEBIDA";
      case "NC":
        return "NOTA_CREDITO";
      case "ND":
        return "NOTA_DEBITO";
      case "RC":
      case "RG":
      case "RP":
        return "RECIBO";
      default:
        return undefined;
    }
  }

  /**
   * Map an AI-extracted `documentType` string onto the Prisma
   * `DocumentType` enum. The AI emits labels in many shapes:
   *   - the exact enum form: "FATURA_RECEBIDA", "NOTA_CREDITO", ...
   *   - the snake-cased short form: "FATURA", "RECIBO", "ENCOMENDA", ...
   *   - the human label: "Fatura", "Fatura-recibo", "Recibo",
   *     "Nota de crédito", "Comprovativo", ...
   *   - cross-border labels: "Invoice", "Credit note", "Receipt",
   *     "Rechnung", "Gutschrift", ...
   *
   * The previous implementation sliced the first 2-3 uppercase letters
   * ("FAT") and tried to match them against the QR-AT code map — that
   * silently dropped every well-formed AI classification. We now
   * normalise (case + accents, stripped of separators) and look the
   * result up against the enum directly, with a small cross-border
   * synonym table to catch the human labels.
   *
   * For ambiguous cases ("FATURA" alone, with no received/issued
   * qualifier) we default to `FATURA_RECEBIDA` — this method only runs
   * inside the supplier-invoice extraction path, where "received" is
   * the right answer.
   *
   * Returns undefined for unrecognised strings so the operator's
   * manual classification (set at upload) is left untouched.
   */
  private aiDocumentTypeToEnum(
    raw: string | undefined,
  ): DocumentType | undefined {
    if (!raw) return undefined;
    const cleaned = raw
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "") // strip diacritics
      .replace(/[\s\-_]+/g, "_") // collapse separators into _
      .replace(/[^\w]/g, "")
      .toUpperCase()
      .trim();
    if (!cleaned) return undefined;

    // 1. Exact Prisma enum match — covers "FATURA_RECEBIDA",
    //    "NOTA_CREDITO", "GUIA_TRANSPORTE", ...
    const enumValues = Object.values(DocumentType) as string[];
    if (enumValues.includes(cleaned)) {
      return cleaned as DocumentType;
    }

    // 2. Short / human form → enum mapping. Order matters: the more
    //    specific (NC / ND / RECIBO / etc.) come before the generic
    //    "FATURA" so we don't misclassify a credit note as an invoice.
    const aliasMap: Record<string, DocumentType> = {
      // Fase 3 — non-fiscal / simplified kinds the vision model may name.
      PRO_FORMA: DocumentType.PROFORMA,
      PROFORMA_INVOICE: DocumentType.PROFORMA,
      FATURA_PROFORMA: DocumentType.PROFORMA,
      FATURA_PRO_FORMA: DocumentType.PROFORMA,
      QUOTATION: DocumentType.ORCAMENTO,
      QUOTE: DocumentType.ORCAMENTO,
      DEVIS: DocumentType.ORCAMENTO,
      PRESUPUESTO: DocumentType.ORCAMENTO,
      AVISO: DocumentType.AVISO_PAGAMENTO,
      AVISO_DE_PAGAMENTO: DocumentType.AVISO_PAGAMENTO,
      PAYMENT_NOTICE: DocumentType.AVISO_PAGAMENTO,
      EXTRATO: DocumentType.EXTRATO_FORNECEDOR,
      EXTRATO_DE_CONTA: DocumentType.EXTRATO_FORNECEDOR,
      ACCOUNT_STATEMENT: DocumentType.EXTRATO_FORNECEDOR,
      STATEMENT: DocumentType.EXTRATO_FORNECEDOR,
      FS: DocumentType.FATURA_SIMPLIFICADA,
      FATURA_SIMPLIFICADA: DocumentType.FATURA_SIMPLIFICADA,
      SIMPLIFIED_INVOICE: DocumentType.FATURA_SIMPLIFICADA,
      // Credit notes / debit notes — must precede FATURA.
      NC: DocumentType.NOTA_CREDITO,
      NOTA_CREDITO: DocumentType.NOTA_CREDITO,
      CREDIT_NOTE: DocumentType.NOTA_CREDITO,
      GUTSCHRIFT: DocumentType.NOTA_CREDITO,
      GUTSCHRIFTSRECHNUNG: DocumentType.NOTA_CREDITO,
      AVOIR: DocumentType.NOTA_CREDITO,
      NOTA_DE_CREDITO: DocumentType.NOTA_CREDITO,
      // Fase 4.2 (P1.3) — sinónimos em falta: "nota de abono" (PT) e
      // "factura rectificativa" (ES, quando o valor rectificado é
      // negativo — a versão positiva é só uma correção de dados).
      NOTA_DE_ABONO: DocumentType.NOTA_CREDITO,
      NOTA_ABONO: DocumentType.NOTA_CREDITO,
      FACTURA_RECTIFICATIVA: DocumentType.NOTA_CREDITO,
      FATURA_RETIFICATIVA: DocumentType.NOTA_CREDITO,
      ND: DocumentType.NOTA_DEBITO,
      NOTA_DEBITO: DocumentType.NOTA_DEBITO,
      DEBIT_NOTE: DocumentType.NOTA_DEBITO,
      BELASTUNGSANZEIGE: DocumentType.NOTA_DEBITO,
      // Receipts.
      RC: DocumentType.RECIBO,
      RECIBO: DocumentType.RECIBO,
      RECIBO_VENCIMENTOS: DocumentType.RECIBO,
      RECEIPT: DocumentType.RECIBO,
      QUITTUNG: DocumentType.RECIBO,
      QUITTANCE: DocumentType.RECIBO,
      RICEVUTA: DocumentType.RECIBO,
      RECU: DocumentType.RECIBO,
      // Invoices — short form defaults to RECEIVED because this helper
      // only runs on the supplier-invoice (received) extraction path.
      FT: DocumentType.FATURA_RECEBIDA,
      FR: DocumentType.FATURA_RECEBIDA,
      FATURA: DocumentType.FATURA_RECEBIDA,
      FATURA_RECEBIDA: DocumentType.FATURA_RECEBIDA,
      FACTURA: DocumentType.FATURA_RECEBIDA,
      FACTURE: DocumentType.FATURA_RECEBIDA,
      INVOICE: DocumentType.FATURA_RECEBIDA,
      RECHNUNG: DocumentType.FATURA_RECEBIDA,
      FATTURA: DocumentType.FATURA_RECEBIDA,
      // Issued (rare from the AI on a received-invoice path but possible).
      FATURA_EMITIDA: DocumentType.FATURA_EMITIDA,
      FACTURE_EMISE: DocumentType.FATURA_EMITIDA,
      // Other PT documents.
      COMPROVATIVO: DocumentType.COMPROVATIVO,
      PROOF_OF_PAYMENT: DocumentType.COMPROVATIVO,
      ENCOMENDA: DocumentType.ENCOMENDA,
      ORDER: DocumentType.ENCOMENDA,
      BON_DE_COMMANDE: DocumentType.ENCOMENDA,
      CONFIRMACAO_DE_ENCOMENDA: DocumentType.ENCOMENDA,
      CONFIRMACAO_ENCOMENDA: DocumentType.ENCOMENDA,
      CONFIRMACION_DE_PEDIDO: DocumentType.ENCOMENDA,
      CONFIRMACION_PEDIDO: DocumentType.ENCOMENDA,
      ORDER_CONFIRMATION: DocumentType.ENCOMENDA,
      PURCHASE_ORDER: DocumentType.ENCOMENDA,
      NOTA_DE_ENCOMENDA: DocumentType.ENCOMENDA,
      NOTA_ENCOMENDA: DocumentType.ENCOMENDA,
      ORDEM_DE_ENCOMENDA: DocumentType.ENCOMENDA,
      PEDIDO_DE_COMPRA: DocumentType.ENCOMENDA,
      PEDIDO: DocumentType.ENCOMENDA,
      GUIA_TRANSPORTE: DocumentType.GUIA_TRANSPORTE,
      GUIA_DE_TRANSPORTE: DocumentType.GUIA_TRANSPORTE,
      DELIVERY_NOTE: DocumentType.GUIA_TRANSPORTE,
      TRANSPORTE: DocumentType.GUIA_TRANSPORTE,
      CMR: DocumentType.GUIA_TRANSPORTE,
      PACKING_SLIP: DocumentType.GUIA_TRANSPORTE,
    };
    if (aliasMap[cleaned]) return aliasMap[cleaned];

    // 3. Loose keyword scan — reuse the regex-classifier vocabulary
    //    so a verbose label ("Fatura-Recibo n.º FT 2026/1") still
    //    resolves. Order matters: nota de crédito / débito, recibo,
    //    encomenda before generic fatura.
    const lower = cleaned.toLowerCase();
    if (
      /(nota.{0,3}credito|nota.{0,3}abono|credit.{0,3}note|gutschrift|avoir|(fa[ct]tura|factura).{0,3}rect)/.test(
        lower,
      )
    ) {
      return DocumentType.NOTA_CREDITO;
    }
    if (/(nota.{0,3}debito|debit.{0,3}note|belastungsanzeige)/.test(lower)) {
      return DocumentType.NOTA_DEBITO;
    }
    if (
      /(recibo|receipt|quittung|quittance|ricevuta|recu)/.test(lower)
    ) {
      return DocumentType.RECIBO;
    }
    if (/(confirma[çc][ãa]o.{0,10}encomenda|confirma[çc][ií]on.{0,10}pedido|order.{0,5}confirmation|nota.{0,5}encomenda|encomenda|purchase.{0,5}order|pedido.{0,5}compra|order|bon.de.commande)/.test(lower)) {
      return DocumentType.ENCOMENDA;
    }
    if (
      /(fatura|fatura.?recibo|fatura.?recebida|fatura.?emitida|factura|facture|invoice|rechnung|fattura)/.test(
        lower,
      )
    ) {
      return DocumentType.FATURA_RECEBIDA;
    }
    if (/(comprovativo|proof.of.payment)/.test(lower)) {
      return DocumentType.COMPROVATIVO;
    }
    if (/(guia.{0,3}transporte|delivery.note|cmr|packing.slip)/.test(lower)) {
      return DocumentType.GUIA_TRANSPORTE;
    }

    // Unknown — leave documentType untouched so the operator's manual
    // pick (or the existing row value) is preserved.
    return undefined;
  }

  /**
   * Lightweight keyword classifier — runs only on the regex/OCR path
   * (not on QR-AT, where the D: code is authoritative).
   *
   * Returns undefined when no keyword matches, so `buildUpdateData`
   * leaves `doc.type` untouched. This is deliberate: the user might
   * have set the type manually at upload (e.g. "I know this is a
   * recibo") and we shouldn't overwrite that guess without evidence.
   *
   * Keyword map is intentionally narrow — only labels with strong
   * signal in real invoices. PT is the default; we add EN/DE/ES/FR
   * variants because cross-border invoices are common.
   */
  private classifyDocumentType(text: string): DocumentType | undefined {
    if (!text) return undefined;
    const lower = text.toLowerCase();

    // Order matters: more specific (nota de crédito/débito) before the
    // generic "fatura" so we don't classify a credit note as a fatura.
    const rules: Array<{ pattern: RegExp; type: DocumentType }> = [
      // Credit notes — match before generic invoices.
      {
        pattern:
          /\b(nota\s*(?:de\s*)?cr[eé]dito|nota\s*de\s*cr[eé]dito|credit\s*note|gutschrift(?:-srechnung)?|avoir)\b/i,
        type: "NOTA_CREDITO",
      },
      // Debit notes.
      {
        pattern:
          /\b(nota\s*(?:de\s*)?d[eé]bito|nota\s*de\s*d[eé]bito|debit\s*note|belastungsanzeige)\b/i,
        type: "NOTA_DEBITO",
      },
      // Receipts.
      {
        pattern:
          /\b(recibo|receipt|quittung|quittance|ricevuta|reçu|recibo\s*de\s*vencimentos)\b/i,
        type: "RECIBO",
      },
      // Purchase orders & Order confirmations (match before generic invoice).
      {
        pattern:
          /\b(confirma[çc][ãa]o\s*(?:de\s*)?encomenda|confirma[çc][ií]on\s*(?:de\s*)?pedido|order\s*confirmation|nota\s*de\s*encomenda|ordem\s*de\s*encomenda|pedido\s*de\s*compra|purchase\s*order|bon\s*de\s*commande|bestellung|bestellbest[aä]tigung)\b/i,
        type: "ENCOMENDA",
      },
      // Invoices (most general — checked last so it doesn't swallow NC/ND/RC/ENCOMENDA).
      {
        pattern:
          /\b(fatura(?:\s*recebida|\s+recebida)?|factura|facture|invoice|rechnung|fattura)\b/i,
        type: "FATURA_RECEBIDA",
      },
    ];
    for (const { pattern, type } of rules) {
      if (pattern.test(lower)) {
        return type;
      }
    }
    return undefined;
  }

  /**
   * OCR-with-regex extraction path. The heavy lifting (PDF text layer
   * parsing, tesseract for images, `needs_manual_ocr` flagging) is now
   * done up front by `loadDocumentText`. By the time we reach here,
   * `preloadedText` already represents the best text the system could
   * pull from the file — either the PDF text layer, the OCR result,
   * the file name, or an empty string for an unprocessable file.
   *
   * The function's only job is to feed that text to the regex layer
   * and label the hints accordingly. We keep the method name
   * (`extractWithOcrFallback`) for compatibility with the public API.
   */
  async extractWithOcrFallback(
    doc: { fileKey: string; mimeType: string; fileName: string },
    preloadedText: string,
  ): Promise<ExtractedFields> {
    if (preloadedText) {
      return this.regexExtraction(preloadedText, ["source:pdf_text_or_ocr"]);
    }
    this.logger.warn(
      `extractWithOcrFallback: no text for ${doc.fileName} ` +
        `(mime=${doc.mimeType}) — regex path will run on empty input`,
    );
    return this.regexExtraction("", ["source:none"]);
  }

  /**
   * Heuristic regex extraction. Order:
   *   1) AT-QR (if a candidate line slipped through) — re-parse.
   *   2) Portuguese NIF or country-aware foreign VAT ID.
   *   3) Document number + dates.
   *   4) Dates, totals and VAT using the detected document locale.
   *   5) Any ISO 13616 IBAN, validated with MOD-97.
   *
   * Confidence is the sum of field hits, capped at 0.85 (heuristic
   * ceiling — QR path uses 0.95).
   */
  regexExtraction(text: string, baseHints: string[]): ExtractedFields {
    const hints: string[] = [...baseHints];
    const warnings: string[] = [];
    const normalized = (text ?? "").replace(/\r/g, "\n");

    // 1) AT-QR — defense-in-depth: re-check inside regex path.
    const qrLine = this.findAtQrInText(normalized);
    if (qrLine) {
      const parsed = parseAtQr(qrLine.replace(/\s+/g, ""));
      if (parsed) {
        return this.extractFromQr(qrLine, { type: "OUTRO" });
      }
    }

    // 2) NIF — preserve the Portuguese validation path first.
    let nif: string | undefined;
    let customerNifFromRegex: string | undefined;
    const nifRegex = /(?:NIF|N\.?\s*I\.?\s*F\.?|N\.?º?\s*Contr(?:ib(?:uinte)?)?\.?|Contr(?:ib(?:uinte)?)?\.?|NIPC)[:\s]*(?:PT)?(\d{9})\b/gi;
    const matchedNifs: string[] = [];
    let nifMatch: RegExpExecArray | null;
    while ((nifMatch = nifRegex.exec(normalized)) !== null) {
      const candidate = normalizeNif(nifMatch[1]);
      if (isValidNif(candidate) && !matchedNifs.includes(candidate)) {
        matchedNifs.push(candidate);
      }
    }

    if (matchedNifs.length > 0) {
      nif = matchedNifs[0];
      hints.push(`nif:${nif}`);
      if (matchedNifs.length > 1) {
        customerNifFromRegex = matchedNifs[1];
        hints.push(`customerNif:${customerNifFromRegex}`);
      }
    } else {
      const naked = normalized.match(/\b([1235689]\d{8})\b/);
      if (naked && isValidNif(naked[1])) {
        nif = normalizeNif(naked[1]);
        hints.push(`nif:${nif}`);
      }
    }

    // Foreign VAT IDs are deliberately syntax-validated only: online VIES
    // validation is not safe for an offline OCR path. Country-specific formats
    // prevent arbitrary alphanumeric invoice numbers from being stored as VAT.
    const foreignVat = this.findForeignVatId(normalized);
    const supplierVatId = nif ?? foreignVat?.value;
    const country = foreignVat?.country ?? (nif ? "PT" : undefined);
    const documentLocale = this.documentLocaleFor(country);
    const currency = this.detectCurrency(normalized);
    const dateCountry = country ?? this.countryForCurrency(currency);
    if (foreignVat) hints.push(`vat:${foreignVat.value}`);

    // 3) Document number.
    //
    // Real Portuguese invoices look like `Fatura FT 2026/123`:
    //   - `Fatura` is the doc-type label (covered separately by the
    //     type classifier — see below)
    //   - `FT 2026/123` is the actual invoice number: a 1-3 letter
    //     series + space + year + `/` + sequence (or hyphen)
    //
    // The previous regex `([A-Z0-9\/\-]{1,40})` greedily captured only
    // the first run of letters (e.g. `FT`) and stopped at the space —
    // so `Fatura FT 2026/123` came out as `FT`. We now capture the
    // full series + digits-with-separators as one token, e.g.
    // `FT 2026/123`, `FR 2026/45`, `A/1234`, `2026/123`. We try a
    // sequence of patterns and keep the first hit.
    const docNumberPatterns: RegExp[] = [
      // After a doc-type label: capture series + year/sequence.
      /(?:Fatura|Factura|FT|Facture|Rechnung|Invoice|Receipt|Recibo|N[ºo°]\s*(?:Fatura|FT)?|Documento)\s+((?:[A-Z]{1,3}[\s\-]?\d{4}[\/\-]\d{1,6}|\d{4}[\/\-]\d{1,6}|[A-Z][\/\-]\d{1,6}|[A-Z0-9]{3,40}))/i,
      // `N.º` style with series.
      /N[ºo°]\s*((?:[A-Z]{1,3}\s*\d+[\/\-]\d+|\d+[\/\-]\d+))/i,
      // Bare series `FT 2026/123` with no preceding label.
      /\b((?:[A-Z]{1,3}[\s\-]?\d{4}[\/\-]\d{1,6}|[A-Z][\/\-]\d{1,6}|[A-Z]{1,3}\s\d{4,}\b))/,
    ];
    let docNumber: string | undefined;
    for (const re of docNumberPatterns) {
      const m = normalized.match(re);
      if (m && m[1]) {
        docNumber = m[1].replace(/\s+/g, " ").trim();
        // Guard against picking up an accidental date-only token like
        // "2026/03/15" — that belongs to docDate, not docNumber.
        if (/^\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2}$/.test(docNumber)) continue;
        break;
      }
    }
    if (docNumber) hints.push(`docNumber:${docNumber}`);

    // 4) Dates — accept ISO, DMY and MDY. Ambiguous numeric dates retain a
    // deterministic locale-aware interpretation and are explicitly flagged.
    const dateAll = [
      ...normalized.matchAll(
        /\b(\d{4})-(\d{1,2})-(\d{1,2})\b|\b(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})\b/g,
      ),
    ];
    let docDate: string | undefined;
    let dueDate: string | undefined;
    if (dateAll.length) {
      const parsedDate = this.parseInvoiceDate(
        dateAll[0],
        dateCountry,
        warnings,
      );
      docDate = parsedDate;
      if (docDate) hints.push(`docDate:${docDate}`);
    }
    const dueLabel = normalized.match(
      /(?:Vencimento|Vencimiento|Fecha\s*de\s*vencimiento|F\.?\s*Vto|Vto\.?|Data\s*limite|Due\s*date|F[aä]llig(?:keit)?|[ÉE]ch[ée]ance)[:\s]*(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[\/\.\-]\d{1,2}[\/\.\-]\d{4})/i,
    );
    if (dueLabel) {
      const dateText = dueLabel[1];
      const dueMatch = [
        ...dateText.matchAll(
          /^(\d{4})-(\d{1,2})-(\d{1,2})$|^(\d{1,2})[\/\.\-](\d{1,2})[\/\.\-](\d{4})$/g,
        ),
      ][0];
      dueDate = dueMatch
        ? this.parseInvoiceDate(dueMatch, dateCountry, warnings)
        : undefined;
      if (dueDate) hints.push(`dueDate:${dueDate}`);
    }

    // If no absolute due date was found, calculate from payment terms (e.g. "Forma de Pago: 30 DÍAS")
    if (!dueDate && docDate) {
      const paymentTermMatch = normalized.match(
        /(?:Forma\s*de\s*pago|Condi[çc][õo]es?\s*de\s*pagamento|Forma\s*de\s*pagamento|Prazo\s*de\s*pagamento|Condiciones\s*de\s*pago|Pagamento\s*a|Payment\s*terms|Net)[:\s]*(\d{1,3})\s*(?:d[ií]as?|days?)/i,
      );
      if (paymentTermMatch) {
        const days = parseInt(paymentTermMatch[1], 10);
        if (Number.isFinite(days) && days > 0 && days <= 365) {
          const d = new Date(docDate);
          d.setDate(d.getDate() + days);
          dueDate = d.toISOString().slice(0, 10);
          hints.push(`dueDate:${dueDate}`);
        }
      } else if (
        /(?:Forma\s*de\s*pago|Forma\s*de\s*pagamento)[:\s]*(?:Pronto\s*pagamento|A\s*pronto|Contado|Al\s*contado|Immediate)\b/i.test(
          normalized,
        )
      ) {
        dueDate = docDate;
        hints.push(`dueDate:${dueDate}`);
      }
    }

    // 5) Totals + VAT — both 1.234,56 and 1,234.56 are common on invoices.
    const totalMatch =
      normalized.match(
        /(?:Total\s*(?:a\s*pagar|il[ií]quido|com\s*IVA)?|Total\s*GERAL|Amount\s*due|Gesamtbetrag|Montant\s*TTC|TOTAL)\s*[:\-]?\s*(?:EUR|GBP|USD|CHF|€|£|\$)?\s*([\d][\d\s.,']*)/i,
      ) ??
      normalized.match(
        /TOTAL\s*[:\-]?\s*(?:EUR|GBP|USD|CHF|€|£|\$)?\s*([\d][\d\s.,']*)/i,
      );
    const ivaMatch = normalized.match(
      /(?:IVA|VAT|I\.V\.A\.|MwSt\.?|TVA)(?:\s*\(?\d+(?:[.,]\d+)?\s*%?\)?)?\s*[:\-]?\s*(?:EUR|GBP|USD|CHF|€|£|\$)?\s*([\d][\d\s.,']*)/i,
    );
    const total = this.parseInvoiceAmount(totalMatch?.[1]);
    const iva = this.parseInvoiceAmount(ivaMatch?.[1]);
    // Money-trio reconciliation on the regex path too. Same invariant
    // (total ≈ net + tax) as the QR/AI paths so a regex-only result
    // also lands a self-consistent trio in the database. The
    // reconciler handles the "regex captured only total" / "regex
    // captured only IVA" / "regex captured both" cases the same way
    // as the QR/AI paths — derive the missing field from the pair.
    const reconciledMoney = this.reconcileMoneyTrio({
      total,
      taxAmount: iva,
      netAmount: undefined,
    });
    const reconciledTotal = reconciledMoney.total;
    const reconciledTax = reconciledMoney.taxAmount;
    const reconciledNet = reconciledMoney.netAmount;
    const taxRate =
      reconciledNet != null && reconciledTax != null && reconciledNet > 0
        ? Number(((reconciledTax / reconciledNet) * 100).toFixed(2))
        : undefined;
    if (reconciledTotal != null) hints.push(`total:${reconciledTotal}`);
    if (reconciledTax != null) hints.push(`iva:${reconciledTax}`);
    if (taxRate != null) hints.push(`taxRate:${taxRate}`);

    // 6) IBAN — scan all ISO country prefixes, then rely on shared MOD-97.
    // Allow internal whitespace and group separators; we normalise + revalidate.
    //
    // Each candidate we try (whether it passes or not) is recorded in
    // `ibanCandidates` so the operator can debug "the PDF has IBAN
    // text but extraction returned null" cases — they can see what
    // shapes the regex matched and why each one failed MOD-97.
    let iban: string | undefined;
    let ibanCountry: string | undefined;
    const ibanCandidates: Array<{
      raw: string;
      normalized: string;
      valid: boolean;
    }> = [];
    const ibanMatches = normalized.matchAll(
      /\b[A-Z]{2}\s?\d{2}(?:[\s.\-]?[A-Z0-9]){10,30}\b/gi,
    );
    for (const match of ibanMatches) {
      const raw = match[0];
      const candidate = normalizeIban(raw);
      const valid = isValidIban(candidate);
      ibanCandidates.push({ raw, normalized: candidate, valid });
      if (valid) {
        iban = candidate;
        ibanCountry = candidate.slice(0, 2);
        hints.push(`iban:${iban}`);
        break;
      } else {
        warnings.push(`iban_invalid:${candidate}`);
      }
    }

    // Detect a label-only or partial IBAN slot — "IBAN:", "IBAN", or
    // "IBAN: PT50..." followed by something too short to be a valid
    // IBAN. Almost always a truncated PDF where the IBAN ran off the
    // page (or a PDF generator that forgot to write the value).
    // Surface it as a warning so the operator can re-upload or
    // hand-OCR the file instead of silently seeing null.
    const labelOnlyMatch = normalized.match(
      /\b(?:IBAN|Iban|iban)\b\s*[:\-]?\s*([A-Z0-9\s.\-]{0,40})?$/im,
    );
    if (!iban && labelOnlyMatch) {
      const tail = (labelOnlyMatch[1] ?? "").replace(/\s/g, "");
      const looksLikePartialIban = /^[A-Z]{2}\d{0,10}$/.test(tail);
      const isBareLabel = tail.length === 0;
      if (isBareLabel || looksLikePartialIban) {
        warnings.push(
          tail.length === 0
            ? "iban_label_only_truncated"
            : `iban_truncated:${tail}`,
        );
      }
    }

    // Supplier name (informational only — QR path leaves it empty).
    const supplierLine = normalized.match(
      /(?:Fornecedor|Emitente|De|From)[:\s]+([^\n]{3,120})/i,
    );
    const supplier = supplierLine?.[1]?.trim().slice(0, 120);
    if (supplier) hints.push(`supplier:${supplier}`);

    // Document type — keyword-based classifier. Only sets the field when
    // there's a strong signal (one of the recognised labels). The QR
    // path is authoritative and never reaches here, but for safety
    // we still gate on a hit so we don't overwrite a user-set type.
    const documentType = this.classifyDocumentType(normalized);
    if (documentType) hints.push(`documentType:${documentType}`);

    // Confidence accumulator — capped at 0.85.
    let confidence = 0.2;
    if (supplierVatId) confidence += 0.25;
    if (total != null) confidence += 0.2;
    if (docNumber) confidence += 0.1;
    if (docDate) confidence += 0.1;
    if (iva != null) confidence += 0.05;
    if (iban) confidence += 0.05;
    confidence = Math.min(confidence, 0.85);

    return {
      supplierNif: supplierVatId,
      supplierVatId,
      customerNif: customerNifFromRegex,
      supplier,
      customer: undefined,
      docNumber,
      atcud: undefined,
      docDate,
      dueDate,
      total: reconciledTotal,
      taxAmount: reconciledTax,
      netAmount: reconciledNet,
      iban,
      currency,
      country: country ?? ibanCountry,
      documentLocale: this.documentLocaleFor(country ?? ibanCountry),
      ibanCountry,
      taxRate,
      documentType,
      confidence,
      // `source` is widened to include `"ai"` — the merge step in
      // `runAiOrRegexPath` rewrites this to "ai" when the LLM ran.
      source: (iban || reconciledTotal || supplierVatId ? "ocr" : "regex") as
        | "ocr"
        | "regex",
      hints,
      warnings,
      ibanCandidates: ibanCandidates.length > 0 ? ibanCandidates : undefined,
    } as ExtractedFields;
  }

  // -------------------------------------------------------------------------
  // IBAN anti-fraud
  // -------------------------------------------------------------------------

  /**
   * Compare the extracted IBAN against the Party's known IBAN history
   * (`IbanHistory` rows). Flags a mismatch as potential fraud and writes
   * a history entry tagged with the originating Document so the audit
   * trail stays complete.
   *
   * Rules:
   *   - IBAN fails ISO MOD-97               → flag (invalid)
   *   - IBAN matches `party.iban`           → ok (no history write)
   *   - IBAN appears in `IbanHistory`       → ok (no flag, no history)
   *   - IBAN is new for this party          → flag (anomaly) + history
   */
  async checkIbanAgainstParty(
    tenantId: string,
    partyId: string,
    extractedIban: string,
    userId: string | null,
    previousDocumentIban?: string | null,
  ): Promise<IbanCheckResult> {
    const normalized = normalizeIban(extractedIban);
    const reasons: string[] = [];
    let flagged = false;

    if (!isValidIban(normalized)) {
      reasons.push("iban_invalid_format");
      flagged = true;
    }

    const party = await this.prisma.party.findFirst({
      where: { id: partyId, tenantId },
      select: { id: true, iban: true },
    });

    const partyIban = party?.iban ? normalizeIban(party.iban) : null;
    const matchesPartyIban = !!partyIban && partyIban === normalized;

    const history = await this.prisma.ibanHistory.findMany({
      where: { tenantId, partyId },
      select: { newIban: true },
      orderBy: { createdAt: "desc" },
      take: 25,
    });
    const knownIbans = new Set(
      history.map((h) => normalizeIban(h.newIban)).filter((v) => !!v),
    );
    if (partyIban) knownIbans.add(partyIban);
    const knownIbanForParty = knownIbans.has(normalized);

    if (!matchesPartyIban && !knownIbanForParty) {
      reasons.push("iban_not_in_party_history");
      flagged = true;
    }
    if (
      previousDocumentIban &&
      normalizeIban(previousDocumentIban) !== normalized &&
      !matchesPartyIban
    ) {
      reasons.push("iban_changed_since_last_doc");
    }

    // Persist a history row only for new or mismatched IBANs.
    if (flagged || (!matchesPartyIban && !knownIbanForParty)) {
      try {
        await this.prisma.ibanHistory.create({
          data: {
            tenantId,
            partyId,
            oldIban: partyIban ?? previousDocumentIban ?? null,
            newIban: normalized,
            changedById: userId ?? null,
            reason: reasons.join(",") || "extracted_iban",
            verified: false,
          },
        });
      } catch (err) {
        this.logger.warn(
          `Could not write IbanHistory row: ${(err as Error).message}`,
        );
      }
    }

    return {
      ok: !flagged,
      iban: normalized,
      isValidIban: isValidIban(normalized),
      matchesPartyIban,
      knownIbanForParty,
      flagged,
      reasons,
      historyCount: history.length,
    };
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** Return the first plausible AT-QR candidate line in `text`, if any. */
  private findAtQrInText(text: string): string | null {
    if (!text) return null;
    const line = text
      .split(/\n/)
      .map((l) => l.trim())
      .find((l) => /A:\d{9}/.test(l) && l.includes("*"));
    if (line) return line;
    const compact = text.replace(/\s+/g, "");
    return /A:\d{9}/.test(compact) && compact.includes("*") ? compact : null;
  }

  /** VIES syntax rules. These validate document shape, not VAT registration. */
  private findForeignVatId(
    text: string,
  ): { value: string; country: string } | undefined {
    const patterns: Record<string, RegExp> = {
      AT: /^ATU\d{8}$/,
      BE: /^BE\d{10}$/,
      BG: /^BG\d{9,10}$/,
      CY: /^CY\d{8}[A-Z]$/,
      CZ: /^CZ\d{8,10}$/,
      DE: /^DE\d{9}$/,
      DK: /^DK\d{8}$/,
      EE: /^EE\d{9}$/,
      ES: /^ES[A-Z0-9]\d{7}[A-Z0-9]$/,
      FI: /^FI\d{8}$/,
      FR: /^FR[A-Z0-9]{2}\d{9}$/,
      GR: /^(?:GR|EL)\d{9}$/,
      HR: /^HR\d{11}$/,
      HU: /^HU\d{8}$/,
      IE: /^IE\d{7}[A-Z0-9]{1,2}$/,
      IT: /^IT\d{11}$/,
      LT: /^LT(?:\d{9}|\d{12})$/,
      LU: /^LU\d{8}$/,
      LV: /^LV\d{11}$/,
      MT: /^MT\d{8}$/,
      NL: /^NL\d{9}B\d{2}$/,
      PL: /^PL\d{10}$/,
      RO: /^RO\d{2,10}$/,
      SE: /^SE\d{12}$/,
      SI: /^SI\d{8}$/,
      SK: /^SK\d{10}$/,
      GB: /^GB(?:\d{9}|\d{12}|GD\d{3}|HA\d{3})$/,
    };
    const labelled = text.matchAll(
      /(?:VAT(?:\s*(?:No\.?|ID))?|Tax\s*ID|USt-?IdNr\.?|N[ºo]\s*TVA|C\.?I\.?F\.?)\s*[:#-]?\s*([A-Z]{2}[- ]?[A-Z0-9][- ]?[0-9]{7}[A-Z0-9]?|[A-Z]{2}[A-Z0-9-]{7,14})\b/gi,
    );
    const candidates = [...labelled].map((match) => match[1]);

    // Spanish CIF without ES prefix (e.g. C.I.F. A-14219836 or CIF A14219836)
    const cifWithoutCountry = text.matchAll(
      /(?:C\.?I\.?F\.?)\s*[:#-]?\s*([A-Z][- ]?\d{7}[- ]?[A-Z0-9])\b/gi,
    );
    for (const match of cifWithoutCountry) {
      candidates.push(`ES${match[1]}`);
    }

    candidates.push(
      ...[
        ...text.matchAll(
          /\b(?:ATU\d{8}|(?:BE|BG|CY|CZ|DE|DK|EE|ES|FI|FR|GR|EL|HR|HU|IE|IT|LT|LU|LV|MT|NL|PL|RO|SE|SI|SK|GB)[- ]?[A-Z0-9][- ]?[0-9]{6,12}[A-Z0-9]?)\b/gi,
        ),
      ].map((match) => match[0]),
    );
    for (const raw of candidates) {
      const value = raw.replace(/[ .-]/g, "").toUpperCase();
      const country = value.slice(0, 2) === "EL" ? "GR" : value.slice(0, 2);
      if (country !== "PT" && patterns[country]?.test(value))
        return { value, country };
    }
    return undefined;
  }

  private parseInvoiceAmount(value?: string): number | undefined {
    if (!value) return undefined;
    const compact = value.replace(/[\s']/g, "");
    const lastComma = compact.lastIndexOf(",");
    const lastDot = compact.lastIndexOf(".");
    let normalized = compact;
    if (lastComma !== -1 && lastDot !== -1) {
      const decimal = lastComma > lastDot ? "," : ".";
      normalized = compact
        .replace(decimal === "," ? /\./g : /,/g, "")
        .replace(decimal, ".");
    } else if (lastComma !== -1 || lastDot !== -1) {
      const separator = lastComma !== -1 ? "," : ".";
      const digitsAfter = compact.length - compact.lastIndexOf(separator) - 1;
      // A single separator followed by exactly three digits is a thousands
      // separator; every other single separator is treated as decimal.
      normalized =
        digitsAfter === 3
          ? compact.replace(new RegExp(`\\${separator}`, "g"), "")
          : compact.replace(separator, ".");
    }
    const parsed = Number.parseFloat(normalized);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  private parseInvoiceDate(
    match: RegExpMatchArray,
    country: string | undefined,
    warnings: string[],
  ): string | undefined {
    const [, isoYear, isoMonth, isoDay, first, second, year] = match;
    let y: string;
    let month: string;
    let day: string;
    if (isoYear) {
      [y, month, day] = [isoYear, isoMonth, isoDay];
    } else {
      if (!first || !second || !year) return undefined;
      const firstNumber = Number(first);
      const secondNumber = Number(second);
      const isMdy =
        country === "US" || (firstNumber <= 12 && secondNumber > 12);
      if (firstNumber <= 12 && secondNumber <= 12)
        warnings.push(`date_ambiguous:${first}/${second}/${year}`);
      [y, month, day] = isMdy ? [year, first, second] : [year, second, first];
    }
    const parsed = new Date(
      `${y}-${month.padStart(2, "0")}-${day.padStart(2, "0")}T00:00:00.000Z`,
    );
    return !Number.isNaN(parsed.getTime()) &&
      parsed.getUTCFullYear() === Number(y)
      ? `${y}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`
      : undefined;
  }

  private detectCurrency(text: string): string {
    if (/\bGBP\b|£/.test(text)) return "GBP";
    if (/\bUSD\b|\$/.test(text)) return "USD";
    if (/\bCHF\b|\bSFr\.?\b/i.test(text)) return "CHF";
    return "EUR";
  }

  private documentLocaleFor(country?: string): string | undefined {
    const locales: Record<string, string> = {
      PT: "pt-PT",
      ES: "es-ES",
      DE: "de-DE",
      FR: "fr-FR",
      GB: "en-GB",
      IE: "en-IE",
    };
    return country
      ? (locales[country] ?? `${country.toLowerCase()}-${country}`)
      : undefined;
  }

  private countryForCurrency(currency: string): string | undefined {
    return (
      { GBP: "GB", USD: "US", CHF: "CH" } as Record<string, string | undefined>
    )[currency];
  }

  private computeNet(total?: number, tax?: number): number | undefined {
    if (total == null) return undefined;
    const t = tax ?? 0;
    const net = total - t;
    return Number.isFinite(net) ? Math.max(net, 0) : undefined;
  }

  // ──────────────────────────────────────────────────────────────────────
  // Money-trio reconciliation — the ROOT-CAUSE FIX for the shuffled
  // total/net/tax fields on photos. Three independent sources contribute
  // numeric values: QR-AT (O / N), the AI vision JSON, and the regex
  // layer. Each runs at a different time and reads the document from a
  // different perspective, so a single document gets read with different
  // totals on different runs.
  //
  // Invariant (always): total ≈ net + tax (±0.05).
  //
  // Priority order:
  //   1. ivaBreakdown — Σ base = net, Σ tax = tax, total = net+tax.
  //      MOST reliable (per-rate amounts come straight off the printed
  //      footer; they don't depend on which field the model chose).
  //   2. Two of {net, tax, total} are known — derive the third
  //      (total=net+tax, or net=total-tax, or tax=total-net).
  //   3. Single source present — keep it, mark the others undefined.
  //
  // Sanity / cleanup — a value is dropped if:
  //   - it's not finite / not a number,
  //   - it's < 0,
  //   - it equals 0 (almost always the AI inventing "no tax" / "no net"
  //     instead of admitting it didn't see them),
  //   - it equals 1 (the recurring bug: AI writes the per-line IVA at
  //     23% × 1 base → tax=0.23 rounded down to 1 in some serialisers;
  //     or the placeholder the model falls back to when it gives up),
  //   - it > 1_000_000 (date-shaped garbage like `31082026` or
  //     mis-read stamps like `20250217.37`),
  //   - it looks like a YYYYMMDD date string when serialised.
  //
  // The function is applied LAST in every merge path so no matter what
  // the QR or the AI said, the row that lands in the database is always
  // self-consistent.
  // ──────────────────────────────────────────────────────────────────────
  private reconcileMoneyTrio(fields: {
    total?: number;
    taxAmount?: number;
    netAmount?: number;
    ivaBreakdown?: Array<{ rate: number; base: number; tax: number }>;
  }): {
    total?: number;
    taxAmount?: number;
    netAmount?: number;
    /** Diagnostic hint for the audit trail (e.g. "reconciled_from_breakdown"). */
    reconciliationHint?: string;
  } {
    const isPlausible = (v: unknown): v is number => {
      if (typeof v !== "number" || !Number.isFinite(v)) return false;
      if (v < 0) return false;
      if (v === 0) return false; // never accept "0 total" / "0 tax" / "0 net"
      if (v === 1) return false; // never accept the "tax=1" placeholder
      if (v > 1_000_000) return false; // refuse dates / 7-digit garbage
      // Date-shaped integer (YYYYMMDD with no decimal) — refuse it as money.
      // 20260101..20991231 is the only window where this overlaps real money
      // values, but invoices above €10 000 (which would overlap) are
      // validated separately downstream by the operator; here we trust
      // numeric plausibility over a literal 8-digit pattern.
      return true;
    };
    const round2 = (n: number): number => Math.round(n * 100) / 100;
    const reconcile = (
      total: number | undefined,
      tax: number | undefined,
      net: number | undefined,
    ): { total?: number; taxAmount?: number; netAmount?: number } => {
      // Try pairs in priority order — the pair with the smallest
      // reconciliation error wins.
      const candidates: Array<{
        err: number;
        total?: number;
        tax?: number;
        net?: number;
      }> = [];
      if (total != null && tax != null) {
        const netFromPair = total - tax;
        const err = Math.abs(total - (netFromPair + tax));
        candidates.push({
          err,
          total,
          tax,
          net: Number.isFinite(netFromPair) ? Math.max(netFromPair, 0) : undefined,
        });
      }
      if (total != null && net != null) {
        const taxFromPair = total - net;
        const err = Math.abs(total - (net + taxFromPair));
        candidates.push({
          err,
          total,
          tax: Number.isFinite(taxFromPair) ? Math.max(taxFromPair, 0) : undefined,
          net,
        });
      }
      if (tax != null && net != null) {
        const totalFromPair = net + tax;
        const err = Math.abs(totalFromPair - (net + tax));
        candidates.push({ err, total: totalFromPair, tax, net });
      }
      if (candidates.length > 0) {
        candidates.sort((a, b) => a.err - b.err);
        const best = candidates[0];
        return {
          total: best.total != null ? round2(best.total) : undefined,
          taxAmount: best.tax != null ? round2(best.tax) : undefined,
          netAmount: best.net != null ? round2(best.net) : undefined,
        };
      }
      return {
        total: total != null ? round2(total) : undefined,
        taxAmount: tax != null ? round2(tax) : undefined,
        netAmount: net != null ? round2(net) : undefined,
      };
    };
    type Reconciled = ReturnType<typeof reconcile> & { reconciliationHint?: string };

    // 1. ivaBreakdown wins (Σ base = net, Σ tax = tax).
    if (fields.ivaBreakdown && fields.ivaBreakdown.length > 0) {
      let sumBase = 0;
      let sumTax = 0;
      let ok = true;
      for (const row of fields.ivaBreakdown) {
        if (!isPlausible(row.base) || !isPlausible(row.tax)) {
          ok = false;
          break;
        }
        sumBase += row.base;
        sumTax += row.tax;
      }
      if (ok && sumBase > 0 && sumTax >= 0) {
        const reconciled = reconcile(round2(sumBase + sumTax), round2(sumTax), round2(sumBase));
        return {
          total: reconciled.total,
          taxAmount: reconciled.taxAmount,
          netAmount: reconciled.netAmount,
          reconciliationHint: "reconciled_from_breakdown",
        };
      }
    }

    // 2. Filter candidate values for plausibility.
    const total = isPlausible(fields.total) ? fields.total : undefined;
    const tax = isPlausible(fields.taxAmount) ? fields.taxAmount : undefined;
    const net = isPlausible(fields.netAmount) ? fields.netAmount : undefined;

    // 3. Reconcile from the available pair / singleton.
    const reconciled: Reconciled = reconcile(total, tax, net);

    // 4. Final sanity: total ≈ net + tax (±0.05). If not, fall back to
    //    the most trustworthy single value (the one with the highest
    //    plausibility score — we approximate that by the order: total >
    //    tax > net, since total is the most-published and least likely
    //    to be AI-fabricated).
    const sanity = (r: Reconciled): Reconciled => {
      if (
        r.total != null &&
        r.netAmount != null &&
        r.taxAmount != null &&
        Math.abs(r.total - (r.netAmount + r.taxAmount)) > 0.05
      ) {
        // Pick the most trustworthy single value and drop the others.
        if (total != null) {
          const fallbackTax = isPlausible(tax) ? tax : undefined;
          const fallbackNet =
            fallbackTax != null ? total - fallbackTax : undefined;
          return {
            total: round2(total),
            taxAmount: fallbackTax != null ? round2(fallbackTax) : undefined,
            netAmount:
              fallbackNet != null && fallbackNet >= 0 ? round2(fallbackNet) : undefined,
            reconciliationHint: "reconciled_from_total_only",
          };
        }
        if (tax != null) {
          return {
            total: undefined,
            taxAmount: round2(tax),
            netAmount: undefined,
            reconciliationHint: "reconciled_from_tax_only",
          };
        }
        if (net != null) {
          return {
            total: undefined,
            taxAmount: undefined,
            netAmount: round2(net),
            reconciliationHint: "reconciled_from_net_only",
          };
        }
      }
      return r;
    };

    const safe = sanity(reconciled);
    const hint =
      safe === reconciled
        ? total != null && tax != null && net != null
          ? "reconciled_from_pair"
          : total != null || tax != null || net != null
            ? "reconciled_partial"
            : undefined
        : safe.reconciliationHint;
    return {
      total: safe.total,
      taxAmount: safe.taxAmount,
      netAmount: safe.netAmount,
      reconciliationHint: hint,
    };
  }

  /**
   * Convert extracted fields into a Prisma Document update payload.
   * NEVER overwrites an existing non-null value with `null`/`undefined` —
   * heuristic extraction is additive, not destructive.
   */
  private buildUpdateData(
    fields: ExtractedFields,
    options?: {
      qrPayloadOverride?: string;
      /**
       * Fase 4.1 — origem de cada família de campos, para o teto de
       * confiança. Sem isto assume-se `ai` (teto baixo), que é a
       * posição segura: quem não prova, não mostra 90 %.
       */
      confidenceSources?: {
        nif: 'qr' | 'validated' | 'ai';
        qrBacked: 'qr' | 'ai';
      };
    },
  ): Prisma.DocumentUpdateInput {
    const data: Prisma.DocumentUpdateInput = {};
    if (fields.supplierNif) data.supplierNif = fields.supplierNif;
    if (fields.customerNif) data.customerNif = fields.customerNif;
    if (fields.supplier) data.supplier = fields.supplier;
    if (fields.customer) data.customer = fields.customer;
    if (fields.docNumber) data.docNumber = fields.docNumber;
    if (fields.atcud) data.atcud = fields.atcud;
    if (fields.docDate) data.docDate = new Date(fields.docDate);
    if (fields.dueDate) data.dueDate = new Date(fields.dueDate);
    if (fields.total != null) data.total = fields.total;
    if (fields.taxAmount != null) data.taxAmount = fields.taxAmount;
    if (fields.netAmount != null) data.netAmount = fields.netAmount;
    if (fields.iban) data.iban = fields.iban;
    if (fields.currency) data.currency = fields.currency;
    // Document type — only writes when the classifier or the QR path
    // had a strong signal. Undefined leaves the user-set value alone.
    if (fields.documentType) data.type = fields.documentType;
    // Persist the decoded AT-QR payload on the row so future re-runs
    // (manual triggers, audit) skip the decode-from-image work. Only
    // set when we actually decoded something on this run (override is
    // undefined for the regex/AI path).
    if (options?.qrPayloadOverride) {
      data.qrPayload = options.qrPayloadOverride;
    }

    // ── Sprint 1.A — per-field extraction confidence ───────────────
    // The AI returns a single top-level confidence; Gemini does not
    // score fields individually. We fan that score out to every field
    // the path actually populated, so the review screen's chip grid
    // reflects "how confident was the model in what it returned"
    // instead of "we have no idea". A future migration that captures
    // per-field scores from the prompt can replace these lines
    // without touching the schema or the UI.
    //
    // We ALSO compute nifValid / ibanValid at write time — mod-11 and
    // mod-97 are cheap enough that running them here is free, and the
    // review screen needs the verdict alongside the value to flag
    // "AI is confident but the checksum disagrees" cases.
    //
    // Fase 4.1 — a confiança reportada tem de refletir a validação. Um
    // campo que não foi cruzado com nada (só o modelo o viu) fica com
    // teto em UNVALIDATED_CONFIDENCE_CAP, para a interface não mostrar
    // 90 % num valor que ninguém verificou.
    const src = options?.confidenceSources;
    const fan = (column: string, source: "qr" | "validated" | "ai" = "ai") => {
      const value = fieldConfidence(fields.confidence, source);
      if (value == null) return;
      (data as Record<string, unknown>)[column] = value;
    };

    if (fields.supplierNif) {
      // Chegou aqui → já passou o resolveTaxIds (módulo 11 / VIES).
      fan("supplierNifConfidence", src?.nif ?? "validated");
      data.nifValid = this.isValidPortugueseNifLocal(fields.supplierNif);
    }
    if (fields.iban) {
      const ibanValid = this.isValidIbanLocal(fields.iban);
      fan("supplierIbanConfidence", ibanValid ? "validated" : "ai");
      data.ibanValid = ibanValid;
    }
    if (fields.supplier) fan("supplierNameConfidence");
    if (fields.total != null) {
      // Os totais só são "validados" quando fecham entre si ao cêntimo
      // (soma − descontos + IVA = total) ou vieram do QR-AT.
      fan("totalAmountConfidence", fields.totalsReconciled ? "validated" : (src?.qrBacked ?? "ai"));
    }
    if (fields.docDate) fan("issueDateConfidence", src?.qrBacked ?? "ai");
    if (fields.dueDate) fan("dueDateConfidence");
    if (fields.suggestedCategory) fan("categoryConfidence");
    return data;
  }

  /**
   * Local re-export of the NIF validator. Imported from
   * `common/validation/tax-id.validator` at the top of the file but
   * referenced here via thin wrappers so a future swap to a
   * per-country helper stays localised.
   */
  private isValidPortugueseNifLocal(value: string): boolean {
    return isValidPortugueseNif(value);
  }

  /**
   * Local re-export of the IBAN validator. See isValidPortugueseNifLocal.
   */
  private isValidIbanLocal(value: string): boolean {
    return isValidIban(value);
  }

  private composeMetadata(
    existing: Prisma.JsonValue | null | undefined,
    fields: ExtractedFields,
    ibanCheck: IbanCheckResult | null,
    qrValidation?: { ok: boolean; errors: string[]; warnings: string[] },
    loaded?: LoadedText,
    supplierResolve?: { supplierReview: boolean; supplierReason?: string },
    aiExpenseCategory?: ExpenseCategory | null,
    certaintyResult?: CertaintyScoreResult,
  ): Prisma.InputJsonValue {
    // ── Per-rate VAT breakdown ───────────────────────────────────
    // Source priority:
    //   1. AI-explicit ivaBreakdown (already on `fields.ivaBreakdown`).
    //   2. Aggregated from line items, grouping by vatRate, summing net
    //      (lineTotal − per-line discount − tax, or unitPrice*quantity −
    //      per-line discount when no tax has been included in lineTotal)
    //      and tax (vatRate% of net).
    //   3. Aggregated from a single taxAmount/total pair (one-rate
    //      invoices — derive the implicit breakdown from net + tax).
    //
    // The synthesised breakdown is the input for the IVA apuramento
    // (deductible / payable) on the review screen. We never persist an
    // empty array — `null` means "we don't know the breakdown" and the
    // UI can decide whether to compute from taxAmount/total as a fallback.
    const ivaBreakdown =
      this.resolveIvaBreakdown(
        fields.ivaBreakdown,
        fields.lineItems,
        fields.taxAmount,
        fields.netAmount,
      );

    // ── Discounts ────────────────────────────────────────────────
    // discountAmount is the invoice-level (global) discount. Line-level
    // discounts already travel inside `fields.lineItems[i].discount` and
    // are exposed via the `lineItems` block below — no separate column.
    const discountAmount =
      typeof fields.discountAmount === "number" &&
      Number.isFinite(fields.discountAmount) &&
      fields.discountAmount >= 0
        ? fields.discountAmount
        : null;

    const base = (
      existing && typeof existing === "object" && !Array.isArray(existing)
        ? (existing as Record<string, unknown>)
        : {}
    ) as Record<string, unknown>;

    // ── Auto-persist expenseCategory into metadata.filing ───────────
    // When the folder-rules branch above resolved an AI-driven
    // expenseCategory (one of EXPENSE_CATEGORIES), we mirror it into
    // `metadata.filing` so the document-detail page can show it on
    // first load — no manual Save required. We respect any existing
    // user-set filing.expenseCategory (a manual override on PATCH
    // carries source='user') so this branch NEVER clobbers a manual
    // pick — only fills it in when the row was empty.
    let filing: Record<string, unknown> | undefined;
    if (aiExpenseCategory) {
      const existingFiling =
        base.filing && typeof base.filing === "object" && !Array.isArray(base.filing)
          ? (base.filing as Record<string, unknown>)
          : {};
      const alreadySetByUser =
        typeof existingFiling.expenseCategory === "string" &&
        existingFiling.source === "user";
      if (!alreadySetByUser) {
        filing = {
          ...existingFiling,
          expenseCategory: aiExpenseCategory,
          vatDeductibilityHint: VAT_DEDUCTIBILITY_HINTS[aiExpenseCategory].reason,
          source: "ai",
        };
      } else {
        filing = existingFiling;
      }
    }

    // Cap the persisted text to a few KB so a 1MB PDF doesn't blow up
    // metadata. We keep the first N chars + a length marker so the
    // operator can see what the extractor actually saw.
    const extractedText = loaded?.text ?? "";
    const persistedTextPreview = extractedText.slice(0, 4000);

    // Pull AI provenance out of the hints (set by `mergeVisionWithRegex`)
    // so it lands in metadata.extraction as structured fields, not just
    // opaque hint strings.
    //
    // The hint shape is `ai:<provider>/<model>`. Some providers carry a
    // composite provider name like `openrouter/gemini`, and OpenRouter
    // models often have a slash in the id (e.g. `google/gemini-2.5-flash`).
    // To support BOTH without ambiguity, the parser takes the LAST
    // `/`-delimited segment as the model and everything BEFORE it as the
    // provider — so a hint of `ai:openrouter/gemini/google/gemini-2.5-flash`
    // resolves to provider=`openrouter/gemini`, model=`google/gemini-2.5-flash`.
    const aiHintValue = (fields.hints ?? [])
      .find((h) => h.startsWith("ai:") && h.includes("/"))
      ?.split(":")[1];
    const aiModel = aiHintValue?.split("/").pop() ?? null;
    let aiProvider: string | null = null;
    if (aiHintValue && aiModel) {
      aiProvider =
        aiHintValue.slice(0, aiHintValue.length - aiModel.length - 1) || null;
    }
    const aiConfidence =
      Number(
        (fields.hints ?? [])
          .find((h) => h.startsWith("aiConfidence:"))
          ?.split(":")[1],
      ) || null;

    return {
      ...base,
      supplierAddress: fields.supplierAddress ?? base.supplierAddress ?? null,
      supplierPostalCode: fields.supplierPostalCode ?? base.supplierPostalCode ?? null,
      supplierCity: fields.supplierCity ?? base.supplierCity ?? null,
      supplierPhone: fields.supplierPhone ?? base.supplierPhone ?? null,
      supplierEmail: fields.supplierEmail ?? base.supplierEmail ?? null,
      supplierWebsite: fields.supplierWebsite ?? base.supplierWebsite ?? null,
      extraction: {
        source: fields.source,
        confidence: fields.confidence,
        currency: fields.currency,
        country: fields.country,
        supplierAddress: fields.supplierAddress ?? null,
        supplierPostalCode: fields.supplierPostalCode ?? null,
        supplierCity: fields.supplierCity ?? null,
        supplierPhone: fields.supplierPhone ?? null,
        supplierEmail: fields.supplierEmail ?? null,
        supplierWebsite: fields.supplierWebsite ?? null,
        // Fase 4.1 — o cabeçalho transcrito à letra fica gravado: é o
        // texto em que a regra determinística se baseou para decidir
        // "orçamento" em vez de "fatura", e sem ele quem revê o
        // documento não consegue perceber porquê.
        documentTitle: fields.documentTitle,
        correctedDocumentNumber: fields.correctedDocumentNumber,
        totalsReconciled: fields.totalsReconciled,
        documentLocale: fields.documentLocale,
        ibanCountry: fields.ibanCountry,
        supplierVatId: fields.supplierVatId,
        taxRate: fields.taxRate,
        hints: fields.hints,
        warnings: fields.warnings,
        // `needsReview` is a single boolean the UI can drive a
        // "needs review" badge from. True when (a) the AI returned
        // JSON but the inner merge gated out the numerics (partial
        // pass — supplier/IBAN/lines still merged but flagged), (b)
        // the AI never ran (qr_only path), or (c) the supplier
        // resolver couldn't auto-link. Operators can drill into the
        // `warnings[]` array for the specific reason.
        needsReview:
          (fields.warnings ?? []).some((w) =>
            [
              "qr_only_ai_unavailable_supplier_may_be_null",
              "qr_only_ai_failed_supplier_may_be_null",
              "ai_partial_response_used_for_supplier_iban_lines_qr_fiscal_authoritative",
              "ai_all_retries_failed_on_image_needs_review",
              "vision_partial_no_regex_fallback_on_image",
            ].includes(w),
          ) || (supplierResolve?.supplierReview ?? false),
        qrValidation,
        ibanCheck,
        aiProvider: aiProvider || null,
        aiModel: aiModel || null,
        aiConfidence: aiConfidence,
        // Every IBAN candidate the regex matched, with raw/normalized
        // form and whether MOD-97 accepted it. Lets the operator see
        // "the regex found something but it wasn't a valid IBAN" vs
        // "the text didn't have an IBAN at all".
        ibanCandidates: fields.ibanCandidates ?? null,
        // ── Richer AI extraction (Gap 2) ──────────────────────────────
        // Structured line items captured by the vision path. Surfaced
        // so the operator can verify / correct the table before
        // posting the entry to accounting. Each row now also carries a
        // per-line `discount` field (currency) when the AI picked one up.
        lineItems: fields.lineItems ?? null,
        // True when the AI classified this as an intra-community
        // acquisition (foreign EU supplier + reverse charge). Drives
        // downstream tax treatment in the SAF-T export and the
        // review-queue flag.
        isEuIntracommunity:
          typeof fields.isEuIntracommunity === "boolean"
            ? fields.isEuIntracommunity
            : null,
        // SNC/PGC expense category mapped by the AI. Drives auto-filing
        // (the folder-rules engine re-runs when this is present) and
        // pre-fills the COA code on the accounting entry.
        suggestedCategory: fields.suggestedCategory ?? null,
        // Early-payment discount, as a percentage (e.g. 2 → 2 %). Only
        // present on PT/ES supplier invoices that explicitly print it.
        cashDiscountRate:
          typeof fields.cashDiscountRate === "number"
            ? fields.cashDiscountRate
            : null,
        // Invoice-level (global) discount. Subtracted from the subtotal
        // before VAT. Distinct from per-line `discount` carried inside
        // `lineItems[i]`. Persisted as null when no global discount
        // applies — the operator can still see the document's total.
        discountAmount,
        // Per-rate VAT breakdown. Either emitted by the AI directly or
        // synthesised here from line items (grouping by vatRate). Used
        // by the UI to show "IVA a 23 %: X €, base Y €" per rate and
        // by the apuramento flow to compute IVA/dedutível vs a pagar.
        ivaBreakdown,
        // Where the text fed into the extractor came from. Lets the
        // operator see *why* a doc ended up with low confidence — e.g.
        // `textSource=none, needsManualOcr=true` means it's a scanned
        // PDF and needs human OCR before the regex path can do anything.
        textSource: loaded?.source ?? null,
        needsManualOcr: loaded?.needsManualOcr ?? false,
        pageCount: loaded?.pageCount ?? null,
        textLoadReason: loaded?.reason ?? null,
        // First ~4KB of the text the regex layer actually parsed. This
        // is the canonical "what did the extractor see" field — when
        // iban is null, you read this to find out whether the text
        // ever had an IBAN at all.
        extractedTextPreview:
          extractedText.length > 4000
            ? `${persistedTextPreview}\n…[truncated, full length=${extractedText.length}]`
            : persistedTextPreview,
        extractedTextLength: extractedText.length,
        extractedAt: new Date().toISOString(),
        // ── Auto-resolved supplier ──────────────────────────────
        // `supplierReview` is true when the AI confidence was < 0.8
        // OR the tax-ID validator rejected the NIF/VAT — the UI
        // surfaces this as a "needs review" badge. `supplierReason`
        // is a short audit-trail label ("found" / "created" /
        // "created_review" / "resolve_threw:...").
        supplierReview: supplierResolve?.supplierReview ?? false,
        supplierReason: supplierResolve?.supplierReason ?? null,
        // ── Certainty Score (95% - 99%) & Mathematical Triangulation (Fase 5) ──
        certaintyScore: certaintyResult?.score ?? null,
        certaintyLevel: certaintyResult?.level ?? null,
        certainty: certaintyResult
          ? {
              score: certaintyResult.score,
              level: certaintyResult.level,
              label: certaintyResult.label,
              needsReview: certaintyResult.needsReview,
              triangulation: certaintyResult.triangulation,
              taxIdResolution: certaintyResult.taxIdResolution,
              tenantNifValidation: certaintyResult.tenantNifValidation,
              lineItemsValidation: {
                isValid: certaintyResult.lineItemsValidation.isValid,
                totalLines: certaintyResult.lineItemsValidation.totalLines,
                sumOfLines: certaintyResult.lineItemsValidation.sumOfLines,
                discrepancies: certaintyResult.lineItemsValidation.lineDiscrepancies,
              },
              vatRatesValidation: {
                isValid: certaintyResult.vatRatesValidation.isValid,
                ratesChecked: certaintyResult.vatRatesValidation.ratesChecked,
                invalidRates: certaintyResult.vatRatesValidation.invalidRates,
              },
              passedChecks: certaintyResult.passedChecks,
              warnings: certaintyResult.warnings,
            }
          : null,
      },
      ...(this.lastAiExtraction
        ? { aiExtraction: this.lastAiExtraction }
        : base.aiExtraction
          ? { aiExtraction: base.aiExtraction }
          : {}),
      ...(filing ? { filing } : {}),
    } as unknown as Prisma.InputJsonValue;
  }

  /**
   * Resolve the per-rate VAT breakdown in priority order.
   *
   *   1. AI-explicit list (already aggregated on the model side) — wins
   *      even when the line items would say something different; the AI
   *      saw the printed totals and is the authoritative source.
   *   2. Line items with `vatRate` set — group, sum net (after
   *      per-line discount) and tax.
   *   3. Single-rate invoice inferred from `taxAmount` / `netAmount`.
   *
   * Returns `null` (not []) when nothing usable was found — the UI
   * surfaces that as "IVA breakdown: n/a".
   */
  private resolveIvaBreakdown(
    explicit: Array<{ rate: number; base: number; tax: number }> | undefined,
    lineItems:
      | Array<{
          vatRate?: number;
          discount?: number;
          lineTotal?: number;
          quantity?: number;
          unitPrice?: number;
        }>
      | undefined,
    taxAmount: number | undefined,
    netAmount: number | undefined,
  ): Array<{ rate: number; base: number; tax: number }> | null {
    if (explicit && explicit.length > 0) {
      const sorted = [...explicit].sort((a, b) => a.rate - b.rate);
      return sorted.map((row) => ({
        rate: Number(row.rate),
        base: Number(row.base),
        tax: Number(row.tax),
      }));
    }
    if (lineItems && lineItems.length > 0) {
      const buckets = new Map<
        number,
        { base: number; tax: number }
      >();
      let fallbackGross = true;
      for (const row of lineItems) {
        if (typeof row.vatRate !== "number" || !Number.isFinite(row.vatRate)) {
          continue;
        }
        const rate = row.vatRate;
        // Compute net for this row. The supplier prints either:
        //   - net lineTotal (so lineTotal is base, before VAT) — easy
        //   - gross lineTotal (so lineTotal is base*(1+vatRate/100)) — derive
        //
        // We default to "gross" and let the deducer correct later: a
        // gross lineTotal at rate 23 over a quantity*unitPrice that
        // matches would reconcile to tax = lineTotal*23/123. When the
        // supplier prints net totals, qty*unitPrice will usually diverge
        // from lineTotal — we try the net interpretation in that case.
        const quantity = typeof row.quantity === "number" ? row.quantity : 1;
        const unitPrice = typeof row.unitPrice === "number" ? row.unitPrice : undefined;
        const lineTotal = typeof row.lineTotal === "number" ? row.lineTotal : undefined;
        const discount = typeof row.discount === "number" && row.discount > 0 ? row.discount : 0;
        let base: number | undefined;
        if (lineTotal != null) {
          if (unitPrice != null && quantity > 0) {
            const grossFromUnit = quantity * unitPrice;
            const expectedGross = grossFromUnit * (1 + rate / 100);
            const tolerance = Math.max(0.05, expectedGross * 0.01);
            if (Math.abs(lineTotal - expectedGross) <= tolerance) {
              // supplier printed gross totals — net = lineTotal / (1 + rate)
              base = lineTotal / (1 + rate / 100);
              fallbackGross = true;
            } else if (Math.abs(lineTotal - grossFromUnit) <= tolerance) {
              // supplier printed net totals — base = lineTotal
              base = lineTotal;
              fallbackGross = false;
            } else {
              // No clean signal — assume gross, common in PT faturas.
              base = lineTotal / (1 + rate / 100);
            }
          } else {
            // No unitPrice to validate against — assume gross (PT default).
            base = lineTotal / (1 + rate / 100);
          }
        } else if (unitPrice != null) {
          base = quantity * unitPrice;
        }
        if (base == null || !Number.isFinite(base)) continue;
        base = Math.max(0, base - discount);
        const tax = base * (rate / 100);
        const cur = buckets.get(rate) ?? { base: 0, tax: 0 };
        cur.base += base;
        cur.tax += tax;
        buckets.set(rate, cur);
      }
      // If we couldn't get anything out of the line items because the
      // vatRate was missing, fall through to the single-rate derivation
      // below. Otherwise return the buckets sorted by rate ascending.
      if (buckets.size > 0) {
        return Array.from(buckets.entries())
          .map(([rate, v]) => ({
            rate,
            base: Number(v.base.toFixed(2)),
            tax: Number(v.tax.toFixed(2)),
          }))
          .sort((a, b) => a.rate - b.rate);
      }
      // Reference unused to keep TS happy and to preserve the heuristic
      // for the operator-visible comment above.
      void fallbackGross;
    }
    if (
      typeof taxAmount === "number" &&
      typeof netAmount === "number" &&
      netAmount > 0 &&
      taxAmount >= 0
    ) {
      const rate = Number(((taxAmount / netAmount) * 100).toFixed(2));
      return [{ rate, base: Number(netAmount.toFixed(2)), tax: Number(taxAmount.toFixed(2)) }];
    }
    return null;
  }

  /**
   * Read the Document's bytes and pull any embedded text. Returns a
   * `LoadedText` record that records the source (`pdf-text` / `ocr` /
   * `none` / `filename` / `preloaded`) and whether the file looked
   * like a scanned / image-only PDF that needs manual OCR.
   *
   * PDF strategy (the fix for the "extraction does a bad job" bug):
   *   1. Read the buffer from storage.
   *   2. If the file is text/plain, return it directly.
   *   3. If the file looks like a PDF (header `%PDF-`), delegate to
   *      `parsePdfText` which uses pdf-parse's text layer extraction.
   *      This is fast (no rasterisation) and accurate for digital
   *      invoices.
   *   4. If pdf-parse returns substantial text → `pdf-text`.
   *   5. If pdf-parse returns essentially empty text (≤ a small noise
   *      floor — pdfjs always emits a `-- N of M --` page marker) →
   *      `none` with `needsManualOcr: true`. The downstream OCR path
   *      would otherwise produce noise; instead we surface the flag
   *      so the operator knows the document must be OCR'd manually.
   *   6. If the PDF is malformed/encrypted → `none` with a reason.
   *
   * The function NEVER throws on a malformed file — failures are
   * logged and converted into a `LoadedText { source: 'none', reason }`.
   */
  async loadDocumentText(doc: {
    fileKey: string;
    mimeType: string;
    fileName: string;
    fileSize: number;
  }): Promise<LoadedText> {
    if (!this.storage) {
      return {
        text: [doc.fileName].filter(Boolean).join("\n"),
        source: "filename",
        needsManualOcr: false,
        reason: "storage_unavailable",
      };
    }

    let obj: { buffer: Buffer; contentType?: string; size: number };
    try {
      obj = await this.storage.getBuffer(doc.fileKey);
    } catch (err) {
      this.logger.warn(
        `Could not read ${doc.fileKey} for extraction: ${(err as Error).message}`,
      );
      return {
        text: doc.fileName,
        source: "filename",
        needsManualOcr: false,
        reason: `storage_read_failed:${(err as Error).message}`,
      };
    }

    // Plain text — return as-is.
    if (
      doc.mimeType.startsWith("text/") ||
      doc.fileName.toLowerCase().endsWith(".txt")
    ) {
      try {
        return {
          text: obj.buffer.toString("utf8"),
          source: "none",
          needsManualOcr: false,
        };
      } catch (err) {
        // Buffer.toString should never throw, but if a corrupted file
        // slipped past storage we still want a sensible LoadedText back.
        this.logger.warn(
          `loadDocumentText: text decode failed for ${doc.fileName}: ${(err as Error).message}`,
        );
        return {
          text: doc.fileName,
          source: "filename",
          needsManualOcr: false,
          reason: `text_decode_failed:${(err as Error).message}`,
        };
      }
    }

    // PDF — extract text layer via pdf-parse.
    if (
      /^application\/pdf/i.test(doc.mimeType) ||
      doc.fileName.toLowerCase().endsWith(".pdf")
    ) {
      return ExtractionService.parsePdfText(
        obj.buffer,
        doc.fileName,
        this.logger,
      );
    }

    // Image — tesseract OCR.
    if (/^image\//i.test(doc.mimeType)) {
      try {
        const text = await this.ocrImage(obj.buffer, doc.mimeType);
        return {
          text,
          source: text ? "ocr" : "none",
          needsManualOcr: !text,
          reason: text ? undefined : "ocr_returned_empty",
        };
      } catch (err) {
        return {
          text: "",
          source: "none",
          needsManualOcr: true,
          reason: `ocr_failed:${(err as Error).message}`,
        };
      }
    }

    // Unknown mimetype — best effort: leave it to the regex path.
    return {
      text: "",
      source: "none",
      needsManualOcr: false,
      reason: `unsupported_mimetype:${doc.mimeType}`,
    };
  }

  /**
   * Sprint H+ Part 2 — supplier-only re-extraction.
   *
   * Pulls the file bytes from storage, runs vision (if a provider is
   * configured) + the regex/OCR path, and merges the result into a
   * focused supplier-shaped payload:
   *
   *   { supplierName?, supplierNif?, supplierIban?, address?, country? }
   *
   * Distinct from `processDocumentAsync()` (the full 4-stage pipeline
   * driver): this helper does NOT advance processingStatus, does NOT
   * publish any queue events, and does NOT touch totals / line items
   * / party links. Use this when the operator wants to refresh just
   * the supplier block on a Document that already has the rest of the
   * header locked in (typical "AI swapped the wrong party" case after
   * the operator reviewed but BEFORE they verified-supplier).
   *
   * Operator-Verified Guard: the caller is responsible for checking
   * `Document.supplierVerifiedAt` BEFORE invoking this method. This
   * helper does not duplicate the guard — running it on a verified
   * document is technically allowed, but the caller (DocumentsService.
   * extractSupplierFromDocument) treats verified docs as 409 unless
   * the operator passes `force=true`.
   *
   * Failure modes (graceful — never throws to the caller unless the
   * underlying read blows up):
   *   - storage missing                → regex path on filename only
   *   - no vision provider configured  → regex path only (silent skip)
   *   - vision throws / times out      → regex path takes over
   */
  async extractSupplierFromDocument(
    tenantId: string,
    userId: string,
    documentId: string,
  ): Promise<{
    supplierName: string | null;
    supplierNif: string | null;
    supplierIban: string | null;
    address: string | null;
    country: string | null;
  }> {
    this.logger.log(
      `[extractSupplierFromDocument] start document=${documentId} tenant=${tenantId}`,
    );

    const doc = await this.prisma.document.findFirst({
      where: { id: documentId, tenantId },
    });
    if (!doc) {
      throw new Error(`Document ${documentId} not found for tenant ${tenantId}`);
    }

    // Load text — reuse `loadDocumentText` so we benefit from the same
    // OCR/PDF parsing pipeline as the full extraction. Returns
    // `source='filename'` when storage is offline so the regex path
    // still has SOMETHING to scan.
    const loaded = await this.loadDocumentText({
      fileKey: doc.fileKey,
      mimeType: doc.mimeType,
      fileName: doc.fileName,
      fileSize: doc.fileSize,
    });

    // Regex path — always runs. Cheap, never throws, gives us the
    // baseline supplier candidate (NIF / IBAN / country) even when the
    // vision provider is offline.
    const regexFields = await this.extractWithOcrFallback(
      { fileKey: doc.fileKey, mimeType: doc.mimeType, fileName: doc.fileName },
      loaded.text,
    );

    // Vision path — runs ONLY when a provider is configured AND the
    // file is a multimodal-supporting type. Mirrors the same gating
    // the full pipeline uses so we get the same provider fallback
    // behaviour without re-implementing the chain.
    let visionExtracted:
      | import("../ai/vision.service").VisionExtractedFields
      | null = null;
    if (this.vision?.liveProviderAvailable) {
      try {
        const result = await this.callVisionForSupplier({
          doc,
          loaded,
          tenantId,
        });
        visionExtracted = result;
      } catch (err) {
        this.logger.warn(
          `[extractSupplierFromDocument] vision failed for ` +
            `${doc.fileName}: ${(err as Error).message}. Falling back to regex.`,
        );
        visionExtracted = null;
      }
    }

    // Merge priority: vision wins on overlap (vision carries the
    // tenant-identity block, so it's the strongest signal on the
    // supplier-vs-customer distinction). Regex fills the gaps so the
    // operator still sees a sensible row when vision is silent or
    // offline. This mirrors the public `mergeVisionWithRegex` shape
    // but locally scoped to the supplier fields.
    const merged = mergeSupplierOnly(visionExtracted, regexFields);

    this.logger.log(
      `[extractSupplierFromDocument] done document=${documentId} ` +
        `vision=${visionExtracted ? "yes" : "no"} regex=${regexFields ? "yes" : "no"} ` +
        `→ supplierName=${merged.supplierName ?? "?"} nif=${merged.supplierNif ?? "?"}`,
    );

    return merged;
  }

  /**
   * Internal — runs the vision call focused on extracting the supplier
   * block. Lives here (not as a separate public method) because it
   * shares ~95 % of `tryVisionAnalysis`'s payload-building logic and
   * the divergence is purely in which fields we keep afterwards. The
   * caller passes the doc + loaded text and gets a
   * `VisionExtractedFields` shape back, ready to be merged with the
   * regex baseline.
   */
  private async callVisionForSupplier(args: {
    doc: {
      fileKey: string;
      mimeType: string;
      fileName: string;
    };
    loaded: LoadedText;
    tenantId: string;
  }): Promise<
    import("../ai/vision.service").VisionExtractedFields | null
  > {
    const { doc, loaded, tenantId } = args;
    if (!this.vision) return null;

    // Build the multimodal payload — same logic as `tryVisionAnalysis`
    // but inlined so we don't need to hoist `tryVisionAnalysis` to
    // public just for this. Image/PDF routing matches the canonical
    // pipeline (line 1682-1730 in `tryVisionAnalysis`).
    let fileBase64: string | undefined;
    let mimeType: string | undefined;
    if (this.storage) {
      try {
        if (/^image\//i.test(doc.mimeType)) {
          const obj = await this.storage.getBuffer(doc.fileKey);
          fileBase64 = obj.buffer.toString("base64");
          mimeType = obj.contentType ?? doc.mimeType;
        } else if (/^application\/pdf/i.test(doc.mimeType)) {
          const obj = await this.storage.getBuffer(doc.fileKey);
          fileBase64 = obj.buffer.toString("base64");
          mimeType = obj.contentType ?? "application/pdf";
        }
      } catch (err) {
        this.logger.warn(
          `extractSupplierFromDocument: vision could not re-read file (${doc.fileName}): ${(err as Error).message}. Falling back to text-only prompt.`,
        );
      }
    }

    const result = await this.vision.analyze({
      fileBase64,
      mimeType,
      text: loaded.text || undefined,
      fileName: doc.fileName,
      documentContext: "invoice",
      timeoutMs: 30_000,
      tenantId,
    });
    return result?.extracted ?? null;
  }

  /**
   * Parse a PDF's embedded text layer. Returns the joined text plus a
   * source marker. pdf-parse (which wraps pdfjs-dist) always emits a
   * `-- N of M --` marker between pages; we treat that as noise and
   * use a small floor (~50) to decide whether the document actually
   * has a text layer worth parsing.
   *
   * On any failure (malformed PDF, encrypted PDF, missing dep) the
   * function returns a `none` result with a descriptive reason — it
   * never throws. The caller (processDocumentAsync) reads the
   * `needsManualOcr` flag and either proceeds or asks for manual
   * intervention.
   *
   * Marked `public static` so the unit tests can exercise the PDF
   * layer without having to mock the entire `ExtractionService`.
   */
  static async parsePdfText(
    buffer: Buffer,
    fileName = "document.pdf",
    logger?: { warn: (msg: string) => void },
  ): Promise<LoadedText> {
    try {
      const parser = new PDFParse({ data: buffer });
      let text = "";
      let pageCount: number | undefined;
      try {
        const result = await parser.getText();
        text = (result?.text ?? "").trim();
        pageCount = result?.pages?.length ?? result?.total ?? undefined;
      } finally {
        // pdf-parse v2 holds a worker; release it so we don't leak.
        try {
          await parser.destroy?.();
        } catch {
          /* ignore */
        }
      }

      // Strip pdfjs page markers ("-- 1 of 3 --") for length accounting.
      const meaningful = text.replace(/--\s*\d+\s*of\s*\d+\s*--/g, "").trim();
      const hasTextLayer = meaningful.length >= 50;

      if (hasTextLayer) {
        return {
          text: meaningful,
          source: "pdf-text",
          needsManualOcr: false,
          pageCount,
        };
      }

      // PDF parsed cleanly but had no embedded text. This is the
      // canonical "scanned / image-only" case — the regex layer can't
      // see anything, so we surface the flag instead of pretending.
      return {
        text: "",
        source: "none",
        needsManualOcr: true,
        pageCount,
        reason: "pdf_has_no_text_layer",
      };
    } catch (err) {
      logger?.warn?.(
        `PDF parse failed for ${fileName}: ${(err as Error).message}`,
      );
      return {
        text: "",
        source: "none",
        needsManualOcr: true,
        reason: `pdf_parse_failed:${(err as Error).message}`,
      };
    }
  }

  /**
   * Lazy Tesseract worker — initialised once per process and cached.
   * Returns empty string on any failure (Redis-down, missing WASM, etc.)
   * so the caller still produces a regex-only extraction.
   */
  private async ocrImage(buffer: Buffer, mimeType: string): Promise<string> {
    if (!/^image\//i.test(mimeType)) return ""; // PDF raster OCR is out-of-scope here
    try {
      // Lazy import — tesseract.js pulls in ~30MB of WASM and we don't
      // want it on the boot path. Falls through on TS compile-time too.
      const tesseract = await import("tesseract.js").catch(() => null);
      if (!tesseract) return "";
      const { data } = await tesseract.recognize(buffer, "por+eng", {
        // logger: () => {},  // silent — noisy in production logs
      });
      return (data?.text ?? "").trim();
    } catch (err) {
      this.logger.warn(`Tesseract failed: ${(err as Error).message}`);
      return "";
    }
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.queue?.close();
    } catch {
      /* swallow — queue may be uninitialised if Redis never came up */
    }
  }
}

/**
 * Sprint H+ Part 2 — merge helper that collapses a vision payload
 * (shape `VisionExtractedFields`) + a regex payload (shape
 * `ExtractedFields`) into the focused supplier block used by
 * `extractSupplierFromDocument`. Exported as a top-level function so
 * the supplier controller can re-use it without dragging the whole
 * ExtractionService into the controller's dependency tree.
 *
 * Priority: vision wins when it has a value, regex fills the gap.
 * Rationale: vision carries the tenant-identity context block so it's
 * the strongest signal for distinguishing supplier-vs-customer;
 * regex is the safety net for offline / no-provider environments.
 */
export function mergeSupplierOnly(
  vision: import("../ai/vision.service").VisionExtractedFields | null | undefined,
  regex: ExtractedFields | null | undefined,
): {
  supplierName: string | null;
  supplierNif: string | null;
  supplierIban: string | null;
  address: string | null;
  country: string | null;
} {
  const vName = vision?.supplier?.trim() ?? undefined;
  const vNif = vision?.supplierNif?.trim() ?? vision?.supplierVatId?.trim();
  const vIban = vision?.iban?.trim();
  const vCountry = vision?.country?.trim();

  const rName = regex?.supplier?.trim();
  const rNif = regex?.supplierNif?.trim() ?? regex?.supplierVatId?.trim();
  const rIban = regex?.iban?.trim();
  const rCountry = regex?.country?.trim();

  return {
    supplierName: (vName && vName.length > 0 ? vName : rName) ?? null,
    supplierNif: (vNif && vNif.length > 0 ? vNif : rNif) ?? null,
    supplierIban: (vIban && vIban.length > 0 ? vIban : rIban) ?? null,
    // `address` is not extracted by the current vision prompt or the
    // regex layer (free-text addresses are unreliable), so this slot
    // is always null at extraction time. Operators fill it in via
    // the manual-edit endpoint instead.
    address: null,
    country: (vCountry && vCountry.length > 0 ? vCountry : rCountry) ?? null,
  };
}

/** Minimal port for the storage layer; matches StorageService shape. */
export interface StoragePort {
  getBuffer(
    key: string,
  ): Promise<{ buffer: Buffer; contentType?: string; size: number }>;
  /**
   * Persist `buffer` at `key`. Used by the orientation-fix step to
   * overwrite the original image bytes with the upright version so the
   * viewer/PDF show the document right-side-up. Optional in tests /
   * misconfigured DI — `autoOrientImage` swallows write failures.
   */
  put?(
    key: string,
    buffer: Buffer,
    options?: { contentType?: string; metadata?: Record<string, string> },
  ): Promise<void>;
}
