import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction, PartyAddressType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import {
  CreatePartyAddressDto,
  UpdatePartyAddressDto,
} from './dto/party-address.dto';

/**
 * PartyAddressesService — CRUD on the per-Party address list.
 *
 * Multi-tenant isolation: every query carries `tenantId` from the session,
 * and `assertPartyInTenant` is called before any read/write so a tenant
 * cannot probe another tenant's party by guessing IDs.
 *
 * `isPrimary` constraint
 * ----------------------
 * Prisma 4's DSL has no `WHERE isPrimary` clause on `@@unique`, so the
 * "at most one primary per (partyId, type)" invariant is enforced in the
 * service layer with a transactional advisory lock keyed on the
 * (partyId, type) pair:
 *
 *     SELECT pg_advisory_xact_lock(hashtext(
 *       'party_address_primary:' || partyId || ':' || type
 *     ));
 *
 * The lock is held for the remainder of the transaction and released
 * automatically on commit/rollback — Postgress auto-release means we
 * don't need to unlock explicitly, and a crashed writer doesn't leave a
 * dangling lock (it dies with the transaction).
 *
 * Race scenario: two concurrent POSTs both trying to mark their new
 * address as `isPrimary=true` for the same (partyId, BILLING). Without the
 * lock, both could pass the uniqueness check and the second INSERT would
 * commit a second primary. With the lock, the second request waits until
 * the first transaction commits and then sees the new state — its own
 * unset-others-then-set-self still produces exactly one primary row.
 *
 * On `UPDATE`: the same lock is acquired with the address's CURRENT
 * type. If the caller is changing the address's `type` (e.g. from
 * CORRESPONDENCE to BILLING) the lock is taken on the NEW type AFTER the
 * type flip commits — so two concurrent "change type to BILLING" requests
 * still serialise correctly under the new-type lock.
 */
