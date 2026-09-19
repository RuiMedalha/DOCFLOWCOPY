import { AuditAction } from '@prisma/client';
import { PartyTimelineService } from '../timeline/party-timeline.service';

/**
 * Sprint G — Timeline cursor correctness.
 *
 * The cursor is composite: base64url(`<iso>|<id>`). It must:
 *   1. NEVER skip events — the page after cursor X must contain
 *      EVERY event strictly older than X.
 *   2. NEVER duplicate events — the same id cannot appear on two
 *      pages.
 *   3. End correctly: when `nextCursor` is null on the last page,
 *      no further events exist.
 *   4. Survive same-ms events: two events with the SAME timestamp
 *      but different ids must BOTH surface across the cursor walk.
 *
 * The mocks simulate the per-source pagination: each source returns
 * `take` rows; the service merges, sorts, and slices the merged
 * result. To exercise the cursor, we pre-seed enough events to fill
 * multiple pages and then walk the cursor.
 */

const TENANT_A = 'tenant-A';
const PARTY_A = 'party-A';

function buildPrisma(opts: {
  /** when provided, return only rows whose createdAt is < cursor */
  audits: Array<{ id: string; createdAt: Date }>;
  /** when provided, return only rows whose dueDate is < cursor */
  payments: Array<{ id: string; dueDate: Date; document: { id: string; partyId: string; tenantId: string; docNumber: string } }>;
  ibans: Array<{ id: string; createdAt: Date }>;
  approvedDocs: Array<{ id: string; approvedAt: Date }>;
}) {
  return {
    // Sprint G review §A2: assertPartyInTenant guard runs before the
    // 4-source aggregation. The mock MUST return a party for the common
    // case (TENANT_A + PARTY_A) so the guard doesn't fail these tests.
    party: {
      findFirst: jest.fn(async ({ where }: any = {}) => {
        if (where?.id === PARTY_A && where?.tenantId === TENANT_A) {
          return { id: PARTY_A };
        }
        return null;
      }),
    },
    auditLog: {
      findMany: jest.fn(async ({ where }: any = {}) => {
        // NB: the mock returns ALL matching rows — the service is
        // responsible for slicing to the page size AFTER merging across
        // sources (this gives a balanced view rather than source-by-source
        // page boundaries). See PartyTimelineService.list for the
        // `events.slice(0, safeLimit)` step.
        let rows = opts.audits.slice();
        // The service wraps the cursor in OR [{ts:{lt}}, {AND:[{ts:eq},{id:{lt}}]}]
        const cursorOr = where?.OR as Array<any> | undefined;
        if (cursorOr) {
          rows = rows.filter((r) =>
            cursorOr.some((branch) => {
              if (branch?.createdAt?.lt !== undefined) {
                return r.createdAt.getTime() < new Date(branch.createdAt.lt).getTime();
              }
              if (branch?.AND) {
                const tsClause = branch.AND.find((c: any) => 'createdAt' in c);
                const idClause = branch.AND.find((c: any) => 'id' in c);
                if (
                  tsClause &&
                  r.createdAt.getTime() === new Date(tsClause.createdAt).getTime() &&
                  idClause &&
                  r.id < idClause.id.lt
                )
                  return true;
              }
              return false;
            }),
          );
        }
        rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
        return rows.map((r) => ({
          id: r.id,
          tenantId: TENANT_A,
          userId: 'user-1',
          action: AuditAction.EDIT,
          entityType: 'party',
          entityId: PARTY_A,
          metadata: {},
          createdAt: r.createdAt,
        }));
      }),
    },
    paymentEvent: {
      findMany: jest.fn(async ({ where }: any = {}) => {
        let rows = opts.payments.slice();
        if (where?.dueDate?.lt) {
          const cursor = new Date(where.dueDate.lt).getTime();
          rows = rows.filter((r) => r.dueDate.getTime() < cursor);
        }
        rows.sort((a, b) => (a.dueDate < b.dueDate ? 1 : -1));
        return rows.map((r) => ({
          id: r.id,
          tenantId: TENANT_A,
          documentId: r.document.id,
          dueDate: r.dueDate,
          amount: { toString: () => '10.00' },
          status: 'PENDING',
          paidAt: null,
          paidAmount: null,
          paymentMethod: null,
          notes: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          document: { id: r.document.id, docNumber: r.document.docNumber, fileKey: 'k' },
        }));
      }),
    },
    ibanHistory: {
      findMany: jest.fn(async ({ where }: any = {}) => {
        let rows = opts.ibans.slice();
        if (where?.createdAt?.lt) {
          const cursor = new Date(where.createdAt.lt).getTime();
          rows = rows.filter((r) => r.createdAt.getTime() < cursor);
        }
        rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
        return rows.map((r) => ({
          id: r.id,
          tenantId: TENANT_A,
          partyId: PARTY_A,
          oldIban: null,
          newIban: 'PT50000201231234567890154',
          changedById: 'user-1',
          reason: 'iban_change',
          verified: false,
          createdAt: r.createdAt,
        }));
      }),
    },
    document: {
      findMany: jest.fn(async ({ where }: any = {}) => {
        let rows = opts.approvedDocs.slice();
        if (where?.approvedAt?.lt) {
          const cursor = new Date(where.approvedAt.lt).getTime();
          rows = rows.filter((r) => r.approvedAt.getTime() < cursor);
        }
        rows.sort((a, b) => (a.approvedAt < b.approvedAt ? 1 : -1));
        return rows.map((r) => ({
          id: r.id,
          fileName: 'invoice.pdf',
          docNumber: 'D-1',
          approvedAt: r.approvedAt,
          approvedById: 'user-1',
        }));
      }),
    },
  };
}

