import { PartyPaymentsService } from '../payments/party-payments.service';

/**
 * Sprint G — GET /parties/:id/payments JOIN via Document.partyId.
 *
 * The non-trivial bits:
 *   1. Tenant isolation: every query carries `tenantId` AND the
 *      `document.tenantId` filter. A payment event whose document
 *      points at a party in another tenant is invisible.
 *   2. Cursor pagination: cursor=lastId, take=limit, skip=1 on cursor.
 *   3. Default + bounded limit (1..50).
 */

const TENANT_A = 'tenant-A';
const TENANT_B = 'tenant-B';
const PARTY_A = 'party-A';

function buildPrisma(opts: {
  events?: Array<{
    id: string;
    tenantId: string;
    documentId: string;
    document?: { partyId: string; tenantId: string };
    dueDate?: Date;
  }>;
} = {}) {
  const events = new Map((opts.events ?? []).map((e) => [e.id, e]));
  return {
    // Sprint G review §A2: assertPartyInTenant guard runs before the
    // JOIN query. The mock returns PARTY_A in TENANT_A so the guard
    // passes for the common test cases.
    party: {
      findFirst: jest.fn(async ({ where }: any = {}) => {
        if (where?.id === PARTY_A && where?.tenantId === TENANT_A) {
          return { id: PARTY_A };
        }
        return null;
      }),
    },
    paymentEvent: {
      findMany: jest.fn(
        async ({
          where,
          include,
          orderBy,
          take,
          cursor,
          skip,
        }: any = {}) => {
          let out: any[] = [];
          for (const e of events.values()) {
            if (where?.tenantId && e.tenantId !== where.tenantId) continue;
            if (where?.document?.partyId) {
              if (!e.document) continue;
              if (e.document.partyId !== where.document.partyId) continue;
              if (where.document.tenantId && e.document.tenantId !== where.document.tenantId)
                continue;
            }
            out.push({
              id: e.id,
              tenantId: e.tenantId,
              documentId: e.documentId,
              dueDate: e.dueDate ?? new Date(),
              amount: { toString: () => '123.45' },
              status: 'PENDING',
              paidAt: null,
              paidAmount: null,
              paymentMethod: null,
              notes: null,
              createdAt: new Date(),
              updatedAt: new Date(),
              document: e.document
                ? { id: 'doc-1', docNumber: 'DOC 1', fileKey: 'k' }
                : undefined,
            });
          }
          // Mirror Prisma's orderBy semantics: array of {field: 'asc'|'desc'}
          // applied as a multi-key sort — the secondary clause only acts
          // as a tie-break when the primary fields are EQUAL. A naive
          // sequential sort would re-shuffle the primary order based on
          // the secondary clause even when the primary already ordered
          // the rows. The combined comparator below bails out on the
          // first clause where the keys differ, exactly like SQL
          // ORDER BY col1, col2.
          if (orderBy && Array.isArray(orderBy)) {
            const clauses = orderBy.map((clause: any) => {
              const field = Object.keys(clause)[0];
              const dir = clause[field];
              return { field, dir };
            });
            out.sort((a, b) => {
              for (const { field, dir } of clauses) {
                const av = (a as any)[field];
                const bv = (b as any)[field];
                if (av === bv) continue;
                return dir === 'asc' ? (av < bv ? -1 : 1) : av < bv ? 1 : -1;
              }
              return 0;
            });
          }
          if (cursor?.id) {
            const idx = out.findIndex((r) => r.id === cursor.id);
            if (idx >= 0) out = out.slice(idx + 1);
          }
          if (typeof take === 'number') out = out.slice(0, take);
          return out;
        },
      ),
    },
  };
}

describe('PartyPaymentsService — JOIN via Document.partyId', () => {
  it('returns only events whose document belongs to the party + tenant', async () => {
    const prisma = buildPrisma({
      events: [
        {
          id: 'ev-1',
          tenantId: TENANT_A,
          documentId: 'doc-1',
          document: { partyId: PARTY_A, tenantId: TENANT_A },
        },
        {
          id: 'ev-2',
          tenantId: TENANT_A,
          documentId: 'doc-2',
          document: { partyId: 'party-other', tenantId: TENANT_A },
        },
        {
          id: 'ev-3',
          tenantId: TENANT_A,
          documentId: 'doc-3',
          document: { partyId: PARTY_A, tenantId: TENANT_B }, // cross-tenant doc
        },
        {
          id: 'ev-4',
          tenantId: TENANT_B,
          documentId: 'doc-4',
          document: { partyId: PARTY_A, tenantId: TENANT_B },
        },
      ],
    });
    const svc = new PartyPaymentsService(prisma as any);
    const r = await svc.list(TENANT_A, PARTY_A, undefined, 50);
    expect(r.items.map((i: any) => i.id)).toEqual(['ev-1']);
    // The query MUST carry the document JOIN + tenant scope
    expect(prisma.paymentEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: TENANT_A,
          document: { partyId: PARTY_A, tenantId: TENANT_A },
        }),
        take: 50,
      }),
    );
  });

  it('clamps limit to 1..50', async () => {
    const prisma = buildPrisma();
    const svc = new PartyPaymentsService(prisma as any);
    await svc.list(TENANT_A, PARTY_A, undefined, 999);
    expect(prisma.paymentEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 50 }),
    );
    await svc.list(TENANT_A, PARTY_A, undefined, 0);
    expect(prisma.paymentEvent.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ take: 1 }),
    );
  });

  it('uses cursor-based pagination', async () => {
    const prisma = buildPrisma({
      events: [
        {
          id: 'ev-1',
          tenantId: TENANT_A,
          documentId: 'doc-1',
          document: { partyId: PARTY_A, tenantId: TENANT_A },
        },
        {
          id: 'ev-2',
          tenantId: TENANT_A,
          documentId: 'doc-2',
          document: { partyId: PARTY_A, tenantId: TENANT_A },
        },
      ],
    });
    const svc = new PartyPaymentsService(prisma as any);
    await svc.list(TENANT_A, PARTY_A, 'ev-1', 20);
    expect(prisma.paymentEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        cursor: { id: 'ev-1' },
        skip: 1,
        take: 20,
      }),
    );
  });

  it('nextCursor is null when fewer rows than limit', async () => {
    const prisma = buildPrisma({
      events: [
        {
          id: 'ev-1',
          tenantId: TENANT_A,
          documentId: 'doc-1',
          document: { partyId: PARTY_A, tenantId: TENANT_A },
        },
      ],
    });
    const svc = new PartyPaymentsService(prisma as any);
    const r = await svc.list(TENANT_A, PARTY_A, undefined, 20);
    expect(r.nextCursor).toBeNull();
  });

  it('nextCursor is the last row id when the page is full', async () => {
    const prisma = buildPrisma({
      events: [
        {
          id: 'ev-1',
          tenantId: TENANT_A,
          documentId: 'doc-1',
          document: { partyId: PARTY_A, tenantId: TENANT_A },
          dueDate: new Date('2026-09-04T11:00:00Z'),
        },
        {
          id: 'ev-2',
          tenantId: TENANT_A,
          documentId: 'doc-2',
          document: { partyId: PARTY_A, tenantId: TENANT_A },
          dueDate: new Date('2026-09-04T10:00:00Z'),
        },
      ],
    });
    const svc = new PartyPaymentsService(prisma as any);
    const r = await svc.list(TENANT_A, PARTY_A, undefined, 2);
    // ev-1 dueDate > ev-2 dueDate → ev-1 first. Page full → nextCursor
    // = last item id = 'ev-2'.
    expect(r.nextCursor).toBe('ev-2');
  });
});
