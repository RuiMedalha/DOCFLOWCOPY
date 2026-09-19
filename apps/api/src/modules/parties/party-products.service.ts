import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Fase 4 — "produtos comprados" a um fornecedor: agrega as linhas
 * (DocumentItem) de todos os documentos vivos ligados ao Party.
 * Chave = código do artigo quando existe, senão a descrição normalizada.
 */
export interface PartyProduct {
  key: string;
  code: string | null;
  description: string;
  timesBought: number;
  totalQuantity: number;
  totalSpent: number;
  lastUnitPrice: number | null;
  lastDate: string | null;
  lastDocumentId: string | null;
}

export function aggregateProducts(
  items: Array<{
    code: string | null;
    description: string;
    quantity: number;
    unitPrice: number;
    total: number;
    docDate: Date | null;
    documentId: string;
  }>,
): PartyProduct[] {
  const map = new Map<string, PartyProduct & { _lastTs: number }>();
  for (const it of items) {
    const desc = (it.description ?? '').trim();
    const code = it.code?.trim() || null;
    const key = (code ?? desc).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ');
    if (!key) continue;
    const ts = it.docDate ? it.docDate.getTime() : 0;
    const cur = map.get(key) ?? {
      key, code, description: desc, timesBought: 0, totalQuantity: 0, totalSpent: 0,
      lastUnitPrice: null, lastDate: null, lastDocumentId: null, _lastTs: -1,
    };
    cur.timesBought += 1;
    cur.totalQuantity += Number(it.quantity) || 0;
    cur.totalSpent += Number(it.total) || 0;
    if (ts >= cur._lastTs) {
      cur._lastTs = ts;
      cur.lastUnitPrice = Number.isFinite(Number(it.unitPrice)) ? Number(it.unitPrice) : null;
      cur.lastDate = it.docDate ? it.docDate.toISOString().slice(0, 10) : cur.lastDate;
      cur.lastDocumentId = it.documentId;
      if (desc) cur.description = desc;
    }
    map.set(key, cur);
  }
  return [...map.values()]
    .map(({ _lastTs, ...p }) => ({ ...p, totalQuantity: Math.round(p.totalQuantity * 1000) / 1000, totalSpent: Math.round(p.totalSpent * 100) / 100 }))
    .sort((a, b) => b.totalSpent - a.totalSpent);
}

@Injectable()
export class PartyProductsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(tenantId: string, partyId: string): Promise<{ items: PartyProduct[]; documents: number }> {
    const rows = await this.prisma.documentItem.findMany({
      where: { document: { tenantId, partyId, deletedAt: null, status: { not: 'DUPLICADO' } } },
      select: {
        code: true,
        description: true,
        quantity: true,
        unitPrice: true,
        total: true,
        documentId: true,
        document: { select: { docDate: true } },
      },
      take: 5000,
    });
    const items = aggregateProducts(
      rows.map((r) => ({
        code: r.code,
        description: r.description,
        quantity: Number(r.quantity),
        unitPrice: Number(r.unitPrice),
        total: Number(r.total),
        docDate: r.document.docDate,
        documentId: r.documentId,
      })),
    );
    const documents = new Set(rows.map((r) => r.documentId)).size;
    return { items, documents };
  }
}
