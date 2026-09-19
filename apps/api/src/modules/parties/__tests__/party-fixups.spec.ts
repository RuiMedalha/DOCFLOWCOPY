import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { NotFoundException } from '@nestjs/common';
import { AuditAction } from '@prisma/client';

import { PartyTimelineService } from '../timeline/party-timeline.service';
import { PartyPaymentsService } from '../payments/party-payments.service';
import { PartyContactsService } from '../party-contacts.service';
import {
  CreatePartyContactDto,
} from '../dto/party-contact.dto';
import { CreatePartyAddressDto } from '../dto/party-address.dto';

/**
 * Sprint G review follow-up tests (5 advisories closed):
 *
 *   1. Timeline response does NOT include `document.fileKey` (advisory A1).
 *   2. Timeline + Payments throw 404 when partyId is cross-tenant
 *      (parity with contacts/addresses — advisory A2).
 *   3. `IsValidCountryCode` rejects unknown ISO 3166-1 alpha-2 codes
 *      (advisory §13-A).
 *
 * (Advisories §4-A throttle and §8-A permissive regex are validated at
 * the decorator/registry level rather than via unit tests — the throttle
 * bucket is a wiring concern, and the regex is intentionally permissive
 * so an assertion would lock in the wrong shape. See
 * SECURITY-AUDIT.md §4-A / §8-A for the rationale.)
 */

const TENANT_A = 'tenant-A';
const TENANT_B = 'tenant-B';
const PARTY_A = 'party-A';
const PARTY_OTHER_TENANT = 'party-other-tenant';

// ════════════════════════════════════════════════════════════════════════
//  FIX 1 (A1): timeline + payments responses must NOT carry fileKey
// ════════════════════════════════════════════════════════════════════════

describe('PartyTimelineService — fileKey strip (Sprint G review §A1)', () => {
  function buildPrisma(opts: {
    includeParty?: boolean;
    payments?: Array<{
      id: string;
      tenantId: string;
      documentId: string;
      document: { partyId: string; tenantId: string; id: string; docNumber: string };
    }>;
  } = {}) {
    const parties = opts.includeParty
      ? [{ id: PARTY_A, tenantId: TENANT_A }]
      : [];
    return {
      party: {
        findFirst: jest.fn(async ({ where }: any = {}) => {
          if (!where?.id || !where?.tenantId) return null;
          return parties.find((p) => p.id === where.id && p.tenantId === where.tenantId) ?? null;
        }),
      },
      auditLog: { findMany: jest.fn(async () => []) },
      paymentEvent: {
        findMany: jest.fn(async () =>
          (opts.payments ?? []).map((p) => ({
            id: p.id,
            tenantId: p.tenantId,
            documentId: p.documentId,
            dueDate: new Date('2026-09-04T10:00:00Z'),
            amount: { toString: () => '50.00' },
            status: 'PENDING',
            paidAt: null,
            paidAmount: null,
            paymentMethod: null,
            notes: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            document: p.document, // intentionally WITHOUT fileKey — mimics the new select
          })),
        ),
      },
      ibanHistory: { findMany: jest.fn(async () => []) },
      document: { findMany: jest.fn(async () => []) },
    };
  }

  it('payment event document payload never carries fileKey', async () => {
    const prisma = buildPrisma({
      includeParty: true,
      payments: [
        {
          id: 'p-1',
          tenantId: TENANT_A,
          documentId: 'doc-1',
          document: {
            partyId: PARTY_A,
            tenantId: TENANT_A,
            id: 'doc-1',
            docNumber: 'D-1',
          },
        },
      ],
    });
    const svc = new PartyTimelineService(prisma as any);
    const r = await svc.list(TENANT_A, PARTY_A);
    const payment = r.items.find((e: any) => e.type === 'payment');
    expect(payment).toBeDefined();
    expect((payment as any).document).toBeDefined();
    expect((payment as any).document).not.toHaveProperty('fileKey');
    expect((payment as any).document).toHaveProperty('id', 'doc-1');
    expect((payment as any).document).toHaveProperty('docNumber', 'D-1');
  });

  it('paymentEvent.findMany was called with `select` excluding fileKey', async () => {
    const prisma = buildPrisma({
      includeParty: true,
      payments: [
        {
          id: 'p-1',
          tenantId: TENANT_A,
          documentId: 'doc-1',
          document: { partyId: PARTY_A, tenantId: TENANT_A, id: 'doc-1', docNumber: 'D-1' },
        },
      ],
    });
    const svc = new PartyTimelineService(prisma as any);
    await svc.list(TENANT_A, PARTY_A);
    const call = (prisma.paymentEvent.findMany as jest.Mock).mock.calls[0][0];
    // The include.document.select MUST NOT contain fileKey
    expect(call.include.document.select).toEqual({ id: true, docNumber: true });
    expect(call.include.document.select).not.toHaveProperty('fileKey');
  });
});

