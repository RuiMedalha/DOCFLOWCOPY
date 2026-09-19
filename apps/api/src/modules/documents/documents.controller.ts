import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import type { Response } from 'express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { DocumentOrigin } from '@prisma/client';

import { Roles } from '../../common/decorators/roles.decorator';
import { Role } from '../../common/guards/rbac.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { DocumentsService, ALLOWED_MIMES, MAX_UPLOAD_BYTES } from './documents.service';
import {
  AssignFolderDto,
  CorrectSupplierDto,
  DocumentQueryDto,
  UpdateDocumentDto,
  UploadDocumentDto,
} from './dto/document.dto';
import {
  ConfirmAllDto,
  ConfirmFieldDto,
  ExtractionConfidenceResponseDto,
} from './dto/extraction-confidence.dto';

/**
 * DocumentsController — REST surface for the inbox.
 *
 * Routes:
 *   POST   /documents/upload       — multipart upload
 *   GET    /documents              — paginated list (all statuses)
 *   GET    /documents/inbox        — paginated list, status=NOVO shortcut
 *   GET    /documents/trash        — paginated list, soft-deleted rows (trash)
 *   GET    /documents/:id          — detail
 *   PATCH  /documents/:id          — partial metadata update
 *   PATCH  /documents/:id/folder   — explicit folder assignment
 *   GET    /documents/:id/download — bytes stream (authenticated)
 *   GET    /documents/:id/url      — signed URL (or local route)
 *   DELETE /documents/:id          — soft-delete (trash, reversible via /restore)
 *   POST   /documents/:id/restore  — ADMIN-only restore from trash
 *   DELETE /documents/:id/hard     — ADMIN-only destructive delete (removes
 *                                    file + DB row + cascades to items &
 *                                    payment events; audit row emitted)
 *
 * Auth is enforced by the global JwtGuard + TenantGuard (APP_GUARD).
 * Tenant scoping is automatic via the Prisma extension — every Prisma
 * call here goes through `prisma.scoped`.
 */
