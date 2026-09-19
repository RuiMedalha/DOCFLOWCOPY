import {
  ConflictException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Role } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { AuthService } from './auth.service';
import { TwoFactorService } from './two-factor.service';
import { AuditService } from '../audit/audit.service';
import { __resetLoginLockoutForTests } from '../../common/auth/login-lockout';

// ---------- helpers --------------------------------------------------------
const TENANT = {
  id: 'tenant-1',
  name: 'Demo',
  slug: 'demo',
  nif: null,
  active: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const ADMIN_USER: {
  id: string;
  tenantId: string;
  email: string;
  passwordHash: string;
  name: string;
  role: Role;
  isActive: boolean;
  deletedAt: null;
  twoFactorEnabled: boolean;
  twoFactorSecret: null;
  lastLoginAt: null;
  createdAt: Date;
  updatedAt: Date;
  canViewBankValues: boolean;
  canViewReconciliation: boolean;
  canApprovePayments: boolean;
  canExportData: boolean;
  canManagePayroll: boolean;
  canManageIntegrations: boolean;
  permissions: null;
  scanToken: null;
  scanEmail: null;
  logoUrl: null;
  settings: null;
  bic: null;
  bankName: null;
  iban: null;
  address: null;
  city: null;
  postalCode: null;
  country: string;
} = {
  id: 'user-1',
  tenantId: TENANT.id,
  email: 'admin@demo.pt',
  passwordHash: '', // filled in beforeEach
  name: 'Admin Demo',
  role: Role.ADMIN,
  isActive: true,
  deletedAt: null,
  twoFactorEnabled: false,
  twoFactorSecret: null,
  lastLoginAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  canViewBankValues: false,
  canViewReconciliation: false,
  canApprovePayments: false,
  canExportData: false,
  canManagePayroll: false,
  canManageIntegrations: false,
  permissions: null,
  scanToken: null,
  scanEmail: null,
  logoUrl: null,
  settings: null,
  bic: null,
  bankName: null,
  iban: null,
  address: null,
  city: null,
  postalCode: null,
  country: 'PT',
};

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

function buildPrismaMock() {
  const tenantFindUnique = jest.fn();
  const tenantCreate = jest.fn();
  const userFindUnique = jest.fn();
  const userCreate = jest.fn();
  const userUpdate = jest.fn();
  const refreshTokenCreate = jest.fn();
  const refreshTokenFindUnique = jest.fn();
  const refreshTokenFindFirst = jest.fn();
  const refreshTokenUpdate = jest.fn();
  const refreshTokenUpdateMany = jest.fn();
  const refreshTokenCount = jest.fn();
  const auditLogCreate = jest.fn();
  const folderRuleCreate = jest.fn();
  const transaction = jest.fn();

  const tx = {
    tenant: { create: tenantCreate },
    user: { create: userCreate, update: userUpdate },
    auditLog: { create: auditLogCreate },
    folderRule: { create: folderRuleCreate },
    refreshToken: { create: refreshTokenCreate },
  };
  // Support BOTH forms: array-of-promises AND callback-style. AuthService
  // uses array form for login/audit and callback form for register/invite.
  transaction.mockImplementation(async (input: any) => {
    if (Array.isArray(input)) {
      // Resolve every prisma operation in the order given — the values returned
      // here don't matter for the assertions; the mocks themselves capture calls.
      return Promise.all(input);
    }
    if (typeof input === 'function') {
      return input(tx);
    }
    return undefined;
  });

  return {
    prisma: {
      tenant: { findUnique: tenantFindUnique, create: tenantCreate },
      user: {
        findUnique: userFindUnique,
        create: userCreate,
        update: userUpdate,
      },
      refreshToken: {
        create: refreshTokenCreate,
        findUnique: refreshTokenFindUnique,
        findFirst: refreshTokenFindFirst,
        update: refreshTokenUpdate,
        updateMany: refreshTokenUpdateMany,
        count: refreshTokenCount,
      },
      auditLog: { create: auditLogCreate },
      folderRule: { create: folderRuleCreate },
      $transaction: transaction,
    } as any,
    mocks: {
      tenantFindUnique,
      tenantCreate,
      userFindUnique,
      userCreate,
      userUpdate,
      refreshTokenCreate,
      refreshTokenFindUnique,
      refreshTokenFindFirst,
      refreshTokenUpdate,
      refreshTokenUpdateMany,
      refreshTokenCount,
      auditLogCreate,
      folderRuleCreate,
      transaction,
    },
  };
}

function buildJwtMock() {
  return {
    signAsync: jest.fn(async (_payload: unknown, _opts?: unknown) => 'signed.access.token'),
  } as unknown as JwtService;
}

function buildTwoFactorMock() {
  return {
    verifyToken: jest.fn().mockReturnValue(true),
    generateSecret: jest.fn(),
    enable: jest.fn(),
    disable: jest.fn(),
  } as unknown as TwoFactorService & { verifyToken: jest.Mock };
}

function buildAuditMock() {
  return {
    log: jest.fn(async () => undefined),
    logInTx: jest.fn(async () => undefined),
    verifyChain: jest.fn(async () => ({ valid: true })),
  } as unknown as AuditService;
}

function buildConfig() {
  return {
    get: jest.fn((key: string, fallback?: string) => {
      const map: Record<string, string> = {
        JWT_ACCESS_SECRET: 'test-access-secret',
        JWT_ISSUER: 'docflow-test',
        JWT_AUDIENCE: 'docflow-api-test',
        JWT_ACCESS_EXPIRES_IN: '15m',
      };
      return map[key] ?? fallback;
    }),
  } as unknown as ConfigService;
}

// ---------- tests ----------------------------------------------------------
describe('AuthService', () => {
  let svc: AuthService;
  let prisma: ReturnType<typeof buildPrismaMock>['prisma'];
  let mocks: ReturnType<typeof buildPrismaMock>['mocks'];
  let jwt: JwtService;
  let twoFactor: ReturnType<typeof buildTwoFactorMock>;
  let config: ConfigService;
  let audit: AuditService;
  let hashedPassword: string;

  beforeEach(async () => {
    const built = buildPrismaMock();
    prisma = built.prisma;
    mocks = built.mocks;
    jwt = buildJwtMock();
    twoFactor = buildTwoFactorMock();
    config = buildConfig();
    audit = buildAuditMock();
    svc = new AuthService(prisma, jwt, config, twoFactor, audit);

    // AUDIT §4.1: per-account lockout uses a process-wide singleton.
    // Reset between tests so cross-test state never bleeds into the
    // 5-failure threshold below.
    __resetLoginLockoutForTests();

    hashedPassword = await bcrypt.hash('correct horse battery staple', 4); // low cost in tests
    ADMIN_USER.passwordHash = hashedPassword;
  });

  // ============================================================== register
  describe('register()', () => {
    const dto = {
      tenantName: 'DocFlow Demo',
      tenantSlug: 'docflow-demo',
      tenantNif: '500123456',
      email: 'admin@demo.pt',
      password: 'Admin123!Secure',
      name: 'João Silva',
    };

    it('creates the tenant + admin user and returns tokens', async () => {
      mocks.tenantFindUnique.mockResolvedValue(null); // slug available
      // tenantCreate should echo the input (Prisma returns the row it just wrote)
      mocks.tenantCreate.mockImplementation(async (args: any) => ({ ...TENANT, ...args.data }));
      mocks.userCreate.mockImplementation(async (args: any) => ({ ...ADMIN_USER, ...args.data }));
      mocks.folderRuleCreate.mockResolvedValue({});
      mocks.auditLogCreate.mockResolvedValue({});
      mocks.refreshTokenCreate.mockResolvedValue({});

      const out = await svc.register(dto);

      expect(out.user.email).toBe(dto.email);
      expect(out.user.role).toBe(Role.ADMIN);
      expect(out.tenant.slug).toBe(dto.tenantSlug);
      expect(out.tokens.accessToken).toBe('signed.access.token');
      expect(out.tokens.refreshToken).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(out.tokens.expiresIn).toBe(15 * 60);
      expect(mocks.tenantCreate).toHaveBeenCalledTimes(1);
      expect(mocks.userCreate).toHaveBeenCalledTimes(1);
      expect(mocks.refreshTokenCreate).toHaveBeenCalledTimes(1);
      expect(mocks.folderRuleCreate).toHaveBeenCalledTimes(1);

      // C-03: the row written to refresh_tokens must carry `tokenHash`
      // (sha256 of the raw token) and never the raw token itself.
      const writeArgs = mocks.refreshTokenCreate.mock.calls[0]?.[0];
      expect(writeArgs).toBeDefined();
      expect(writeArgs).toHaveProperty('data.tokenHash');
      expect(writeArgs.data.tokenHash).toMatch(/^[a-f0-9]{64}$/);
      expect(writeArgs.data.token).toBeNull();
      // And the returned raw token's hash MUST equal what we wrote.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const c = require('crypto');
      const expectedHash = c.createHash('sha256').update(out.tokens.refreshToken).digest('hex');
      expect(writeArgs.data.tokenHash).toBe(expectedHash);

      // Audit row is now written via AuditService.logInTx (was inline auditLog.create).
      expect((audit.logInTx as jest.Mock)).toHaveBeenCalledTimes(1);
      expect((audit.logInTx as jest.Mock)).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: 'CREATE_TENANT',
          entityType: 'tenant',
        }),
      );
    });

    it('rejects duplicate tenant slugs with ConflictException', async () => {
      mocks.tenantFindUnique.mockResolvedValue({ id: 'taken' });
      await expect(svc.register(dto)).rejects.toBeInstanceOf(ConflictException);
      expect(mocks.tenantCreate).not.toHaveBeenCalled();
    });
  });

  // =============================================================== login
  describe('login()', () => {
    const dto = {
      email: ADMIN_USER.email,
      password: 'correct horse battery staple',
      tenantSlug: TENANT.slug,
    };

    it('returns tokens + user for a valid password', async () => {
      mocks.tenantFindUnique.mockResolvedValue({ ...TENANT });
      mocks.userFindUnique.mockResolvedValue({ ...ADMIN_USER });
      mocks.refreshTokenCreate.mockResolvedValue({});
      mocks.userUpdate.mockResolvedValue({});
      mocks.auditLogCreate.mockResolvedValue({});

      const out = await svc.login(dto, { ip: '127.0.0.1', userAgent: 'jest' });
      if ('requiresTwoFactor' in out) throw new Error('expected authenticated response');

      expect(out.user.email).toBe(dto.email);
      expect(out.tokens.accessToken).toBeTruthy();
      // Audit row is now written via AuditService.log (was inline auditLog.create).
      expect((audit.log as jest.Mock)).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'LOGIN', ip: '127.0.0.1' }),
      );
    });

    it('rejects unknown tenant slug', async () => {
      mocks.tenantFindUnique.mockResolvedValue(null);
      await expect(svc.login(dto)).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('rejects wrong password with generic error', async () => {
      mocks.tenantFindUnique.mockResolvedValue({ ...TENANT });
      mocks.userFindUnique.mockResolvedValue({ ...ADMIN_USER });
      await expect(svc.login({ ...dto, password: 'wrong' })).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('rejects inactive users', async () => {
      mocks.tenantFindUnique.mockResolvedValue({ ...TENANT });
      mocks.userFindUnique.mockResolvedValue({ ...ADMIN_USER, isActive: false });
      await expect(svc.login(dto)).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('returns Pending2FAResponse when 2FA is enabled and no code supplied', async () => {
      mocks.tenantFindUnique.mockResolvedValue({ ...TENANT });
      mocks.userFindUnique.mockResolvedValue({
        ...ADMIN_USER,
        twoFactorEnabled: true,
        twoFactorSecret: 'JBSWY3DPEHPK3PXP',
      });

      const out = await svc.login(dto);
      if (!('requiresTwoFactor' in out)) throw new Error('expected 2FA challenge');
      expect(out.requiresTwoFactor).toBe(true);
      expect(out.userId).toBe(ADMIN_USER.id);
      expect(mocks.refreshTokenCreate).not.toHaveBeenCalled();
    });

    it('verifies the TOTP when 2FA is enabled and a code is supplied', async () => {
      mocks.tenantFindUnique.mockResolvedValue({ ...TENANT });
      mocks.userFindUnique.mockResolvedValue({
        ...ADMIN_USER,
        twoFactorEnabled: true,
        twoFactorSecret: 'JBSWY3DPEHPK3PXP',
      });
      (twoFactor.verifyToken as jest.Mock).mockReturnValue(true);
      mocks.refreshTokenCreate.mockResolvedValue({});
      mocks.userUpdate.mockResolvedValue({});
      mocks.auditLogCreate.mockResolvedValue({});

      const out = await svc.login({ ...dto, twoFactorCode: '123456' });
      if ('requiresTwoFactor' in out) throw new Error('expected authenticated response');
      expect(out.tokens.accessToken).toBeTruthy();
      expect(twoFactor.verifyToken).toHaveBeenCalledWith('JBSWY3DPEHPK3PXP', '123456');
    });

    it('rejects a bad TOTP code with UnauthorizedException', async () => {
      mocks.tenantFindUnique.mockResolvedValue({ ...TENANT });
      mocks.userFindUnique.mockResolvedValue({
        ...ADMIN_USER,
        twoFactorEnabled: true,
        twoFactorSecret: 'JBSWY3DPEHPK3PXP',
      });
      (twoFactor.verifyToken as jest.Mock).mockReturnValue(false);

      await expect(svc.login({ ...dto, twoFactorCode: '000000' })).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });
  });

  // ============================================================== refresh
  describe('refresh()', () => {
    // C-03: the stub row carries `tokenHash` (sha256 of the raw token) so
    // the service's `where: { tokenHash }` lookup resolves it.
    const RAW_TOKEN = 'old-refresh-token';
    const TOKEN_HASH = (() => {
      // Inline sha256 to keep the test stub self-contained.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const c = require('crypto');
      return c.createHash('sha256').update(RAW_TOKEN).digest('hex');
    })();

    it('rotates a valid refresh token', async () => {
      const future = new Date(Date.now() + 86400_000);
      mocks.refreshTokenFindUnique.mockResolvedValue({
        id: 'rt-1',
        userId: ADMIN_USER.id,
        tokenHash: TOKEN_HASH,
        expiresAt: future,
        revokedAt: null,
        user: { ...ADMIN_USER },
      });
      // C-03: completeRefresh() re-loads the user via findUnique before
      // generating tokens (since the include payload isn't used).
      mocks.userFindUnique.mockResolvedValue({ ...ADMIN_USER });
      mocks.refreshTokenCreate.mockResolvedValue({});
      mocks.refreshTokenUpdate.mockResolvedValue({});

      const out = await svc.refresh(RAW_TOKEN);
      expect(out.accessToken).toBeTruthy();
      expect(mocks.refreshTokenUpdate).toHaveBeenCalledWith({
        where: { id: 'rt-1' },
        data: expect.objectContaining({ revokedAt: expect.any(Date) }),
      });
    });

    it('rejects an unknown refresh token', async () => {
      mocks.refreshTokenFindUnique.mockResolvedValue(null);
      // Also no legacy fallback row.
      await expect(svc.refresh('nope')).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('rejects an expired refresh token', async () => {
      mocks.refreshTokenFindUnique.mockResolvedValue({
        id: 'rt-1',
        userId: ADMIN_USER.id,
        tokenHash: TOKEN_HASH,
        expiresAt: new Date(Date.now() - 1000),
        revokedAt: null,
        user: { ...ADMIN_USER },
      });
      await expect(svc.refresh(RAW_TOKEN)).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('revokes the entire family when a revoked token is replayed', async () => {
      mocks.refreshTokenFindUnique.mockResolvedValue({
        id: 'rt-1',
        userId: ADMIN_USER.id,
        tokenHash: TOKEN_HASH,
        expiresAt: new Date(Date.now() + 86400_000),
        revokedAt: new Date(),
        user: { ...ADMIN_USER },
      });
      mocks.refreshTokenCount.mockResolvedValue(2);
      mocks.refreshTokenUpdateMany.mockResolvedValue({ count: 2 });

      await expect(svc.refresh(RAW_TOKEN)).rejects.toBeInstanceOf(UnauthorizedException);
      expect(mocks.refreshTokenUpdateMany).toHaveBeenCalledWith({
        where: { userId: ADMIN_USER.id, revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
    });

    it('C-03: refresh() looks up by sha256 hash, not by raw token', async () => {
      // The pin statement for the C-03 fix: the service must pass
      // `where: { tokenHash: sha256(rawToken) }` — never `where: { token: rawToken }`.
      mocks.refreshTokenFindUnique.mockResolvedValue(null);
      await expect(svc.refresh(RAW_TOKEN)).rejects.toBeInstanceOf(UnauthorizedException);

      const callArgs = mocks.refreshTokenFindUnique.mock.calls[0]?.[0];
      expect(callArgs).toBeDefined();
      expect(callArgs).toHaveProperty('where.tokenHash', TOKEN_HASH);
      // Belt-and-braces: ensure we did NOT pass `where.token` as a key.
      expect(callArgs.where).not.toHaveProperty('token');
    });
  });

  // ============================================================== logout
  describe('logout()', () => {
    // C-03: same hashing contract as refresh().
    const RAW = 'logout-target';
    const HASH = (() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const c = require('crypto');
      return c.createHash('sha256').update(RAW).digest('hex');
    })();

    it('revokes the matching refresh token (lookup by tokenHash)', async () => {
      mocks.refreshTokenFindFirst.mockResolvedValue({
        id: 'rt-1',
        userId: ADMIN_USER.id,
        tokenHash: HASH,
      });
      mocks.refreshTokenUpdate.mockResolvedValue({});

      const out = await svc.logout(ADMIN_USER.id, ADMIN_USER.tenantId, RAW);
      expect(out.revoked).toBe(true);
      expect(mocks.refreshTokenUpdate).toHaveBeenCalledWith({
        where: { id: 'rt-1' },
        data: expect.objectContaining({ revokedAt: expect.any(Date) }),
      });
      // Audit row is now written via AuditService.log (was inline auditLog.create).
      expect((audit.log as jest.Mock)).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'LOGOUT' }),
      );

      // C-03: must have looked up by `where: { tokenHash: HASH, userId }`.
      const args = mocks.refreshTokenFindFirst.mock.calls[0]?.[0];
      expect(args).toHaveProperty('where.tokenHash', HASH);
      expect(args).toHaveProperty('where.userId', ADMIN_USER.id);
    });

    it('falls back to the legacy token column during the migration window', async () => {
      // First findFirst (tokenHash) misses, second findFirst (token) hits.
      mocks.refreshTokenFindFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          id: 'rt-legacy',
          userId: ADMIN_USER.id,
          token: RAW,
        });
      mocks.refreshTokenUpdate.mockResolvedValue({});

      const out = await svc.logout(ADMIN_USER.id, ADMIN_USER.tenantId, RAW);
      expect(out.revoked).toBe(true);
      expect(mocks.refreshTokenUpdate).toHaveBeenCalledWith({
        where: { id: 'rt-legacy' },
        data: expect.objectContaining({ revokedAt: expect.any(Date) }),
      });
    });

    it('is idempotent when the token is already gone', async () => {
      mocks.refreshTokenFindFirst.mockResolvedValue(null);
      const out = await svc.logout(ADMIN_USER.id, ADMIN_USER.tenantId, 'missing');
      expect(out.revoked).toBe(true);
      expect(mocks.refreshTokenUpdate).not.toHaveBeenCalled();
    });
  });

  // ============================================================== invite
  describe('inviteUser()', () => {
    const dto = {
      email: 'new@demo.pt',
      name: 'Newbie',
      role: Role.OPERADOR,
      canViewBankValues: false,
      canViewReconciliation: false,
      canApprovePayments: false,
      canExportData: false,
      canManagePayroll: false,
      canManageIntegrations: false,
    };

    it('creates a user and returns a one-time temp password', async () => {
      mocks.userFindUnique.mockResolvedValue(null);
      mocks.userCreate.mockResolvedValue({
        ...ADMIN_USER,
        email: dto.email,
        name: dto.name,
        role: dto.role,
      });
      mocks.auditLogCreate.mockResolvedValue({});

      const out = await svc.inviteUser('inviter-1', TENANT.id, dto);
      expect(out.user.email).toBe(dto.email);
      expect(out.user.role).toBe(Role.OPERADOR);
      expect(out.temporaryPassword).toMatch(/^[A-Za-z0-9_-]{14}$/);
      // The plaintext is returned once; never persisted.
      expect(mocks.userCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ email: dto.email, role: dto.role }),
        }),
      );
      // Audit row is now written via AuditService.logInTx (was inline auditLog.create).
      expect((audit.logInTx as jest.Mock)).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: 'INVITE_USER' }),
      );
    });

    it('rejects duplicate emails in the same tenant', async () => {
      mocks.userFindUnique.mockResolvedValue({ id: 'existing' });
      await expect(svc.inviteUser('inviter-1', TENANT.id, dto)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(mocks.userCreate).not.toHaveBeenCalled();
    });
  });

  // =============================================================== revokeAll
  describe('revokeAllForUser()', () => {
    it('marks all live refresh tokens revoked', async () => {
      mocks.refreshTokenUpdateMany.mockResolvedValue({ count: 3 });
      const out = await svc.revokeAllForUser('user-1');
      expect(out.count).toBe(3);
      expect(mocks.refreshTokenUpdateMany).toHaveBeenCalledWith({
        where: { userId: 'user-1', revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
    });
  });
});