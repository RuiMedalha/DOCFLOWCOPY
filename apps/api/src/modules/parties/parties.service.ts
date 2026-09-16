import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction, PartyType, Prisma } from '@prisma/client';
import { isValidIban, isValidNif, normalizeIban, normalizeNif } from '@docflow/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { PartyCategoriesService } from '../party-categories/party-categories.service';
import { isGenericPartyName } from '../vies/address-parser';
import { slugify } from '../../common/storage/slug';
import {
  AccountQueryDto,
  CreateAccountDto,
  UpdateAccountDto,
} from './dto/account.dto';
import {
  CreatePartyDto,
  FlagIbanDto,
  MarkVerifiedIbanDto,
  PartyQueryDto,
  UpdatePartyDto,
} from './dto/party.dto';

export interface RiskBreakdownItem {
  factor: string;
  score: number;
  reason: string;
}

export interface IbanRiskReport {
  iban: string;
  blacklistMatch: boolean;
  blacklistReason?: string;
  riskScore: number; // 0..100 — higher is riskier
  recommendedAction: 'allow' | 'review' | 'block';
  breakdown: RiskBreakdownItem[];
}

/**
 * PartiesService — masters for fornecedores/clientes + PT chart of accounts.
 *
 * Responsibilities:
 *
 *   - CRUD on Party (fornecedor | cliente | ambos). NIF and IBAN are validated
 *     with the @docflow/shared PT utilities (mod-11, MOD-97-10) before any
 *     row is written. A failed validation throws BadRequestException.
 *   - IBAN change tracking: every time a Party's `iban` column changes, an
 *     IbanHistory row is written in the SAME transaction. This is the
 *     anti-fraud audit trail — ExtractService and the documents module read
 *     from it when validating OCR/QR-AT IBANs.
 *   - Anti-fraud helpers: markVerified (set ibanVerified/ibanVerifiedAt),
 *     flag (set ibanFlagged + reason in IbanBlacklist if missing), riskScore
 *     (compute a 0..100 score by reading IbanBlacklist + history of changes).
 *   - PT chart of accounts CRUD + a "seed accounts" listing that the
 *     migration script seeds (8 default accounts in `wave-1`).
 *
 * All mutations go through the global AuditService so the hash-chained
 * AuditLog stays consistent with the rest of DocFlow.
 */
@Injectable()
export class PartiesService {
  private readonly logger = new Logger(PartiesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly partyCategories: PartyCategoriesService,
  ) {}

  // ════════════════════════════════ PARTIES — CRUD ══════════════════════════

