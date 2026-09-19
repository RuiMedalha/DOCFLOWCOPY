import {
  ExtractedFields,
  ExtractionService,
  StoragePort,
} from "../extraction.service";

// =============================================================================
// should-swap.spec.ts
//
// Pins the root-cause fix from DIAGNOSTIC-2 §5 item 6: `shouldSwap` is now
// NIF-anchored, NOT filename-anchored. Before this fix the swap predicate
// was `filenameSuspiciousMatch || (structuralNifMismatch && filenameSuspiciousMatch)` —
// i.e. the structural NIF check only fired when the filename also looked
// suspicious. The user's "10× the same PDF" pattern: AI hallucinated a
// supplier name NOT present in the filename, so the structural check never
// ran and the wrong supplier was kept.
//
// New predicate: `shouldSwap = structuralNifMismatch`. Three cases:
//
//   1) structural NIF mismatch (AI NIF fails mod-11 / customer NIF passes)
//      AND filename does NOT match → swap fires (the previously-missed
//      case — this is the root-cause fix).
//   2) structural NIF mismatch AND filename DOES match → swap fires
//      (legacy behaviour preserved — the warning log branches).
//   3) no mismatch → no swap.
//
// We invoke the private `ensureSupplierCustomerSanity` via cast so we
// exercise the real logic without spinning up the full extraction
// pipeline. Mirrors the pattern in qr-overrides-ai-vision.spec.ts.
// =============================================================================

const TENANT_ID = "tenant-swap";
const TENANT_NAME = "NOV OUSADO UNIPESSOAL LDA";
const TENANT_NIF = "515208566";
// Supplier NIF that FAILS mod-11 (forces structuralNifMismatch=true).
// `100000000` is structurally invalid: mod-11 sum=10, expected check
// digit=1, actual=0. Verifiable with `isValidPortugueseNif`.
const BAD_SUPPLIER_NIF = "100000000";
// Customer NIF that PASSES mod-11 — distinct from `TENANT_NIF` so the
// "supplier NIF equals tenant NIF" path (CONDITION 1) doesn't fire
// accidentally. `500000000` is mod-11 valid (sum=0, mod=0, expected=0,
// check digit=0) and is NOT the tenant's NIF.
const GOOD_CUSTOMER_NIF = "500000000";

function buildService() {
  const prisma = {
    tenant: {
      findUnique: jest.fn(async () => ({ name: TENANT_NAME, nif: TENANT_NIF })),
      findFirst: jest.fn(async () => ({ name: TENANT_NAME, nif: TENANT_NIF })),
    },
    party: {
      findFirst: jest.fn(),
    },
  };
  const storage = {} as StoragePort;
  const svc = new ExtractionService(prisma as any, null, storage);
  return { svc, prisma };
}

const invoke = (
  svc: ExtractionService,
  fields: ExtractedFields,
  qrPayload: string | undefined,
  fileName: string | undefined,
): Promise<ExtractedFields> =>
  (svc as any).ensureSupplierCustomerSanity(
    TENANT_ID,
    fields,
    qrPayload,
    fileName,
  );

describe("ensureSupplierCustomerSanity — NIF-anchored shouldSwap", () => {
  it("Caso 1: structural NIF mismatch WITHOUT filename match → SWAP (root-cause fix)", async () => {
    const { svc } = buildService();
    // Real bug from DIAGNOSTIC-2: filename doesn't contain the AI's
    // hallucinated supplier name. Old predicate missed this; new
    // predicate catches it via mod-11 alone.
    const fields: ExtractedFields = {
      supplier: "SOME VENDOR WE NEVER HEARD OF",
      supplierNif: BAD_SUPPLIER_NIF,
      customer: "EDENOX EQUIPAMENTOS HOTELEIROS LDA",
      customerNif: GOOD_CUSTOMER_NIF,
      currency: "EUR",
      confidence: 0.5,
      source: "ai",
      hints: [],
      warnings: [],
    };
    const out = await invoke(
      svc,
      fields,
      undefined,
      "random-november-receipt.pdf",
    );
    // Swap flipped supplier/customer. Supplier is now the previously-
    // detected customer.
    expect(out.supplier).toBe("EDENOX EQUIPAMENTOS HOTELEIROS LDA");
    expect(out.supplierNif).toBe(GOOD_CUSTOMER_NIF);
    expect(out.customer).toBe("SOME VENDOR WE NEVER HEARD OF");
    expect(out.customerNif).toBe(BAD_SUPPLIER_NIF);
    // The new audit hint pinpoints the trigger.
    expect(out.hints ?? []).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^partySwap:reason=ai_supplier_name_matches_filename_prefix/),
      ]),
    );
  });

  it("Caso 2: structural NIF mismatch WITH filename match → SWAP (legacy compat)", async () => {
    const { svc } = buildService();
    // The original EDENOX case from 2026-09-06 — filename prefix IS the
    // wrong AI-extracted supplier name. The legacy log branch should fire
    // because filenameSuspiciousMatch is also true.
    const fields: ExtractedFields = {
      supplier: "AMERICO ALVES",
      supplierNif: BAD_SUPPLIER_NIF,
      customer: "EDENOX EQUIPAMENTOS HOTELEIROS LDA",
      customerNif: GOOD_CUSTOMER_NIF,
      currency: "EUR",
      confidence: 0.5,
      source: "ai",
      hints: [],
      warnings: [],
    };
    const out = await invoke(
      svc,
      fields,
      undefined,
      "AMERICO-ALVES_2026-03-19_1018224984.pdf",
    );
    expect(out.supplier).toBe("EDENOX EQUIPAMENTOS HOTELEIROS LDA");
    expect(out.supplierNif).toBe(GOOD_CUSTOMER_NIF);
    expect(out.customer).toBe("AMERICO ALVES");
    expect(out.customerNif).toBe(BAD_SUPPLIER_NIF);
  });

  it("Caso 3: NO mismatch → no swap", async () => {
    const { svc } = buildService();
    // Both NIFs pass mod-11 → structuralNifMismatch is false → no swap.
    // Filename heuristic must not be the only gate; clean numbers must
    // survive untouched.
    const fields: ExtractedFields = {
      supplier: "EDENOX EQUIPAMENTOS HOTELEIROS LDA",
      supplierNif: GOOD_CUSTOMER_NIF,
      customer: "NOV OUSADO UNIPESSOAL LDA",
      customerNif: TENANT_NIF,
      currency: "EUR",
      confidence: 0.5,
      source: "ai",
      hints: [],
      warnings: [],
    };
    const out = await invoke(
      svc,
      fields,
      undefined,
      "EDENOX_2026_03_19.pdf",
    );
    // Untouched — supplier/customer preserved as the AI returned them.
    expect(out.supplier).toBe("EDENOX EQUIPAMENTOS HOTELEIROS LDA");
    expect(out.supplierNif).toBe(GOOD_CUSTOMER_NIF);
    expect(out.customer).toBe("NOV OUSADO UNIPESSOAL LDA");
    expect(out.customerNif).toBe(TENANT_NIF);
    // No partySwap hint should appear.
    expect((out.hints ?? []).some((h) => h.startsWith("partySwap:"))).toBe(false);
  });
});