describe('PartyPaymentsService — fileKey strip (Sprint G review §A1)', () => {
  function buildPrisma(opts: { includeParty?: boolean } = {}) {
    const parties = opts.includeParty
      ? [{ id: PARTY_A, tenantId: TENANT_A }]
      : [];
    return {
      party: {
        findFirst: jest.fn(async ({ where }: any = {}) => {
          if (!where?.id || !where?.tenantId) return null;
          return parties.find((p) => p.id === where.id && p.tenantId === where.tenantId) ?? null;
        }),
      },
      paymentEvent: {
        findMany: jest.fn(async () => [
          {
            id: 'ev-1',
            tenantId: TENANT_A,
            documentId: 'doc-1',
            dueDate: new Date('2026-09-04T10:00:00Z'),
            amount: { toString: () => '123.45' },
            status: 'PENDING',
            paidAt: null,
            paidAmount: null,
            paymentMethod: null,
            notes: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            document: { id: 'doc-1', docNumber: 'D-1' }, // NO fileKey
          },
        ]),
      },
    };
  }

  it('item.document never carries fileKey', async () => {
    const prisma = buildPrisma({ includeParty: true });
    const svc = new PartyPaymentsService(prisma as any);
    const r = await svc.list(TENANT_A, PARTY_A, undefined, 20);
    expect(r.items[0].document).toBeDefined();
    expect(r.items[0].document).not.toHaveProperty('fileKey');
    expect(r.items[0].document).toHaveProperty('id', 'doc-1');
    expect(r.items[0].document).toHaveProperty('docNumber', 'D-1');
  });

  it('paymentEvent.findMany was called with include.document.select excluding fileKey', async () => {
    const prisma = buildPrisma({ includeParty: true });
    const svc = new PartyPaymentsService(prisma as any);
    await svc.list(TENANT_A, PARTY_A, undefined, 20);
    const call = (prisma.paymentEvent.findMany as jest.Mock).mock.calls[0][0];
    expect(call.include.document.select).toEqual({ id: true, docNumber: true });
    expect(call.include.document.select).not.toHaveProperty('fileKey');
  });
});

// ════════════════════════════════════════════════════════════════════════
//  FIX 2 (A2): timeline + payments throw 404 when partyId is cross-tenant
// ════════════════════════════════════════════════════════════════════════

describe('PartyTimelineService — assertPartyInTenant parity (Sprint G review §A2)', () => {
  it('throws NotFoundException when partyId belongs to another tenant', async () => {
    const parties: Array<{ id: string; tenantId: string }> = [
      { id: PARTY_OTHER_TENANT, tenantId: TENANT_B },
    ];
    const prisma = {
      party: {
        findFirst: jest.fn(async ({ where }: any = {}) =>
          parties.find((p) => p.id === where.id && p.tenantId === where.tenantId) ?? null,
        ),
      },
      auditLog: { findMany: jest.fn() },
      paymentEvent: { findMany: jest.fn() },
      ibanHistory: { findMany: jest.fn() },
      document: { findMany: jest.fn() },
    };
    const svc = new PartyTimelineService(prisma as any);
    await expect(
      svc.list(TENANT_A, PARTY_OTHER_TENANT),
    ).rejects.toBeInstanceOf(NotFoundException);
    // Guard MUST run BEFORE the 4-source aggregation — none of the
    // `findMany` calls should have fired.
    expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
    expect(prisma.paymentEvent.findMany).not.toHaveBeenCalled();
    expect(prisma.ibanHistory.findMany).not.toHaveBeenCalled();
    expect(prisma.document.findMany).not.toHaveBeenCalled();
  });

  it('does NOT throw when partyId belongs to the calling tenant', async () => {
    const parties = [{ id: PARTY_A, tenantId: TENANT_A }];
    const prisma = {
      party: {
        findFirst: jest.fn(async ({ where }: any = {}) =>
          parties.find((p) => p.id === where.id && p.tenantId === where.tenantId) ?? null,
        ),
      },
      auditLog: { findMany: jest.fn(async () => []) },
      paymentEvent: { findMany: jest.fn(async () => []) },
      ibanHistory: { findMany: jest.fn(async () => []) },
      document: { findMany: jest.fn(async () => []) },
    };
    const svc = new PartyTimelineService(prisma as any);
    const r = await svc.list(TENANT_A, PARTY_A);
    expect(r.items).toEqual([]);
    expect(r.nextCursor).toBeNull();
  });
});

