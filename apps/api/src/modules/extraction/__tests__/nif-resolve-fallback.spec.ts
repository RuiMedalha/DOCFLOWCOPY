import {
  ExtractedFields,
  ExtractionService,
  StoragePort,
} from "../extraction.service";

// =============================================================================
// nif-resolve-fallback.spec.ts
//
// Pins the root-cause fix from DIAGNOSTIC-2 §5 item 7: when the AI's
// supplier NIF is structurally invalid AND the customer NIF resolves to
// an existing Party in this tenant, the customer Party is the actual
// supplier (AI swapped the slots). The resolver returns the trusted
// Party's id + name so the caller can overwrite `Document.supplier`,
// `Document.supplierNif` and `Document.partyId`.
//
// Four cases pinned here:
//
//   1) Bad AI supplier NIF + good customer NIF + Party exists →
//      resolves, returns the trusted Party's data.
//   2) Good AI supplier NIF → no fallback (AI is trusted).
//   3) Bad AI supplier NIF + good customer NIF + NO Party → no fallback.
//   4) Cross-tenant lookup is structurally rejected by Prisma's
//      `where: { tenantId }`. We pin the contract by verifying the
//      Prisma query is scoped to this tenantId.
//
// We invoke the private `resolveSupplierByNif` via cast so we exercise
// the real logic without spinning up the full extraction pipeline.
// =============================================================================

const TENANT_ID = "tenant-nif-fallback";
const OTHER_TENANT_ID = "tenant-other";
// Valid (mod-11) customer NIF used as the resolver lookup key. We use
// a constructed NIF instead of the real EDENOX `502782160` because the
// real EDENOX NIF actually fails mod-11 (the EDENOX tax-id validator
// comment is stale — see tax-id.validator.ts:50). `510000002` is
// mod-11 valid (sum=2, mod=2, expected=9, check digit=2 — verifiably
// valid by the same `isValidPortugueseNif` helper).
const REAL_PARTY_NIF = "510000002";
const REAL_PARTY_ID = "party-customer-real";
const REAL_PARTY_NAME = "CUSTOMER PARTY LDA";
// A bad NIF — fails mod-11. `100000000` is structurally invalid:
// sum=10, expected check digit=1, actual=0.
const BAD_SUPPLIER_NIF = "100000000";

function buildService(opts: {
  partyForCustomerNif: { id: string; name: string; nif: string } | null;
}) {
  // The mock models what Prisma would do — a Party row only matches if
  // BOTH the tenantId AND the NIF line up with the `where` clause. This
  // is what enforces the OWASP API1 (BOLA) guard: a Party from another
  // tenant never leaks into this tenant's documents.
  const partyFindFirst = jest.fn(async (args: { where: { nif?: string; tenantId?: string } }) => {
    if (
      args?.where?.tenantId === TENANT_ID &&
      args?.where?.nif === REAL_PARTY_NIF
    ) {
      return opts.partyForCustomerNif;
    }
    return null;
  });
  const prisma = {
    party: {
      findFirst: partyFindFirst,
    },
  };
  const storage = {} as StoragePort;
  const svc = new ExtractionService(prisma as any, null, storage);
  return { svc, prisma };
}

const invoke = (
  svc: ExtractionService,
  documentId: string,
  fields: ExtractedFields,
): Promise<{
  supplier: string;
  supplierNif: string;
  partyId: string | null;
  reason: string;
} | null> => (svc as any).resolveSupplierByNif(TENANT_ID, documentId, fields);

