import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
  registerDecorator,
  ValidationOptions,
} from 'class-validator';
import {
  isValidIban,
  isValidPortugueseNif,
} from '../../../common/validation/tax-id.validator';

/**
 * Custom class-validator decorator — runs `isValidPortugueseNif`
 * (mod-11 checksum from `common/validation/tax-id.validator`).
 *
 * Only triggers on values that already look like a 9-digit NIF or a
 * `PT`-prefixed NIF. Foreign VAT identifiers (e.g. `ES14219836`,
 * `DE123456789`) skip the structural check — the project does not
 * yet implement country-specific non-PT checksums.
 *
 * Null / empty / non-string input is considered VALID so the field
 * remains optional when paired with `@IsOptional()`.
 */
export function IsPortugueseNifChecksum(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return function (object: object, propertyName: string | symbol): void {
    registerDecorator({
      name: 'isPortugueseNifChecksum',
      target: object.constructor,
      propertyName: propertyName as string,
      options: validationOptions,
      validator: {
        validate(value: unknown): boolean {
          if (value === null || value === undefined) return true;
          if (typeof value !== 'string') return false;
          const trimmed = value.trim();
          if (trimmed.length === 0) return true;
          // Foreign VATs — no PT checksum possible.
          if (/^[A-Z]{2}/i.test(trimmed) && !/^PT/i.test(trimmed)) {
            return true;
          }
          return isValidPortugueseNif(trimmed);
        },
        defaultMessage(): string {
          return `${propertyName as string} fails the PT NIF mod-11 checksum`;
        },
      },
    });
  };
}

/**
 * Custom class-validator decorator — runs `isValidIban` (ISO 13616
 * mod-97 from `common/validation/tax-id.validator`).
 *
 * Null / empty / non-string input is VALID so the field stays optional
 * when combined with `@IsOptional()`.
 */
export function IsIbanChecksum(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return function (object: object, propertyName: string | symbol): void {
    registerDecorator({
      name: 'isIbanChecksum',
      target: object.constructor,
      propertyName: propertyName as string,
      options: validationOptions,
      validator: {
        validate(value: unknown): boolean {
          if (value === null || value === undefined) return true;
          if (typeof value !== 'string') return false;
          const trimmed = value.trim();
          if (trimmed.length === 0) return true;
          return isValidIban(trimmed);
        },
        defaultMessage(): string {
          return `${propertyName as string} fails the ISO 13616 mod-97 IBAN checksum`;
        },
      },
    });
  };
}

/**
 * Supplier-fields-only DTO used by `POST /api/v1/documents/:id/supplier/update`
 * (the strict-validation companion to the legacy `correct-supplier`
 * endpoint, which still uses regex-only NIF/IBAN matching).
 *
 * Every field is OPTIONAL — the operator can fix just one field at a
 * time. At least one field should be supplied (controller enforces
 * this with a `BadRequestException`).
 *
 * Fields:
 *   - name        → maps to `Document.supplier`
 *   - nif         → maps to `Document.supplierNif`  (mod-11 PT checksum)
 *   - iban        → maps to `Document.iban`         (mod-97 IBAN)
 *   - address     → NOT in `Document` schema; stored in `metadata.supplierAddress`
 *   - country     → NOT in `Document` schema; stored in `metadata.supplierCountry`
 *
 * NIF + IBAN validation only runs when the field is provided (the
 * inner `if (trimmed.length === 0) return true` in the custom
 * decorators) AND for PT NIFs only — foreign VAT IDs skip the mod-11
 * check, mirroring the helpers in `tax-id.validator.ts`.
 */
export class UpdateSupplierDto {
  @ApiPropertyOptional({
    description: 'Supplier name (overwrites Document.supplier)',
    maxLength: 200,
    example: 'EDENOX',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  @ValidateIf((o: UpdateSupplierDto) => o.name !== undefined)
  name?: string;

  @ApiPropertyOptional({
    description:
      'Supplier NIF (overwrites Document.supplierNif). PT-prefixed values are mod-11 checksum-validated; foreign VAT IDs skip the structural check.',
    maxLength: 20,
    example: 'PT502782160',
  })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  @IsPortugueseNifChecksum()
  nif?: string;

  @ApiPropertyOptional({
    description:
      'Supplier IBAN (overwrites Document.iban). Validated via ISO 13616 mod-97.',
    maxLength: 34,
    example: 'PT50000201231234567890154',
  })
  @IsOptional()
  @IsString()
  @MaxLength(34)
  @IsIbanChecksum()
  iban?: string;

  @ApiPropertyOptional({
    description:
      'Supplier postal address (NOT in Document schema — stored in metadata.supplierAddress).',
    maxLength: 500,
    example: 'Rua das Indústrias 123, 4400-001 Vila Nova de Gaia',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  address?: string;

  @ApiPropertyOptional({
    description:
      'Supplier country code (ISO 3166-1 alpha-2). NOT in Document schema — stored in metadata.supplierCountry.',
    maxLength: 2,
    example: 'PT',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2)
  country?: string;
}

/**
 * Response shape for both `POST /:id/supplier/re-extract` and
 * `POST /:id/supplier/update`. Carries the supplier snapshot + a
 * boolean the UI uses to decide whether to refresh.
 */
export class SupplierResponseDto {
  @ApiPropertyOptional({ description: 'Supplier name' })
  supplierName?: string | null;
  @ApiPropertyOptional({ description: 'Supplier NIF' })
  supplierNif?: string | null;
  @ApiPropertyOptional({ description: 'Supplier IBAN' })
  supplierIban?: string | null;
  @ApiPropertyOptional({ description: 'Supplier postal address (from metadata)' })
  supplierAddress?: string | null;
  @ApiPropertyOptional({ description: 'Supplier country code (from metadata)' })
  supplierCountry?: string | null;
  @ApiPropertyOptional({
    description: 'True when the extraction pipeline re-ran during this call',
  })
  reExtracted?: boolean;
}
