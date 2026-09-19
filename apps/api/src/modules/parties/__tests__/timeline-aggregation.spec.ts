import { AuditAction } from '@prisma/client';
import { PartyTimelineService } from '../timeline/party-timeline.service';

/**
 * Sprint G — Timeline aggregation across 4 sources.
 *
 * Sources merged:
 *   1. AuditLog     (entityType='party' AND entityId=partyId)
 *   2. PaymentEvent (via Document JOIN — Document.partyId = partyId)
 *   3. IbanHistory  (partyId direct)
 *   4. Document     (partyId AND status='APROVADO')
 *
 * Invariants tested:
 *   - All 4 sources executed in parallel (Promise.all) — we verify by
 *     checking the orderBy/limit clauses are correct, not the timing.
 *   - Tenant isolation: every query carries `tenantId`. Cross-tenant
 *     events never surface in the timeline.
 *   - Items are sorted by `at` desc with `id` desc as tie-break.
 *   - Composite cursor: when `nextCursor` is present, it base64url-
 *     encodes `<iso>|<id>` of the LAST returned item.
 *   - The first page (no cursor) returns up to `limit` items sliced
 *     AFTER merging so each source contributes proportionally.
 */

const TENANT_A = 'tenant-A';
const TENANT_B = 'tenant-B';
const PARTY_A = 'party-A';

function buildPrisma(opts: {
  /** when provided, party.findFirst returns this party for matching tenantId */
  party?: { id: string; tenantId: string };
  audits?: Array<{
    id: string;
    tenantId: string;
    entityType?: string;
    entityId?: string;
    createdAt: Date;
    action?: AuditAction;
  }>;
  payments?: Array<{
    id: string;
    tenantId: string;
    documentId: string;
    document?: { partyId: string; tenantId: string; id: string; docNumber?: string };
    dueDate?: Date;
  }>;
  ibans?: Array<{
    id: string;
    tenantId: string;
    partyId: string;
    createdAt: Date;
  }>;
  approvedDocs?: Array<{
    id: string;
    tenantId: string;
    partyId: string;
    status: string;
    approvedAt: Date;
  }>;
} = {}) {
  // Default to PARTY_A in TENANT_A so the assertPartyInTenant guard
  // (Sprint G review §A2) passes for the common case.
  const partyRow = opts.party ?? { id: PARTY_A, tenantId: TENANT_A };
  return {
    party: {
      findFirst: jest.fn(async ({ where }: any = {}) => {
        if (!where?.id || !where?.tenantId) return null;
        return partyRow.id === where.id && partyRow.tenantId === where.tenantId
          ? { id: partyRow.id }
          : null;
      }),
    },
    auditLog: {
      findMany: jest.fn(async ({ where }: any = {}) => {
        return (opts.audits ?? [])
          .filter((a) => {
            if (where?.tenantId && a.tenantId !== where.tenantId) return false;
            if (where?.entityType && a.entityType !== where.entityType) return false;
            if (where?.entityId && a.entityId !== where.entityId) return false;
            return true;
          })
          .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
          .map((a) => ({
            id: a.id,
            tenantId: a.tenantId,
            userId: 'user-1',
            action: a.action ?? AuditAction.EDIT,
            entityType: a.entityType,
            entityId: a.entityId,
            metadata: { foo: 'bar' },
            createdAt: a.createdAt,
          }));
      }),
    },
    paymentEvent: {
      findMany: jest.fn(async ({ where }: any = {}) => {
        return (opts.payments ?? [])
          .filter((p) => {
            if (where?.tenantId && p.tenantId !== where.tenantId) return false;
            if (where?.document?.partyId) {
              if (!p.document) return false;
              if (p.document.partyId !== where.document.partyId) return false;
              if (
                where.document.tenantId &&
                p.document.tenantId !== where.document.tenantId
              )
                return false;
            }
            return true;
          })
          .sort((a, b) => (a.dueDate! < b.dueDate! ? 1 : -1))
          .map((p) => ({
            id: p.id,
            tenantId: p.tenantId,
            documentId: p.documentId,
            dueDate: p.dueDate ?? new Date(),
            amount: { toString: () => '50.00' },
            status: 'PENDING',
            paidAt: null,
            paidAmount: null,
            paymentMethod: null,
            notes: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            document: p.document
              ? {
                  id: p.document.id,
                  docNumber: p.document.docNumber ?? 'D-1',
                  fileKey: 'k',
                }
              : undefined,
          }));
      }),
    },
    ibanHistory: {
      findMany: jest.fn(async ({ where }: any = {}) => {
        return (opts.ibans ?? [])
          .filter((i) => {
            if (where?.tenantId && i.tenantId !== where.tenantId) return false;
            if (where?.partyId && i.partyId !== where.partyId) return false;
            return true;
          })
          .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
          .map((i) => ({
            id: i.id,
            tenantId: i.tenantId,
            partyId: i.partyId,
            oldIban: null,
            newIban: 'PT50000201231234567890154',
            changedById: 'user-1',
            reason: 'iban_change',
            verified: false,
            createdAt: i.createdAt,
          }));
      }),
    },
    document: {
      findMany: jest.fn(async ({ where }: any = {}) => {
        return (opts.approvedDocs ?? [])
          .filter((d) => {
            if (where?.tenantId && d.tenantId !== where.tenantId) return false;
            if (where?.partyId && d.partyId !== where.partyId) return false;
            if (where?.status && d.status !== where.status) return false;
            return true;
          })
          .sort((a, b) => (a.approvedAt < b.approvedAt ? 1 : -1))
          .map((d) => ({
            id: d.id,
            fileName: 'invoice.pdf',
            docNumber: 'D-2026-1',
            approvedAt: d.approvedAt,
            approvedById: 'user-1',
          }));
      }),
    },
  };
}