@ApiTags('documents')
@ApiBearerAuth()
@Controller('documents')
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  // ─────────────────────────────────────────── upload ──────────────────

  @Post('upload')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Upload a document to the inbox',
    description:
      'Accepts PDF/JPG/PNG/DOCX up to 20MB. The SHA-256 of the bytes is computed and used for per-tenant duplicate detection. The folder-rules engine assigns `finalFolder` on creation.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', format: 'binary' },
        origin: {
          type: 'string',
          enum: Object.values(DocumentOrigin),
          default: 'UPLOAD',
        },
        type: { type: 'string', description: 'Pre-classify (optional)' },
      },
      required: ['file'],
    },
  })
  @ApiResponse({ status: 201, description: 'Document stored and indexed' })
  @ApiResponse({ status: 400, description: 'Invalid file (type or size)' })
  @ApiResponse({ status: 409, description: 'Duplicate document detected' })
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: MAX_UPLOAD_BYTES },
      fileFilter: (_req, file, cb) => {
        if (ALLOWED_MIMES.has(file.mimetype)) {
          cb(null, true);
        } else {
          cb(new BadRequestException(`Unsupported file type: ${file.mimetype}`), false);
        }
      },
    }),
  )
  async upload(
    @CurrentUser() user: AuthenticatedUser,
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: UploadDocumentDto,
  ) {
    if (!file) throw new BadRequestException('File is required');
    return this.documents.upload(
      user.tenantId,
      user.id,
      {
        fieldname: file.fieldname,
        originalname: file.originalname,
        encoding: file.encoding,
        mimetype: file.mimetype,
        size: file.size,
        buffer: file.buffer,
      },
      dto.origin,
      dto.type,
    );
  }

  // ─────────────────────────────────────────── listings ────────────────

  @SkipThrottle()
  @Get()
  @ApiOperation({
    summary: 'List documents',
    description:
      'Paginated listing with optional status/type/date/party/search filters. Soft-deleted rows (ARQUIVADO) are excluded by default.',
  })
  @ApiQuery({ name: 'status', required: false, enum: DocumentOrigin })
  findAll(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: DocumentQueryDto,
  ) {
    return this.documents.findAll(user.tenantId, query);
  }

  @SkipThrottle()
  @Get('inbox')
  @ApiOperation({ summary: 'List inbox documents (status=NOVO)' })
  findInbox(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: DocumentQueryDto,
  ) {
    return this.documents.findInbox(user.tenantId, query);
  }

  @SkipThrottle()
  @Get('trash')
  @ApiOperation({
    summary: 'List soft-deleted documents (trash)',
    description:
      'Tenant-scoped listing of documents with `deletedAt` set. ' +
      'Powers the trash view where an ADMIN can restore individual ' +
      'rows via POST /documents/:id/restore. Soft-deleted rows are ' +
      'excluded from `GET /documents` and `GET /documents/inbox`.',
  })
  @ApiQuery({ name: 'page', required: false, example: 1 })
  @ApiQuery({ name: 'pageSize', required: false, example: 20 })
  @ApiResponse({ status: 200, description: 'Paginated soft-deleted documents' })
  findInTrash(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: DocumentQueryDto,
  ) {
    return this.documents.findInTrash(user.tenantId, query);
  }

  @SkipThrottle()
  @Get('folders')
  @ApiOperation({
    summary: 'List folders for the inbox sidebar',
    description:
      'Returns tenant-scoped folders (id, name, color). Empty list if the tenant has not created any folders yet.',
  })
  @ApiResponse({ status: 200, description: 'Folder list (possibly empty)' })
  async listFolders(@CurrentUser() user: AuthenticatedUser) {
    return this.documents.listFolders(user.tenantId);
  }

  @Post('batch/re-extract-all')
  @HttpCode(HttpStatus.ACCEPTED)
  @Roles(Role.ADMIN, Role.OPERADOR)
  @ApiOperation({
    summary: 'Re-run extraction and image enhancement on all active documents for the tenant',
  })
  async reExtractAll(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ queuedCount: number; status: string }> {
    const result = await this.documents.reExtractAll(user.tenantId, user.id);
    return { queuedCount: result.count, status: 'batch re-extraction queued' };
  }

  // ─────────────────────────────────────────── detail ───────────────────

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @Roles(Role.ADMIN, Role.APPROVER)
  @ApiOperation({ summary: 'Approve a document' })
  @ApiResponse({ status: 200, description: 'Document approved' })
  @ApiResponse({ status: 409, description: 'Document cannot be approved in its current status' })
  approve(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.documents.approve(user.tenantId, user.id, id);
  }

  @Post(':id/re-extract')
  @HttpCode(HttpStatus.ACCEPTED)
  @Roles(Role.ADMIN, Role.OPERADOR)
  @ApiOperation({
    summary: 'Re-run the extraction + enrichment pipeline on an existing document',
    description:
      'Resets the document\'s processingStatus to RECEIVED and re-publishes `document.uploaded` so the 4-stage pipeline (RECEIVED → EXTRACTING → ENRICHING → COMPLETED) re-runs end-to-end. The actual extraction work happens asynchronously — clients observe progress via the SSE channel.',
  })
  @ApiResponse({ status: 202, description: 'Re-extraction queued' })
  @ApiResponse({ status: 404, description: 'Document not found' })
  async reExtract(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body?: { model?: string; provider?: string },
  ): Promise<{ documentId: string; status: 're-extraction triggered' }> {
    const doc = await this.documents.reExtract(user.tenantId, user.id, id, body);
    return { documentId: doc.id, status: 're-extraction triggered' };
  }

  @Post(':id/correct-supplier')
  @HttpCode(HttpStatus.OK)
  @Roles(Role.ADMIN, Role.OPERADOR)
  @ApiOperation({
    summary: 'Manually correct the supplier + customer the AI extracted',
    description:
      'Overwrites the Document.supplier / supplierNif / iban / customer / customerNif / partyId fields with the operator-supplied values, writes a forensic audit row tagged `document.correct_supplier`, and re-publishes `document.uploaded` so the enrichment pipeline re-runs against the corrected fields. Use this when the extraction swapped the customer/supplier sides or picked the wrong entity altogether.',
  })
  @ApiBody({ type: CorrectSupplierDto })
  @ApiResponse({ status: 200, description: 'Supplier corrected; pipeline re-triggered' })
  @ApiResponse({ status: 400, description: 'Validation error (NIF / IBAN format)' })
  @ApiResponse({ status: 404, description: 'Document or Party not found in this tenant' })
  async correctSupplier(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: CorrectSupplierDto,
  ): Promise<{ ok: true; supplier: string; partyId: string | null }> {
    return this.documents.correctSupplier(user.tenantId, user.id, id, dto);
  }

  @Patch(':id/verify-supplier')
  @HttpCode(HttpStatus.OK)
  @Roles(Role.ADMIN, Role.OPERADOR)
  @ApiOperation({
    summary: 'Confirm the AI-extracted supplier block as-is (no field edit)',
    description:
      'Writes Document.supplierVerifiedAt = now() and emits an audit row tagged `document.verify_supplier`. Distinct from `correct-supplier` (which overwrites fields) and from `approve` (which is a downstream approval gate). Use this when the operator reviewed the row and decided the AI extraction is correct — the dialog used to force a field edit even when nothing was wrong, which is what this endpoint + UX triad fixes.',
  })
  @ApiResponse({ status: 200, description: 'Supplier block confirmed; verifiedAt returned' })
  @ApiResponse({ status: 404, description: 'Document not found in this tenant' })
  async verifySupplier(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<{ ok: true; verifiedAt: string }> {
    return this.documents.verifySupplier(user.tenantId, user.id, id);
  }

  // ─────────────────────────────────────────── extraction confidence ─────

  /**
   * GET /documents/:id/extraction-confidence — the data backing the
   * review screen. Returns one entry per reviewable field with
   * `{ value, confidence, valid, confirmedAt }` plus a top-level
   * summary. Open to every authenticated member of the tenant — the
   * review screen is part of the inbox flow and not sensitive to
   * APPROVE / ADMIN gating (the verify-supplier/confirm-field
   * mutations are the privileged parts).
   */
  @Get(':id/extraction-confidence')
  @ApiOperation({
    summary: 'Get per-field extraction confidence + summary for the review screen',
    description:
      'Returns one `{ value, confidence, valid, confirmedAt }` entry per reviewable field (supplierName, supplierNif, supplierIban, supplierAddress, supplierCountry, totalAmount, issueDate, dueDate, category) plus a top-level summary the UI renders in the header. Tenant-scoped; cross-tenant ids surface as 404.',
  })
  @ApiResponse({
    status: 200,
    description: 'Per-field confidence payload',
    type: ExtractionConfidenceResponseDto,
  })
  @ApiResponse({ status: 404, description: 'Document not found (or cross-tenant)' })
  getExtractionConfidence(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<ExtractionConfidenceResponseDto> {
    return this.documents.getExtractionConfidence(user.tenantId, id);
  }

  /**
   * PATCH /documents/:id/confirm-field — operator confirms ONE field.
   * Writes the value (when supplied) to the matching column or
   * metadata slot, records the confirmation in
   * `document_field_confirmations`, and emits an AuditAction.EDIT row
   * with the BEFORE/AFTER diff. ADMIN + OPERADOR — same gate as the
   * other supplier-edit routes.
   */
  @Patch(':id/confirm-field')
  @HttpCode(HttpStatus.OK)
  @Roles(Role.ADMIN, Role.OPERADOR)
  @ApiOperation({
    summary: 'Confirm a single extraction field (with optional value override)',
    description:
      "Writes the operator-confirmed value to the corresponding Document column (or `metadata.supplierAddress` / `metadata.supplierCountry` / `metadata.filing.expenseCategory` for the fields that don't have a dedicated column), records the confirmation in `document_field_confirmations`, and emits an AuditAction.EDIT row with the BEFORE/AFTER diff. If `value` is omitted, the operator is acknowledging the AI's extraction without changing anything — still records the confirmation so the review screen's pending chip flips to confirmed.",
  })
  @ApiResponse({ status: 200, description: 'Field confirmed' })
  @ApiResponse({ status: 400, description: 'Invalid field name or malformed value' })
  @ApiResponse({ status: 404, description: 'Document not found (or cross-tenant)' })
  async confirmField(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ConfirmFieldDto,
  ): Promise<{ ok: true; field: string; confirmedAt: string }> {
    return this.documents.confirmField(user.tenantId, user.id, id, dto);
  }

  /**
   * POST /documents/:id/confirm-all — bulk confirm + supplier-verified.
   * Writes `supplierVerifiedAt = now()` and emits a single AuditAction
   * .EDIT row tagged `document.confirm_all`. Idempotent: a second
   * call updates the timestamp and emits a second audit row tagged
   * with `previousVerifiedAt`.
   */
  @Post(':id/confirm-all')
  @HttpCode(HttpStatus.OK)
  @Roles(Role.ADMIN, Role.OPERADOR)
  @ApiOperation({
    summary: 'Bulk-confirm a set of fields + mark supplier block verified',
    description:
      'Sets `supplierVerifiedAt = now()` and emits one AuditAction row tagged `document.confirm_all` carrying the list of fields the operator reviewed. Field-level overrides (if any) should be sent ahead of time via `PATCH /confirm-field` — this endpoint closes the loop. Idempotent: a second call updates `supplierVerifiedAt` and records `previousVerifiedAt` in the audit row.',
  })
  @ApiResponse({ status: 200, description: 'Supplier block verified' })
  @ApiResponse({ status: 404, description: 'Document not found (or cross-tenant)' })
  async confirmAll(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ConfirmAllDto,
  ): Promise<{ ok: true; verifiedAt: string; confirmedFields: string[] }> {
    return this.documents.confirmAll(user.tenantId, user.id, id, dto);
  }

  @Get(':id/items')
  @ApiOperation({ summary: 'List document line items' })
  @ApiResponse({ status: 404, description: 'Document not found' })
  listItems(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.documents.listItems(user.tenantId, id);
  }

  @Post(':id/items')
  @Roles(Role.ADMIN, Role.OPERADOR)
  @ApiOperation({ summary: 'Add a new line item to a document' })
  addItem(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: { description: string; quantity?: number; unitPrice?: number; discount?: number; taxRate?: number; code?: string },
  ) {
    return this.documents.addItem(user.tenantId, id, body);
  }

  @Patch(':id/items/:itemId')
  @Roles(Role.ADMIN, Role.OPERADOR)
  @ApiOperation({ summary: 'Update a line item (qty / price / discount / taxRate) and recompute totals' })
  updateItem(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Body() body: { description?: string; quantity?: number; unitPrice?: number; discount?: number; taxRate?: number },
  ) {
    return this.documents.updateItem(user.tenantId, id, itemId, body);
  }

  @Delete(':id/items/:itemId')
  @Roles(Role.ADMIN, Role.OPERADOR)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a line item' })
  removeItem(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Param('itemId') itemId: string,
  ) {
    return this.documents.removeItem(user.tenantId, id, itemId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get document detail (without file bytes)' })
  @ApiResponse({ status: 404, description: 'Document not found' })
  findOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.documents.findOne(user.tenantId, id);
  }

  // ─────────────────────────────────────────── update ───────────────────

  @Patch(':id')
  @ApiOperation({
    summary: 'Update document metadata',
    description:
      'Partial update. Changing `type` or `supplier` re-runs the folder-rules engine and updates `suggestedFolder` / `finalFolder`.',
  })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateDocumentDto,
  ) {
    return this.documents.update(user.tenantId, user.id, id, dto);
  }

  @Patch(':id/folder')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Assign a document to a folder',
    description:
      'Explicit folder assignment (UI drag-and-drop). Pass `folderId: null` to clear and let the rules engine re-suggest.',
  })
  assignFolder(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: AssignFolderDto,
  ) {
    return this.documents.assignFolder(user.tenantId, user.id, id, dto.folderId ?? null);
  }

  // ── Fase 4.2 (P2) — contabilização ─────────────────────────────────
  // O frontend já chamava estas duas rotas; só não existiam no backend,
  // por isso "Conta débito"/"Conta crédito" nunca tinham nada para
  // escolher nem gravavam nada.
  @Get(':id/accounting-proposal')
  @ApiOperation({
    summary: 'Proposta determinística de lançamento (natureza + regime de IVA)',
    description:
      'Nunca inventa: sem natureza definida ou sem regime de IVA conhecido, devolve listas vazias e o motivo em `reason`.',
  })
  accountingProposal(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.documents.getAccountingProposal(user.tenantId, id);
  }

  @Patch(':id/accounting')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Atribui a conta de débito/crédito ao documento',
    description:
      'Aceita códigos SNC ("312", "2432", ...). Uma Account é criada automaticamente no tenant se ainda não existir. Passar null limpa a atribuição.',
  })
  assignAccounting(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: { debitAccount?: string | null; creditAccount?: string | null },
  ) {
    return this.documents.assignAccounting(user.tenantId, user.id, id, dto);
  }

  // ─────────────────────────────────────────── download ─────────────────

  @Get([':id/download', ':id/download/:fileName', ':id/file/:fileName'])
  @ApiOperation({
    summary: 'Download the document file',
    description:
      'Streams the stored bytes back. For image uploads, `?format=pdf` (the default for images) returns the generated PDF derivative so the UI / browser can preview it natively; `?format=original` returns the original photo bytes. For PDFs and other non-image uploads, both formats return the same stored file.',
  })
  @ApiResponse({ status: 200, description: 'File bytes (binary)' })
  @ApiResponse({ status: 404, description: 'Document or file blob not found' })
  async download(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Param('fileName') routeFileName: string | undefined,
    @Query('format') format: string | undefined,
    @Res({ passthrough: false }) res: Response,
  ): Promise<void> {
    const wantPdf = format !== 'original';
    const { buffer, mimeType, fileName } = await this.documents.getFileBuffer(
      user.tenantId,
      id,
      wantPdf ? 'pdf' : 'original',
    );
    // Belt-and-braces: if any upstream interceptor already wrote to the
    // response, we MUST NOT set headers or call res.end() again. The
    // original bug surfaced here as ERR_HTTP_HEADERS_SENT + a second
    // 500 from the global filter, because TenantInterceptor tried to
    // stamp x-tenant-id after the bytes had already been flushed.
    if (res.headersSent || res.writableEnded) {
      return;
    }
    const finalName = routeFileName || fileName;
    const cleanName = this.sanitizeFilename(finalName);
    const encodedName = encodeURIComponent(finalName);
    res.set({
      'Content-Type': mimeType,
      'Content-Disposition': `inline; filename="${cleanName}"; filename*=UTF-8''${encodedName}`,
      'Content-Length': buffer.length.toString(),
    });
    res.end(buffer);
  }

  @Get(':id/url')
  @ApiOperation({
    summary: 'Get a URL the client can use to fetch the file',
    description:
      'Local driver returns the controller download route. S3/MinIO driver returns a presigned URL with TTL.',
  })
  getFileUrl(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.documents.getFileUrl(user.tenantId, id);
  }

  // ────────────────────────────────────── iban-history ───────────────────

  @Get(':id/iban-history')
  @ApiOperation({
    summary: 'IBAN change history for the supplier party behind this document',
    description:
      'Resolves the document → linked party, then returns the IBAN change rows for that party. Returns an empty list when the document is not yet linked to a party.',
  })
  @ApiResponse({ status: 200, description: 'IbanHistory rows for the resolved party' })
  async ibanHistory(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.documents.listIbanHistoryForDocument(user.tenantId, id);
  }

  // ─────────────────────────────────────────── delete ───────────────────

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Soft-delete a document (move to trash)',
    description:
      'Sets `deletedAt = now()` on the row. The file stays on disk for audit, the audit chain is preserved, and the row reappears if an ADMIN hits POST /documents/:id/restore. Default listings (inbox, search, party detail) hide trashed rows. Returns 200 with the `{ id, deletedAt }` payload so the client can update its cache optimistically.',
  })
  @ApiResponse({ status: 200, description: 'Document moved to trash' })
  @ApiResponse({ status: 404, description: 'Document not found in this tenant' })
  remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.documents.softDelete(user.tenantId, user.id, id);
  }

  @Post(':id/restore')
  @HttpCode(HttpStatus.OK)
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary: 'Restore a soft-deleted document from trash (ADMIN only)',
    description:
      'Clears `deletedAt` so the row is once again visible to `GET /documents` and the inbox. Idempotent: restoring a row that is already live returns 200 with `restored: false` and does NOT emit an additional audit row. Hard-deleted rows (rows physically removed by `DELETE /:id/hard`) cannot be restored.',
  })
  @ApiResponse({ status: 200, description: 'Document restored (or already live)' })
  @ApiResponse({ status: 403, description: 'Caller is not ADMIN' })
  @ApiResponse({ status: 404, description: 'Document not found (or cross-tenant)' })
  restore(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.documents.restore(user.tenantId, user.id, id);
  }

  @Delete(':id/hard')
  @Roles(Role.ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Hard-delete a document (ADMIN only)',
    description:
      'Destructive: removes the file bytes from storage, the DB row, and cascades to DocumentItem + PaymentEvent. An audit row is emitted before the delete so the forensic trail records who pulled the trigger. Returns 204 No Content on success, 404 when the document is missing or cross-tenant, 403 for non-ADMIN callers.',
  })
  @ApiResponse({ status: 204, description: 'Document removed' })
  @ApiResponse({ status: 403, description: 'Caller is not ADMIN' })
  @ApiResponse({ status: 404, description: 'Document not found (or cross-tenant)' })
  async hardRemove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<void> {
    await this.documents.hardDelete(user.tenantId, user.id, id);
  }

  // ─────────────────────────────────────────── helpers ──────────────────

  /**
   * Quote a filename so a Content-Disposition header stays safe against
   * header-splitting / encoding attacks. We keep ASCII letters, digits,
   * dot, dash, underscore — anything else is folded to `_`.
   *
   * L1 hardening: even though the storage layer already rejects
   * path-traversal attempts via `resolveSafe`, we strip `..` and any path
   * separator BEFORE reaching the storage backend as a defence-in-depth
   * measure against edge cases (e.g. NUL bytes, mixed slashes).
   */
  private sanitizeFilename(name: string): string {
    if (typeof name !== 'string' || name.length === 0) return 'file';
    if (name.includes('\0') || name.includes('..')) {
      return 'file';
    }
    return name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 200);
  }
}
