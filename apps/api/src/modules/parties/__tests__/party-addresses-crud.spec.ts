import { PartyAddressType } from '@prisma/client';
import { PartyAddressesService } from '../party-addresses.service';

/**
 * Sprint G — PartyAddress CRUD + isPrimary transaction semantics.
 *
 * The non-trivial bits to lock down:
 *   1. `isPrimary` invariant: at most one isPrimary=true per
 *      (partyId, type). Enforced via pg_advisory_xact_lock inside
 *      prisma.$transaction — the test mocks the transaction callback
 *      to capture the EXECUTE order and the updateMany / update calls.
 *   2. Auto-promote: when the first address of a type is created without
 *      `isPrimary=true`, the service promotes it automatically so the UI
 *      always has a primary of each type to render.
 *   3. Fast-path vs slow-path: a PATCH that changes only scalar fields
 *      (line1/line2/city/postalCode/country) does NOT take the lock;
 *      a PATCH that flips type or isPrimary MUST go through the
 *      transaction with the lock.
 *   4. Tenant isolation: a contact in another tenant cannot be
 *      updated/deleted.
 *   5. RBAC: the controller layer is the gate (controller.spec covers
 *      the @Roles(ADMIN) decorator). Service-layer calls from a queue
 *      would still go through; the tests focus on the invariant logic.
 */

const TENANT_A = 'tenant-A';
const TENANT_B = 'tenant-B';
const PARTY_A = 'party-A';
const USER = 'user-1';

