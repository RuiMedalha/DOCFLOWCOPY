import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '@prisma/client';
import { normalizePartyName } from './party-identity';

export interface PartyMergeResult {
  targetId: string;
  sourceId: string;
  moved: Record<string, number>;
  /** Campos que a entidade de destino herdou por estarem vazios nela. */
  adopted: string[];
}

/**
 * Fase 4.1 — fundir entidades.
 *
 * Em produção o mesmo fornecedor ficou espalhado por várias Party (três
 * `CreateInfor`, duas `Fornecedor por identificar`), porque um NIF mal
 * lido pela IA não passava o módulo 11 e o resolver acabava a criar uma
 * entidade nova a cada documento. O `party-identity` já impede que isso
 * volte a acontecer; esta operação serve para corrigir o que já está
 * partido na base.
 *
 * A fusão move documentos, contactos, moradas, IBANs, estatísticas de
 * categoria e itens a pagar da origem para o destino, desativa a origem
 * (nunca apaga — o histórico fiscal tem de sobreviver) e deixa registo
 * na auditoria.
 */
@Injectable()
export class PartyMergeService {
  private readonly logger = new Logger(PartyMergeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async merge(
    tenantId: string,
    userId: string,
    targetId: string,
    sourceId: string,
  ): Promise<PartyMergeResult> {
    if (targetId === sourceId) {
      throw new BadRequestException('Não é possível fundir uma entidade consigo própria.');
    }

    const [target, source] = await Promise.all([
      this.prisma.party.findFirst({ where: { id: targetId, tenantId } }),
      this.prisma.party.findFirst({ where: { id: sourceId, tenantId } }),
    ]);
    if (!target) throw new NotFoundException(`Entidade de destino ${targetId} não encontrada.`);
    if (!source) throw new NotFoundException(`Entidade de origem ${sourceId} não encontrada.`);

    // Guarda-costas contra a fusão de fornecedores diferentes: exigimos
    // que partilhem o NIF ou o nome normalizado. Um erro aqui misturava
    // faturas de empresas distintas na contabilidade.
    const sameNif =
      Boolean(target.nif) && Boolean(source.nif) && target.nif === source.nif;
    const sameName =
      normalizePartyName(target.name).length > 0 &&
      normalizePartyName(target.name) === normalizePartyName(source.name);
    const oneHasNoNif = !target.nif || !source.nif;
    if (!sameNif && !(sameName && oneHasNoNif)) {
      throw new BadRequestException(
        `Recusado: "${source.name}" (NIF ${source.nif ?? '—'}) e "${target.name}" ` +
          `(NIF ${target.nif ?? '—'}) não partilham NIF nem nome normalizado. ` +
          'Fundir entidades diferentes corromperia a contabilidade.',
      );
    }

    const moved: Record<string, number> = {};
    const adopted: string[] = [];

    await this.prisma.$transaction(async (tx) => {
      const client = tx as unknown as Record<string, {
        updateMany?: (args: unknown) => Promise<{ count: number }>;
      }>;

      // Relações 1:N simples — mudam de dono sem conflito.
      for (const model of [
        'document',
        'partyContact',
        'partyAddress',
        'ibanHistory',
        'payableItem',
        'contact',
      ]) {
        const delegate = client[model];
        if (typeof delegate?.updateMany !== 'function') continue;
        try {
          const res = await delegate.updateMany({
            where: { partyId: sourceId },
            data: { partyId: targetId },
          });
          if (res.count > 0) moved[model] = res.count;
        } catch (err) {
          this.logger.warn(
            `[merge] could not move ${model} rows from ${sourceId}: ${(err as Error).message}`,
          );
        }
      }

      // PartyCategoryStat tem chave única (partyId, categoryId): somamos
      // as contagens na linha do destino em vez de mudar o dono às cegas.
      const stats = await tx.partyCategoryStat.findMany({ where: { partyId: sourceId } });
      let mergedStats = 0;
      for (const st of stats) {
        await tx.partyCategoryStat.upsert({
          where: { partyId_categoryId: { partyId: targetId, categoryId: st.categoryId } },
          create: {
            tenantId,
            partyId: targetId,
            categoryId: st.categoryId,
            approvedCount: st.approvedCount,
            lastApprovedAt: st.lastApprovedAt,
          },
          update: { approvedCount: { increment: st.approvedCount } },
        });
        mergedStats += 1;
      }
      if (stats.length > 0) {
        await tx.partyCategoryStat.deleteMany({ where: { partyId: sourceId } });
        moved.partyCategoryStat = mergedStats;
      }

      // O destino adota os campos que tem vazios — a fusão não pode
      // perder informação que só existia na origem.
      const inherit: Record<string, unknown> = {};
      const fields = [
        'nif', 'vatNumber', 'iban', 'email', 'phone', 'address', 'city',
        'postalCode', 'country', 'website', 'billingEmail', 'defaultCategoryId',
      ] as const;
      const t = target as unknown as Record<string, unknown>;
      const src = source as unknown as Record<string, unknown>;
      for (const f of fields) {
        if ((t[f] === null || t[f] === undefined || t[f] === '') && src[f]) {
          inherit[f] = src[f];
          adopted.push(f);
        }
      }
      if (Object.keys(inherit).length > 0) {
        await tx.party.update({ where: { id: targetId }, data: inherit });
      }

      // A origem é desativada, nunca apagada: mantemos o rasto de que
      // aquela entidade existiu e para onde foi.
      await tx.party.update({
        where: { id: sourceId },
        data: {
          isActive: false,
          notes: [
            source.notes?.trim(),
            `[Fase 4.1] Fundida em ${target.name} (${targetId}) em ${new Date().toISOString()}.`,
          ]
            .filter(Boolean)
            .join('\n')
            .slice(0, 2000),
        },
      });
    });

    await this.audit
      .log({
        tenantId,
        userId,
        action: AuditAction.EDIT,
        entityType: 'Party',
        entityId: targetId,
        metadata: {
          operation: 'merge',
          sourceId,
          sourceName: source.name,
          sourceNif: source.nif,
          targetName: target.name,
          targetNif: target.nif,
          moved,
          adopted,
        },
      })
      .catch((err: Error) =>
        this.logger.warn(`[merge] audit log failed: ${err.message}`),
      );

    this.logger.log(
      `[merge] party ${sourceId} ("${source.name}") → ${targetId} ("${target.name}") ` +
        `moved=${JSON.stringify(moved)} adopted=${adopted.join(',') || 'none'}`,
    );

    return { targetId, sourceId, moved, adopted };
  }

  /**
   * Sugere grupos de entidades que são o mesmo fornecedor — mesma chave
   * de nome normalizado + país (mesmo quando uma linha tem NIF e outra não),
   * ou o mesmo NIF. A linha com NIF é sugerida como destino.
   */
  async findDuplicates(tenantId: string) {
    const parties = await this.prisma.party.findMany({
      where: { tenantId, isActive: true },
      select: { id: true, name: true, nif: true, country: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });

    const parent = new Map<string, string>();
    const repNif = new Map<string, string | null>();

    for (const p of parties) {
      parent.set(p.id, p.id);
      repNif.set(p.id, p.nif || null);
    }

    const find = (id: string): string => {
      let root = id;
      while (root !== parent.get(root)) {
        root = parent.get(root)!;
      }
      let curr = id;
      while (curr !== root) {
        const nxt = parent.get(curr)!;
        parent.set(curr, root);
        curr = nxt;
      }
      return root;
    };

    const union = (id1: string, id2: string): boolean => {
      const root1 = find(id1);
      const root2 = find(id2);
      if (root1 === root2) return true;

      const nif1 = repNif.get(root1);
      const nif2 = repNif.get(root2);

      // Não une se ambos os componentes tiverem NIFs distintos não nulos
      if (nif1 && nif2 && nif1 !== nif2) {
        return false;
      }

      parent.set(root2, root1);
      repNif.set(root1, nif1 || nif2 || null);
      return true;
    };

    for (let i = 0; i < parties.length; i++) {
      const a = parties[i];
      const normA = normalizePartyName(a.name);
      const countryA = (a.country || 'PT').toUpperCase();

      for (let j = i + 1; j < parties.length; j++) {
        const b = parties[j];
        const countryB = (b.country || 'PT').toUpperCase();

        const sameNif = Boolean(a.nif) && Boolean(b.nif) && a.nif === b.nif;
        const sameName = normA.length > 0 && normA === normalizePartyName(b.name) && countryA === countryB;

        if (sameNif || sameName) {
          union(a.id, b.id);
        }
      }
    }

    const componentMap = new Map<string, typeof parties>();
    for (const p of parties) {
      const root = find(p.id);
      const bucket = componentMap.get(root) ?? [];
      bucket.push(p);
      componentMap.set(root, bucket);
    }

    const duplicateGroups = [...componentMap.values()]
      .filter((rows) => rows.length > 1)
      .map((rows) => {
        const withNif = rows.find((r) => r.nif);
        const target = withNif ?? rows[0];
        const key = target.nif
          ? `nif:${target.nif}`
          : `name:${target.country ?? 'PT'}:${normalizePartyName(target.name)}`;

        return {
          key,
          suggestedTargetId: target.id,
          parties: rows,
        };
      });

    return { groups: duplicateGroups };
  }
}