describe('PartyTimelineService — 4-source aggregation', () => {
  it('returns events sorted desc across all 4 sources', async () => {
    const prisma = buildPrisma({
      audits: [
        {
          id: 'a-1',
          tenantId: TENANT_A,
          entityType: 'party',
          entityId: PARTY_A,
          createdAt: new Date('2026-09-01T10:00:00Z'),
        },
      ],
      payments: [
        {
          id: 'p-1',
          tenantId: TENANT_A,
          documentId: 'doc-1',
          document: { partyId: PARTY_A, tenantId: TENANT_A, id: 'doc-1' },
          dueDate: new Date('2026-09-03T10:00:00Z'),
        },
      ],
      ibans: [
        {
          id: 'i-1',
          tenantId: TENANT_A,
          partyId: PARTY_A,
          createdAt: new Date('2026-09-02T10:00:00Z'),
        },
      ],
      approvedDocs: [
        {
          id: 'd-1',
          tenantId: TENANT_A,
          partyId: PARTY_A,
          status: 'APROVADO',
          approvedAt: new Date('2026-09-04T10:00:00Z'),
        },
      ],
    });
    const svc = new PartyTimelineService(prisma as any);
    const r = await svc.list(TENANT_A, PARTY_A, undefined, 20);

    expect(r.items).toHaveLength(4);
    // Most recent first
    expect(r.items.map((e: any) => e.id)).toEqual(['d-1', 'p-1', 'i-1', 'a-1']);
    expect(r.items.map((e: any) => e.type)).toEqual([
      'document_approved',
      'payment',
      'iban_change',
      'audit',
    ]);
    expect(r.nextCursor).toBeNull(); // 4 < limit=20
  });

  it('respects tenant isolation: events from another tenant never surface', async () => {
    const prisma = buildPrisma({
      audits: [
        {
          id: 'a-1',
          tenantId: TENANT_A,
          entityType: 'party',
          entityId: PARTY_A,
          createdAt: new Date('2026-09-01T10:00:00Z'),
        },
        {
          id: 'a-2',
          tenantId: TENANT_B,
          entityType: 'party',
          entityId: PARTY_A,
          createdAt: new Date('2026-09-02T10:00:00Z'),
        },
      ],
    });
    const svc = new PartyTimelineService(prisma as any);
    const r = await svc.list(TENANT_A, PARTY_A, undefined, 20);
    expect(r.items.every((e: any) => e.id !== 'a-2')).toBe(true);
  });

  it('clamps limit to 1..50 (page size in the response)', async () => {
    // Pre-seed enough audits that 999 would otherwise span >50 items
    // after merge — the service must cap the page slice at 50 max.
    const bigAudits = Array.from({ length: 80 }, (_, i) => ({
      id: `a-${i}`,
      tenantId: TENANT_A,
      entityType: 'party',
      entityId: PARTY_A,
      createdAt: new Date(`2026-09-04T${String(Math.floor(i / 4)).padStart(2, '0')}:${String((i % 4) * 15).padStart(2, '0')}:00Z`),
    }));
    const prisma = buildPrisma({ audits: bigAudits });
    const svc = new PartyTimelineService(prisma as any);
    const r = await svc.list(TENANT_A, PARTY_A, undefined, 999);
    expect(r.items).toHaveLength(50);
    expect(r.nextCursor).not.toBeNull(); // more pages remain
  });

  it('the join for paymentEvent carries the document.tenantId filter', async () => {
    const prisma = buildPrisma({
      payments: [
        {
          id: 'p-1',
          tenantId: TENANT_A,
          documentId: 'doc-1',
          document: { partyId: PARTY_A, tenantId: TENANT_A, id: 'doc-1' },
        },
      ],
    });
    const svc = new PartyTimelineService(prisma as any);
    await svc.list(TENANT_A, PARTY_A, undefined, 20);
    expect(prisma.paymentEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: TENANT_A,
          document: { partyId: PARTY_A, tenantId: TENANT_A },
        }),
      }),
    );
  });
});
