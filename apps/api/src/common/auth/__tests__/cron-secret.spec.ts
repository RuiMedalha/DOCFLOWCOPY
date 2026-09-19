import { assertCronSecret } from '../cron-secret';

describe('assertCronSecret', () => {
  const expected = 'super-secret-cron-token-32-bytes-min';

  it('returns true when provided matches expected exactly', () => {
    expect(assertCronSecret(expected, expected)).toBe(true);
  });

  it('returns false when provided differs by one character', () => {
    const wrong = expected.slice(0, -1) + 'X';
    expect(assertCronSecret(wrong, expected)).toBe(false);
  });

  it('returns false when provided has a different length (no throw)', () => {
    expect(() => assertCronSecret('short', expected)).not.toThrow();
    expect(assertCronSecret('short', expected)).toBe(false);
  });

  it('returns false when provided is undefined', () => {
    expect(assertCronSecret(undefined, expected)).toBe(false);
    expect(assertCronSecret(null as unknown as undefined, expected)).toBe(false);
  });

  it('returns false when expected is undefined (mis-configured server)', () => {
    expect(assertCronSecret(expected, undefined)).toBe(false);
    expect(assertCronSecret(expected, '')).toBe(false);
  });

  it('returns false when both are empty', () => {
    expect(assertCronSecret('', '')).toBe(false);
  });

  it('treats provided as empty when it is not a string', () => {
    expect(assertCronSecret(123 as unknown as string, expected)).toBe(false);
    expect(assertCronSecret({} as unknown as string, expected)).toBe(false);
  });
});