describe('PartyPaymentsService — assertPartyInTenant parity (Sprint G review §A2)', () => {
  it('throws NotFoundException when partyId belongs to another tenant', async () => {
    const parties = [{ id: PARTY_OTHER_TENANT, tenantId: TENANT_B }];
    const prisma = {
      party: {
        findFirst: jest.fn(async ({ where }: any = {}) =>
          parties.find((p) => p.id === where.id && p.tenantId === where.tenantId) ?? null,
        ),
      },
      paymentEvent: { findMany: jest.fn() },
    };
    const svc = new PartyPaymentsService(prisma as any);
    await expect(
      svc.list(TENANT_A, PARTY_OTHER_TENANT),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.paymentEvent.findMany).not.toHaveBeenCalled();
  });

  it('does NOT throw when partyId belongs to the calling tenant', async () => {
    const parties = [{ id: PARTY_A, tenantId: TENANT_A }];
    const prisma = {
      party: {
        findFirst: jest.fn(async ({ where }: any = {}) =>
          parties.find((p) => p.id === where.id && p.tenantId === where.tenantId) ?? null,
        ),
      },
      paymentEvent: { findMany: jest.fn(async () => []) },
    };
    const svc = new PartyPaymentsService(prisma as any);
    const r = await svc.list(TENANT_A, PARTY_A);
    expect(r.items).toEqual([]);
    expect(r.nextCursor).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════
//  FIX 5 (§13-A): IsValidCountryCode rejects unknown ISO 3166-1 alpha-2
// ════════════════════════════════════════════════════════════════════════

describe('IsValidCountryCode — DTO validation (Sprint G review §13-A)', () => {
  async function validateAddress(payload: Record<string, unknown>) {
    const dto = plainToInstance(CreatePartyAddressDto, payload);
    return validate(dto);
  }

  it('accepts ISO 3166-1 alpha-2 codes from the allow-list (PT, ES, US, BR)', async () => {
    for (const code of ['PT', 'ES', 'US', 'BR', 'FR', 'DE', 'GB']) {
      const errors = await validateAddress({
        type: 'BILLING',
        line1: 'Rua X',
        country: code,
      });
      const countryErrors = errors.filter((e) => e.property === 'country');
      expect(countryErrors).toEqual([]);
    }
  });

  it('lowercase input is upper-cased then accepted (Transform runs first)', async () => {
    const errors = await validateAddress({
      type: 'BILLING',
      line1: 'Rua X',
      country: 'pt',
    });
    expect(errors.filter((e) => e.property === 'country')).toEqual([]);
  });

  it('rejects unknown codes (XX, ZZ, EU, UK, etc.)', async () => {
    for (const code of ['XX', 'ZZ', 'EU', 'UK', 'P1', '1T']) {
      const errors = await validateAddress({
        type: 'BILLING',
        line1: 'Rua X',
        country: code,
      });
      const countryErrors = errors.filter((e) => e.property === 'country');
      expect(countryErrors.length).toBeGreaterThan(0);
    }
  });

  it('optional country (omitted) does not raise', async () => {
    const errors = await validateAddress({
      type: 'BILLING',
      line1: 'Rua X',
      // country intentionally omitted
    });
    expect(errors.filter((e) => e.property === 'country')).toEqual([]);
  });

  it('empty string is treated as "not set" (passes)', async () => {
    const errors = await validateAddress({
      type: 'BILLING',
      line1: 'Rua X',
      country: '',
    });
    expect(errors.filter((e) => e.property === 'country')).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════
//  Sanity: contacts + addresses services still work (no regression from
//  the throttle + ISO validator additions).
// ════════════════════════════════════════════════════════════════════════

describe('PartyContactsService — no regression after fix-ups', () => {
  function buildPrisma() {
    const contacts = new Map<string, any>();
    return {
      party: {
        findFirst: jest.fn(async ({ where }: any = {}) => ({
          id: where?.id,
          tenantId: where?.tenantId,
        })),
      },
      partyContact: {
        findMany: jest.fn(async () => []),
        findFirst: jest.fn(async () => null),
        create: jest.fn(async ({ data }: any) => {
          const row = { id: 'c-1', createdAt: new Date(), updatedAt: new Date(), ...data };
          contacts.set(row.id, row);
          return row;
        }),
        update: jest.fn(async ({ where, data }: any) => {
          const row = contacts.get(where.id);
          Object.assign(row, data);
          return row;
        }),
        delete: jest.fn(async ({ where }: any) => contacts.delete(where.id) ?? { id: where.id }),
      },
      $transaction: jest.fn(async (fn: any) => fn({
        partyContact: { create: jest.fn(), updateMany: jest.fn(), findFirst: jest.fn() },
      })),
    };
  }

  it('create() succeeds with a valid DTO', async () => {
    const prisma = buildPrisma();
    const audit = { log: jest.fn() };
    const svc = new PartyContactsService(prisma as any, audit as any);
    const dto = plainToInstance(CreatePartyContactDto, {
      name: 'Maria',
      email: 'maria@a.pt',
      phone: '+351 210 000 000',
    });
    const errors = await validate(dto);
    expect(errors).toEqual([]);
    const r = await svc.create(TENANT_A, 'user-1', PARTY_A, dto);
    expect(r).toHaveProperty('id', 'c-1');
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: AuditAction.CREATE }),
    );
  });
});
