/**
 * Named rate-limit definitions used by @Throttle('name').
 *
 * The names map to buckets declared in app.module.ts
 * (ThrottlerModule.forRoot([...])). Each bucket has its own TTL window
 * and request cap, applied per the tracker set by ThrottlerByGuard:
 *
 *   'login'         → 5 attempts / 15 min / per IP
 *   'extract'       → 10 / min / per tenant
 *   'export'        → 1  / min / per user
 *   'master-write'  → 30 / min / per tenant  (Sprint G review §4-A fix-up)
 *
 * `master-write` is applied to PartyContactsController and
 * PartyAddressesController POST/PATCH/DELETE — tighter than the global
 * default to deter noisy scripts hammering master-data CRUD.
 *
 * Use these constants wherever you wire `@Throttle()` so the names
 * stay in sync with the bucket declarations.
 */
export const THROTTLE_NAMES = {
  LOGIN: 'login',
  EXTRACT: 'extract',
  EXPORT: 'export',
  MASTER_WRITE: 'master-write',
} as const;

export type ThrottleName =
  (typeof THROTTLE_NAMES)[keyof typeof THROTTLE_NAMES];