describe("resolveSupplierByNif — Party lookup fallback", () => {
  it("Caso 1: bad AI supplier NIF + good customer NIF + Party exists → resolves", async () => {
    const { svc, prisma } = buildService({
      partyForCustomerNif: {
        id: REAL_PARTY_ID,
        name: REAL_PARTY_NAME,
        nif: REAL_PARTY_NIF,
      },
    });
    const fields: ExtractedFields = {
      supplier: "HALLUCINATED VENDOR",
      supplierNif: BAD_SUPPLIER_NIF,
      customer: REAL_PARTY_NAME,
      customerNif: REAL_PARTY_NIF,
      currency: "EUR",
      confidence: 0.4,
      source: "ai",
      hints: [],
      warnings: [],
    };
    const out = await invoke(svc, "doc-1", fields);
    expect(out).not.toBeNull();
    expect(out?.supplier).toBe(REAL_PARTY_NAME);
    expect(out?.supplierNif).toBe(REAL_PARTY_NIF);
    expect(out?.partyId).toBe(REAL_PARTY_ID);
    expect(out?.reason).toBe("customer-nif-resolves-existing-party");
    // Verify the lookup was scoped to this tenant (the cross-tenant
    // rejection path requires the tenantId in `where`).
    expect(prisma.party.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: TENANT_ID,
          nif: REAL_PARTY_NIF,
        }),
      }),
    );
  });

  it("Caso 2: good AI supplier NIF → no fallback (AI is trusted)", async () => {
    const { svc, prisma } = buildService({
      partyForCustomerNif: null,
    });
    // supplier NIF passes mod-11 → resolver must short-circuit and NOT
    // even hit the DB. Confidence in AI stays intact.
    const fields: ExtractedFields = {
      supplier: REAL_PARTY_NAME,
      supplierNif: REAL_PARTY_NIF, // mod-11 valid
      customer: "NOV OUSADO UNIPESSOAL LDA",
      customerNif: "515208566",
      currency: "EUR",
      confidence: 0.7,
      source: "ai",
      hints: [],
      warnings: [],
    };
    const out = await invoke(svc, "doc-2", fields);
    expect(out).toBeNull();
    expect(prisma.party.findFirst).not.toHaveBeenCalled();
  });

  it("Caso 3: customer NIF doesn't resolve a Party → no fallback", async () => {
    const { svc, prisma } = buildService({
      partyForCustomerNif: null,
    });
    const fields: ExtractedFields = {
      supplier: "HALLUCINATED VENDOR",
      supplierNif: BAD_SUPPLIER_NIF,
      customer: "UNKNOWN CUSTOMER",
      customerNif: REAL_PARTY_NIF,
      currency: "EUR",
      confidence: 0.4,
      source: "ai",
      hints: [],
      warnings: [],
    };
    const out = await invoke(svc, "doc-3", fields);
    expect(out).toBeNull();
    // The lookup was attempted but returned null — proves the resolver
    // reached the DB rather than short-circuiting on a precondition.
    expect(prisma.party.findFirst).toHaveBeenCalledTimes(1);
  });

  it("Caso 4: cross-tenant lookup is rejected by where:{tenantId} scoping", async () => {
    // The Prisma `where: { tenantId: TENANT_ID }` is what enforces cross-
    // tenant rejection. We assert that the query is scoped to this
    // tenant even when the customer NIF happens to match a Party in
    // another tenant — the mock returns null for any tenantId other than
    // TENANT_ID, mirroring Prisma's row-level filter.
    //
    // To pin the contract, we configure the mock so a Party keyed on
    // REAL_PARTY_NIF would be returned IF the lookup used the OTHER
    // tenant's id. The resolver uses TENANT_ID, so the lookup must
    // return null — proving that the `where.tenantId` filter is what
    // actually blocks the cross-tenant case.
    const fields: ExtractedFields = {
      supplier: "HALLUCINATED VENDOR",
      supplierNif: BAD_SUPPLIER_NIF,
      customer: "OTHER TENANT'S CUSTOMER PARTY",
      customerNif: REAL_PARTY_NIF,
      currency: "EUR",
      confidence: 0.4,
      source: "ai",
      hints: [],
      warnings: [],
    };
    // Lookup uses TENANT_ID — the mock matches and returns the row.
    // Wait: this test is about REJECTION. The mock returns the row only
    // when tenantId matches. With our service using TENANT_ID, the mock
    // returns the row, and the resolver accepts it. That doesn't test
    // rejection. Let me invert: use a different mock that returns null
    // for cross-tenant lookups but the row for in-tenant.
    // The fix: build a SEPARATE mock that only matches OTHER_TENANT_ID,
    // proving TENANT_ID doesn't see the row.
    const crossTenantPrisma = {
      party: {
        findFirst: jest.fn(async (args: { where: { nif?: string; tenantId?: string } }) => {
          if (
            args?.where?.tenantId === OTHER_TENANT_ID &&
            args?.where?.nif === REAL_PARTY_NIF
          ) {
            return {
              id: "party-different-tenant",
              name: "OTHER TENANT'S CUSTOMER PARTY",
              nif: REAL_PARTY_NIF,
            };
          }
          return null;
        }),
      },
    };
    const crossTenantSvc = new ExtractionService(crossTenantPrisma as any, null, {} as StoragePort);
    const out = await (crossTenantSvc as any).resolveSupplierByNif(
      TENANT_ID,
      "doc-4",
      fields,
    );
    // The Party row exists but does not match THIS tenant — the where
    // clause filters it out and the resolver returns null. This is the
    // OWASP API1 (BOLA) guard the skill oc-api-audit requires.
    expect(out).toBeNull();
    expect(crossTenantPrisma.party.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: TENANT_ID,
        }),
      }),
    );
    // Sanity check: re-run with the OTHER tenant's id, and the same
    // resolver should now FIND the Party (proving the mock is correct
    // and the only thing blocking the rejection is the where.tenantId).
    const crossTenantResolved = await (crossTenantSvc as any).resolveSupplierByNif(
      OTHER_TENANT_ID,
      "doc-4b",
      fields,
    );
    expect(crossTenantResolved).not.toBeNull();
    expect(crossTenantResolved?.partyId).toBe("party-different-tenant");
  });
});