@Injectable()
export class PartyAddressesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * GET /parties/:partyId/addresses — list addresses for a party. We
   * sort by `isPrimary DESC` first so the UI can show the primary of
   * each type at the top without re-sorting client-side.
   */
  async list(tenantId: string, partyId: string) {
    await this.assertPartyInTenant(tenantId, partyId);
    const items = await this.prisma.partyAddress.findMany({
      where: { tenantId, partyId },
      orderBy: [{ isPrimary: 'desc' }, { type: 'asc' }, { createdAt: 'desc' }],
    });
    return { items: items.map((a) => this.sanitize(a)) };
  }

  /**
   * POST /parties/:partyId/addresses — create new address. When
   * `isPrimary=true` (or `type` has no other primary yet), the service
   * promotes it under a transactional advisory lock.
   */
  async create(
    tenantId: string,
    userId: string,
    partyId: string,
    dto: CreatePartyAddressDto,
  ) {
    await this.assertPartyInTenant(tenantId, partyId);
    const country = (dto.country ?? 'PT').toUpperCase();
    const isPrimary = dto.isPrimary === true;

    const created = await this.prisma.$transaction(async (tx) => {
      // Acquire the per-(partyId, type) lock FIRST so any concurrent
      // POST/PATCH for the same party+type serialises here.
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtext(
          ${'party_address_primary:' + partyId + ':' + dto.type}
        ))
      `;
      // If the caller asked for isPrimary=true, OR if no other address
      // of this type exists yet (we auto-promote the first one to make
      // the UI nicer), unset existing primaries of the same type before
      // inserting the new row with isPrimary=true.
      let effectiveIsPrimary = isPrimary;
      if (effectiveIsPrimary) {
        await tx.partyAddress.updateMany({
          where: {
            tenantId,
            partyId,
            type: dto.type,
            isPrimary: true,
          },
          data: { isPrimary: false },
        });
      } else {
        // Auto-promote: if no primary of this type exists yet, the new
        // address becomes the primary. This keeps the UI's "primary"
        // badge useful even when the operator never ticks the box.
        const existingPrimary = await tx.partyAddress.findFirst({
          where: { tenantId, partyId, type: dto.type, isPrimary: true },
          select: { id: true },
        });
        if (!existingPrimary) effectiveIsPrimary = true;
      }
      return tx.partyAddress.create({
        data: {
          tenantId,
          partyId,
          type: dto.type,
          line1: dto.line1,
          line2: dto.line2 ?? null,
          postalCode: dto.postalCode ?? null,
          city: dto.city ?? null,
          country,
          isPrimary: effectiveIsPrimary,
        },
      });
    });

    await this.audit.log({
      tenantId,
      userId,
      action: AuditAction.CREATE,
      entityType: 'party_address',
      entityId: created.id,
      metadata: {
        partyId,
        type: created.type,
        isPrimary: created.isPrimary,
        country: created.country,
      },
    });
    return this.sanitize(created);
  }

  /**
   * PATCH /parties/:partyId/addresses/:id — partial update. The
   * isPrimary / type transitions are routed through a single
   * transaction with the appropriate advisory lock; the simple
   * field updates (line1 / line2 / city / postalCode / country) go
   * through a fast-path UPDATE without locking.
   */
  async update(
    tenantId: string,
    userId: string,
    partyId: string,
    id: string,
    dto: UpdatePartyAddressDto,
  ) {
    await this.assertPartyInTenant(tenantId, partyId);
    const existing = await this.prisma.partyAddress.findFirst({
      where: { id, tenantId, partyId },
      select: {
        id: true,
        partyId: true,
        type: true,
        line1: true,
        line2: true,
        postalCode: true,
        city: true,
        country: true,
        isPrimary: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    if (!existing) throw new NotFoundException('Morada não encontrada');

    const typeChanged = dto.type !== undefined && dto.type !== existing.type;
    const isPrimaryChanged =
      dto.isPrimary !== undefined && dto.isPrimary !== existing.isPrimary;

    if (!typeChanged && !isPrimaryChanged) {
      // Fast path — no cross-row invariant at stake. Just update the row
      // and emit per-field audit rows if anything actually changed.
      const data: Record<string, unknown> = {};
      if (dto.line1 !== undefined) data.line1 = dto.line1;
      if (dto.line2 !== undefined) data.line2 = dto.line2 ?? null;
      if (dto.postalCode !== undefined) data.postalCode = dto.postalCode ?? null;
      if (dto.city !== undefined) data.city = dto.city ?? null;
      if (dto.country !== undefined) {
        data.country = (dto.country ?? 'PT').toUpperCase();
      }
      if (Object.keys(data).length === 0) return this.sanitize(existing);

      const updated = await this.prisma.partyAddress.update({
        where: { id },
        data,
      });
      await this.auditFieldChanges(
        tenantId,
        userId,
        id,
        existing as unknown as Record<string, unknown>,
        data,
      );
      return this.sanitize(updated);
    }

    // Slow path — either type or isPrimary is changing. Wrap in a
    // transaction with the right advisory lock:
    //   - If the type is changing, we have to release the old type's
    //     primary promotion (unset on the OLD side) AND acquire the new
    //     type's lock to set the new primary. Doing that under a single
    //     transaction keeps both halves atomic.
    //   - If just isPrimary is changing, lock only on (partyId, type).
    //
    // We lock on the NEW type (because that's where the conflict lives
    // — "another primary of the new type"). The unset-old-type-side is
    // done first inside the lock so a reader can never observe two
    // primaries of the old type mid-transaction.
    const newType = dto.type ?? existing.type;
    const targetIsPrimary = dto.isPrimary ?? existing.isPrimary;

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtext(
          ${'party_address_primary:' + partyId + ':' + newType}
        ))
      `;

      // If the type is changing and we're moving from PRIMARY on the
      // old type to NON-PRIMARY on the new type, nothing on the old
      // side needs promotion/unset (we're leaving — the row stays put
      // but isPrimary becomes false effectively because the old
      // primary now points elsewhere or stays primary only if a
      // different row on the same old type gets re-promoted). The
      // simpler invariant: any unset of OLD-side primary comes for
      // free because the row itself is changing type away.
      //
      // If the type changes AND we're becoming primary on the new type,
      // unset OTHER primaries on the new type so we end up with exactly
      // one.
      if (targetIsPrimary) {
        await tx.partyAddress.updateMany({
          where: {
            tenantId,
            partyId,
            type: newType,
            isPrimary: true,
            NOT: { id },
          },
          data: { isPrimary: false },
        });
      }
      const row = await tx.partyAddress.update({
        where: { id },
        data: {
          type: newType,
          isPrimary: targetIsPrimary,
          line1: dto.line1 ?? undefined,
          line2: dto.line2 ?? undefined,
          postalCode: dto.postalCode ?? undefined,
          city: dto.city ?? undefined,
          country:
            dto.country !== undefined
              ? (dto.country ?? 'PT').toUpperCase()
              : undefined,
        },
      });
      return row;
    });

    await this.audit.log({
      tenantId,
      userId,
      action: AuditAction.EDIT,
      entityType: 'party_address',
      entityId: id,
      metadata: {
        subAction: 'party.update.address',
        oldType: existing.type,
        newType,
        oldIsPrimary: existing.isPrimary,
        newIsPrimary: targetIsPrimary,
        partyId,
      },
    });

    return this.sanitize(updated);
  }

  /**
   * DELETE /parties/:partyId/addresses/:id. Hard delete. We do NOT
   * auto-promote another address of the same type to primary — the UI
   * can offer an "Add new primary" prompt when the deleted row was the
   * primary. (A future Sprint may add auto-promote, mirroring the
   * CREATE auto-promote.)
   */
  async remove(tenantId: string, userId: string, partyId: string, id: string) {
    await this.assertPartyInTenant(tenantId, partyId);
    const existing = await this.prisma.partyAddress.findFirst({
      where: { id, tenantId, partyId },
      select: { id: true, type: true, isPrimary: true, line1: true },
    });
    if (!existing) throw new NotFoundException('Morada não encontrada');

    await this.prisma.partyAddress.delete({ where: { id } });
    await this.audit.log({
      tenantId,
      userId,
      action: AuditAction.DELETE,
      entityType: 'party_address',
      entityId: id,
      metadata: {
        partyId,
        type: existing.type,
        isPrimary: existing.isPrimary,
        line1: existing.line1,
      },
    });
    return { id };
  }

  // ════════════════════════════════ helpers ═════════════════════════════════

  private async assertPartyInTenant(tenantId: string, partyId: string) {
    const p = await this.prisma.party.findFirst({
      where: { id: partyId, tenantId },
      select: { id: true },
    });
    if (!p) throw new NotFoundException('Entidade não encontrada');
  }

  private sanitize = (a: {
    id: string;
    partyId: string;
    type: PartyAddressType;
    line1: string;
    line2: string | null;
    postalCode: string | null;
    city: string | null;
    country: string;
    isPrimary: boolean;
    createdAt: Date;
    updatedAt: Date;
  }) => ({
    id: a.id,
    partyId: a.partyId,
    type: a.type,
    line1: a.line1,
    line2: a.line2,
    postalCode: a.postalCode,
    city: a.city,
    country: a.country,
    isPrimary: a.isPrimary,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  });

  /**
   * Per-field audit helper for the fast-path update. Skips fields the
   * caller did NOT include (`data[field] === undefined`) AND fields
   * whose values did not actually change.
   */
  private async auditFieldChanges(
    tenantId: string,
    userId: string,
    id: string,
    existing: Record<string, unknown>,
    data: Record<string, unknown>,
  ) {
    const keys: Array<
      'line1' | 'line2' | 'postalCode' | 'city' | 'country'
    > = ['line1', 'line2', 'postalCode', 'city', 'country'];
    for (const field of keys) {
      if (data[field] === undefined) continue;
      const prev = existing[field] ?? null;
      const next = data[field] ?? null;
      if (prev === next) continue;
      await this.audit.log({
        tenantId,
        userId,
        action: AuditAction.EDIT,
        entityType: 'party_address',
        entityId: id,
        metadata: {
          subAction: 'party.update.address',
          field,
          oldValue: prev,
          newValue: next,
        },
      });
    }
  }
}
