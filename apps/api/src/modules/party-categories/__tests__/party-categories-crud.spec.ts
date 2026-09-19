import { ConflictException, NotFoundException } from '@nestjs/common';
import { PartyCategoriesService } from '../party-categories.service';

/**
 * CRUD contract for PartyCategoriesService. Mirrors the CategoriesService
 * pattern (Sprint B) — auto-seeds 4 default buckets for a fresh tenant,
 * refuses duplicate slugs in the same tenant, allows duplicates across
 * tenants (per-tenant isolation).
 */

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';

function buildPrisma(seed: Array<{ id: string; tenantId: string; slug: string; name: string; color: string | null; sortOrder: number }> = []) {
  const rows = new Map<string, any>(seed.map((r) => [r.id, { ...r }]));
  let counter = 0;
  const nextId = () => `pc-${++counter}`;

  const model = {
    findFirst: jest.fn(async ({ where, select }: any = {}) => {
      for (const row of rows.values()) {
        const matchTenant = !where?.tenantId || where.tenantId === row.tenantId;
        const matchSlug = !where?.slug || where.slug === row.slug;
        const matchId = !where?.id || where.id === row.id;
        if (matchTenant && matchSlug && matchId) {
          if (select) {
            const out: any = {};
            for (const k of Object.keys(select)) out[k] = row[k];
            return out;
          }
          return { ...row };
        }
      }
      return null;
    }),
    findMany: jest.fn(async ({ where, orderBy }: any = {}) => {
      let list = Array.from(rows.values()).filter(
        (r) => !where?.tenantId || r.tenantId === where.tenantId,
      );
      if (where?.OR) {
        list = list.filter((r) =>
          where.OR.some((clause: any) => {
            if (clause.name?.contains && r.name.toLowerCase().includes(clause.name.contains.toLowerCase())) return true;
            if (clause.slug?.contains && r.slug.includes(clause.slug.contains)) return true;
            return false;
          }),
        );
      }
      if (orderBy?.[0]?.sortOrder === 'asc') list.sort((a, b) => a.sortOrder - b.sortOrder);
      else if (orderBy?.[0]?.name === 'asc') list.sort((a, b) => a.name.localeCompare(b.name));
      return list.map((r) => ({ ...r }));
    }),
    count: jest.fn(async ({ where }: any = {}) => {
      return Array.from(rows.values()).filter(
        (r) => !where?.tenantId || r.tenantId === where.tenantId,
      ).length;
    }),
    create: jest.fn(async ({ data }: any) => {
      const id = nextId();
      const row = { ...data, createdAt: new Date(), updatedAt: new Date() };
      rows.set(id, row);
      return { ...row };
    }),
    createMany: jest.fn(async ({ data }: any) => {
      const arr = Array.isArray(data) ? data : [data];
      const created = arr.map((d: any) => {
        const id = nextId();
        const row = { ...d, id, createdAt: new Date(), updatedAt: new Date() };
        rows.set(id, row);
        return row;
      });
      return { count: created.length };
    }),
    update: jest.fn(async ({ where, data }: any) => {
      const row = rows.get(where.id);
      if (!row) throw new Error('not found');
      Object.assign(row, data);
      return { ...row };
    }),
    delete: jest.fn(async ({ where }: any) => {
      const row = rows.get(where.id);
      if (!row) throw new Error('not found');
      rows.delete(where.id);
      return { ...row };
    }),
  };

  return { partyCategory: model };
}

