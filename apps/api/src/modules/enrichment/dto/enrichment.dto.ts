import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';

/**
 * Response from `POST /parties/:id/enrich` and
 * `GET /parties/:id/enrichment`. Tells the UI which provider ran,
 * which fields were filled, and which (if any) errored.
 *
 * `source` is one of:
 *   - 'sabi-pt'    — Sabi PT returned data
 *   - 'vies'       — VIES returned data
 *   - 'manual'     — extra-EU / no provider available; row untouched
 *   - 'cached'     — fresh cache hit (< 30d); no provider called
 *   - 'no_data'    — provider called, no fields returned
 */
export class EnrichmentResponseDto {
  @ApiProperty({ example: 'vies', enum: ['sabi-pt', 'vies', 'nif-lookup', 'invoices', 'manual', 'cached', 'no_data'] })
  source!: 'sabi-pt' | 'vies' | 'nif-lookup' | 'invoices' | 'manual' | 'cached' | 'no_data';

  @ApiProperty({ example: ['email', 'address', 'city'], type: [String] })
  fieldsPopulated!: string[];

  @ApiPropertyOptional({ example: 'rate_limited' })
  error?: string | null;

  @ApiProperty({ example: '2026-09-05T12:34:56.000Z' })
  fetchedAt!: string;
}

/**
 * Path params for `/parties/:id/enrich` and `/parties/:id/enrichment`.
 * `id` is the Party cuid.
 */
export class EnrichmentPathDto {
  @ApiProperty({ description: 'Party cuid' })
  @IsString()
  id!: string;
}

/**
 * Optional body for POST /parties/:id/enrich — caller can force a
 * provider override. When omitted, the service consults VIES / NIF PT
 * e as melhores faturas para deixar a ficha 100% preenchida.
 */
export class EnrichPartyDto {
  @ApiPropertyOptional({
    enum: ['sabi-pt', 'vies', 'nif-lookup', 'invoices', 'manual', 'auto'],
    description:
      'Force a specific provider or auto.',
  })
  @IsOptional()
  @IsIn(['sabi-pt', 'vies', 'nif-lookup', 'invoices', 'manual', 'auto'])
  forceProvider?: 'sabi-pt' | 'vies' | 'nif-lookup' | 'invoices' | 'manual' | 'auto';

  @ApiPropertyOptional({ description: 'Skip the 30-day cache check and force fresh enrichment' })
  @IsOptional()
  skipCache?: boolean;
}
