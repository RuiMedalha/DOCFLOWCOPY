import { createHash } from 'crypto';

/**
 * DocFlow advisory-lock key helpers.
 *
 * Background — pg_advisory_xact_lock takes a bigint key. Two callers that
 * agree on the same key acquire a mutually exclusive lock for the
 * lifetime of the transaction. We use this to serialise read-modify-write
 * cycles on a single documentId (e.g. approve-vs-relocate races).
 *
 * Important — the lock key derivation MUST be identical across every
 * caller. If `documents.service.ts` uses `hashtext` and
 * `processing.service.ts` uses a SHA-256 truncation, two callers locking
 * on the same documentId will not actually serialise (different lock
 * spaces in Postgres). Centralising the function here guarantees parity.
 *
 * Sprint H security-audit finding M-3 — before the centralisation,
 * `relocateAfterApprove` used `hashtext('relocate:' || id)` and the
 * pipeline used `SHA-256 truncated`. Same docId → different keys → no
 * serialisation. Fix: one helper, one algorithm, imported by both.
 */

/**
 * Deterministic 63-bit positive bigint derived from a SHA-256 of the
 * document id. Used as the key for `pg_advisory_xact_lock` so concurrent
 * approves on the same document serialize on the same lock.
 *
 * The hash is truncated to 8 bytes and bit 63 is cleared (Postgres
 * bigint is signed; an advisory lock key outside the int64 range errors
 * with `bigint out of range`).
 *
 * Range: 0 .. 2^63-1.
 *
 * NOTE: any caller that previously used `hashtext(...)` MUST migrate to
 * this helper. A hashtext-derived key is incompatible.
 */
export function docLockKey(documentId: string): bigint {
  const h = createHash('sha256').update(documentId).digest();
  // Read the first 8 bytes as a big-endian unsigned int, then clear
  // the sign bit and convert to BigInt.
  const view = new DataView(h.buffer, h.byteOffset, h.byteLength);
  const unsigned = view.getBigUint64(0, false);
  return unsigned & 0x7fffffffffffffffn;
}
