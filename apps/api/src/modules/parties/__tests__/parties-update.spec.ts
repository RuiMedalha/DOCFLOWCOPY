import { ForbiddenException } from '@nestjs/common';
import { PartiesService } from '../parties.service';

/**
 * Defense-in-depth: the @Patch('parties/:id') route is gated by
 * @Roles(Role.ADMIN), but a direct service caller (queue, cron, test) could
 * still try to flip isRecurring. Verify that the service rejects non-ADMIN
 * callers and accepts ADMIN callers.
 *
 * Audit §4: ADMIN toggles of isRecurring / isRecurringManualOverride must
 * leave a per-field audit row tagged `subAction: 'party.update.recurring'`
 * carrying the field name and old/new values. These tests pin that contract
 * too.
 */

const buildPrisma = (opts?: {
  isRecurring?: boolean;
  isRecurringManualOverride?: boolean;
}) =>
  ({
    party: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'party-1',
        name: 'Acme',
        iban: null,
        nif: '123456789',
        type: 'FORNECEDOR',
        isActive: true,
        isRecurring: opts?.isRecurring ?? false,
        isRecurringManualOverride: opts?.isRecurringManualOverride ?? false,
      }),
      update: jest.fn().mockResolvedValue({
        id: 'party-1',
        name: 'Acme',
        iban: null,
        nif: '123456789',
        type: 'FORNECEDOR',
        isActive: true,
        isRecurring: true,
        isRecurringManualOverride: true,
      }),
    },
    ibanBlacklist: { findFirst: jest.fn().mockResolvedValue(null) },
    ibanHistory: { create: jest.fn().mockResolvedValue(null) },
    auditLog: { create: jest.fn().mockResolvedValue(null) },
    $transaction: jest.fn((arr) => Promise.all(arr)),
  }) as any;

const buildAudit = () =>
  ({
    log: jest.fn().mockResolvedValue(undefined),
  }) as any;

/**
 * Sprint E: the PartiesService.update path validates `partyCategoryId` via
 * PartyCategoriesService.assertCategoryInTenant. The tests below don't
 * touch the category path, but the constructor still requires the third
 * arg. Stub it out — the helper resolves anything as long as the test
 * doesn't pass a `partyCategoryId`.
 */
const buildPartyCategories = () =>
  ({
    assertCategoryInTenant: jest.fn(async (_tenantId: string, id: string) => ({
      id,
      slug: 'fake',
      name: 'Fake',
      color: null,
      sortOrder: 100,
    })),
  }) as any;

/**
 * The service's `update()` calls `this.findOne()` at the end to return the
 * fresh DB row. We patch the prototype so it short-circuits to the same
 * shape we passed to update() — keeps the test independent of Prisma calls.
 */
function patchFindOne(svc: PartiesService, payload: any) {
  (svc as any).findOne = jest.fn().mockResolvedValue(payload);
}

describe('PartiesService.update — ADMIN-only isRecurring / isRecurringManualOverride', () => {
  it('rejects non-ADMIN trying to change isRecurring', async () => {
    const svc = new PartiesService(buildPrisma(), buildAudit(), buildPartyCategories());

    await expect(
      svc.update(
        'tenant-1',
        'user-1',
        'party-1',
        { isRecurring: true } as any,
        'OPERADOR',
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects non-ADMIN trying to change isRecurringManualOverride', async () => {
    const svc = new PartiesService(buildPrisma(), buildAudit(), buildPartyCategories());

    await expect(
      svc.update(
        'tenant-1',
        'user-1',
        'party-1',
        { isRecurringManualOverride: true } as any,
        'OPERADOR',
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('allows ADMIN to change both fields', async () => {
    const prisma = buildPrisma({
      isRecurring: false,
      isRecurringManualOverride: false,
    });
    const svc = new PartiesService(prisma, buildAudit(), buildPartyCategories());
    patchFindOne(svc, {
      id: 'party-1',
      isRecurring: true,
      isRecurringManualOverride: true,
    });

    const result = await svc.update(
      'tenant-1',
      'admin-1',
      'party-1',
      { isRecurring: true, isRecurringManualOverride: true } as any,
      'ADMIN',
    );

    expect(result.isRecurring).toBe(true);
    expect(result.isRecurringManualOverride).toBe(true);
    expect(prisma.party.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'party-1' },
        data: expect.objectContaining({
          isRecurring: true,
          isRecurringManualOverride: true,
        }),
      }),
    );
  });

  it('allows ADMIN to change isRecurring without overriding', async () => {
    const prisma = buildPrisma({
      isRecurring: false,
      isRecurringManualOverride: false,
    });
    const svc = new PartiesService(prisma, buildAudit(), buildPartyCategories());
    patchFindOne(svc, { id: 'party-1' });

    await svc.update(
      'tenant-1',
      'admin-1',
      'party-1',
      { isRecurringManualOverride: true } as any,
      'ADMIN',
    );

    expect(prisma.party.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ isRecurringManualOverride: true }),
      }),
    );
  });
});

