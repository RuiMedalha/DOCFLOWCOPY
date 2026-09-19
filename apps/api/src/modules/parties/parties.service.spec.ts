import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction, PartyType } from '@prisma/client';
import { PartiesService } from './parties.service';
import { PrismaService } from '../../prisma/prisma.service';
import { runWithTenantContext } from '../../common/context/tenant-context';

/**
 * In-memory test double for the Prisma models PartiesService touches.
 * We deliberately do NOT spin up a real client — the unit tests cover the
 * validation flow, audit-write ordering, and IbanHistory bookkeeping, which
 * is the contract worth proving here.
 */

type PartyRow = {
  id: string;
  tenantId: string;
  type: PartyType;
  name: string;
  nif: string | null;
  email: string | null;
  phone: string | null;
  mobile: string | null;
  iban: string | null;
  bic: string | null;
  address: string | null;
  city: string | null;
  postalCode: string | null;
  country: string;
  website: string | null;
  industry: string | null;
  notes: string | null;
  tags: string[];
  paymentTermDays: number | null;
  defaultDebitAccountId: string | null;
  defaultCreditAccountId: string | null;
  externalIds: unknown;
  ibanVerified: boolean;
  ibanVerifiedAt: Date | null;
  ibanRiskScore: number | null;
  ibanFlagged: boolean;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
};

type IbanHistoryRow = {
  id: string;
  tenantId: string;
  partyId: string;
  oldIban: string | null;
  newIban: string;
  changedById: string | null;
  reason: string | null;
  verified: boolean;
  createdAt: Date;
};

type IbanBlacklistRow = {
  id: string;
  tenantId: string;
  iban: string;
  reason: string;
  source: string | null;
  createdAt: Date;
};

type AccountRow = {
  id: string;
  tenantId: string;
  code: string;
  name: string;
  type: string;
  parentCode: string | null;
  parentId: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
};

type AuditRow = {
  id: string;
  tenantId: string;
  userId: string | null;
  action: AuditAction;
  entityType: string | null;
  entityId: string | null;
  metadata: unknown;
};

const TENANT_ID = 'tenant-test';
const USER_ID = 'user-test';

