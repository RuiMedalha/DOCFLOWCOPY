import { PartiesService } from '../parties.service';
import { PartyType } from '@prisma/client';

/**
 * Sprint E: Party.slug — kebab-case ASCII of `name`, persisted on create
 * and on PATCH when name changes. Collision case appends `-<first 4 of
 * the existing id>` so the folder name is unique AND human-readable.
 */

const TENANT = 'tenant-slug-test';
const USER = 'user-1';

function buildPrisma(opts: {
  existingSlugs?: string[];
  existingByName?: Record<string, string>;
} = {}) {
  const existingSlugs = new Set(opts.existingSlugs ?? []);
  const existingByName = new Map(Object.entries(opts.existingByName ?? {}));

  const rows = new Map<string, any>();
  let id = 0;
  const nextId = () => `party-${++id}`;

  return {
    party: {
      findFirst: jest.fn(async ({ where, select }: any = {}) => {
        for (const row of rows.values()) {
          if (where?.id && where.id !== row.id) continue;
          if (where?.tenantId && where.tenantId !== row.tenantId) continue;
          if (where?.slug && where.slug !== row.slug) continue;
          if (where?.name && where.name !== row.name) continue;
          if (where?.nif && where.nif !== row.nif) continue;
          if (select) {
            const out: any = {};
            for (const k of Object.keys(select)) out[k] = row[k];
            return out;
          }
          return { ...row };
        }
        return null;
      }),
      findMany: jest.fn(async () => Array.from(rows.values()).map((r) => ({ ...r }))),
      count: jest.fn(async () => rows.size),
      create: jest.fn(async ({ data }: any) => {
        const newId = nextId();
        // Sprint E: mirror the slug generation logic here.
        const generatedSlug = data.slug;
        const row = {
          id: newId,
          tenantId: data.tenantId,
          type: data.type,
          name: data.name,
          slug: generatedSlug,
          nif: data.nif ?? null,
          iban: data.iban ?? null,
          partyCategoryId: data.partyCategoryId ?? null,
          defaultDebitAccountId: data.defaultDebitAccountId ?? null,
          defaultCreditAccountId: data.defaultCreditAccountId ?? null,
          ibanVerified: false,
          ibanFlagged: false,
          isActive: true,
          paymentTermDays: 30,
          tags: [],
          externalIds: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        rows.set(newId, row);
        return { ...row };
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = rows.get(where.id);
        if (!row) throw new Error('party not found');
        Object.assign(row, data);
        return { ...row };
      }),
    },
    ibanBlacklist: { findFirst: jest.fn(async () => null) },
    ibanHistory: { create: jest.fn(async () => undefined) },
    account: { findMany: jest.fn(async () => []) },
    $transaction: jest.fn((arr: Promise<any>[]) => Promise.all(arr)),
  };
}

function buildAudit() {
  return { log: jest.fn(async () => undefined) };
}

function buildPartyCategories() {
  return {
    assertCategoryInTenant: jest.fn(async (_t: string, id: string) => ({
      id, slug: 'fake', name: 'Fake', color: null, sortOrder: 100,
    })),
  };
}

describe('PartiesService — Party.slug generation', () => {
  it('slugifies ASCII names on create', async () => {
    const prisma = buildPrisma();
    const svc = new PartiesService(prisma as any, buildAudit() as any, buildPartyCategories() as any);
    (svc as any).findOne = jest.fn().mockResolvedValue({
      id: 'party-1', name: 'EDP Comercial', slug: 'edp-comercial',
    });

    await svc.create(TENANT, USER, {
      type: PartyType.FORNECEDOR,
      name: 'EDP Comercial',
    });

    const createCall = prisma.party.create.mock.calls[0][0];
    expect(createCall.data.slug).toBe('edp-comercial');
  });

  it('folds Portuguese diacritics (Américo → americo)', async () => {
    const prisma = buildPrisma();
    const svc = new PartiesService(prisma as any, buildAudit() as any, buildPartyCategories() as any);
    (svc as any).findOne = jest.fn().mockResolvedValue({ id: 'party-1' });

    await svc.create(TENANT, USER, {
      type: PartyType.FORNECEDOR,
      name: 'Américo Alves',
    });

    const createCall = prisma.party.create.mock.calls[0][0];
    expect(createCall.data.slug).toBe('americo-alves');
  });

  it('uses <slug>-<id4> suffix on collision', async () => {
    // Pre-seed an existing party with slug "edp-comercial".
    const prisma = buildPrisma();
    prisma.party.findFirst.mockImplementation(async ({ where }: any = {}) => {
      if (where?.slug === 'edp-comercial') {
        return { id: 'party-existing-1234', slug: 'edp-comercial' };
      }
      return null;
    });
    const svc = new PartiesService(prisma as any, buildAudit() as any, buildPartyCategories() as any);
    (svc as any).findOne = jest.fn().mockResolvedValue({ id: 'party-new' });

    await svc.create(TENANT, USER, {
      type: PartyType.FORNECEDOR,
      name: 'EDP Comercial',
    });

    const createCall = prisma.party.create.mock.calls[0][0];
    // The first 4 chars of the colliding row's id are "part".
    expect(createCall.data.slug).toBe('edp-comercial-part');
  });

  it('regenerates the slug when name changes on update', async () => {
    const prisma = buildPrisma();
    // existing party: id=party-1, name="Old Name", slug="old-name"
    prisma.party.findFirst.mockImplementation(async ({ where }: any = {}) => {
      if (where?.id === 'party-1') {
        return {
          id: 'party-1',
          name: 'Old Name',
          iban: null,
          nif: null,
          type: PartyType.FORNECEDOR,
          isActive: true,
          isRecurring: false,
          isRecurringManualOverride: false,
        };
      }
      if (where?.slug === 'new-name') return null; // no collision
      return null;
    });
    // Pre-seed the row so prisma.party.update succeeds.
    const svc = new PartiesService(prisma as any, buildAudit() as any, buildPartyCategories() as any);
    (svc as any).findOne = jest.fn().mockResolvedValue({ id: 'party-1', name: 'New Name' });

    // Inject the row into prisma's internal map by spying on update.
    (prisma.party.update as jest.Mock).mockImplementation(async ({ where, data }: any) => {
      // Echo back — the real implementation mutates rows but our stub
      // doesn't need to, the call args are what we assert against.
      return { id: where.id, ...data };
    });

    await svc.update(TENANT, USER, 'party-1', { name: 'New Name' });

    const updateCall = prisma.party.update.mock.calls.find(
      (c: any[]) => c[0]?.data?.slug,
    );
    expect(updateCall).toBeDefined();
    expect(updateCall![0].data.slug).toBe('new-name');
    expect(updateCall![0].data.name).toBe('New Name');
  });

  it('keeps the slug stable when name does not change', async () => {
    const prisma = buildPrisma();
    prisma.party.findFirst.mockResolvedValue({
      id: 'party-1',
      name: 'Existing Name',
      iban: null,
      nif: null,
      type: PartyType.FORNECEDOR,
      isActive: true,
      isRecurring: false,
      isRecurringManualOverride: false,
    });
    (prisma.party.update as jest.Mock).mockImplementation(async ({ where, data }: any) => ({
      id: where.id,
      ...data,
    }));
    const svc = new PartiesService(prisma as any, buildAudit() as any, buildPartyCategories() as any);
    (svc as any).findOne = jest.fn().mockResolvedValue({ id: 'party-1' });

    await svc.update(TENANT, USER, 'party-1', { email: 'new@example.com' });

    const updateCall = prisma.party.update.mock.calls[0];
    // No slug key in the data payload — we never overwrite on non-name edits.
    expect(updateCall[0].data.slug).toBeUndefined();
  });

  it('ignores the row being updated when checking for slug collision', async () => {
    const prisma = buildPrisma();
    prisma.party.findFirst.mockImplementation(async ({ where }: any = {}) => {
      if (where?.id === 'party-1') {
        return {
          id: 'party-1',
          name: 'Old Name',
          iban: null,
          nif: null,
          type: PartyType.FORNECEDOR,
          isActive: true,
          isRecurring: false,
          isRecurringManualOverride: false,
        };
      }
      // Slug collision check (with NOT.id) — no row matches because the
      // only party with this slug IS the row being updated.
      if (where?.slug === 'same-name') {
        // Verify the NOT clause is present.
        expect(where.NOT).toBeDefined();
        return null;
      }
      return null;
    });
    (prisma.party.update as jest.Mock).mockImplementation(async ({ where, data }: any) => ({
      id: where.id,
      ...data,
    }));
    const svc = new PartiesService(prisma as any, buildAudit() as any, buildPartyCategories() as any);
    (svc as any).findOne = jest.fn().mockResolvedValue({ id: 'party-1' });

    // Renaming to a slug that exists ONLY on the row being updated —
    // collision check must exclude it via the NOT clause.
    await svc.update(TENANT, USER, 'party-1', { name: 'Same Name' });

    const updateCall = prisma.party.update.mock.calls.find(
      (c: any[]) => c[0]?.data?.slug,
    );
    expect(updateCall).toBeDefined();
    expect(updateCall![0].data.slug).toBe('same-name');
  });
});
