/**
 * Confidence thresholds — pure functions used by the review screen
 * and unit-tested in isolation.
 *
 * Bands (inclusive lower bound, exclusive upper bound):
 *   - high     :  confidence >= 0.85 → green chip ("alta confiança")
 *   - medium   :  0.50 ≤ confidence < 0.85 → yellow chip ("rever")
 *   - low      :  confidence < 0.50 OR null → red / grey chip
 *
 * `null` confidence is treated as "indeterminate" (NOT low). The UI
 * distinguishes the two states: a `null` chip says "the provider did
 * not return a score"; a `low` chip says "the provider scored this
 * below 50%". Confusing the two would mislead operators into
 * re-extracting rows that simply never had a score.
 *
 * `invalid` is a separate axis driven by the structural validators
 * (NIF mod-11, IBAN mod-97). A field can be `high` confidence AND
 * `invalid` — the AI is confident it read "PT5000020..." but the
 * checksum rejects the last two digits. Both axes must be visible.
 */

export type ConfidenceBand = 'high' | 'medium' | 'low' | 'indeterminate';

/** Inclusive lower bound for the `high` band. */
export const CONFIDENCE_HIGH_THRESHOLD = 0.85;
/** Inclusive lower bound for the `medium` band. */
export const CONFIDENCE_MEDIUM_THRESHOLD = 0.5;

/**
 * Classify a single confidence score.
 *
 * @param confidence 0..1 or null
 * @returns the band the chip should render
 */
export function classifyConfidence(confidence: number | null | undefined): ConfidenceBand {
  if (confidence === null || confidence === undefined || Number.isNaN(confidence)) {
    return 'indeterminate';
  }
  if (confidence >= CONFIDENCE_HIGH_THRESHOLD) return 'high';
  if (confidence >= CONFIDENCE_MEDIUM_THRESHOLD) return 'medium';
  return 'low';
}

export interface ConfidenceSummary {
  totalFields: number;
  highConfidence: number;
  mediumConfidence: number;
  lowConfidence: number;
  /** Fields with a known-invalid structural validator (NIF/IBAN false). */
  invalid: number;
  /** Fields where the operator has not yet confirmed AND confidence is indeterminate or low. */
  pending: number;
}

export interface FieldInput {
  confidence: number | null | undefined;
  valid: boolean | null | undefined;
  confirmedAt: Date | string | null | undefined;
}

/**
 * Roll up the per-field map into the header summary. `pending` is the
 * count of fields that the review screen should call out to the
 * operator — low confidence OR indeterminate OR invalid, never
 * confirmed.
 */
export function summariseConfidence(fields: FieldInput[]): ConfidenceSummary {
  let high = 0;
  let medium = 0;
  let low = 0;
  let invalid = 0;
  let pending = 0;
  for (const f of fields) {
    const band = classifyConfidence(f.confidence);
    if (band === 'high') high += 1;
    else if (band === 'medium') medium += 1;
    else low += 1;

    if (f.valid === false) invalid += 1;

    const confirmed = f.confirmedAt !== null && f.confirmedAt !== undefined;
    if (!confirmed && (band === 'low' || band === 'indeterminate' || f.valid === false)) {
      pending += 1;
    }
  }
  return {
    totalFields: fields.length,
    highConfidence: high,
    mediumConfidence: medium,
    lowConfidence: low,
    invalid,
    pending,
  };
}
