import {
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  PaymentStatus,
  Prisma,
} from '@prisma/client';
import { PaymentsService } from './payments.service';

/**
 * Unit tests for PaymentsService.
 *
 * We deliberately drive the service against a hand-rolled in-memory
 * Prisma stub rather than spinning up a real client — these tests
 * focus on:
 *
 *   - the approval flow (canApprovePayments flag, status transitions,
 *     audit log emissions)
 *   - the "mark paid" flow (must be approved first, status flips to
 *     PAID, audit row records the payment)
 *   - the SEPA export orchestration (builds pain.001, skips payables
 *     whose party has no IBAN, records the export as an audit row)
 *
 * The XML serialization itself is exhaustively tested in
 * iso20022-sepa.builder.spec.ts.
 */

const TENANT_ID = 'tenant-test';
const USER_ID = 'user-test';

// PT IBAN that passes MOD-97-10 (canonical fixture from @docflow/shared).
const VALID_PT_IBAN = 'PT50000201231234567890154';
const VALID_DEBTOR_IBAN = 'PT77003506510000000000739';

type PayableRow = {
  id: string;
  tenantId: string;
  documentId: string | null;
  partyId: string | null;
  description: string | null;
  amount: Prisma.Decimal | string | number;
  dueDate: Date | null;
  status: PaymentStatus;
  paidAt: Date | null;
  paidAmount: Prisma.Decimal | string | number | null;
  paymentMethod: string | null;
  paymentRef: string | null;
  bankTxId: string | null;
  notes: string | null;
  approvedById: string | null;
  approvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type ScheduleRow = {
  id: string;
  tenantId: string;
  title: string;
  description: string | null;
  amount: Prisma.Decimal | string | number;
  dueDate: Date;
  paymentDate: Date | null;
  status: PaymentStatus;
  category: string | null;
  paymentMethod: string | null;
  documentId: string | null;
  crmContactId: string | null;
  recurring: boolean;
  recurrenceType: string | null;
  recurrenceInterval: number | null;
  createdById: string;
  createdAt: Date;
  updatedAt: Date;
};

type PartyRow = {
  id: string;
  tenantId: string;
  name: string;
  nif: string | null;
  iban: string | null;
  bic: string | null;
  ibanFlagged: boolean;
  ibanVerified: boolean;
  isActive: boolean;
};

type DocumentRow = {
  id: string;
  tenantId: string;
  fileName: string;
  total: Prisma.Decimal | string | number | null;
  dueDate: Date | null;
  supplier: string | null;
  docNumber: string | null;
  atcud: string | null;
  partyId: string | null;
};

type TenantRow = {
  id: string;
  name: string;
  iban: string | null;
  bic: string | null;
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

function buildPrismaStub() {
  const dbPayables = new Map<string, PayableRow>();
  const dbSchedules = new Map<string, ScheduleRow>();
  const dbParties = new Map<string, PartyRow>();
  const dbBlacklist = new Map<string, { iban: string; reason: string }>();
  const dbDocuments = new Map<string, DocumentRow>();
  const dbTenants = new Map<string, TenantRow>();
  const auditLog: AuditRow[] = [];

  let pCounter = 0;
  let sCounter = 0;
  let auditCounter = 0;

  const payableModel = {
    findFirst: jest.fn(async ({ where, select }: any) => {
      for (const p of dbPayables.values()) {
        if (
          (!where?.id || where.id === p.id) &&
          (!where?.tenantId || where.tenantId === p.tenantId)
        ) {
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
    findMany: jest.fn(async ({ where, take, orderBy, skip }: any = {}) => {
      let rows = Array.from(dbPayables.values()).filter(
        (p) => !where?.tenantId || p.tenantId === where.tenantId,
      );
      if (where?.status) {
        if (typeof where.status === 'string') {
          rows = rows.filter((p) => p.status === where.status);
        } else if (where.status.in) {
          rows = rows.filter((p) => where.status.in.includes(p.status));
        }
      }
      if (where?.approvedAt?.not != null) {
        rows = rows.filter((p) => p.approvedAt != null);
      }
      if (where?.paidAt === null) {
        rows = rows.filter((p) => p.paidAt == null);
      }
      if (where?.id?.in) {
        rows = rows.filter((p) => where.id.in.includes(p.id));
      }
      if (where?.dueDate) {
        if (where.dueDate.lt) rows = rows.filter((p) => p.dueDate && p.dueDate < where.dueDate.lt);
        if (where.dueDate.gte) rows = rows.filter((p) => p.dueDate && p.dueDate >= where.dueDate.gte);
        if (where.dueDate.lte) rows = rows.filter((p) => p.dueDate && p.dueDate <= where.dueDate.lte);
      }
      if (where?.partyId) {
        rows = rows.filter((p) => p.partyId === where.partyId);
      }
      if (orderBy?.dueDate === 'asc') {
        rows.sort((a, b) => {
          const at = a.dueDate?.getTime() ?? 0;
          const bt = b.dueDate?.getTime() ?? 0;
          return at - bt;
        });
      }
      if (typeof skip === 'number') rows = rows.slice(skip);
      if (typeof take === 'number') rows = rows.slice(0, take);
      return rows.map((r) => ({ ...r }));
    }),
    count: jest.fn(async ({ where }: any = {}) => {
      return Array.from(dbPayables.values()).filter(
        (p) => !where?.tenantId || p.tenantId === where.tenantId,
      ).length;
    }),
    create: jest.fn(async ({ data }: any) => {
      const id = `payable-${++pCounter}`;
      const now = new Date();
      const row: PayableRow = {
        id,
        tenantId: data.tenantId,
        documentId: data.documentId ?? null,
        partyId: data.partyId ?? null,
        description: data.description ?? null,
        amount: data.amount,
        dueDate: data.dueDate ?? null,
        status: data.status ?? PaymentStatus.TO_PAY,
        paidAt: data.paidAt ?? null,
        paidAmount: data.paidAmount ?? null,
        paymentMethod: data.paymentMethod ?? null,
        paymentRef: data.paymentRef ?? null,
        bankTxId: data.bankTxId ?? null,
        notes: data.notes ?? null,
        approvedById: data.approvedById ?? null,
        approvedAt: data.approvedAt ?? null,
        createdAt: now,
        updatedAt: now,
      };
      dbPayables.set(id, row);
      return { ...row };
    }),
    update: jest.fn(async ({ where, data }: any) => {
      const row = dbPayables.get(where.id);
      if (!row) throw new Error('payable not found');
      Object.assign(row, data);
      row.updatedAt = new Date();
      return { ...row };
    }),
  };

  const scheduleModel = {
    findFirst: jest.fn(async ({ where, select }: any) => {
      for (const s of dbSchedules.values()) {
        if (
          (!where?.id || where.id === s.id) &&
          (!where?.tenantId || where.tenantId === s.tenantId)
        ) {
          if (select) {
            const out: any = {};
            for (const k of Object.keys(select)) out[k] = (s as any)[k];
            return out;
          }
          return { ...s };
        }
      }
      return null;
    }),
    findMany: jest.fn(async ({ where, take, orderBy, skip }: any = {}) => {
      let rows = Array.from(dbSchedules.values()).filter(
        (s) => !where?.tenantId || s.tenantId === where.tenantId,
      );
      if (where?.status) {
        if (typeof where.status === 'string') rows = rows.filter((s) => s.status === where.status);
        else if (where.status.in) rows = rows.filter((s) => where.status.in.includes(s.status));
      }
      if (where?.crmContactId) rows = rows.filter((s) => s.crmContactId === where.crmContactId);
      if (where?.dueDate) {
        if (where.dueDate.gte) rows = rows.filter((s) => s.dueDate >= where.dueDate.gte);
        if (where.dueDate.lte) rows = rows.filter((s) => s.dueDate <= where.dueDate.lte);
      }
      if (where?.OR) {
        rows = rows.filter((s) =>
          where.OR.some((cond: any) => {
            if (cond.dueDate) {
              if (cond.dueDate.gte && cond.dueDate.lte) {
                return s.dueDate >= cond.dueDate.gte && s.dueDate <= cond.dueDate.lte;
              }
              if (cond.dueDate.lte) {
                return s.dueDate <= cond.dueDate.lte;
              }
            }
            if (cond.recurring && cond.dueDate?.lte) {
              return s.recurring && s.dueDate <= cond.dueDate.lte;
            }
            return false;
          }),
        );
      }
      if (orderBy?.dueDate === 'asc') {
        rows.sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime());
      }
      if (typeof skip === 'number') rows = rows.slice(skip);
      if (typeof take === 'number') rows = rows.slice(0, take);
      return rows.map((r) => ({ ...r }));
    }),
    count: jest.fn(async ({ where }: any = {}) => {
      return Array.from(dbSchedules.values()).filter(
        (s) => !where?.tenantId || s.tenantId === where.tenantId,
      ).length;
    }),
    create: jest.fn(async ({ data }: any) => {
      const id = `schedule-${++sCounter}`;
      const now = new Date();
      const row: ScheduleRow = {
        id,
        tenantId: data.tenantId,
        title: data.title,
        description: data.description ?? null,
        amount: data.amount,
        dueDate: data.dueDate,
        paymentDate: data.paymentDate ?? null,
        status: data.status ?? PaymentStatus.SCHEDULED,
        category: data.category ?? null,
        paymentMethod: data.paymentMethod ?? null,
        documentId: data.documentId ?? null,
        crmContactId: data.crmContactId ?? null,
        recurring: data.recurring ?? false,
        recurrenceType: data.recurrenceType ?? null,
        recurrenceInterval: data.recurrenceInterval ?? 1,
        createdById: data.createdById,
        createdAt: now,
        updatedAt: now,
      };
      dbSchedules.set(id, row);
      return { ...row };
    }),
    update: jest.fn(async ({ where, data }: any) => {
      const row = dbSchedules.get(where.id);
      if (!row) throw new Error('schedule not found');
      Object.assign(row, data);
      row.updatedAt = new Date();
      return { ...row };
    }),
  };

  const partyModel = {
    findFirst: jest.fn(async ({ where, select }: any) => {
      for (const p of dbParties.values()) {
        if (
          (!where?.id || where.id === p.id) &&
          (!where?.tenantId || where.tenantId === p.tenantId)
        ) {
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
    findMany: jest.fn(async ({ where }: any = {}) => {
      let rows = Array.from(dbParties.values()).filter(
        (p) => !where?.tenantId || p.tenantId === where.tenantId,
      );
      if (where?.id?.in) rows = rows.filter((p) => where.id.in.includes(p.id));
      return rows.map((r) => ({ ...r }));
    }),
  };

  // C-08: ibanBlacklist model for the SEPA export blacklist check.
  const ibanBlacklistModel = {
    findMany: jest.fn(async ({ where }: any = {}) => {
      let rows = Array.from(dbBlacklist.values()).filter(
        (b) => !where?.tenantId || b.tenantId === where.tenantId,
      );
      if (where?.iban?.in) rows = rows.filter((b) => where.iban.in.includes(b.iban));
      return rows;
    }),
  };

  const documentModel = {
    findFirst: jest.fn(async ({ where, select, include }: any) => {
      for (const d of dbDocuments.values()) {
        if (
          (!where?.id || where.id === d.id) &&
          (!where?.tenantId || where.tenantId === d.tenantId)
        ) {
          if (select) {
            const out: any = {};
            for (const k of Object.keys(select)) out[k] = (d as any)[k];
            return out;
          }
          if (include?.payableItems) {
            // Find existing payables for this document (used to enforce
            // uniqueness on createPayableFromDocument).
            const list = Array.from(dbPayables.values()).filter(
              (p) => p.documentId === d.id,
            );
            return { ...d, payableItems: list.slice(0, 1) };
          }
          return { ...d };
        }
      }
      return null;
    }),
    findMany: jest.fn(async ({ where }: any = {}) => {
      let rows = Array.from(dbDocuments.values()).filter(
        (d) => !where?.tenantId || d.tenantId === where.tenantId,
      );
      if (where?.id?.in) rows = rows.filter((d) => where.id.in.includes(d.id));
      return rows.map((r) => ({ ...r }));
    }),
  };

  const tenantModel = {
    findUnique: jest.fn(async ({ where, select }: any) => {
      const t = dbTenants.get(where.id);
      if (!t) return null;
      if (select) {
        const out: any = {};
        for (const k of Object.keys(select)) out[k] = (t as any)[k];
        return out;
      }
      return { ...t };
    }),
  };

  const auditModel = {
    log: jest.fn(async () => undefined),
  };

  return {
    dbPayables,
    dbSchedules,
    dbParties,
    dbBlacklist,
    dbDocuments,
    dbTenants,
    auditLog,
    payableItem: payableModel,
    paymentSchedule: scheduleModel,
    party: partyModel,
    document: documentModel,
    tenant: tenantModel,
    ibanBlacklist: ibanBlacklistModel,
    audit: auditModel,
  };
}

describe('PaymentsService', () => {
  let prisma: ReturnType<typeof buildPrismaStub>;
  let svc: PaymentsService;

  beforeEach(() => {
    prisma = buildPrismaStub();
    svc = new PaymentsService(prisma as any, prisma.audit as any);
  });

  // ─────────────────────────────────────────── APPROVAL FLOW ──────────────
  describe('approvePayable()', () => {
    function seedPayable(): PayableRow {
      const row: PayableRow = {
        id: 'payable-1',
        tenantId: TENANT_ID,
        documentId: null,
        partyId: 'party-1',
        description: 'Sample',
        amount: new Prisma.Decimal(1234.56),
        dueDate: new Date('2026-09-30'),
        status: PaymentStatus.TO_PAY,
        paidAt: null,
        paidAmount: null,
        paymentMethod: null,
        paymentRef: null,
        bankTxId: null,
        notes: null,
        approvedById: null,
        approvedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      prisma.dbPayables.set('payable-1', row);
      return row;
    }

    it('approves, flips status to SCHEDULED, and writes an APPROVE audit row', async () => {
      seedPayable();
      const result = await svc.approvePayable(
        TENANT_ID,
        USER_ID,
        'payable-1',
        { note: 'ok por telefone' } as any,
      );
      expect(result.status).toBe(PaymentStatus.SCHEDULED);
      expect(result.approvedAt).toBeTruthy();
      expect(result.approvedById).toBe(USER_ID);
      expect(prisma.audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: TENANT_ID,
          userId: USER_ID,
          action: AuditAction.APPROVE,
          entityType: 'payable_item',
          entityId: 'payable-1',
          metadata: expect.objectContaining({ note: 'ok por telefone' }),
        }),
      );
    });

    it('refuses to approve a payable that has already been approved', async () => {
      const row = seedPayable();
      row.approvedAt = new Date();
      row.approvedById = USER_ID;
      await expect(
        svc.approvePayable(TENANT_ID, USER_ID, 'payable-1', {} as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses to approve a payable that is already PAID', async () => {
      const row = seedPayable();
      row.status = PaymentStatus.PAID;
      await expect(
        svc.approvePayable(TENANT_ID, USER_ID, 'payable-1', {} as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws NotFound when the payable does not exist', async () => {
      await expect(
        svc.approvePayable(TENANT_ID, USER_ID, 'payable-missing', {} as any),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ─────────────────────────────────────────── MARK PAID FLOW ────────────
  describe('markPayablePaid()', () => {
    function seedApprovedPayable(): PayableRow {
      const row: PayableRow = {
        id: 'payable-1',
        tenantId: TENANT_ID,
        documentId: null,
        partyId: 'party-1',
        description: 'Sample',
        amount: new Prisma.Decimal(500),
        dueDate: new Date('2026-09-30'),
        status: PaymentStatus.SCHEDULED,
        paidAt: null,
        paidAmount: null,
        paymentMethod: null,
        paymentRef: null,
        bankTxId: null,
        notes: null,
        approvedById: USER_ID,
        approvedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      prisma.dbPayables.set('payable-1', row);
      return row;
    }

    it('flips status to PAID and writes a PAYMENT_CONFIRM audit row', async () => {
      seedApprovedPayable();
      const result = await svc.markPayablePaid(
        TENANT_ID,
        USER_ID,
        'payable-1',
        { paymentMethod: 'sepa', paymentRef: 'E2E-123' } as any,
      );
      expect(result.status).toBe(PaymentStatus.PAID);
      expect(result.paidAmount).toBe(500);
      expect(result.paymentMethod).toBe('sepa');
      expect(result.paymentRef).toBe('E2E-123');
      expect(prisma.audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.PAYMENT_CONFIRM,
          entityId: 'payable-1',
          metadata: expect.objectContaining({
            paidAmount: 500,
            paymentMethod: 'sepa',
            paymentRef: 'E2E-123',
          }),
        }),
      );
    });

    it('refuses to mark paid a payable that was never approved', async () => {
      const row = seedApprovedPayable();
      row.approvedAt = null;
      row.approvedById = null;
      await expect(
        svc.markPayablePaid(TENANT_ID, USER_ID, 'payable-1', {} as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses to mark paid a payable that is already PAID', async () => {
      const row = seedApprovedPayable();
      row.status = PaymentStatus.PAID;
      row.paidAt = new Date();
      await expect(
        svc.markPayablePaid(TENANT_ID, USER_ID, 'payable-1', {} as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    // ──────────────── C-09 amount validation ────────────────
    it('C-09: rejects paidAmount that differs from payable amount without partialReason', async () => {
      seedApprovedPayable(); // amount=500
      await expect(
        svc.markPayablePaid(TENANT_ID, USER_ID, 'payable-1', {
          paidAmount: 1,
        } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('C-09: accepts a partial payment when partialReason is provided', async () => {
      seedApprovedPayable(); // amount=500
      const result = await svc.markPayablePaid(TENANT_ID, USER_ID, 'payable-1', {
        paidAmount: 450,
        partialReason: 'fornecedor concedeu 50€ de desconto',
      } as any);
      expect(result.status).toBe(PaymentStatus.PAID);
      expect(result.paidAmount).toBe(450);
      expect(prisma.audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            paidAmount: 450,
            expectedAmount: 500,
            diff: 50,
            partialReason: 'fornecedor concedeu 50€ de desconto',
          }),
        }),
      );
    });

    it('C-09: tolerates sub-cent rounding differences without partialReason', async () => {
      seedApprovedPayable(); // amount=500
      // 0.005 difference is well below the 0.01 tolerance.
      const result = await svc.markPayablePaid(TENANT_ID, USER_ID, 'payable-1', {
        paidAmount: 500.005,
      } as any);
      expect(result.status).toBe(PaymentStatus.PAID);
      expect(result.paidAmount).toBeCloseTo(500.005, 3);
    });
  });

  // ─────────────────────────────────────────── SEPA EXPORT FLOW ──────────
  describe('exportSepa()', () => {
    function seedTenant() {
      prisma.dbTenants.set(TENANT_ID, {
        id: TENANT_ID,
        name: 'DocFlow Demo Lda',
        iban: VALID_DEBTOR_IBAN,
        bic: 'BCOMPTPL',
      });
    }
    function seedParty(id: string, iban: string | null, name = 'Vendor Co') {
      prisma.dbParties.set(id, {
        id,
        tenantId: TENANT_ID,
        name,
        nif: '500000000',
        iban,
        bic: 'BCOMPTPL',
        ibanFlagged: false,
        ibanVerified: true,
        isActive: true,
      });
    }
    function seedApprovedPayable(
      id: string,
      partyId: string,
      amount: number,
      status: PaymentStatus = PaymentStatus.SCHEDULED,
    ): PayableRow {
      const row: PayableRow = {
        id,
        tenantId: TENANT_ID,
        documentId: null,
        partyId,
        description: `Sample ${id}`,
        amount: new Prisma.Decimal(amount),
        dueDate: new Date('2026-09-30'),
        status,
        paidAt: null,
        paidAmount: null,
        paymentMethod: null,
        paymentRef: null,
        bankTxId: null,
        notes: null,
        approvedById: USER_ID,
        approvedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      prisma.dbPayables.set(id, row);
      return row;
    }

    it('produces a pain.001 XML that contains every approved payable', async () => {
      seedTenant();
      seedParty('party-1', VALID_PT_IBAN, 'EDP Comercial');
      seedApprovedPayable('payable-1', 'party-1', 100);
      seedApprovedPayable('payable-2', 'party-1', 250.5);

      const out = await svc.exportSepa(TENANT_ID, USER_ID, {} as any);

      expect(out.summary.numberOfTransactions).toBe(2);
      expect(out.summary.controlSum).toBeCloseTo(350.5, 2);
      expect(out.summary.payableIds).toEqual(['payable-1', 'payable-2']);
      expect(out.xml).toContain('<CstmrCdtTrfInitn>');
      expect(out.xml).toContain('<NbOfTxs>2</NbOfTxs>');
      expect(out.xml).toContain('<EndToEndId>payable-1</EndToEndId>');
      expect(out.xml).toContain('<EndToEndId>payable-2</EndToEndId>');
      expect(out.xml).toContain(`<IBAN>${VALID_PT_IBAN}</IBAN>`);
      // Audit row written as EXPORT.
      expect(prisma.audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.EXPORT,
          entityType: 'sepa_export',
        }),
      );
    });

    it('throws 400 when no approved payables match the filter', async () => {
      seedTenant();
      await expect(
        svc.exportSepa(TENANT_ID, USER_ID, {} as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws 400 when the tenant has no IBAN configured', async () => {
      seedTenant();
      prisma.dbTenants.set(TENANT_ID, {
        id: TENANT_ID,
        name: 'DocFlow Demo Lda',
        iban: null,
        bic: null,
      });
      seedParty('party-1', VALID_PT_IBAN);
      seedApprovedPayable('payable-1', 'party-1', 100);
      await expect(
        svc.exportSepa(TENANT_ID, USER_ID, {} as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('skips payables whose party has no IBAN and surfaces the skip in metadata', async () => {
      seedTenant();
      seedParty('party-1', VALID_PT_IBAN, 'Has IBAN');
      seedParty('party-2', null, 'No IBAN');
      seedApprovedPayable('payable-1', 'party-1', 100);
      seedApprovedPayable('payable-2', 'party-2', 200);

      const out = await svc.exportSepa(TENANT_ID, USER_ID, {} as any);

      // Only payable-1 ends up in the XML — payable-2 is skipped.
      expect(out.summary.payableIds).toEqual(['payable-1']);
      expect(out.xml).toContain('<NbOfTxs>1</NbOfTxs>');
      expect(prisma.audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            skipped: expect.arrayContaining([
              expect.objectContaining({ payableId: 'payable-2' }),
            ]),
          }),
        }),
      );
    });

    it('throws 400 when ALL payables are skipped because their parties have no IBAN', async () => {
      seedTenant();
      seedParty('party-1', null);
      seedApprovedPayable('payable-1', 'party-1', 100);
      await expect(
        svc.exportSepa(TENANT_ID, USER_ID, {} as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    // ──────────────── C-08 SEPA blacklist / ibanFlagged ────────────────
    it('C-08: skips a payable whose party has ibanFlagged=true', async () => {
      seedTenant();
      // Two parties so the file does not throw "all skipped".
      seedParty('party-1', VALID_PT_IBAN, 'Flagged Party');
      prisma.dbParties.get('party-1')!.ibanFlagged = true;
      // Use VALID_DEBTOR_IBAN-style second party so we have a clean export.
      seedParty('party-2', VALID_DEBTOR_IBAN, 'Clean Party');
      seedApprovedPayable('payable-1', 'party-1', 100);
      seedApprovedPayable('payable-2', 'party-2', 50);

      const out = await svc.exportSepa(TENANT_ID, USER_ID, {} as any);
      // payable-1 is flagged → skipped; payable-2 lands in the XML.
      expect(out.summary.payableIds).toEqual(['payable-2']);
      expect(out.xml).not.toContain('<EndToEndId>payable-1</EndToEndId>');
      expect(out.xml).toContain('<EndToEndId>payable-2</EndToEndId>');
      expect(prisma.audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            skipped: expect.arrayContaining([
              expect.objectContaining({
                payableId: 'payable-1',
                reason: expect.stringContaining('security'),
              }),
            ]),
          }),
        }),
      );
    });

    it('C-08: skips a payable whose IBAN is on the tenant blacklist', async () => {
      seedTenant();
      seedParty('party-1', VALID_PT_IBAN, 'Blacklisted Party');
      seedParty('party-2', VALID_DEBTOR_IBAN, 'Clean Party');
      // Blacklist the IBAN — same IBAN the party carries.
      prisma.dbBlacklist.set('blacklist-1', {
        tenantId: TENANT_ID,
        iban: VALID_PT_IBAN,
        reason: 'fraud-network',
      });
      seedApprovedPayable('payable-1', 'party-1', 250);
      seedApprovedPayable('payable-2', 'party-2', 50);

      const out = await svc.exportSepa(TENANT_ID, USER_ID, {} as any);
      expect(out.summary.payableIds).toEqual(['payable-2']);
      expect(out.xml).not.toContain(`<IBAN>${VALID_PT_IBAN}</IBAN>`);
      expect(prisma.audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            skipped: expect.arrayContaining([
              expect.objectContaining({
                payableId: 'payable-1',
                reason: 'security: creditor IBAN on blacklist',
              }),
            ]),
          }),
        }),
      );
    });
  });

  // ─────────────────────────────────────────── CREATE PAYABLE FROM DOC ────
  describe('createPayableFromDocument()', () => {
    function seedDocument() {
      prisma.dbDocuments.set('doc-1', {
        id: 'doc-1',
        tenantId: TENANT_ID,
        fileName: 'FT-2026-123.pdf',
        total: new Prisma.Decimal(500),
        dueDate: new Date('2026-09-15'),
        supplier: 'EDP Comercial SA',
        docNumber: 'FT 2026/123',
        atcud: 'ATCUD:ABC123',
        partyId: 'party-1',
      });
    }

    it('throws 409 (BadRequest) when the document already has a payable', async () => {
      seedDocument();
      prisma.dbPayables.set('payable-existing', {
        id: 'payable-existing',
        tenantId: TENANT_ID,
        documentId: 'doc-1',
        partyId: null,
        description: null,
        amount: new Prisma.Decimal(0),
        dueDate: null,
        status: PaymentStatus.TO_PAY,
        paidAt: null,
        paidAmount: null,
        paymentMethod: null,
        paymentRef: null,
        bankTxId: null,
        notes: null,
        approvedById: null,
        approvedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await expect(
        svc.createPayableFromDocument(TENANT_ID, USER_ID, {
          documentId: 'doc-1',
        } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('creates the payable using the document header fields', async () => {
      seedDocument();
      const result = await svc.createPayableFromDocument(TENANT_ID, USER_ID, {
        documentId: 'doc-1',
      } as any);
      expect(result.amount).toBe(500);
      expect(result.description).toContain('EDP Comercial');
      expect(result.description).toContain('FT 2026/123');
      expect(result.status).toBe(PaymentStatus.TO_PAY);
      expect(prisma.audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.CREATE,
          entityType: 'payable_item',
        }),
      );
    });
  });

  // ─────────────────────────────────────────── CALENDAR EXPANSION ────────
  describe('calendarView()', () => {
    it('expands a MONTHLY recurring schedule into the window', async () => {
      const base = new Date('2026-01-15');
      prisma.dbSchedules.set('schedule-1', {
        id: 'schedule-1',
        tenantId: TENANT_ID,
        title: 'Aluguer',
        description: null,
        amount: new Prisma.Decimal(1250),
        dueDate: base,
        paymentDate: null,
        status: PaymentStatus.SCHEDULED,
        category: 'rent',
        paymentMethod: 'transfer',
        documentId: null,
        crmContactId: null,
        recurring: true,
        recurrenceType: 'MONTHLY',
        recurrenceInterval: 1,
        createdById: USER_ID,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const out = await svc.calendarView(
        TENANT_ID,
        '2026-03-01',
        '2026-06-30',
      );

      const dueDates = (out.items as Array<{ dueDate: string }>).map((i) =>
        i.dueDate.slice(0, 10),
      );
      expect(dueDates).toEqual([
        '2026-03-15',
        '2026-04-15',
        '2026-05-15',
        '2026-06-15',
      ]);
    });

    it('marks past occurrences as OVERDUE when the source is still open', async () => {
      const base = new Date('2026-01-15');
      prisma.dbSchedules.set('schedule-1', {
        id: 'schedule-1',
        tenantId: TENANT_ID,
        title: 'Condomínio',
        description: null,
        amount: new Prisma.Decimal(150),
        dueDate: base,
        paymentDate: null,
        status: PaymentStatus.SCHEDULED,
        category: 'rent',
        paymentMethod: 'transfer',
        documentId: null,
        crmContactId: null,
        recurring: true,
        recurrenceType: 'MONTHLY',
        recurrenceInterval: 1,
        createdById: USER_ID,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const out = await svc.calendarView(TENANT_ID, '2026-08-01', '2026-11-30');

      const items = out.items as Array<{ dueDate: string; status: PaymentStatus }>;
      const aug = items.find((i) => i.dueDate.startsWith('2026-08-'));
      const oct = items.find((i) => i.dueDate.startsWith('2026-10-'));
      expect(aug?.status).toBe(PaymentStatus.OVERDUE);
      expect(oct?.status).toBe(PaymentStatus.SCHEDULED);
    });
  });
});