describe('PartyCategoriesService', () => {
  describe('ensureSeedForTenant', () => {
    it('seeds the four default buckets on first call', async () => {
      const prisma = buildPrisma();
      const svc = new PartyCategoriesService(prisma as any);
      await svc.ensureSeedForTenant(TENANT_A);
      expect(prisma.partyCategory.createMany).toHaveBeenCalledTimes(1);
      const list = await svc.list(TENANT_A, {});
      expect(list.map((c: any) => c.slug).sort()).toEqual([
        'consultor', 'estrategico', 'operacional', 'recorrente',
      ]);
    });

    it('is idempotent when the tenant already has categories', async () => {
      const prisma = buildPrisma([
        { id: 'pc-1', tenantId: TENANT_A, slug: 'estrategico', name: 'Estratégico', color: '#3B82F6', sortOrder: 10 },
      ]);
      const svc = new PartyCategoriesService(prisma as any);
      await svc.ensureSeedForTenant(TENANT_A);
      expect(prisma.partyCategory.createMany).not.toHaveBeenCalled();
    });
  });

  describe('CRUD', () => {
    it('creates a new category', async () => {
      const prisma = buildPrisma();
      const svc = new PartyCategoriesService(prisma as any);
      const created = await svc.create(TENANT_A, {
        name: 'Logística',
        slug: 'logistica',
        color: '#0EA5E9',
      });
      expect(created.slug).toBe('logistica');
      expect(created.color).toBe('#0EA5E9');
    });

    it('rejects duplicate slug in the same tenant', async () => {
      const prisma = buildPrisma([
        { id: 'pc-1', tenantId: TENANT_A, slug: 'logistica', name: 'Logística', color: null, sortOrder: 100 },
      ]);
      const svc = new PartyCategoriesService(prisma as any);
      await expect(
        svc.create(TENANT_A, { name: 'Logística 2', slug: 'logistica' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('allows the same slug across different tenants', async () => {
      const prisma = buildPrisma([
        { id: 'pc-1', tenantId: TENANT_A, slug: 'logistica', name: 'Logística', color: null, sortOrder: 100 },
      ]);
      const svc = new PartyCategoriesService(prisma as any);
      const created = await svc.create(TENANT_B, {
        name: 'Logística',
        slug: 'logistica',
      });
      expect(created.tenantId).toBe(TENANT_B);
      expect(created.slug).toBe('logistica');
    });

    it('throws 404 when updating a missing category', async () => {
      const prisma = buildPrisma();
      const svc = new PartyCategoriesService(prisma as any);
      await expect(
        svc.update(TENANT_A, 'missing', { name: 'X' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws 404 when deleting a missing category', async () => {
      const prisma = buildPrisma();
      const svc = new PartyCategoriesService(prisma as any);
      await expect(svc.remove(TENANT_A, 'missing')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('lists categories sorted by sortOrder then name', async () => {
      const prisma = buildPrisma([
        { id: 'pc-1', tenantId: TENANT_A, slug: 'consultor', name: 'Consultor', color: null, sortOrder: 30 },
        { id: 'pc-2', tenantId: TENANT_A, slug: 'estrategico', name: 'Estratégico', color: null, sortOrder: 10 },
      ]);
      const svc = new PartyCategoriesService(prisma as any);
      const list = await svc.list(TENANT_A, {});
      expect(list.map((c: any) => c.slug)).toEqual(['estrategico', 'consultor']);
    });
  });

  describe('assertCategoryInTenant', () => {
    it('returns the category when it exists in the tenant', async () => {
      const prisma = buildPrisma([
        { id: 'pc-1', tenantId: TENANT_A, slug: 'estrategico', name: 'Estratégico', color: '#3B82F6', sortOrder: 10 },
      ]);
      const svc = new PartyCategoriesService(prisma as any);
      const c = await svc.assertCategoryInTenant(TENANT_A, 'pc-1');
      expect(c.slug).toBe('estrategico');
    });

    it('throws 404 when the category belongs to another tenant', async () => {
      const prisma = buildPrisma([
        { id: 'pc-1', tenantId: TENANT_B, slug: 'estrategico', name: 'Estratégico', color: null, sortOrder: 10 },
      ]);
      const svc = new PartyCategoriesService(prisma as any);
      await expect(svc.assertCategoryInTenant(TENANT_A, 'pc-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
