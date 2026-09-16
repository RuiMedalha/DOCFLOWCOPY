import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import {
  DocumentOrigin,
  DocumentStatus,
  DocumentType,
  FiscalStatus,
  CategoryNature,
  PaymentStatus,
} from '@prisma/client';
import { EXPENSE_CATEGORIES } from '../folder-rules/folder-rules.types';

/**
 * Body sent alongside a multipart upload. The file itself travels in the
 * `file` field — multer picks it up; this DTO covers the rest.
 */
export class UploadDocumentDto {
  @ApiPropertyOptional({
    enum: DocumentOrigin,
    default: DocumentOrigin.UPLOAD,
    description: 'Channel the document arrived through',
  })
  @IsOptional()
  @IsEnum(DocumentOrigin)
  origin?: DocumentOrigin = DocumentOrigin.UPLOAD;

  @ApiPropertyOptional({
    enum: DocumentType,
    description: 'Pre-classify the document type (the rules engine can override)',
  })
  @IsOptional()
  @IsEnum(DocumentType)
  type?: DocumentType;
}

/**
 * Body for PATCH /documents/:id. Every field is optional — partial updates.
 * The service is responsible for re-evaluating folder rules when type or
 * supplier change.
 */
export class UpdateDocumentDto {
  @ApiPropertyOptional({ enum: DocumentType })
  @IsOptional()
  @IsEnum(DocumentType)
  type?: DocumentType;

  @ApiPropertyOptional({ enum: DocumentStatus })
  @IsOptional()
  @IsEnum(DocumentStatus)
  status?: DocumentStatus;

  @ApiPropertyOptional({ example: 'RESTAURANTE-CLIPPER_2026-03-01_FS-A2605-3085.pdf', nullable: true })
  @IsOptional()
  @ValidateIf((_, val) => val !== null && val !== undefined && val !== '')
  @IsString()
  @MaxLength(255)
  fileName?: string | null;

  @ApiPropertyOptional({ example: 'EDP Comercial', nullable: true })
  @IsOptional()
  @ValidateIf((_, val) => val !== null && val !== undefined && val !== '')
  @IsString()
  @MaxLength(255)
  supplier?: string | null;

  @ApiPropertyOptional({ example: '500000001', nullable: true })
  @IsOptional()
  @ValidateIf((_, val) => val !== null && val !== undefined && val !== '')
  @IsString()
  @MaxLength(20)
  supplierNif?: string | null;

  @ApiPropertyOptional({ example: 'Cliente Demo SA', nullable: true })
  @IsOptional()
  @ValidateIf((_, val) => val !== null && val !== undefined && val !== '')
  @IsString()
  @MaxLength(255)
  customer?: string | null;

  @ApiPropertyOptional({ example: '501000002', nullable: true })
  @IsOptional()
  @ValidateIf((_, val) => val !== null && val !== undefined && val !== '')
  @IsString()
  @MaxLength(20)
  customerNif?: string | null;

  @ApiPropertyOptional({ example: 'FT 2026/1234', nullable: true })
  @IsOptional()
  @ValidateIf((_, val) => val !== null && val !== undefined && val !== '')
  @IsString()
  @MaxLength(100)
  docNumber?: string | null;

  @ApiPropertyOptional({ example: '2026-08-30', nullable: true })
  @IsOptional()
  @ValidateIf((_, val) => val !== null && val !== undefined && val !== '')
  @IsDateString()
  docDate?: string | null;

  @ApiPropertyOptional({ example: '2026-09-29', nullable: true })
  @IsOptional()
  @ValidateIf((_, val) => val !== null && val !== undefined && val !== '')
  @IsDateString()
  dueDate?: string | null;

  @ApiPropertyOptional({ example: 123.45, nullable: true })
  @IsOptional()
  @ValidateIf((_, val) => val !== null && val !== undefined && val !== '')
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  total?: number | null;

  @ApiPropertyOptional({ example: 28.39, nullable: true })
  @IsOptional()
  @ValidateIf((_, val) => val !== null && val !== undefined && val !== '')
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  taxAmount?: number | null;