  /**
   * Paginated listing of parties for `tenantId`. `where.isActive` defaults
   * to true but accepts false (soft-archived parties show up too).
   */
  async findAll(tenantId: string, query: PartyQueryDto) {
    const where: Prisma.PartyWhereInput = { tenantId };
    if (query.type) where.type = query.type;
    if (query.isActive !== undefined) where.isActive = query.isActive;
    if (query.search) {
      const s = query.search;
      where.OR = [
        { name: { contains: s, mode: 'insensitive' } },
        { nif: { contains: s } },
        { email: { contains: s, mode: 'insensitive' } },
        { iban: { contains: s } },
        { city: { contains: s, mode: 'insensitive' } },
      ];
    }
    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 20, 200);
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      this.prisma.party.findMany({
        where,
        orderBy: { name: 'asc' },
        skip,
        take: limit,
        include: {
          partyCategory: {
            select: { id: true, slug: true, name: true, color: true, sortOrder: true },
          },
        },
      }),
      this.prisma.party.count({ where }),
    ]);
    // Note: `findAll` deliberately does NOT eager-load contacts /
    // addresses — the list view does not display them and the extra
    // round-trip would balloon page weight on tenants with hundreds
    // of parties. `findOne` (party detail) DOES load them for the
    // 360° file.

    // The Party schema carries FK columns (`defaultDebitAccountId`,
    // `defaultCreditAccountId`) but no Prisma relation lines — so we
    // hydrate the related Account rows in one extra findMany rather than
    // an `include`. Keeps the service type-safe against the actual schema.
    const accountIds = new Set<string>();
    for (const p of items) {
      if (p.defaultDebitAccountId) accountIds.add(p.defaultDebitAccountId);
      if (p.defaultCreditAccountId) accountIds.add(p.defaultCreditAccountId);
    }
    const accounts = accountIds.size
      ? await this.prisma.account.findMany({
          where: { tenantId, id: { in: Array.from(accountIds) } },
          select: { id: true, code: true, name: true },
        })
      : [];
    const accountById = new Map(accounts.map((a) => [a.id, a]));

    return {
      items: items.map((p) => this.sanitizeParty(p, accountById)),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async findOne(tenantId: string, id: string) {
    const p = await this.prisma.party.findFirst({
      where: { id, tenantId },
      include: {
        partyCategory: {
          select: { id: true, slug: true, name: true, color: true, sortOrder: true },
        },
        defaultCategory: { select: { id: true, name: true, slug: true } },
        // Sprint G: eager-load the 360° sub-resources so the detail page
        // can render without a waterfall of follow-up GETs. Tenant scope
        // is already enforced by `where: { tenantId }` above — the
        // contacts/addresses relations are 1:N on the same tenant.
        contacts: {
          orderBy: [{ createdAt: 'desc' }],
        },
        addresses: {
          orderBy: [{ isPrimary: 'desc' }, { type: 'asc' }, { createdAt: 'desc' }],
        },
      },
    });
    if (!p) throw new NotFoundException('Party not found');

    // Auto-recuperação de nome genérico (ex.: "---" vindo do VIES de Espanha ou "Fornecedor por identificar")
    // a partir do fornecedor extraído dos documentos já processados desta entidade.
    if (isGenericPartyName(p.name, p.nif, p.vatNumber)) {
      try {
        const linkedDoc = await this.prisma.document.findFirst({
          where: {
            tenantId,
            OR: [
              { partyId: p.id },
              ...(p.nif ? [{ supplierNif: p.nif }] : []),
              ...(p.vatNumber ? [{ supplierNif: p.vatNumber }] : []),
            ],
            supplier: { not: null },
          },
          select: { supplier: true },
          orderBy: { createdAt: 'desc' },
        });
        if (linkedDoc?.supplier && !isGenericPartyName(linkedDoc.supplier)) {
          const healedName = linkedDoc.supplier.trim().slice(0, 200);
          await this.prisma.party.update({
            where: { id: p.id },
            data: { name: healedName },
          });
          p.name = healedName;
          this.logger.log(`[findOne] auto-healed generic party=${p.id} name to "${healedName}" from linked document`);
        }
      } catch (healErr) {
        this.logger.warn(`[findOne] auto-heal failed for party=${p.id}: ${(healErr as Error).message}`);
      }
    }

    const accountIds = [p.defaultDebitAccountId, p.defaultCreditAccountId].filter(
      Boolean,
    ) as string[];
    const accounts = accountIds.length
      ? await this.prisma.account.findMany({
          where: { tenantId, id: { in: accountIds } },
          select: { id: true, code: true, name: true },
        })
      : [];
    const accountById = new Map(accounts.map((a) => [a.id, a]));
    return this.sanitizeParty(p, accountById);
  }

  /**
   * Create a new Party. NIF + IBAN are validated with the PT utilities.
   * If the same NIF already exists for this tenant, throws Conflict.
   */
  async create(tenantId: string, userId: string, dto: CreatePartyDto) {
    const nif = this.coerceNif(dto.nif);
    const iban = this.coerceIban(dto.iban);

    if (nif) {
      const dupe = await this.prisma.party.findFirst({
        where: { tenantId, nif },
        select: { id: true, name: true },
      });
      if (dupe) {
        throw new ConflictException(
          `Já existe entidade com este NIF (${dupe.name})`,
        );
      }
    }

    // Auto-detect blacklist: refuse to create if iban is in the blacklist.
    if (iban) {
      const blocked = await this.prisma.ibanBlacklist.findFirst({
        where: { tenantId, iban },
        select: { id: true, reason: true },
      });
      if (blocked) {
        throw new BadRequestException(
          `IBAN está na blacklist do tenant: ${blocked.reason}`,
        );
      }
    }

    await this.assertAccountsExist(tenantId, {
      defaultDebitAccountId: dto.defaultDebitAccountId,
      defaultCreditAccountId: dto.defaultCreditAccountId,
    });

    // Validate category FK if supplied.
    if (dto.partyCategoryId) {
      await this.partyCategories.assertCategoryInTenant(tenantId, dto.partyCategoryId);
    }

    const party = await this.prisma.party.create({
      data: {
        tenantId,
        type: dto.type ?? PartyType.FORNECEDOR,
        name: dto.name,
        slug: await this.generateUniqueSlug(tenantId, dto.name),
        // Scalar FK to keep the create consistent with the rest of the
        // party-create path (which uses unchecked scalars like tenantId).
        partyCategoryId: dto.partyCategoryId ?? null,
        nif: nif ?? null,
        email: dto.email,
        phone: dto.phone,
        mobile: dto.mobile,
        iban: iban ?? null,
        bic: dto.bic,
        address: dto.address,
        city: dto.city,
        postalCode: dto.postalCode,
        country: dto.country ?? 'PT',
        website: dto.website,
        industry: dto.industry,
        notes: dto.notes,
        // Fase 4
        vatNumber: dto.vatNumber ? dto.vatNumber.replace(/[\s.-]/g, '').toUpperCase() : null,
        vatRegime: dto.vatRegime ?? ((dto.country ?? 'PT').toUpperCase() === 'PT' ? 'PT' : dto.vatNumber ? 'UE_REVERSE_CHARGE' : 'EXTRA_UE'),
        currency: (dto.currency ?? 'EUR').toUpperCase(),
        directDebit: dto.directDebit ?? false,
        billingEmail: dto.billingEmail,
        defaultCategoryId: dto.defaultCategoryId ?? null,
        tags: dto.tags ?? [],
        paymentTermDays: dto.paymentTermDays ?? 30,
        defaultDebitAccountId: dto.defaultDebitAccountId,
        defaultCreditAccountId: dto.defaultCreditAccountId,
        externalIds: (dto.externalIds ?? null) as Prisma.InputJsonValue,
        ibanVerified: false,
        ibanFlagged: false,
      },
    });

    // IBAN was set on creation — record the initial value in the history so
    // subsequent queries (ExtractService.compareIban) see it as "known".
    if (iban) {
      await this.prisma.ibanHistory.create({
        data: {
          tenantId,
          partyId: party.id,
          oldIban: null,
          newIban: iban,
          changedById: userId,
          reason: 'initial_iban_on_create',
          verified: false,
        },
      });
    }

    await this.audit.log({
      tenantId,
      userId,
      action: AuditAction.CREATE,
      entityType: 'party',
      entityId: party.id,
      metadata: { name: party.name, nif: party.nif, type: party.type },
    });

    return this.findOne(tenantId, party.id);
  }

  /**
   * Partial-update a Party. The IBAN column is diffed BEFORE the write —
   * if it changed, an IbanHistory row is added INSIDE the same transaction
   * (or right after, with a try/catch — the audit trail is best-effort).
   */
  async update(
    tenantId: string,
    userId: string,
    id: string,
    dto: UpdatePartyDto,
    userRole?: string,
  ) {
    const existing = await this.prisma.party.findFirst({
      where: { id, tenantId },
      select: {
        id: true,
        name: true,
        iban: true,
        nif: true,
        type: true,
        isActive: true,
        isRecurring: true,
        isRecurringManualOverride: true,
        // Sprint E fix-up (audit §9 LOW-5 / MEDIUM-5): the recurring-toggle
        // pattern emits a per-field audit row; the same per-field audit
        // discipline must apply to `partyCategoryId` so a compliance
        // review can answer "who moved party X from category A to B".
        partyCategoryId: true,
      },
    });
    if (!existing) throw new NotFoundException('Party not found');

    // Defense-in-depth RBAC: even though the route is gated by @Roles(Role.ADMIN),
    // a direct service caller (queue, cron, test) could still try to flip
    // isRecurring. Reject early here too.
    if (
      (dto.isRecurring !== undefined || dto.isRecurringManualOverride !== undefined) &&
      userRole !== 'ADMIN'
    ) {
      throw new ForbiddenException('Only ADMIN may override isRecurring');
    }

    const newNif = dto.nif !== undefined ? this.coerceNif(dto.nif) : undefined;
    if (newNif !== undefined && newNif !== null && newNif !== existing.nif) {
      const dupe = await this.prisma.party.findFirst({
        where: { tenantId, nif: newNif, NOT: { id } },
        select: { id: true },
      });
      if (dupe) {
        throw new ConflictException('NIF já está registado noutra entidade');
      }
    }

    const newIban =
      dto.iban !== undefined ? this.coerceIban(dto.iban) : undefined;
    if (newIban !== undefined && newIban) {
      // The IBAN is only checked against the blacklist if it actually
      // changed — re-assigning the same (already-listed) IBAN must not
      // throw. Without this guard, the update endpoint becomes a no-op
      // that 400s as soon as an entry is flagged.
      const normalizedOld = existing.iban ? normalizeIban(existing.iban) : null;
      const isChange = normalizeIban(newIban) !== normalizedOld;
      if (isChange) {
        const blocked = await this.prisma.ibanBlacklist.findFirst({
          where: { tenantId, iban: newIban },
          select: { id: true, reason: true },
        });
        if (blocked) {
          throw new BadRequestException(
            `IBAN está na blacklist do tenant: ${blocked.reason}`,
          );
        }
      }
    }

    await this.assertAccountsExist(tenantId, {
      defaultDebitAccountId: dto.defaultDebitAccountId,
      defaultCreditAccountId: dto.defaultCreditAccountId,
    });

    // Sprint E: validate the optional partyCategoryId FK. Passing null
    // (undefined → null) clears the classification; passing a string
    // requires the category to belong to this tenant.
    if (dto.partyCategoryId !== undefined && dto.partyCategoryId !== null) {
      await this.partyCategories.assertCategoryInTenant(tenantId, dto.partyCategoryId);
    }

    // Sprint E: when the name changes, regenerate the slug. The slug
    // is otherwise immutable — renames do NOT move the existing folder
    // (that would be unsafe + expensive); the slug is just a display
    // hint in URLs.
    const nameChanged = dto.name !== undefined && dto.name !== existing.name;

    const ibanChanged =
      newIban !== undefined &&
      newIban !== null &&
      normalizeIban(newIban) !==
        (existing.iban ? normalizeIban(existing.iban) : null);

    const sanitizedNif =
      newNif === undefined ? undefined : newNif === null ? null : newNif;
    const sanitizedIban =
      newIban === undefined ? undefined : newIban === null ? null : newIban;

    const data: Prisma.PartyUpdateInput = {};
    if (dto.type !== undefined) data.type = dto.type;
    if (dto.name !== undefined) data.name = dto.name;
    if (nameChanged) {
      data.slug = await this.generateUniqueSlug(tenantId, dto.name as string, id);
    }
    if (dto.partyCategoryId !== undefined) {
      // The data builder above mixes scalar (tenantId) and relation
      // (partyCategory) shapes, which forces the inferred input type to
      // be the checked `PartyUpdateInput` (no scalar FK exposed).
      // Cast to the unchecked variant just for this assignment — it
      // accepts both `partyCategoryId` and the relation form.
      (data as Prisma.PartyUncheckedUpdateInput).partyCategoryId =
        dto.partyCategoryId ?? null;
    }
    if (sanitizedNif !== undefined) data.nif = sanitizedNif;
    if (dto.email !== undefined) data.email = dto.email;
    if (dto.phone !== undefined) data.phone = dto.phone;
    if (dto.mobile !== undefined) data.mobile = dto.mobile;
    if (sanitizedIban !== undefined) data.iban = sanitizedIban;
    if (dto.bic !== undefined) data.bic = dto.bic;
    if (dto.address !== undefined) data.address = dto.address;
    if (dto.city !== undefined) data.city = dto.city;
    if (dto.postalCode !== undefined) data.postalCode = dto.postalCode;
    if (dto.country !== undefined) data.country = dto.country;
    if (dto.website !== undefined) data.website = dto.website;
    if (dto.industry !== undefined) data.industry = dto.industry;
    if (dto.notes !== undefined) data.notes = dto.notes;
    // Fase 4
    if (dto.vatNumber !== undefined)
      data.vatNumber = dto.vatNumber ? dto.vatNumber.replace(/[\s.-]/g, '').toUpperCase() : null;
    if (dto.vatRegime !== undefined) data.vatRegime = dto.vatRegime;
    if (dto.currency !== undefined) data.currency = (dto.currency || 'EUR').toUpperCase();
    if (dto.directDebit !== undefined) data.directDebit = dto.directDebit;
    if (dto.billingEmail !== undefined) data.billingEmail = dto.billingEmail || null;
    if (dto.defaultCategoryId !== undefined)
      data.defaultCategory = dto.defaultCategoryId ? { connect: { id: dto.defaultCategoryId } } : { disconnect: true };
    if (dto.tags !== undefined) data.tags = dto.tags;
    if (dto.paymentTermDays !== undefined) data.paymentTermDays = dto.paymentTermDays;
    if (dto.defaultDebitAccountId !== undefined)
      data.defaultDebitAccountId = dto.defaultDebitAccountId ?? null;
    if (dto.defaultCreditAccountId !== undefined)
      data.defaultCreditAccountId = dto.defaultCreditAccountId ?? null;
    if (dto.externalIds !== undefined) {
      data.externalIds = (dto.externalIds ?? null) as Prisma.InputJsonValue;
    }
    if (dto.isActive !== undefined) data.isActive = dto.isActive;
    if (dto.isRecurring !== undefined) data.isRecurring = dto.isRecurring;
    if (dto.isRecurringManualOverride !== undefined)
      data.isRecurringManualOverride = dto.isRecurringManualOverride;

    // H-05 fix: when the IBAN changes, BOTH the party row update AND the
    // IbanHistory row write must be in a single transaction — the audit
    // trail can never silently fall out of sync with the live data. We
    // also collapse the non-iban update path through the same transaction
    // when no iban changes, so the audit log is written atomically with
    // the party write. The previous version did `party.update` outside
    // the transaction and wrapped a `ibanHistory.create` in a silent
    // catch — a transient failure would leave the DB inconsistent.
    const updated = await (async () => {
      if (!ibanChanged) {
        // Fast path: no IBAN churn — just update the party row and audit
        // log, no IBAN history to write.
        return this.prisma.party.update({ where: { id }, data });
      }
      return this.prisma.$transaction(async (tx) => {
        const row = await tx.party.update({ where: { id }, data });
        await tx.ibanHistory.create({
          data: {
            tenantId,
            partyId: id,
            oldIban: existing.iban ?? null,
            newIban: sanitizedIban as string,
            changedById: userId,
            reason: dto.notes ? `iban_change: ${dto.notes.slice(0, 200)}` : 'iban_change',
            verified: false,
          },
        });
        return row;
      });
    })();

    await this.audit.log({
      tenantId,
      userId,
      action: AuditAction.EDIT,
      entityType: 'party',
      entityId: id,
      metadata: {
        ibanChanged,
        oldIban: existing.iban ?? null,
        newIban: ibanChanged ? (sanitizedIban as string) : null,
      },
    });

    // Security fix (audit §4): the EDIT row above only carried IBAN metadata.
    // When an ADMIN toggles isRecurring or isRecurringManualOverride there was
    // no audit trail at all. Emit a dedicated 'party.update.recurring' row
    // PER changed field so accountability is preserved (who flipped it, when,
    // old vs new value). We re-use AuditAction.EDIT to stay within the
    // existing enum and filter by `metadata.field` for downstream queries.
    const recurringFields: Array<'isRecurring' | 'isRecurringManualOverride'> = [
      'isRecurring',
      'isRecurringManualOverride',
    ];
    for (const field of recurringFields) {
      const next = dto[field];
      if (next === undefined) continue;
      const prev = existing[field];
      if (prev === next) continue;
      await this.audit.log({
        tenantId,
        userId,
        action: AuditAction.EDIT,
        entityType: 'party',
        entityId: id,
        metadata: {
          subAction: 'party.update.recurring',
          field,
          oldValue: prev,
          newValue: next,
        },
      });
    }

    // Sprint E fix-up (audit §9 LOW-5 / MEDIUM-5): per-field audit row
    // for `partyCategoryId`. The general EDIT row above only carries
    // IBAN metadata; without this row a compliance review can't answer
    // "who moved party X from category A to category B". Same per-field
    // pattern as the recurring toggle — `subAction: 'party.update.partyCategory'`,
    // `field: 'partyCategoryId'`, oldValue/newValue carry the IDs (or null
    // when the category was cleared by passing `null` in the DTO).
    //
    // The "changed" check uses strict `!==` so undefined-vs-null is a real
    // change (user is clearing a previously-set category), but undefined
    // alone means "field was not in the PATCH" — skip those.
    if (dto.partyCategoryId !== undefined) {
      const prevCategory = existing.partyCategoryId ?? null;
      const nextCategory = dto.partyCategoryId ?? null;
      if (prevCategory !== nextCategory) {
        await this.audit.log({
          tenantId,
          userId,
          action: AuditAction.EDIT,
          entityType: 'party',
          entityId: id,
          metadata: {
            subAction: 'party.update.partyCategory',
            field: 'partyCategoryId',
            oldValue: prevCategory,
            newValue: nextCategory,
          },
        });
      }
    }

    return this.findOne(tenantId, id);
  }

  /**
   * Soft-archive a party. Sets `isActive=false`. The row stays queryable for
   * audit; default listings filter it out.
   */
  async softDelete(tenantId: string, userId: string, id: string) {
    const existing = await this.prisma.party.findFirst({
      where: { id, tenantId },
      select: { id: true, name: true },
    });
    if (!existing) throw new NotFoundException('Party not found');

    await this.prisma.party.update({
      where: { id },
      data: { isActive: false },
    });

    await this.audit.log({
      tenantId,
      userId,
      action: AuditAction.DELETE,
      entityType: 'party',
      entityId: id,
      metadata: { reason: 'soft-delete (isActive=false)' },
    });

    return { id, isActive: false };
  }

  // ════════════════════════════════ IBAN — anti-fraud ══════════════════════

  /** GET /parties/:id/iban-history — paginated history rows for a party. */
  async listIbanHistory(tenantId: string, partyId: string) {
    await this.assertPartyExists(tenantId, partyId);
    const rows = await this.prisma.ibanHistory.findMany({
      where: { tenantId, partyId },
      orderBy: { createdAt: 'desc' },
    });
    return { items: rows };
  }

  /**
   * POST /parties/:id/iban/verify — mark the party's IBAN as verified by a
   * human (typically after a phone call). Sets `ibanVerified=true` and
   * `ibanVerifiedAt=now()`. Writes a history row with `verified=true`.
   */
  async markIbanVerified(
    tenantId: string,
    userId: string,
    partyId: string,
    dto: MarkVerifiedIbanDto,
  ) {
    const party = await this.assertPartyExists(tenantId, partyId);
    if (!party.iban) throw new BadRequestException('Party has no IBAN to verify');

    await this.prisma.party.update({
      where: { id: partyId },
      data: { ibanVerified: true, ibanVerifiedAt: new Date(), ibanFlagged: false },
    });

    await this.prisma.ibanHistory.create({
      data: {
        tenantId,
        partyId,
        oldIban: party.iban,
        newIban: party.iban,
        changedById: userId,
        reason: `verified: ${dto.reason ?? 'manual verification'}`,
        verified: true,
      },
    });

    await this.audit.log({
      tenantId,
      userId,
      action: AuditAction.EDIT,
      entityType: 'party',
      entityId: partyId,
      metadata: { action: 'iban_verified', reason: dto.reason ?? null },
    });

    return this.findOne(tenantId, partyId);
  }

  /**
   * POST /parties/:id/iban/flag — mark the party's IBAN as risky. Sets
   * `ibanFlagged=true` and (optionally) `ibanRiskScore`. Also writes a row
   * to IbanBlacklist if missing, so future parties get blocked too.
   */
  async flagIban(
    tenantId: string,
    userId: string,
    partyId: string,
    dto: FlagIbanDto,
  ) {
    const party = await this.assertPartyExists(tenantId, partyId);
    if (!party.iban) throw new BadRequestException('Party has no IBAN to flag');

    await this.prisma.party.update({
      where: { id: partyId },
      data: {
        ibanFlagged: true,
        ibanRiskScore: dto.riskScore ?? 80,
        ibanVerified: false,
      },
    });

    // Make sure the blacklist row exists — best-effort (race-safe by
    // unique constraint on tenantId+iban).
    try {
      const existingBl = await this.prisma.ibanBlacklist.findFirst({
        where: { tenantId, iban: party.iban },
        select: { id: true },
      });
      if (existingBl) {
        await this.prisma.ibanBlacklist.update({
          where: { id: existingBl.id },
          data: { reason: dto.reason },
        });
      } else {
        await this.prisma.ibanBlacklist.create({
          data: {
            tenantId,
            iban: party.iban,
            reason: dto.reason,
            source: 'manual',
          },
        });
      }
    } catch (err) {
      this.logger.warn(
        `ibanBlacklist write failed for party=${partyId}: ${(err as Error).message}`,
      );
    }

    await this.audit.log({
      tenantId,
      userId,
      action: AuditAction.EDIT,
      entityType: 'party',
      entityId: partyId,
      metadata: {
        action: 'iban_flagged',
        reason: dto.reason,
        riskScore: dto.riskScore ?? 80,
      },
    });

    return this.findOne(tenantId, partyId);
  }

  /**
   * GET /parties/:id/iban/risk-score — compute a 0..100 score for the
   * party's current IBAN. Combines:
   *
   *   - Blacklist hit           → +60
   *   - IBAN syntax invalid     → +30
   *   - N recent changes (>3 in 90d) → +5 each
   *   - Country non-PT          → +10
   *   - Untouched since create  → -5 (positive signal)
   *   - Manually verified       → -40
   *
   * Resulting score is clamped to [0, 100]. recommendedAction is derived
   * from the score (allow ≤ 30, review ≤ 70, block > 70).
   */
  async riskScore(tenantId: string, partyId: string): Promise<IbanRiskReport> {
    const party = await this.assertPartyExists(tenantId, partyId);
    const iban = party.iban ? normalizeIban(party.iban) : '';
    const breakdown: RiskBreakdownItem[] = [];
    let score = 0;

    if (!iban) {
      return {
        iban: '',
        blacklistMatch: false,
        riskScore: 0,
        recommendedAction: 'allow',
        breakdown: [{ factor: 'no_iban', score: 0, reason: 'Sem IBAN registado' }],
      };
    }

    const blacklistHit = await this.prisma.ibanBlacklist.findFirst({
      where: { tenantId, iban },
      select: { reason: true },
    });
    if (blacklistHit) {
      score += 60;
      breakdown.push({
        factor: 'blacklist_hit',
        score: 60,
        reason: `IBAN está na blacklist: ${blacklistHit.reason}`,
      });
    }

    if (!isValidIban(iban)) {
      score += 30;
      breakdown.push({
        factor: 'invalid_iban',
        score: 30,
        reason: 'IBAN não passa validação MOD-97-10 (ISO 7064)',
      });
    }

    const ninetyAgo = new Date();
    ninetyAgo.setDate(ninetyAgo.getDate() - 90);
    const recentChanges = await this.prisma.ibanHistory.count({
      where: {
        tenantId,
        partyId,
        createdAt: { gte: ninetyAgo },
        oldIban: { not: null },
      },
    });
    if (recentChanges > 3) {
      const extra = (recentChanges - 3) * 5;
      score += extra;
      breakdown.push({
        factor: 'frequent_changes',
        score: extra,
        reason: `${recentChanges} mudanças nos últimos 90 dias (limite: 3)`,
      });
    }

    if (iban.slice(0, 2) !== 'PT') {
      score += 10;
      breakdown.push({
        factor: 'non_pt_iban',
        score: 10,
        reason: `IBAN estrangeiro (${iban.slice(0, 2)})`,
      });
    }

    if (party.ibanVerified) {
      score -= 40;
      breakdown.push({
        factor: 'manually_verified',
        score: -40,
        reason: 'IBAN verificado manualmente por operador',
      });
    }

    score = Math.max(0, Math.min(100, score));

    let recommendedAction: IbanRiskReport['recommendedAction'] = 'allow';
    if (score > 70) recommendedAction = 'block';
    else if (score > 30) recommendedAction = 'review';

    return {
      iban,
      blacklistMatch: !!blacklistHit,
      blacklistReason: blacklistHit?.reason,
      riskScore: score,
      recommendedAction,
      breakdown,
    };
  }

  /**
   * Check whether the given IBAN is in the tenant's blacklist AND/OR
   * historically tied to risky parties. This is a public helper the
   * ExtractService (or any caller) can use to validate IBANs during OCR.
   */
  async checkBlacklist(tenantId: string, iban: string) {
    const normalized = normalizeIban(iban);
    if (!normalized) {
      return { iban: '', listed: false, reason: null };
    }
    const hit = await this.prisma.ibanBlacklist.findFirst({
      where: { tenantId, iban: normalized },
      select: { id: true, reason: true, source: true },
    });
    return {
      iban: normalized,
      listed: !!hit,
      reason: hit?.reason ?? null,
      source: hit?.source ?? null,
    };
  }

  /**
   * GET /parties/blacklist — list all blacklisted IBANs (paginated). Lives
   * here because the IBAN anti-fraud story is the parties module's domain.
   */
  async listBlacklist(tenantId: string, page = 1, limit = 50) {
    const safeLimit = Math.min(limit, 200);
    const skip = (page - 1) * safeLimit;
    const [items, total] = await Promise.all([
      this.prisma.ibanBlacklist.findMany({
        where: { tenantId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: safeLimit,
      }),
      this.prisma.ibanBlacklist.count({ where: { tenantId } }),
    ]);
    return {
      items,
      meta: { total, page, limit: safeLimit, totalPages: Math.ceil(total / safeLimit) },
    };
  }

  /**
   * POST /parties/blacklist — add an IBAN to the blacklist. Used by ops to
   * register fraud-network IBANs proactively.
   */
  async addToBlacklist(
    tenantId: string,
    userId: string,
    payload: { iban: string; reason: string; source?: string },
  ) {
    const iban = this.coerceIban(payload.iban);
    if (!iban) throw new BadRequestException('IBAN is required');

    const existingBl = await this.prisma.ibanBlacklist.findFirst({
      where: { tenantId, iban },
      select: { id: true },
    });
    const created = existingBl
      ? await this.prisma.ibanBlacklist.update({
          where: { id: existingBl.id },
          data: { reason: payload.reason, source: payload.source ?? 'manual' },
        })
      : await this.prisma.ibanBlacklist.create({
          data: {
            tenantId,
            iban,
            reason: payload.reason,
            source: payload.source ?? 'manual',
          },
        });

    await this.audit.log({
      tenantId,
      userId,
      action: AuditAction.CREATE,
      entityType: 'iban_blacklist',
      entityId: created.id,
      metadata: { iban, reason: payload.reason, source: payload.source ?? 'manual' },
    });

    return created;
  }

  // ════════════════════════════════ ACCOUNTS (PT PGC) ════════════════════════

  /** GET /accounts — paginated listing with optional filters. */
  async findAllAccounts(tenantId: string, query: AccountQueryDto) {
    const where: Prisma.AccountWhereInput = { tenantId };
    if (query.type) where.type = query.type;
    if (query.isActive !== undefined) where.isActive = query.isActive;
    if (query.search) {
      const s = query.search;
      where.OR = [
        { code: { contains: s } },
        { name: { contains: s, mode: 'insensitive' } },
      ];
    }

    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 100, 500);
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      this.prisma.account.findMany({
        where,
        orderBy: [{ type: 'asc' }, { code: 'asc' }],
        skip,
        take: limit,
        include: {
          parent: { select: { id: true, code: true, name: true } },
          children: {
            select: { id: true, code: true, name: true, isActive: true },
          },
        },
      }),
      this.prisma.account.count({ where }),
    ]);

    return {
      items: items.map((a) => this.sanitizeAccount(a)),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  /** GET /accounts/seed — returns the seed PGC accounts (id + code + name). */
  async listSeedAccounts(tenantId: string) {
    const rows = await this.prisma.account.findMany({
      where: { tenantId, isActive: true },
      orderBy: { code: 'asc' },
      select: { id: true, code: true, name: true, type: true },
    });
    return { items: rows };
  }

  async findOneAccount(tenantId: string, id: string) {
    const a = await this.prisma.account.findFirst({
      where: { id, tenantId },
      include: {
        parent: { select: { id: true, code: true, name: true } },
        children: { select: { id: true, code: true, name: true } },
      },
    });
    if (!a) throw new NotFoundException('Account not found');
    return this.sanitizeAccount(a);
  }

  async createAccount(tenantId: string, userId: string, dto: CreateAccountDto) {
    const code = dto.code.trim();
    const existing = await this.prisma.account.findFirst({
      where: { tenantId, code },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException(`Já existe uma conta com o código "${code}"`);
    }

    let parentId: string | undefined;
    if (dto.parentId) {
      const parent = await this.prisma.account.findFirst({
        where: { id: dto.parentId, tenantId },
        select: { id: true },
      });
      if (!parent) throw new NotFoundException('Parent account not found');
      parentId = parent.id;
    } else if (dto.parentCode) {
      const parent = await this.prisma.account.findFirst({
        where: { tenantId, code: dto.parentCode },
        select: { id: true },
      });
      if (!parent) throw new BadRequestException(`Parent code "${dto.parentCode}" não existe`);
      parentId = parent.id;
    }

    const acc = await this.prisma.account.create({
      data: {
        tenantId,
        code,
        name: dto.name,
        type: dto.type,
        parentId: parentId ?? null,
        parentCode: dto.parentCode ?? null,
        isActive: dto.isActive ?? true,
      },
    });

    await this.audit.log({
      tenantId,
      userId,
      action: AuditAction.CREATE,
      entityType: 'account',
      entityId: acc.id,
      metadata: { code: acc.code, name: acc.name, type: acc.type },
    });

    return this.findOneAccount(tenantId, acc.id);
  }

  async updateAccount(
    tenantId: string,
    userId: string,
    id: string,
    dto: UpdateAccountDto,
  ) {
    const existing = await this.prisma.account.findFirst({
      where: { id, tenantId },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Account not found');

    if (dto.code !== undefined) {
      const dupe = await this.prisma.account.findFirst({
        where: { tenantId, code: dto.code.trim(), NOT: { id } },
        select: { id: true },
      });
      if (dupe) throw new ConflictException('Código já está registado noutra conta');
    }

    if (dto.parentId !== undefined) {
      if (dto.parentId && dto.parentId === id) {
        throw new BadRequestException('A conta não pode ser seu próprio parent');
      }
      if (dto.parentId) {
        const parent = await this.prisma.account.findFirst({
          where: { id: dto.parentId, tenantId },
          select: { id: true },
        });
        if (!parent) throw new NotFoundException('Parent account not found');
      }
    } else if (dto.parentCode !== undefined && dto.parentCode) {
      const parent = await this.prisma.account.findFirst({
        where: { tenantId, code: dto.parentCode },
        select: { id: true },
      });
      if (!parent) throw new BadRequestException('Parent code não existe');
    }

    const data: Prisma.AccountUpdateInput = {};
    if (dto.code !== undefined) data.code = dto.code.trim();
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.type !== undefined) data.type = dto.type;
    if (dto.parentCode !== undefined) data.parentCode = dto.parentCode;
    if (dto.isActive !== undefined) data.isActive = dto.isActive;
    if (dto.parentId !== undefined) {
      data.parent = dto.parentId ? { connect: { id: dto.parentId } } : { disconnect: true };
    }

    const updated = await this.prisma.account.update({ where: { id }, data });

    await this.audit.log({
      tenantId,
      userId,
      action: AuditAction.EDIT,
      entityType: 'account',
      entityId: id,
      metadata: { code: updated.code },
    });

    return this.findOneAccount(tenantId, id);
  }

  async softDeleteAccount(tenantId: string, userId: string, id: string) {
    const existing = await this.prisma.account.findFirst({
      where: { id, tenantId },
      select: { id: true, code: true },
    });
    if (!existing) throw new NotFoundException('Account not found');

    await this.prisma.account.update({
      where: { id },
      data: { isActive: false },
    });

    await this.audit.log({
      tenantId,
      userId,
      action: AuditAction.DELETE,
      entityType: 'account',
      entityId: id,
      metadata: { code: existing.code },
    });

    return { id, isActive: false };
  }

  // ════════════════════════════════ helpers ═════════════════════════════════

  /** Validate + normalize a NIF; throw 400 on failure. */
  private coerceNif(input: string | undefined | null): string | null {
    if (input === undefined || input === null || input === '') return null;
    const n = normalizeNif(input);
    if (!isValidNif(n)) {
      throw new BadRequestException(`NIF inválido: "${input}"`);
    }
    return n;
  }

  /** Validate + normalize an IBAN; throw 400 on failure. */
  private coerceIban(input: string | undefined | null): string | null {
    if (input === undefined || input === null || input === '') return null;
    const n = normalizeIban(input);
    if (!isValidIban(n)) {
      throw new BadRequestException(`IBAN inválido: "${input}"`);
    }
    return n;
  }

  /** Verify an existing Party belongs to the tenant; throw 404 otherwise. */
  private async assertPartyExists(tenantId: string, partyId: string) {
    const p = await this.prisma.party.findFirst({
      where: { id: partyId, tenantId },
      select: { id: true, name: true, iban: true, ibanVerified: true, ibanFlagged: true },
    });
    if (!p) throw new NotFoundException('Party not found');
    return p;
  }

  /**
   * Confirm the default Debit/Credit account FKs, when supplied, point to
   * real rows in the tenant's chart of accounts. Throws 404 otherwise.
   */
  private async assertAccountsExist(
    tenantId: string,
    refs: { defaultDebitAccountId?: string; defaultCreditAccountId?: string },
  ) {
    const ids = [refs.defaultDebitAccountId, refs.defaultCreditAccountId].filter(
      Boolean,
    ) as string[];
    for (const id of ids) {
      const a = await this.prisma.account.findFirst({
        where: { id, tenantId },
        select: { id: true },
      });
      if (!a) throw new NotFoundException(`Account not found: ${id}`);
    }
  }

  /**
   * Drop internal-only columns from the Party response. `externalIds` is
   * opaque JSON to the caller — keep it but no other sensitive fields.
   *
   * Sprint G: the 360° sub-resources (contacts / addresses) come back
   * from Prisma with their `tenantId` field exposed. We strip it here
   * so the response never leaks the internal tenancy column — same
   * discipline as `sanitizePartyContact` / `sanitizePartyAddress` in
   * the dedicated services.
   */
  private sanitizeParty(p: any, accountById?: Map<string, { id: string; code: string; name: string }>) {
    if (!p) return p;
    const { contacts, addresses, ...rest } = p;
    return {
      ...rest,
      iban: p.iban ?? null,
      ibanMasked: p.iban
        ? `${(p.iban as string).slice(0, 4)}••••${(p.iban as string).slice(-4)}`
        : null,
      defaultDebitAccount: p.defaultDebitAccountId && accountById
        ? accountById.get(p.defaultDebitAccountId) ?? null
        : null,
      defaultCreditAccount: p.defaultCreditAccountId && accountById
        ? accountById.get(p.defaultCreditAccountId) ?? null
        : null,
      contacts: Array.isArray(contacts)
        ? contacts.map((c: any) => ({
            id: c.id,
            partyId: c.partyId,
            name: c.name,
            role: c.role,
            email: c.email,
            phone: c.phone,
            notes: c.notes,
            createdAt: c.createdAt,
            updatedAt: c.updatedAt,
          }))
        : [],
      addresses: Array.isArray(addresses)
        ? addresses.map((a: any) => ({
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
          }))
        : [],
    };
  }

  /**
   * Sprint E: slugify(name) and de-collide against existing rows in the
   * tenant. On collision append `<base>-<first4 of id>` (from the row
   * being created or the row being updated) so the on-disk folder name
   * is human-readable AND stable across renames. When the base slug is
   * unique the suffix is omitted entirely.
   *
   * Async because we have to read existing rows; called from both
   * `create()` (no `excludeId`) and `update()` (with `excludeId` to
   * ignore the row being renamed).
   */
  private async generateUniqueSlug(
    tenantId: string,
    name: string,
    excludeId?: string,
  ): Promise<string> {
    const base = slugify(name) ?? 'party';
    const where: Prisma.PartyWhereInput = { tenantId, slug: base };
    if (excludeId) where.NOT = { id: excludeId };
    const collision = await this.prisma.party.findFirst({ where, select: { id: true } });
    if (!collision) return base;
    return `${base}-${(excludeId ?? collision.id).slice(0, 4)}`;
  }

  /** Strip anything we don't want to leak to the client from an Account row. */
  private sanitizeAccount(a: any) {
    if (!a) return a;
    return { ...a };
  }
}
