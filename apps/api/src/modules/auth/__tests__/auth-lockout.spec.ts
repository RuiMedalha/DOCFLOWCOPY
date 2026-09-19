/**
 * Lockout-flow integration tests for AuthService.
 *
 * The map is the singleton from `getLoginLockout()`; each test resets
 * it via `__resetLoginLockoutForTests` so we never leak state between
 * cases. Fake timers are NOT used here — the spec exercises the
 * **real wall clock** with a tight threshold so the 30-min lock window
 * doesn't actually trigger. We cover the lock-expiry path with a
 * separate test using a custom `LoginLockout` instance + injected
 * clock (see `login-lockout.spec.ts` for the helper-level tests).
 */
import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Role } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { AuthService } from '../auth.service';
import { TwoFactorService } from '../two-factor.service';
import { AuditService } from '../../audit/audit.service';
import {
  getLoginLockout,
  __resetLoginLockoutForTests,
} from '../../../common/auth/login-lockout';

// ──────────────────────────────────────────────────────── test doubles

const TENANT = {
  id: 'tenant-1',
  name: 'Demo',
  slug: 'demo',
  nif: null,
  active: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function buildUserRow(overrides: Partial<{ email: string; isActive: boolean }> = {}) {
  return {
    id: 'user-1',
    tenantId: TENANT.id,
    email: overrides.email ?? 'admin@demo.pt',
    passwordHash: '', // filled by the test
    name: 'Admin Demo',
    role: Role.ADMIN,
    isActive: overrides.isActive ?? true,
    deletedAt: null,
    twoFactorEnabled: false,
    twoFactorSecret: null,
  };
}

function buildPrismaMock() {
  const tenantFindUnique = jest.fn();
  const userFindUnique = jest.fn();
  const userUpdate = jest.fn();
  const refreshTokenCreate = jest.fn();
  const auditLogCreate = jest.fn();
  return {
    prisma: {
      tenant: { findUnique: tenantFindUnique },
      user: { findUnique: userFindUnique, update: userUpdate },
      refreshToken: { create: refreshTokenCreate },
      auditLog: { create: auditLogCreate },
      $transaction: jest.fn(async (input: any) => (Array.isArray(input) ? Promise.all(input) : input)),
    } as any,
    mocks: { tenantFindUnique, userFindUnique, userUpdate, refreshTokenCreate, auditLogCreate },
  };
}

function buildJwt() {
  return {
    signAsync: jest.fn(async (_p: unknown, _o?: unknown) => 'signed.access.token'),
  } as unknown as JwtService;
}

function buildTwoFactor() {
  return {
    verifyToken: jest.fn().mockReturnValue(true),
  } as unknown as TwoFactorService;
}

function buildAudit() {
  return {
    log: jest.fn(async () => undefined),
    logInTx: jest.fn(async () => undefined),
  } as unknown as AuditService;
}

function buildConfig() {
  return {
    get: jest.fn((k: string, fallback?: string) => {
      const map: Record<string, string> = {
        JWT_ACCESS_SECRET: 'test-access-secret',
        JWT_ISSUER: 'docflow-test',
        JWT_AUDIENCE: 'docflow-api-test',
        JWT_ACCESS_EXPIRES_IN: '15m',
      };
      return map[k] ?? fallback;
    }),
  } as unknown as ConfigService;
}

function buildSvc() {
  const { prisma, mocks } = buildPrismaMock();
  const svc = new AuthService(prisma, buildJwt(), buildConfig(), buildTwoFactor(), buildAudit());
  return { svc, mocks };
}

// ──────────────────────────────────────────────────────── tests

describe('AuthService — per-account login lockout (AUDIT §4.1)', () => {
  let svc: AuthService;
  let mocks: ReturnType<typeof buildPrismaMock>['mocks'];
  let hashedPassword: string;
  const dto = {
    email: 'admin@demo.pt',
    password: 'correct horse battery staple',
    tenantSlug: TENANT.slug,
  };

  beforeEach(async () => {
    __resetLoginLockoutForTests();
    const built = buildSvc();
    svc = built.svc;
    mocks = built.mocks;
    hashedPassword = await bcrypt.hash(dto.password, 4);
    mocks.tenantFindUnique.mockResolvedValue({ ...TENANT });
    mocks.userFindUnique.mockResolvedValue({ ...buildUserRow(), passwordHash: hashedPassword });
    mocks.userUpdate.mockResolvedValue({});
    mocks.refreshTokenCreate.mockResolvedValue({});
    mocks.auditLogCreate.mockResolvedValue({});
  });

  it('locks the account on the 5th consecutive bad-password attempt', async () => {
    for (let i = 0; i < 4; i++) {
      await expect(
        svc.login({ ...dto, password: 'wrong' }, { ip: '127.0.0.1' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    }
    // 5th attempt with the WRONG password still gets an Unauthorized
    // (not 423) — the lockout fires AFTER bcrypt so the wire message
    // matches every other failure.
    await expect(
      svc.login({ ...dto, password: 'wrong' }, { ip: '127.0.0.1' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    // 6th attempt with the CORRECT password is now blocked — but the
    // body is still 'Invalid credentials' so callers can't distinguish.
    let captured: unknown = null;
    try {
      await svc.login(dto, { ip: '127.0.0.1' });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(UnauthorizedException);
    expect((captured as UnauthorizedException).message).toBe('Invalid credentials');
    // bcypt never ran on the locked attempt — refresh token was NOT created.
    expect(mocks.refreshTokenCreate).not.toHaveBeenCalled();
  });

  it('resets the counter on a successful login (4 fails + 1 success → no lock)', async () => {
    for (let i = 0; i < 4; i++) {
      await expect(
        svc.login({ ...dto, password: 'wrong' }, { ip: '127.0.0.1' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    }
    // Successful login — clears the counter.
    const ok = await svc.login(dto, { ip: '127.0.0.1' });
    expect(ok).toHaveProperty('tokens.accessToken');
    // Now four MORE failures are still under threshold — no lock.
    for (let i = 0; i < 4; i++) {
      await expect(
        svc.login({ ...dto, password: 'wrong' }, { ip: '127.0.0.1' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    }
    // The successful login still went through, AND no lock has fired.
    const entry = getLoginLockout().get({ tenantSlug: dto.tenantSlug, email: dto.email });
    expect(entry).toBeDefined();
    expect(entry?.failures).toBe(4);
    expect(entry?.lockedUntil).toBeNull();
  });

  it('exposes the lockout helper as a singleton (same instance across calls)', () => {
    const a = getLoginLockout();
    const b = getLoginLockout();
    expect(a).toBe(b);
  });

  it('does NOT lock when failures are scattered across multiple users (per-account keying)', async () => {
    // user A — three bad attempts (no lock)
    mocks.userFindUnique.mockResolvedValue({
      ...buildUserRow({ email: 'a@demo.pt' }),
      passwordHash: hashedPassword,
    });
    for (let i = 0; i < 3; i++) {
      await expect(
        svc.login({ ...dto, email: 'a@demo.pt', password: 'wrong' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    }
    // user B — three different attempts, fresh counter (no lock)
    mocks.userFindUnique.mockResolvedValue({
      ...buildUserRow({ email: 'b@demo.pt' }),
      passwordHash: hashedPassword,
    });
    for (let i = 0; i < 3; i++) {
      await expect(
        svc.login({ ...dto, email: 'b@demo.pt', password: 'wrong' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    }
    // user A's counter is independent — still 3, not 6
    const aEntry = getLoginLockout().get({ tenantSlug: dto.tenantSlug, email: 'a@demo.pt' });
    expect(aEntry?.failures).toBe(3);
  });

  it('records a failure when the tenant is unknown (covers enumeration attacks)', async () => {
    mocks.tenantFindUnique.mockResolvedValue(null);
    await expect(svc.login(dto)).rejects.toBeInstanceOf(UnauthorizedException);
    const entry = getLoginLockout().get({ tenantSlug: dto.tenantSlug, email: dto.email });
    expect(entry?.failures).toBe(1);
  });

  it('returns the same "Invalid credentials" message whether locked or not', async () => {
    // Drive the account into lockout.
    for (let i = 0; i < 5; i++) {
      try { await svc.login({ ...dto, password: 'wrong' }); } catch { /* expected */ }
    }
    // Now attempt with the CORRECT password — must return the same
    // message. We don't want the API to leak whether the password was
    // correct on a locked attempt.
    let lockedErr: UnauthorizedException | undefined;
    try {
      await svc.login(dto);
    } catch (err) {
      lockedErr = err as UnauthorizedException;
    }
    expect(lockedErr).toBeInstanceOf(UnauthorizedException);
    expect(lockedErr!.message).toBe('Invalid credentials');
  });

  it('does NOT count a 2FA-challenge return (no code supplied) as a failure', async () => {
    mocks.userFindUnique.mockResolvedValue({
      ...buildUserRow(),
      passwordHash: hashedPassword,
      twoFactorEnabled: true,
    });
    // 10 challenges in a row — no lock.
    for (let i = 0; i < 10; i++) {
      const out = await svc.login(dto);
      if (!('requiresTwoFactor' in out)) throw new Error('expected 2FA challenge');
    }
    const entry = getLoginLockout().get({ tenantSlug: dto.tenantSlug, email: dto.email });
    expect(entry).toBeUndefined();
  });
});
