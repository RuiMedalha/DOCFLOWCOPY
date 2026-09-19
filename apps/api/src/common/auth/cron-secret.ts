/**
 * Constant-time comparison helper for the cron endpoint.
 *
 * The previous implementation used `secret !== envSecret` in
 * `inbound.controller.ts` (syncAll). JavaScript's `!==` short-circuits
 * on the first mismatching byte — a side-channel that, in theory, lets
 * a sophisticated attacker recover the secret byte-by-byte by watching
 * the response time distribution. The codebase already uses
 * `crypto.timingSafeEqual` for HMAC verifies (inbound.service.ts) — we
 * reuse the same primitive here for the CRON_SECRET header check.
 *
 * The Node `timingSafeEqual` contract requires equal-length buffers;
 * supplying differently-sized buffers throws synchronously. We guard
 * the length check explicitly so a wrong-length caller gets `false`
 * (no leak of the expected length via the throw-time).
 *
 * Both inputs are coerced to UTF-8 Buffer. Non-string inputs are
 * treated as "no match" rather than throwing — the controller is the
 * only caller and it always passes `string | undefined`.
 */
import { Buffer } from 'node:buffer';
import { timingSafeEqual } from 'node:crypto';

/**
 * Returns true when `provided` matches `expected` under constant-time
 * comparison. Returns false on undefined/empty/length-mismatch inputs
 * without throwing.
 *
 * @param provided  value received from the request header
 * @param expected   value loaded from the environment (CRON_SECRET)
 */
export function assertCronSecret(
  provided: string | undefined | null,
  expected: string | undefined | null,
): boolean {
  // Both sides must be defined and non-empty — fail fast.
  if (typeof provided !== 'string' || provided.length === 0) return false;
  if (typeof expected !== 'string' || expected.length === 0) return false;

  // Equal-length buffer contract required by timingSafeEqual. Different
  // lengths CANNOT match, so we return false without touching the
  // comparison — this avoids both the throw and any chance of leaking
  // the expected length via the comparison path.
  if (provided.length !== expected.length) return false;

  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  // timingSafeEqual returns a boolean in modern Node versions; older
  // signatures returned a Buffer — coerce to boolean to keep the
  // contract stable for callers.
  const ok = timingSafeEqual(a, b);
  return typeof ok === 'boolean' ? ok : Boolean(ok);
}
