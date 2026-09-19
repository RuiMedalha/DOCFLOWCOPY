import { IsString, IsOptional, IsInt, IsEnum, Min, Max, Length, Matches } from 'class-validator';
import { CategoryNature } from '@prisma/client';

export class CreateCategoryDto {
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

  /** Fase 4.1 — eixo contabilístico da categoria. */
  @IsOptional()
  @IsEnum(CategoryNature)
  nature?: CategoryNature;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  defaultIvaDeductibilityPct?: number;

  @IsOptional()
  @IsString()
  @Length(1, 500)
  notes?: string;
}

export class UpdateCategoryDto {
  @IsOptional() @IsString() @Length(1, 80) name?: string;
  @IsOptional() @IsString() @Length(1, 16) color?: string;
  @IsOptional() @IsEnum(CategoryNature) nature?: CategoryNature;
  @IsOptional() @IsInt() @Min(0) @Max(100) defaultIvaDeductibilityPct?: number;
  @IsOptional() @IsString() @Length(1, 500) notes?: string;
}
