import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';

/**
 * PartyPaymentsService — read-only `GET /parties/:id/payments`.
 *
 * PaymentEvent has no `partyId` direct FK — it points to `Document`,
 * which has `partyId`. The list query JOINs through the document:
 *
 *     prisma.paymentEvent.findMany({
 *       where: {
 *         document: { partyId, tenantId },
 *         tenantId,
 *       },
 *       include: { document: { select: { id, docNumber } } }
 *     })
 *
 * Cursor pagination uses the row id (not a timestamp) because two
 * events on the same invoice can have identical `dueDate`s — and even
 * with distinct dates, composite `[dueDate, id]` is overkill for the
 * scale (≤ 50 events per fetch). The UI scrolls by page of 20.
 */
@Injectable()
export class PartyPaymentsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * GET /parties/:partyId/payments?cursor=&limit=20
   *
   * The cursor is the LAST returned row's id (cuid). Subsequent pages
   * use `cursor: { id }` + `skip: 1`. We cap `limit` at 50 and clamp
   * bad input to a safe default.
   */
  async list(
    tenantId: string,
    partyId: string,
    cursor?: string,
    limit = 20,
  ) {
    // Security fix-up (Sprint G review §A2): assert party belongs to
    // tenant BEFORE running the JOIN query. Mirrors the
    // assertPartyInTenant guard in party-contacts / party-addresses —
    // closes the parity gap where payments used to return 200 + empty
    // array for a cross-tenant partyId.
    const party = await this.prisma.party.findFirst({
      where: { id: partyId, tenantId },
      select: { id: true },
    });
    if (!party) throw new NotFoundException('Entidade não encontrada');

    // Security fix-up (Sprint G review §A1): `fileKey` was removed from
    // the document select. fileKey is the on-disk storage path
    // (`tenants/<id>/<year>/<month>/<id>.pdf`); exposing it leaks the
    // tenant folder layout. The UI uses `docNumber` as the label — same
    // convention as the existing DocumentsModule responses.
    const safeLimit = Math.min(Math.max(limit, 1), 50);
    const events = await this.prisma.paymentEvent.findMany({
      where: {
        tenantId,
        document: { partyId, tenantId },
      },
      include: {
        document: {
          select: { id: true, docNumber: true },
        },
      },
      orderBy: [{ dueDate: 'desc' }, { id: 'desc' }],
      take: safeLimit,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    const items = events.map((e) => ({
      id: e.id,
      documentId: e.documentId,
      document: e.document,
      dueDate: e.dueDate,
      amount: e.amount?.toString() ?? null,
      status: e.status,
      paidAt: e.paidAt,
      paidAmount: e.paidAmount?.toString() ?? null,
      paymentMethod: e.paymentMethod,
      notes: e.notes,
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
    }));

    const nextCursor =
      events.length === safeLimit ? events[events.length - 1].id : null;

    return { items, nextCursor };
  }
}
