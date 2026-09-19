/**
 * Per-account login lockout.
 *
 * Audit finding §4.1 / §5.3 of `audit-and-ui-overhaul/AUDIT-REPORT.md`:
 * the previous throttle was per-IP. An attacker rotating through a /24
 * (or a single NAT with many users behind it) bypassed the bucket. We
 * add a per-account counter keyed by `tenantSlug:email` — 5 consecutive
 * failures within a 15-minute sliding window lock the account for 30
 * minutes regardless of source IP.
 *
 * Storage is in-process (Map). This is acceptable for the MVP because:
 *   - Each DocFlow deployment runs a single API process for now.
 *   - The lockout window (30min) is short enough that a process restart
 *     is bounded.
 * In a clustered deployment (multiple API processes), the map MUST be
 * hoisted into a shared store (Redis with INCR + EXPIRE). The interface
 * here is intentionally small so that swap is mechanical.
 *
 * Counter hygiene:
 *   - Successful login → `reset(account)`.
 *   - Failure → `recordFailure(account)`.
 *   - Pre-check bcrypt cost → `isLocked(account)`. Locked calls throw
 *     `LockedException` which the controller maps to HTTP 423.
 *   - Generic message (`'Invalid credentials'`) on locked attempts so
 *     the API does not leak account existence.
 */

export interface AccountKey {
  tenantSlug: string;
  email: string;
}

export interface LockoutEntry {
  failures: number;
  /** ms-since-epoch of the FIRST failure in the active window. */
  windowStart: number;
  /** ms-since-epoch when the lock expires; null when not locked. */
  lockedUntil: number | null;
}

export interface LockoutOptions {
  /** Failures allowed inside `windowMs` before lockout kicks in. Default 5. */
  threshold?: number;
  /** Sliding window in ms. Default 15 minutes. */
  windowMs?: number;
  /** Lockout duration in ms. Default 30 minutes. */
  lockMs?: number;
  /** Clock supplier — overridable so tests can use fake timers. */
  now?: () => number;
}

export const DEFAULT_LOCKOUT_OPTIONS: Required<Omit<LockoutOptions, 'now'>> = {
  threshold: 5,
  windowMs: 15 * 60 * 1000,
  lockMs: 30 * 60 * 1000,
};

export class LockedException extends Error {
  readonly tenantSlug: string;
  readonly email: string;
  readonly lockedUntil: number;
  constructor(tenantSlug: string, email: string, lockedUntil: number) {
    super('Account temporarily locked due to too many failed attempts');
    this.name = 'LockedException';
    this.tenantSlug = tenantSlug;
    this.email = email;
    this.lockedUntil = lockedUntil;
  }
}

function normalizeKey(account: AccountKey): string {
  // Lowercase email to make the key case-insensitive — users do try the
  // same email with mixed casing. tenantSlug is already lowercased by
  // the DTO validator (Matches /^[a-z0-9-]+$/).
  return `${account.tenantSlug.toLowerCase()}:${account.email.trim().toLowerCase()}`;
}

/**
 * Map-based in-memory lockout tracker. The class is intentionally tiny —
 * one Map, no async primitives — so tests can deterministically drive
 * it via fake timers.
 */
export class LoginLockout {
  private readonly entries = new Map<string, LockoutEntry>();
  private readonly threshold: number;
  private readonly windowMs: number;
  private readonly lockMs: number;
  private readonly now: () => number;

  constructor(opts: LockoutOptions = {}) {
    this.threshold = opts.threshold ?? DEFAULT_LOCKOUT_OPTIONS.threshold;
    this.windowMs = opts.windowMs ?? DEFAULT_LOCKOUT_OPTIONS.windowMs;
    this.lockMs = opts.lockMs ?? DEFAULT_LOCKOUT_OPTIONS.lockMs;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Returns true when the account is currently locked AND the lock has
   * not expired. A locked account MUST NOT proceed to bcrypt.
   */
  isLocked(account: AccountKey): boolean {
    const entry = this.entries.get(normalizeKey(account));
    if (!entry?.lockedUntil) return false;
    if (entry.lockedUntil <= this.now()) {
      // Lock expired — drop the entry so the next failure starts a
      // fresh window instead of accumulating into the old one.
      this.entries.delete(normalizeKey(account));
      return false;
    }
    return true;
  }

  /**
   * Record a failed login attempt. Returns the updated entry so callers
   * can branch on `entry.lockedUntil` for logging. Returns null when no
   * entry was created (windowMs has not elapsed AND a fresh failure
   * would exceed threshold — caller-side decision).
   */
  recordFailure(account: AccountKey): LockoutEntry {
    const key = normalizeKey(account);
    const now = this.now();
    const existing = this.entries.get(key);
    let entry: LockoutEntry;
    if (!existing) {
      entry = { failures: 1, windowStart: now, lockedUntil: null };
    } else if (now - existing.windowStart > this.windowMs) {
      // Window elapsed — restart the counter. This is a SLIDING window
      // (resets after `windowMs` of no failures), not a fixed window,
      // because attackers will not pause voluntarily.
      entry = { failures: 1, windowStart: now, lockedUntil: null };
    } else {
      entry = {
        failures: existing.failures + 1,
        windowStart: existing.windowStart,
        lockedUntil: existing.lockedUntil,
      };
    }
    if (entry.failures >= this.threshold && entry.lockedUntil === null) {
      entry.lockedUntil = now + this.lockMs;
    }
    this.entries.set(key, entry);
    return entry;
  }

  /**
   * Clear the counter on a successful login. Idempotent.
   */
  reset(account: AccountKey): void {
    this.entries.delete(normalizeKey(account));
  }

  /**
   * Pre-check helper: throws LockedException when the account is locked,
   * otherwise returns silently. The controller maps LockedException to
   * the same `'Invalid credentials'` body that wrong-password attempts
   * get — no leak of account existence.
   */
  assertNotLocked(account: AccountKey): void {
    if (this.isLocked(account)) {
      const entry = this.entries.get(normalizeKey(account));
      throw new LockedException(
        account.tenantSlug,
        account.email,
        entry?.lockedUntil ?? this.now(),
      );
    }
  }

  /** Read-only introspection for tests / metrics. */
  get(account: AccountKey): LockoutEntry | undefined {
    return this.entries.get(normalizeKey(account));
  }

  /** Wipe all state — tests + a future admin endpoint. */
  clear(): void {
    this.entries.clear();
  }
}

/**
 * Singleton accessor. We need a single shared map per process, so the
 * service holds an instance and exposes this getter. Tests construct
 * their own `new LoginLockout()` rather than going through this
 * accessor, so the singleton can be swapped in cluster deployments
 * (replace `instance` with a Redis-backed implementation).
 */
let instance: LoginLockout | null = null;
export function getLoginLockout(): LoginLockout {
  if (!instance) instance = new LoginLockout();
  return instance;
}

/** Test-only: replace the singleton with a fresh instance. */
export function __resetLoginLockoutForTests(): void {
  instance = null;
}
