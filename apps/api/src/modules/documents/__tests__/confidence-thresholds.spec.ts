import {
  CONFIDENCE_HIGH_THRESHOLD,
  CONFIDENCE_MEDIUM_THRESHOLD,
  classifyConfidence,
  summariseConfidence,
} from '../extraction-confidence';

/**
 * Sprint 1.A — pure unit tests for the confidence thresholds.
 *
 * Lives next to its sibling `extraction-confidence.spec.ts` but
 * focuses exclusively on the pure helpers — no Prisma, no NestJS,
 * no service injection. Every band boundary (0.5, 0.85) is covered
 * explicitly so a future tweak to the constants cannot silently
 * change the chip colours the UI renders.
 */

describe('classifyConfidence()', () => {
  describe('high band (>= 0.85)', () => {
    it('returns "high" at exactly the threshold', () => {
      expect(classifyConfidence(CONFIDENCE_HIGH_THRESHOLD)).toBe('high');
    });
    it('returns "high" above the threshold', () => {
      expect(classifyConfidence(0.9)).toBe('high');
      expect(classifyConfidence(1)).toBe('high');
    });
    it('returns "medium" just below the threshold', () => {
      expect(classifyConfidence(0.849999)).toBe('medium');
    });
  });

  describe('medium band (>= 0.5)', () => {
    it('returns "medium" at exactly the medium threshold', () => {
      expect(classifyConfidence(CONFIDENCE_MEDIUM_THRESHOLD)).toBe('medium');
    });
    it('returns "medium" between the two thresholds', () => {
      expect(classifyConfidence(0.5)).toBe('medium');
      expect(classifyConfidence(0.7)).toBe('medium');
      expect(classifyConfidence(0.849)).toBe('medium');
    });
    it('returns "low" just below the medium threshold', () => {
      expect(classifyConfidence(0.49999)).toBe('low');
    });
  });

  describe('low band (< 0.5)', () => {
    it('returns "low" for small values', () => {
      expect(classifyConfidence(0)).toBe('low');
      expect(classifyConfidence(0.1)).toBe('low');
      expect(classifyConfidence(0.49)).toBe('low');
    });
  });

  describe('indeterminate (null / undefined / NaN)', () => {
    it('returns "indeterminate" for null', () => {
      expect(classifyConfidence(null)).toBe('indeterminate');
    });
    it('returns "indeterminate" for undefined', () => {
      expect(classifyConfidence(undefined)).toBe('indeterminate');
    });
    it('returns "indeterminate" for NaN', () => {
      expect(classifyConfidence(Number.NaN)).toBe('indeterminate');
    });
    it('never returns "low" for missing data — UI uses a different chip', () => {
      // Distinguishing "the provider didn't score this" (indeterminate)
      // from "the provider scored low" (low) is the whole point of the
      // null branch. If this test ever fails, the UI is going to
      // mis-render grey rows as red.
      expect(classifyConfidence(null)).not.toBe('low');
      expect(classifyConfidence(undefined)).not.toBe('low');
    });
  });

  describe('numeric edge cases', () => {
    it('handles negative values as low', () => {
      // Out-of-range but should not crash. Negative scores are
      // technically invalid but the classifier must not throw.
      expect(classifyConfidence(-0.1)).toBe('low');
    });
    it('handles > 1.0 as high (gracefully, no throw)', () => {
      expect(classifyConfidence(1.5)).toBe('high');
    });
  });
});

describe('summariseConfidence()', () => {
  it('returns zeroes for an empty field list', () => {
    expect(summariseConfidence([])).toEqual({
      totalFields: 0,
      highConfidence: 0,
      mediumConfidence: 0,
      lowConfidence: 0,
      invalid: 0,
      pending: 0,
    });
  });

  it('tallies each band correctly', () => {
    const out = summariseConfidence([
      { confidence: 0.95, valid: true, confirmedAt: null }, // high
      { confidence: 0.6, valid: true, confirmedAt: null }, // medium
      { confidence: 0.3, valid: true, confirmedAt: null }, // low
      { confidence: null, valid: null, confirmedAt: null }, // indeterminate
    ]);
    expect(out).toEqual({
      totalFields: 4,
      highConfidence: 1,
      mediumConfidence: 1,
      lowConfidence: 2, // low + indeterminate
      invalid: 0,
      pending: 2, // low + indeterminate, both unconfirmed
    });
  });

  it('counts invalid even on high-confidence fields', () => {
    const out = summariseConfidence([
      // AI is confident but the checksum disagrees.
      { confidence: 0.95, valid: false, confirmedAt: null },
    ]);
    expect(out.highConfidence).toBe(1);
    expect(out.invalid).toBe(1);
    // High + invalid is still "pending" until the operator confirms
    // (the AI might have confidently picked the wrong value).
    expect(out.pending).toBe(1);
  });

  it('drops pending once the operator confirms, regardless of band', () => {
    const out = summariseConfidence([
      { confidence: 0.3, valid: true, confirmedAt: '2026-09-08T10:00:00Z' },
      { confidence: null, valid: null, confirmedAt: '2026-09-08T10:00:00Z' },
    ]);
    expect(out.lowConfidence).toBe(2);
    expect(out.pending).toBe(0);
  });

  it('keeps high-confidence invalid rows pending until confirmed', () => {
    const out = summariseConfidence([
      { confidence: 0.95, valid: false, confirmedAt: null },
    ]);
    expect(out.pending).toBe(1);
  });

  it('treats a confirmed invalid row as not pending', () => {
    const out = summariseConfidence([
      { confidence: 0.95, valid: false, confirmedAt: '2026-09-08T10:00:00Z' },
    ]);
    expect(out.invalid).toBe(1);
    expect(out.pending).toBe(0);
  });
});
