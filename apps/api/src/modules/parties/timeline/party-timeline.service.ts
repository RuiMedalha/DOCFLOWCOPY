import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { TimelineEvent } from './party-timeline.dto';

/**
 * PartyTimelineService — read-only aggregation of events that touched a
 * party, across 4 distinct sources:
 *
 *   1. AuditLog         (entityType='party' AND entityId=partyId)
 *   2. PaymentEvent     (via Document JOIN — Document.partyId = partyId)
 *   3. IbanHistory      (partyId direct)
 *   4. Document         (partyId AND status='APROVADO')
 *
 * Each source has its own native timestamp (audit.createdAt,
 * paymentEvent.createdAt, iban.createdAt, document.approvedAt). We map
 * each to a uniform `at: ISO` field on the TimelineEvent DTO, then merge
 * + sort desc + paginate by composite cursor.
 *
 * Composite cursor — `at` (ISO) + `id` (cuid) — defends against two
 * events with the same timestamp landing on opposite pages. Naive
 * single-timestamp cursor can lose OR duplicate events when the DB
 * returns more than one event with the same ms timestamp. Cursor format:
 *
 *     base64(`<iso>|<id>`)
 *
 * On the next request, we split + use it to filter:
 *
 *     - keep events strictly older than `at` (createdAt / dueDate / approvedAt)
 *     - OR events at the exact same `at` but with id lexicographically < cursorId
 *
 * The composite cursor is overkill for most parties (< 100 events total)
 * but correct under race-conditions and high-volume tenants.
 */