  @ApiPropertyOptional({ example: 95.06, nullable: true })
  @IsOptional()
  @ValidateIf((_, val) => val !== null && val !== undefined && val !== '')
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  netAmount?: number | null;

  @ApiPropertyOptional({ example: 'EUR', default: 'EUR', nullable: true })
  @IsOptional()
  @ValidateIf((_, val) => val !== null && val !== undefined && val !== '')
  @IsString()
  @MaxLength(3)
  currency?: string | null;

  @ApiPropertyOptional({ type: [String], example: ['fatura', 'edp'], nullable: true })
  @IsOptional()
  @ValidateIf((_, val) => val !== null && val !== undefined)
  @IsArray()
  @IsString({ each: true })
  tags?: string[] | null;

  @ApiPropertyOptional({
    description:
      'Force folder assignment to a specific Folder.id. Pass null to clear and let the rules engine re-suggest.',
    nullable: true,
    type: String,
  })
  @IsOptional()
  @ValidateIf((_, val) => val !== null && val !== undefined && val !== '')
  @IsString()
  @MaxLength(50)
  folderId?: string | null;

  @ApiPropertyOptional({
    description:
      'Manual expense-category override (PT). One of EXPENSE_CATEGORIES. ' +
      'When set, the folder-rules engine re-files the document under ' +
      '`/Despesas/{Categoria}/{Ano}/{Mes}/` (or /Estrangeiras/... when foreign). ' +
      'Pass an empty string to clear the override and fall back to the AI suggestion.',
    enum: [...EXPENSE_CATEGORIES, ''],
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_, val) => val !== null && val !== undefined && val !== '')
  @IsString()
  @MaxLength(50)
  expenseCategory?: string | null;

  /**
   * Fase 4.1 — classificação. O operador escolhe uma Category real
   * (tabela `categories`), não um nome de uma lista fixa. A natureza vem
   * com a categoria; passar `expenseNature` sozinho permite corrigir só
   * o eixo contabilístico.
   */
  @ApiPropertyOptional({
    description:
      'Category.id da classificação. Define também a natureza e recalcula a '
      + 'dedutibilidade do IVA. String vazia limpa a classificação.',
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_, val) => val !== null && val !== undefined && val !== '')
  @IsString()
  @MaxLength(50)
  expenseCategoryId?: string | null;

  @ApiPropertyOptional({ enum: CategoryNature, nullable: true })
  @IsOptional()
  @ValidateIf((_, val) => val !== null && val !== undefined && val !== '')
  @IsEnum(CategoryNature)
  expenseNature?: CategoryNature | null;

  /**
   * Fase 4.1 (P2.2) — o operador tem de poder marcar um documento como
   * não fiscal. A correção manual fica registada na auditoria e não é
   * revertida por uma re-extração.
   */
  @ApiPropertyOptional({ enum: FiscalStatus, nullable: true })
  @IsOptional()
  @ValidateIf((_, val) => val !== null && val !== undefined && val !== '')
  @IsEnum(FiscalStatus)
  fiscalStatus?: FiscalStatus | null;

  /**
   * Fase 4.1 — desfazer a correção manual.
   *
   * Sem isto, um operador que se enganasse a marcar o tipo ou a validade
   * fiscal ficava preso: a correção manual tem prioridade sobre a IA e
   * nunca mais era recalculada. Com `true`, as marcas são limpas e a
   * próxima re-extração volta a decidir.
   */
  @ApiPropertyOptional({
    description: 'Limpa as correções manuais de tipo/validade fiscal para a re-extração voltar a decidir.',
  })
  @IsOptional()
  @IsBoolean()
  @Type(() => Boolean)
  resetClassificationOverride?: boolean;

  @ApiPropertyOptional({
    description:
      'Link the document to a Party.id (supplier/customer). The folder-rules ' +
      'engine reads the party\'s country + isRecurring flag to decide between ' +
      '/Fornecedores/{Nome}/, /Despesas/{Categoria}/, and /Estrangeiras/...',
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_, val) => val !== null && val !== undefined && val !== '')
  @IsString()
  @MaxLength(50)
  partyId?: string | null;

