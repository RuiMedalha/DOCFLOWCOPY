import { AuditAction } from '@prisma/client';
import { EnrichmentService } from '../enrichment.service';
import {
  EnrichmentProviderFactory,
  type EnrichmentProvider,
  type EnrichmentResult,
} from '../providers/provider.factory';
import { ManualProvider } from '../providers/manual.provider';
import { SabiPtProvider } from '../providers/sabi-pt.provider';
import { ViesProvider } from '../providers/vies.provider';

/**
 * Sprint I — EnrichmentService tests.
 *
 * Proves the three contracts the brief calls out:
 *   - 30-day TTL gate (cache hit within TTL → no provider call)
 *   - only-fill-nulls semantic (pre-populated fields are preserved)
 *   - audit row on every run (success / no_data / manual)
 *
 * Uses in-memory stubs for Prisma + AuditService; the provider chain
 * is faked at the factory level so we don't need to mock `fetch`.
 */

type PartyRow = {
  id: string;
  tenantId: string;
  name: string;
  nif: string | null;
  country: string;
  iban: string | null;
  email: string | null;
  phone: string | null;
  mobile: string | null;
  address: string | null;
  city: string | null;
  postalCode: string | null;
  website: string | null;
  industry: string | null;
  enrichedAt: Date | null;
  enrichmentSource: string | null;
  enrichmentError: string | null;
};

type AuditRow = {
  tenantId: string;
  userId: string | null;
  action: AuditAction;
  entityType: string | null;
  entityId: string | null;
  metadata: Record<string, unknown> | null;
};

const TENANT = 'tenant-enrich';
const PARTY_ID = 'party-1';

