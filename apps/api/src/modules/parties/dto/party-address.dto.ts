import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { PartyAddressType } from '@prisma/client';
import { IsValidCountryCode } from '../../../common/validation/country-code.validator';

/**
 * Body for POST /parties/:partyId/addresses — add a new address.
 *
 * `type` is one of the PartyAddressType enum values. The service layer
 * enforces "at most one isPrimary per (partyId, type)" via a transactional
 * advisory lock — see PartyAddressesService.create / update.
 */
export class CreatePartyAddressDto {
  @ApiProperty({
    enum: PartyAddressType,
    description: 'BILLING (faturação) / CORRESPONDENCE (postal) / OPERATIONAL (sede/armazém) / OTHER',
  })
  @IsEnum(PartyAddressType)
  type: PartyAddressType;

  @ApiProperty({ example: 'Rua dos Clientes, 12' })
  @IsString()
  @MaxLength(255)
  line1: string;

  @ApiPropertyOptional({ example: 'Piso 3, sala 7' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  line2?: string;

  @ApiPropertyOptional({ example: '1050-070' })
  @IsOptional()
  @IsString()
  // Sprint G review §8-A: this regex is intentionally permissive — it
  // accepts any combination of digits / letters / hyphens / spaces up to
  // 20 chars (e.g. `---` or `   ` would technically pass). A
  // country-aware strict regex (PT `^\d{4}-\d{3}$`, ES, FR, ...) would
  // break for cross-border addresses. Keep loose for MVP; tighten when
  // the product wires country-aware validation.
  @Matches(/^[0-9A-Za-z\- ]{3,20}$/, {
    message: 'Código postal inválido',
  })
  postalCode?: string;

  @ApiPropertyOptional({ example: 'Lisboa' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  city?: string;

  @ApiPropertyOptional({
    example: 'PT',
    description:
      'ISO 3166-1 alpha-2 country code (validated against the allow-list — see IsValidCountryCode).',
    default: 'PT',
  })
  @IsOptional()
  @IsString()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  // Sprint G review §13-A fix-up: validate the country against ISO
  // 3166-1 alpha-2. Previously a typo like "XX" would silently pass
  // (only upper-cased + length-capped). The allow-list lives in
  // common/validation/country-code.validator.ts and covers the EU/EFTA
  // + common LATAM/APAC/MEA partners DocFlow deals with.
  @IsValidCountryCode()
  country?: string;

  @ApiPropertyOptional({
    example: true,
    description: 'Marque como primário deste tipo (BILLING/CORRESPONDENCE/...)',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;
}

/** PATCH /parties/:partyId/addresses/:id — every field optional. */
export class UpdatePartyAddressDto extends PartialType(CreatePartyAddressDto) {}
