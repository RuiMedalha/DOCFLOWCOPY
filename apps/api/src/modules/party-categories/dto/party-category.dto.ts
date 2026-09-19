import { IsInt, IsOptional, IsString, Length, Matches, Max, Min } from 'class-validator';

/**
 * Create a PartyCategory — Sprint E buckets that segment the master Party
 * list (Estratégico / Operacional / Consultor / Recorrente, plus whatever
 * the tenant adds later). Conceptually distinct from `Category`, which
 * classifies a Document by expense type.
 */
export class CreatePartyCategoryDto {
  @IsString()
  @Length(1, 80)
  name!: string;

  @IsString()
  @Length(1, 80)
  @Matches(/^[a-z0-9-]+$/, { message: 'slug must be lowercase letters/digits/dashes' })
  slug!: string;

  @IsOptional()
  @IsString()
  @Length(1, 16)
  color?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(9999)
  sortOrder?: number;
}

/** PATCH /party-categories/:id — every field optional. */
export class UpdatePartyCategoryDto {
  @IsOptional() @IsString() @Length(1, 80) name?: string;
  @IsOptional() @IsString() @Length(1, 16) color?: string;
  @IsOptional() @IsInt() @Min(0) @Max(9999) sortOrder?: number;
}

/** Query string for GET /party-categories. */
export class PartyCategoryQueryDto {
  @IsOptional() @IsString() @Length(1, 80) search?: string;
}
