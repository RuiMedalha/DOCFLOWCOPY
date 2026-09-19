import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * Fields the review screen exposes. The list is closed (not arbitrary
 * free-form) because every entry maps to a dedicated column on
 * `Document` and a dedicated validator — opening the surface would
 * require auditing which field names are safe to write.
 *
 * `value` is carried as a string on the wire so callers can post
 * `totalAmount = "123.45"` and the service decides whether to coerce
 * to Decimal / Date / boolean. The schema column type dictates the
 * coercion; unknown field names fail with 400 before the service
 * touches the DB.
 */
export const REVIEWABLE_FIELDS = [
  'supplierName',
  'supplierNif',
  'supplierIban',
  'supplierAddress',
  'supplierCountry',
  'totalAmount',
  'issueDate',
  'dueDate',
  'category',
] as const;

export type ReviewableField = (typeof REVIEWABLE_FIELDS)[number];

/** Coercion rule per field — keeps the DTO type-agnostic. */
export const FIELD_COLUMN: Record<ReviewableField, string> = {
  supplierName: 'supplier',
  supplierNif: 'supplierNif',
  supplierIban: 'iban',
  supplierAddress: '__metadata.supplierAddress',
  supplierCountry: '__metadata.supplierCountry',
  totalAmount: 'total',
  issueDate: 'docDate',
  dueDate: 'dueDate',
  category: '__metadata.filing.expenseCategory',
};

/**
 * Body for `PATCH /documents/:id/confirm-field`. Operator confirms
 * one field at a time. The audit trail captures the BEFORE/AFTER diff
 * — see service `confirmField()`.
 */
export class ConfirmFieldDto {
  @ApiProperty({
    description: 'Field identifier — must be one of REVIEWABLE_FIELDS',
    enum: REVIEWABLE_FIELDS,
    example: 'supplierNif',
  })
  @IsString()
  @IsIn(REVIEWABLE_FIELDS as unknown as string[])
  field!: ReviewableField;

  @ApiPropertyOptional({
    description:
      'New value (string-encoded). For dates use ISO 8601 (YYYY-MM-DD); for amounts use decimal string ("123.45"); for booleans use "true"/"false".',
    example: 'PT502782160',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  value?: string;
}

/**
 * Body for `POST /documents/:id/confirm-all`. Operator confirms a
 * batch of fields in a single transaction — typically the "Confirmar
 * e arquivar" button on the review screen after the operator has
 * eyeballed every green/yellow/red chip. Sets `supplierVerifiedAt`
 * and writes one audit row tagged `document.confirm_all`.
 */
export class ConfirmAllDto {
  @ApiProperty({
    description: 'Field names the operator has reviewed. Empty array is allowed (no-op).',
    type: [String],
    example: ['supplierName', 'supplierNif', 'totalAmount'],
  })
  @IsArray()
  @IsString({ each: true })
  @IsIn(REVIEWABLE_FIELDS as unknown as string[], { each: true })
  confirmedFields!: ReviewableField[];
}

/**
 * Per-field payload returned by `GET /documents/:id/extraction-confidence`.
 * The UI uses the value for the input + the confidence/valid pair for
 * the badge colour. Confidence of `null` renders as "indeterminate"
 * (grey chip) — different from "low confidence" (red chip), because
 * "unknown" and "low" are different states.
 */
export class FieldConfidenceDto {
  @ApiPropertyOptional({
    description: 'Current persisted value (string-encoded).',
    example: 'PT502782160',
  })
  @Type(() => String)
  value?: string | null;

  @ApiPropertyOptional({
    description:
      'AI/vision confidence 0..1. Null when the provider did not return one (regex / fallback path).',
    example: 0.92,
  })
  @Type(() => Number)
  @IsOptional()
  @IsNumber()
  @Min(0)
  confidence?: number | null;

  @ApiPropertyOptional({
    description:
      'Structural-validator verdict — true when mod-11/mod-97 accepted the value, false when rejected, null when no validator runs (e.g. supplierName has no checksum).',
    example: true,
  })
  valid?: boolean | null;

  @ApiPropertyOptional({
    description:
      'When the field was last confirmed by an operator (ISO 8601). Null when never confirmed.',
    example: '2026-09-08T10:42:31.000Z',
  })
  confirmedAt?: string | null;
}

export class ExtractionConfidenceResponseDto {
  @ApiProperty({
    description:
      'Top-of-screen summary the UI uses to render the "8/10 alta confiança · 1 inválido · 1 pendente" header. Computed from the per-field map below.',
    example: {
      totalFields: 9,
      highConfidence: 7,
      mediumConfidence: 1,
      lowConfidence: 0,
      invalid: 1,
      pending: 0,
    },
  })
  summary!: {
    totalFields: number;
    highConfidence: number;
    mediumConfidence: number;
    lowConfidence: number;
    invalid: number;
    pending: number;
  };

  @ApiPropertyOptional({ type: FieldConfidenceDto })
  supplierName?: FieldConfidenceDto;
  @ApiPropertyOptional({ type: FieldConfidenceDto })
  supplierNif?: FieldConfidenceDto;
  @ApiPropertyOptional({ type: FieldConfidenceDto })
  supplierIban?: FieldConfidenceDto;
  @ApiPropertyOptional({ type: FieldConfidenceDto })
  supplierAddress?: FieldConfidenceDto;
  @ApiPropertyOptional({ type: FieldConfidenceDto })
  supplierCountry?: FieldConfidenceDto;
  @ApiPropertyOptional({ type: FieldConfidenceDto })
  totalAmount?: FieldConfidenceDto;
  @ApiPropertyOptional({ type: FieldConfidenceDto })
  issueDate?: FieldConfidenceDto;
  @ApiPropertyOptional({ type: FieldConfidenceDto })
  dueDate?: FieldConfidenceDto;
  @ApiPropertyOptional({ type: FieldConfidenceDto })
  category?: FieldConfidenceDto;

  @ApiPropertyOptional({
    description:
      'AI/vision provenance — surfaced on the review screen so the operator can see *why* confidence is what it is.',
  })
  aiProvider?: string | null;
  @ApiPropertyOptional({ description: 'AI model id (e.g. "gemini-2.5-flash").' })
  aiModel?: string | null;
  @ApiPropertyOptional({ description: 'Top-level extraction confidence (0..1).' })
  ocrConfidence?: number | null;
  @ApiPropertyOptional({
    description: 'When supplierVerifiedAt was set (ISO 8601).',
  })
  supplierVerifiedAt?: string | null;
}
