import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

/**
 * ISO 3166-1 alpha-2 country-code validator (Sprint G review §13-A fix-up).
 *
 * Background:
 *   The party-address DTO accepts a 2-char `country` field. Previously
 *   it only normalised to upper-case + capped length — a typo like `XX`
 *   would persist and reach the UI as an unknown flag. This validator
 *   rejects codes that aren't in the ISO 3166-1 alpha-2 set.
 *
 * Scope:
 *   - We hard-code the 50 most common country codes rather than pulling
 *     the full ~250-entry ISO list. DocFlow operators work with European
 *     + North-Atlantic counterparties (PT/ES/FR/DE/IT/GB/IE/NL/BE + the
 *     US/CA/BR commonly seen in vendor invoices). The full list can be
 *     swapped in via `ALLOWED_COUNTRY_CODES` later without touching the
 *     DTO or tests.
 *   - Validation runs AFTER the existing `Transform` that uppercases +
 *     trims the input — so callers may post `pt` or ` PT ` and we still
 *     accept it.
 *
 * Failure mode:
 *   - Empty string / null / undefined pass through (the DTO marks the
 *     field optional; `@IsOptional` short-circuits before our check).
 *   - Unknown codes throw a 400 with a PT-BR message naming the allowed
 *     set.
 */
const ALLOWED_COUNTRY_CODES = new Set<string>([
  // EU + EFTA + UK
  'AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI',
  'FR', 'GB', 'GR', 'HR', 'HU', 'IE', 'IT', 'LT', 'LU', 'LV',
  'MT', 'NL', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK',
  // EFTA
  'CH', 'IS', 'LI', 'NO',
  // North America
  'US', 'CA', 'MX',
  // LATAM (common counterparties in PT-speaking market)
  'BR', 'AR', 'CL', 'CO', 'PE', 'UY', 'VE', 'MX',
  // Asia-Pacific (vendor invoices frequently originate here)
  'CN', 'JP', 'KR', 'SG', 'HK', 'TW', 'TH', 'IN', 'MY', 'PH',
  'VN', 'ID', 'AU', 'NZ',
  // Middle East / Africa
  'AE', 'SA', 'IL', 'TR', 'ZA', 'EG', 'MA',
  // Eastern Europe / Balkans
  'AL', 'BA', 'MK', 'RS', 'UA', 'MD', 'BY', 'RU',
]);

@ValidatorConstraint({ name: 'IsValidCountryCode', async: false })
class IsValidCountryCodeConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    // Optional / empty → defer to @IsOptional semantics (don't fail here).
    if (value === undefined || value === null) return true;
    if (typeof value !== 'string') return false;
    const normalised = value.trim().toUpperCase();
    if (normalised === '') return true;
    return ALLOWED_COUNTRY_CODES.has(normalised);
  }

  defaultMessage(args: ValidationArguments): string {
    return `${args.property} deve ser um código ISO 3166-1 alpha-2 válido (ex.: PT, ES, FR). Recebido: ${JSON.stringify(args.value)}`;
  }
}

/**
 * Decorator: applies the ISO 3166-1 alpha-2 validator to a string field.
 *
 * Usage:
 *   @IsValidCountryCode()
 *   country: string;
 *
 * Pair with @IsOptional() when the field is optional, and an
 * upper-casing @Transform to handle `pt` → `PT` from the wire.
 */
export function IsValidCountryCode(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'IsValidCountryCode',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: IsValidCountryCodeConstraint,
    });
  };
}

/** Test-only escape hatch — exposed for unit tests in apps/api. */
export const _ALLOWED_COUNTRY_CODES_INTERNAL = ALLOWED_COUNTRY_CODES;
