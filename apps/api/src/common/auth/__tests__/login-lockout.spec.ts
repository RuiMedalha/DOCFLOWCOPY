import { LoginLockout, LockedException } from '../login-lockout';

describe('LoginLockout', () => {
  const account = { tenantSlug: 'demo', email: 'admin@demo.pt' };

  /** Fake clock helper — returns a function we can pass to LoginLockout. */
  function makeFakeClock(initial: number) {
    let current = initial;
    const fn = () => current;
    return {
      now: fn,
      advance: (ms: number) => {
        current += ms;
      },
      set: (v: number) => {
        current = v;
      },
    };
  }

  // ──────────────────────────────────────────────────── basic record/reset
  it('starts unlocked and reports no failures for an unknown account', () => {
    const clock = makeFakeClock(1_700_000_000_000);
    const lockout = new LoginLockout({ now: clock.now });
    expect(lockout.isLocked(account)).toBe(false);
    expect(lockout.get(account)).toBeUndefined();
  });

  it('records failures and returns an entry with the count', () => {
    const clock = makeFakeClock(1_700_000_000_000);
    const lockout = new LoginLockout({ now: clock.now });
    const entry = lockout.recordFailure(account);
    expect(entry.failures).toBe(1);
    expect(entry.lockedUntil).toBeNull();
  });

  it('reset() clears the counter', () => {
    const clock = makeFakeClock(1_700_000_000_000);
    const lockout = new LoginLockout({ now: clock.now });
    lockout.recordFailure(account);
    lockout.recordFailure(account);
    lockout.reset(account);
    expect(lockout.get(account)).toBeUndefined();
    expect(lockout.isLocked(account)).toBe(false);
  });

  // ──────────────────────────────────────────────────── threshold behaviour
  it('does NOT lock below the threshold (default 5)', () => {
    const clock = makeFakeClock(1_700_000_000_000);
    const lockout = new LoginLockout({ now: clock.now });
    for (let i = 0; i < 4; i++) {
      const entry = lockout.recordFailure(account);
      expect(entry.lockedUntil).toBeNull();
    }
    expect(lockout.isLocked(account)).toBe(false);
  });

  it('locks the account on the 5th consecutive failure within the window', () => {
    const clock = makeFakeClock(1_700_000_000_000);
    const lockout = new LoginLockout({ now: clock.now });
    for (let i = 0; i < 4; i++) lockout.recordFailure(account);
    const fifth = lockout.recordFailure(account);
    expect(fifth.failures).toBe(5);
    expect(fifth.lockedUntil).not.toBeNull();
    expect(fifth.lockedUntil!).toBe(1_700_000_000_000 + 30 * 60 * 1000);
    expect(lockout.isLocked(account)).toBe(true);
  });

  it('assertNotLocked throws LockedException while the lock is active', () => {
    const clock = makeFakeClock(1_700_000_000_000);
    const lockout = new LoginLockout({ now: clock.now });
    for (let i = 0; i < 5; i++) lockout.recordFailure(account);
    expect(() => lockout.assertNotLocked(account)).toThrow(LockedException);
  });

  it('keeps the SAME error message shape — controller-side generic message', () => {
    // Sanity: the lockout throws a LockedException, but the controller
    // maps it to the generic `'Invalid credentials'` body. The error
    // itself never reaches the wire — verify the type is what the
    // controller catches.
    const clock = makeFakeClock(1_700_000_000_000);
    const lockout = new LoginLockout({ now: clock.now });
    for (let i = 0; i < 5; i++) lockout.recordFailure(account);
    try {
      lockout.assertNotLocked(account);
      throw new Error('expected LockedException');
    } catch (err) {
      expect(err).toBeInstanceOf(LockedException);
    }
  });

  // ──────────────────────────────────────────────────── window reset
  it('resets the counter when the window has elapsed (sliding window)', () => {
    const clock = makeFakeClock(1_700_000_000_000);
    const lockout = new LoginLockout({ now: clock.now });
    for (let i = 0; i < 4; i++) lockout.recordFailure(account);
    // Advance past the 15-minute window — but BEFORE the 30-minute lock
    // would have been relevant (since we never reached threshold).
    clock.advance(15 * 60 * 1000 + 1);
    const entry = lockout.recordFailure(account);
    expect(entry.failures).toBe(1);
    expect(entry.lockedUntil).toBeNull();
  });

  it('clears the lock when lockMs have elapsed', () => {
    const clock = makeFakeClock(1_700_000_000_000);
    const lockout = new LoginLockout({ now: clock.now });
    for (let i = 0; i < 5; i++) lockout.recordFailure(account);
    expect(lockout.isLocked(account)).toBe(true);
    // Advance past lock expiry (30 min)
    clock.advance(30 * 60 * 1000 + 1);
    expect(lockout.isLocked(account)).toBe(false);
    // The entry was dropped on lock-expiry check
    expect(lockout.get(account)).toBeUndefined();
  });

  // ──────────────────────────────────────────────────── multi-account isolation
  it('tracks different accounts independently', () => {
    const clock = makeFakeClock(1_700_000_000_000);
    const lockout = new LoginLockout({ now: clock.now });
    const alice = { tenantSlug: 'demo', email: 'alice@demo.pt' };
    const bob = { tenantSlug: 'demo', email: 'bob@demo.pt' };
    for (let i = 0; i < 5; i++) lockout.recordFailure(alice);
    expect(lockout.isLocked(alice)).toBe(true);
    expect(lockout.isLocked(bob)).toBe(false);
    // bob's first failure must not be affected by alice's lock
    expect(lockout.recordFailure(bob).failures).toBe(1);
  });

  it('treats email case-insensitively (normalises to lower)', () => {
    const clock = makeFakeClock(1_700_000_000_000);
    const lockout = new LoginLockout({ now: clock.now });
    const upper = { tenantSlug: 'demo', email: 'Admin@DEMO.PT' };
    const lower = { tenantSlug: 'demo', email: 'admin@demo.pt' };
    for (let i = 0; i < 5; i++) lockout.recordFailure(upper);
    expect(lockout.isLocked(lower)).toBe(true);
  });

  // ──────────────────────────────────────────────────── custom thresholds
  it('honours a custom threshold and lock duration', () => {
    const clock = makeFakeClock(1_700_000_000_000);
    const lockout = new LoginLockout({
      now: clock.now,
      threshold: 2,
      windowMs: 5 * 60 * 1000,
      lockMs: 60 * 1000,
    });
    lockout.recordFailure(account);
    const entry = lockout.recordFailure(account);
    expect(entry.lockedUntil).toBe(1_700_000_000_000 + 60_000);
    expect(lockout.isLocked(account)).toBe(true);
  });

  // ──────────────────────────────────────────────────── clear()
  it('clear() wipes all state', () => {
    const clock = makeFakeClock(1_700_000_000_000);
    const lockout = new LoginLockout({ now: clock.now });
    lockout.recordFailure({ tenantSlug: 'a', email: 'a@x' });
    lockout.recordFailure({ tenantSlug: 'b', email: 'b@x' });
    lockout.clear();
    expect(lockout.get({ tenantSlug: 'a', email: 'a@x' })).toBeUndefined();
  });
});