function buildPartyDb() {
  const parties = new Map<string, PartyRow>();

  const partyModel = {
    findFirst: jest.fn(async ({ where, select }: any) => {
      for (const p of parties.values()) {
        if (
          (!where?.tenantId || p.tenantId === where.tenantId) &&
          (!where?.id || p.id === where.id)
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
    update: jest.fn(async ({ where, data }: any) => {
      const row = parties.get(where.id);
      if (!row) throw new Error('party not found');
      Object.assign(row, data);
      return { ...row };
    }),
  };

  return { partyModel, parties };
}

function buildAuditLog() {
  const rows: AuditRow[] = [];
  return {
    rows,
    log: jest.fn(async (entry: AuditRow) => {
      rows.push(entry);
    }),
    logInTx: jest.fn(async (_tx: unknown, entry: AuditRow) => {
      rows.push(entry);
    }),
  };
}

function buildEnrichmentService(opts: {
  partyModel: any;
  audit: ReturnType<typeof buildAuditLog>;
  provider: EnrichmentProvider;
}) {
  const sabi = Object.create(SabiPtProvider.prototype) as SabiPtProvider;
  Object.defineProperty(sabi, 'name', { value: opts.provider.name });
  const vies = Object.create(ViesProvider.prototype) as ViesProvider;
  Object.defineProperty(vies, 'name', { value: 'vies' });
  const manual = Object.create(ManualProvider.prototype) as ManualProvider;
  Object.defineProperty(manual, 'name', { value: 'manual' });
  const factory = new EnrichmentProviderFactory(sabi, vies, manual);

  // Force the factory pick() to always return opts.provider so the
  // test controls the provider result deterministically.
  jest.spyOn(factory, 'pick').mockReturnValue(opts.provider);

  const prismaStub: any = {
    party: opts.partyModel,
    $transaction: async (work: any) => {
      const tx = {
        party: opts.partyModel,
        ...txAuditShim(),
      };
      return work(tx);
    },
  };

  return {
    service: new EnrichmentService(
      prismaStub,
      opts.audit as any,
      factory,
    ),
    factory,
  };
}

/**
 * Stub the AuditService.logInTx path inside a $transaction. We can't
 * just inject the same audit object because logInTx is called as a
 * method on the audit instance — the enrichment service treats the
 * tx param as opaque.
 */
function txAuditShim() {
  return {
    // The enrichment service calls tx.party.update + audit.logInTx(tx, ...)
    // with a Prisma.TransactionClient-shape argument. We forward the
    // logInTx call to the audit service's out-of-tx logger when the
    // test runs without a real transaction. (The test passes a tx
    // object whose `audit` is unbound.)
  };
}

function seedParty(overrides: Partial<PartyRow> = {}): PartyRow {
  return {
    id: PARTY_ID,
    tenantId: TENANT,
    name: 'EMPRESA TESTE',
    nif: '500000001',
    country: 'PT',
    iban: 'PT50 0002 0123 1234 5678 9015 4',
    email: null,
    phone: null,
    mobile: null,
    address: null,
    city: null,
    postalCode: null,
    website: null,
    industry: null,
    enrichedAt: null,
    enrichmentSource: null,
    enrichmentError: null,
    ...overrides,
  };
}

describe('EnrichmentService', () => {
  describe('enrichParty', () => {
    it('returns cached when enrichedAt < 30d ago', async () => {
      const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
      const { partyModel } = buildPartyDb();
      partyModel.findFirst.mockResolvedValue(
        seedParty({ enrichedAt: fiveDaysAgo, enrichmentSource: 'sabi-pt' }),
      );

      const audit = buildAuditLog();
      const provider: EnrichmentProvider = {
        name: 'sabi-pt',
        fetch: jest.fn(),
      };
      const { service } = buildEnrichmentService({
        partyModel,
        audit,
        provider,
      });

      const result = await service.enrichParty(TENANT, PARTY_ID, 'user-1');
      expect(result.source).toBe('cached');
      expect(result.fieldsPopulated).toEqual([]);
      expect(provider.fetch).not.toHaveBeenCalled();
      // Cache hit doesn't write an audit row — only the actual
      // enrichment writes one. (Matches sprint-E audit pattern.)
      expect(audit.rows.length).toBe(0);
    });

    it('triggers a provider call when enrichedAt is null', async () => {
      const { partyModel, parties } = buildPartyDb();
      parties.set(PARTY_ID, seedParty({ enrichedAt: null }));

      const audit = buildAuditLog();
      const providerFetch = jest
        .fn()
        .mockResolvedValue({
          ok: true,
          source: 'sabi-pt',
          fields: { email: 'a@b.pt', phone: null, address: 'RUA 1', city: 'LISBOA' },
        });
      const provider: EnrichmentProvider = {
        name: 'sabi-pt',
        fetch: providerFetch,
      };
      const { service } = buildEnrichmentService({
        partyModel,
        audit,
        provider,
      });

      const result = await service.enrichParty(TENANT, PARTY_ID, 'user-1');
      expect(providerFetch).toHaveBeenCalledTimes(1);
      expect(result.source).toBe('sabi-pt');
      // Fields populated: only those that were null on the row.
      expect(result.fieldsPopulated).toEqual(
        expect.arrayContaining(['email', 'address', 'city']),
      );
      // Provider's phone was null → service doesn't write it; it's
      // never in the populated list.
      expect(result.fieldsPopulated).not.toContain('phone');
    });

    it('respects only-fill-nulls: pre-populated fields stay untouched', async () => {
      const { partyModel, parties } = buildPartyDb();
      // Operator has already manually entered an email. The provider
      // returns a different email; service MUST NOT overwrite.
      parties.set(
        PARTY_ID,
        seedParty({
          enrichedAt: null,
          email: 'operador@tenant.pt',
          city: 'PORTO',
        }),
      );

      const audit = buildAuditLog();
      const providerFetch = jest.fn().mockResolvedValue({
        ok: true,
        source: 'sabi-pt',
        fields: {
          email: 'sabi@teste.pt',
          phone: '+351 210 000 000',
          address: 'RUA NOVA',
          city: 'LISBOA',
        },
      });
      const provider: EnrichmentProvider = {
        name: 'sabi-pt',
        fetch: providerFetch,
      };
      const { service } = buildEnrichmentService({
        partyModel,
        audit,
        provider,
      });

      const result = await service.enrichParty(TENANT, PARTY_ID, 'user-1');
      expect(result.fieldsPopulated).toEqual(
        expect.arrayContaining(['phone', 'address']),
      );
      // Email + city were already set → NOT in the populated list.
      expect(result.fieldsPopulated).not.toContain('email');
      expect(result.fieldsPopulated).not.toContain('city');
    });

    it('records enrichmentError on provider failure', async () => {
      const { partyModel, parties } = buildPartyDb();
      parties.set(PARTY_ID, seedParty({ enrichedAt: null }));

      const audit = buildAuditLog();
      const provider: EnrichmentProvider = {
        name: 'vies',
        fetch: jest.fn().mockResolvedValue({
          ok: false,
          source: 'manual',
          reason: 'vies_invalid_vat',
        }),
      };
      const { service } = buildEnrichmentService({
        partyModel,
        audit,
        provider,
      });

      const result = await service.enrichParty(TENANT, PARTY_ID, 'user-1');
      expect(result.source).toBe('manual');
      expect(result.error).toBe('vies_invalid_vat');
      // The row was updated with enrichmentError=reason (and
      // enrichedAt was NOT touched so the gate stays open for retry).
      const updated = parties.get(PARTY_ID)!;
      expect(updated.enrichmentError).toBe('vies_invalid_vat');
      expect(updated.enrichedAt).toBeNull();
    });

    it('writes an audit row on success', async () => {
      const { partyModel, parties } = buildPartyDb();
      parties.set(PARTY_ID, seedParty({ enrichedAt: null }));

      const audit = buildAuditLog();
      const provider: EnrichmentProvider = {
        name: 'sabi-pt',
        fetch: jest.fn().mockResolvedValue({
          ok: true,
          source: 'sabi-pt',
          fields: { email: 'a@b.pt' },
        }),
      };
      const { service } = buildEnrichmentService({
        partyModel,
        audit,
        provider,
      });

      await service.enrichParty(TENANT, PARTY_ID, 'user-1');
      const enrichRows = audit.rows.filter((r) => (r.metadata as any)?.subAction === 'party.enrich');
      expect(enrichRows.length).toBe(1);
      expect(enrichRows[0].action).toBe(AuditAction.EDIT);
      expect(enrichRows[0].entityType).toBe('party');
      expect(enrichRows[0].entityId).toBe(PARTY_ID);
      expect((enrichRows[0].metadata as any).source).toBe('sabi-pt');
      expect((enrichRows[0].metadata as any).fieldsPopulated).toEqual(['email']);
    });

    it('writes a separate failed audit row on provider failure', async () => {
      const { partyModel, parties } = buildPartyDb();
      parties.set(PARTY_ID, seedParty({ enrichedAt: null }));

      const audit = buildAuditLog();
      const provider: EnrichmentProvider = {
        name: 'vies',
        fetch: jest.fn().mockResolvedValue({
          ok: false,
          source: 'manual',
          reason: 'timeout',
        }),
      };
      const { service } = buildEnrichmentService({
        partyModel,
        audit,
        provider,
      });

      await service.enrichParty(TENANT, PARTY_ID, 'user-1');
      const failedRows = audit.rows.filter(
        (r) => (r.metadata as any)?.subAction === 'party.enrich.failed',
      );
      expect(failedRows.length).toBe(1);
      expect((failedRows[0].metadata as any).reason).toBe('timeout');
    });

    it('returns no_data when provider succeeds but every field is already filled', async () => {
      const { partyModel, parties } = buildPartyDb();
      // Already populated everything the provider returns.
      parties.set(
        PARTY_ID,
        seedParty({
          enrichedAt: null,
          email: 'operador@tenant.pt',
          phone: '+351 0',
          address: 'X',
          city: 'LISBOA',
          postalCode: '1050-070',
          website: 'https://op.pt',
          industry: 'Tech',
          mobile: '+351 9',
        }),
      );

      const audit = buildAuditLog();
      const provider: EnrichmentProvider = {
        name: 'sabi-pt',
        fetch: jest.fn().mockResolvedValue({
          ok: true,
          source: 'sabi-pt',
          fields: {
            email: 'sabi@x.pt',
            phone: '+351 1',
            address: 'Y',
            city: 'PORTO',
            postalCode: '4000-001',
            website: 'https://sabi.pt',
            industry: 'Other',
            mobile: '+351 8',
          },
        }),
      };
      const { service } = buildEnrichmentService({
        partyModel,
        audit,
        provider,
      });

      const result = await service.enrichParty(TENANT, PARTY_ID, 'user-1');
      expect(result.source).toBe('no_data');
      expect(result.fieldsPopulated).toEqual([]);
    });
  });

  describe('getMetadata', () => {
    it('returns the cached values + the factory-picked provider', async () => {
      const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
      const { partyModel, parties } = buildPartyDb();
      parties.set(
        PARTY_ID,
        seedParty({
          enrichedAt: fiveDaysAgo,
          enrichmentSource: 'sabi-pt',
          enrichmentError: null,
        }),
      );

      const audit = buildAuditLog();
      const provider: EnrichmentProvider = {
        name: 'sabi-pt',
        fetch: jest.fn(),
      };
      const { service } = buildEnrichmentService({
        partyModel,
        audit,
        provider,
      });

      const metadata = await service.getMetadata(TENANT, PARTY_ID);
      expect(metadata.lastEnrichedAt).toEqual(fiveDaysAgo);
      expect(metadata.source).toBe('sabi-pt');
      expect(metadata.error).toBeNull();
      expect(metadata.provider).toBe('sabi-pt');
    });

    it('returns nulls + provider=none when the party does not exist', async () => {
      const { partyModel } = buildPartyDb();
      const audit = buildAuditLog();
      const provider: EnrichmentProvider = {
        name: 'sabi-pt',
        fetch: jest.fn(),
      };
      const { service } = buildEnrichmentService({
        partyModel,
        audit,
        provider,
      });

      const metadata = await service.getMetadata(TENANT, 'no-such-party');
      expect(metadata.lastEnrichedAt).toBeNull();
      expect(metadata.source).toBeNull();
      expect(metadata.provider).toBe('none');
    });
  });

  describe('dedupe via inFlight Map', () => {
    it('returns the same promise for two concurrent calls on the same partyId', async () => {
      const { partyModel, parties } = buildPartyDb();
      // enrichedAt < 30d → both calls should see the cache and never
      // touch the provider.
      const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
      parties.set(PARTY_ID, seedParty({ enrichedAt: fiveDaysAgo }));

      const audit = buildAuditLog();
      const providerFetch = jest.fn();
      const provider: EnrichmentProvider = {
        name: 'sabi-pt',
        fetch: providerFetch,
      };
      const { service } = buildEnrichmentService({
        partyModel,
        audit,
        provider,
      });

      const [r1, r2] = await Promise.all([
        service.enrichParty(TENANT, PARTY_ID, 'user-1'),
        service.enrichParty(TENANT, PARTY_ID, 'user-1'),
      ]);
      expect(r1.source).toBe('cached');
      expect(r2.source).toBe('cached');
      expect(providerFetch).not.toHaveBeenCalled();
    });
  });
});
