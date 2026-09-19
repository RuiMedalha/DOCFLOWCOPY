import {
  ConflictException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { AuditAction, Role } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { DocFlowJwtPayload } from '../../common/guards/jwt.guard';
import { AuditService } from '../audit/audit.service';
import { AuthenticatedUser } from './strategies/jwt.strategy';
import { InviteUserDto } from './dto/invite-user.dto';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { TwoFactorService } from './two-factor.service';
import {
  getLoginLockout,
  LockedException,
} from '../../common/auth/login-lockout';

const BCRYPT_ROUNDS = 12;
/** 7 days in ms — refresh token TTL. Read JWT_REFRESH_EXPIRES_IN if you want to override. */
const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * SHA-256 hex digest of the refresh token's raw bytes — stored on the row,
 * never the token itself. The raw token is only emitted once at creation
 * (see {@link AuthService.generateTokens}). Every lookup below hashes the
 * wire-side value first and queries by hash. C-03.
 */
function hashRefreshToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number; // seconds until access token expires
}

export interface AuthenticatedResponse {
  user: PublicUser;
  tenant: { id: string; name: string; slug: string };
  tokens: TokenPair;
}

export interface Pending2FAResponse {
  requiresTwoFactor: true;
  userId: string;
  tenantId: string;
}

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  tenantId: string;
  twoFactorEnabled: boolean;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly twoFactor: TwoFactorService,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------- register
  async register(dto: RegisterDto): Promise<AuthenticatedResponse> {
    const existingTenant = await this.prisma.tenant.findUnique({
      where: { slug: dto.tenantSlug },
      select: { id: true },
    });
    if (existingTenant) {
      throw new ConflictException('Tenant slug already in use');
    }

    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);

    const { tenant, user } = await this.prisma.$transaction(async (tx) => {
      const t = await tx.tenant.create({
        data: {
          name: dto.tenantName,
          slug: dto.tenantSlug,
          nif: dto.tenantNif ?? null,
        },
      });

      const u = await tx.user.create({
        data: {
          tenantId: t.id,
          email: dto.email,
          passwordHash,
          name: dto.name,
          role: Role.ADMIN,
        },
      });

      // Default folder rule — gives the new tenant a working auto-folder out of the box.
      await tx.folderRule.create({
        data: {
          tenantId: t.id,
          name: 'Padrão Ano/Mês/Tipo',
          priority: 0,
          conditions: {},
          folderPattern: '/{Ano}/{Mes}/{Tipo}/{Entidade}',
        },
      });

      // Audit the tenant birth. logInTx rethrows on failure so the
      // tenant+user creation is rolled back if the audit row cannot be
      // written with a valid hash — same atomicity guarantee as the old
      // inline create call, but with a correct rowHash.
      await this.audit.logInTx(tx, {
        tenantId: t.id,
        userId: u.id,
        action: AuditAction.CREATE_TENANT,
        entityType: 'tenant',
        entityId: t.id,
        metadata: { slug: t.slug },
      });

      return { tenant: t, user: u };
    });

    const tokens = await this.generateTokens(user);
    return {
      user: this.toPublicUser(user),
      tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug },
      tokens,
    };
  }

  // ------------------------------------------------------------------ login
  /**
   * Returns either full tokens, or a `Pending2FAResponse` when 2FA is on and
   * no code was supplied (the client must call /auth/login again with the code).
   *
   * AUDIT §4.1 / §5.3: per-account lockout (5 fails / 15 min → 30 min lock)
   * runs BEFORE bcrypt so a locked account pays zero CPU cost. Locked
   * attempts share the same `'Invalid credentials'` response as wrong-
   * password attempts so the API cannot be used to enumerate accounts.
   */
  async login(
    dto: LoginDto,
    meta?: { ip?: string; userAgent?: string },
  ): Promise<AuthenticatedResponse | Pending2FAResponse> {
    const lockout = getLoginLockout();
    const accountKey = { tenantSlug: dto.tenantSlug, email: dto.email };

    // 1) Pre-bcrypt lock check — the cheapest possible rejection.
    try {
      lockout.assertNotLocked(accountKey);
    } catch (err) {
      if (err instanceof LockedException) {
        // Structured log separate from auth failures — SIEM-friendly.
        // We do NOT count a locked attempt as a fresh failure (the
        // account is already locked; counting would extend the lock
        // indefinitely under continuous attempts).
        this.logger.warn({
          event: 'login.locked',
          tenantSlug: dto.tenantSlug,
          email: dto.email,
          ip: meta?.ip ?? null,
          userAgent: meta?.userAgent ?? null,
          lockedUntil: new Date(err.lockedUntil).toISOString(),
        });
        throw new UnauthorizedException('Invalid credentials');
      }
      throw err;
    }

    const tenant = await this.prisma.tenant.findUnique({
      where: { slug: dto.tenantSlug },
      select: { id: true, name: true, slug: true, active: true },
    });
    if (!tenant || !tenant.active) {
      // Same message as bad creds — don't reveal that the slug exists.
      // We DO record a failure here so a brute-force enumeration of
      // slugs is also rate-limited. The cost is a tiny in-memory map
      // write — no DB hit, no bcrypt.
      lockout.recordFailure(accountKey);
      this.logger.warn({
        event: 'login.fail',
        reason: 'tenant_unknown_or_inactive',
        tenantSlug: dto.tenantSlug,
        email: dto.email,
        ip: meta?.ip ?? null,
      });
      throw new UnauthorizedException('Invalid credentials');
    }

    const user = await this.prisma.user.findUnique({
      where: { tenantId_email: { tenantId: tenant.id, email: dto.email } },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        tenantId: true,
        passwordHash: true,
        isActive: true,
        deletedAt: true,
        twoFactorEnabled: true,
        twoFactorSecret: true,
      },
    });
    if (!user || !user.isActive || user.deletedAt) {
      // Account-inactive gets a failure recorded so the lockout covers
      // attempts at disabled / deleted users too. Same generic message.
      lockout.recordFailure(accountKey);
      this.logger.warn({
        event: 'login.fail',
        reason: 'user_unknown_or_inactive',
        tenantSlug: dto.tenantSlug,
        email: dto.email,
        ip: meta?.ip ?? null,
      });
      throw new UnauthorizedException('Invalid credentials');
    }

    const passwordOk = await bcrypt.compare(dto.password, user.passwordHash);
    if (!passwordOk) {
      const entry = lockout.recordFailure(accountKey);
      this.logger.warn({
        event: 'login.fail',
        reason: 'bad_password',
        tenantSlug: dto.tenantSlug,
        email: dto.email,
        ip: meta?.ip ?? null,
        failures: entry.failures,
        locked: entry.lockedUntil !== null,
      });
      throw new UnauthorizedException('Invalid credentials');
    }

    // 2FA gate: if on and no code supplied, hand back a marker; the client must
    // re-call /auth/login with the TOTP code to complete the sign-in.
    //
    // NOTE: a 2FA-challenge return (no code supplied yet) is NEITHER a
    // success NOR a failure — we leave the counter alone so an attacker
    // can't push the user's account into lockout by spamming 2FA
    // challenges.
    if (user.twoFactorEnabled) {
      if (!dto.twoFactorCode) {
        return {
          requiresTwoFactor: true,
          userId: user.id,
          tenantId: user.tenantId,
        };
      }
      if (!user.twoFactorSecret || !this.twoFactor.verifyToken(user.twoFactorSecret, dto.twoFactorCode)) {
        // Bad TOTP counts as a failure too — same lockout discipline.
        const entry = lockout.recordFailure(accountKey);
        this.logger.warn({
          event: 'login.fail',
          reason: 'bad_2fa',
          tenantSlug: dto.tenantSlug,
          email: dto.email,
          ip: meta?.ip ?? null,
          failures: entry.failures,
          locked: entry.lockedUntil !== null,
        });
        throw new UnauthorizedException('Invalid credentials');
      }
    }

    // Successful login (bcrypt passed AND any required TOTP passed).
    // Reset the per-account counter — the audit §4.1 spec calls this
    // out explicitly.
    lockout.reset(accountKey);

    const tokens = await this.generateTokens(user);

    // lastLoginAt update runs in its own transaction. The audit row is
    // written via AuditService (best-effort: never fails the login).
    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });
    await this.audit.log({
      tenantId: tenant.id,
      userId: user.id,
      action: AuditAction.LOGIN,
      ip: meta?.ip ?? null,
      userAgent: meta?.userAgent ?? null,
    });

    return {
      user: this.toPublicUser(user),
      tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug },
      tokens,
    };
  }

  // --------------------------------------------------------------- refresh
  async refresh(refreshToken: string): Promise<TokenPair> {
    // C-03: lookup by SHA-256 hash, not by raw token. The DB row only ever
    // contains the hash; the raw value lives in the caller's cookie/header.
    const tokenHash = hashRefreshToken(refreshToken);
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });
    if (!stored) {
      // Fallback for the migration window: an environment where some rows
      // still have plaintext `token` and no `tokenHash`. Once the follow-up
      // migration drops `token`, this branch becomes unreachable and is left
      // in only as a 24-48h safety net.
      const legacy = await this.prisma.refreshToken.findUnique({
        where: { token: refreshToken },
        include: { user: true },
      });
      if (!legacy) {
        throw new UnauthorizedException('Invalid refresh token');
      }
      return this.completeRefresh(legacy);
    }
    return this.completeRefresh(stored);
  }

  /**
   * Shared post-lookup logic for refresh(): chain validation, family
   * revocation on reuse detection, rotation.
   */
  private async completeRefresh(
    stored: {
      id: string;
      userId: string;
      revokedAt: Date | null;
      expiresAt: Date;
      user: { isActive: boolean; deletedAt: Date | null };
    },
  ): Promise<TokenPair> {
    if (stored.revokedAt) {
      // Reuse of a revoked token: revoke the entire family. Detected by lookup
      // of any OTHER non-revoked token for the same user — if found, treat as
      // a stolen-token event.
      const others = await this.prisma.refreshToken.count({
        where: { userId: stored.userId, revokedAt: null, NOT: { id: stored.id } },
      });
      if (others > 0) {
        await this.prisma.refreshToken.updateMany({
          where: { userId: stored.userId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        this.logger.warn(`Possible refresh-token reuse for user ${stored.userId} — entire family revoked`);
      }
      throw new UnauthorizedException('Refresh token revoked');
    }
    if (stored.expiresAt < new Date()) {
      throw new UnauthorizedException('Refresh token expired');
    }
    if (!stored.user.isActive || stored.user.deletedAt) {
      throw new UnauthorizedException('User inactive');
    }

    // Rotate: revoke the old one, issue a new pair.
    const userRow = await this.prisma.user.findUnique({
      where: { id: stored.userId },
      select: { id: true, email: true, role: true, tenantId: true, isActive: true },
    });
    if (!userRow) {
      throw new UnauthorizedException('User inactive');
    }
    const newPair = await this.generateTokens(userRow);
    await this.prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date() },
    });
    return newPair;
  }

  // ---------------------------------------------------------------- logout
  async logout(userId: string, tenantId: string, refreshToken: string): Promise<{ revoked: true }> {
    // C-03: lookup by SHA-256 hash, with a fallback to the legacy `token`
    // column for the migration window.
    const tokenHash = hashRefreshToken(refreshToken);
    let stored = await this.prisma.refreshToken.findFirst({
      where: { tokenHash, userId },
    });
    if (!stored) {
      stored = await this.prisma.refreshToken.findFirst({
        where: { token: refreshToken, userId },
      });
    }
    if (!stored) {
      // Idempotent: token already gone — treat as success.
      return { revoked: true };
    }
    await this.prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date() },
    });
    await this.audit.log({
      tenantId,
      userId,
      action: AuditAction.LOGOUT,
    });
    return { revoked: true };
  }

  // -------------------------------------------------------------------- me
  async me(userId: string): Promise<PublicUser & { tenant: { id: string; name: string; slug: string } }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { tenant: { select: { id: true, name: true, slug: true, active: true } } },
    });
    if (!user || !user.isActive || user.deletedAt || !user.tenant.active) {
      throw new UnauthorizedException('User not found');
    }
    return {
      ...this.toPublicUser(user),
      tenant: { id: user.tenant.id, name: user.tenant.name, slug: user.tenant.slug },
    };
  }

  // --------------------------------------------------------------- invite
  /**
   * Admin/operator invites a new user into the SAME tenant. Returns the
   * generated temporary password exactly once — the caller is expected to
   * deliver it via an out-of-band channel.
   */
  async inviteUser(inviterId: string, tenantId: string, dto: InviteUserDto): Promise<{
    user: PublicUser;
    temporaryPassword: string;
  }> {
    const existing = await this.prisma.user.findUnique({
      where: { tenantId_email: { tenantId, email: dto.email } },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException('User already exists in this tenant');
    }

    // Cryptographically-strong temporary password. The caller MUST surface it
    // to the invitee; we never store it in plaintext.
    const temporaryPassword = this.generateTempPassword();
    const passwordHash = await bcrypt.hash(temporaryPassword, BCRYPT_ROUNDS);

    const user = await this.prisma.$transaction(async (tx) => {
      const u = await tx.user.create({
        data: {
          tenantId,
          email: dto.email,
          name: dto.name,
          passwordHash,
          role: dto.role,
          canViewBankValues: dto.canViewBankValues ?? false,
          canViewReconciliation: dto.canViewReconciliation ?? false,
          canApprovePayments: dto.canApprovePayments ?? false,
          canExportData: dto.canExportData ?? false,
          canManagePayroll: dto.canManagePayroll ?? false,
          canManageIntegrations: dto.canManageIntegrations ?? false,
        },
      });
      await this.audit.logInTx(tx, {
        tenantId,
        userId: inviterId,
        action: AuditAction.INVITE_USER,
        entityType: 'user',
        entityId: u.id,
        metadata: { email: dto.email, role: dto.role },
      });
      return u;
    });

    return {
      user: this.toPublicUser(user),
      temporaryPassword,
    };
  }

  // ============================================================ helpers ===
  /**
   * Sign a fresh access+refresh pair. C-03: only the SHA-256 hash of the
   * refresh token is persisted. The raw token is emitted exactly once
   * (here, on the returned `refreshToken` field) and never written to
   * the DB.
   */
  private async generateTokens(user: {
    id: string;
    email: string;
    role: Role;
    tenantId: string;
    isActive: boolean;
  }): Promise<TokenPair> {
    const issuer = this.config.get<string>('JWT_ISSUER') ?? 'docflow';
    const audience = this.config.get<string>('JWT_AUDIENCE') ?? 'docflow-api';
    const expiresIn = this.config.get<string>('JWT_ACCESS_EXPIRES_IN') ?? '15m';
    const secret = this.config.get<string>('JWT_ACCESS_SECRET') ?? this.config.get<string>('JWT_SECRET');

    const sid = randomUUID();
    const jti = randomUUID();
    const payload: DocFlowJwtPayload = {
      sub: user.id,
      tenant_id: user.tenantId,
      roles: [user.role],
      sid,
      jti,
    };

    const accessToken = await this.jwt.signAsync(payload, {
      secret,
      issuer,
      audience,
      expiresIn: expiresIn as unknown as number,
      algorithm: 'HS256',
    });

    // Opaque refresh token — random, not a JWT. Persisted ONLY as a SHA-256
    // hash so a DB leak does not yield usable session tokens. The raw value
    // is returned to the caller (this is the only time it leaves the process).
    const refreshToken = randomBytes(48).toString('base64url');
    const tokenHash = hashRefreshToken(refreshToken);
    await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash,
        // Legacy plaintext column kept nullable for the migration window —
        // we DO NOT write it on fresh rows, but a pre-deploy DB can still
        // answer a hash-miss by falling back to it (see refresh() / logout()).
        token: null,
        expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
      },
    });

    return {
      accessToken,
      refreshToken,
      expiresIn: this.toSeconds(expiresIn),
    };
  }

  private toPublicUser(u: { id: string; email: string; name: string; role: Role; tenantId: string; twoFactorEnabled: boolean }): PublicUser {
    return {
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      tenantId: u.tenantId,
      twoFactorEnabled: u.twoFactorEnabled,
    };
  }

  private generateTempPassword(): string {
    // 14 chars, url-safe, easy to type. Replace with a passphrase generator
    // if you want better memorability.
    return randomBytes(10).toString('base64url').slice(0, 14);
  }

  private toSeconds(exp: string): number {
    const m = /^(\d+)([smhd])$/.exec(exp.trim());
    if (!m) return 900; // 15m default
    const n = parseInt(m[1], 10);
    const unit = m[2];
    return n * ({ s: 1, m: 60, h: 3600, d: 86400 }[unit] ?? 60);
  }

  // Exposed for tests / future API surface (e.g. revocation admin endpoints)
  async revokeAllForUser(userId: string): Promise<{ count: number }> {
    const result = await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return { count: result.count };
  }
}