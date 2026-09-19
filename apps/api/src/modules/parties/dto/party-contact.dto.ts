import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

/**
 * Normalise an email-ish field: trim + lowercase + collapse empty strings
 * to undefined. The service layer treats undefined and the explicit string
 * "" as "no email" so the `@@unique([tenantId, partyId, email])` index
 * doesn't reject a 2nd contact that simply has no email.
 *
 * Postgres treats NULL as distinct in unique indexes by default, so we
 * want undefined/null in the DB — never "".
 */
const normalizeEmail = ({ value }: { value: unknown }): string | undefined => {
  if (typeof value !== 'string') return value as undefined;
  const trimmed = value.trim().toLowerCase();
  if (trimmed === '') return undefined;
  return trimmed;
};

/** Body for POST /parties/:partyId/contacts — create a named contact. */
export class CreatePartyContactDto {
  @ApiProperty({ example: 'Maria Santos' })
  @IsString()
  @MaxLength(255)
  name: string;

  @ApiPropertyOptional({ example: 'CFO' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  role?: string;

  @ApiPropertyOptional({ example: 'maria@edp.pt' })
  @IsOptional()
  @Transform(normalizeEmail)
  @IsEmail({}, { message: 'Email inválido' })
  @MaxLength(255)
  email?: string;

  @ApiPropertyOptional({ example: '+351 210 000 001' })
  @IsOptional()
  @IsString()
  // Sprint G review §8-A: this regex is intentionally permissive — it
  // accepts any combination of digits / spaces / `+` / `-` / parentheses
  // (e.g. `++++`, `   `, `---` would technically pass). We keep it loose
  // because phone numbers are copy-pasted from invoices / emails / vCards
  // and a strict PT-only regex would reject valid international formats
  // pasted by users. If a tighter rule is needed, country-aware validation
  // can be added as a follow-up — see docs/decisions/contact-validation.md.
  @Matches(/^[+0-9 ()\-]{4,30}$/, {
    message: 'Telefone deve ter 4-30 caracteres e apenas dígitos/espaços/+/-/()',
  })
  phone?: string;

  @ApiPropertyOptional({ example: 'Contacto principal para faturação' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

/** PATCH /parties/:partyId/contacts/:id — every field optional. */
export class UpdatePartyContactDto extends PartialType(CreatePartyContactDto) {}