describe('PartiesService.update — audit log entries for recurring toggles', () => {
  it('writes a recurring audit row when ADMIN flips isRecurringManualOverride', async () => {
    const prisma = buildPrisma({
      isRecurring: false,
      isRecurringManualOverride: false,
    });
    const audit = buildAudit();
    const svc = new PartiesService(prisma, audit, buildPartyCategories());
    patchFindOne(svc, { id: 'party-1', isRecurringManualOverride: true });

    await svc.update(
      'tenant-1',
      'admin-1',
      'party-1',
      { isRecurringManualOverride: true } as any,
      'ADMIN',
    );

    // We expect: (1) the generic EDIT row from the IBAN-aware code path,
    // (2) the dedicated recurring row tagged with subAction + field.
    const calls = (audit.log as jest.Mock).mock.calls;
    const recurring = calls.find(
      ([entry]: any) => entry?.metadata?.subAction === 'party.update.recurring',
    );
    expect(recurring).toBeDefined();
    const [entry] = recurring;
    expect(entry.tenantId).toBe('tenant-1');
    expect(entry.userId).toBe('admin-1');
    expect(entry.action).toBe('EDIT');
    expect(entry.entityType).toBe('party');
    expect(entry.entityId).toBe('party-1');
    expect(entry.metadata).toEqual({
      subAction: 'party.update.recurring',
      field: 'isRecurringManualOverride',
      oldValue: false,
      newValue: true,
    });
  });

  it('writes a recurring audit row when ADMIN flips isRecurring', async () => {
    const prisma = buildPrisma({
      isRecurring: false,
      isRecurringManualOverride: false,
    });
    const audit = buildAudit();
    const svc = new PartiesService(prisma, audit, buildPartyCategories());
    patchFindOne(svc, { id: 'party-1', isRecurring: true });

    await svc.update(
      'tenant-1',
      'admin-1',
      'party-1',
      { isRecurring: true } as any,
      'ADMIN',
    );

    const calls = (audit.log as jest.Mock).mock.calls;
    const recurring = calls.find(
      ([entry]: any) =>
        entry?.metadata?.subAction === 'party.update.recurring' &&
        entry?.metadata?.field === 'isRecurring',
    );
    expect(recurring).toBeDefined();
    const [entry] = recurring;
    expect(entry.tenantId).toBe('tenant-1');
    expect(entry.userId).toBe('admin-1');
    expect(entry.metadata).toEqual({
      subAction: 'party.update.recurring',
      field: 'isRecurring',
      oldValue: false,
      newValue: true,
    });
  });

  it('writes ONE recurring row per actually-changed field (not for no-ops)', async () => {
    const prisma = buildPrisma({
      isRecurring: true, // already true — DTO sets true → no-op
      isRecurringManualOverride: false,
    });
    const audit = buildAudit();
    const svc = new PartiesService(prisma, audit, buildPartyCategories());
    patchFindOne(svc, { id: 'party-1' });

    await svc.update(
      'tenant-1',
      'admin-1',
      'party-1',
      // isRecurring:true is a no-op (already true); isRecurringManualOverride
      // toggles false → true and MUST be audited.
      { isRecurring: true, isRecurringManualOverride: true } as any,
      'ADMIN',
    );

    const calls = (audit.log as jest.Mock).mock.calls;
    const recurring = calls.filter(
      ([entry]: any) => entry?.metadata?.subAction === 'party.update.recurring',
    );
    // Exactly one row for the override change — no row for the no-op
    // isRecurring change.
    expect(recurring).toHaveLength(1);
    expect(recurring[0][0].metadata.field).toBe('isRecurringManualOverride');
    expect(recurring[0][0].metadata.oldValue).toBe(false);
    expect(recurring[0][0].metadata.newValue).toBe(true);
  });

  it('does NOT write a recurring audit row when ADMIN omits both fields', async () => {
    const prisma = buildPrisma();
    const audit = buildAudit();
    const svc = new PartiesService(prisma, audit, buildPartyCategories());
    patchFindOne(svc, { id: 'party-1' });

    await svc.update(
      'tenant-1',
      'admin-1',
      'party-1',
      { name: 'Renamed' } as any,
      'ADMIN',
    );

    const calls = (audit.log as jest.Mock).mock.calls;
    const recurring = calls.filter(
      ([entry]: any) => entry?.metadata?.subAction === 'party.update.recurring',
    );
    expect(recurring).toHaveLength(0);
    // The generic EDIT row IS still emitted (IBAN bookkeeping) — confirm
    // it ran at least once with action EDIT.
    const genericEdit = calls.find(
      ([entry]: any) => entry?.action === 'EDIT' && entry?.entityType === 'party',
    );
    expect(genericEdit).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Sprint E fix-up (audit §9 LOW-5 / MEDIUM-5): per-field audit row for
// partyCategoryId changes. Same per-field pattern as the recurring
// toggle — `subAction: 'party.update.partyCategory'`, field + old/new
// values. Without these rows a compliance review can't answer "who
// moved party X from category A to category B".
// ─────────────────────────────────────────────────────────────────────────

describe('PartiesService.update — audit log entries for partyCategoryId', () => {
  const buildPrismaWithCategory = (opts: {
    partyCategoryId?: string | null;
  }) =>
    ({
      party: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'party-1',
          name: 'Acme',
          iban: null,
          nif: '123456789',
          type: 'FORNECEDOR',
          isActive: true,
          isRecurring: false,
          isRecurringManualOverride: false,
          partyCategoryId: opts.partyCategoryId ?? null,
        }),
        update: jest.fn().mockResolvedValue({
          id: 'party-1',
          name: 'Acme',
          partyCategoryId: opts.partyCategoryId ?? null,
        }),
      },
      ibanBlacklist: { findFirst: jest.fn().mockResolvedValue(null) },
      ibanHistory: { create: jest.fn().mockResolvedValue(null) },
      auditLog: { create: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn((arr) => Promise.all(arr)),
    }) as any;

  it('writes a party.update.partyCategory row when the category changes (null → id)', async () => {
    const prisma = buildPrismaWithCategory({ partyCategoryId: null });
    const audit = buildAudit();
    const svc = new PartiesService(prisma, audit, buildPartyCategories());
    patchFindOne(svc, { id: 'party-1', partyCategoryId: 'cat-new' });

    await svc.update(
      'tenant-1',
      'admin-1',
      'party-1',
      { partyCategoryId: 'cat-new' } as any,
      'ADMIN',
    );

    const calls = (audit.log as jest.Mock).mock.calls;
    const category = calls.find(
      ([entry]: any) => entry?.metadata?.subAction === 'party.update.partyCategory',
    );
    expect(category).toBeDefined();
    const [entry] = category;
    expect(entry.tenantId).toBe('tenant-1');
    expect(entry.userId).toBe('admin-1');
    expect(entry.action).toBe('EDIT');
    expect(entry.entityType).toBe('party');
    expect(entry.entityId).toBe('party-1');
    expect(entry.metadata).toEqual({
      subAction: 'party.update.partyCategory',
      field: 'partyCategoryId',
      oldValue: null,
      newValue: 'cat-new',
    });
  });

  it('writes a party.update.partyCategory row when the category is cleared (id → null)', async () => {
    const prisma = buildPrismaWithCategory({ partyCategoryId: 'cat-old' });
    const audit = buildAudit();
    const svc = new PartiesService(prisma, audit, buildPartyCategories());
    patchFindOne(svc, { id: 'party-1', partyCategoryId: null });

    await svc.update(
      'tenant-1',
      'admin-1',
      'party-1',
      { partyCategoryId: null } as any,
      'ADMIN',
    );

    const calls = (audit.log as jest.Mock).mock.calls;
    const category = calls.find(
      ([entry]: any) => entry?.metadata?.subAction === 'party.update.partyCategory',
    );
    expect(category).toBeDefined();
    expect(category[0].metadata).toEqual({
      subAction: 'party.update.partyCategory',
      field: 'partyCategoryId',
      oldValue: 'cat-old',
      newValue: null,
    });
  });

  it('does NOT write a party.update.partyCategory row when the category is unchanged', async () => {
    const prisma = buildPrismaWithCategory({ partyCategoryId: 'cat-same' });
    const audit = buildAudit();
    const svc = new PartiesService(prisma, audit, buildPartyCategories());
    patchFindOne(svc, { id: 'party-1', partyCategoryId: 'cat-same' });

    await svc.update(
      'tenant-1',
      'admin-1',
      'party-1',
      { partyCategoryId: 'cat-same' } as any,
      'ADMIN',
    );

    const calls = (audit.log as jest.Mock).mock.calls;
    const category = calls.filter(
      ([entry]: any) => entry?.metadata?.subAction === 'party.update.partyCategory',
    );
    expect(category).toHaveLength(0);
  });

  it('does NOT write a party.update.partyCategory row when partyCategoryId is omitted from the DTO', async () => {
    const prisma = buildPrismaWithCategory({ partyCategoryId: 'cat-existing' });
    const audit = buildAudit();
    const svc = new PartiesService(prisma, audit, buildPartyCategories());
    patchFindOne(svc, { id: 'party-1' });

    await svc.update(
      'tenant-1',
      'admin-1',
      'party-1',
      { name: 'Renamed' } as any,
      'ADMIN',
    );

    const calls = (audit.log as jest.Mock).mock.calls;
    const category = calls.filter(
      ([entry]: any) => entry?.metadata?.subAction === 'party.update.partyCategory',
    );
    expect(category).toHaveLength(0);
  });
});