  @ApiPropertyOptional({ enum: PaymentStatus, description: 'Estado do pagamento da fatura', nullable: true })
  @IsOptional()
  @ValidateIf((_, val) => val !== null && val !== undefined && val !== '')
  @IsEnum(PaymentStatus)
  paymentStatus?: PaymentStatus | null;

  @ApiPropertyOptional({ example: 'transfer', description: 'Método de pagamento (débito direto, transferência, etc.)', nullable: true })
  @IsOptional()
  @ValidateIf((_, val) => val !== null && val !== undefined && val !== '')
  @IsString()
  @MaxLength(50)
  paymentMethod?: string | null;

  @ApiPropertyOptional({ example: '2026-09-30', description: 'Data limite ou data de pagamento', nullable: true })
  @IsOptional()
  @ValidateIf((_, val) => val !== null && val !== undefined && val !== '')
  @IsDateString()
  paymentDueDate?: string | null;
}

/**
 * All-in-one PATCH body exposed publicly. Internal-only fields (fileKey,
 * fileHash, tenantId) cannot be set through this DTO.
 */
export class UpdateDocumentResponseDto extends PartialType(UpdateDocumentDto) {}

/**
 * Query string for GET /documents and GET /documents/inbox.
 * Mirrors the controller surface and stays compatible with class-validator's
 * transform-on-query.
 */
export class DocumentQueryDto {
  @ApiPropertyOptional({ enum: DocumentStatus })
  @IsOptional()
  @IsEnum(DocumentStatus)
  status?: DocumentStatus;

  /**
   * Fase 4.1 — filtro por validade fiscal determinística. O teste real
   * mostrou que a listagem não deixava separar o que já é fiscal do que
   * ainda está por confirmar.
   */
  @ApiPropertyOptional({ enum: FiscalStatus })
  @IsOptional()
  @IsEnum(FiscalStatus)
  fiscalStatus?: FiscalStatus;

  @ApiPropertyOptional({ enum: DocumentType })
  @IsOptional()
  @IsEnum(DocumentType)
  type?: DocumentType;

  @ApiPropertyOptional({ enum: DocumentType, description: 'Exclude a specific DocumentType from the results' })
  @IsOptional()
  @IsEnum(DocumentType)
  excludeType?: DocumentType;

  @ApiPropertyOptional({
    description: 'Filter by party.id (supplier or customer link)',
  })
  @IsOptional()
  @IsString()
  partyId?: string;

  @ApiPropertyOptional({ example: '2026-08-01', description: 'ISO date (inclusive)' })
  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @ApiPropertyOptional({ example: '2026-08-31', description: 'ISO date (inclusive)' })
  @IsOptional()
  @IsDateString()
  dateTo?: string;

  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 20, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number = 20;

