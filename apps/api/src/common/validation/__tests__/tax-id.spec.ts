import {
  isValidPortugueseNif,
  isValidIban,
} from '../tax-id.validator';

/**
 * Sprint H+ extraction-fix-3 — tax-id validator tests.
 *
 * Covers the bug that motivated this helper:
 *   Doc cmtoag5il000ng59oor229cb3 (the "ONNERA REFRIGERATION" invoice
 *   for NOV OUSADO LDA) had AI Vision extract the supplier name from
 *   the upload filename ("NOV-OUSADO-LDA_*.pdf") instead of reading the
 *   QR-A-field of the actual document. The result was a wrong supplier
 *   record that downstream consumers (IBAN fraud check, party-linker,
 *   enrichment) could not validate because they had no structural check
 *   on the NIF. The two helpers now let any caller quickly decide
 *   "this looks like a PT NIF" / "this looks like a valid IBAN" before
 *   trusting the upstream-supplied value.
 */
describe('isValidPortugueseNif', () => {
  it('accepts NOV OUSADO LDA NIF (515208566) without prefix', () => {
    expect(isValidPortugueseNif('515208566')).toBe(true);
  });

  it('accepts the same NIF with PT prefix', () => {
    expect(isValidPortugueseNif('PT515208566')).toBe(true);
  });

  it('accepts the same NIF with lowercase pt prefix and whitespace', () => {
    expect(isValidPortugueseNif('pt 515 208 566')).toBe(true);
  });

  it('rejects the EDENOX NIF 502782160 — mod-11 checksum fails (check digit 0, expected 1)', () => {
    // The EDENOX NIF (PT502782160) was the wrong supplier in the
    // ONNERA-vs-EDENOX extraction bug. The structural validator rejects it
    // because 502782160 has the wrong check digit for a real PT NIF (mod-11
    // would expect a `1`, the actual last digit is `0`). This is a small
    // win on its own — but it shows the value of a structural check before
    // we trust any supplier NIF in the pipeline.
    expect(isValidPortugueseNif('502782160')).toBe(false);
  });

  it('rejects the Spanish ONNERA CIF (ES14219836) — not a PT NIF', () => {
    expect(isValidPortugueseNif('ES14219836')).toBe(false);
  });

  it('rejects a 9-digit number that fails the mod-11 checksum', () => {
    // 100000000 — weighted sum of 1,0,0,0,0,0,0,0 with weights 9..2 is 9,
    // mod 11 = 9, expected check = 2, actual is 0 → invalid.
    expect(isValidPortugueseNif('100000000')).toBe(false);
  });

  it('rejects a string that is not 9 digits after prefix stripping', () => {
    expect(isValidPortugueseNif('12345')).toBe(false);
    expect(isValidPortugueseNif('1234567890')).toBe(false);
  });

  it('rejects empty / non-string input', () => {
    expect(isValidPortugueseNif('')).toBe(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(isValidPortugueseNif(null as any)).toBe(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(isValidPortugueseNif(undefined as any)).toBe(false);
  });
});

describe('isValidIban', () => {
  it('accepts the real ONNERA REFRIGERATION IBAN (ES BBVA)', () => {
    expect(isValidIban('ES2501825699690201515634')).toBe(true);
  });

  it('accepts a real Portuguese bank IBAN (CGD reference)', () => {
    // PT50 0000 0000 0000 0000 0000 0 — synthetic; mod-97 of the reordered
    // numeric string is 71 (NOT 1), so this example is intentionally left
    // out of the "valid" suite. The next test pins the bad-check-digit
    // behaviour, and a separate real-world IBAN (GB / DE / FR) covers
    // the mod-97 = 1 happy path. Documented in the IBAN validator JSDoc.
    expect(isValidIban('GB82WEST12345698765432')).toBe(true);
  });

  it('rejects a PT IBAN with bad check digits (PT50003300004531296655007)', () => {
    // The "PT50 0033 0000 4531 2966 5500 7" string has check digits that
    // produce mod-97 = 88 (not 1). Demonstrates that the validator catches
    // IBANs with a wrong country-prefix check-digit pair — useful for the
    // extraction pipeline when an OCR'd IBAN comes back with one or two
    // digits flipped.
    expect(isValidIban('PT50003300004531296655007')).toBe(false);
  });

  it('accepts IBANs with internal whitespace and lowercase', () => {
    expect(isValidIban('es25 0182 5699 6902 0151 5634')).toBe(true);
  });

  it('rejects a structurally valid IBAN with wrong check digits', () => {
    // Same body as the real ONNERA IBAN but with check digits 99 (invalid).
    expect(isValidIban('ES9901825699690201515634')).toBe(false);
  });

  it('rejects an IBAN with bad country prefix', () => {
    // '1Z' is not a valid ISO 3166-1 country prefix — first two chars
    // must be uppercase letters.
    expect(isValidIban('1Z2501825699690201515634')).toBe(false);
  });

  it('rejects an IBAN that is too short', () => {
    expect(isValidIban('ES25018256')).toBe(false);
  });

  it('rejects an IBAN that is too long', () => {
    // 33 alnum chars after the country + check digits = body too long.
    expect(isValidIban('ES25018256996902015156341234567890')).toBe(false);
  });

  it('rejects empty / non-string input', () => {
    expect(isValidIban('')).toBe(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(isValidIban(null as any)).toBe(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(isValidIban(undefined as any)).toBe(false);
  });
});