@Injectable()
export class PartyTimelineService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * GET /parties/:partyId/timeline?cursor=&limit=20
   *
   * Pulls ALL matching rows from each of the 4 sources independently
   * (Promise.all for parallel execution), normalises, merges, sorts,
   * then slices the merged result down to `limit` and computes the
   * composite cursor from the last kept item.
   *
   * Note: each source query is intentionally NOT capped with the page
   * limit. Capping per source would produce unbalanced pages — e.g. if
   * one source has 100 events and the others have 5, capping per source
   * to 20 would let the dominant source monopolise the page. Fetching
   * all matching rows + slicing after merge gives a balanced view across
   * sources. A defensive per-source cap of 200 keeps the worst case
   * bounded for very busy tenants.
   */
  async list(
    tenantId: string,
    partyId: string,
    cursor?: string,
    limit = 20,
  ) {
    // Security fix-up (Sprint G review §A2): assert party belongs to
    // tenant BEFORE running the 4-source aggregation. Mirrors the
    // assertPartyInTenant guard in party-contacts / party-addresses
    // services — closes the parity gap where timeline/payments used to
    // return 200 + empty array for a cross-tenant partyId (an
    // information-disclosure asymmetry vs the other party endpoints).
    const party = await this.prisma.party.findFirst({
      where: { id: partyId, tenantId },
      select: { id: true },
    });
    if (!party) throw new NotFoundException('Entidade não encontrada');

    const safeLimit = Math.min(Math.max(limit, 1), 50);
    const parsedCursor = cursor ? this.decodeCursor(cursor) : null;

    // Build a where-clause with the composite cursor applied. We use
    // the source's native timestamp column plus the id column for the
    // tie-breaker: rows strictly older than the cursor's timestamp,
    // OR at the same timestamp but with id lexicographically < cursor's id.
    // Without the OR branch, two events sharing the same millisecond
    // would both be returned on every page or skipped entirely.
    const cursorWhere = (tsField: 'createdAt' | 'dueDate' | 'approvedAt') => {
      if (!parsedCursor) return undefined;
      return {
        OR: [
          { [tsField]: { lt: parsedCursor.at } },
          {
            AND: [
              { [tsField]: parsedCursor.at },
              { id: { lt: parsedCursor.id } },
            ],
          },
        ],
      };
    };

    const [audits, payments, ibans, approvedDocs] = await Promise.all([
      this.prisma.auditLog.findMany({
        where: {
          tenantId,
          entityType: 'party',
          entityId: partyId,
          ...(cursorWhere('createdAt') ?? {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 200,
      }),
      this.prisma.paymentEvent.findMany({
        where: {
          tenantId,
          document: { partyId, tenantId },
          ...(cursorWhere('dueDate') ?? {}),
        },
        orderBy: [{ dueDate: 'desc' }, { id: 'desc' }],
        take: 200,
        // Security fix-up (Sprint G review §A1): fileKey intentionally
        // OMITTED. fileKey is the on-disk storage path
        // (`tenants/<id>/<year>/<month>/<id>.pdf`); exposing it leaks the
        // tenant's folder layout. UI uses docNumber as the label.
        include: {
          document: {
            select: { id: true, docNumber: true },
          },
        },
      }),
      this.prisma.ibanHistory.findMany({
        where: {
          tenantId,
          partyId,
          ...(cursorWhere('createdAt') ?? {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 200,
      }),
      this.prisma.document.findMany({
        where: {
          tenantId,
          partyId,
          status: 'APROVADO',
          ...(cursorWhere('approvedAt') ?? {}),
        },
        orderBy: [{ approvedAt: 'desc' }, { id: 'desc' }],
        take: 200,
        select: {
          id: true,
          fileName: true,
          docNumber: true,
          approvedAt: true,
          approvedById: true,
        },
      }),
    ]);

    // Normalise into a uniform TimelineEvent shape. Each source's
    // native timestamp becomes the unified `at`.
    const events: TimelineEvent[] = [
      ...audits.map((a) => ({
        id: a.id,
        type: 'audit' as const,
        at: a.createdAt.toISOString(),
        action: a.action,
        userId: a.userId,
        metadata: a.metadata,
      })),
      ...payments.map((p) => ({
        id: p.id,
        type: 'payment' as const,
        at: p.dueDate.toISOString(),
        amount: p.amount?.toString() ?? null,
        status: p.status,
        documentId: p.documentId,
        document: p.document,
      })),
      ...ibans.map((i) => ({
        id: i.id,
        type: 'iban_change' as const,
        at: i.createdAt.toISOString(),
        oldIban: i.oldIban,
        newIban: i.newIban,
        verified: i.verified,
        changedById: i.changedById,
      })),
      ...approvedDocs.map((d) => ({
        id: d.id,
        type: 'document_approved' as const,
        at: (d.approvedAt as Date).toISOString(),
        documentId: d.id,
        fileName: d.fileName,
        docNumber: d.docNumber,
        approvedById: d.approvedById,
      })),
    ];

    // Sort by `at` desc, then by `id` desc as tie-break for events that
    // share a timestamp. Same logic as the per-source query.
    events.sort((a, b) => {
      if (a.at !== b.at) return a.at < b.at ? 1 : -1;
      return a.id < b.id ? 1 : -1;
    });

    // Slice to the requested page. We do this AFTER merging so the UI
    // gets a balanced view across all sources — slice-before-merge would
    // over-weight the first source.
    const page = events.slice(0, safeLimit);
    // If we returned a full page, the caller's NEXT request may find
    // more events. Strict `> safeLimit` would silently drop the "is
    // the last page?" hint when the remaining count happens to equal
    // exactly safeLimit — so use `>=` here and let the next request
    // (with no remaining rows) signal a true end via empty page +
    // null cursor. The tiny redundancy of one extra round-trip is
    // worth the correctness.
    const nextCursor =
      events.length >= safeLimit
        ? this.encodeCursor(page[page.length - 1].at, page[page.length - 1].id)
        : null;

    return { items: page, nextCursor };
  }

  /**
   * Encode `<iso>|<id>` into base64 so the cursor looks opaque to the
   * client. Same format the frontend sends back for the next page.
   */
  private encodeCursor(at: string, id: string): string {
    return Buffer.from(`${at}|${id}`, 'utf8').toString('base64url');
  }

  private decodeCursor(cursor: string): { at: Date; id: string } | null {
    try {
      const raw = Buffer.from(cursor, 'base64url').toString('utf8');
      const sep = raw.indexOf('|');
      if (sep <= 0) return null;
      const at = new Date(raw.slice(0, sep));
      const id = raw.slice(sep + 1);
      if (isNaN(at.getTime()) || !id) return null;
      return { at, id };
    } catch {
      return null;
    }
  }
}
