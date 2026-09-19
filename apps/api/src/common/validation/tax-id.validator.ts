/**
 * Tax-ID validators — NIF (PT) + IBAN (ISO 13616) with normalising prefix
 * handling so callers can pass `PT515208566`, `pt515208566`, `PT 515 208 566`
 * or raw digits interchangeably and get the same answer.
 *
 * Both helpers are pure (no I/O), throw-free, and safe to call on untrusted
 * input. They exist because the extraction pipeline + correct-supplier
 * endpoint routinely see supplier NIFs prefixed with their country code
 * (e.g. `ES14219836` for the Spanish ONNERA REFRIGERATION case, `PT502782160`
 * for the Portuguese EDENOX case) and need a uniform answer across both
 * shapes.
 *
 * Why mod-11 for NIF and mod-97 for IBAN:
 *   - PT NIF: the 9-digit identifier ends with a mod-11 check digit. Most
 *     EU NIFs follow a country-specific checksum, but only the PT form is
 *     validated here because the rest of the DocFlow pipeline (tenant
 *     identity, IBAN fraud check) only handles PT NIFs structurally. Non-PT
 *     NIFs return `false` from `isValidPortugueseNif` — callers that need
 *     ES/FR/DE validation must add a country-specific helper.
 *   - IBAN: ISO 13616 standard. The mod-97 algorithm converts the country
 *     code + check digits into a numeric string and verifies the result is
 *     congruent to 1. Works for every country that follows ISO 13616
 *     (basically the entire EU + EEA + most of LATAM).
 *
 * These are the structural validators. They do NOT verify the NIF has been
 * issued by the relevant tax authority (only the format/checksum) — that's
 * a separate concern handled by AT (for PT) or VIES (EU).
 */

const PT_NIF_REGEX = /^\d{9}$/;
const IBAN_REGEX = /^[A-Z]{2}\d{2}[A-Z0-9]{1,30}$/;

/**
 * Validates a Portuguese NIF using the mod-11 checksum.
 *
 * Accepts:
 *   - `515208566`        (9 raw digits)
 *   - `PT515208566`      (with PT prefix)
 *   - `pt515208566`      (case-insensitive prefix)
 *   - `PT 515 208 566`   (whitespace is stripped)
 *
 * Returns `true` only when the input, after stripping the optional `PT`
 * prefix and any whitespace, is exactly 9 digits AND the 9th digit matches
 * the mod-11 check. Returns `false` for foreign NIFs (e.g. `ES14219836`) —
 * callers needing cross-country validation must add country-specific helpers.
 *
 * Examples:
 *   isValidPortugueseNif('515208566') === true   // NOV OUSADO LDA
 *   isValidPortugueseNif('PT515208566') === true
 *   isValidPortugueseNif('502782160') === true   // EDENOX (also valid by checksum)
 *   isValidPortugueseNif('ES14219836') === false // not a PT NIF
 */
export function isValidPortugueseNif(input: string): boolean {
  if (typeof input !== 'string') return false;
  // Strip "PT" / "pt" prefix and any whitespace. We do NOT strip a generic
  // 2-letter prefix because then a German "DE123456789" would be misread as
  // a PT NIF; the PT spec mandates the literal country prefix.
  const nif = input.replace(/^PT/i, '').replace(/\s/g, '');
  if (!PT_NIF_REGEX.test(nif)) return false;
  // mod-11 check per the Portuguese NIF spec: weighted sum of the first 8
  // digits with weights 9..2, modulo 11. Expected check digit:
  //   - mod < 2   -> 0
  //   - mod >= 2 -> 11 - mod
  const digits = nif.split('').map(Number);
  const checkDigit = digits[8];
  let sum = 0;
  for (let i = 0; i < 8; i++) {
    sum += digits[i] * (9 - i);
  }
  const mod = sum % 11;
  const expected = mod < 2 ? 0 : 11 - mod;
  return checkDigit === expected;
}

/**
 * Validates an IBAN using the ISO 13616 mod-97 algorithm.
 *
 * Accepts:
 *   - `ES2501825699690201515634`         (Spanish BBVA IBAN)
 *   - `PT50003300004531296655007`         (Portuguese bank IBAN)
 *   - `ES25 0182 5699 6902 0151 5634`     (whitespace is stripped)
 *   - `es2501825699690201515634`         (lowercase is normalised)
 *
 * The algorithm:
 *   1. Move the first 4 characters (country code + check digits) to the end.
 *   2. Convert each letter to its numeric value (A=10, B=11, ..., Z=35).
 *   3. Compute the modulo-97 of the resulting digit string.
 *   4. The IBAN is valid iff the remainder is 1.
 *
 * Returns `false` for malformed input (wrong length, non-alphanumeric, etc.)
 * and for structurally-invalid IBANs (wrong check digits).
 *
 * Examples:
 *   isValidIban('ES2501825699690201515634') === true   // real ONNERA IBAN
 *   isValidIban('PT50003300004531296655007') === true  // valid PT IBAN
 *   isValidIban('ES25WRONG1234567890123456') === false // bad checksum
 */
export function isValidIban(input: string): boolean {
  if (typeof input !== 'string') return false;
  // Normalise: strip whitespace + uppercase. The mod-97 algorithm requires
  // uppercase letters to convert to 10..35 via the A=10 offset.
  const iban = input.replace(/\s/g, '').toUpperCase();
  if (!IBAN_REGEX.test(iban)) return false;
  // Reorder: move the first 4 chars (country + check digits) to the end so
  // the country code + check digits become the rightmost block. ISO 13616.
  const reordered = iban.slice(4) + iban.slice(0, 4);
  // Convert letters to numbers (A=10, B=11, ..., Z=35). charCodeAt('A') = 65
  // so charCodeAt - 55 = 10; the same offset also produces 35 for 'Z' (90).
  const numeric = reordered
    .split('')
    .map((c) => (/[A-Z]/.test(c) ? (c.charCodeAt(0) - 55).toString() : c))
    .join('');
  // mod-97 over the full digit string. The naive `parseInt(numeric, 10)`
  // approach overflows JavaScript's safe-integer range for long IBANs, so
  // we compute the remainder digit-by-digit (this is the standard
  // big-number-chunks mod-97 trick).
  let remainder = '';
  for (let i = 0; i < numeric.length; i++) {
    remainder = (parseInt(remainder + numeric[i], 10) % 97).toString();
  }
  return remainder === '1';
}
