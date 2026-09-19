import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateCategoryDto, UpdateCategoryDto } from './categories.dto';
import { CategoryNature } from '@prisma/client';

/**
 * Fase 4.1 — as categorias passam a ter natureza. A HotelEquip é
 * revendedora: a maioria das faturas é compra de mercadoria para
 * revenda, não despesa, e antes não havia sequer onde a arrumar. As três
 * primeiras entradas são novas por causa disso.
 *
 * A percentagem de dedução aqui é só o valor por defeito visível na
 * ficha da categoria — quem manda no cálculo é `resolveIvaDeductibility`
 * (natureza + categoria), para a regra ficar num sítio só.
 */
const SEED_CATEGORIES: Array<{
  name: string;
  slug: string;
  color: string;
  nature: CategoryNature;
  defaultIvaDeductibilityPct: number;
}> = [
  { name: 'Mercadorias para revenda', slug: 'mercadorias-revenda', color: '#0EA5E9', nature: 'MERCADORIAS_REVENDA', defaultIvaDeductibilityPct: 100 },
  { name: 'Matérias-primas e subsidiárias', slug: 'materias-primas', color: '#0891B2', nature: 'MATERIAS_PRIMAS_SUBSIDIARIAS', defaultIvaDeductibilityPct: 100 },
  { name: 'Equipamento e imobilizado', slug: 'imobilizado',      color: '#7C3AED', nature: 'IMOBILIZADO', defaultIvaDeductibilityPct: 100 },
  { name: 'Refeições',         slug: 'refeicoes',         color: '#F59E0B', nature: 'DESPESA_OPERACIONAL', defaultIvaDeductibilityPct: 50 },
  { name: 'Combustível',       slug: 'combustivel',       color: '#EF4444', nature: 'DESPESA_OPERACIONAL', defaultIvaDeductibilityPct: 50 },
  { name: 'Alojamento',        slug: 'alojamento',        color: '#8B5CF6', nature: 'DESPESA_OPERACIONAL', defaultIvaDeductibilityPct: 0 },
  { name: 'Deslocações',       slug: 'deslocacoes',       color: '#3B82F6', nature: 'DESPESA_OPERACIONAL', defaultIvaDeductibilityPct: 0 },
  { name: 'Material de escritório', slug: 'material-escritorio', color: '#10B981', nature: 'DESPESA_OPERACIONAL', defaultIvaDeductibilityPct: 100 },
  { name: 'Serviços / FSE',    slug: 'servicos-fse',      color: '#6366F1', nature: 'SERVICOS_EXTERNOS', defaultIvaDeductibilityPct: 100 },
  { name: 'Comunicações',      slug: 'comunicacoes',      color: '#14B8A6', nature: 'SERVICOS_EXTERNOS', defaultIvaDeductibilityPct: 100 },
  { name: 'Rendas',            slug: 'rendas',            color: '#A855F7', nature: 'SERVICOS_EXTERNOS', defaultIvaDeductibilityPct: 100 },
  { name: 'Seguros — Saúde',   slug: 'seguros-saude',     color: '#EC4899', nature: 'SERVICOS_EXTERNOS', defaultIvaDeductibilityPct: 0 },
  { name: 'Seguros — Trabalho', slug: 'seguros-trabalho', color: '#F43F5E', nature: 'SERVICOS_EXTERNOS', defaultIvaDeductibilityPct: 100 },
  { name: 'Seguros — Vida',    slug: 'seguros-vida',      color: '#FB7185', nature: 'SERVICOS_EXTERNOS', defaultIvaDeductibilityPct: 0 },
  { name: 'Seguros — Imóveis', slug: 'seguros-imoveis',   color: '#E11D48', nature: 'SERVICOS_EXTERNOS', defaultIvaDeductibilityPct: 100 },
  { name: 'Seguros — Viaturas', slug: 'seguros-viaturas', color: '#BE123C', nature: 'SERVICOS_EXTERNOS', defaultIvaDeductibilityPct: 100 },
  { name: 'Remunerações / Funcionários', slug: 'funcionarios-remuneracoes', color: '#10B981', nature: 'DESPESA_OPERACIONAL', defaultIvaDeductibilityPct: 0 },
  { name: 'Pagamentos ao Estado / Impostos', slug: 'pagamentos-estado', color: '#6366F1', nature: 'DESPESA_OPERACIONAL', defaultIvaDeductibilityPct: 0 },
  { name: 'Donativos',         slug: 'donativos',         color: '#8B5CF6', nature: 'DESPESA_OPERACIONAL', defaultIvaDeductibilityPct: 0 },
  { name: 'Outras',            slug: 'outras',            color: '#64748B', nature: 'DESPESA_OPERACIONAL', defaultIvaDeductibilityPct: 100 },
];

@Injectable()
export class CategoriesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Fase 4.1 — o seed passou a ser incremental. Os tenants criados antes
   * desta fase já tinham categorias e saíam daqui na primeira linha, sem
   * nunca ver "Mercadorias para revenda" — que é exactamente a categoria
   * que falta a uma revendedora. Agora acrescentamos o que falta por
   * slug e nunca mexemos no que o tenant já personalizou.
   */
  async ensureSeedForTenant(tenantId: string): Promise<void> {
    const existing = await this.prisma.category.findMany({
      where: { tenantId },
      select: { slug: true },
    });
    const have = new Set(existing.map((c) => c.slug));
    const missing = SEED_CATEGORIES.filter((c) => !have.has(c.slug));
    if (missing.length === 0) return;
    await this.prisma.category.createMany({
      data: missing.map((c) => ({ ...c, tenantId })),
      skipDuplicates: true,
    });
  }

  async list(tenantId: string) {
    const categories = await this.prisma.category.findMany({
      where: { tenantId },
      orderBy: { name: 'asc' },
    });
    if (categories.length > 0) return categories;

    await this.ensureSeedForTenant(tenantId);
    return this.prisma.category.findMany({
      where: { tenantId },
      orderBy: { name: 'asc' },
    });
  }

  async getOrThrow(tenantId: string, id: string) {
    const c = await this.prisma.category.findFirst({ where: { id, tenantId } });
    if (!c) throw new NotFoundException(`Category ${id} not found`);
    return c;
  }

  async create(tenantId: string, dto: CreateCategoryDto) {
    const dup = await this.prisma.category.findFirst({ where: { tenantId, slug: dto.slug } });
    if (dup) throw new ConflictException(`Category with slug "${dto.slug}" already exists in this tenant`);
    return this.prisma.category.create({
      data: { ...dto, tenantId },
    });
  }

  async update(tenantId: string, id: string, dto: UpdateCategoryDto) {
    await this.getOrThrow(tenantId, id);
    return this.prisma.category.update({ where: { id }, data: dto });
  }

  async remove(tenantId: string, id: string) {
    await this.getOrThrow(tenantId, id);
    await this.prisma.category.delete({ where: { id } });
  }
}