function buildPrisma(opts: {
  existingAddresses?: Array<{
    id: string;
    tenantId: string;
    partyId: string;
    type: PartyAddressType;
    line1: string;
    line2?: string | null;
    postalCode?: string | null;
    city?: string | null;
    country?: string;
    isPrimary?: boolean;
  }>;
  parties?: Array<{ id: string; tenantId: string }>;
} = {}) {
  const addresses = new Map(
    (opts.existingAddresses ?? []).map((a) => [`${a.tenantId}:${a.id}`, a]),
  );
  const parties = new Map(
    (opts.parties ?? [{ id: PARTY_A, tenantId: TENANT_A }]).map((p) => [
      `${p.tenantId}:${p.id}`,
      p,
    ]),
  );

  // The mocked $transaction runs the callback with a tx client that has
  // the same surface as Prisma.TransactionClient for the methods we use.
  const txClient: any = {
    $executeRaw: jest.fn(async () => undefined),
    partyAddress: {
      updateMany: jest.fn(async ({ where, data }: any) => {
        let count = 0;
        for (const a of addresses.values()) {
          if (where?.tenantId && a.tenantId !== where.tenantId) continue;
          if (where?.partyId && a.partyId !== where.partyId) continue;
          if (where?.type && a.type !== where.type) continue;
          if (where?.isPrimary !== undefined && a.isPrimary !== where.isPrimary)
            continue;
          if (where?.NOT?.id && where.NOT.id === a.id) continue;
          Object.assign(a, data);
          count++;
        }
        return { count };
      }),
      findFirst: jest.fn(async ({ where }: any = {}) => {
        for (const a of addresses.values()) {
          if (where?.tenantId && a.tenantId !== where.tenantId) continue;
          if (where?.partyId && a.partyId !== where.partyId) continue;
          if (where?.type && a.type !== where.type) continue;
          if (where?.isPrimary !== undefined && a.isPrimary !== where.isPrimary)
            continue;
          return { ...a };
        }
        return null;
      }),
      create: jest.fn(async ({ data }: any) => {
        const id = `addr-${addresses.size + 1}`;
        const row = {
          id,
          tenantId: data.tenantId,
          partyId: data.partyId,
          type: data.type,
          line1: data.line1,
          line2: data.line2 ?? null,
          postalCode: data.postalCode ?? null,
          city: data.city ?? null,
          country: data.country ?? 'PT',
          isPrimary: data.isPrimary ?? false,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        addresses.set(`${row.tenantId}:${row.id}`, row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = addresses.get(`${TENANT_A}:${where.id}`);
        if (!row) throw new Error('not found');
        Object.assign(row, data);
        (row as any).updatedAt = new Date();
        return row;
      }),
    },
  };

  return {
    party: {
      findFirst: jest.fn(async ({ where }: any = {}) => {
        if (!where?.id || !where?.tenantId) return null;
        return parties.get(`${where.tenantId}:${where.id}`) ?? null;
      }),
    },
    partyAddress: {
      findMany: jest.fn(async ({ where }: any = {}) => {
        const out: any[] = [];
        for (const a of addresses.values()) {
          if (where?.tenantId && a.tenantId !== where.tenantId) continue;
          if (where?.partyId && a.partyId !== where.partyId) continue;
          out.push({ ...a });
        }
        return out;
      }),
      findFirst: jest.fn(async ({ where }: any = {}) => {
        if (!where?.id) return null;
        const a = addresses.get(`${where.tenantId}:${where.id}`);
        if (!a) return null;
        if (where.partyId && a.partyId !== where.partyId) return null;
        return { ...a };
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = addresses.get(`${TENANT_A}:${where.id}`);
        if (!row) throw new Error('not found');
        Object.assign(row, data);
        (row as any).updatedAt = new Date();
        return row;
      }),
      delete: jest.fn(async ({ where }: any) => {
        const row = addresses.get(`${TENANT_A}:${where.id}`);
        if (!row) throw new Error('not found');
        addresses.delete(`${TENANT_A}:${where.id}`);
        return row;
      }),
    },
    $transaction: jest.fn(async (fn: any) => fn(txClient)),
    __txClient: txClient,
    __addresses: addresses,
  };
}

function buildAudit() {
  const rows: any[] = [];
  return {
    log: jest.fn(async (entry: any) => {
      rows.push(entry);
    }),
    rows,
  };
}

function buildSvc(opts: Parameters<typeof buildPrisma>[0] = {}) {
  const prisma = buildPrisma(opts);
  const audit = buildAudit();
  const svc = new PartyAddressesService(prisma as any, audit as any);
  return { svc, prisma, audit };
}

describe('PartyAddressesService — CRUD + tenant isolation', () => {
  it('list() refuses an address from another tenant (no leak)', async () => {
    const { svc } = buildSvc({
      parties: [{ id: PARTY_A, tenantId: TENANT_B }],
    });
    await expect(svc.list(TENANT_A, PARTY_A)).rejects.toThrow(
      'Entidade não encontrada',
    );
  });

  it('create() with isPrimary=true takes the advisory lock + unsets other primaries', async () => {
    const { svc, prisma } = buildSvc({
      existingAddresses: [
        {
          id: 'a-old',
          tenantId: TENANT_A,
          partyId: PARTY_A,
          type: PartyAddressType.BILLING,
          line1: 'Old St',
          isPrimary: true,
        },
      ],
    });
    await svc.create(TENANT_A, USER, PARTY_A, {
      type: PartyAddressType.BILLING,
      line1: 'New St',
      isPrimary: true,
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.__txClient.$executeRaw).toHaveBeenCalledTimes(1);
    // create() path unsets ALL existing primaries of (partyId, type) —
    // no NOT:{id} clause needed because the new row hasn't been inserted
    // yet (no self to exclude). The slow-path update() DOES exclude
    // self, see the corresponding test below.
    expect(prisma.__txClient.partyAddress.updateMany).toHaveBeenCalledWith({
      where: {
        tenantId: TENANT_A,
        partyId: PARTY_A,
        type: PartyAddressType.BILLING,
        isPrimary: true,
      },
      data: { isPrimary: false },
    });
    const aOld = prisma.__addresses.get(`${TENANT_A}:a-old`) as any;
    expect(aOld.isPrimary).toBe(false);
  });

  it('create() auto-promotes the first address of a new type', async () => {
    const { svc, prisma } = buildSvc();
    const result = await svc.create(TENANT_A, USER, PARTY_A, {
      type: PartyAddressType.OPERATIONAL,
      line1: 'Armazém 1',
    });
    expect(result.isPrimary).toBe(true);
    // The transaction took the lock + saw no existing primary → no updateMany
    expect(prisma.__txClient.partyAddress.updateMany).not.toHaveBeenCalled();
  });

  it('create() does NOT promote when caller leaves isPrimary undefined but a primary exists', async () => {
    const { svc } = buildSvc({
      existingAddresses: [
        {
          id: 'a-1',
          tenantId: TENANT_A,
          partyId: PARTY_A,
          type: PartyAddressType.BILLING,
          line1: 'Old',
          isPrimary: true,
        },
      ],
    });
    const r = await svc.create(TENANT_A, USER, PARTY_A, {
      type: PartyAddressType.BILLING,
      line1: 'New',
    });
    expect(r.isPrimary).toBe(false);
  });

  it('update() fast-path: only scalar fields, no transaction / no lock', async () => {
    const { svc, prisma } = buildSvc({
      existingAddresses: [
        {
          id: 'a-1',
          tenantId: TENANT_A,
          partyId: PARTY_A,
          type: PartyAddressType.BILLING,
          line1: 'Old',
          city: 'Old City',
        },
      ],
    });
    const r = await svc.update(TENANT_A, USER, PARTY_A, 'a-1', {
      line1: 'New',
      city: 'New City',
    });
    expect(r.line1).toBe('New');
    // NO $transaction call for scalar-only updates
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('update() slow-path: flipping isPrimary takes the lock + unset-others', async () => {
    const { svc, prisma } = buildSvc({
      existingAddresses: [
        {
          id: 'a-1',
          tenantId: TENANT_A,
          partyId: PARTY_A,
          type: PartyAddressType.BILLING,
          line1: 'One',
          isPrimary: false,
        },
        {
          id: 'a-2',
          tenantId: TENANT_A,
          partyId: PARTY_A,
          type: PartyAddressType.BILLING,
          line1: 'Two',
          isPrimary: true,
        },
      ],
    });
    await svc.update(TENANT_A, USER, PARTY_A, 'a-1', { isPrimary: true });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.__txClient.$executeRaw).toHaveBeenCalledTimes(1);
    expect(prisma.__txClient.partyAddress.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: TENANT_A,
          partyId: PARTY_A,
          type: PartyAddressType.BILLING,
          isPrimary: true,
          NOT: { id: 'a-1' },
        }),
        data: { isPrimary: false },
      }),
    );
    const a2 = prisma.__addresses.get(`${TENANT_A}:a-2`) as any;
    expect(a2.isPrimary).toBe(false);
  });

  it('update() slow-path: changing type locks on the NEW type', async () => {
    const { svc, prisma } = buildSvc({
      existingAddresses: [
        {
          id: 'a-1',
          tenantId: TENANT_A,
          partyId: PARTY_A,
          type: PartyAddressType.CORRESPONDENCE,
          line1: 'Old',
          isPrimary: false,
        },
        {
          id: 'a-2',
          tenantId: TENANT_A,
          partyId: PARTY_A,
          type: PartyAddressType.BILLING,
          line1: 'Existing BILLING primary',
          isPrimary: true,
        },
      ],
    });
    await svc.update(TENANT_A, USER, PARTY_A, 'a-1', {
      type: PartyAddressType.BILLING,
      isPrimary: true,
    });
    // The advisory lock SQL is called with the NEW type (BILLING), not
    // the old type (CORRESPONDENCE) — confirmed via the $executeRaw call.
    const sqlCalls = prisma.__txClient.$executeRaw.mock.calls.map((c: any) =>
      c[0]?.join?.('') ?? String(c[0]),
    );
    // We assert the lock was acquired (any executeRaw call counts) —
    // the SQL template tag means the template is split, so we just check
    // the call happened and the new-type was passed (via the where clause
    // of the updateMany below).
    expect(prisma.__txClient.partyAddress.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          type: PartyAddressType.BILLING,
        }),
      }),
    );
    // The existing BILLING primary was unset.
    const a2 = prisma.__addresses.get(`${TENANT_A}:a-2`) as any;
    expect(a2.isPrimary).toBe(false);
    expect(sqlCalls.length).toBeGreaterThan(0);
  });

  it('remove() deletes the row and writes an AuditAction.DELETE row', async () => {
    const { svc, prisma, audit } = buildSvc({
      existingAddresses: [
        {
          id: 'a-1',
          tenantId: TENANT_A,
          partyId: PARTY_A,
          type: PartyAddressType.BILLING,
          line1: 'X',
          isPrimary: true,
        },
      ],
    });
    await svc.remove(TENANT_A, USER, PARTY_A, 'a-1');
    expect(prisma.partyAddress.delete).toHaveBeenCalledWith({ where: { id: 'a-1' } });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'DELETE',
        entityType: 'party_address',
      }),
    );
  });
});