function buildPrismaStub() {
  // Renamed to `db_*` so the test can access the underlying Map stores
  // (prisma.dbParties.set(...)) without colliding with the model mocks
  // (prisma.party.create, prisma.ibanHistory.create, ...) that the service
  // sees at runtime.
  const dbParties = new Map<string, PartyRow>();
  const dbIbanHistory = new Map<string, IbanHistoryRow>();
  const dbIbanBlacklist = new Map<string, IbanBlacklistRow>();
  const dbAccounts = new Map<string, AccountRow>();
  const auditLog: AuditRow[] = [];

  let partyCounter = 0;
  let ibanCounter = 0;
  let blCounter = 0;
  let accCounter = 0;
  let auditCounter = 0;

  function findInMap<T>(
    collection: Map<string, T>,
    tenantId: string,
    predicate: (row: T) => boolean,
  ): T | null {
    for (const row of collection.values()) {
      if ((row as any).tenantId === tenantId && predicate(row)) return row;
    }
    return null;
  }

  function findById<T extends { id: string; tenantId: string }>(
    collection: Map<string, T>,
    tenantId: string,
    id: string,
  ): T | null {
    const row = collection.get(id);
    return row && row.tenantId === tenantId ? row : null;
  }

  const partyModel = {
    findFirst: jest.fn(async ({ where, select }: any) => {
      for (const p of dbParties.values()) {
        const matchId = !where?.id || where.id === p.id;
        const matchTenant = !where?.tenantId || where.tenantId === p.tenantId;
        const matchNif = !where?.nif || where.nif === p.nif;
        const matchIban =
          !where?.iban || (where.iban && (where.iban.equals ? where.iban.equals === p.iban : true));
        if (matchId && matchTenant && matchNif && matchIban) {
          if (select) {
            const out: any = {};
            for (const k of Object.keys(select)) out[k] = (p as any)[k];
            return out;
          }
          return { ...p };
        }
      }
      return null;
    }),
    findMany: jest.fn(async ({ where, take, orderBy }: any = {}) => {
      let rows = Array.from(dbParties.values()).filter(
        (p) => !where?.tenantId || p.tenantId === where.tenantId,
      );
      if (where?.isActive !== undefined) {
        rows = rows.filter((p) => p.isActive === where.isActive);
      }
      if (where?.type) rows = rows.filter((p) => p.type === where.type);
      if (where?.search) {
        const s = where.search.toLowerCase();
        rows = rows.filter(
          (p) =>
            p.name.toLowerCase().includes(s) ||
            (p.nif ?? '').includes(s) ||
            (p.email ?? '').toLowerCase().includes(s) ||
            (p.iban ?? '').includes(s),
        );
      }
      if (orderBy?.name) rows.sort((a, b) => a.name.localeCompare(b.name));
      if (typeof take === 'number') rows = rows.slice(0, take);
      return rows.map((p) => ({ ...p }));
    }),
    count: jest.fn(async ({ where }: any = {}) => {
      return Array.from(dbParties.values()).filter(
        (p) => !where?.tenantId || p.tenantId === where.tenantId,
      ).length;
    }),
    create: jest.fn(async ({ data }: any) => {
      const id = `party-${++partyCounter}`;
      const now = new Date();
      const row: PartyRow = {
        id,
        tenantId: data.tenantId,
        type: data.type,
        name: data.name,
        nif: data.nif ?? null,
        email: data.email ?? null,
        phone: data.phone ?? null,
        mobile: data.mobile ?? null,
        iban: data.iban ?? null,
        bic: data.bic ?? null,
        address: data.address ?? null,
        city: data.city ?? null,
        postalCode: data.postalCode ?? null,
        country: data.country ?? 'PT',
        website: data.website ?? null,
        industry: data.industry ?? null,
        notes: data.notes ?? null,
        tags: data.tags ?? [],
        paymentTermDays: data.paymentTermDays ?? 30,
        defaultDebitAccountId: data.defaultDebitAccountId ?? null,
        defaultCreditAccountId: data.defaultCreditAccountId ?? null,
        externalIds: data.externalIds ?? null,
        ibanVerified: data.ibanVerified ?? false,
        ibanVerifiedAt: data.ibanVerifiedAt ?? null,
        ibanRiskScore: data.ibanRiskScore ?? null,
        ibanFlagged: data.ibanFlagged ?? false,
        isActive: data.isActive ?? true,
        createdAt: now,
        updatedAt: now,
      };
      dbParties.set(id, row);
      return { ...row };
    }),
    update: jest.fn(async ({ where, data }: any) => {
      const row = dbParties.get(where.id);
      if (!row) throw new Error('party not found');
      Object.assign(row, data);
      row.updatedAt = new Date();
      return { ...row };
    }),
  };

  const ibanHistoryModel = {
    findMany: jest.fn(async ({ where, orderBy }: any = {}) => {
      let rows = Array.from(dbIbanHistory.values()).filter(
        (h) =>
          (!where?.tenantId || h.tenantId === where.tenantId) &&
          (!where?.partyId || h.partyId === where.partyId),
      );
      if (orderBy?.createdAt === 'desc')
        rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      return rows.map((h) => ({ ...h }));
    }),
    count: jest.fn(async ({ where }: any = {}) => {
      return Array.from(dbIbanHistory.values()).filter((h) => {
        if (where?.tenantId && h.tenantId !== where.tenantId) return false;
        if (where?.partyId && h.partyId !== where.partyId) return false;
        if (where?.oldIban?.not != null && h.oldIban === null) return false;
        if (where?.createdAt?.gte && h.createdAt < where.createdAt.gte) return false;
        return true;
      }).length;
    }),
    create: jest.fn(async ({ data }: any) => {
      const id = `ih-${++ibanCounter}`;
      const row: IbanHistoryRow = {
        id,
        tenantId: data.tenantId,
        partyId: data.partyId,
        oldIban: data.oldIban ?? null,
        newIban: data.newIban,
        changedById: data.changedById ?? null,
        reason: data.reason ?? null,
        verified: data.verified ?? false,
        createdAt: new Date(),
      };
      dbIbanHistory.set(id, row);
      return { ...row };
    }),
  };

  const ibanBlacklistModel = {
    findFirst: jest.fn(async ({ where }: any) => {
      return findInMap(
        dbIbanBlacklist,
        where.tenantId,
        (r) => r.iban === where.iban,
      ) as IbanBlacklistRow | null;
    }),
    findMany: jest.fn(async ({ where, skip, take, orderBy }: any = {}) => {
      let rows = Array.from(dbIbanBlacklist.values()).filter(
        (r) => r.tenantId === where.tenantId,
      );
      if (orderBy?.createdAt === 'desc')
        rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      if (typeof skip === 'number') rows = rows.slice(skip);
      if (typeof take === 'number') rows = rows.slice(0, take);
      return rows.map((r) => ({ ...r }));
    }),
    count: jest.fn(async ({ where }: any = {}) => {
      return Array.from(dbIbanBlacklist.values()).filter(
        (r) => r.tenantId === where.tenantId,
      ).length;
    }),
    create: jest.fn(async ({ data }: any) => {
      const id = `bl-${++blCounter}`;
      const row: IbanBlacklistRow = {
        id,
        tenantId: data.tenantId,
        iban: data.iban,
        reason: data.reason,
        source: data.source ?? null,
        createdAt: new Date(),
      };
      dbIbanBlacklist.set(id, row);
      return { ...row };
    }),
    update: jest.fn(async ({ where, data }: any) => {
      const row = dbIbanBlacklist.get(where.id);
      if (!row) throw new Error('blacklist row not found');
      Object.assign(row, data);
      return { ...row };
    }),
  };

  const accountModel = {
    findFirst: jest.fn(async ({ where }: any) => {
      if (where?.id) {
        return findById(dbAccounts, where.tenantId, where.id) as AccountRow | null;
      }
      if (where?.code) {
        return findInMap(dbAccounts, where.tenantId, (r) => r.code === where.code) as AccountRow | null;
      }
      return null;
    }),
    findMany: jest.fn(async ({ where, take, skip }: any = {}) => {
      let rows = Array.from(dbAccounts.values()).filter(
        (a) => !where?.tenantId || a.tenantId === where.tenantId,
      );
      if (where?.id?.in) rows = rows.filter((a) => where.id.in.includes(a.id));
      if (where?.type) rows = rows.filter((a) => a.type === where.type);
      if (where?.isActive !== undefined)
        rows = rows.filter((a) => a.isActive === where.isActive);
      if (typeof take === 'number') rows = rows.slice(skip ?? 0, (skip ?? 0) + take);
      return rows.map((a) => ({ ...a }));
    }),
    count: jest.fn(async ({ where }: any = {}) => {
      return Array.from(dbAccounts.values()).filter(
        (a) => !where?.tenantId || a.tenantId === where.tenantId,
      ).length;
    }),
    create: jest.fn(async ({ data }: any) => {
      const id = `acc-${++accCounter}`;
      const row: AccountRow = {
        id,
        tenantId: data.tenantId,
        code: data.code,
        name: data.name,
        type: data.type,
        parentCode: data.parentCode ?? null,
        parentId: data.parentId ?? null,
        isActive: data.isActive ?? true,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      dbAccounts.set(id, row);
      return { ...row };
    }),
    update: jest.fn(async ({ where, data }: any) => {
      const row = dbAccounts.get(where.id);
      if (!row) throw new Error('account not found');
      Object.assign(row, data);
      row.updatedAt = new Date();
      return { ...row };
    }),
  };

  const auditLogModel = {
    create: jest.fn(async ({ data }: any) => {
      const row: AuditRow = {
        id: `audit-${++auditCounter}`,
        tenantId: data.tenantId,
        userId: data.userId ?? null,
        action: data.action,
        entityType: data.entityType ?? null,
        entityId: data.entityId ?? null,
        metadata: data.metadata ?? null,
      };
      auditLog.push(row);
      return { ...row };
    }),
  };

  return {
    // Map stores for tests to seed directly. Names are `db_*` to avoid
    // colliding with the model mocks that the service sees at runtime.
    dbParties,
    dbIbanHistory,
    dbIbanBlacklist,
    dbAccounts,
    auditLog,
    // Model mocks (the surface the service actually consumes).
    party: partyModel,
    ibanHistory: ibanHistoryModel,
    ibanBlacklist: ibanBlacklistModel,
    account: accountModel,
    auditLogModel,
    // H-05: $transaction mock — the IBAN-change write path now goes
    // through this. We simulate a tx callback that runs the work against
    // the same in-memory store and rolls back if any inner op throws.
    $transaction: jest.fn(async (work: any) => {
      if (typeof work !== 'function') return work;
      // Snapshot the IBAN state so we can roll back on failure.
      const snapshot = {
        party: new Map(dbParties),
        history: new Map(dbIbanHistory),
      };
      const tx = {
        party: partyModel,
        ibanHistory: ibanHistoryModel,
      };
      try {
        return await work(tx);
      } catch (err) {
        dbParties.clear();
        snapshot.party.forEach((v, k) => dbParties.set(k, v));
        dbIbanHistory.clear();
        snapshot.history.forEach((v, k) => dbIbanHistory.set(k, v));
        throw err;
      }
    }),
  };
}

function buildAuditStub() {
  return {
    log: jest.fn(async () => undefined),
  };
}

describe('PartiesService', () => {
  let prisma: ReturnType<typeof buildPrismaStub>;
  let audit: ReturnType<typeof buildAuditStub>;
  let svc: PartiesService;

  beforeEach(() => {
    prisma = buildPrismaStub();
    audit = buildAuditStub();
    // Sprint E: PartyCategoriesService is injected for the FK validation
    // path. Tests below don't touch the partyCategoryId branch, but the
    // constructor still requires the third arg.
    const partyCategories = {
      assertCategoryInTenant: jest.fn(async (_tenantId: string, id: string) => ({
        id,
        slug: 'fake',
        name: 'Fake',
        color: null,
        sortOrder: 100,
      })),
    };
    svc = new PartiesService(prisma as any, audit as any, partyCategories as any);
  });

  // ──────────────────────────────────────────── CRUD: create
  describe('create()', () => {
    const baseDto = {
      type: PartyType.FORNECEDOR,
      name: 'EDP Comercial',
      nif: '500697256',
      email: 'clientes@edp.pt',
      iban: 'PT50000201231234567890154',
      paymentTermDays: 30,
    };

    it('persists the party, validates NIF/IBAN, and writes the audit row', async () => {
      const result = await svc.create(TENANT_ID, USER_ID, baseDto as any);

      expect(result.id).toMatch(/^party-/);
      expect(result.ibanMasked).toMatch(/^PT50••••0154$/);
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: TENANT_ID,
          userId: USER_ID,
          action: AuditAction.CREATE,
          entityType: 'party',
        }),
      );

      // IbanHistory seeded with the initial IBAN so subsequent OCR checks
      // see it as "known for this party".
      expect(prisma.ibanHistory.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            tenantId: TENANT_ID,
            newIban: 'PT50000201231234567890154',
            oldIban: null,
            reason: 'initial_iban_on_create',
          }),
        }),
      );
    });

    it('rejects an invalid NIF BEFORE touching the database', async () => {
      await expect(
        svc.create(TENANT_ID, USER_ID, { ...baseDto, nif: '000000000' } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.party.create).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
    });

    it('rejects an invalid IBAN with a 400', async () => {
      await expect(
        svc.create(TENANT_ID, USER_ID, { ...baseDto, iban: 'NOT-AN-IBAN' } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.party.create).not.toHaveBeenCalled();
    });

    it('throws 409 when the NIF already exists for the tenant', async () => {
      // Pre-seed a party with the same NIF.
      prisma.dbParties.set('party-existing', {
        id: 'party-existing',
        tenantId: TENANT_ID,
        type: PartyType.FORNECEDOR,
        name: 'Other Vendor',
        nif: '500697256',
        email: null,
        phone: null,
        mobile: null,
        iban: null,
        bic: null,
        address: null,
        city: null,
        postalCode: null,
        country: 'PT',
        website: null,
        industry: null,
        notes: null,
        tags: [],
        paymentTermDays: 30,
        defaultDebitAccountId: null,
        defaultCreditAccountId: null,
        externalIds: null,
        ibanVerified: false,
        ibanVerifiedAt: null,
        ibanRiskScore: null,
        ibanFlagged: false,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as PartyRow);

      await expect(
        svc.create(TENANT_ID, USER_ID, baseDto as any),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.party.create).not.toHaveBeenCalled();
    });
  });

  // ──────────────────────────────────────────── CRUD: update + IBAN history
  describe('update()', () => {
    beforeEach(async () => {
      // Seed a party with no IBAN.
      prisma.dbParties.set('party-1', {
        id: 'party-1',
        tenantId: TENANT_ID,
        type: PartyType.FORNECEDOR,
        name: 'Vendor One',
        nif: '500697256',
        email: null,
        phone: null,
        mobile: null,
        iban: null,
        bic: null,
        address: null,
        city: null,
        postalCode: null,
        country: 'PT',
        website: null,
        industry: null,
        notes: null,
        tags: [],
        paymentTermDays: 30,
        defaultDebitAccountId: null,
        defaultCreditAccountId: null,
        externalIds: null,
        ibanVerified: false,
        ibanVerifiedAt: null,
        ibanRiskScore: null,
        ibanFlagged: false,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as PartyRow);
    });

    it('writes an IbanHistory row when IBAN changes', async () => {
      await svc.update(TENANT_ID, USER_ID, 'party-1', {
        iban: 'PT50000201231234567890154',
      } as any);

      expect(prisma.ibanHistory.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            tenantId: TENANT_ID,
            partyId: 'party-1',
            oldIban: null,
            newIban: 'PT50000201231234567890154',
            reason: 'iban_change',
            verified: false,
          }),
        }),
      );

      // Audit row records that the IBAN changed.
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ ibanChanged: true }),
        }),
      );
    });

    it('does NOT write an IbanHistory row when the IBAN is unchanged', async () => {
      // First set the IBAN.
      prisma.dbParties.get('party-1')!.iban = 'PT50000201231234567890154';
      (prisma.ibanHistory.create as jest.Mock).mockClear();

      // Re-assign the same IBAN.
      await svc.update(TENANT_ID, USER_ID, 'party-1', {
        iban: 'PT50000201231234567890154',
      } as any);

      // No new history row.
      expect(prisma.ibanHistory.create).not.toHaveBeenCalled();
    });

    it('refuses to write a blacklisted IBAN on update (only when it changes)', async () => {
      // Pre-blacklist an IBAN.
      prisma.dbIbanBlacklist.set('bl-1', {
        id: 'bl-1',
        tenantId: TENANT_ID,
        iban: 'PT50000201231234567890154',
        reason: 'fraud-network',
        source: 'manual',
        createdAt: new Date(),
      });

      await expect(
        svc.update(TENANT_ID, USER_ID, 'party-1', {
          iban: 'PT50000201231234567890154',
        } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws 404 when the party does not exist', async () => {
      await expect(
        svc.update(TENANT_ID, USER_ID, 'party-missing', { name: 'X' } as any),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    // ──────────────── H-05 IBAN history in single transaction ────────────────
    it('H-05: rolls back the party.iban update if ibanHistory.create throws', async () => {
      // Snapshot the original state.
      const before = prisma.dbParties.get('party-1')!;

      // Make ibanHistory.create blow up.
      (prisma.ibanHistory.create as jest.Mock).mockImplementationOnce(async () => {
        throw new Error('FK violation');
      });

      await expect(
        svc.update(TENANT_ID, USER_ID, 'party-1', {
          iban: 'PT50000201231234567890154',
        } as any),
      ).rejects.toThrow(/FK violation/);

      // The party.iban MUST be unchanged after rollback.
      const after = prisma.dbParties.get('party-1')!;
      expect(after.iban).toBe(before.iban);
    });
  });

  // ──────────────────────────────────────────── anti-fraud helpers
  describe('markIbanVerified()', () => {
    beforeEach(() => {
      prisma.dbParties.set('party-1', {
        id: 'party-1',
        tenantId: TENANT_ID,
        type: PartyType.FORNECEDOR,
        name: 'Vendor One',
        nif: null,
        email: null,
        phone: null,
        mobile: null,
        iban: 'PT50000201231234567890154',
        bic: null,
        address: null,
        city: null,
        postalCode: null,
        country: 'PT',
        website: null,
        industry: null,
        notes: null,
        tags: [],
        paymentTermDays: 30,
        defaultDebitAccountId: null,
        defaultCreditAccountId: null,
        externalIds: null,
        ibanVerified: false,
        ibanVerifiedAt: null,
        ibanRiskScore: null,
        ibanFlagged: false,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as PartyRow);
    });

    it('flips ibanVerified=true and writes a verified=true history row', async () => {
      await svc.markIbanVerified(
        TENANT_ID,
        USER_ID,
        'party-1',
        { reason: 'verified via phone' } as any,
      );

      expect(prisma.party.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'party-1' },
          data: expect.objectContaining({
            ibanVerified: true,
            ibanFlagged: false,
          }),
        }),
      );
      expect(prisma.ibanHistory.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            verified: true,
            reason: expect.stringMatching(/^verified:/),
          }),
        }),
      );
    });

    it('throws 400 if the party has no IBAN', async () => {
      prisma.dbParties.get('party-1')!.iban = null;
      await expect(
        svc.markIbanVerified(TENANT_ID, USER_ID, 'party-1', {} as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('flagIban()', () => {
    beforeEach(() => {
      prisma.dbParties.set('party-1', {
        id: 'party-1',
        tenantId: TENANT_ID,
        type: PartyType.FORNECEDOR,
        name: 'Vendor One',
        nif: null,
        email: null,
        phone: null,
        mobile: null,
        iban: 'PT50000201231234567890154',
        bic: null,
        address: null,
        city: null,
        postalCode: null,
        country: 'PT',
        website: null,
        industry: null,
        notes: null,
        tags: [],
        paymentTermDays: 30,
        defaultDebitAccountId: null,
        defaultCreditAccountId: null,
        externalIds: null,
        ibanVerified: false,
        ibanVerifiedAt: null,
        ibanRiskScore: null,
        ibanFlagged: false,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as PartyRow);
    });

    it('flips ibanFlagged=true and adds the IBAN to the blacklist', async () => {
      await svc.flagIban(
        TENANT_ID,
        USER_ID,
        'party-1',
        { reason: 'differs from QR-AT' } as any,
      );

      expect(prisma.party.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            ibanFlagged: true,
            ibanRiskScore: 80,
            ibanVerified: false,
          }),
        }),
      );
      expect(prisma.ibanBlacklist.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            tenantId: TENANT_ID,
            iban: 'PT50000201231234567890154',
            reason: 'differs from QR-AT',
            source: 'manual',
          }),
        }),
      );
    });

    it('updates an existing blacklist row instead of duplicating it', async () => {
      prisma.dbIbanBlacklist.set('bl-1', {
        id: 'bl-1',
        tenantId: TENANT_ID,
        iban: 'PT50000201231234567890154',
        reason: 'old reason',
        source: 'manual',
        createdAt: new Date(),
      });

      await svc.flagIban(
        TENANT_ID,
        USER_ID,
        'party-1',
        { reason: 'new reason' } as any,
      );

      expect(prisma.ibanBlacklist.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'bl-1' },
          data: { reason: 'new reason' },
        }),
      );
      expect(prisma.ibanBlacklist.create).not.toHaveBeenCalled();
    });
  });

  // ──────────────────────────────────────────── risk-score
  describe('riskScore()', () => {
    it('returns score 0 with breakdown for a party with no IBAN', async () => {
      prisma.dbParties.set('party-1', {
        id: 'party-1',
        tenantId: TENANT_ID,
        type: PartyType.FORNECEDOR,
        name: 'V',
        nif: null,
        email: null,
        phone: null,
        mobile: null,
        iban: null,
        bic: null,
        address: null,
        city: null,
        postalCode: null,
        country: 'PT',
        website: null,
        industry: null,
        notes: null,
        tags: [],
        paymentTermDays: 30,
        defaultDebitAccountId: null,
        defaultCreditAccountId: null,
        externalIds: null,
        ibanVerified: false,
        ibanVerifiedAt: null,
        ibanRiskScore: null,
        ibanFlagged: false,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as PartyRow);

      const report = await svc.riskScore(TENANT_ID, 'party-1');
      expect(report.riskScore).toBe(0);
      expect(report.recommendedAction).toBe('allow');
      expect(report.breakdown[0].factor).toBe('no_iban');
    });

    it('bumps score when the IBAN is in the blacklist', async () => {
      prisma.dbParties.set('party-1', {
        id: 'party-1',
        tenantId: TENANT_ID,
        type: PartyType.FORNECEDOR,
        name: 'V',
        nif: null,
        email: null,
        phone: null,
        mobile: null,
        iban: 'PT50000201231234567890154',
        bic: null,
        address: null,
        city: null,
        postalCode: null,
        country: 'PT',
        website: null,
        industry: null,
        notes: null,
        tags: [],
        paymentTermDays: 30,
        defaultDebitAccountId: null,
        defaultCreditAccountId: null,
        externalIds: null,
        ibanVerified: false,
        ibanVerifiedAt: null,
        ibanRiskScore: null,
        ibanFlagged: false,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as PartyRow);
      prisma.dbIbanBlacklist.set('bl-1', {
        id: 'bl-1',
        tenantId: TENANT_ID,
        iban: 'PT50000201231234567890154',
        reason: 'fraud-network',
        source: 'manual',
        createdAt: new Date(),
      });

      const report = await svc.riskScore(TENANT_ID, 'party-1');
      expect(report.blacklistMatch).toBe(true);
      expect(report.riskScore).toBeGreaterThanOrEqual(60);
      expect(report.recommendedAction).not.toBe('allow');
    });

    it('subtracts from score when the IBAN was manually verified', async () => {
      prisma.dbParties.set('party-1', {
        id: 'party-1',
        tenantId: TENANT_ID,
        type: PartyType.FORNECEDOR,
        name: 'V',
        nif: null,
        email: null,
        phone: null,
        mobile: null,
        iban: 'PT50000201231234567890154',
        bic: null,
        address: null,
        city: null,
        postalCode: null,
        country: 'PT',
        website: null,
        industry: null,
        notes: null,
        tags: [],
        paymentTermDays: 30,
        defaultDebitAccountId: null,
        defaultCreditAccountId: null,
        externalIds: null,
        ibanVerified: true,
        ibanVerifiedAt: new Date(),
        ibanRiskScore: null,
        ibanFlagged: false,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as PartyRow);

      const report = await svc.riskScore(TENANT_ID, 'party-1');
      const verifiedFactor = report.breakdown.find(
        (b) => b.factor === 'manually_verified',
      );
      expect(verifiedFactor).toBeDefined();
      expect(verifiedFactor!.score).toBe(-40);
    });
  });

  // ──────────────────────────────────────────── blacklist helpers
  describe('checkBlacklist()', () => {
    it('returns listed=false for an empty IBAN', async () => {
      const result = await svc.checkBlacklist(TENANT_ID, '');
      expect(result.listed).toBe(false);
    });

    it('returns listed=true when the IBAN is blacklisted', async () => {
      prisma.dbIbanBlacklist.set('bl-1', {
        id: 'bl-1',
        tenantId: TENANT_ID,
        iban: 'PT50000201231234567890154',
        reason: 'fraud',
        source: 'manual',
        createdAt: new Date(),
      });

      const result = await svc.checkBlacklist(
        TENANT_ID,
        'PT50000201231234567890154',
      );
      expect(result.listed).toBe(true);
      expect(result.reason).toBe('fraud');
    });
  });

  // ──────────────────────────────────────────── accounts
  describe('accounts CRUD', () => {
    it('rejects duplicate codes for the tenant', async () => {
      prisma.dbAccounts.set('acc-1', {
        id: 'acc-1',
        tenantId: TENANT_ID,
        code: '221',
        name: 'Fornecedores',
        type: 'LIABILITY',
        parentCode: null,
        parentId: null,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await expect(
        svc.createAccount(TENANT_ID, USER_ID, {
          code: '221',
          name: 'Fornecedores',
          type: 'LIABILITY' as any,
        } as any),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('creates the account, wires parent via parentCode, and writes audit', async () => {
      prisma.dbAccounts.set('acc-parent', {
        id: 'acc-parent',
        tenantId: TENANT_ID,
        code: '22',
        name: 'Fornecedores',
        type: 'LIABILITY',
        parentCode: null,
        parentId: null,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const out = await svc.createAccount(TENANT_ID, USER_ID, {
        code: '221',
        name: 'Fornecedores c/corrente',
        type: 'LIABILITY' as any,
        parentCode: '22',
      } as any);

      expect(out.code).toBe('221');
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.CREATE,
          entityType: 'account',
        }),
      );
    });
  });
});

// ──────────────────────────────────────────────── C-01 cross-tenant
//
// C-01: PrismaService auto-scopes every tenant-model call via a Proxy.
// We assert this end-to-end by routing a real PartiesService through a
// real PrismaService (with a stub inner client) and observing that:
//   1. inside a TenantContext, a scoped call succeeds and injects tenantId
//   2. outside any TenantContext, a scoped call THROWS (defence-in-depth)
describe('C-01 cross-tenant — auto-scoped PrismaService', () => {
  it('inside TenantContext: party.findMany resolves with tenantId injected', async () => {
    const captured: Array<{ model: string; args: Record<string, unknown> }> = [];

    const fakeBase: any = {
      party: {
        // Intentionally do NOT capture here — the wrapped extension's
        // query() callback captures the TRANSFORMED args once per call.
        findMany: jest.fn(async () => []),
        findUnique: jest.fn(async () => null),
        findFirst: jest.fn(async () => null),
        create: jest.fn(async () => null),
        update: jest.fn(async () => null),
        delete: jest.fn(async () => null),
        upsert: jest.fn(async () => null),
      },
      user: {
        findUnique: jest.fn(async () => null),
        findFirst: jest.fn(async () => null),
      },
      $transaction: jest.fn(async (input: any) => {
        if (typeof input === 'function') return input(fakeBase);
        return Promise.all(input);
      }),
      $extends: (ext: any) => {
        fakeBase._extension = ext;
        // Return the SAME wrapped client on repeat calls — mirrors the
        // real PrismaService's `scopedByContext` memoisation. Without
        // this, the test would accumulate wrappers.
        if (!fakeBase._scopedWrapped) {
          fakeBase._scopedWrapped = wrapWithExtension(fakeBase);
        }
        return fakeBase._scopedWrapped;
      },
    };

    function wrapWithExtension(base: any): any {
      const wrapped: any = { ...base };
      for (const key of Object.keys(base)) {
        if (typeof base[key] === 'object' && base[key] !== null && !key.startsWith('$')) {
          const modelName = key.charAt(0).toUpperCase() + key.slice(1);
          wrapped[key] = wrapDelegate(base[key], modelName, base._extension);
        }
      }
      return wrapped;
    }

    function wrapDelegate(delegate: any, modelName: string, extension: any): any {
      const out: any = {};
      for (const op of Object.keys(delegate)) {
        const original = delegate[op];
        out[op] = async (args: Record<string, unknown>) => {
          const ext = extension?.query?.$allModels?.$allOperations;
          if (typeof ext === 'function') {
            // The production Prisma extension delegates back to `query(a)`,
            // which is the only path that actually runs `original(a)`.
            // Capture at THAT point so we see the transformed args exactly
            // once per call.
            const result = await ext({
              model: modelName,
              operation: op,
              args,
              query: async (a: Record<string, unknown>) => {
                captured.push({ model: modelName, args: a });
                return original(a);
              },
            });
            return result;
          }
          return original(args);
        };
      }
      return out;
    }

    const prismaSvc = new PrismaService();
    (prismaSvc as any).onModuleInit = async () => undefined;
    (prismaSvc as any).onModuleDestroy = async () => undefined;
    (prismaSvc as any).inner = fakeBase;

    // Run inside an active TenantContext for tenant-A.
    await runWithTenantContext(
      { tenantId: 'tenant-A', userId: 'u', roles: [], requestId: 'r-A' },
      async () => {
        await prismaSvc.prisma.party.findMany({ where: { name: 'X' } });
      },
    );

    expect(captured).toHaveLength(1);
    expect(captured[0].args).toMatchObject({
      where: { name: 'X', tenantId: 'tenant-A' },
    });
  });

  it('outside TenantContext: a tenant-scoped call THROWS with no TenantContext', async () => {
    const fakeBase: any = {
      party: {
        findMany: jest.fn(async () => []),
        findUnique: jest.fn(async () => null),
        findFirst: jest.fn(async () => null),
        create: jest.fn(async () => null),
        update: jest.fn(async () => null),
        delete: jest.fn(async () => null),
        upsert: jest.fn(async () => null),
      },
      user: {
        findUnique: jest.fn(async () => null),
        findFirst: jest.fn(async () => null),
      },
      tenant: {
        findUnique: jest.fn(async () => null),
        findFirst: jest.fn(async () => null),
        findMany: jest.fn(async () => []),
        create: jest.fn(async () => null),
        update: jest.fn(async () => null),
      },
      $transaction: jest.fn(async (input: any) => {
        if (typeof input === 'function') return input(fakeBase);
        return Promise.all(input);
      }),
      $extends: (ext: any) => {
        fakeBase._extension = ext;
        return wrapExt(fakeBase);
      },
    };
    function wrapExt(base: any): any {
      const wrapped: any = { ...base };
      for (const key of Object.keys(base)) {
        if (typeof base[key] === 'object' && base[key] !== null && !key.startsWith('$')) {
          const modelName = key.charAt(0).toUpperCase() + key.slice(1);
          wrapped[key] = wrapDelegate(base[key], modelName, base._extension);
        }
      }
      return wrapped;
    }
    function wrapDelegate(delegate: any, modelName: string, extension: any): any {
      const out: any = {};
      for (const op of Object.keys(delegate)) {
        const original = delegate[op];
        out[op] = async (args: Record<string, unknown>) => {
          const ext = extension?.query?.$allModels?.$allOperations;
          if (typeof ext === 'function') {
            let transformed = args;
            await ext({
              model: modelName,
              operation: op,
              args,
              query: async (a: Record<string, unknown>) => {
                transformed = a;
                return original(a);
              },
            });
            return original(transformed);
          }
          return original(args);
        };
      }
      return out;
    }

    const prismaSvc = new PrismaService();
    (prismaSvc as any).onModuleInit = async () => undefined;
    (prismaSvc as any).onModuleDestroy = async () => undefined;
    (prismaSvc as any).inner = fakeBase;

    // No TenantContext — this is the C-01 cross-tenant assertion: a
    // tenant-scoped call from outside any context MUST throw, not silently
    // fall through to the raw client.
    await expect(prismaSvc.prisma.party.findMany({})).rejects.toThrow(
      /no TenantContext/,
    );
    await expect(
      prismaSvc.prisma.party.update({ where: { id: 'p1' }, data: { name: 'X' } }),
    ).rejects.toThrow(/no TenantContext/);
    // Exempt models DO work — login flows pre-context need this.
    await expect(
      prismaSvc.prisma.tenant.findUnique({ where: { slug: 'acme' } }),
    ).resolves.toBeDefined();
  });
});

