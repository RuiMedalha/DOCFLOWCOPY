import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import {
  CreatePartyContactDto,
  UpdatePartyContactDto,
} from './dto/party-contact.dto';

/**
 * PartyContactsService — CRUD on the per-Party named-contact list
 * (CFO, contabilista, comercial, ...).
 *
 * Multi-tenant isolation:
 *   - Every Prisma call carries `tenantId` from the session, never from the
 *     request body or URL.
 *   - `assertPartyInTenant` runs BEFORE any contact read/write so a request
 *     to a partyId that doesn't belong to the tenant returns 404 (and does
 *     not leak whether the party exists in another tenant).
 *
 * The `@@unique([tenantId, partyId, email])` constraint is honored by:
 *   1. The DTO `normalizeEmail` Transform collapsing "" to undefined so we
 *      never write empty strings.
 *   2. Catching `Prisma.PrismaClientKnownRequestError('P2002')` and turning
 *      it into a 409 with a Portuguese message — never leaks the raw
 *      Prisma error to the client.
 */
@Injectable()
export class PartyContactsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * GET /parties/:partyId/contacts — list contacts for a party, newest first.
   * GET does NOT require ADMIN — read access follows the same pattern as
   * `GET /parties/:id/iban-history`.
   */
  async list(tenantId: string, partyId: string) {
    await this.assertPartyInTenant(tenantId, partyId);
    const items = await this.prisma.partyContact.findMany({
      where: { tenantId, partyId },
      orderBy: [{ createdAt: 'desc' }],
    });
    return { items: items.map(this.sanitize) };
  }

  /**
   * POST /parties/:partyId/contacts — add a new contact. ADMIN-only at the
   * controller. Per-field audit row follows `AuditAction.EDIT` (party.update
   * .contact) convention from Sprint E so the audit log stays queryable
   * by `metadata.field`.
   */
  async create(
    tenantId: string,
    userId: string,
    partyId: string,
    dto: CreatePartyContactDto,
  ) {
    await this.assertPartyInTenant(tenantId, partyId);
    try {
      const created = await this.prisma.partyContact.create({
        data: {
          tenantId,
          partyId,
          name: dto.name,
          role: dto.role ?? null,
          email: dto.email ?? null,
          phone: dto.phone ?? null,
          notes: dto.notes ?? null,
        },
      });
      await this.audit.log({
        tenantId,
        userId,
        action: AuditAction.CREATE,
        entityType: 'party_contact',
        entityId: created.id,
        metadata: { partyId, name: created.name, email: created.email },
      });
      return this.sanitize(created);
    } catch (err) {
      throw this.translateKnownErrors(err, 'Contacto');
    }
  }

  /**
   * PATCH /parties/:partyId/contacts/:id — partial update. Writes per-field
   * audit rows so we can answer "who renamed contact X from A to B".
   */
  async update(
    tenantId: string,
    userId: string,
    partyId: string,
    id: string,
    dto: UpdatePartyContactDto,
  ) {
    await this.assertPartyInTenant(tenantId, partyId);
    const existing = await this.prisma.partyContact.findFirst({
      where: { id, tenantId, partyId },
      select: {
        id: true,
        name: true,
        role: true,
        email: true,
        phone: true,
        notes: true,
      },
    });
    if (!existing) throw new NotFoundException('Contacto não encontrado');

    const data: Record<string, unknown> = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.role !== undefined) data.role = dto.role ?? null;
    if (dto.email !== undefined) data.email = dto.email ?? null;
    if (dto.phone !== undefined) data.phone = dto.phone ?? null;
    if (dto.notes !== undefined) data.notes = dto.notes ?? null;

    try {
      const updated = await this.prisma.partyContact.update({
        where: { id },
        data,
      });

      // Per-field audit — same pattern as party.update.recurring /
      // party.update.partyCategory in parties.service.ts. Skip fields the
      // caller didn't include OR whose value didn't actually change.
      const fieldKeys: Array<'name' | 'role' | 'email' | 'phone' | 'notes'> =
        ['name', 'role', 'email', 'phone', 'notes'];
      for (const field of fieldKeys) {
        const next = (dto as Record<string, unknown>)[field];
        if (next === undefined) continue;
        const prev = (existing as Record<string, unknown>)[field];
        const normalisedPrev = prev ?? null;
        const normalisedNext = next ?? null;
        if (normalisedPrev === normalisedNext) continue;
        await this.audit.log({
          tenantId,
          userId,
          action: AuditAction.EDIT,
          entityType: 'party_contact',
          entityId: id,
          metadata: {
            subAction: 'party.update.contact',
            field,
            oldValue: normalisedPrev,
            newValue: normalisedNext,
          },
        });
      }

      return this.sanitize(updated);
    } catch (err) {
      throw this.translateKnownErrors(err, 'Contacto');
    }
  }

  /**
   * DELETE /parties/:partyId/contacts/:id — hard delete. The contact row
   * has no FK pointing at it from elsewhere in the schema, so cascade
   * isn't a concern.
   */
  async remove(tenantId: string, userId: string, partyId: string, id: string) {
    await this.assertPartyInTenant(tenantId, partyId);
    const existing = await this.prisma.partyContact.findFirst({
      where: { id, tenantId, partyId },
      select: { id: true, name: true, email: true },
    });
    if (!existing) throw new NotFoundException('Contacto não encontrado');

    await this.prisma.partyContact.delete({ where: { id } });
    await this.audit.log({
      tenantId,
      userId,
      action: AuditAction.DELETE,
      entityType: 'party_contact',
      entityId: id,
      metadata: { partyId, name: existing.name, email: existing.email },
    });
    return { id };
  }

  // ════════════════════════════════ helpers ═════════════════════════════════

  /**
   * Verify the party belongs to this tenant. Throws 404 if not found —
   * the API does NOT distinguish "wrong tenant" from "doesn't exist",
   * which would otherwise be a tenant-existence oracle.
   */
  private async assertPartyInTenant(tenantId: string, partyId: string) {
    const p = await this.prisma.party.findFirst({
      where: { id: partyId, tenantId },
      select: { id: true },
    });
    if (!p) throw new NotFoundException('Entidade não encontrada');
  }

  /**
   * Drop the internal `tenantId` from the response. Mirrors `sanitizeParty`
   * in parties.service.ts.
   */
  private sanitize = (c: {
    id: string;
    partyId: string;
    name: string;
    role: string | null;
    email: string | null;
    phone: string | null;
    notes: string | null;
    createdAt: Date;
    updatedAt: Date;
  }) => ({
    id: c.id,
    partyId: c.partyId,
    name: c.name,
    role: c.role,
    email: c.email,
    phone: c.phone,
    notes: c.notes,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  });

  /**
   * Map known Prisma errors to user-safe HTTP errors. The generic
   * exception filter catches everything else.
   */
  private translateKnownErrors(err: unknown, label: string): Error {
    // PrismaClientKnownRequestError carries a `code` like 'P2002' (unique
    // violation). We import dynamically to avoid pulling @prisma/client
    // types into a runtime path — the `code` field is a string either way.
    const code = (err as { code?: string })?.code;
    if (code === 'P2002') {
      return new ConflictException(
        `${label} com este email já existe nesta entidade`,
      );
    }
    return err as Error;
  }
}
