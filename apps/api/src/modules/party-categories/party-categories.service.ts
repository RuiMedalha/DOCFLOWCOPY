import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CreatePartyCategoryDto,
  PartyCategoryQueryDto,
  UpdatePartyCategoryDto,
} from './dto/party-category.dto';

/**
 * Sprint E default PartyCategory buckets — every tenant gets these on first
 * access (mirrors CategoriesService.ensureSeedForTenant for `Category`).
 * The operator can edit colors / names later without breaking the FK link
 * from `parties.partyCategoryId`.
 */
const SEED_PARTY_CATEGORIES = [
  { name: 'Estratégico',        slug: 'estrategico', color: '#3B82F6', sortOrder: 10 },
  { name: 'Operacional',        slug: 'operacional', color: '#64748B', sortOrder: 20 },
  { name: 'Consultor / Serviços', slug: 'consultor', color: '#8B5CF6', sortOrder: 30 },
  { name: 'Recorrente',         slug: 'recorrente', color: '#10B981', sortOrder: 40 },
];

/**
 * PartyCategoriesService — CRUD for Sprint E's master-party classification.
 *
 * Distinct from CategoriesService (which classifies Documents by expense
 * type). A PartyCategory segments the master Party list and drives the
 * folder layout in `documents/storage/path-builder.ts`.
 */
@Injectable()
export class PartyCategoriesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Seed the four default buckets for a brand-new tenant. Idempotent —
   * no-op when the tenant already has at least one PartyCategory. Called
   * by the controller before `list` on every read so the UI always has
   * something to show.
   */
  async ensureSeedForTenant(tenantId: string): Promise<void> {
    const existing = await this.prisma.partyCategory.count({ where: { tenantId } });
    if (existing > 0) return;
    await this.prisma.partyCategory.createMany({
      data: SEED_PARTY_CATEGORIES.map((c) => ({ ...c, tenantId })),
    });
  }

  async list(tenantId: string, query: PartyCategoryQueryDto) {
    const where: { tenantId: string; OR?: object[] } = { tenantId };
    if (query.search) {
      where.OR = [
        { name: { contains: query.search, mode: 'insensitive' } },
        { slug: { contains: query.search.toLowerCase() } },
      ];
    }
    return this.prisma.partyCategory.findMany({
      where,
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  }

  async getOrThrow(tenantId: string, id: string) {
    const c = await this.prisma.partyCategory.findFirst({ where: { id, tenantId } });
    if (!c) throw new NotFoundException(`PartyCategory ${id} not found`);
    return c;
  }

  /**
   * Defensive FK helper used by `PartiesService.update()` when the caller
   * supplies a new `partyCategoryId`. Returns the row on success, throws
   * 404 if the category does not exist in the tenant. Never returns null.
   */
  async assertCategoryInTenant(tenantId: string, id: string) {
    const c = await this.prisma.partyCategory.findFirst({
      where: { id, tenantId },
      select: { id: true, slug: true, name: true, color: true, sortOrder: true },
    });
    if (!c) throw new NotFoundException(`PartyCategory ${id} not found in tenant`);
    return c;
  }

  async create(tenantId: string, dto: CreatePartyCategoryDto) {
    const dup = await this.prisma.partyCategory.findFirst({
      where: { tenantId, slug: dto.slug },
    });
    if (dup) {
      throw new ConflictException(
        `PartyCategory with slug "${dto.slug}" already exists in this tenant`,
      );
    }
    return this.prisma.partyCategory.create({
      data: {
        tenantId,
        name: dto.name,
        slug: dto.slug,
        color: dto.color ?? null,
        sortOrder: dto.sortOrder ?? 100,
      },
    });
  }

  async update(tenantId: string, id: string, dto: UpdatePartyCategoryDto) {
    await this.getOrThrow(tenantId, id);
    return this.prisma.partyCategory.update({
      where: { id },
      data: {
        name: dto.name,
        color: dto.color ?? undefined,
        sortOrder: dto.sortOrder,
      },
    });
  }

  async remove(tenantId: string, id: string) {
    await this.getOrThrow(tenantId, id);
    // FK on parties.partyCategoryId is ON DELETE SET NULL — deleting a
    // category clears the link on every party that used it but does not
    // delete those parties. Operators can reclassify without losing rows.
    await this.prisma.partyCategory.delete({ where: { id } });
  }
}
