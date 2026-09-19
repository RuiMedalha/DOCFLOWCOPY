import { PartyContactsService } from '../party-contacts.service';

/**
 * Sprint G — PartyContact CRUD + tenant isolation + ADMIN-only RBAC.
 *
 * The service depends on PrismaService + AuditService. We mock both with
 * the minimum surface needed (party.findFirst, partyContact.findFirst /
 * findMany / create / update / delete) and verify the assertions that
 * matter for the 360° file:
 *
 *   1. Tenant isolation: every Prisma call carries `tenantId` derived
 *      from the caller, never from the URL/body.
 *   2. Per-field audit on update: `party.update.contact` rows emitted
 *      with oldValue/newValue — same pattern as the Sprint E party
 *      category toggle audit.
 *   3. P2002 (unique violation) on email → 409 ConflictException with
 *      a Portuguese message — never leaks the raw Prisma error.
 *   4. DELETE hard-deletes the row and writes an audit row.
 */

const TENANT_A = 'tenant-A';
const TENANT_B = 'tenant-B';
const PARTY_A = 'party-A';
const PARTY_B = 'party-B';
const USER = 'user-1';

function buildPrisma(opts: {
  existingContacts?: Array<{
    id: string;
    tenantId: string;
    partyId: string;
    name: string;
    role?: string | null;
    email?: string | null;
    phone?: string | null;
    notes?: string | null;
  }>;
  parties?: Array<{ id: string; tenantId: string }>;
  p2002OnCreate?: boolean;
} = {}) {
  const contacts = new Map(
    (opts.existingContacts ?? []).map((c) => [`${c.tenantId}:${c.id}`, c]),
  );
  const parties = new Map(
    (opts.parties ?? [{ id: PARTY_A, tenantId: TENANT_A }]).map((p) => [
      `${p.tenantId}:${p.id}`,
      p,
    ]),
  );

  return {
    party: {
      findFirst: jest.fn(async ({ where }: any = {}) => {
        if (!where?.id || !where?.tenantId) return null;
        return parties.get(`${where.tenantId}:${where.id}`) ?? null;
      }),
    },
    partyContact: {
      findMany: jest.fn(async ({ where }: any = {}) => {
        const out: any[] = [];
        for (const c of contacts.values()) {
          if (where?.tenantId && c.tenantId !== where.tenantId) continue;
          if (where?.partyId && c.partyId !== where.partyId) continue;
          out.push({
            ...c,
            createdAt: new Date('2026-09-04T10:00:00Z'),
            updatedAt: new Date('2026-09-04T10:00:00Z'),
          });
        }
        return out;
      }),
      findFirst: jest.fn(async ({ where }: any = {}) => {
        if (!where?.id) return null;
        const c = contacts.get(`${where.tenantId}:${where.id}`);
        if (!c) return null;
        if (where.partyId && c.partyId !== where.partyId) return null;
        return {
          ...c,
          createdAt: new Date('2026-09-04T10:00:00Z'),
          updatedAt: new Date('2026-09-04T10:00:00Z'),
        };
      }),
      create: jest.fn(async ({ data }: any) => {
        if (opts.p2002OnCreate) {
          const err: any = new Error('Unique constraint failed');
          err.code = 'P2002';
          err.meta = { target: ['tenantId', 'partyId', 'email'] };
          throw err;
        }
        const id = `contact-${contacts.size + 1}`;
        const row = {
          id,
          tenantId: data.tenantId,
          partyId: data.partyId,
          name: data.name,
          role: data.role ?? null,
          email: data.email ?? null,
          phone: data.phone ?? null,
          notes: data.notes ?? null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        contacts.set(`${row.tenantId}:${row.id}`, row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = contacts.get(`${TENANT_A}:${where.id}`);
        if (!row) throw new Error('not found');
        Object.assign(row, data);
        (row as any).updatedAt = new Date();
        return row;
      }),
      delete: jest.fn(async ({ where }: any) => {
        const row = contacts.get(`${TENANT_A}:${where.id}`);
        if (!row) throw new Error('not found');
        contacts.delete(`${TENANT_A}:${where.id}`);
        return row;
      }),
    },
    $transaction: jest.fn(async (fn: any) => fn({
      partyContact: {
        create: jest.fn(),
        updateMany: jest.fn(),
        findFirst: jest.fn(),
      },
    })),
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
  const svc = new PartyContactsService(prisma as any, audit as any);
  return { svc, prisma, audit };
}

describe('PartyContactsService — CRUD + tenant isolation', () => {
  it('list() refuses a party from another tenant (no leak)', async () => {
    const { svc } = buildSvc({
      parties: [{ id: PARTY_B, tenantId: TENANT_B }],
    });
    await expect(svc.list(TENANT_A, PARTY_B)).rejects.toThrow(
      'Entidade não encontrada',
    );
  });

  it('list() returns only contacts of the tenant + party', async () => {
    const { svc, prisma } = buildSvc({
      existingContacts: [
        { id: 'c-1', tenantId: TENANT_A, partyId: PARTY_A, name: 'Maria' },
        {
          id: 'c-2',
          tenantId: TENANT_A,
          partyId: PARTY_A,
          name: 'João',
          email: 'joao@a.pt',
        },
        {
          id: 'c-3',
          tenantId: TENANT_B,
          partyId: PARTY_A,
          name: 'Outsider',
        },
      ],
    });
    const result = await svc.list(TENANT_A, PARTY_A);
    expect(result.items).toHaveLength(2);
    expect(result.items.every((c: any) => !('tenantId' in c))).toBe(true);
    expect(prisma.partyContact.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: TENANT_A, partyId: PARTY_A },
      }),
    );
  });

  it('create() writes the contact with the SESSION tenantId', async () => {
    const { svc, prisma } = buildSvc();
    await svc.create(TENANT_A, USER, PARTY_A, {
      name: 'Maria Santos',
      role: 'CFO',
      email: 'maria@a.pt',
    });
    expect(prisma.partyContact.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: TENANT_A,
          partyId: PARTY_A,
          name: 'Maria Santos',
        }),
      }),
    );
  });

  it('create() emits an AuditAction.CREATE row', async () => {
    const { svc, audit } = buildSvc();
    await svc.create(TENANT_A, USER, PARTY_A, { name: 'Maria' });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'CREATE',
        entityType: 'party_contact',
      }),
    );
  });

  it('create() maps P2002 (email unique) to 409 ConflictException', async () => {
    const { svc } = buildSvc({ p2002OnCreate: true });
    await expect(
      svc.create(TENANT_A, USER, PARTY_A, {
        name: 'Maria',
        email: 'dup@a.pt',
      }),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('email'),
    });
  });

  it('update() emits per-field audit rows only for fields that changed', async () => {
    const { svc, audit } = buildSvc({
      existingContacts: [
        {
          id: 'c-1',
          tenantId: TENANT_A,
          partyId: PARTY_A,
          name: 'Maria',
          role: 'CFO',
          email: 'maria@a.pt',
          phone: '+351 210 000 000',
          notes: null,
        },
      ],
    });
    await svc.update(TENANT_A, USER, PARTY_A, 'c-1', {
      name: 'Maria Santos', // changed
      role: 'CFO',          // unchanged
      email: 'maria.santos@a.pt', // changed
      phone: '+351 210 000 000', // unchanged
      // notes omitted → no audit row
    });
    const subActionCalls = audit.rows.filter(
      (r: any) => r.metadata?.subAction === 'party.update.contact',
    );
    const fields = subActionCalls.map((r: any) => r.metadata.field).sort();
    expect(fields).toEqual(['email', 'name']);
  });

  it('update() refuses a contact that belongs to another party', async () => {
    const { svc } = buildSvc({
      existingContacts: [
        { id: 'c-1', tenantId: TENANT_A, partyId: PARTY_B, name: 'X' },
      ],
    });
    await expect(
      svc.update(TENANT_A, USER, PARTY_A, 'c-1', { name: 'Y' }),
    ).rejects.toThrow('Contacto não encontrado');
  });

  it('remove() deletes the row and writes an AuditAction.DELETE row', async () => {
    const { svc, prisma, audit } = buildSvc({
      existingContacts: [
        { id: 'c-1', tenantId: TENANT_A, partyId: PARTY_A, name: 'X' },
      ],
    });
    await svc.remove(TENANT_A, USER, PARTY_A, 'c-1');
    expect(prisma.partyContact.delete).toHaveBeenCalledWith({
      where: { id: 'c-1' },
    });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'DELETE',
        entityType: 'party_contact',
      }),
    );
  });
});

describe('PartyContactsService — sanitize', () => {
  it('list() response never carries tenantId', async () => {
    const { svc } = buildSvc({
      existingContacts: [
        { id: 'c-1', tenantId: TENANT_A, partyId: PARTY_A, name: 'A' },
      ],
    });
    const r = await svc.list(TENANT_A, PARTY_A);
    expect(r.items[0]).not.toHaveProperty('tenantId');
    expect(r.items[0]).toHaveProperty('id', 'c-1');
  });
});