describe('PartyTimelineService — cursor walk does not skip or duplicate', () => {
  it('walks all events across multiple pages and reaches null cursor', async () => {
    // 30 audit events spread across 6 hours so we can paginate.
    const audits = Array.from({ length: 30 }, (_, i) => ({
      id: `a-${i.toString().padStart(2, '0')}`,
      createdAt: new Date(`2026-09-04T${String(Math.floor(i / 5)).padStart(2, '0')}:${String((i % 5) * 12).padStart(2, '0')}:00Z`),
    }));
    const prisma = buildPrisma({ audits, payments: [], ibans: [], approvedDocs: [] });
    const svc = new PartyTimelineService(prisma as any);

    const seen: string[] = [];
    let cursor: string | undefined = undefined;
    let iterations = 0;
    while (iterations++ < 100) {
      const page = await svc.list(TENANT_A, PARTY_A, cursor, 7);
      for (const e of page.items) seen.push(e.id);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(seen).toHaveLength(30);
    expect(new Set(seen).size).toBe(30); // no duplicates
    // Order: most-recent-first by createdAt
    expect(seen[0]).toBe('a-29');
    expect(seen[29]).toBe('a-00');
  });

  it('two events with the same timestamp + different ids both surface', async () => {
    const sameTs = new Date('2026-09-04T10:00:00Z');
    const audits = [
      { id: 'a-A', createdAt: sameTs },
      { id: 'a-B', createdAt: sameTs },
    ];
    const prisma = buildPrisma({ audits, payments: [], ibans: [], approvedDocs: [] });
    const svc = new PartyTimelineService(prisma as any);
    const r1 = await svc.list(TENANT_A, PARTY_A, undefined, 1);
    expect(r1.items).toHaveLength(1);
    expect(r1.nextCursor).not.toBeNull();
    const r2 = await svc.list(TENANT_A, PARTY_A, r1.nextCursor as string, 1);
    expect(r2.items).toHaveLength(1);
    expect(r2.items[0].id).not.toBe(r1.items[0].id);
    // No duplication across pages
    expect(r1.items[0].id).not.toBe(r2.items[0].id);
    const r3 = await svc.list(TENANT_A, PARTY_A, r2.nextCursor as string, 1);
    expect(r3.items).toHaveLength(0);
    expect(r3.nextCursor).toBeNull();
  });

  it('cursor + same-ms event: tie-break by id desc keeps ordering deterministic', async () => {
    const ts = new Date('2026-09-04T10:00:00Z');
    const audits = [
      { id: 'a-1', createdAt: ts },
      { id: 'a-2', createdAt: ts },
      { id: 'a-3', createdAt: ts },
    ];
    const prisma = buildPrisma({ audits, payments: [], ibans: [], approvedDocs: [] });
    const svc = new PartyTimelineService(prisma as any);
    const r1 = await svc.list(TENANT_A, PARTY_A, undefined, 2);
    expect(r1.items.map((e: any) => e.id)).toEqual(['a-3', 'a-2']);
    const r2 = await svc.list(TENANT_A, PARTY_A, r1.nextCursor as string, 2);
    expect(r2.items.map((e: any) => e.id)).toEqual(['a-1']);
    expect(r2.nextCursor).toBeNull();
  });

  it('invalid cursor falls back to "first page" semantics', async () => {
    const audits = [
      { id: 'a-1', createdAt: new Date('2026-09-04T10:00:00Z') },
      { id: 'a-2', createdAt: new Date('2026-09-04T11:00:00Z') },
    ];
    const prisma = buildPrisma({ audits, payments: [], ibans: [], approvedDocs: [] });
    const svc = new PartyTimelineService(prisma as any);
    const r = await svc.list(TENANT_A, PARTY_A, 'this-is-not-a-valid-base64-cursor', 10);
    expect(r.items).toHaveLength(2); // both events visible — invalid cursor → no filter
  });
});
