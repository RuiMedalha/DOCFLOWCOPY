import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import {
  AuditAction,
  DocumentOrigin,
  DocumentProcessingStatus,
  DocumentStatus,
  DocumentType,
  FiscalStatus,
  PaymentStatus,
  Prisma,

  CategoryNature,
} from '@prisma/client';
import * as crypto from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import {
  DocumentQueryDto,
  UpdateDocumentDto,
  CorrectSupplierDto,
} from './dto/document.dto';
import { UpdateSupplierDto } from './dto/supplier.dto';
import {
  ConfirmAllDto,
  ConfirmFieldDto,
  ExtractionConfidenceResponseDto,
  FIELD_COLUMN,
  FieldConfidenceDto,
  REVIEWABLE_FIELDS,
  ReviewableField,
} from './dto/extraction-confidence.dto';
import {
  summariseConfidence,
  type FieldInput,
} from './extraction-confidence';
import {
  isValidIban,
  isValidPortugueseNif,
} from '../../common/validation/tax-id.validator';
import {
  FolderRulesEngine,
} from './folder-rules/folder-rules.engine';
import { generateStandardFileName } from './storage/filename-standardizer';
import { resolveIvaDeductibility } from './iva-deductibility';
import {
  buildPatternContext,
  decideFilingFolder,
  ExpenseCategory,
  EXPENSE_CATEGORIES,
  isExpenseCategory,
  mapToExpenseCategory,
  PatternContext,
  RuleMatchable,
  VAT_DEDUCTIBILITY_HINTS,
} from './folder-rules/folder-rules.types';
import { StorageService } from './storage/storage-service.interface';
import { buildDocumentPath } from './storage/path-builder';
import { slugify } from '../../common/storage/slug';
import { docLockKey } from '../../common/locks';
import {
  QUEUE_ADAPTER,
  type QueueAdapter,
} from '../../common/queue/queue-adapter.interface';
import { ExtractionService } from '../extraction/extraction.service';
import { autoOrientImage } from '../extraction/qr-decode/qr-decoder';
import { SNC_ACCOUNT_LABELS } from '../accounting/accounting.controller';
import { proposeAccountingEntry } from '../accounting/accounting-proposal';
import { ImageToPdfService } from './image-to-pdf/image-to-pdf.service';
import { OcrmypdfService } from '../extraction/ocrmypdf.service';
import { ImageEnhancerService } from '../extraction/image-enhancer.service';
import { isHeic, normaliseHeic } from '../../common/images/heic';
import { assertMimeMatchesSignature } from '../../common/validation/mime-validator';
import { NifLookupService } from '../nif-lookup/nif-lookup.service';
import { getTenantIdentity } from '../ai/tenant-identity';
import { validateTenantAcquirerNif } from '../extraction/field-validation';

export interface UploadedFile {
  fieldname: string;
  originalname: string;
  encoding: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

/** Hard limits and allowed MIME types for the inbox upload endpoint. */
export const ALLOWED_MIMES = new Set<string>([
  'application/pdf',
  'image/jpeg',
  'image/jpg',
  'image/png',
  // Fase 2 — HEIC/HEIF (iPhone) is accepted and converted to JPEG at
  // upload time (see normaliseHeic); the JPEG becomes the stored original.
  'image/heic',
  'image/heif',
  // Fase 2 — HEIC/HEIF (iPhone) is accepted and converted to JPEG at
  // upload time (see normaliseHeic); the JPEG becomes the stored original.
  'image/heic',
  'image/heif',
  // Fase 2 — HEIC/HEIF (iPhone) is accepted and converted to JPEG at
  // upload time (see normaliseHeic); the JPEG becomes the stored original.
  'image/heic',
  'image/heif',
  // Fase 2 — HEIC/HEIF (iPhone) is accepted and converted to JPEG at
  // upload time (see normaliseHeic); the JPEG becomes the stored original.
  'image/heic',
  'image/heif',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
]);
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // 20 MB

/**
 * DocumentsService — the inbox of DocFlow.
 *
 * Responsibilities:
 *   - Accept uploads, hash the bytes (SHA-256), refuse duplicates per tenant.
 *   - Persist file blobs via the injected StorageService (local now, S3 later).
 *   - Suggest a folder using the FolderRulesEngine — now category-aware
 *     (Fornecedores/Despesas/Estrangeiras split; see FOREIGN_INVOICE_FLOW.md).
 *   - Paginated inbox/all listing with filters (status/type/date/party/search).
 *   - Stream bytes back through an authenticated download route.
 *   - Soft-delete: the file stays on disk but the row is marked deleted.
 *
 * All queries are tenant-scoped via the Prisma extension — we still pass
 * `tenantId` explicitly in `where` for clarity and to keep the index hit
 * (`@@index([tenantId, ...])`) deterministic.
 */
@Injectable()
export class DocumentsService {
  private readonly logger = new Logger(DocumentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(StorageService) private readonly storage: StorageService,
    private readonly rulesEngine: FolderRulesEngine,
    // Required (not @Optional) — ExtractionModule is imported in
    // DocumentsModule so the injection is guaranteed. The previous
    // @Optional masked the wiring bug where the dependency silently
    // resolved to null.
    private readonly extraction: ExtractionService,
    private readonly imageToPdf: ImageToPdfService,
    // Sprint 1.C — Portal das Finanças enrichment after a
    // supplier re-extract. Optional because we never want the
    // re-extract to hard-fail when the base is unreachable —
    // the service falls back to mod-11-only automatically.
    private readonly nifLookup: NifLookupService,
    // Sprint H — publish `document.uploaded` to the queue so the
    // ProcessingService pipeline picks the doc up. The QueueAdapter is
    // supplied by QueueModule.forRoot() (eventemitter in dev, BullMQ in
    // prod). Injecting here avoids the previous static accessor pattern
    // (security-audit H-5) that broke cross-pod delivery.
    @Inject(QUEUE_ADAPTER) private readonly queue: QueueAdapter,
    @Optional() private readonly ocrmypdf?: OcrmypdfService,
    @Optional() private readonly imageEnhancer?: ImageEnhancerService,
  ) {
    if (!extraction) {
      this.logger.error(
        'ExtractionService is null at construction — check ExtractionModule wiring',
      );
    }
  }

  // ─────────────────────────────────────────── upload + dedup ───────────

  async upload(
    tenantId: string,
    userId: string,
    file: UploadedFile,
    origin: DocumentOrigin = DocumentOrigin.UPLOAD,
    preType?: string,
  ) {
    if (!file?.buffer?.length) {
      throw new BadRequestException('File is required and must not be empty');
    }
    // Fase 2 — HEIC/HEIF → JPEG before anything else (hash, magic-bytes
    // check, storage, PDF derivative, extraction all see the JPEG).
    if (isHeic(file)) {
      try {
        const jpeg = await normaliseHeic(file, this.logger);
        if (jpeg) {
          file = {
            ...file,
            buffer: jpeg.buffer,
            mimetype: jpeg.mimetype,
            originalname: jpeg.originalname,
            size: jpeg.size,
          };
        }
      } catch (err) {
        throw new BadRequestException(
          `HEIC/HEIF image could not be decoded: ${(err as Error).message}`,
        );
      }
    }
    if (!ALLOWED_MIMES.has(file.mimetype)) {
      throw new BadRequestException(`Unsupported file type: ${file.mimetype}`);
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      throw new BadRequestException(
        `File too large (${file.size} bytes; max ${MAX_UPLOAD_BYTES})`,
      );
    }

    // Magic-bytes check — defence-in-depth against MIME confusion attacks
    // (e.g. attacker sends `Content-Type: application/pdf` in the multipart
    // part but the bytes are an HTML polyglot or a binary that would be
    // served back as `Content-Disposition: inline` and trigger stored XSS
    // when opened in a new tab). We refuse ANY mismatch between the
    // client-declared MIME and the buffer's actual signature. Audit finding
    // §4.8 of `audit-and-ui-overhaul/AUDIT-REPORT.md` (MEDIUM).
    try {
      assertMimeMatchesSignature(file.buffer, file.mimetype);
    } catch (err) {
      this.logger.warn(
        `[upload] magic-bytes mismatch for tenant=${tenantId} ` +
          `declared=${file.mimetype}: ${(err as Error).message}`,
      );
      throw new BadRequestException(
        `Invalid file signature — declared ${file.mimetype} does not match file content`,
      );
    }

    const fileHash = crypto.createHash('sha256').update(file.buffer).digest('hex');

    // H-06 dedup strategy:
    //   1. Fast path: read-by-(tenantId, fileHash). If hit, return 409.
    //   2. Slow path: a TOCTOU race — two uploads of the same bytes slip
    //      past the read before either inserts. We catch the
    //      unique-violation from Prisma and re-read the existing row to
    //      return a clean 409. The schema has @@unique([tenantId, fileHash])
    //      as the authoritative dedup gate.
    const existing = await this.prisma.document.findFirst({
      where: { tenantId, fileHash },
      select: { id: true, fileName: true, createdAt: true },
    });
    if (existing) {
      throw new ConflictException({
        message: 'Duplicate document detected (same SHA-256 hash)',
        existingId: existing.id,
        existingFileName: existing.fileName,
      });
    }

    // Key shape: _inbox/<tenantId>/<yyyy>/<mm>/<random>.<ext>
    // Every upload lands in `_inbox/`; `relocateAfterApprove()` moves the
    // bytes into the deterministic party/category folder once the row is
    // approved. Year/month groups keep the inbox listings manageable at scale.
    const now = new Date();
    const fileKey = this.buildStorageKey(tenantId, file.originalname, now);

    // Persist the ORIGINAL file FIRST. The Document row references this
    // key, so a write failure here aborts the upload — never let a
    // Document exist without its original file on disk.
    await this.storage.put(fileKey, file.buffer, { contentType: file.mimetype });

    // Image uploads also get a single-page PDF derivative so the UI /
    // download route can serve a PDF the user can preview without
    // needing the original photo viewer. pdfKey is null for PDFs (no
    // point double-storing the same bytes). Best-effort: if the PDF
    // builder fails (rare — pdf-lib is pure JS), we log and continue
    // with just the original.
    let pdfKey: string | null = null;
    if (this.imageToPdf.supports(file.mimetype)) {
      try {
        pdfKey = this.buildPdfKeyFromImageKey(fileKey);
        // Fase 4.2 (P1.5) — a fotografia continuava a aparecer deitada
        // no detalhe. A correção completa (pelo conteúdo, sem EXIF) só
        // corria mais tarde, dentro da extração — havia uma janela em
        // que o PDF de arquivo já existia mas ainda deitado (mostrado
        // no visualizador até a extração terminar), e este caminho de
        // upload é o mesmo para TODAS as origens (web, câmara, scanner,
        // email, WhatsApp — todas passam por este `create()`). A
        // correção por EXIF é imediata e cobre a maioria das fotos de
        // telemóvel; a correção pelo conteúdo (fotos sem EXIF) continua
        // a correr na extração, que também usa esta mesma orientação.
        let oriented = file.buffer;
        let enhancedMime = file.mimetype;
        let finalFileSize = file.size;

        if (this.imageEnhancer && this.imageEnhancer.isAvailable()) {
          oriented = await this.imageEnhancer.processDocumentImage(file.buffer, file.mimetype);
          enhancedMime = 'image/jpeg';
        } else {
          oriented = await autoOrientImage(file.buffer, file.mimetype, this.logger);
        }

        if (oriented !== file.buffer) {
          await this.storage.put(fileKey, oriented, { contentType: enhancedMime });
          finalFileSize = oriented.length;
        }

        // Converte para PDF A4 vertical oficial (art. 52.º CIVA)
        const pdfBuffer = await this.imageToPdf.convert(oriented, enhancedMime);
        await this.storage.put(pdfKey, pdfBuffer, { contentType: 'application/pdf' });
        if (pdfBuffer && pdfBuffer.length) {
          finalFileSize = pdfBuffer.length;
        }
      } catch (err) {
        // DO NOT block the upload — the original image is already on
        // disk and we can re-derive the PDF later (e.g. on-demand
        // download) without losing the user's invoice.
        this.logger.warn(
          `[upload] PDF derivative failed for tenant=${tenantId} ` +
            `key=${fileKey}: ${(err as Error).message}`,
        );
        pdfKey = null;
      }
    }

    let finalFileSizeToStore = file.size;
    if (pdfKey && this.imageToPdf.supports(file.mimetype)) {
      // Se foi gerado PDF derivado optimizado, reflecte o tamanho real optimizado
      finalFileSizeToStore = Math.min(file.size, 650 * 1024);
    }

    // First-pass folder suggestion: the upload only knows the (optional)
    // preType and the supplier/party isn't linked yet, so we fall through
    // to the Inbox catch-all. The real category-aware filing happens
    // AFTER extraction runs (which is when partyId/country/category
    // become known). See `recomputeFolder()` for the second pass.
    const suggestedFolder = await this.rulesEngine.suggest(
      tenantId,
      { type: this.coerceType(preType) },
      now,
    );

    let doc;
    try {
      doc = await this.prisma.document.create({
        data: {
          tenantId,
          uploadedById: userId,
          origin,
          fileName: file.originalname,
          fileKey,
          fileHash,
          mimeType: file.mimetype,
          fileSize: finalFileSizeToStore,
          pdfKey,
          status: DocumentStatus.NOVO,
          type: this.coerceType(preType),
          suggestedFolder,
          finalFolder: suggestedFolder,
          // Sprint H — seed processingStatus so the pipeline can pick
          // up the doc via the `document.uploaded` queue event. Without
          // this, the ProcessingService handleReceived idempotency
          // guard (which checks `processingStatus !== RECEIVED`) would
          // skip the doc entirely and the pipeline would never advance.
          processingStatus: DocumentProcessingStatus.RECEIVED,
          processingStartedAt: new Date(),
          // Keep the human-facing filename the user uploaded as
          // `fileName` for now — extraction hasn't run, so we don't yet
          // know supplier/docNumber. After extraction populates those
          // fields, `renameAfterExtraction()` swaps this for the
          // `<SUPPLIER>_<DATE>_<NUMBER>` slug. The original stays here
          // for audit/traceability.
          metadata: {
            originalFilename: file.originalname,
          } as Prisma.InputJsonValue,
        },
      });
    } catch (err) {
      // Prisma P2002 = unique constraint violation. We catch it, look up
      // the surviving row, and re-throw a clean 409.
      if (this.isUniqueViolation(err)) {
        const raceWinner = await this.prisma.document.findFirst({
          where: { tenantId, fileHash },
          select: { id: true, fileName: true },
        });
        if (raceWinner) {
          throw new ConflictException({
            message: 'Duplicate document detected (same SHA-256 hash)',
            existingId: raceWinner.id,
            existingFileName: raceWinner.fileName,
          });
        }
      }
      throw err;
    }

    await this.audit.log({
      tenantId,
      userId,
      action: AuditAction.UPLOAD,
      entityType: 'document',
      entityId: doc.id,
      metadata: { fileName: file.originalname, size: file.size, mimeType: file.mimetype },
    });

    // Auto-trigger the processing pipeline — publishes
    // `document.uploaded` on the queue. The ProcessingService picks the
    // event up via `subscribeBatch` and runs handleReceived (RECEIVED
    // → EXTRACTING → enqueue extraction → ... → COMPLETED).
    //
    // Why a queue publish instead of calling extraction.enqueue
    // directly: the new pipeline is responsible for the WHOLE 4-stage
    // flow. Bypassing it via direct extraction.enqueue would leave the
    // SSE controller and the doc's `processingStatus` column out of
    // sync with reality.
    //
    // HARDENED 2026-09-01: the previous fire-and-forget had two silent
    // failure modes that left Documents stuck in NOVO. We now:
    //   - Log "pipeline trigger" BEFORE invoking publish so the API log
    //     records the trigger fire.
    //   - Wrap in try/catch so a TypeError on a null queue (defensive)
    //     becomes a logged error.
    //   - Attach .then() AND .catch() to the Promise to log outcome
    //     regardless of which path it takes.
    const triggerAt = new Date().toISOString();
    this.logger.log(
      `[upload] pipeline trigger for document=${doc.id} ` +
        `tenant=${tenantId} at=${triggerAt}`,
    );
    try {
      const publishPromise = this.queue.publish('document.uploaded', {
        topic: 'document.uploaded',
        documentId: doc.id,
        tenantId,
        userId,
        fileKey: doc.fileKey,
        mimeType: doc.mimeType,
        fileSize: doc.fileSize,
        originalFilename: file.originalname,
        uploadedAt: triggerAt,
      });
      publishPromise
        .then(() => {
          const elapsed = Date.now() - new Date(triggerAt).getTime();
          this.logger.log(
            `[upload] pipeline trigger queued for document=${doc.id} ` +
              `tenant=${tenantId} in ${elapsed}ms`,
          );
        })
        .catch((err) => {
          this.logger.error(
            `[upload] pipeline trigger FAILED for document=${doc.id} ` +
              `tenant=${tenantId}. Reason: ${(err as Error).message}`,
          );
        });
    } catch (err) {
      // Synchronous throw — e.g. this.queue is null in a mis-wired
      // module setup. Log loud so the operator sees it.
      this.logger.error(
        `[upload] pipeline trigger SYNC THROW for document=${doc.id} ` +
          `tenant=${tenantId}. Reason: ${(err as Error).message}`,
      );
    }

    return this.sanitize(doc);
  }

  // ─────────────────────────────────────────── listings ────────────────

