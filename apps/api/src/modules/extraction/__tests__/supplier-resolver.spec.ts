import { SupplierResolver } from '../supplier-resolver';

/**
 * The `refreshRecurringFlag` helper auto-flips `isRecurring` on a party
 * once the document count crosses RECURRING_THRESHOLD (=3). When the ADMIN
 * sets `isRecurringManualOverride = true`, the auto-flip MUST pause and
 * return the locked value as-is.
 *
 * Audit §3 TOCTOU fix (2026-09-03): the old SELECT+UPDATE pair was
 * replaced with a single atomic `updateMany` keyed on
 * `isRecurringManualOverride: false` so an ADMIN flipping the override
 * mid-flight is respected (count=0, no write). These tests pin that
 * contract.
 */

const buildPrisma = (opts: {
  postImageOverride: boolean;
  postImageIsRecurring: boolean;
  docCount: number;
}) => {
  const updateMany = jest.fn().mockResolvedValue({ count: 1 });
  return {
    party: {
      findFirst: jest.fn().mockResolvedValue({
        isRecurringManualOverride: opts.postImageOverride,
        isRecurring: opts.postImageIsRecurring,
      }),
      updateMany,
      // Legacy `update` should NEVER be called by the new atomic path —
      // any regression here breaks the audit guarantee.
      update: jest.fn(),
    },
    document: {
      count: jest.fn().mockResolvedValue(opts.docCount),
    },
  } as any;
};

describe('SupplierResolver.refreshRecurringFlag — ADMIN override guard', () => {
  it('does NOT flip when isRecurringManualOverride=true (lock at false)', async () => {
    const prisma = buildPrisma({
      postImageOverride: true,
      postImageIsRecurring: false,
      docCount: 10, // would normally flip
    });
    // Simulate "ADMIN enabled override between our docCount read and our
    // updateMany" by returning count=0 from the conditional updateMany.
    (prisma.party.updateMany as jest.Mock).mockResolvedValue({ count: 0 });

    const resolver = new SupplierResolver(prisma);

    const result = await (resolver as any).refreshRecurringFlag(
      'tenant-1',
      'party-1',
      0,
    );

    expect(result).toBe(false); // locked value, not auto-flip true
    expect(prisma.party.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'party-1',
          isRecurringManualOverride: false,
        },
        data: { isRecurring: true },
      }),
    );
    expect(prisma.party.update).not.toHaveBeenCalled();
  });

  it('does NOT flip and returns locked true when override is on even with low doc count', async () => {
    const prisma = buildPrisma({
      postImageOverride: true,
      postImageIsRecurring: true,
      docCount: 0, // below threshold — but updateMany never runs anyway
    });

    const resolver = new SupplierResolver(prisma);

    const result = await (resolver as any).refreshRecurringFlag(
      'tenant-1',
      'party-1',
      0,
    );

    expect(result).toBe(true); // the locked true
    expect(prisma.party.updateMany).not.toHaveBeenCalled();
    expect(prisma.party.update).not.toHaveBeenCalled();
  });

  it('flips normally when isRecurringManualOverride=false and threshold crossed', async () => {
    const prisma = buildPrisma({
      postImageOverride: false,
      postImageIsRecurring: false,
      docCount: 3, // == RECURRING_THRESHOLD
    });

    const resolver = new SupplierResolver(prisma);

    const result = await (resolver as any).refreshRecurringFlag(
      'tenant-1',
      'party-1',
      0,
    );

    expect(result).toBe(true);
    expect(prisma.party.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'party-1',
          isRecurringManualOverride: false,
        },
        data: { isRecurring: true },
      }),
    );
    // The atomic path MUST NOT use the old `party.update` form — that was
    // the source of the TOCTOU window. A regression here is a security
    // regression and must fail CI.
    expect(prisma.party.update).not.toHaveBeenCalled();
  });

  it('does NOT flip when docCount is below threshold (override irrelevant)', async () => {
    const prisma = buildPrisma({
      postImageOverride: false,
      postImageIsRecurring: false,
      docCount: 2, // below threshold
    });

    const resolver = new SupplierResolver(prisma);

    const result = await (resolver as any).refreshRecurringFlag(
      'tenant-1',
      'party-1',
      0,
    );

    expect(result).toBe(false);
    expect(prisma.party.updateMany).not.toHaveBeenCalled();
  });

  // ── Audit §3: explicit TOCTOU pin tests ─────────────────────────────────

  it('TOCTOU: when override flips on between docCount read and updateMany, count=0 → no write, return current', async () => {
    const prisma = buildPrisma({
      postImageOverride: true, // post-image: override was just enabled
      postImageIsRecurring: false,
      docCount: 5, // would normally flip
    });
    (prisma.party.updateMany as jest.Mock).mockResolvedValue({ count: 0 });

    const resolver = new SupplierResolver(prisma);

    const result = await (resolver as any).refreshRecurringFlag(
      'tenant-1',
      'party-1',
      0,
    );

    // updateMany was attempted with the conditional where — DB said no.
    expect(prisma.party.updateMany).toHaveBeenCalledWith({
      where: { id: 'party-1', isRecurringManualOverride: false },
      data: { isRecurring: true },
    });
    // Result reflects the locked current value, NOT the would-be flip.
    expect(result).toBe(false);
    expect(prisma.party.update).not.toHaveBeenCalled();
  });

  it('TOCTOU: when override stays false, count=1 → write happened, returns shouldRecur', async () => {
    const prisma = buildPrisma({
      postImageOverride: false,
      postImageIsRecurring: true, // post-image: we just flipped it on
      docCount: 7, // well past threshold
    });
    (prisma.party.updateMany as jest.Mock).mockResolvedValue({ count: 1 });

    const resolver = new SupplierResolver(prisma);

    const result = await (resolver as any).refreshRecurringFlag(
      'tenant-1',
      'party-1',
      0,
    );

    expect(prisma.party.updateMany).toHaveBeenCalledWith({
      where: { id: 'party-1', isRecurringManualOverride: false },
      data: { isRecurring: true },
    });
    expect(result).toBe(true);
    expect(prisma.party.update).not.toHaveBeenCalled();
  });
});
