import { Injectable, Logger } from '@nestjs/common';
import { AuditAction, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

/**
 * Sprint H — Tenants settings service.
 *
 * Thin layer over Prisma's Tenant.settings JSON column. The settings
 * shape isn't typed at the schema level (it's a `Json` column), so we
 * narrow it here to the documented contract:
 *
 *   {
 *     "autoApprove": boolean,
 *     ...
 *   }
 *
 * Settings writes ALWAYS write a `tenant.settings.update` audit row
 * with the previous and new values — never silently. The frontend
 * `AutoApproveToggle` polls the GET to refresh; the backend audit log
 * gives the human admin a forensic trail.
 */

type JsonObject = Record<string, unknown>;

export interface TenantSettingsShape {
  autoApprove?: boolean;
  [key: string]: unknown;
}

@Injectable()
export class TenantsService {
  private readonly logger = new Logger(TenantsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Fetch the tenant's current settings. Empty object → defaults.
   */
  async get(tenantId: string): Promise<TenantSettingsShape> {
    const row = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { settings: true },
    });
    if (!row) return {};
    const settings = row.settings as TenantSettingsShape | null;
    return settings ?? {};
  }

  /**
   * Update one or more settings. Writes a `tenant.settings.update`
   * audit row with the previous value inside `metadata.before` and
   * the new value in `metadata.after`. Run inside a single
   * transaction with the audit row so an observer never sees the
   * settings flipped without the audit row.
   */
  async update(
    tenantId: string,
    userId: string,
    patch: Partial<TenantSettingsShape>,
  ): Promise<TenantSettingsShape> {
    const before = await this.get(tenantId);
    const next: TenantSettingsShape = {
      ...before,
      ...patch,
    };

    // Build the audit `metadata.before/after` projections.
    // PATCH /tenants/me/settings currently accepts only autoApprove,
    // but new keys flow through this same path. We store the WHOLE
    // before/after pair so the audit row stays useful as the schema
    // grows.
    const beforeMeta = this.snapshot(before);
    const afterMeta = this.snapshot(next);
    const changedKeys = this.diffKeys(beforeMeta, afterMeta);

    await this.prisma.$transaction(async (tx) => {
      await tx.tenant.update({
        where: { id: tenantId },
        data: { settings: next as unknown as Prisma.InputJsonValue },
      });
      await this.audit.logInTx(tx as never, {
        tenantId,
        userId,
        action: AuditAction.EDIT,
        entityType: 'tenant.settings',
        entityId: tenantId,
        metadata: {
          subAction: 'tenant.settings.update',
          changedKeys,
          before: beforeMeta as Prisma.InputJsonValue,
          after: afterMeta as Prisma.InputJsonValue,
        },
      });
    });

    this.logger.log(
      `[tenants.update] tenant=${tenantId} user=${userId} keys=${changedKeys.join(',') || '(none)'}`,
    );
    return next;
  }

  private snapshot(settings: TenantSettingsShape): Record<string, unknown> {
    // Stable, deterministic projection for the audit row.
    return JSON.parse(JSON.stringify(settings)) as Record<string, unknown>;
  }

  private diffKeys(
    before: Record<string, unknown>,
    after: Record<string, unknown>,
  ): string[] {
    const keys = new Set<string>([...Object.keys(before), ...Object.keys(after)]);
    const changed: string[] = [];
    for (const key of keys) {
      if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
        changed.push(key);
      }
    }
    return changed.sort();
  }
}