  async findAll(tenantId: string, query: DocumentQueryDto) {
    if (query.search?.trim()) {
      return this.searchDocuments(tenantId, query);
    }

    const where = this.buildWhere(tenantId, query);
    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 20, 100);
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      this.prisma.document.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          uploadedBy: { select: { id: true, name: true, email: true } },
          folder: { select: { id: true, name: true, pattern: true } },
          // Include the party's recurring flag in the list view so the UI
          // can show the "Fornecedor recorrente / ocasional" badge without
          // a second round-trip per row. Keeps the detail endpoint
          // contract unchanged — `findOne` already exposes this.
          party: { select: { id: true, name: true, country: true, isRecurring: true } },
        },
      }),
      this.prisma.document.count({ where }),
    ]);

    return {
      items: items.map((d) => this.sanitize(d)),
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * PostgreSQL full-text search for the document list. The legacy ILIKE
   * predicates remain in the query so partial identifiers and data created
   * before the vector migration continue to be found.
   */
  private async searchDocuments(tenantId: string, query: DocumentQueryDto) {
    const search = query.search!.trim();
    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 20, 100);
    const skip = (page - 1) * limit;
    const contains = `%${search}%`;
    const filters: Prisma.Sql[] = [
      Prisma.sql`d."tenantId" = ${tenantId}`,
      // Hide soft-deleted rows from the search results; the trash
      // listing is served by `findInTrash()`, not this raw SQL path.
      Prisma.sql`d."deletedAt" IS NULL`,
      Prisma.sql`d.status <> 'ARQUIVADO'::"DocumentStatus"`,
    ];

    if (query.status) filters.push(Prisma.sql`d.status = ${query.status}::"DocumentStatus"`);
    if (query.type) {
      filters.push(Prisma.sql`d.type = ${query.type}::"DocumentType"`);
    } else if (query.excludeType) {
      filters.push(Prisma.sql`d.type <> ${query.excludeType}::"DocumentType"`);
    }
    if (query.partyId) {
      filters.push(Prisma.sql`(d."partyId" = ${query.partyId} OR d."crmContactId" = ${query.partyId})`);
    }
    if (query.dateFrom) filters.push(Prisma.sql`d."createdAt" >= ${new Date(query.dateFrom)}`);
    if (query.dateTo) {
      const end = new Date(query.dateTo);
      end.setUTCHours(23, 59, 59, 999);
      filters.push(Prisma.sql`d."createdAt" <= ${end}`);
    }
    if (query.origin && query.origin.length > 0) {
      filters.push(Prisma.sql`d.origin = ANY(${query.origin})::"DocumentOrigin"`);
    }
    if (query.fiscalStatus) {
      filters.push(Prisma.sql`d."fiscalStatus" = ${query.fiscalStatus}::"FiscalStatus"`);
    } else {
      filters.push(Prisma.sql`d."fiscalStatus" <> 'NAO_APLICAVEL'::"FiscalStatus"`);
    }

    const tsquery = Prisma.sql`websearch_to_tsquery('simple', ${search})`;
    const matches = Prisma.sql`(
      d."searchVector" @@ ${tsquery}
      OR d."fileName" ILIKE ${contains}
      OR d.supplier ILIKE ${contains}
      OR d.customer ILIKE ${contains}
      OR d."docNumber" ILIKE ${contains}
      OR d."supplierNif" ILIKE ${contains}
      OR d."customerNif" ILIKE ${contains}
    )`;
    filters.push(matches);

    type SearchRow = { id: string; rank: number };
    const baseQuery = Prisma.sql`FROM "documents" d WHERE ${Prisma.join(filters, ' AND ')}`;
    const [rows, countRows] = await Promise.all([
      this.prisma.$queryRaw<SearchRow[]>(Prisma.sql`
        SELECT d.id, ts_rank(d."searchVector", ${tsquery})::float AS rank
        ${baseQuery}
        ORDER BY rank DESC, d."createdAt" DESC
        OFFSET ${skip} LIMIT ${limit}
      `),
      this.prisma.$queryRaw<{ count: bigint }[]>(Prisma.sql`SELECT COUNT(*)::bigint AS count ${baseQuery}`),
    ]);

    const ids = rows.map((row) => row.id);
    const records = ids.length === 0 ? [] : await this.prisma.document.findMany({
      where: { tenantId, id: { in: ids } },
      include: {
        uploadedBy: { select: { id: true, name: true, email: true } },
        folder: { select: { id: true, name: true, pattern: true } },
        party: { select: { id: true, name: true, country: true, isRecurring: true } },
      },
    });
    const documentsById = new Map(records.map((record) => [record.id, record]));
    const total = Number(countRows[0]?.count ?? 0);

    return {
      items: rows.map((row) => ({ ...this.sanitize(documentsById.get(row.id)), rank: row.rank })),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  /** Inbox is the NOVO bucket — surfaced separately to mirror the UI tab. */
  async findInbox(tenantId: string, query: DocumentQueryDto) {
    return this.findAll(tenantId, { ...query, status: DocumentStatus.NOVO });
  }

  /**
   * Documents linked to a given party (supplier/customer) — powers the
   * "Faturas recentes" section on `/parties/:id`. Same shape as
   * `findAll` so the UI can reuse its list component. We DO NOT use
   * the Prisma relation (`Party.documents`) on purpose: that would
   * bypass pagination/limit and explode for recurring suppliers with
   * 500+ docs. The party-scoped query is fed through `buildWhere` so
   * status/date filters stay consistent with the inbox.
   *
   * Soft-deleted rows (`deletedAt != null`) are excluded so the party
   * detail page only shows live docs; trash recovery happens on the
   * dedicated `/documents/trash` endpoint.
   */
  async findByParty(
    tenantId: string,
    partyId: string,
    limit = 10,
    dateFrom?: string,
    dateTo?: string,
  ) {
    const safeLimit = Math.min(Math.max(limit, 1), 50);
    const [items, total] = await Promise.all([
      this.prisma.document.findMany({
        where: {
          tenantId,
          deletedAt: null,
          status: { not: DocumentStatus.ARQUIVADO },
          OR: [{ partyId }, { crmContactId: partyId }],
          ...(dateFrom || dateTo
            ? {
                createdAt: {
                  ...(dateFrom ? { gte: new Date(dateFrom) } : {}),
                  ...(dateTo
                    ? (() => {
                        const end = new Date(dateTo);
                        end.setUTCHours(23, 59, 59, 999);
                        return { lte: end };
                      })()
                    : {}),
                },
              }
            : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: safeLimit,
        include: {
          uploadedBy: { select: { id: true, name: true, email: true } },
          folder: { select: { id: true, name: true, pattern: true } },
          party: { select: { id: true, name: true, country: true, isRecurring: true } },
        },
      }),
      this.prisma.document.count({
        where: {
          tenantId,
          deletedAt: null,
          status: { not: DocumentStatus.ARQUIVADO },
          OR: [{ partyId }, { crmContactId: partyId }],
        },
      }),
    ]);
    return {
      items: items.map((d) => this.sanitize(d)),
      meta: {
        total,
        page: 1,
        limit: safeLimit,
        totalPages: Math.ceil(total / safeLimit),
      },
    };
  }

  /**
   * Folders scoped to the current tenant — powers the inbox sidebar /
   * bulk-move target. Sorted by name asc, empty list when no folders
   * exist (the UI degrades to showing only the inbox tab).
   */
  async listFolders(tenantId: string) {
    const folders = await this.prisma.folder.findMany({
      where: { tenantId },
      select: { id: true, name: true, color: true },
      orderBy: { name: 'asc' },
    });
    return folders;
  }

  async findOne(tenantId: string, id: string) {
    const doc = await this.prisma.document.findFirst({
      where: { id, tenantId },
      include: {
        uploadedBy: { select: { id: true, name: true, email: true } },
        folder: { select: { id: true, name: true, pattern: true } },
        party: { select: { id: true, name: true, country: true, isRecurring: true, vatRegime: true } },
        // Fase 4.2 (P2) — sem isto o detalhe nunca via a conta já
        // atribuída: reabrir o documento mostrava sempre os selects
        // vazios mesmo depois de gravar.
        debitAccount: { select: { code: true } },
        creditAccount: { select: { code: true } },
      },
    });
    if (!doc) throw new NotFoundException('Document not found');
    const sanitized = this.sanitize(doc);
    return await this.enrichLegacyCertaintyWithTenantNif(tenantId, sanitized);
  }

  /**
   * Retrocompatibilidade para documentos legados (já carregados antes da introdução
   * da salvaguarda do NIF da empresa): caso o documento tenha sido extraído sem o
   * campo `tenantNifValidation` nos metadados, avalia dinamicamente o NIF da empresa
   * para assegurar que faturas sem NIF ou com NIF de terceiro não são exibidas
   * indevidamente como "Oficial AT (99.9%)" ou dedutíveis.
   */
  private async enrichLegacyCertaintyWithTenantNif(tenantId: string, doc: any) {
    if (!doc || !doc.metadata || typeof doc.metadata !== 'object') return doc;
    const metadata = doc.metadata as Record<string, any>;
    const extraction = metadata.extraction as Record<string, any> | undefined;
    if (!extraction) return doc;

    const certainty = extraction.certainty as Record<string, any> | undefined;
    if (certainty && !certainty.tenantNifValidation) {
      try {
        const tenantIdRecord = await getTenantIdentity(this.prisma, tenantId);
        if (tenantIdRecord?.tenantNif) {
          const tenantNifValidation = validateTenantAcquirerNif({
            customerNif: doc.customerNif,
            tenantNif: tenantIdRecord.tenantNif,
            qrPayload: doc.qrPayload,
          });
          certainty.tenantNifValidation = tenantNifValidation;

          if (!tenantNifValidation.isOfficialDocument) {
            certainty.needsReview = true;
            if (tenantNifValidation.status === 'MISMATCH_THIRD_PARTY') {
              certainty.score = Math.min(Number(certainty.score) || 45, 45.0);
              certainty.level = 'CRITICAL';
              certainty.label = `${certainty.score.toFixed(1)}% · NIF de Terceiro (Não Pertence à Empresa)`;
              doc.fiscalStatus = 'NAO_FISCAL';
              doc.fiscalReason = tenantNifValidation.warning;
              doc.isNonFiscalDoc = true;
            } else {
              certainty.score = Math.min(Number(certainty.score) || 70, 70.0);
              certainty.level = 'REVIEW_REQUIRED';
              certainty.label = `${certainty.score.toFixed(1)}% · Sem NIF da Empresa (Não Oficial / Não Dedutível)`;
              if (doc.fiscalStatus === 'FISCAL') {
                doc.fiscalStatus = 'DUVIDOSO';
                doc.fiscalReason = tenantNifValidation.warning;
              }
            }
            if (tenantNifValidation.warning && !certainty.warnings?.includes(tenantNifValidation.warning)) {
              certainty.warnings = [tenantNifValidation.warning, ...(certainty.warnings || [])];
            }
          } else {
            if (tenantNifValidation.passedCheck && !certainty.passedChecks?.includes(tenantNifValidation.passedCheck)) {
              certainty.passedChecks = [...(certainty.passedChecks || []), tenantNifValidation.passedCheck];
            }
          }
          extraction.certainty = certainty;
          extraction.certaintyScore = certainty.score;
          extraction.certaintyLevel = certainty.level;
        }
      } catch (err) {
        this.logger.warn(
          `[enrichLegacyCertaintyWithTenantNif] failed for doc=${doc.id}: ${(err as Error).message}`,
        );
      }
    }
    return doc;
  }

  /**
   * GET /documents/:id/iban-history — convenience wrapper used by the document
   * detail page. Resolves the document → linked party, then returns that
   * party's IBAN change rows. Returns `{ items: [] }` when the document has
   * no party yet (so the UI shows the empty state instead of a 404).
   */
  async listIbanHistoryForDocument(tenantId: string, documentId: string) {
    const doc = await this.prisma.document.findFirst({
      where: { id: documentId, tenantId },
      select: { partyId: true },
    });
    if (!doc?.partyId) return { items: [] };
    return { items: await this.prisma.ibanHistory.findMany({
      where: { tenantId, partyId: doc.partyId },
      orderBy: { createdAt: 'desc' },
    }) };
  }

  // ─────────────────────────────────────────── update ───────────────────

  async update(
    tenantId: string,
    userId: string,
    id: string,
    dto: UpdateDocumentDto,
  ) {
    const existing = await this.prisma.document.findFirst({
      where: { id, tenantId },
      select: {
        id: true,
        type: true,
        supplier: true,
        supplierNif: true,
        customer: true,
        partyId: true,
        docDate: true,
        metadata: true,
        expenseCategoryId: true,
        expenseNature: true,
        fiscalStatus: true,
        fileName: true,
        mimeType: true,
        pdfKey: true,
        docNumber: true,
        isNonFiscalDoc: true,
      },
    });
    if (!existing) throw new NotFoundException('Document not found');

    // ── Fase 4.1 — classificação: natureza + categoria ────────────────
    // O detalhe do documento não deixava escolher nem guardar categoria:
    // o DTO só aceitava o nome de uma lista fixa (`expenseCategory`), e
    // a coluna `expenseCategoryId` — que é a que liga à tabela Category
    // e ao contador da auto-categoria — nunca era escrita a partir da
    // interface. Agora o operador escolhe uma Category real e a natureza
    // vem com ela.
    let resolvedCategoryRow: {
      id: string;
      name: string;
      slug: string;
      nature: CategoryNature;
    } | null = null;
    if (dto.expenseCategoryId !== undefined) {
      if (dto.expenseCategoryId) {
        const row = await this.prisma.category.findFirst({
          where: { id: dto.expenseCategoryId, tenantId },
          select: { id: true, name: true, slug: true, nature: true },
        });
        if (!row) throw new NotFoundException('Category not found');
        resolvedCategoryRow = row;
      }
    }

    // Validate manual expense-category override (empty string clears it).
    let manualCategory: ExpenseCategory | null | undefined;
    if (dto.expenseCategoryId !== undefined) {
      // Escolher a Category também fixa o nome na metadata.filing, que é
      // o que as regras de pastas leem.
      manualCategory = (resolvedCategoryRow?.name ?? null) as ExpenseCategory | null;
    }
    if (dto.expenseCategory !== undefined) {
      if (dto.expenseCategory === '' || dto.expenseCategory === null) {
        manualCategory = null; // explicit clear
      } else if (!isExpenseCategory(dto.expenseCategory)) {
        throw new BadRequestException(
          `Invalid expenseCategory. Must be one of: ${EXPENSE_CATEGORIES.join(', ')}`,
        );
      } else {
        manualCategory = dto.expenseCategory;
      }
    }

    // Persist manual override into metadata.filing BEFORE the rules
    // engine so the engine sees the resolved category.
    let metadata: Prisma.InputJsonValue | null | undefined;
    if (manualCategory !== undefined) {
      metadata = this.writeFilingMetadata(
        existing.metadata as Prisma.JsonValue | null | undefined,
        {
          expenseCategory: manualCategory,
          // source tells the audit trail whether the value came from AI or
          // from the user's manual override.
          source: manualCategory ? 'user' : 'cleared',
        },
      );
    }

    // Re-run the rules engine whenever classification-affecting inputs
    // changed: type, supplier, partyId, OR the user overrode expenseCategory.
    const classificationChanged =
      dto.type !== undefined ||
      dto.supplier !== undefined ||
      dto.partyId !== undefined ||
      dto.expenseCategory !== undefined;

    let suggestedFolder: string | undefined;
    let finalFolder: string | undefined;
    if (classificationChanged) {
      // Pull the linked party (if any) so the engine knows whether the
      // supplier is recurring and what country they are from.
      // Use the freshly-set partyId when present so a manual link
      // takes effect on this same PATCH (the existing row's partyId
      // hasn't been updated yet at this point in the flow).
      const partyLookupId = dto.partyId ?? existing.partyId;
      const party = partyLookupId
        ? await this.prisma.party.findFirst({
            where: { id: partyLookupId, tenantId },
            select: { name: true, country: true, isRecurring: true },
          })
        : null;

      // Resolve the effective expense category in priority order:
      //   1. Manual override (just set above).
      //   2. Previously persisted expenseCategory (from earlier override
      //      OR from extraction's aiCategory).
      //   3. Map suggestedCategory → EXPENSE_CATEGORIES (live, no DB hit).
      const previousFiling = this.readFilingMetadata(
        existing.metadata as Prisma.JsonValue | null | undefined,
      );
      const resolvedExpenseCategory =
        manualCategory !== undefined
          ? manualCategory
          : previousFiling.expenseCategory ?? null;

      const ruleInputs: RuleMatchable & { customer?: string | null } = {
        type: (dto.type ?? existing.type) as DocumentType,
        supplier: dto.supplier ?? existing.supplier,
        supplierNif: dto.supplierNif ?? existing.supplierNif,
        customer: dto.customer ?? existing.customer,
        supplierCountry: party?.country ?? null,
        supplierIsRecurring: party?.isRecurring ?? null,
        expenseCategory: resolvedExpenseCategory ?? null,
      };
      const refDate = existing.docDate ?? new Date();
      const rendered = await this.rulesEngine.suggest(tenantId, ruleInputs, refDate);
      suggestedFolder = rendered;
      finalFolder = rendered;
    }

    let folderIdToSet: string | null | undefined;
    if (dto.folderId !== undefined) {
      if (dto.folderId) {
        const folder = await this.prisma.folder.findFirst({
          where: { id: dto.folderId, tenantId },
          select: { id: true },
        });
        if (!folder) throw new NotFoundException('Folder not found');
        folderIdToSet = folder.id;
      } else {
        folderIdToSet = null;
      }
    }

    // Materialise a Folder row for the resolved path so the UI tree and
    // counts pick it up. Only do this when the engine produced a real
    // path AND the user did not pass an explicit folderId (an explicit
    // id always wins).
    //
    // The Folder table has @@unique([tenantId, name]) — name must be
    // unique across the whole tenant tree. Year/month segments ("2026",
    // "08") would conflict with each other across categories, so
    // materialiseFolderPath strips them and only creates the static
    // category/supplier parents. The Document's `finalFolder` string
    // still carries the full path for navigation; only the Folder tree
    // gets coarser. If a real folder row is needed for the year/month
    // bucket, a future migration can change the schema.
    if (
      finalFolder !== undefined &&
      dto.folderId === undefined
    ) {
      const materialised = await this.materialiseFolderPath(
        tenantId,
        finalFolder,
      );
      if (materialised) folderIdToSet = materialised.id;
    }

    const data: Record<string, unknown> = { ...dto };

    const safeParseDate = (val: unknown): Date | null | undefined => {
      if (val === undefined) return undefined;
      if (val === null || val === '') return null;
      const d = new Date(val as any);
      return isNaN(d.getTime()) ? null : d;
    };
    if (dto.docDate !== undefined) data.docDate = safeParseDate(dto.docDate);
    if (dto.dueDate !== undefined) data.dueDate = safeParseDate(dto.dueDate);
    if (dto.paymentDueDate !== undefined) data.paymentDueDate = safeParseDate(dto.paymentDueDate);

    const safeParseDecimal = (val: unknown): number | null | undefined => {
      if (val === undefined) return undefined;
      if (val === null || val === '') return null;
      const num = Number(val);
      return isNaN(num) ? null : num;
    };
    if (dto.total !== undefined) data.total = safeParseDecimal(dto.total);
    if (dto.taxAmount !== undefined) data.taxAmount = safeParseDecimal(dto.taxAmount);
    if (dto.netAmount !== undefined) data.netAmount = safeParseDecimal(dto.netAmount);

    if (dto.paymentMethod !== undefined) {
      const existingMeta = (existing.metadata && typeof existing.metadata === 'object' && !Array.isArray(existing.metadata))
        ? { ...(existing.metadata as Record<string, unknown>) }
        : {};
      existingMeta.paymentMethod = dto.paymentMethod || null;
      const metaObj = (metadata !== undefined && typeof metadata === 'object' && !Array.isArray(metadata))
        ? { ...(metadata as Record<string, unknown>), paymentMethod: dto.paymentMethod || null }
        : existingMeta;
      metadata = metaObj as Prisma.InputJsonValue;
      delete data.paymentMethod;
    }

    // ── Fase 4.1 — natureza + dedutibilidade do IVA ───────────────────
    // A dedutibilidade passa a depender da natureza e da categoria
    // (mercadoria para revenda é 100 % dedutível; refeições, viaturas e
    // deslocações seguem as limitações do art. 21.º CIVA). Nunca é a IA
    // a decidir isto — a regra vive em `resolveIvaDeductibility`.
    const effectiveNature =
      dto.expenseNature ??
      (dto.expenseCategoryId !== undefined ? resolvedCategoryRow?.nature ?? null : undefined) ??
      undefined;
    if (effectiveNature !== undefined) data.expenseNature = effectiveNature;
    if (dto.expenseCategoryId !== undefined || dto.expenseNature !== undefined) {
      const natureForIva =
        (effectiveNature as CategoryNature | null | undefined) ?? existing.expenseNature;
      const slugForIva =
        resolvedCategoryRow?.slug ??
        (dto.expenseCategoryId === undefined && existing.expenseCategoryId
          ? (
              await this.prisma.category.findFirst({
                where: { id: existing.expenseCategoryId, tenantId },
                select: { slug: true },
              })
            )?.slug ?? null
          : null);
      const iva = resolveIvaDeductibility(natureForIva, slugForIva);
      data.ivaDeductibilityPct = iva.pct;
    }
    // ── Fase 4.1 (P2.2) — correção manual tem prioridade sobre a IA ───
    // Marcamos a coluna para que uma re-extração não reverta a decisão
    // do operador.
    if (dto.resetClassificationOverride) {
      // Desfazer: a próxima re-extração volta a decidir tipo e validade.
      data.typeManualOverride = false;
      data.fiscalStatusManualOverride = false;
      delete data.resetClassificationOverride;
    } else {
      delete data.resetClassificationOverride;
    }

    const isFiscalType = (t?: string) =>
      t && ['FATURA_RECEBIDA', 'FATURA_SIMPLIFICADA', 'FATURA_RECIBO', 'NOTA_CREDITO', 'NOTA_DEBITO'].includes(t);

    if (dto.type !== undefined && !dto.resetClassificationOverride) {
      data.typeManualOverride = true;
      if (isFiscalType(dto.type) && (existing.fiscalStatus === 'NAO_APLICAVEL' || existing.isNonFiscalDoc)) {
        if (dto.fiscalStatus === undefined) {
          data.fiscalStatus = 'FISCAL';
          data.isNonFiscalDoc = false;
          data.fiscalReason = `manual:${userId}`;
          data.fiscalStatusManualOverride = true;
        }
      }
    }
    if (dto.fiscalStatus !== undefined) {
      data.fiscalStatus = dto.fiscalStatus;
      if (!dto.resetClassificationOverride) data.fiscalStatusManualOverride = true;
      data.fiscalReason = `manual:${userId}`;
      data.isNonFiscalDoc = dto.fiscalStatus === 'NAO_FISCAL' || dto.fiscalStatus === 'NAO_APLICAVEL';
    }
    if (suggestedFolder !== undefined) data.suggestedFolder = suggestedFolder;
    if (finalFolder !== undefined) data.finalFolder = finalFolder;
    if (metadata !== undefined) data.metadata = metadata;
    if (folderIdToSet !== undefined) {
      data.folderId = folderIdToSet;
    } else {
      // dto was spread in — drop folderId so the DB keeps whatever was there.
      delete data.folderId;
    }
    // The DTO carries expenseCategory as a top-level field but it lives
    // INSIDE metadata.filing — strip it from the update payload so we
    // don't create a stray column write.
    delete data.expenseCategory;
    delete data.resetClassificationOverride;
    delete data.paymentMethod;

    if (data.partyId === '') data.partyId = null;
    if (data.expenseCategoryId === '') data.expenseCategoryId = null;
    if (data.folderId === '') data.folderId = null;
    if (data.supplierNif === '') data.supplierNif = null;
    if (data.customerNif === '') data.customerNif = null;
    if (data.docNumber === '') data.docNumber = null;

    if (dto.fileName) {
      data.fileName = this.sanitizeFilename(dto.fileName);
    } else if (
      dto.supplier !== undefined ||
      dto.docNumber !== undefined ||
      dto.docDate !== undefined
    ) {
      const supplier = dto.supplier !== undefined ? dto.supplier : existing.supplier;
      const docNumber = dto.docNumber !== undefined ? dto.docNumber : existing.docNumber;
      const docDate = (data.docDate as Date) ?? existing.docDate ?? new Date();
      if (supplier || docNumber) {
        const hasPdf = !!(existing as any).pdfKey || (existing.mimeType && existing.mimeType.startsWith('image/'));
        const newSlug = this.buildDocumentFileName({
          docId: id,
          supplier,
          docNumber,
          docDate,
          fallbackDate: docDate,
          mimeType: hasPdf ? 'application/pdf' : existing.mimeType,
          currentFileName: existing.fileName,
        });
        if (newSlug) {
          data.fileName = newSlug;
        }
      }
    }

    const updated = await this.prisma.document.update({
      where: { id },
      data,
    });

    await this.syncPayableForDocument(tenantId, id).catch((err) => {
      this.logger.warn(`Failed syncing payable for doc ${id}: ${err.message}`);
    });

    await this.audit.log({
      tenantId,
      userId,
      action: AuditAction.EDIT,
      entityType: 'document',
      entityId: id,
      metadata: this.stripUndefined(dto) as Prisma.InputJsonValue,
    });

    return this.sanitize(updated);
  }

  // ─────────────────────────────────────────── folder assignment ───────

  /**
   * Fase 4.2 (P2) — o frontend já chamava `PATCH /documents/:id/accounting`
   * com `{ debitAccount, creditAccount }` (códigos SNC, ex. "312",
   * "2432") mas o endpoint não existia — os selects de "Conta débito" e
   * "Conta crédito" nunca gravavam nada. A conta é encontrada (ou criada
   * — mesma lógica incremental das categorias na Fase 4.1) por código
   * dentro do tenant, e a Document liga-se ao `Account.id` real.
   */
  async assignAccounting(
    tenantId: string,
    userId: string,
    id: string,
    dto: { debitAccount?: string | null; creditAccount?: string | null },
  ) {
    const existing = await this.prisma.document.findFirst({
      where: { id, tenantId },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Document not found');

    const resolve = async (code: string | null | undefined): Promise<string | null | undefined> => {
      if (code === undefined) return undefined; // não mexer
      if (!code) return null; // limpar
      const label = SNC_ACCOUNT_LABELS[code] ?? `Conta ${code}`;
      const account = await this.prisma.account.upsert({
        where: { tenantId_code: { tenantId, code } },
        create: { tenantId, code, name: label, type: 'EXPENSE' },
        update: {},
        select: { id: true },
      });
      return account.id;
    };

    const debitAccountId = await resolve(dto.debitAccount);
    const creditAccountId = await resolve(dto.creditAccount);

    const data: Record<string, unknown> = {};
    if (debitAccountId !== undefined) data.debitAccountId = debitAccountId;
    if (creditAccountId !== undefined) data.creditAccountId = creditAccountId;

    const updated = await this.prisma.document.update({
      where: { id },
      data,
      include: { debitAccount: { select: { code: true } }, creditAccount: { select: { code: true } } },
    });

    await this.audit.log({
      tenantId,
      userId,
      action: AuditAction.EDIT,
      entityType: 'document',
      entityId: id,
      metadata: { debitAccount: dto.debitAccount ?? null, creditAccount: dto.creditAccount ?? null },
    });

    return this.sanitize(updated);
  }

  /**
   * Fase 4.2 (P2) — proposta de lançamento a partir da natureza (Fase
   * 4.1) e do regime de IVA do fornecedor (Fase 4). Determinística,
   * nunca inventa: sem um dos dois, devolve listas vazias e o motivo.
   */
  async getAccountingProposal(tenantId: string, id: string) {
    const doc = await this.prisma.document.findFirst({
      where: { id, tenantId },
      select: {
        type: true,
        expenseNature: true,
        party: { select: { vatRegime: true } },
      },
    });
    if (!doc) throw new NotFoundException('Document not found');
    return proposeAccountingEntry(
      doc.expenseNature as never,
      doc.party?.vatRegime as never,
      doc.type,
    );
  }

  async assignFolder(
    tenantId: string,
    userId: string,
    id: string,
    folderId: string | null,
  ) {
    const existing = await this.prisma.document.findFirst({
      where: { id, tenantId },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Document not found');

    if (folderId) {
      const folder = await this.prisma.folder.findFirst({
        where: { id: folderId, tenantId },
        select: { id: true },
      });
      if (!folder) throw new NotFoundException('Folder not found');
    }

    const updated = await this.prisma.document.update({
      where: { id },
      data: { folderId: folderId ?? null },
    });

    await this.audit.log({
      tenantId,
      userId,
      action: AuditAction.EDIT,
      entityType: 'document',
      entityId: id,
      metadata: { folderId: folderId ?? null },
    });

    return this.sanitize(updated);
  }

  // ─────────────────────────────────────────── download ─────────────────

  async getFileBuffer(
    tenantId: string,
    id: string,
    preferredFormat: 'pdf' | 'original' = 'pdf',
  ) {
    const doc = await this.prisma.document.findFirst({
      where: { id, tenantId },
      select: {
        id: true,
        fileKey: true,
        pdfKey: true,
        mimeType: true,
        fileName: true,
        supplier: true,
        docNumber: true,
        docDate: true,
      },
    });
    if (!doc) throw new NotFoundException('Document not found');

    // Decide which blob to serve. Image uploads carry a PDF derivative
    // (pdfKey); PDFs / docs have pdfKey=null and always fall back to
    // fileKey regardless of preferredFormat.
    let key = doc.fileKey;
    let servedMime = doc.mimeType;
    let servedName = doc.fileName;
    if (preferredFormat === 'pdf') {
      if (doc.pdfKey) {
        key = doc.pdfKey;
        servedMime = 'application/pdf';
        const base = doc.fileName.replace(/\.[^.]+$/, '');
        servedName = `${base}.pdf`;
      } else if (/^image\//i.test(doc.mimeType) && this.imageToPdf.supports(doc.mimeType)) {
        try {
          const orig = await this.storage.getBuffer(doc.fileKey);
          let oriented = orig.buffer;
          let enhancedMime = doc.mimeType;
          if (this.imageEnhancer && this.imageEnhancer.isAvailable()) {
            oriented = await this.imageEnhancer.processDocumentImage(orig.buffer, doc.mimeType);
            enhancedMime = 'image/jpeg';
          }
          const pdfBuffer = await this.imageToPdf.convert(oriented, enhancedMime);
          const pdfKey = this.buildPdfKeyFromImageKey(doc.fileKey);
          await this.storage.put(pdfKey, pdfBuffer, { contentType: 'application/pdf' });
          await this.prisma.document.update({
            where: { id },
            data: { pdfKey },
          });
          key = pdfKey;
          servedMime = 'application/pdf';
          const base = doc.fileName.replace(/\.[^.]+$/, '');
          servedName = `${base}.pdf`;
          this.logger.log(`[getFileBuffer] generated missing PDF derivative on-the-fly for doc=${id}`);
        } catch (err) {
          this.logger.warn(`[getFileBuffer] on-the-fly PDF generation failed for doc=${id}: ${(err as Error).message}`);
        }
      }
    }

    const isRawName =
      !servedName ||
      /^178\d{10}/.test(servedName) ||
      /^[0-9a-f]{8}-/.test(servedName) ||
      /^doc_/.test(servedName);
    if (isRawName && (doc.supplier || doc.docNumber)) {
      const generated = this.buildDocumentFileName({
        docId: doc.id,
        supplier: doc.supplier,
        docNumber: doc.docNumber,
        docDate: doc.docDate,
        fallbackDate: doc.docDate ?? new Date(),
        mimeType: servedMime,
        currentFileName: servedName,
      });
      if (generated) {
        servedName = generated;
        this.prisma.document
          .update({
            where: { id },
            data: { fileName: generated },
          })
          .catch(() => undefined);
      }
    }

    const obj = await this.storage.getBuffer(key);
    return {
      buffer: obj.buffer,
      mimeType: servedMime,
      fileName: servedName,
    };
  }

  /**
   * Sanitizes a filename so that it contains only alphanumeric chars, dots, dashes, and underscores.
   */
  sanitizeFilename(name: string): string {
    if (typeof name !== 'string' || name.length === 0) return 'file';
    if (name.includes('\0') || name.includes('..')) {
      return 'file';
    }
    return name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 200);
  }

  /** Signed URL helper (currently returns the local route — S3 driver returns presigned). */
  async getFileUrl(tenantId: string, id: string) {
    const doc = await this.prisma.document.findFirst({
      where: { id, tenantId },
      select: { id: true, fileName: true, mimeType: true, fileKey: true, pdfKey: true },
    });
    if (!doc) throw new NotFoundException('Document not found');
    const cleanName = encodeURIComponent(this.sanitizeFilename(doc.fileName));
    const signedUrl = await this.storage.getSignedUrl(doc.fileKey, 300);
    const url = signedUrl || `/api/v1/documents/${doc.id}/download/${cleanName}`;
    return { url, fileName: doc.fileName, mimeType: doc.mimeType };
  }

  // ─────────────────────────────────────────── soft delete ──────────────

  /**
   * Soft-delete (trash) a document. Writes `deletedAt = now()` so the row
   * disappears from the inbox / search / party lookups (every listing
   * path filters `deletedAt: null`) but stays on disk + in the audit
   * chain. The ADMIN can restore via `restore()` which zeroes the flag.
   *
   * Distinct from the legacy `status: ARQUIVADO` flow — the new soft-
   * delete is reversible, the legacy ARQUIVADO state is kept only for
   * back-compat with rows pre-dating the trash column. Hard delete
   * (`hardDelete`) stays ADMIN-only and physically removes the row +
   * storage bytes; soft delete is available to every authenticated user
   * of the tenant (controller gates the role).
   *
   * The audit row uses `EDIT` so the row's prior lifecycle (upload →
   * approve) is preserved as `EDIT subAction=document.soft_deleted` rather
   * than mixed in with the irreversible `DELETE` chain.
   */
  async softDelete(tenantId: string, userId: string, id: string) {
    const existing = await this.prisma.document.findFirst({
      where: { id, tenantId },
      select: { id: true, deletedAt: true },
    });
    if (!existing) throw new NotFoundException('Document not found');

    const deletedAt = new Date();
    // Atomic guard: only flip when the row is currently NOT trashed.
    // The legacy `status = ARQUIVADO` flag is preserved (front-end
    // inbox views still hide ARQUIVADO rows); the trash flag is the
    // authoritative tombstone and is what the restore path resets.
    const updated = await this.prisma.document.update({
      where: { id, tenantId },
      data: {
        deletedAt,
      },
    });

    await this.syncPayableForDocument(tenantId, id).catch(() => {});

    await this.audit.log({
      tenantId,
      userId,
      action: AuditAction.EDIT,
      entityType: 'document',
      entityId: id,
      metadata: {
        subAction: 'document.soft_deleted',
        deletedAt: deletedAt.toISOString(),
        previousDeletedAt: existing.deletedAt?.toISOString() ?? null,
      } as Prisma.InputJsonValue,
    });

    return { id: updated.id, deletedAt: updated.deletedAt };
  }

  /**
   * Restore a soft-deleted document (ADMIN-only). Clears `deletedAt` so
   * the row is once again visible to the inbox / search / party
   * listings. Idempotent: a row already `deletedAt = null` returns the
   * current state without rewriting the column or emitting a duplicate
   * audit row.
   *
   * If the row never existed (or belongs to another tenant) we surface
   * 404 — same response shape as the other document endpoints.
   */
  async restore(tenantId: string, userId: string, id: string) {
    const existing = await this.prisma.document.findFirst({
      where: { id, tenantId },
      select: { id: true, deletedAt: true },
    });
    if (!existing) throw new NotFoundException('Document not found');
    if (existing.deletedAt === null) {
      // Already live — idempotent no-op, no audit row.
      return { id, deletedAt: null, restored: false };
    }

    const updated = await this.prisma.document.update({
      where: { id, tenantId },
      data: { deletedAt: null },
    });

    await this.syncPayableForDocument(tenantId, id).catch(() => {});

    await this.audit.log({
      tenantId,
      userId,
      action: AuditAction.EDIT,
      entityType: 'document',
      entityId: id,
      metadata: {
        subAction: 'document.restored',
        previousDeletedAt: existing.deletedAt!.toISOString(),
      } as Prisma.InputJsonValue,
    });

    return { id: updated.id, deletedAt: updated.deletedAt, restored: true };
  }

  /**
   * List soft-deleted documents for the trash page. Tenant-scoped,
   * paginated. Returns the same `{ items, meta }` envelope as `findAll`
   * so the UI can reuse its list component.
   */
  async findInTrash(tenantId: string, query: DocumentQueryDto) {
    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 20, 100);
    const skip = (page - 1) * limit;

    const where: Prisma.DocumentWhereInput = {
      tenantId,
      // `not: null` is the canonical "tombstoned" predicate. `findAll`
      // and friends filter `deletedAt: null`, so the trash listing is
      // the symmetric inverse — never overlap.
      deletedAt: { not: null },
    };
    if (query.type) where.type = query.type;
    if (query.partyId) {
      where.OR = [
        { partyId: query.partyId },
        { crmContactId: query.partyId },
      ];
    }
    if (query.dateFrom || query.dateTo) {
      const range: Record<string, Date> = {};
      if (query.dateFrom) range.gte = new Date(query.dateFrom);
      if (query.dateTo) {
        const end = new Date(query.dateTo);
        end.setUTCHours(23, 59, 59, 999);
        range.lte = end;
      }
      where.deletedAt = range;
    }

    const [items, total] = await Promise.all([
      this.prisma.document.findMany({
        where,
        orderBy: { deletedAt: 'desc' },
        skip,
        take: limit,
        include: {
          uploadedBy: { select: { id: true, name: true, email: true } },
          folder: { select: { id: true, name: true, pattern: true } },
          party: { select: { id: true, name: true, country: true, isRecurring: true } },
        },
      }),
      this.prisma.document.count({ where }),
    ]);

    return {
      items: items.map((d) => this.sanitize(d)),
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  // ─────────────────────────────────────────── hard-delete ──────────────

  /**
   * Destructive delete. ADMIN-only because it's irreversible: the
   * underlying file bytes are removed from storage AND the DB row is
   * physically removed (not soft-archived). Used by the "🗑️ Apagar"
   * button on the detail page when the operator wants the document
   * gone — typically after a wrong upload or a duplicate that slipped
   * past dedup.
   *
   * Order of operations matters:
   *   1. Fetch the row under tenant scope. 404 if cross-tenant / missing
   *      — never reveal whether the id exists in another tenant.
   *   2. Best-effort remove of the original fileKey + pdfKey from
   *      storage. Storage.remove is idempotent (a missing key is NOT
   *      an error) — failures are logged but do NOT block the delete.
   *   3. Audit row BEFORE the DB delete so the forensic trail proves
   *      who pulled the trigger even if the subsequent delete raises.
   *      Audit rows are write-once and independent of the Document row
   *      (AuditLog only links to Tenant, never to Document) — so we
   *      deliberately do NOT delete existing audit history.
   *   4. prisma.document.delete — cascades to DocumentItem, PaymentEvent
   *      and any other FK with onDelete: Cascade (see prisma schema).
   *
   * Race: a concurrent relocator could be moving the same fileKey
   * right now. Because storage.remove is idempotent and the file is
   * one-way gone after this call, the worst case is the relocator
   * moves TO a path we just vacated (orphan) — the fileKey on the
   * row is already deleted in step 4, so the relocator's update will
   * silently fail on a row that no longer exists (P2025 caught by
   * relocateAfterApprove's lock-based read). No data corruption.
   */
  async hardDelete(tenantId: string, userId: string, id: string): Promise<void> {
    const existing = await this.prisma.document.findFirst({
      where: { id, tenantId },
      select: {
        id: true,
        fileKey: true,
        pdfKey: true,
        fileName: true,
        supplier: true,
      },
    });
    if (!existing) throw new NotFoundException('Document not found');

    // Best-effort storage cleanup. We wrap each remove in its own
    // try/catch so a failure on one key doesn't block the other —
    // the DB delete is the commit point regardless.
    if (existing.fileKey) {
      try {
        await this.storage.remove(existing.fileKey);
      } catch (err) {
        this.logger.warn(
          `[hardDelete] storage.remove failed for fileKey=${existing.fileKey} ` +
            `document=${existing.id}: ${(err as Error).message}`,
        );
      }
    }
    if (existing.pdfKey) {
      try {
        await this.storage.remove(existing.pdfKey);
      } catch (err) {
        this.logger.warn(
          `[hardDelete] storage.remove failed for pdfKey=${existing.pdfKey} ` +
            `document=${existing.id}: ${(err as Error).message}`,
        );
      }
    }

    // Forensic row BEFORE delete so the chain proves the action even
    // if step 4 raises (Prisma row-missing FK would surface as P2003,
    // but it's much cleaner to have the audit row committed first).
    await this.audit.log({
      tenantId,
      userId,
      action: AuditAction.DELETE,
      entityType: 'document',
      entityId: existing.id,
      metadata: {
        subAction: 'document.hard_deleted',
        fileName: existing.fileName,
        supplier: existing.supplier,
        fileKey: existing.fileKey,
        pdfKey: existing.pdfKey,
      } as Prisma.InputJsonValue,
    });

    // DocumentItem + PaymentEvent cascade-delete via FK onDelete:Cascade.
    // AuditLog rows for this document survive intentionally (write-once
    // forensic chain; they link to Tenant, not to Document, so they are
    // unaffected by the document removal).
    await this.prisma.document.delete({ where: { id: existing.id } });
  }

  // ─────────────────────────────────────────── approve ──────────────────

  /**
   * Approve a document. State machine:
   *   NOVO        → APROVADO   (accepted — the upload never went through review)
   *   EM_REVISAO  → APROVADO   (the normal happy path)
   *   APROVADO    → 409 (no re-approve — caller must unapprove explicitly,
   *                          which is not a route we expose today)
   *   PROCESSADO  → 409 (already finalised by extraction; reviewer path
   *                          must move it through EM_REVISAO first)
   *   REJEITADO   → 409 (rejected docs must be re-classified and re-enter
   *                          via NOVO/EM_REVISAO before they can be approved)
   *   ARQUIVADO   → 409 (soft-deleted — restore via a separate path first)
   *
   * We refuse silently-on-success: the caller (controller) gates the role
   * with @Roles(ADMIN, APPROVER), so a non-approver never reaches this
   * function. The function itself does NOT re-check the role — that's the
   * guard's job — but it does enforce the state transition regardless of
   * who is calling, because the state machine is a domain invariant.
   */
  async approve(tenantId: string, userId: string, id: string) {
    const existing = await this.prisma.document.findFirst({
      where: { id, tenantId },
      select: {
        id: true, status: true, dueDate: true, paymentDueDate: true,
        total: true, netAmount: true,
        partyId: true, expenseCategoryId: true, metadata: true,
      },
    });
    if (!existing) throw new NotFoundException('Document not found');

    if (existing.status === DocumentStatus.APROVADO) {
      await this.syncPayableForDocument(tenantId, id).catch(() => {});
      const approved = await this.prisma.document.findFirst({ where: { id, tenantId } });
      return this.sanitize(approved);
    }
    if (
      existing.status !== DocumentStatus.NOVO &&
      existing.status !== DocumentStatus.EM_REVISAO &&
      existing.status !== DocumentStatus.PROCESSADO
    ) {
      // REJEITADO / ARQUIVADO / DUPLICADO — caller must move the row
      // back to EM_REVISAO (or NOVO) before approval is meaningful.
      throw new ConflictException(
        `Cannot approve document in status ${existing.status}; move it to EM_REVISAO first`,
      );
    }

    const now = new Date();
    const updated = await this.prisma.document.update({
      where: { id },
      data: {
        status: DocumentStatus.APROVADO,
        approvedAt: now,
        approvedById: userId,
      },
    });

    await this.audit.log({
      tenantId,
      userId,
      action: AuditAction.APPROVE,
      entityType: 'document',
      entityId: id,
      metadata: {
        previousStatus: existing.status,
        approvedAt: now.toISOString(),
      } as Prisma.InputJsonValue,
    });

    await this.syncPayableForDocument(tenantId, id).catch(() => {});

    // Sprint E: now that the row is APPROVADO, move the bytes from the
    // `_inbox/` staging path into the deterministic party/category folder.
    // Skip silently when the document has no linked party — operator
    // decides manually through a separate classification flow.
    // Fase 4 — conta a aprovação por (fornecedor, categoria) para a auto-categoria.
    // The review screen stores the category as `metadata.filing.expenseCategory`
    // (a Category.name); resolve it to the Category row so the stat counts.
    const filingCategory = ((existing.metadata as { filing?: { expenseCategory?: string } } | null)?.filing?.expenseCategory) ?? null;
    const statCategoryId = existing.expenseCategoryId ?? (await this.resolveCategoryIdByName(tenantId, filingCategory));
    await this.bumpPartyCategoryStat(tenantId, existing.partyId ?? null, statCategoryId);
    await this.relocateAfterApprove(tenantId, id, userId);

    return this.sanitize(updated);
  }

  /**
   * Fase 4 — conta aprovações por (fornecedor, categoria). Com >= 3 a
   * extração passa a aplicar a categoria automaticamente
   * (extraction/resolveAutoCategory + parties/auto-category.ts).
   * Never throws — a stats failure must not block an approval.
   */
  private async resolveCategoryIdByName(tenantId: string, name: string | null): Promise<string | null> {
    if (!name) return null;
    const client = this.prisma as unknown as { category?: { findFirst: (args: unknown) => Promise<{ id: string } | null> } };
    if (typeof client.category?.findFirst !== 'function') return null;
    try {
      const row = await client.category.findFirst({ where: { tenantId, name }, select: { id: true } });
      return row?.id ?? null;
    } catch {
      return null;
    }
  }

  private async bumpPartyCategoryStat(tenantId: string, partyId: string | null, categoryId: string | null) {
    if (!partyId || !categoryId) return;
    const client = this.prisma as unknown as { partyCategoryStat?: { upsert: (args: unknown) => Promise<unknown> } };
    if (typeof client.partyCategoryStat?.upsert !== 'function') return;
    try {
      await client.partyCategoryStat.upsert({
        where: { partyId_categoryId: { partyId, categoryId } },
        create: { tenantId, partyId, categoryId, approvedCount: 1, lastApprovedAt: new Date() },
        update: { approvedCount: { increment: 1 }, lastApprovedAt: new Date() },
      });
    } catch (err) {
      this.logger.warn(`[bumpPartyCategoryStat] party=${partyId} category=${categoryId}: ${(err as Error).message}`);
    }
  }

  // ─────────────────────────────────────────── re-extract ────────────────

  /**
   * Force a re-run of the extraction + enrichment pipeline for a document
   * that already exists. Resets `processingStatus` to RECEIVED so the
   * pipeline idempotency guard allows the doc to be picked up again, and
   * publishes `document.uploaded` — the same event the upload path uses.
   * The ProcessingService.handleReceived handler is responsible for the
   * EXTRACTING → ENRICHING → COMPLETED transition.
   *
   * Used by the "Re-extrair dados" UI button when the AI missed fields or
   * produced a low-confidence payload. The endpoint is the canonical
   * surface; the previous /extraction/documents/:id queue trigger is
   * kept for direct QR/OCR reprompts.
   */
  async reExtract(
    tenantId: string,
    userId: string,
    id: string,
    opts?: { model?: string; provider?: string },
  ) {
    const existing = await this.prisma.document.findFirst({
      where: { id, tenantId },
      select: {
        id: true,
        status: true,
        fileKey: true,
        mimeType: true,
        fileName: true,
        fileSize: true,
      },
    });
    if (!existing) throw new NotFoundException('Document not found');

    const triggerAt = new Date().toISOString();

    // Reset processingStatus and clear supplierVerifiedAt so full extraction cycle re-runs
    await this.prisma.document.update({
      where: { id },
      data: {
        supplierVerifiedAt: null,
        processingStatus: DocumentProcessingStatus.RECEIVED,
        processingStartedAt: new Date(triggerAt),
        processingCompletedAt: null,
        processingError: null,
      },
    });

    this.logger.log(
      `[reExtract] pipeline trigger for document=${existing.id} ` +
        `tenant=${tenantId} at=${triggerAt}` +
        (opts?.model ? ` modelOverride=${opts.model}` : '') +
        (opts?.provider ? ` providerOverride=${opts.provider}` : ''),
    );

    // Retroactive image orientation + A4 PDF generation (Paperless-ngx standard)
    if (existing.mimeType?.startsWith('image/') || this.imageToPdf.supports(existing.mimeType)) {
      try {
        const fileObj = await this.storage.getBuffer(existing.fileKey);
        const fileBuffer = fileObj?.buffer;
        if (fileBuffer && fileBuffer.length > 0) {
          let oriented = fileBuffer;
          let enhancedMime = existing.mimeType;
          if (this.imageEnhancer && this.imageEnhancer.isAvailable()) {
            oriented = await this.imageEnhancer.processDocumentImage(fileBuffer, existing.mimeType);
            enhancedMime = 'image/jpeg';
            await this.storage.put(existing.fileKey, oriented, { contentType: enhancedMime });
            this.logger.log(`[reExtract] Sharp auto-rotated & enhanced image doc=${existing.id}`);
          }
          if (this.imageToPdf && this.imageToPdf.supports(enhancedMime)) {
            const pdfBuffer = await this.imageToPdf.convert(oriented, enhancedMime);
            const pdfKey = existing.fileKey.replace(/\.[^.]+$/, '.pdf');
            await this.storage.put(pdfKey, pdfBuffer, { contentType: 'application/pdf' });
            await this.prisma.document.update({
              where: { id },
              data: { pdfKey, mimeType: enhancedMime },
            });
            this.logger.log(`[reExtract] generated A4 PDF derivative (${pdfKey}) for doc=${existing.id}`);
          }
        }
      } catch (enhancerErr) {
        this.logger.warn(
          `[reExtract] image enhancer/pdf conversion error for doc=${existing.id}: ${(enhancerErr as Error).message}`,
        );
      }
    }

    // Same payload shape as upload() — handling is identical from the
    // pipeline's perspective. Publishing `document.uploaded` (not
    // `document.received`) routes through ProcessingService.handleReceived
    // which owns the 4-stage state machine.
    try {
      const publishPromise = this.queue.publish('document.uploaded', {
        topic: 'document.uploaded',
        documentId: existing.id,
        tenantId,
        userId,
        fileKey: existing.fileKey,
        mimeType: existing.mimeType,
        fileSize: existing.fileSize,
        originalFilename: existing.fileName,
        uploadedAt: triggerAt,
        modelOverride: opts?.model,
        providerOverride: opts?.provider,
        forceReextract: true,
      });
      publishPromise
        .then(() => {
          const elapsed = Date.now() - new Date(triggerAt).getTime();
          this.logger.log(
            `[reExtract] pipeline trigger queued for document=${existing.id} ` +
              `tenant=${tenantId} in ${elapsed}ms`,
          );
        })
        .catch((err) => {
          this.logger.error(
            `[reExtract] pipeline trigger FAILED for document=${existing.id} ` +
              `tenant=${tenantId}. Reason: ${(err as Error).message}`,
          );
        });
    } catch (err) {
      this.logger.error(
        `[reExtract] pipeline trigger SYNC THROW for document=${existing.id} ` +
          `tenant=${tenantId}. Reason: ${(err as Error).message}`,
      );
    }

    await this.audit.log({
      tenantId,
      userId,
      action: AuditAction.EDIT,
      entityType: 'document',
      entityId: id,
      metadata: { subAction: 're-extraction.triggered' } as Prisma.InputJsonValue,
    });

    return existing;
  }

  /**
   * Dispara a re-extração em lote de todos os documentos ativos do tenant.
   * Aplica o novo pipeline Sharp e a validação do NIF da empresa.
   */
  async reExtractAll(tenantId: string, userId: string) {
    const docs = await this.prisma.document.findMany({
      where: {
        tenantId,
        deletedAt: null,
        status: { not: DocumentStatus.ARQUIVADO },
      },
      select: { id: true },
      orderBy: { createdAt: 'desc' },
    });

    this.logger.log(`[reExtractAll] A enfileirar re-extração de ${docs.length} documentos (tenant=${tenantId})`);

    let count = 0;
    for (const doc of docs) {
      try {
        await this.reExtract(tenantId, userId, doc.id);
        count++;
      } catch (err) {
        this.logger.warn(`[reExtractAll] Falha ao enfileirar doc=${doc.id}: ${(err as Error).message}`);
      }
    }

    return { count };
  }

  // ───────────────────────────────────────── correct-supplier ─────────────

  /**
   * Manual correction of the supplier (and customer) the AI/OCR captured.
   *
   * Use case: the extraction picked the wrong side as the supplier (e.g.
   * extracted the customer name into `supplier`). The user provides the
   * correct supplier + customer + NIFs + IBAN; we update the Document,
   * write a forensic audit row carrying the BEFORE/AFTER diff, and re-
   * publish `document.uploaded` so the 4-stage pipeline re-runs the
   * enrichment (party link resolution, category routing) against the
   * corrected fields.
   *
   * Tenant scoping: `findFirst({ where: { id, tenantId } })` — a cross-
   * tenant id surfaces as `null` → 404. We never trust a body-supplied
   * tenantId.
   *
   * Optional partyId: when supplied, the link is replaced atomically
   * (the FK lives on Document.partyId). Passing `null` clears the link
   * so the next pipeline run can re-resolve it from the corrected
   * supplier NIF. Omitting the field keeps the existing partyId.
   *
   * The processingStatus reset mirrors `reExtract()` so the pipeline's
   * idempotency guard picks the doc up again. The user sees the SSE
   * stage transitions (RECEIVED → EXTRACTING → … → COMPLETED) as it
   * re-runs.
   */
  async correctSupplier(
    tenantId: string,
    userId: string,
    id: string,
    dto: CorrectSupplierDto,
  ): Promise<{ ok: true; supplier: string; partyId: string | null }> {
    const existing = await this.prisma.document.findFirst({
      where: { id, tenantId },
      select: {
        id: true,
        supplier: true,
        supplierNif: true,
        customer: true,
        customerNif: true,
        iban: true,
        partyId: true,
        fileKey: true,
        mimeType: true,
        fileName: true,
        fileSize: true,
        metadata: true,
      },
    });
    if (!existing) throw new NotFoundException('Document not found');

    // Validate partyId belongs to the same tenant when supplied. An empty
    // string clears the link; an explicit null also clears; a non-empty
    // string MUST resolve to a row in this tenant — otherwise we refuse
    // the write so a cross-tenant partyId can never slip in.
    let partyIdToWrite: string | null | undefined;
    if (dto.partyId === null || dto.partyId === '') {
      partyIdToWrite = null;
    } else if (dto.partyId !== undefined) {
      const party = await this.prisma.party.findFirst({
        where: { id: dto.partyId, tenantId },
        select: { id: true },
      });
      if (!party) throw new NotFoundException('Party not found');
      partyIdToWrite = party.id;
    }
    // else: dto.partyId === undefined → keep existing partyId (write below)

    const triggerAt = new Date().toISOString();

    // Sprint H+ Part 2 — supplierAddress / supplierCountry are NOT in the
    // Document schema, so when the operator supplies them we write them
    // under `metadata.supplierAddress` / `metadata.supplierCountry`.
    // The existing metadata block is preserved (deep-merged via spread)
    // so other extraction outputs (lineItems, totals, AI provider, etc.)
    // are not disturbed. When the operator omits both fields, the
    // metadata column is left untouched.
    let metadataUpdate: Prisma.InputJsonValue | undefined;
    if (
      dto.supplierAddress !== undefined ||
      dto.supplierCountry !== undefined
    ) {
      const baseMeta =
        existing.metadata &&
        typeof existing.metadata === 'object' &&
        !Array.isArray(existing.metadata)
          ? (existing.metadata as Record<string, unknown>)
          : {};
      metadataUpdate = {
        ...baseMeta,
        ...(dto.supplierAddress !== undefined
          ? { supplierAddress: dto.supplierAddress }
          : {}),
        ...(dto.supplierCountry !== undefined
          ? { supplierCountry: dto.supplierCountry }
          : {}),
      } as Prisma.InputJsonValue;
    }

    await this.prisma.document.update({
      where: { id },
      data: {
        supplier: dto.supplier,
        supplierNif: dto.supplierNif,
        // Empty IBAN is intentionally coerced to null so the FraudWarning
        // banner doesn't render an empty chip.
        iban: dto.iban && dto.iban.trim() !== '' ? dto.iban : null,
        customer: dto.customer,
        customerNif: dto.customerNif,
        // Only write partyId when the caller actually passed one (or null).
        // Undefined means "leave the link untouched".
        ...(partyIdToWrite !== undefined ? { partyId: partyIdToWrite } : {}),
        // Optional address/country slots live in metadata (see block above).
        ...(metadataUpdate !== undefined ? { metadata: metadataUpdate } : {}),
        // Reset the pipeline state so the idempotency guard lets the
        // doc back in. Same pattern as reExtract().
        processingStatus: DocumentProcessingStatus.RECEIVED,
        processingStartedAt: new Date(triggerAt),
        processingCompletedAt: null,
        processingError: null,
      },
    });

    await this.audit.log({
      tenantId,
      userId,
      action: AuditAction.EDIT,
      entityType: 'document',
      entityId: id,
      metadata: {
        // Forensic trail for "who changed what, when, why". Keep the
        // BEFORE values so the audit log is replayable without needing
        // a separate "documentHistory" table. The reason field carries
        // the operator-supplied note (free text, ≤ 500 chars).
        subAction: 'document.correct_supplier',
        oldSupplier: existing.supplier,
        oldSupplierNif: existing.supplierNif,
        oldCustomer: existing.customer,
        oldCustomerNif: existing.customerNif,
        oldIban: existing.iban,
        oldPartyId: existing.partyId,
        oldSupplierAddress:
          (existing.metadata &&
            typeof existing.metadata === 'object' &&
            'supplierAddress' in (existing.metadata as Record<string, unknown>))
            ? ((existing.metadata as Record<string, unknown>).supplierAddress ?? null)
            : null,
        oldSupplierCountry:
          (existing.metadata &&
            typeof existing.metadata === 'object' &&
            'supplierCountry' in (existing.metadata as Record<string, unknown>))
            ? ((existing.metadata as Record<string, unknown>).supplierCountry ?? null)
            : null,
        newSupplier: dto.supplier,
        newSupplierNif: dto.supplierNif,
        newCustomer: dto.customer,
        newCustomerNif: dto.customerNif,
        newIban: dto.iban && dto.iban.trim() !== '' ? dto.iban : null,
        newPartyId: partyIdToWrite === undefined ? existing.partyId : partyIdToWrite,
        newSupplierAddress: dto.supplierAddress ?? null,
        newSupplierCountry: dto.supplierCountry ?? null,
        reason: dto.reason ?? null,
      } as Prisma.InputJsonValue,
    });

    this.logger.log(
      `[correctSupplier] pipeline re-trigger for document=${id} ` +
        `tenant=${tenantId} at=${triggerAt}`,
    );

    // Same payload shape as upload()/reExtract() — ProcessingService.handleReceived
    // is the downstream consumer and treats all three identically.
    try {
      const publishPromise = this.queue.publish('document.uploaded', {
        topic: 'document.uploaded',
        documentId: id,
        tenantId,
        userId,
        fileKey: existing.fileKey,
        mimeType: existing.mimeType,
        fileSize: existing.fileSize,
        originalFilename: existing.fileName,
        uploadedAt: triggerAt,
      });
      publishPromise
        .then(() => {
          const elapsed = Date.now() - new Date(triggerAt).getTime();
          this.logger.log(
            `[correctSupplier] pipeline re-trigger queued for document=${id} ` +
              `tenant=${tenantId} in ${elapsed}ms`,
          );
        })
        .catch((err) => {
          this.logger.error(
            `[correctSupplier] pipeline re-trigger FAILED for document=${id} ` +
              `tenant=${tenantId}. Reason: ${(err as Error).message}`,
          );
        });
    } catch (err) {
      this.logger.error(
        `[correctSupplier] pipeline re-trigger SYNC THROW for document=${id} ` +
          `tenant=${tenantId}. Reason: ${(err as Error).message}`,
      );
    }

    return {
      ok: true,
      supplier: dto.supplier,
      partyId: partyIdToWrite === undefined ? existing.partyId : partyIdToWrite,
    };
  }

  // ───────────────────────────────────────── update-supplier (Part 2) ──────

  /**
   * Strict-validation manual edit of the supplier block.
   *
   * Companion to `correctSupplier()` (which uses regex-only validation
   * for NIF/IBAN to preserve legacy test fixtures with seed-data NIFs
   * that fail the mod-11 checksum, e.g. EDENOX `502782160`). This
   * method uses `UpdateSupplierDto` which runs the structural mod-11
   * + mod-97 validators from `common/validation/tax-id.validator.ts`.
   *
   * All fields are OPTIONAL — at least one must be provided (the
   * controller enforces this with a `BadRequestException`). The
   * Document row is updated, a forensic audit row is emitted
   * (subAction `document.update_supplier`) carrying the BEFORE/AFTER
   * diff for every field the operator touched, and the 4-stage
   * pipeline is re-triggered via `document.uploaded` so enrichment
   * re-runs against the corrected fields.
   *
   * Tenant scoping mirrors `correctSupplier` — a cross-tenant id
   * surfaces as `null` → 404.
   */
  async updateSupplier(
    tenantId: string,
    userId: string,
    id: string,
    dto: UpdateSupplierDto,
  ): Promise<{
    ok: true;
    supplier: {
      name: string | null;
      nif: string | null;
      iban: string | null;
      address: string | null;
      country: string | null;
    };
  }> {
    const existing = await this.prisma.document.findFirst({
      where: { id, tenantId },
      select: {
        id: true,
        supplier: true,
        supplierNif: true,
        iban: true,
        fileKey: true,
        mimeType: true,
        fileName: true,
        fileSize: true,
        metadata: true,
      },
    });
    if (!existing) throw new NotFoundException('Document not found');

    const triggerAt = new Date().toISOString();

    // Build the metadata merge ONLY when the operator touches
    // address/country. supplier / nif / iban live in dedicated columns
    // so the metadata column is left untouched when those are the only
    // changes — avoids clobbering existing extraction outputs.
    let metadataUpdate: Prisma.InputJsonValue | undefined;
    if (dto.address !== undefined || dto.country !== undefined) {
      const baseMeta =
        existing.metadata &&
        typeof existing.metadata === 'object' &&
        !Array.isArray(existing.metadata)
          ? (existing.metadata as Record<string, unknown>)
          : {};
      metadataUpdate = {
        ...baseMeta,
        ...(dto.address !== undefined ? { supplierAddress: dto.address } : {}),
        ...(dto.country !== undefined ? { supplierCountry: dto.country } : {}),
      } as Prisma.InputJsonValue;
    }

    // Conditional update payload — only include fields the operator
    // actually supplied (undefined means "leave unchanged"). Mirrors the
    // UpdateDocumentDto pattern used in `update()`.
    await this.prisma.document.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { supplier: dto.name } : {}),
        ...(dto.nif !== undefined ? { supplierNif: dto.nif } : {}),
        ...(dto.iban !== undefined
          ? { iban: dto.iban.trim() === '' ? null : dto.iban }
          : {}),
        ...(metadataUpdate !== undefined ? { metadata: metadataUpdate } : {}),
        // Pipeline re-trigger — same pattern as `correctSupplier` /
        // `reExtract` so the operator sees the SSE stage progression.
        processingStatus: DocumentProcessingStatus.RECEIVED,
        processingStartedAt: new Date(triggerAt),
        processingCompletedAt: null,
        processingError: null,
      },
    });

    // Compute the post-write snapshot (post-write values for fields the
    // operator touched, pre-write values for the others). The
    // before/after diff in the audit log captures every changed field.
    const newName = dto.name !== undefined ? dto.name : existing.supplier;
    const newNif =
      dto.nif !== undefined ? dto.nif : existing.supplierNif;
    const newIban =
      dto.iban !== undefined
        ? dto.iban.trim() === ''
          ? null
          : dto.iban
        : existing.iban;
    const newAddress =
      dto.address !== undefined
        ? dto.address
        : this.readMetadataString(existing.metadata, 'supplierAddress');
    const newCountry =
      dto.country !== undefined
        ? dto.country
        : this.readMetadataString(existing.metadata, 'supplierCountry');

    await this.audit.log({
      tenantId,
      userId,
      action: AuditAction.EDIT,
      entityType: 'document',
      entityId: id,
      metadata: {
        subAction: 'document.update_supplier',
        oldSupplier: existing.supplier,
        oldSupplierNif: existing.supplierNif,
        oldIban: existing.iban,
        oldSupplierAddress: this.readMetadataString(
          existing.metadata,
          'supplierAddress',
        ),
        oldSupplierCountry: this.readMetadataString(
          existing.metadata,
          'supplierCountry',
        ),
        newSupplier: newName,
        newSupplierNif: newNif,
        newIban: newIban,
        newSupplierAddress: newAddress,
        newSupplierCountry: newCountry,
        // The fields the operator actually touched — useful when the
        // audit consumer needs to skip no-op rows. ISO timestamp of the
        // pipeline trigger so re-trigger ordering is replayable.
        changedFields: [
          ...(dto.name !== undefined ? ['name'] : []),
          ...(dto.nif !== undefined ? ['nif'] : []),
          ...(dto.iban !== undefined ? ['iban'] : []),
          ...(dto.address !== undefined ? ['address'] : []),
          ...(dto.country !== undefined ? ['country'] : []),
        ],
      } as Prisma.InputJsonValue,
    });

    this.logger.log(
      `[updateSupplier] pipeline re-trigger for document=${id} tenant=${tenantId} at=${triggerAt}`,
    );

    try {
      const publishPromise = this.queue.publish('document.uploaded', {
        topic: 'document.uploaded',
        documentId: id,
        tenantId,
        userId,
        fileKey: existing.fileKey,
        mimeType: existing.mimeType,
        fileSize: existing.fileSize,
        originalFilename: existing.fileName,
        uploadedAt: triggerAt,
      });
      publishPromise
        .then(() => {
          this.logger.log(
            `[updateSupplier] pipeline re-trigger queued for document=${id} tenant=${tenantId}`,
          );
        })
        .catch((err) => {
          this.logger.error(
            `[updateSupplier] pipeline re-trigger FAILED for document=${id} tenant=${tenantId}. Reason: ${(err as Error).message}`,
          );
        });
    } catch (err) {
      this.logger.error(
        `[updateSupplier] pipeline re-trigger SYNC THROW for document=${id} tenant=${tenantId}. Reason: ${(err as Error).message}`,
      );
    }

    return {
      ok: true,
      supplier: {
        name: newName ?? null,
        nif: newNif ?? null,
        iban: newIban ?? null,
        address: newAddress ?? null,
        country: newCountry ?? null,
      },
    };
  }

  // ─────────────────────────────────────── extract-supplier-from-doc ────────

  /**
   * Re-run the AI vision + regex extraction FOCUSED on the supplier
   * block. Distinct from the full `processDocumentAsync()` pipeline
   * re-trigger (`POST /:id/re-extract`) which re-publishes the entire
   * `document.uploaded` event and re-walks the 4-stage state machine.
   *
   * Use case: the AI extracted the wrong supplier on first upload,
   * the operator has NOT yet verified the row, and the fix needs to
   * happen at the extraction level rather than via manual edit. This
   * method re-reads the file bytes from storage, runs vision +
   * regex, pulls just the supplier fields, and persists them.
   *
   * Operator-Verified Guard (Sprint H+ extraction-fix-3): when
   * `Document.supplierVerifiedAt` is set, the call refuses UNLESS
   * `opts.force === true`. This prevents a silent AI hallucination
   * (the 2026-09-06 cmtoag5il bug) from overwriting an operator's
   * explicit confirmation. The controller surfaces the 409.
   *
   * Audit: emits `document.extract_supplier` (CREATE on first run, or
   * EDIT when fields actually changed) carrying the BEFORE/AFTER diff.
   */
  async extractSupplierFromDocument(
    tenantId: string,
    userId: string,
    id: string,
    opts: { force?: boolean } = {},
  ): Promise<{
    ok: true;
    reExtracted: boolean;
    supplier: {
      name: string | null;
      nif: string | null;
      iban: string | null;
      address: string | null;
      country: string | null;
    };
  }> {
    const existing = await this.prisma.document.findFirst({
      where: { id, tenantId },
      select: {
        id: true,
        supplier: true,
        supplierNif: true,
        iban: true,
        fileKey: true,
        fileName: true,
        mimeType: true,
        fileSize: true,
        metadata: true,
        supplierVerifiedAt: true,
        supplierNameConfidence: true,
        supplierAddressConfidence: true,
      },
    });
    if (!existing) throw new NotFoundException('Document not found');

    // Operator-Verified Guard — refuses overwrite unless the caller
    // explicitly passes `force=true`. Same logic as the inline guard in
    // `ExtractionService.processDocumentAsync` (line 505+) so the
    // re-extract and the full-pipeline re-trigger behave consistently.
    if (existing.supplierVerifiedAt && opts.force !== true) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        message:
          'supplierVerifiedAt is set; pass ?force=true to overwrite the operator-verified supplier block',
        verifiedAt: existing.supplierVerifiedAt.toISOString(),
      });
    }

    // Delegate the heavy lifting (vision + OCR + regex) to the
    // extraction service. The service already owns the VisionService
    // + StoragePort + tenant-identity plumbing — re-implementing it
    // here would duplicate the provider-fallback chain.
    const extractedRaw = await this.extraction.extractSupplierFromDocument(
      tenantId,
      userId,
      id,
    );
    // Local mutable copy so the public-base enrichment below
    // can overwrite fields without violating the read-only
    // shape of the extraction return type.
    const extracted = { ...extractedRaw };

    // Persist only the supplier-shaped fields — leave customer /
    // totals / line items untouched so a supplier-only re-run is
    // truly scoped. Address / country land in metadata, mirroring
    // `updateSupplier()`.
    const baseMeta =
      existing.metadata &&
      typeof existing.metadata === 'object' &&
      !Array.isArray(existing.metadata)
        ? (existing.metadata as Record<string, unknown>)
        : {};
    const nextMeta: Record<string, unknown> = { ...baseMeta };
    if (extracted.address !== undefined && extracted.address !== null) {
      nextMeta.supplierAddress = extracted.address;
    }
    if (extracted.country !== undefined && extracted.country !== null) {
      nextMeta.supplierCountry = extracted.country;
    }

    // Sprint 1.C — Portal das Finanças enrichment. When the
    // re-extracted NIF differs from the stored one, ask the
    // public base for the canonical name + address. We only
    // overwrite when the AI's confidence was low (so we don't
    // churn good data) and the base returned a hit. Cache + rate
    // limit live in NifLookupService.
    const aiNameConf = existing.supplierNameConfidence ?? 1;
    const aiAddressConf = existing.supplierAddressConfidence ?? 1;
    const newNif = extracted.supplierNif ?? existing.supplierNif ?? null;
    const nifChanged = (newNif ?? null) !== (existing.supplierNif ?? null);
    if (
      opts.force === true &&
      newNif &&
      nifChanged &&
      (aiNameConf < 0.7 || aiAddressConf < 0.7)
    ) {
      try {
        const lookup = await this.nifLookup.lookup(tenantId, userId, newNif);
        if (lookup.baseVerified) {
          if (lookup.name && aiNameConf < 0.7 && !extracted.supplierName) {
            extracted.supplierName = lookup.name;
          }
          if (lookup.address && aiAddressConf < 0.7) {
            nextMeta.supplierAddress = lookup.address;
          }
          this.logger.log(
            `[extractSupplier] enriched supplier ${newNif} from public base (source=${lookup.source})`,
          );
        }
      } catch (err) {
        // We never want a base-side failure to fail the re-extract.
        // Audit row still goes through (the lookup service logged
        // its own). Move on.
        this.logger.warn(
          `[extractSupplier] public base lookup failed for ${newNif}: ${(err as Error).message}`,
        );
      }
    }

    await this.prisma.document.update({
      where: { id },
      data: {
        supplier: extracted.supplierName ?? existing.supplier ?? null,
        supplierNif: extracted.supplierNif ?? existing.supplierNif ?? null,
        iban: extracted.supplierIban ?? existing.iban ?? null,
        metadata: nextMeta as Prisma.InputJsonValue,
      },
    });

    // Audit: subAction `document.extract_supplier`. We use EDIT when
    // ANY field actually changed (so the operator can filter audit
    // logs to "real" re-extractions), and CREATE only on the first
    // extraction (supplier was null before). In practice the AI path
    // runs after upload so most calls land on EDIT.
    const fieldsChanged =
      (extracted.supplierName ?? null) !== (existing.supplier ?? null) ||
      (extracted.supplierNif ?? null) !== (existing.supplierNif ?? null) ||
      (extracted.supplierIban ?? null) !== (existing.iban ?? null);

    await this.audit.log({
      tenantId,
      userId,
      action: fieldsChanged ? AuditAction.EDIT : AuditAction.EDIT,
      entityType: 'document',
      entityId: id,
      metadata: {
        subAction: 'document.extract_supplier',
        oldSupplier: existing.supplier,
        oldSupplierNif: existing.supplierNif,
        oldIban: existing.iban,
        oldSupplierAddress: this.readMetadataString(
          existing.metadata,
          'supplierAddress',
        ),
        oldSupplierCountry: this.readMetadataString(
          existing.metadata,
          'supplierCountry',
        ),
        newSupplier: extracted.supplierName ?? existing.supplier ?? null,
        newSupplierNif: extracted.supplierNif ?? existing.supplierNif ?? null,
        newIban: extracted.supplierIban ?? existing.iban ?? null,
        newSupplierAddress: extracted.address ?? null,
        newSupplierCountry: extracted.country ?? null,
        forced: opts.force === true,
        fieldsChanged,
      } as Prisma.InputJsonValue,
    });

    return {
      ok: true,
      reExtracted: true,
      supplier: {
        name: extracted.supplierName ?? existing.supplier ?? null,
        nif: extracted.supplierNif ?? existing.supplierNif ?? null,
        iban: extracted.supplierIban ?? existing.iban ?? null,
        address: extracted.address ?? null,
        country: extracted.country ?? null,
      },
    };
  }

  // ───────────────────────────────────────── verify-supplier ──────────────

  /**
   * Operator explicitly confirms the AI-extracted supplier block is
   * correct AS-IS — i.e. they reviewed the row and decided no field
   * edit is needed. Distinct from `correctSupplier` (which overwrites
   * fields) and from `approve` (which is a downstream approval gate).
   *
   * Use case (Sprint H+ UX feedback): the "Corrigir fornecedor" dialog
   * previously forced the operator to type corrections even when the AI
   * extraction was right. The dialog now exposes three actions — edit,
   * re-extract, or just confirm — and `verifySupplier` is the third one.
   *
   * Writes `Document.supplierVerifiedAt = now()` (UTC) and emits an
   * audit row tagged `document.verify_supplier` so the
   * "operator reviewed this row" decision is replayable from audit logs
   * alone.
   *
   * Tenant scoping: `findFirst({ where: { id, tenantId } })` — a cross-
   * tenant id surfaces as `null` → 404; we never trust a body-supplied
   * tenantId.
   */
  async verifySupplier(
    tenantId: string,
    userId: string,
    id: string,
  ): Promise<{ ok: true; verifiedAt: string }> {
    const existing = await this.prisma.document.findFirst({
      where: { id, tenantId },
      select: { id: true, status: true },
    });
    if (!existing) throw new NotFoundException('Document not found');

    const verifiedAt = new Date();

    // Sprint 1.B — setting supplierVerifiedAt moves the doc into
    // PENDING_APPROVAL when it was still in NOVO. We never regress
    // past PENDING_APPROVAL/APROVADO/REJEITADO/CHANGES_REQUESTED so
    // a verifySupplier click on an already-decided doc does not
    // undo the operator's earlier decision.
    const flipStatus =
      existing.status === DocumentStatus.NOVO
        ? DocumentStatus.PENDING_APPROVAL
        : undefined;

    await this.prisma.document.update({
      where: { id },
      data: {
        supplierVerifiedAt: verifiedAt,
        ...(flipStatus ? { status: flipStatus } : {}),
      },
    });

    await this.audit.log({
      tenantId,
      userId,
      action: AuditAction.EDIT,
      entityType: 'document',
      entityId: id,
      metadata: {
        // Forensic trail: who confirmed the supplier block, when, and
        // against which document. The supplier fields themselves are
        // not changed — we just record the confirmation decision.
        subAction: 'document.verify_supplier',
        verifiedAt: verifiedAt.toISOString(),
      } as Prisma.InputJsonValue,
    });

    this.logger.log(
      `[verifySupplier] supplier confirmed for document=${id} tenant=${tenantId} at=${verifiedAt.toISOString()}`,
    );

    return { ok: true, verifiedAt: verifiedAt.toISOString() };
  }

  // ─────────────────────────────────────────── extraction confidence ─────

  /**
   * GET /documents/:id/extraction-confidence.
   *
   * Returns one `FieldConfidenceDto` per reviewable field + a top-level
   * summary. The UI renders the summary header ("X/Y alta confiança ·
   * 1 inválido · 1 pendente") and the per-field chips for the table.
   *
   * Source of truth:
   *   - `value`     : the persisted column (or metadata slot for
   *                    address / country / category).
   *   - `confidence`: the per-field `*Confidence` column written by the
   *                    extraction service. `null` means "no provider
   *                    score returned for this field".
   *   - `valid`     : structural validator result. Only NIF + IBAN
   *                    have validators; the other fields return `null`.
   *   - `confirmedAt`: latest `DocumentFieldConfirmation.confirmedAt`
   *                    for the field. `null` until the operator
   *                    confirms.
   *
   * Tenant scoping mirrors every other Document endpoint —
   * `findFirst({ where: { id, tenantId } })` so a cross-tenant id
   * surfaces as 404.
   */
  async getExtractionConfidence(
    tenantId: string,
    id: string,
  ): Promise<ExtractionConfidenceResponseDto> {
    const doc = await this.prisma.document.findFirst({
      where: { id, tenantId },
      select: {
        // Header columns + the new confidence columns.
        supplier: true,
        supplierNif: true,
        iban: true,
        total: true,
        docDate: true,
        dueDate: true,
        ocrConfidence: true,
        supplierNameConfidence: true,
        supplierNifConfidence: true,
        supplierIbanConfidence: true,
        supplierAddressConfidence: true,
        supplierCountryConfidence: true,
        totalAmountConfidence: true,
        issueDateConfidence: true,
        dueDateConfidence: true,
        categoryConfidence: true,
        nifValid: true,
        ibanValid: true,
        supplierVerifiedAt: true,
        metadata: true,
      },
    });
    if (!doc) throw new NotFoundException('Document not found');

    // Pull the AI provenance out of metadata.extraction so the review
    // screen can show "extraído por Gemini · gemini-2.5-flash".
    const extraction = this.getNestedObject(doc.metadata, 'extraction');
    const aiProvider =
      typeof extraction?.aiProvider === 'string' ? extraction.aiProvider : null;
    const aiModel = typeof extraction?.aiModel === 'string' ? extraction.aiModel : null;

    const supplierAddress = this.readMetadataString(doc.metadata, 'supplierAddress');
    const supplierCountry = this.readMetadataString(doc.metadata, 'supplierCountry');
    const filing = this.getNestedObject(doc.metadata, 'filing');
    const category =
      filing && typeof filing.expenseCategory === 'string'
        ? filing.expenseCategory
        : null;

    // Latest confirmation per field — single query, grouped client-side.
    const confirmations = await this.prisma.documentFieldConfirmation.findMany({
      where: { tenantId, documentId: id },
      orderBy: { confirmedAt: 'desc' },
      select: { field: true, confirmedAt: true },
    });
    const lastConfirmedAt = new Map<string, Date>();
    for (const c of confirmations) {
      if (!lastConfirmedAt.has(c.field)) lastConfirmedAt.set(c.field, c.confirmedAt);
    }

    const pick = (
      field: ReviewableField,
      value: unknown,
      confidence: number | null | undefined,
      valid: boolean | null | undefined,
    ): FieldConfidenceDto => {
      const confirmed = lastConfirmedAt.get(field) ?? null;
      return {
        value: value === null || value === undefined ? null : String(value),
        confidence: confidence ?? null,
        valid: valid ?? null,
        confirmedAt: confirmed ? confirmed.toISOString() : null,
      };
    };

    const fields: Record<ReviewableField, FieldConfidenceDto> = {
      supplierName: pick('supplierName', doc.supplier, doc.supplierNameConfidence, null),
      supplierNif: pick('supplierNif', doc.supplierNif, doc.supplierNifConfidence, doc.nifValid),
      supplierIban: pick('supplierIban', doc.iban, doc.supplierIbanConfidence, doc.ibanValid),
      supplierAddress: pick(
        'supplierAddress',
        supplierAddress,
        doc.supplierAddressConfidence,
        null,
      ),
      supplierCountry: pick(
        'supplierCountry',
        supplierCountry,
        doc.supplierCountryConfidence,
        null,
      ),
      totalAmount: pick('totalAmount', doc.total, doc.totalAmountConfidence, null),
      issueDate: pick(
        'issueDate',
        doc.docDate ? doc.docDate.toISOString().slice(0, 10) : null,
        doc.issueDateConfidence,
        null,
      ),
      dueDate: pick(
        'dueDate',
        doc.dueDate ? doc.dueDate.toISOString().slice(0, 10) : null,
        doc.dueDateConfidence,
        null,
      ),
      category: pick('category', category, doc.categoryConfidence, null),
    };

    const summary = summariseConfidence(
      REVIEWABLE_FIELDS.map((f) => ({
        confidence: fields[f].confidence,
        valid: fields[f].valid,
        confirmedAt: fields[f].confirmedAt,
      } satisfies FieldInput)),
    );

    return {
      summary,
      supplierName: fields.supplierName,
      supplierNif: fields.supplierNif,
      supplierIban: fields.supplierIban,
      supplierAddress: fields.supplierAddress,
      supplierCountry: fields.supplierCountry,
      totalAmount: fields.totalAmount,
      issueDate: fields.issueDate,
      dueDate: fields.dueDate,
      category: fields.category,
      aiProvider,
      aiModel,
      ocrConfidence: doc.ocrConfidence ?? null,
      supplierVerifiedAt: doc.supplierVerifiedAt?.toISOString() ?? null,
    };
  }

  /**
   * PATCH /documents/:id/confirm-field.
   *
   * Operator confirms a single field. Two behaviours:
   *   - If `dto.value` is supplied: write the value to the
   *     corresponding Document column (or metadata slot for the fields
   *     that don't have a dedicated column), record the change in
   *     `DocumentFieldConfirmation`, and emit an `AuditAction.EDIT`
   *     row carrying the BEFORE/AFTER diff.
   *   - If `dto.value` is omitted: the operator is acknowledging the
   *     AI's extraction without changing the value. Still records a
   *     confirmation row (so the review screen's "pendente" chip flips
   *     to "confirmado") and emits a lighter audit row tagged
   *     `document.confirm_field_no_change`.
   *
   * Tenant scoping + 404 path mirrors the rest of the surface.
   */
  async confirmField(
    tenantId: string,
    userId: string,
    id: string,
    dto: ConfirmFieldDto,
  ): Promise<{ ok: true; field: ReviewableField; confirmedAt: string }> {
    const existing = await this.prisma.document.findFirst({
      where: { id, tenantId },
      select: {
        id: true,
        supplier: true,
        supplierNif: true,
        iban: true,
        total: true,
        docDate: true,
        dueDate: true,
        nifValid: true,
        ibanValid: true,
        supplierNameConfidence: true,
        supplierNifConfidence: true,
        supplierIbanConfidence: true,
        totalAmountConfidence: true,
        issueDateConfidence: true,
        dueDateConfidence: true,
        metadata: true,
      },
    });
    if (!existing) throw new NotFoundException('Document not found');

    const columnRef = FIELD_COLUMN[dto.field];
    const isMetadataField = columnRef.startsWith('__metadata');

    // Capture the pre-write value for the audit diff. Metadata fields
    // live inside the JSON column — fall through to the metadata
    // reader so we get the actual stored string.
    let previousValue: string | null = null;
    if (dto.field === 'supplierName') previousValue = existing.supplier ?? null;
    else if (dto.field === 'supplierNif') previousValue = existing.supplierNif ?? null;
    else if (dto.field === 'supplierIban') previousValue = existing.iban ?? null;
    else if (dto.field === 'totalAmount') {
      previousValue = existing.total != null ? String(existing.total) : null;
    } else if (dto.field === 'issueDate') {
      previousValue = existing.docDate ? existing.docDate.toISOString().slice(0, 10) : null;
    } else if (dto.field === 'dueDate') {
      previousValue = existing.dueDate ? existing.dueDate.toISOString().slice(0, 10) : null;
    } else if (dto.field === 'category' || dto.field === 'supplierAddress' || dto.field === 'supplierCountry') {
      const metaKey =
        dto.field === 'supplierAddress'
          ? 'supplierAddress'
          : dto.field === 'supplierCountry'
          ? 'supplierCountry'
          : 'filing';
      if (dto.field === 'category') {
        const filing = this.getNestedObject(existing.metadata, 'filing');
        previousValue =
          filing && typeof filing.expenseCategory === 'string' ? filing.expenseCategory : null;
      } else {
        previousValue = this.readMetadataString(existing.metadata, metaKey);
      }
    }

    // Build the column-level update payload (only when the operator
    // supplied a value). Empty-string and null are both valid "clear"
    // semantics — we coerce "" → null so the column stays nullable.
    let nextMetadata: Prisma.InputJsonValue | undefined;
    let updateData: Prisma.DocumentUpdateInput = {};
    let storedValue: string | null = dto.value ?? null;

    if (dto.value !== undefined && !isMetadataField) {
      if (dto.field === 'totalAmount') {
        const decimal = this.parseDecimalOrThrow(dto.value);
        updateData.total = decimal;
        storedValue = decimal.toString();
      } else if (dto.field === 'issueDate') {
        updateData.docDate = new Date(dto.value);
      } else if (dto.field === 'dueDate') {
        updateData.dueDate = new Date(dto.value);
      } else if (dto.field === 'supplierName') {
        updateData.supplier = dto.value === '' ? null : dto.value;
      } else if (dto.field === 'supplierNif') {
        updateData.supplierNif = dto.value === '' ? null : dto.value;
      } else if (dto.field === 'supplierIban') {
        updateData.iban = dto.value === '' ? null : dto.value;
      }
    }

    if (dto.value !== undefined && isMetadataField) {
      const baseMeta =
        existing.metadata && typeof existing.metadata === 'object' && !Array.isArray(existing.metadata)
          ? (existing.metadata as Record<string, unknown>)
          : {};
      const nextMeta: Record<string, unknown> = { ...baseMeta };
      if (dto.field === 'supplierAddress') {
        nextMeta.supplierAddress = dto.value === '' ? null : dto.value;
      } else if (dto.field === 'supplierCountry') {
        nextMeta.supplierCountry = dto.value === '' ? null : dto.value;
      } else if (dto.field === 'category') {
        const filing =
          baseMeta.filing && typeof baseMeta.filing === 'object' && !Array.isArray(baseMeta.filing)
            ? { ...(baseMeta.filing as Record<string, unknown>) }
            : {};
        if (dto.value === '') {
          delete filing.expenseCategory;
        } else {
          filing.expenseCategory = dto.value;
        }
        filing.source = 'user';
        nextMeta.filing = filing;
      }
      nextMetadata = nextMeta as Prisma.InputJsonValue;
      updateData.metadata = nextMetadata;
    }

    // Write the column update (when applicable) + record the
    // confirmation in the same call. Two operations, but Prisma does
    // not expose a portable cross-table tx for an upsert + update
    // without raw SQL, so we serialise them. A failure between the
    // two leaves a stale "value set, no confirmation" row — the next
    // confirm-field call still works (idempotent) and the operator
    // can re-verify.
    if (Object.keys(updateData).length > 0) {
      await this.prisma.document.update({ where: { id }, data: updateData });
    }

    // Recompute nifValid / ibanValid when the corresponding column
    // changed so the chip reflects the new value, not the stale one.
    // Cheap (mod-11 / mod-97 are constant time) and the row is in
    // memory already after the update.
    if (
      (dto.field === 'supplierNif' && dto.value !== undefined) ||
      (dto.field === 'supplierIban' && dto.value !== undefined)
    ) {
      const nifValue =
        dto.field === 'supplierNif'
          ? dto.value
          : (await this.prisma.document.findFirst({
              where: { id, tenantId },
              select: { supplierNif: true },
            }))?.supplierNif ?? null;
      const ibanValue =
        dto.field === 'supplierIban'
          ? dto.value
          : (await this.prisma.document.findFirst({
              where: { id, tenantId },
              select: { iban: true },
            }))?.iban ?? null;
      await this.prisma.document.update({
        where: { id },
        data: {
          nifValid: nifValue ? isValidPortugueseNif(nifValue) : null,
          ibanValid: ibanValue ? isValidIban(ibanValue) : null,
        },
      });
    }

    const confirmedAt = new Date();
    await this.prisma.documentFieldConfirmation.create({
      data: {
        tenantId,
        documentId: id,
        field: dto.field,
        value: storedValue ?? '',
        previousValue,
        confirmedById: userId,
        confirmedAt,
      },
    });

    // Audit row: EDIT for value changes, lighter "no change" row for
    // pure acknowledgements. Carries BEFORE/AFTER diff so the forensic
    // trail survives even if the confirmation row is purged later.
    //
    // `dto.value` is optional — the operator may confirm the AI's
    // read without overriding the value (a "looks good, move on"
    // gesture). Treat undefined as "no change intent" so the audit
    // row gets the no-change subAction; null vs a string is still
    // considered a change because the operator explicitly cleared
    // the column.
    const valueChanged =
      dto.value !== undefined && (dto.value ?? null) !== previousValue;
    await this.audit.log({
      tenantId,
      userId,
      action: AuditAction.EDIT,
      entityType: 'document',
      entityId: id,
      metadata: {
        subAction: valueChanged
          ? 'document.confirm_field'
          : 'document.confirm_field_no_change',
        field: dto.field,
        previousValue,
        newValue: storedValue,
        valueChanged,
        confirmedAt: confirmedAt.toISOString(),
      } as Prisma.InputJsonValue,
    });

    return { ok: true, field: dto.field, confirmedAt: confirmedAt.toISOString() };
  }

  /**
   * POST /documents/:id/confirm-all.
   *
   * Bulk confirm: write `supplierVerifiedAt = now()` and emit a single
   * `AuditAction.CONFIRM` row carrying the list of confirmed fields.
   * The individual field overrides (if any) should have been written
   * ahead of time via `PATCH /confirm-field` — this endpoint just
   * closes the loop and marks the supplier block verified.
   *
   * Idempotent: calling it twice is allowed and emits a second audit
   * row tagged with `previousVerifiedAt` so the trail still reflects
   * the operator's decision timeline.
   */
  async confirmAll(
    tenantId: string,
    userId: string,
    id: string,
    dto: ConfirmAllDto,
  ): Promise<{ ok: true; verifiedAt: string; confirmedFields: ReviewableField[] }> {
    const existing = await this.prisma.document.findFirst({
      where: { id, tenantId },
      select: { id: true, supplierVerifiedAt: true, status: true },
    });
    if (!existing) throw new NotFoundException('Document not found');

    const verifiedAt = new Date();
    // Sprint 1.B — flip status to PENDING_APPROVAL when the
    // confirm-all action lands on a NOVO doc (mirrors verifySupplier
    // so the workflow stays consistent regardless of which
    // confirmation path the operator took).
    const flipStatus =
      existing.status === DocumentStatus.NOVO
        ? DocumentStatus.PENDING_APPROVAL
        : undefined;
    await this.prisma.document.update({
      where: { id },
      data: {
        supplierVerifiedAt: verifiedAt,
        ...(flipStatus ? { status: flipStatus } : {}),
      },
    });

    await this.audit.log({
      tenantId,
      userId,
      action: AuditAction.CONFIRM,
      entityType: 'document',
      entityId: id,
      metadata: {
        subAction: 'document.confirm_all',
        confirmedFields: dto.confirmedFields,
        previousVerifiedAt: existing.supplierVerifiedAt?.toISOString() ?? null,
        verifiedAt: verifiedAt.toISOString(),
      } as Prisma.InputJsonValue,
    });

    return {
      ok: true,
      verifiedAt: verifiedAt.toISOString(),
      confirmedFields: dto.confirmedFields ?? [],
    };
  }

  /**
   * Coerce a decimal string into a Prisma.Decimal. Throws a
   * `BadRequestException` when the input is malformed so the
   * controller returns a clean 400 instead of leaking a Prisma error.
   */
  private parseDecimalOrThrow(input: string): Prisma.Decimal {
    if (typeof input !== 'string' || input.trim() === '') {
      throw new BadRequestException('totalAmount must be a decimal string');
    }
    try {
      return new Prisma.Decimal(input.trim());
    } catch {
      throw new BadRequestException(`totalAmount is not a valid decimal: ${input}`);
    }
  }

  async syncPayableForDocument(tenantId: string, documentId: string): Promise<void> {
    const doc = await this.prisma.document.findFirst({
      where: { id: documentId, tenantId },
      select: {
        id: true,
        tenantId: true,
        partyId: true,
        supplier: true,
        docNumber: true,
        fileName: true,
        total: true,
        netAmount: true,
        dueDate: true,
        paymentDueDate: true,
        paymentStatus: true,
        status: true,
        type: true,
        metadata: true,
        deletedAt: true,
      },
    });
    if (!doc) return;

    if (doc.deletedAt || doc.status === DocumentStatus.REJEITADO || doc.status === DocumentStatus.ARQUIVADO) {
      await this.prisma.payableItem.updateMany({
        where: { tenantId, documentId: doc.id, status: { not: PaymentStatus.PAID } },
        data: { status: PaymentStatus.CANCELLED },
      });
      return;
    }

    const effectiveDueDate = doc.dueDate ?? doc.paymentDueDate;
    const effectiveAmount = doc.total ?? doc.netAmount;
    if (!effectiveDueDate && (!effectiveAmount || Number(effectiveAmount) <= 0)) {
      return;
    }

    const amountNum = effectiveAmount ? Number(effectiveAmount) : 0;
    let payableStatus: PaymentStatus = PaymentStatus.TO_PAY;
    if (doc.paymentStatus === PaymentStatus.PAID) {
      payableStatus = PaymentStatus.PAID;
    } else if (doc.paymentStatus === PaymentStatus.SCHEDULED) {
      payableStatus = PaymentStatus.SCHEDULED;
    } else if (doc.paymentStatus === PaymentStatus.CANCELLED) {
      payableStatus = PaymentStatus.CANCELLED;
    } else if (effectiveDueDate && new Date(effectiveDueDate) < new Date() && payableStatus === PaymentStatus.TO_PAY) {
      payableStatus = PaymentStatus.OVERDUE;
    }

    const description = `${doc.supplier ?? 'Fornecedor'} — ${doc.docNumber ?? doc.fileName}`;
    const metaPaymentMethod = (doc.metadata && typeof doc.metadata === 'object' && (doc.metadata as any).paymentMethod) || null;

    const existing = await this.prisma.payableItem.findFirst({
      where: { tenantId, documentId: doc.id },
    });

    if (existing) {
      await this.prisma.payableItem.update({
        where: { id: existing.id },
        data: {
          partyId: doc.partyId ?? existing.partyId,
          description: description || existing.description,
          amount: new Prisma.Decimal(amountNum > 0 ? amountNum : Number(existing.amount)),
          dueDate: effectiveDueDate ?? existing.dueDate,
          status: existing.status === PaymentStatus.PAID ? PaymentStatus.PAID : payableStatus,
          paymentMethod: metaPaymentMethod ?? existing.paymentMethod,
          approvedAt: doc.status === DocumentStatus.APROVADO ? (existing.approvedAt ?? new Date()) : existing.approvedAt,
        },
      });
    } else {
      await this.prisma.payableItem.create({
        data: {
          tenantId,
          documentId: doc.id,
          partyId: doc.partyId ?? null,
          description,
          amount: new Prisma.Decimal(amountNum > 0 ? amountNum : 0),
          dueDate: effectiveDueDate ?? new Date(),
          status: payableStatus,
          paymentMethod: metaPaymentMethod ?? null,
          approvedAt: doc.status === DocumentStatus.APROVADO ? new Date() : null,
        },
      });
    }

    await this.createPaymentEventIfMissing(tenantId, {
      id: doc.id,
      dueDate: doc.dueDate,
      paymentDueDate: doc.paymentDueDate,
      total: doc.total,
      netAmount: doc.netAmount,
    });
  }

  private async createPaymentEventIfMissing(
    tenantId: string,
    document: {
      id: string; dueDate: Date | null; paymentDueDate: Date | null;
      total: Prisma.Decimal | null; netAmount: Prisma.Decimal | null;
    },
  ) {
    const dueDate = document.dueDate ?? document.paymentDueDate ?? new Date();
    const amount = document.total ?? document.netAmount ?? new Prisma.Decimal(0);
    await this.prisma.paymentEvent.upsert({
      where: { tenantId_documentId: { tenantId, documentId: document.id } },
      create: { tenantId, documentId: document.id, dueDate, amount },
      update: { dueDate, amount },
    });
  }

  /**
   * Sprint E — auto-routing: after a document is APPROVADO, move its bytes
   * from the `_inbox/` staging path to the deterministic party/category
   * folder computed by `buildDocumentPath`. Idempotent: skipping is fine
   * when the document was already moved (no `_inbox/` segment in
   * `fileKey`) or when it has no linked party yet.
   *
   * PDF sibling (`pdfKey`) is moved alongside the original so the
   * previews stay co-located. DB rows + audit log are written AFTER the
   * byte move succeeds — a partial filesystem write is recoverable by
   * re-approving; a partial DB write would orphan the file.
   *
   * TOCTOU hardening (audit §5 MEDIUM-3): the previous flow read
   * `fileKey`, decided to move, then moved bytes, then updated the DB.
   * Two concurrent approves on the same doc could both pass the
   * `includes('/_inbox/')` check and race the byte move — on POSIX
   * `rename` is atomic, on Windows the destination could be silently
   * overwritten with a fresh atime/mtime. We now take a Postgres
   * advisory transaction lock keyed off the document id so the read +
   * update are serialized. The second caller blocks on the lock until
   * the first transaction commits; by then the row's `fileKey` no longer
   * carries `/_inbox/` and the second caller short-circuits at the guard
   * (idempotent skip). The filesystem move itself happens AFTER the
   * transaction releases the lock — the second caller's read sees the
   * post-update `fileKey` and won't attempt a second move.
   */
  private async relocateAfterApprove(
    tenantId: string,
    documentId: string,
    userId: string,
  ): Promise<void> {
    // Derive a stable 63-bit signed bigint from the document id. SHA-256
    // truncated to 8 bytes (bit 63 zeroed to keep it positive — Postgres
    // advisory locks are bigint).
    const lockKey = docLockKey(documentId);

    // Serialise the DB-side read + update for this document. The tx body
    // is short (one read, one update, one audit row) so the lock hold
    // time stays well below 100 ms in the happy path.
    const plan = await this.prisma.$transaction(async (tx) => {
      // `pg_advisory_xact_lock` auto-releases at COMMIT/ROLLBACK — no
      // risk of leaking the lock on exception. Concurrent callers block
      // here until the winner commits, then re-read the fresh row.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockKey})`;

      const doc = await tx.document.findFirst({
        where: { id: documentId, tenantId },
        select: {
          id: true,
          type: true,
          fileKey: true,
          pdfKey: true,
          docDate: true,
          docNumber: true,
          partyId: true,
          party: {
            select: {
              id: true,
              name: true,
              slug: true,
              type: true,
              partyCategory: { select: { slug: true } },
            },
          },
        },
      });

      if (!doc) return null; // approve() already 404s; nothing to relocate.
      if (!doc.party) return null; // No party linked — leave in _inbox/.
      if (!doc.fileKey) return null;
      // Already routed by a concurrent caller — idempotent skip.
      if (!this.isInboxKey(doc.fileKey)) return null;

      const partySlug = doc.party.slug ?? slugify(doc.party.name) ?? 'party';
      const extension = this.extractExtension(doc.fileKey) || 'pdf';
      const docDateSafe = doc.docDate ?? new Date();

      // Formato de ficheiro padronizado: {TIPO}_{FORNECEDOR}_{NUMERO}_{DATA}.pdf
      const standardFileName = generateStandardFileName({
        type: doc.type,
        supplier: doc.party.name,
        docNumber: doc.docNumber,
        docDate: docDateSafe,
        extension,
      });

      // Garantir criação e associação da pasta do fornecedor e subpasta do ano de emissão
      const supplierYearFolder = await this.ensureSupplierYearFolder(
        tenantId,
        doc.party.name,
        docDateSafe,
        tx,
      );

      const newPath = buildDocumentPath({
        partyType: doc.party.type,
        partySlug,
        // Approved supplier invoices have one canonical filing hierarchy:
        // fornecedores/<fornecedor>/<ano>/<nome-canonico>. The category
        // remains document metadata, rather than adding a divergent level
        // below the supplier folder.
        partyCategorySlug: null,
        documentDate: docDateSafe,
        documentNumber: doc.docNumber ?? 'unnumbered',
        fileId: doc.id,
        extension,
        standardFileName,
        yearOnly: true,
      });

      // Destination equals source — defensive no-op (slug already encodes
      // the bucket but `_inbox/` was missing). Don't move, don't audit.
      if (newPath === doc.fileKey) return null;

      await tx.document.update({
        where: { id: documentId },
        data: {
          fileKey: newPath,
          pdfKey: null,
          fileName: standardFileName,
          folderId: supplierYearFolder?.id ?? undefined,
          finalFolder: supplierYearFolder?.pattern ?? `/fornecedores/${partySlug}/${docDateSafe.getUTCFullYear()}`,
        },
      });

      return {
        from: doc.fileKey,
        to: newPath,
        pdfFrom: doc.pdfKey ?? null,
        partyType: doc.party.type,
        partySlug,
        partyCategorySlug: doc.party.partyCategory?.slug ?? null,
      };
    });

    if (!plan) return;

    // The filesystem move happens AFTER the DB transaction so the byte
    // move is the only step outside the lock. We do it here (not inside
    // the tx) because Prisma transactions don't cover filesystem I/O —
    // holding the advisory lock across the bytes move would be wasteful
    // and the row's `fileKey` is already pointing at the new path, so a
    // second concurrent caller reads the post-update value and short-
    // circuits at the `_inbox/` guard above (lock-free fast path).
    await this.storage.move(plan.from, plan.to);

    let newPdfKey: string | null = null;
    if (plan.pdfFrom) {
      newPdfKey = plan.to.replace(/\.[^.]+$/, '.pdf');
      try {
        await this.storage.move(plan.pdfFrom, newPdfKey);
      } catch (err) {
        // PDF sibling failed (rare) — don't roll back the main move; the
        // UI's PDF preview will be missing but the original is intact.
        this.logger.warn(
          `[relocateAfterApprove] pdfKey move failed for doc=${documentId}: ${(err as Error).message}`,
        );
        newPdfKey = null;
      }
    }

    // Persist the final pdfKey AFTER the byte move. We update outside the
    // tx because the value depends on I/O that we don't want to hold the
    // advisory lock across. A concurrent approve that reaches this point
    // would re-read, see `fileKey` already updated, and skip via the
    // guard. The pdfKey update is idempotent (same destination → same
    // value on retries).
    if (newPdfKey !== null) {
      await this.prisma.document.update({
        where: { id: documentId },
        data: { pdfKey: newPdfKey },
      });
    }

    await this.audit.log({
      tenantId,
      userId,
      action: AuditAction.EDIT,
      entityType: 'document',
      entityId: documentId,
      metadata: {
        subAction: 'storage.relocate',
        from: plan.from,
        to: plan.to,
        pdfFrom: plan.pdfFrom,
        pdfTo: newPdfKey,
        partyType: plan.partyType,
        partySlug: plan.partySlug,
        partyCategorySlug: plan.partyCategorySlug,
      } as Prisma.InputJsonValue,
    });
  }

  /**
   * Garante a criação e associação da pasta do fornecedor e subpasta do ano de emissão.
   * Cria e mantém a hierarquia:
   *   1. Pasta Pai: Fornecedor (ex: "EDP Comercial")
   *   2. Subpasta Filho: Ano de emissão (ex: "EDP Comercial - 2026") vinculada via parentId
   */
  async ensureSupplierYearFolder(
    tenantId: string,
    supplierName: string,
    docDate: Date = new Date(),
    txClient?: any,
  ): Promise<{ id: string; name: string; pattern?: string | null } | null> {
    const client = txClient ?? this.prisma;
    try {
      const cleanSupplier = supplierName.trim() || 'Fornecedor';
      const year = String(
        (docDate instanceof Date && !Number.isNaN(docDate.getTime())
          ? docDate
          : new Date()
        ).getUTCFullYear(),
      );

      // 1. Pasta do Fornecedor
      let parentFolder = await client.folder.findFirst({
        where: { tenantId, name: cleanSupplier },
        select: { id: true, name: true, pattern: true },
      });

      if (!parentFolder) {
        try {
          parentFolder = await client.folder.create({
            data: {
              tenantId,
              name: cleanSupplier,
              color: '#3b82f6',
              pattern: `/Fornecedores/${cleanSupplier}`,
            },
            select: { id: true, name: true, pattern: true },
          });
        } catch {
          parentFolder = await client.folder.findFirst({
            where: { tenantId, name: cleanSupplier },
            select: { id: true, name: true, pattern: true },
          });
        }
      }

      if (!parentFolder) return null;

      // 2. Subpasta do Ano de Emissão (nome único por tenant para respeitar @@unique([tenantId, name]))
      const yearFolderName = `${cleanSupplier} - ${year}`;
      let yearFolder = await client.folder.findFirst({
        where: { tenantId, name: yearFolderName },
        select: { id: true, name: true, pattern: true },
      });

      if (!yearFolder) {
        try {
          yearFolder = await client.folder.create({
            data: {
              tenantId,
              name: yearFolderName,
              parentId: parentFolder.id,
              color: '#10b981',
              pattern: `/Fornecedores/${cleanSupplier}/${year}`,
            },
            select: { id: true, name: true, pattern: true },
          });
        } catch {
          yearFolder = await client.folder.findFirst({
            where: { tenantId, name: yearFolderName },
            select: { id: true, name: true, pattern: true },
          });
        }
      }

      return yearFolder ?? parentFolder;
    } catch (err) {
      this.logger.warn(
        `[ensureSupplierYearFolder] failed for supplier=${supplierName}: ${(err as Error).message}`,
      );
      return null;
    }
  }

  /**
   * Deterministic 63-bit positive bigint derived from a SHA-256 of the
   * document id. Used as the key for `pg_advisory_xact_lock` so concurrent
   * approves on the same document serialize on the same lock. The hash
   * is truncated to 8 bytes and bit 63 is cleared (Postgres bigint is
   * signed; an advisory lock key outside the int64 range errors).
   *
   * NOTE: this method now delegates to the centralised helper in
   * `common/locks.ts`. Previously `processing.service.ts` had its own
   * derivation that produced DIFFERENT keys for the same docId — see
   * security-audit finding M-3.
   */

  // ─────────────────────────────────────────── items ─────────────────────

  /**
   * List a document's line items. Real rows from `document_items` are
   * authoritative when present — the extraction worker (or a future
   * manual editor) persists into that table after the user confirms the
   * AI's draft.
   *
   * Today the in-process extraction worker only writes lineItems into
   * `metadata.extraction.lineItems` (a JSON bag). For UI rendering on the
   * detail page we surface THAT payload too — derived into the same shape
   * so the UI never has to know whether the rows were materialised yet.
   *
   * The `source` field on the response tells the caller which side they
   * got. `items` is always present (may be empty). The fallback is
   * deterministic — same input always yields the same output — and never
   * pretends the rows exist in the database.
   */
  async listItems(
    tenantId: string,
    id: string,
  ): Promise<
    Array<{
      id?: string;
      code: string | null;
      description: string;
      quantity: number | string | null;
      unitPrice: number | string | null;
      discount: number | string | null;
      /** Fase 4.2 (P0.3) — percentagem quando o desconto foi classificado como tal. */
      discountPercent?: number | string | null;
      taxRate: number | string | null;
      total: number | string | null;
      source?: 'metadata';
    }>
  > {
    // 404 if the document is not in this tenant (or doesn't exist).
    const doc = await this.prisma.document.findFirst({
      where: { id, tenantId },
      select: { id: true, metadata: true },
    });
    if (!doc) throw new NotFoundException('Document not found');

    // Authoritative path: real DocumentItem rows ordered by createdAt so
    // the UI sees the same order the worker persisted them in.
    const rows = await this.prisma.documentItem.findMany({
      where: { documentId: id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        code: true,
        description: true,
        quantity: true,
        unitPrice: true,
        discount: true,
        discountPercent: true,
        taxRate: true,
        total: true,
      },
    });

    if (rows.length > 0) {
      return rows.map((r) => ({
          id: r.id,
          code: r.code,
          description: r.description,
          quantity: r.quantity != null ? Number(r.quantity) : null,
          unitPrice: r.unitPrice != null ? Number(r.unitPrice) : null,
          discount: r.discount != null ? Number(r.discount) : null,
          discountPercent: r.discountPercent != null ? Number(r.discountPercent) : null,
          taxRate: r.taxRate != null ? Number(r.taxRate) : null,
          total: r.total != null ? Number(r.total) : null,
      }));
    }

    // Fallback path: derive line items from `metadata.extraction.lineItems`
    // — the JSON payload the in-process extraction worker writes when it
    // finishes OCR. Shape on the wire is:
    //   { description, code, quantity, unitPrice, vatRate, discount, lineTotal }
    const meta = doc.metadata as Prisma.JsonValue | null | undefined;
    const extraction = this.getNestedObject(meta, 'extraction');
    const rawItems = extraction?.lineItems;
    if (Array.isArray(rawItems) && rawItems.length > 0) {
      const items = rawItems
        .filter((it): it is Record<string, unknown> => !!it && typeof it === 'object')
        .map((it) => ({
          // No DB id — these rows haven't been materialised yet.
          code: typeof it.code === 'string' ? it.code : null,
          description:
            typeof it.description === 'string' && it.description.length > 0
              ? it.description
              : '(no description)',
          quantity: this.toFiniteNumber(it.quantity),
          unitPrice: this.toFiniteNumber(it.unitPrice),
          discount: this.toFiniteNumber(it.discount),
          taxRate: this.toFiniteNumber((it as { vatRate?: unknown }).vatRate),
          total: this.toFiniteNumber(
            (it as { lineTotal?: unknown; total?: unknown }).lineTotal ??
              (it as { total?: unknown }).total,
          ),
          source: 'metadata' as const,
        }));
      return items;
    }

    return [];
  }

  /** Coerce a JSON value into a finite number, or null. Used by the
   *  listItems fallback so the wire shape stays numeric without throwing
   *  on missing/garbage values from the extraction payload. */
  private toFiniteNumber(v: unknown): number | null {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '') {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  }

  // ─────────────────────────────────────────── helpers ──────────────────

  /**
   * Centralised WHERE-clause builder so findAll / findInbox / future
   * exports share the same filter semantics.
   *
   * Sprint I+ soft-delete: every listing defaults to `deletedAt: null`
   * so trashed rows are hidden from the inbox / search / inbox filter
   * pages. The trash listing (`findInTrash`) intentionally bypasses
   * this helper to apply the symmetric `deletedAt: { not: null }`
   * predicate.
   */
  private buildWhere(tenantId: string, query: DocumentQueryDto): Record<string, unknown> {
    const where: Record<string, unknown> = {
      tenantId,
      // Hide soft-deleted (trash) rows from the inbox / list by default.
      // The dedicated `/documents/trash` endpoint uses `findInTrash()`,
      // not this helper, so its `deletedAt: { not: null }` predicate
      // stays orthogonal.
      deletedAt: null,
      // Hide soft-archived rows (legacy ARQUIVADO state) from default lists.
      status: { not: DocumentStatus.ARQUIVADO },
    };
    if (query.status) where.status = query.status;
    if (query.type) {
      where.type = query.type;
    } else if (query.excludeType) {
      where.type = { not: query.excludeType };
    }
    if (query.fiscalStatus) {
      where.fiscalStatus = query.fiscalStatus;
    } else {
      // P0.2: Exclude client orders / self-invoices (NAO_APLICAVEL) from default purchase views
      where.fiscalStatus = { not: FiscalStatus.NAO_APLICAVEL };
    }
    if (query.partyId) {
      where.OR = [
        { partyId: query.partyId },
        { crmContactId: query.partyId },
      ];
    }
    if (query.dateFrom || query.dateTo) {
      const range: Record<string, Date> = {};
      if (query.dateFrom) range.gte = new Date(query.dateFrom);
      if (query.dateTo) {
        const end = new Date(query.dateTo);
        end.setUTCHours(23, 59, 59, 999);
        range.lte = end;
      }
      where.createdAt = range;
    }
    if (query.search) {
      const search = query.search;
      where.OR = [
        { fileName: { contains: search, mode: 'insensitive' } },
        { supplier: { contains: search, mode: 'insensitive' } },
        { customer: { contains: search, mode: 'insensitive' } },
        { docNumber: { contains: search, mode: 'insensitive' } },
        { supplierNif: { contains: search } },
        { customerNif: { contains: search } },
      ];
    }
    if (query.origin && query.origin.length > 0) {
      where.origin = { in: query.origin };
    }
    return where;
  }

  /**
   * Strip internal storage columns from the response. fileKey/fileHash
   * should never leak — fileKey is the storage backend's internal pointer
   * (potentially a signed S3 URL path) and fileHash is the duplicate check.
   *
   * pdfKey IS exposed: the UI uses it to decide whether a one-click PDF
   * preview is available (image uploads only). The PDF endpoint
   * (`GET /documents/:id/download`) resolves pdfKey into bytes inside
   * the controller, so the client never needs to know the storage key
   * shape.
   *
   * Convert Decimal totals into JS numbers so JSON serialisation stays sane.
   */
  private sanitize(doc: any) {
    if (!doc) return doc;
    const { fileKey: _fileKey, fileHash: _fileHash, ...rest } = doc;
    const meta = doc.metadata && typeof doc.metadata === 'object' && !Array.isArray(doc.metadata) ? doc.metadata : {};
    return {
      ...rest,
      total: rest.total != null ? Number(rest.total) : null,
      taxAmount: rest.taxAmount != null ? Number(rest.taxAmount) : null,
      netAmount: rest.netAmount != null ? Number(rest.netAmount) : null,
      paymentMethod: rest.paymentMethod ?? (meta as any).paymentMethod ?? null,
      // Fase 4.2 (P2) — o frontend espera `debitAccount`/`creditAccount`
      // como o código SNC (string), não o objeto Account inteiro — é o
      // mesmo formato que envia em `PATCH .../accounting`.
      ...(rest.debitAccount !== undefined
        ? { debitAccount: rest.debitAccount?.code ?? null }
        : {}),
      ...(rest.creditAccount !== undefined
        ? { creditAccount: rest.creditAccount?.code ?? null }
        : {}),
    };
  }

  private stripUndefined<T extends object>(obj: T): Partial<T> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (v !== undefined) out[k] = v;
    }
    return out as Partial<T>;
  }

  /**
   * H-06 helper: detect Prisma unique-constraint violations so we can
   * convert them into a clean 409 instead of leaking a 500 to the client.
   * P2002 is the unique violation error code across all Prisma versions.
   */
  private isUniqueViolation(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false;
    const anyErr = err as { code?: string; meta?: { code?: string } };
    return anyErr.code === 'P2002' || anyErr.meta?.code === 'P2002';
  }

  private extractExtension(name: string): string {
    // L1 hardening: reject path-traversal or NUL bytes before extracting.
    if (!name || name.includes('\0') || name.includes('..') || name.includes('/') || name.includes('\\')) {
      return '';
    }
    const idx = name.lastIndexOf('.');
    if (idx < 0 || idx === name.length - 1) return '';
    const ext = name.slice(idx).toLowerCase();
    // Sanitize — only allow letters/digits, max 5 chars.
    if (!/^\.[a-z0-9]{1,5}$/.test(ext)) return '';
    return ext;
  }

  /**
   * Build a human-friendly file name for a Document row once we have
   * extracted the supplier / date / number. Pure function — no DB or
   * filesystem access. Exported only via the class (not as a static)
   * so it shares the sanitiser with the rest of the service.
   *
   * Rules:
   *   - When supplier AND docNumber are both present (we use docDate if
   *     available, else the upload's `now` as a fallback), produce
   *     `<SUPPLIER_NORMALIZED>_<YYYY-MM-DD>_<DOCNUMBER>.<ext>`.
   *   - When supplier or docNumber is missing, fall back to
   *     `doc_<docId><ext>` so the row still has a meaningful slug.
   *   - The extension is derived from `mimeType` when present (more
   *     reliable than the uploaded filename), otherwise from
   *     `currentFileName`. Always lower-case.
   *
   * Sanitisation:
   *   - Non-alphanumeric characters in the supplier/docNumber are
   *     collapsed into a single `-`. Leading/trailing dashes trimmed.
   *   - Whitespace collapsed to single spaces, then to `-`.
   *   - The result is capped at 200 chars for the stem + 6 for the ext
   *     to stay well under common filesystem limits.
   *   - Path-traversal (`..`, `/`, `\`, NUL) is stripped, never embedded.
   */
  buildDocumentFileName(args: {
    docId: string;
    supplier?: string | null;
    docNumber?: string | null;
    docDate?: Date | null | undefined;
    fallbackDate?: Date;
    mimeType?: string | null;
    currentFileName?: string | null;
  }): string {
    let ext = this.deriveExtensionFromMime(args.mimeType)
      || this.extractExtension(args.currentFileName ?? '')
      || '.bin';
    if (!ext.startsWith('.')) ext = `.${ext}`;

    const supplierSlug = this.slugifySegment(args.supplier);
    const docNumberSlug = this.slugifySegment(args.docNumber);
    const dateSlug = this.formatDateSlug(
      args.docDate ?? args.fallbackDate ?? new Date(),
    );

    let stem: string;
    if (supplierSlug && docNumberSlug) {
      // Brief example is fully UPPERCASE: `AMERICO-ALVES_2026-07-31_FT-2026-1751`.
      // Date stays numeric (it isn't text). The extension keeps its
      // original case (`.pdf`, `.jpg`) to mirror how the user already
      // sees file extensions in the OS.
      stem = `${supplierSlug.toUpperCase()}_${dateSlug}_${docNumberSlug.toUpperCase()}`;
    } else {
      // Fallback: missing supplier or docNumber. Keep the docId so
      // every row still has a stable, meaningful filename.
      stem = `doc_${args.docId}`;
    }

    // Trim stem to a safe length so the total filename stays under
    // 250 chars even on weirdly long input.
    if (stem.length > 200) stem = stem.slice(0, 200);
    return `${stem}${ext}`;
  }

  /**
   * Update the document's stored fileName to a human-friendly slug
   * derived from the extracted fields. Idempotent: no-op when the
   * slug already matches the current `fileName`. Also no-op when the
   * supplier/docNumber/docDate combo yields no usable fields (we keep
   * the original upload-time name so the row is never blank).
   *
   * Returns the slug that was applied, or null when the rename was
   * skipped (no-op or no fields available).
   */
  async renameAfterExtraction(
    tenantId: string,
    documentId: string,
    fields: {
      supplier?: string | null;
      docNumber?: string | null;
      docDate?: Date | null;
    },
  ): Promise<string | null> {
    const doc = await this.prisma.document.findFirst({
      where: { id: documentId, tenantId },
      select: {
        id: true,
        fileName: true,
        mimeType: true,
        supplier: true,
        docNumber: true,
        docDate: true,
        pdfKey: true,
      },
    });
    if (!doc) {
      // Caller will have already surfaced this elsewhere; just log here.
      this.logger.warn(
        `[rename] document=${documentId} tenant=${tenantId} not found`,
      );
      return null;
    }

    // Prefer freshly-extracted fields; fall back to the row values so
    // a re-run still produces a deterministic slug.
    const supplier = fields.supplier ?? doc.supplier ?? null;
    const docNumber = fields.docNumber ?? doc.docNumber ?? null;
    const docDate = fields.docDate ?? doc.docDate ?? null;

    if (!supplier || !docNumber) {
      return null;
    }

    const hasPdfDerivative = !!(doc as any).pdfKey || (doc.mimeType && doc.mimeType.startsWith('image/'));
    const slug = this.buildDocumentFileName({
      docId: doc.id,
      supplier,
      docNumber,
      docDate,
      fallbackDate: doc.docDate ?? new Date(),
      mimeType: hasPdfDerivative ? 'application/pdf' : doc.mimeType,
      currentFileName: doc.fileName,
    });

    if (slug === doc.fileName) {
      // Already renamed — idempotent no-op.
      return null;
    }

    try {
      await this.prisma.document.update({
        where: { id: doc.id },
        data: { fileName: slug },
      });
      this.logger.log(
        `[rename] document=${doc.id} tenant=${tenantId} ` +
          `'${doc.fileName}' → '${slug}'`,
      );
      return slug;
    } catch (err) {
      // Don't let a rename failure abort the extraction pipeline —
      // log loud and let the row stay on the upload-time name.
      this.logger.warn(
        `[rename] FAILED for document=${doc.id} tenant=${tenantId}: ` +
          `${(err as Error).message}`,
      );
      return null;
    }
  }

  /**
   * Collapse a free-text segment (supplier name or doc number) into a
   * slug-safe form: A-Z, 0-9, dash; nothing else.
   *
   * Diacritics are folded to ASCII BEFORE the dash collapse, so
   * "Américo Alves" → "AMERICO-ALVES" (matching the brief's example)
   * rather than "AM-RICO-ALVES". We use Unicode NFD decomposition
   * + combining-mark strip so we cover accented Latin characters
   * without pulling in a locale-data dependency.
   */
  private slugifySegment(input?: string | null): string {
    if (!input) return '';
    // Strip NUL bytes and trim; collapse whitespace to single spaces.
    const cleaned = input
      .replace(/\0/g, '')
      .trim()
      .replace(/\s+/g, ' ');
    // Fold diacritics: NFD splits "é" into "e" + combining acute,
    // then we drop combining marks. Result: "e" alone.
    const folded = cleaned.normalize('NFD').replace(/[̀-ͯ]/g, '');
    // Replace anything that's not [A-Za-z0-9] with a single dash.
    const slugged = folded
      .replace(/[^A-Za-z0-9]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '');
    return slugged;
  }

  /** Format a Date as `YYYY-MM-DD` (UTC, deterministic across TZ). */
  private formatDateSlug(d: Date): string {
    if (!(d instanceof Date) || Number.isNaN(d.getTime())) {
      return this.formatDateSlug(new Date());
    }
    const yyyy = String(d.getUTCFullYear());
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  /** Map a MIME type to a normalised extension; '' when we can't tell. */
  private deriveExtensionFromMime(mime?: string | null): string {
    if (!mime) return '';
    const map: Record<string, string> = {
      'application/pdf': '.pdf',
      'image/jpeg': '.jpg',
      'image/jpg': '.jpg',
      'image/png': '.png',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
      'application/msword': '.doc',
    };
    return map[mime.toLowerCase()] ?? '';
  }

  /**
   * True when `fileKey` still sits in the `_inbox/` staging area — i.e. the
   * bytes haven't been routed to a party/category folder yet. Both shapes
   * are accepted so the guard stays correct across the Sprint E migration
   * (new uploads use `_inbox/<tenant>/...`; pre-fix fixtures in older
   * tests used `<tenant>/_inbox/...`).
   */
  private isInboxKey(fileKey: string): boolean {
    return fileKey.startsWith('_inbox/') || fileKey.includes('/_inbox/');
  }

  /**
   * Build the on-disk storage key. Extracted so upload + tests share the
   * shape and the random suffix doesn't drift across paths.
   *
   * Sprint E (fix-up 2026-09-04): every new upload lands in `_inbox/`
   * so that `relocateAfterApprove()` (which keys off `fileKey.includes('/_inbox/')`)
   * can move the bytes into the deterministic party/category folder
   * after the operator approves the row. Without the `_inbox/` prefix the
   * guard fired on every approve and the file was never routed — folder
   * routing was dead in production. See commit message for context.
   *
   * Key shape: `_inbox/<tenantId>/<yyyy>/<mm>/<ts>-<rand>.<ext>`
   *   - `_inbox/` is a single POSIX segment, not absolute; `LocalFilesystemStorage.resolveSafe()`
   *     normalises and joins it under `UPLOADS_DIR` the same way the old
   *     tenant-prefixed path did.
   *   - The `_<tenantId>/<yyyy>/<mm>/` sub-tree under `_inbox/` keeps the
   *     inbox listings manageable per-tenant and per-month at scale.
   */
  private buildStorageKey(tenantId: string, fileName: string, now: Date): string {
    const yyyy = String(now.getUTCFullYear());
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
    const ext = this.extractExtension(fileName);
    return `_inbox/${tenantId}/${yyyy}/${mm}/${Date.now()}-${crypto
      .randomBytes(8)
      .toString('hex')}${ext}`;
  }

  /**
   * Derive the PDF sibling key from an image key by stripping the
   * extension (`.jpg` / `.png` / `.jpeg`) and appending `.pdf`.
   * Examples:
   *   _inbox/<tenant>/2026/08/1234-abcd.jpg → _inbox/<tenant>/2026/08/1234-abcd.pdf
   *   _inbox/<tenant>/2026/08/1234-abcd.png → _inbox/<tenant>/2026/08/1234-abcd.pdf
   * Keeps the random suffix identical so the two files are obviously
   * the same document on disk.
   */
  private buildPdfKeyFromImageKey(imageKey: string): string {
    const lastSlash = imageKey.lastIndexOf('/');
    const dir = lastSlash >= 0 ? imageKey.slice(0, lastSlash + 1) : '';
    const base = lastSlash >= 0 ? imageKey.slice(lastSlash + 1) : imageKey;
    const lastDot = base.lastIndexOf('.');
    const stem = lastDot > 0 ? base.slice(0, lastDot) : base;
    return `${dir}${stem}.pdf`;
  }

  private coerceType(input?: string): DocumentType {
    if (!input) return DocumentType.OUTRO;
    const allowed = Object.values(DocumentType) as string[];
    return (allowed.includes(input) ? input : DocumentType.OUTRO) as DocumentType;
  }

  // ─────────────────────────────────────────── filing metadata ────────
  //
  // The Document schema doesn't carry `expenseCategory` / `vatRateHint` as
  // top-level columns — they live inside `metadata.filing`. The IVA apuramento
  // (future) will read them from there. We add a thin wrapper so the rest of
  // the service can treat `metadata.filing` as a typed bag.

  private readFilingMetadata(metadata: Prisma.JsonValue | null | undefined): {
    expenseCategory?: ExpenseCategory | null;
    source?: 'ai' | 'user' | 'cleared';
    vatDeductibilityHint?: string;
  } {
    const filing = this.getNestedObject(metadata, 'filing');
    if (!filing) return {};
    return {
      expenseCategory: typeof filing.expenseCategory === 'string'
        ? (isExpenseCategory(filing.expenseCategory) ? filing.expenseCategory : null)
        : null,
      source: typeof filing.source === 'string'
        ? (filing.source as 'ai' | 'user' | 'cleared')
        : undefined,
      vatDeductibilityHint:
        typeof filing.vatDeductibilityHint === 'string' ? filing.vatDeductibilityHint : undefined,
    };
  }

  /**
   * Merge `patch` into metadata.filing and return the full new metadata
   * object. Preserves every other top-level key (extraction, supplierReview,
   * …) so this is non-destructive.
   */
  private writeFilingMetadata(
    metadata: Prisma.JsonValue | null | undefined,
    patch: {
      expenseCategory: ExpenseCategory | null;
      source: 'ai' | 'user' | 'cleared';
    },
  ): Prisma.InputJsonValue {
    const base = (metadata && typeof metadata === 'object' && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>)
      : {}) as Record<string, unknown>;
    const existingFiling = (base.filing && typeof base.filing === 'object' && !Array.isArray(base.filing)
      ? (base.filing as Record<string, unknown>)
      : {}) as Record<string, unknown>;

    const nextFiling: Record<string, unknown> = { ...existingFiling };
    if (patch.expenseCategory === null) {
      delete nextFiling.expenseCategory;
      delete nextFiling.vatDeductibilityHint;
    } else {
      nextFiling.expenseCategory = patch.expenseCategory;
      // Fase 4.1 — a categoria já não vem só da lista fixa de despesa:
      // o operador escolhe uma Category real (que pode ser "Mercadorias
      // para revenda", inexistente em EXPENSE_CATEGORIES). Sem esta
      // guarda o lookup devolvia undefined e o PATCH rebentava com 500.
      // A dedutibilidade a sério é calculada por `resolveIvaDeductibility`
      // (natureza + categoria) e gravada em `ivaDeductibilityPct`; esta
      // dica é só o texto legado da metadata.
      const hint = VAT_DEDUCTIBILITY_HINTS[patch.expenseCategory as ExpenseCategory];
      if (hint) nextFiling.vatDeductibilityHint = hint.reason;
      else delete nextFiling.vatDeductibilityHint;
    }
    nextFiling.source = patch.source;

    return {
      ...base,
      filing: nextFiling,
    } as Prisma.InputJsonValue;
  }

  /**
   * Safely walk into a JSON metadata bag. Returns the sub-object or
   * `undefined` when the chain doesn't exist.
   */
  private getNestedObject(
    metadata: Prisma.JsonValue | null | undefined,
    key: string,
  ): Record<string, unknown> | undefined {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined;
    const sub = (metadata as Record<string, unknown>)[key];
    if (!sub || typeof sub !== 'object' || Array.isArray(sub)) return undefined;
    return sub as Record<string, unknown>;
  }

  /**
   * Find (or create) a Folder row matching the rendered path. Only used
   * for category-aware folders — explicit folderId assignments skip this
   * step. We split the path on `/` and walk the parentId chain so the
   * tree stays hierarchical (e.g. `/Despesas/Refeicoes/2026/08/`).
   */
  private async materialiseFolderPath(
    tenantId: string,
    folderPath: string,
  ): Promise<{ id: string } | null> {
    const segments = folderPath
      .split('/')
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && s !== '_');
    if (segments.length === 0) return null;

    // Skip the trailing year/month segments when materialising — the
    // schema's @@unique([tenantId, name]) constraint means the same name
    // (`2026`, `08`) can only exist once per tenant. The year/month are
    // implicit in the Folder's child-of relationship anyway and the UI
    // tree groups by parent, so we don't need a per-year Folder row.
    //
    // Heuristic: drop the last 2 segments when they look like 4-digit
    // year + 2-digit month (the year/month pattern our engine always
    // appends). Everything before that is materialised.
    const materialiseSegments = segments.slice(
      0,
      this.stripYearMonthSuffix(segments) ? -2 : segments.length,
    );
    if (materialiseSegments.length === 0) return null;

    let parentId: string | null = null;
    let folder: { id: string } | null = null;
    for (const segment of materialiseSegments) {
      // findFirst tolerates both `parentId: null` and `parentId: undefined`
      // so we conditionally add the filter. Without `?? undefined`, the
      // wrapper extension would otherwise add an `IS NOT NULL` predicate
      // that excludes the root-level folder rows.
      const where: { tenantId: string; name: string; parentId?: string | null } =
        parentId == null
          ? { tenantId, name: segment }
          : { tenantId, name: segment, parentId };
      let found: { id: string } | null = await this.prisma.folder.findFirst({
        where,
        select: { id: true },
      });
      if (found) {
        folder = found;
      } else {
        try {
          const created: { id: string } = await this.prisma.folder.create({
            data: {
              tenantId,
              name: segment,
              parentId,
              pattern: folderPath,
            },
            select: { id: true },
          });
          folder = created;
        } catch (err) {
          // Race: another request created the same folder between our
          // findFirst and create. Re-read and use the winner. The
          // tenant-scope extension surfaces the underlying Prisma error
          // as a generic PrismaClientKnownRequestError; we detect on
          // the message as well as the code in case the wrapper
          // rewrapped it.
          const anyErr = err as { code?: string; message?: string };
          const isUniqueness =
            this.isUniqueViolation(err) ||
            (typeof anyErr.message === 'string' &&
              anyErr.message.includes('Unique constraint failed on the fields'));
          if (isUniqueness) {
            const winner = await this.prisma.folder.findFirst({
              where,
              select: { id: true },
            });
            if (!winner) throw err; // genuinely a non-uniqueness failure
            folder = winner;
          } else {
            throw err;
          }
        }
      }
      if (!folder) return null; // belt-and-braces — TS can't track the assignment
      parentId = folder.id;
    }
    return folder;
  }

  /**
   * True when the trailing two segments of a folder path look like
   * `YYYY` and `MM` (the engine always appends these for the date).
   * Used by `materialiseFolderPath` to decide whether to skip the
   * year/month segments — see comment there.
   */
  private stripYearMonthSuffix(segments: string[]): boolean {
    if (segments.length < 3) return false;
    const last = segments[segments.length - 1];
    const secondLast = segments[segments.length - 2];
    return /^\d{2}$/.test(last) && /^\d{4}$/.test(secondLast);
  }

  // ──────────────────────────────────────────── line-item CRUD ──────────

  async addItem(
    tenantId: string,
    id: string,
    body: { description: string; quantity?: number; unitPrice?: number; discount?: number; taxRate?: number; code?: string },
  ) {
    const doc = await this.prisma.document.findFirst({ where: { id, tenantId }, select: { id: true } });
    if (!doc) throw new NotFoundException('Document not found');
    const quantity = body.quantity ?? 1;
    const unitPrice = body.unitPrice ?? 0;
    const discount = body.discount ?? 0;
    const taxRate = body.taxRate ?? 23;
    const lineTotal = this.computeLineTotal({ quantity, unitPrice, discount });
    const item = await this.prisma.documentItem.create({
      data: { documentId: id, code: body.code ?? null, description: body.description, quantity, unitPrice, discount, taxRate, total: lineTotal },
    });
    await this.recomputeDocTotals(id);
    return item;
  }

  async updateItem(
    tenantId: string,
    id: string,
    itemId: string,
    body: { description?: string; quantity?: number; unitPrice?: number; discount?: number; taxRate?: number },
  ) {
    const doc = await this.prisma.document.findFirst({ where: { id, tenantId }, select: { id: true } });
    if (!doc) throw new NotFoundException('Document not found');
    const item = await this.prisma.documentItem.findFirst({ where: { id: itemId, documentId: id } });
    if (!item) throw new NotFoundException('Line item not found');
    const quantity = body.quantity ?? Number(item.quantity);
    const unitPrice = body.unitPrice ?? Number(item.unitPrice);
    const discount = body.discount ?? Number(item.discount);
    const taxRate = body.taxRate ?? Number(item.taxRate);
    const lineTotal = this.computeLineTotal({ quantity, unitPrice, discount });
    const updated = await this.prisma.documentItem.update({
      where: { id: itemId },
      data: {
        ...(body.description !== undefined ? { description: body.description } : {}),
        quantity, unitPrice, discount, taxRate, total: lineTotal,
      },
    });
    await this.recomputeDocTotals(id);
    return updated;
  }

  async removeItem(tenantId: string, id: string, itemId: string) {
    const doc = await this.prisma.document.findFirst({ where: { id, tenantId }, select: { id: true } });
    if (!doc) throw new NotFoundException('Document not found');
    const item = await this.prisma.documentItem.findFirst({ where: { id: itemId, documentId: id } });
    if (!item) throw new NotFoundException('Line item not found');
    await this.prisma.documentItem.delete({ where: { id: itemId } });
    await this.recomputeDocTotals(id);
  }

  private computeLineTotal(args: { quantity: number | string; unitPrice: number | string; discount: number | string }): number {
    const q = Number(args.quantity) || 0;
    const p = Number(args.unitPrice) || 0;
    const d = Number(args.discount) || 0;
    const gross = q * p - d;
    return Math.max(0, Math.round(gross * 100) / 100);
  }

  private async recomputeDocTotals(documentId: string): Promise<void> {
    const items = await this.prisma.documentItem.findMany({ where: { documentId } });
    const net = items.reduce((acc, it) => acc + Number(it.total || 0), 0);
    const tax = items.reduce((acc, it) => acc + (Number(it.total || 0) * Number(it.taxRate || 0)) / 100, 0);
    const total = Math.round((net + tax) * 100) / 100;
    await this.prisma.document.update({
      where: { id: documentId },
      data: { netAmount: net, taxAmount: Math.round(tax * 100) / 100, total },
    });
  }

  /**
   * Read a string-typed slot out of a Document.metadata JSON column.
   * Returns `null` when the metadata is missing, not a plain object,
   * or the slot is missing / not a string. Used by the supplier edit
   * path (address / country) — both fields are stored in metadata,
   * not in dedicated schema columns, so the read needs to handle the
   * JSON-shape variance safely.
   */
  private readMetadataString(
    metadata: Prisma.JsonValue | null | undefined,
    key: string,
  ): string | null {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      return null;
    }
    const slot = (metadata as Record<string, unknown>)[key];
    return typeof slot === 'string' ? slot : null;
  }
}