  @ApiPropertyOptional({
    description: 'Free-text search over fileName / supplier / customer / docNumber / NIF',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  search?: string;

  @ApiPropertyOptional({
    description: 'Set true on inbox endpoint to skip status filter (already NOVO)',
  })
  @IsOptional()
  inbox?: boolean;

  @ApiPropertyOptional({
    description:
      'Filter by inbound channel. Accepts a single value (?origin=GMAIL), ' +
      'repeated params (?origin=GMAIL&origin=OUTLOOK), or a CSV string ' +
      '(?origin=GMAIL,OUTLOOK). Unknown values are rejected by validation.',
    type: String,
    isArray: true,
    example: ['GMAIL', 'OUTLOOK'],
    enum: DocumentOrigin,
  })
  @IsOptional()
  @Transform(({ value }) => {
    // Express may deliver repeated query params as an array OR a single
    // string. Normalise to an array of trimmed strings so class-validator
    // can iterate it with `each: true`. CSV strings are split here too so
    // a single `?origin=GMAIL,OUTLOOK` is treated the same as two params.
    if (Array.isArray(value)) {
      return value
        .flatMap((v) => (typeof v === 'string' ? v.split(',') : v))
        .map((v) => (typeof v === 'string' ? v.trim() : v))
        .filter((v) => v !== '');
    }
    if (typeof value === 'string') {
      return value
        .split(',')
        .map((v) => v.trim())
        .filter((v) => v !== '');
    }
    return value;
  })
  @IsArray()
  @IsEnum(DocumentOrigin, { each: true })
  origin?: DocumentOrigin[];
}

/**
 * Response wrapper for paginated lists.
 */
export class PaginatedDocumentsDto {
  items: any[];
  meta: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  };
}

/**
 * Request shape for PATCH /documents/:id/folder — used by the drag-and-drop
 * UI to explicitly move a document into a Folder.
 */
export class AssignFolderDto {
  @ApiPropertyOptional({
    description:
      'Folder.id to assign. Pass null to clear (the document then falls back to the rules engine).',
  })
  @IsOptional()
  @IsUUID()
  folderId?: string;
}

/**
 * Request shape for POST /documents/:id/correct-supplier.
 *
 * Used when the AI extracted the wrong supplier (or the OCR picked the
 * customer side as the supplier). The user provides the correct name +
 * NIF + IBAN for the supplier and a customer correction as well, with an
 * optional reason recorded in the audit log. The Document is updated and
 * the processing pipeline is re-triggered via `document.uploaded` so the
 * downstream enrichment (party linking, category routing) re-runs with
 * the corrected fields.
 *
 * NIF regex mirrors the practical PT/EU surface:
 *   - PT prefix is optional (`PT` + 9 digits) or 9 raw digits.
 *   - Foreign NIFs (when extracted from non-PT invoices) are 5–15 chars
 *     uppercase alnum with optional 2-letter country prefix.
 *
 * IBAN regex is permissive: 2 letter country + 2 check digits + 1–30 alnum
 * body. Strict ISO 13616 mod-97 verification is intentionally NOT done
 * here — the goal is to catch obvious typos before persistence, not to
 * reject legitimate IBANs whose check-digit encoding differs by country.
 */
export class CorrectSupplierDto {
  @ApiProperty({ example: 'EDENOX', maxLength: 200 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  supplier!: string;

  @ApiProperty({ example: '502782160', maxLength: 20 })
  @IsString()
  @IsNotEmpty()
  @Matches(/^[A-Z]{0,2}[A-Z0-9]{5,15}$/, {
    message: 'supplierNif must be 5–15 uppercase alnum with optional 2-letter country prefix',
  })
  @MaxLength(20)
  supplierNif!: string;

  @ApiPropertyOptional({ example: 'PT50003300004531296655007' })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Z]{2}\d{2}[A-Z0-9]{1,30}$/, {
    message: 'iban must start with 2-letter country code + 2 check digits + alnum body',
  })
  @MaxLength(34)
  iban?: string;

  @ApiProperty({ example: 'NOV OUSADO LDA', maxLength: 200 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  customer!: string;

  @ApiProperty({ example: '515208566', maxLength: 20 })
  @IsString()
  @IsNotEmpty()
  @Matches(/^[A-Z]{0,2}[A-Z0-9]{5,15}$/, {
    message: 'customerNif must be 5–15 uppercase alnum with optional 2-letter country prefix',
  })
  @MaxLength(20)
  customerNif!: string;

  @ApiPropertyOptional({
    description:
      'Party.id to link the document to (replaces the existing partyId when present). Pass null to leave the existing party link untouched.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  partyId?: string | null;

  @ApiPropertyOptional({
    description: 'Free-text reason recorded in the audit log (e.g. "AI extracted wrong supplier")',
    maxLength: 500,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  // Sprint H+ Part 2 — optional address/country slots that complement the
  // supplier/customer block. Address + country are NOT in the Document
  // schema, so we persist them under `metadata.supplierAddress` /
  // `metadata.supplierCountry` rather than as dedicated columns. Pure
  // metadata snapshots — they do not affect folder routing or party
  // resolution. Marked optional so existing payloads keep working.

  @ApiPropertyOptional({
    description:
      'Supplier postal address (NOT in Document schema — stored in metadata.supplierAddress).',
    maxLength: 500,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  supplierAddress?: string;

  @ApiPropertyOptional({
    description:
      'Supplier country code (ISO 3166-1 alpha-2). NOT in Document schema — stored in metadata.supplierCountry.',
    maxLength: 2,
  })
  @IsOptional()
  @IsString()
  @MaxLength(2)
  supplierCountry?: string;
}